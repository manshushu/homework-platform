const XLSX = require('xlsx');

/**
 * 将 "六(1)班" / "六（1）班" / "六1班" 统一规范化为 "六年级1班"
 */
function normalizeClassName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^([六七八九])[年级]*[\(（]?(\d+)[\)）]?班$/);
  if (m) {
    return `${m[1]}年级${parseInt(m[2], 10)}班`;
  }
  return s;
}

/**
 * 从 Excel 缓冲区解析班级和学生名单
 * 兼容《六七八年级学生名单汇总表.xlsx》及常见三列表格（班级、座号/学号、姓名）
 */
function parseRosterBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const preferredSheets = ['六七八年级学生总名单汇总', '总名单', '学生名单'];
  let targetSheets = preferredSheets.filter((name) => wb.SheetNames.includes(name));
  if (targetSheets.length === 0) {
    // 跳过总览页，优先扫描各年级汇总页或所有表
    targetSheets = wb.SheetNames.filter((name) => !name.includes('总览'));
  }

  const students = [];
  const seen = new Set();
  const classOrder = [];
  const classMaxNo = new Map();

  for (const sheetName of targetSheets) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows || rows.length === 0) continue;

    // 查找表头行
    let headerIdx = -1;
    let colClass = -1;
    let colSeat = -1;
    let colCode = -1;
    let colName = -1;

    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i].map((c) => String(c || '').trim());
      const cIdx = r.findIndex((h) => h === '教学班级' || h === '班级' || h === '所在班级');
      const sIdx = r.findIndex((h) => h === '班内座号' || h === '座号' || h === '号数');
      const codeIdx = r.findIndex((h) => h === '学号');
      const nIdx = r.findIndex((h) => h === '姓名' || h === '学生姓名');

      if (nIdx !== -1 && (sIdx !== -1 || codeIdx !== -1)) {
        headerIdx = i;
        colClass = cIdx;
        colSeat = sIdx !== -1 ? sIdx : codeIdx;
        colCode = codeIdx;
        colName = nIdx;
        break;
      }
    }

    if (headerIdx === -1) continue;

    // 若表格本身是单班表（无班级列），用 sheetName 作为班级名
    const fallbackClass = normalizeClassName(sheetName);

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const firstCell = String(r[0] || '').trim();
      if (firstCell === '统计' || firstCell === '合计' || firstCell === '小计') continue;

      const rawClass = colClass !== -1 ? r[colClass] : fallbackClass;
      const className = normalizeClassName(rawClass);
      const studentNo = parseInt(r[colSeat], 10);
      const studentName = String(r[colName] || '').trim();
      const studentCode = colCode !== -1 ? String(r[colCode] || '').trim() : '';

      if (!className || !studentNo || isNaN(studentNo) || studentNo <= 0 || !studentName) {
        continue;
      }

      const key = `${className}__${studentNo}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!classMaxNo.has(className)) {
        classMaxNo.set(className, 0);
        classOrder.push(className);
      }
      if (studentNo > classMaxNo.get(className)) {
        classMaxNo.set(className, studentNo);
      }

      students.push({
        class_name: className,
        student_no: studentNo,
        student_code: studentCode,
        student_name: studentName
      });
    }

    // 如果已经从总汇总表成功读出数据，不必再重复扫分表
    if (preferredSheets.includes(sheetName) && students.length > 0) {
      break;
    }
  }

  const classes = classOrder.map((name) => ({
    name,
    max_student_no: classMaxNo.get(name)
  }));

  return { classes, students };
}

module.exports = {
  normalizeClassName,
  parseRosterBuffer
};
