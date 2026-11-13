const fs = require('fs');
const path = require('path');
const http = require('http');
const AdmZip = require('adm-zip');

process.env.PORT = '3898';
require('../server/index');
const auth = require('../server/utils/auth');
const db = require('../server/db');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createMultipartFormData(fields, fileFields) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const crlf = '\r\n';
  const postData = [];

  for (const [key, value] of Object.entries(fields)) {
    postData.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${key}"${crlf}${crlf}` +
      `${value}${crlf}`
    ));
  }

  const files = Array.isArray(fileFields) ? fileFields : (fileFields ? [fileFields] : []);
  for (const fileField of files) {
    postData.push(Buffer.from(
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"${crlf}` +
      `Content-Type: ${fileField.contentType || 'application/octet-stream'}${crlf}${crlf}`
    ));
    postData.push(fileField.content);
    postData.push(Buffer.from(crlf));
  }

  postData.push(Buffer.from(`--${boundary}--${crlf}`));
  const body = Buffer.concat(postData);

  return {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    },
    body
  };
}

function request(method, pathUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3898,
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
  console.log('--- 开始 作业收发平台 多文件与规范命名测试 ---');
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
  const testClassName = '测试临时班_' + Date.now();
  let testClassId = null;
  const createdMaterialIds = [];
  const createdSubmissionIds = [];

  try {
    // 1. Add test class and a test student in roster
    const addClassRes = await request('POST', '/api/classes', {
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ name: testClassName, max_student_no: 45 })
    });
    assert(addClassRes.statusCode === 200 && addClassRes.json.success, '创建测试班级成功');
    testClassId = addClassRes.json.data.id;

    db.db.prepare('INSERT OR REPLACE INTO students (class_name, student_no, student_name, student_code) VALUES (?, ?, ?, ?)')
      .run(testClassName, 8, '李小华', '');

    // 2. Teacher uploads 2 materials at once
    const matForm = createMultipartFormData(
      { title: '测试资料' },
      [
        { name: 'files', filename: '导学案.docx', content: Buffer.from('DOC1') },
        { name: 'files', filename: '素材代码.py', content: Buffer.from('PY1') }
      ]
    );
    const matRes = await request('POST', '/api/materials', {
      headers: { ...matForm.headers, Cookie: teacherCookie },
      body: matForm.body
    });
    assert(matRes.statusCode === 200 && matRes.json.success && Array.isArray(matRes.json.items) && matRes.json.items.length === 2, '教师一次发布 2 个资料成功');
    if (matRes.json && Array.isArray(matRes.json.items)) {
      matRes.json.items.forEach(i => createdMaterialIds.push(i.id));
    }

    // 2.5 Verify SSE real-time push to teacher endpoint when student submits
    const sseReceived = await new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          sseReq.destroy();
          resolve(false);
        }
      }, 4000);

      const sseReq = http.request({
        hostname: '127.0.0.1',
        port: 3898,
        path: '/api/teacher/events',
        method: 'GET',
        headers: { Cookie: teacherCookie }
      }, (res) => {
        let buf = '';
        res.on('data', async (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.includes('event: connected') && !sseReq._triggered) {
            sseReq._triggered = true;
            const pushForm = createMultipartFormData(
              { class_name: testClassName, student_no: '9', note: 'SSE测试' },
              { name: 'files', filename: 'sse_test.py', content: Buffer.from('print(1)') }
            );
            await request('POST', '/api/submissions', { headers: pushForm.headers, body: pushForm.body });
          }
          if (buf.includes('event: submissions_updated') && !resolved) {
            resolved = true;
            clearTimeout(timer);
            sseReq.destroy();
            resolve(true);
          }
        });
      });
      sseReq.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
      sseReq.end();
    });
    assert(sseReceived, '教师端 SSE 接口在学生提交后秒级收到 submissions_updated 推送');

    // Cleanup student 9 test submission before continuing student 8 checks
    const sseSubRows = db.db.prepare('SELECT id FROM submissions WHERE class_name = ? AND student_no = 9').all(testClassName);
    sseSubRows.forEach(r => db.deleteSubmission(r.id));

    // 3. Student submits 1 file with messy duplicate prefix & timestamp
    const sub1 = createMultipartFormData(
      { class_name: testClassName, student_no: '8', note: '第一份' },
      { name: 'files', filename: '08号_李小华_智能小车_1794533562239.sb3', content: Buffer.from('SB3_V1') }
    );
    const subRes1 = await request('POST', '/api/submissions', { headers: sub1.headers, body: sub1.body });
    assert(subRes1.statusCode === 200 && subRes1.json.success, '学生首次提交带重复前缀和时间戳的文件成功');
    assert(subRes1.json.data.originalName === '智能小车.sb3', `自动剥离重复学号姓名和时间戳 (${subRes1.json.data.originalName})`);

    // 4. Student submits 2 different files at once + 1 overwrite of 智能小车.sb3
    const sub2 = createMultipartFormData(
      { class_name: testClassName, student_no: '8', note: '多文件上传' },
      [
        { name: 'files', filename: '08_智能小车.sb3', content: Buffer.from('SB3_V2') },
        { name: 'files', filename: '李小华_运行截图.png', content: Buffer.from('PNG_DATA') },
        { name: 'files', filename: '实验报告.docx', content: Buffer.from('DOCX_DATA') }
      ]
    );
    const subRes2 = await request('POST', '/api/submissions', { headers: sub2.headers, body: sub2.body });
    assert(subRes2.statusCode === 200 && subRes2.json.success && subRes2.json.data.files.length === 3, '学生一次上传 3 个文件成功');

    // 5. Verify submission list & disk filenames
    const listRes = await request('GET', `/api/submissions?class_name=${encodeURIComponent(testClassName)}`, {
      headers: { Cookie: teacherCookie }
    });
    assert(listRes.statusCode === 200 && listRes.json.data.length === 3, '同学生不同名保留、同名覆盖后共 3 条记录');
    listRes.json.data.forEach(item => createdSubmissionIds.push(item.id));

    const sb3Row = listRes.json.data.find(r => r.original_name === '智能小车.sb3');
    assert(!!sb3Row && sb3Row.stored_name === '08号_李小华_智能小车.sb3', `磁盘文件名规范整洁 (${sb3Row && sb3Row.stored_name})`);
    assert(sb3Row && fs.existsSync(sb3Row.file_path) && fs.readFileSync(sb3Row.file_path, 'utf8') === 'SB3_V2', '覆盖更新后磁盘文件内容为最新版');

    // 6. Verify student status endpoint returns multi-file details without student name
    const statusRes = await request('GET', `/api/submission-status?class_name=${encodeURIComponent(testClassName)}&student_no=8`);
    assert(statusRes.statusCode === 200 && statusRes.json.data.submitted && statusRes.json.data.fileCount === 3, '学生端个人状态返回已交 3 个文件');
    assert(!statusRes.text.includes('李小华'), '学生端状态接口严格不泄露学生姓名');

    // 7. Verify ZIP export naming
    const zipRes = await request('GET', `/api/submissions/export-zip?class_name=${encodeURIComponent(testClassName)}`, {
      headers: { Cookie: teacherCookie }
    });
    assert(zipRes.statusCode === 200, '导出 ZIP 成功');
    const zip = new AdmZip(zipRes.buffer);
    const entryNames = zip.getEntries().map(e => e.entryName);
    console.log('ZIP 内文件列表:', entryNames);
    assert(entryNames.length === 3, 'ZIP 内包含全部 3 个文件');
    assert(
      entryNames.includes(`${testClassName}/08号_李小华_智能小车.sb3`) &&
      entryNames.includes(`${testClassName}/08号_李小华_运行截图.png`) &&
      entryNames.includes(`${testClassName}/08号_李小华_实验报告.docx`),
      'ZIP 内文件命名全部规整为 08号_李小华_原文件名.后缀'
    );
  } finally {
    for (const id of createdSubmissionIds) {
      await request('DELETE', `/api/submissions/${id}`, { headers: { Cookie: teacherCookie } });
    }
    for (const id of createdMaterialIds) {
      await request('DELETE', `/api/materials/${id}`, { headers: { Cookie: teacherCookie } });
    }
    if (testClassId) {
      await request('DELETE', `/api/classes/${testClassId}`, { headers: { Cookie: teacherCookie } });
    }
    const classDir = path.join(db.submissionsDir, testClassName);
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
