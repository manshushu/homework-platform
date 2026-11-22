const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('../server/db');
const { formatLocalDate } = require('../server/utils/dateRange');

const DEFAULT_STATS_DIR = 'D:\\提交作业留档\\作业统计\\2026第一学期作业统计';
const DEFAULT_ARCHIVE_DIR = 'D:\\提交作业留档\\2026学年第一学期';
const STATS_FILES = [
  '六年级卫星课作业提交情况统计表.xlsx',
  '七年级人工智能作业提交情况统计表.xlsx',
  '八年级信息科技作业提交情况统计表.xlsx'
];

const UNSUBMITTED_SET = new Set(['', '未查到提交', '当堂缺交', '未交', '缺交', '未提交']);

function normalizeClassName(raw) {
  const s = String(raw || '').trim();
  const m = /^(六|七|八)[(（](\d+)[)）]班$/.exec(s);
  if (m) {
    return `${m[1]}年级${Number(m[2])}班`;
  }
  return s;
}

function extractBookTitle(text) {
  const m = /《([^》]+)》/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function extractHeaderDate(text) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(text || ''));
  return m ? m[1] : '';
}

function normalizeFolderTitle(folderName) {
  // e.g., "第01课_走近机器之眼" -> "走近机器之眼", "第04课_HTTP与MQTT合课" -> "HTTP与MQTT合课"
  return String(folderName || '')
    .replace(/^第?\d+课[_-]?/, '')
    .replace(/^卫星课程[_-]?/, '')
    .replace(/^人工智能[_-]?/, '')
    .trim();
}

function pickModeDate(dateCounts) {
  let bestDate = '';
  let bestCount = -1;
  for (const [d, c] of dateCounts.entries()) {
    if (c > bestCount || (c === bestCount && d < bestDate)) {
      bestDate = d;
      bestCount = c;
    }
  }
  return bestDate;
}

function buildArchiveDateIndex(archiveDir) {
  const classLessonDateMap = new Map(); // `${title}::${className}` -> date
  const lessonGlobalCounts = new Map(); // title -> Map<date, count>

  if (!archiveDir || !fs.existsSync(archiveDir)) {
    console.warn(`归档原文件目录不存在，跳过文件日期索引: ${archiveDir}`);
    return { classLessonDateMap, lessonModeDateMap: new Map() };
  }

  const subjects = fs.readdirSync(archiveDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const subj of subjects) {
    const subjDir = path.join(archiveDir, subj.name);
    const lessons = fs.readdirSync(subjDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const lesson of lessons) {
      const lessonTitle = normalizeFolderTitle(lesson.name);
      if (!lessonTitle) continue;
      const lessonDir = path.join(subjDir, lesson.name);
      const classDirs = fs.readdirSync(lessonDir, { withFileTypes: true }).filter((d) => d.isDirectory());

      if (!lessonGlobalCounts.has(lessonTitle)) {
        lessonGlobalCounts.set(lessonTitle, new Map());
      }
      const globalCounts = lessonGlobalCounts.get(lessonTitle);

      for (const clsDir of classDirs) {
        const normClass = normalizeClassName(clsDir.name);
        const fullClsDir = path.join(lessonDir, clsDir.name);
        const files = fs.readdirSync(fullClsDir, { withFileTypes: true }).filter((f) => f.isFile());
        if (files.length === 0) continue;

        const clsCounts = new Map();
        for (const f of files) {
          try {
            const st = fs.statSync(path.join(fullClsDir, f.name));
            const dateStr = formatLocalDate(st.mtime);
            clsCounts.set(dateStr, (clsCounts.get(dateStr) || 0) + 1);
            globalCounts.set(dateStr, (globalCounts.get(dateStr) || 0) + 1);
          } catch (e) {}
        }

        const modeDate = pickModeDate(clsCounts);
        if (modeDate) {
          classLessonDateMap.set(`${lessonTitle}::${normClass}`, modeDate);
        }
      }
    }
  }

  const lessonModeDateMap = new Map();
  for (const [title, counts] of lessonGlobalCounts.entries()) {
    const d = pickModeDate(counts);
    if (d) lessonModeDateMap.set(title, d);
  }

  return { classLessonDateMap, lessonModeDateMap };
}

function parseLessonColumns(headerRow) {
  const lessons = [];
  for (let col = 0; col < headerRow.length; col++) {
    const cell = String(headerRow[col] || '').trim();
    if (!cell.includes('提交状态')) continue;

    const title = extractBookTitle(cell) || cell.replace(/\s*提交状态\s*$/, '').replace(/\s+/g, ' ').trim();
    const headerDate = extractHeaderDate(cell);
    const next1 = String(headerRow[col + 1] || '');
    const next2 = String(headerRow[col + 2] || '');

    lessons.push({
      title,
      headerDate,
      statusCol: col,
      scoreCol: next1.includes('得分') ? col + 1 : -1,
      detailCol: next2.includes('提交明细') ? col + 2 : -1
    });
  }
  return lessons;
}

function importHistoryStats(statsDir = DEFAULT_STATS_DIR, archiveDir = DEFAULT_ARCHIVE_DIR) {
  const { classLessonDateMap, lessonModeDateMap } = buildArchiveDateIndex(archiveDir);
  const records = [];
  const statsBySource = {};
  const dateSourceCounts = { archive_class: 0, header: 0, archive_lesson: 0, fallback: 0 };

  for (const fileName of STATS_FILES) {
    const filePath = path.join(statsDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`未找到统计表，已跳过: ${filePath}`);
      continue;
    }

    const wb = XLSX.readFile(filePath);
    let fileRecordCount = 0;

    for (const sheetName of wb.SheetNames) {
      const className = normalizeClassName(sheetName);
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      const headerIdx = rows.findIndex((r) => Array.isArray(r) && r.includes('学号') && r.includes('姓名'));
      if (headerIdx < 0) continue;

      const headerRow = rows[headerIdx];
      const seatCol = headerRow.indexOf('座号');
      const codeCol = headerRow.indexOf('学号');
      const nameCol = headerRow.indexOf('姓名');
      const lessons = parseLessonColumns(headerRow);

      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!Array.isArray(row)) continue;

        const studentName = String(row[nameCol] || '').trim();
        let studentNo = seatCol >= 0 ? parseInt(row[seatCol], 10) : NaN;
        if (isNaN(studentNo) && codeCol >= 0) {
          const codeStr = String(row[codeCol] || '').trim();
          if (/^\d{2,}$/.test(codeStr)) {
            studentNo = parseInt(codeStr.slice(-2), 10);
          }
        }
        if (!studentName || isNaN(studentNo) || studentNo <= 0) continue;

        for (const lesson of lessons) {
          const statusText = String(row[lesson.statusCol] || '').trim();
          if (UNSUBMITTED_SET.has(statusText)) continue;

          const scoreRaw = lesson.scoreCol >= 0 ? row[lesson.scoreCol] : '';
          const scoreNum = scoreRaw !== '' && scoreRaw !== null && !isNaN(Number(scoreRaw)) ? Number(scoreRaw) : null;
          const detail = lesson.detailCol >= 0 ? String(row[lesson.detailCol] || '').trim() : '';

          let resolvedDate = classLessonDateMap.get(`${lesson.title}::${className}`) || '';
          if (resolvedDate) {
            dateSourceCounts.archive_class++;
          } else if (lesson.headerDate) {
            resolvedDate = lesson.headerDate;
            dateSourceCounts.header++;
          } else if (lessonModeDateMap.has(lesson.title)) {
            resolvedDate = lessonModeDateMap.get(lesson.title);
            dateSourceCounts.archive_lesson++;
          } else {
            resolvedDate = '2026-11-01';
            dateSourceCounts.fallback++;
          }

          records.push({
            class_name: className,
            student_no: studentNo,
            student_name: studentName,
            lesson_title: lesson.title,
            status_text: statusText,
            score: scoreNum,
            detail,
            submitted_at: `${resolvedDate} 12:00:00`,
            source_file: fileName
          });
          fileRecordCount++;
        }
      }
    }

    statsBySource[fileName] = fileRecordCount;
  }

  const inserted = db.replaceHistoricalSubmissions(records);
  return {
    inserted,
    statsBySource,
    dateSourceCounts
  };
}

if (require.main === module) {
  const statsDir = process.argv[2] || DEFAULT_STATS_DIR;
  const archiveDir = process.argv[3] || DEFAULT_ARCHIVE_DIR;
  const res = importHistoryStats(statsDir, archiveDir);
  console.log('=== 历史作业提交记录导入完成 ===');
  console.log(`共导入记录数: ${res.inserted}`);
  console.log('按统计表分布:', res.statsBySource);
  console.log('提交日期来源统计:', res.dateSourceCounts);
}

module.exports = {
  importHistoryStats
};
