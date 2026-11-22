const fs = require('fs');
const path = require('path');
const http = require('http');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');

process.env.PORT = '3899';
require('../server/index');
const auth = require('../server/utils/auth');
const db = require('../server/db');
const { formatLocalDate, getCurrentIsoWeekString } = require('../server/utils/dateRange');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(method, pathUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3899,
      path: pathUrl,
      method,
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buffer.toString('utf8'));
        } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer,
          text: buffer.toString('utf8'),
          json
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runTests() {
  console.log('--- 开始 按天/按周筛选、广播联动与批量清理测试 ---');
  await sleep(800);

  let passed = 0;
  let failed = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`PASS: ${desc}`);
      passed++;
    } else {
      console.error(`FAIL: ${desc}`);
      failed++;
    }
  }

  const token = auth.createSessionToken();
  const teacherCookie = `${auth.COOKIE_NAME}=${encodeURIComponent(token)}`;
  const testClassName = '测试按周班级_' + Date.now();
  let testClassId = null;
  const classDir = path.join(db.submissionsDir, testClassName);

  try {
    const addClassRes = await request('POST', '/api/classes', {
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ name: testClassName, max_student_no: 10 })
    });
    assert(addClassRes.statusCode === 200 && addClassRes.json.success, '创建测试班级成功');
    testClassId = addClassRes.json.data.id;

    fs.mkdirSync(classDir, { recursive: true });

    const now = new Date();
    const todayStr = formatLocalDate(now);
    const lastWeekDate = new Date(now);
    lastWeekDate.setDate(now.getDate() - 7);
    const lastWeekStr = formatLocalDate(lastWeekDate);
    const lastWeekIso = getCurrentIsoWeekString(lastWeekDate);
    const thisWeekIso = getCurrentIsoWeekString(now);

    const fileToday = path.join(classDir, `01号_作业_${todayStr.replace(/-/g, '')}_100000.py`);
    const fileLastWeek = path.join(classDir, `02号_作业_${lastWeekStr.replace(/-/g, '')}_100000.py`);
    fs.writeFileSync(fileToday, 'print("today")');
    fs.writeFileSync(fileLastWeek, 'print("last week")');

    db.saveOrUpdateSubmission({
      className: testClassName,
      studentNo: 1,
      studentName: '',
      note: '今天',
      originalName: '作业.py',
      storedName: path.basename(fileToday),
      filePath: fileToday,
      fileSize: 14,
      ipAddress: '127.0.0.1',
      submittedAt: `${todayStr} 10:00:00`
    });

    db.saveOrUpdateSubmission({
      className: testClassName,
      studentNo: 2,
      studentName: '',
      note: '上周',
      originalName: '作业.py',
      storedName: path.basename(fileLastWeek),
      filePath: fileLastWeek,
      fileSize: 18,
      ipAddress: '127.0.0.1',
      submittedAt: `${lastWeekStr} 10:00:00`
    });

    // 1. Filter by today
    const todayRes = await request('GET', `/api/submissions?class_name=${encodeURIComponent(testClassName)}&scope=today`, {
      headers: { Cookie: teacherCookie }
    });
    assert(todayRes.statusCode === 200 && todayRes.json.data.length === 1 && todayRes.json.data[0].student_no === 1, 'scope=today 仅返回今天的 1 条作业');

    // 2. Filter by this week
    const thisWeekRes = await request('GET', `/api/submissions?class_name=${encodeURIComponent(testClassName)}&scope=week&week=${thisWeekIso}`, {
      headers: { Cookie: teacherCookie }
    });
    assert(thisWeekRes.statusCode === 200 && thisWeekRes.json.data.length === 1 && thisWeekRes.json.data[0].student_no === 1, 'scope=week 本周仅返回本周作业');

    // 3. Filter by last week (by week & by date)
    const lastWeekRes = await request('GET', `/api/submissions?class_name=${encodeURIComponent(testClassName)}&scope=week&week=${lastWeekIso}`, {
      headers: { Cookie: teacherCookie }
    });
    assert(lastWeekRes.statusCode === 200 && lastWeekRes.json.data.length === 1 && lastWeekRes.json.data[0].student_no === 2, '按指定周次筛选上周仅返回上周的 2 号作业');

    const lastDateRes = await request('GET', `/api/submissions?class_name=${encodeURIComponent(testClassName)}&scope=date&date=${lastWeekStr}`, {
      headers: { Cookie: teacherCookie }
    });
    assert(lastDateRes.statusCode === 200 && lastDateRes.json.data.length === 1 && lastDateRes.json.data[0].student_no === 2, '按指定日期筛选仅返回该日作业');

    // 4. Filter all
    const allRes = await request('GET', `/api/submissions?class_name=${encodeURIComponent(testClassName)}&scope=all`, {
      headers: { Cookie: teacherCookie }
    });
    assert(allRes.statusCode === 200 && allRes.json.data.length === 2, 'scope=all 返回全部 2 条历史作业');

    // 5. Class summary respects time scope
    const sumToday = await request('GET', `/api/teacher/class-summary?class_name=${encodeURIComponent(testClassName)}&scope=today`, {
      headers: { Cookie: teacherCookie }
    });
    assert(sumToday.json.data.submittedCount === 1 && sumToday.json.data.missingCount === 9, '班级统计在今天范围下正确计为已交 1 / 未交 9');

    const sumAll = await request('GET', `/api/teacher/class-summary?class_name=${encodeURIComponent(testClassName)}&scope=all`, {
      headers: { Cookie: teacherCookie }
    });
    assert(sumAll.json.data.submittedCount === 2 && sumAll.json.data.missingCount === 8, '班级统计在全部历史范围下正确计为已交 2 / 未交 8');

    // 6. Broadcast respects time scope
    const bcStart = await request('POST', '/api/broadcast/start', {
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ class_name: testClassName, scope: 'today' })
    });
    assert(bcStart.statusCode === 200 && bcStart.json.success, '开启今天范围的未交学号广播成功');

    const bcGet = await request('GET', '/api/broadcast');
    assert(
      bcGet.statusCode === 200 &&
      bcGet.json.data.active &&
      bcGet.json.data.submittedCount === 1 &&
      !bcGet.json.data.submittedNos.includes(2),
      '广播接口仅按教师选定的今天范围计算未交学号（上周交的 2 号仍列为今天未交）'
    );
    await request('POST', '/api/broadcast/stop', { headers: { Cookie: teacherCookie } });

    // 7. Student personal status defaults to today only
    const st1 = await request('GET', `/api/submission-status?class_name=${encodeURIComponent(testClassName)}&student_no=1`);
    const st2 = await request('GET', `/api/submission-status?class_name=${encodeURIComponent(testClassName)}&student_no=2`);
    assert(st1.json.data.submitted === true, '学生端个人状态：今天交过的 1 号显示已交');
    assert(st2.json.data.submitted === false, '学生端个人状态：仅上周交过的 2 号今天显示未交');

    // 8. ZIP export respects time scope & embeds summary Excel
    const zipToday = await request('GET', `/api/submissions/export-zip?class_name=${encodeURIComponent(testClassName)}&scope=today`, {
      headers: { Cookie: teacherCookie }
    });
    const zipObjToday = new AdmZip(zipToday.buffer);
    const zipEntriesToday = zipObjToday.getEntries().map(e => e.entryName);
    const zipFilesToday = zipEntriesToday.filter(n => !n.endsWith('.xlsx'));
    const zipSummaryToday = zipEntriesToday.find(n => /^作业提交汇总_.*\.xlsx$/.test(n));
    assert(zipFilesToday.length === 1, `ZIP 导出 scope=today 仅打包今天 1 个作业文件 (${zipFilesToday.join(', ')})`);
    assert(Boolean(zipSummaryToday), `ZIP 内附带汇总 Excel (${zipSummaryToday})`);
    const wbInZip = XLSX.read(zipObjToday.readFile(zipSummaryToday), { type: 'buffer' });
    const rowsInZip = XLSX.utils.sheet_to_json(wbInZip.Sheets['提交汇总'], { header: 1 });
    assert(rowsInZip[1] && String(rowsInZip[1][3]).includes('今天'), 'ZIP 内汇总表正确标明统计时间范围');

    // 8b. Student submission summary API & custom date range
    const studentSumToday = await request('GET', `/api/teacher/student-summary?class_name=${encodeURIComponent(testClassName)}&scope=today`, {
      headers: { Cookie: teacherCookie }
    });
    assert(
      studentSumToday.statusCode === 200 &&
      studentSumToday.json.data.stats.totalStudents === 10 &&
      studentSumToday.json.data.stats.submittedStudents === 1 &&
      studentSumToday.json.data.stats.unsubmittedStudents === 9,
      '学生提交汇总接口（今天）正确返回全班 10 人（已交 1 / 未交 9）'
    );
    const studentSumCustom = await request('GET', `/api/teacher/student-summary?class_name=${encodeURIComponent(testClassName)}&scope=custom&start_date=${lastWeekStr}&end_date=${todayStr}`, {
      headers: { Cookie: teacherCookie }
    });
    assert(
      studentSumCustom.statusCode === 200 &&
      studentSumCustom.json.data.stats.submittedStudents === 2 &&
      studentSumCustom.json.data.stats.totalSubmissions === 2,
      '学生提交汇总接口（自定义起止时间段）正确包含上周和今天的共 2 人提交记录'
    );
    const studentSumExport = await request('GET', `/api/teacher/student-summary/export?class_name=${encodeURIComponent(testClassName)}&scope=custom&start_date=${lastWeekStr}&end_date=${todayStr}`, {
      headers: { Cookie: teacherCookie }
    });
    assert(studentSumExport.statusCode === 200 && studentSumExport.buffer.length > 1000, '单独导出学生提交汇总 Excel 成功');

    // 9. Batch delete respects time scope & cleans physical file
    const batchDel = await request('POST', '/api/submissions/batch-delete', {
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ class_name: testClassName, scope: 'date', date: lastWeekStr })
    });
    assert(batchDel.statusCode === 200 && batchDel.json.deletedCount === 1, '按指定日期批量清理仅删除上周的 1 条记录');
    assert(!fs.existsSync(fileLastWeek) && fs.existsSync(fileToday), '批量清理删除了目标日期的磁盘文件且保留今天的文件');
  } finally {
    await request('POST', '/api/submissions/batch-delete', {
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ class_name: testClassName, scope: 'all' })
    }).catch(() => {});
    if (testClassId) {
      await request('DELETE', `/api/classes/${testClassId}`, { headers: { Cookie: teacherCookie } }).catch(() => {});
    }
    if (fs.existsSync(classDir)) {
      fs.rmSync(classDir, { recursive: true, force: true });
    }
  }

  console.log('====================================');
  console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
  console.log('====================================');
  process.exit(failed === 0 ? 0 : 1);
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
