const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { getLocalIpAddresses } = require('../utils/ipHelper');
const { parseRosterBuffer } = require('../utils/rosterParser');
const auth = require('../utils/auth');
const db = require('../db');

// Helper to decode Chinese filenames properly from multer
function decodeOriginalName(originalname) {
  try {
    const decoded = Buffer.from(originalname, 'latin1').toString('utf8');
    if (decoded && !/[ÃÂ]/.test(decoded)) {
      return decoded;
    }
    return originalname;
  } catch (e) {
    return originalname;
  }
}

const teacherSseClients = new Set();

function notifyTeacherClients(eventName, payload = {}) {
  if (teacherSseClients.size === 0) return;
  const data = JSON.stringify({ ...payload, ts: Date.now() });
  const chunk = `event: ${eventName}\ndata: ${data}\n\n`;
  for (const res of teacherSseClients) {
    try {
      res.write(chunk);
    } catch (e) {
      teacherSseClients.delete(res);
    }
  }
}

function sanitizeFilenamePart(str) {
  return String(str || '').trim().replace(/[\\/:*?"<>|]/g, '_');
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip redundant student number, student name, and timestamp suffixes from original filename
function normalizeStudentOriginalName(rawOriginalName, studentNo, studentName) {
  const safeOrig = sanitizeFilenamePart(rawOriginalName || '作业');
  const ext = path.extname(safeOrig);
  let base = path.basename(safeOrig, ext).trim();

  // Remove trailing long timestamp / random numeric suffixes such as _1794533562239 or _1794533562239_123
  base = base.replace(/(?:[_\-\s]+\d{10,13}(?:_\d{1,5})?)+$/g, '');

  const noNum = parseInt(studentNo, 10);
  const noPatterns = [];
  if (!isNaN(noNum) && noNum > 0) {
    const paddedNo = String(noNum).padStart(2, '0');
    const rawNo = String(noNum);
    noPatterns.push(paddedNo, rawNo);
  }
  const cleanStudentName = sanitizeFilenamePart(studentName || '');

  // Iteratively strip leading duplicated studentNo / studentName prefixes
  let changed = true;
  while (changed && base) {
    changed = false;
    base = base.replace(/^[\s_\-—.]+/, '');

    if (cleanStudentName) {
      const nameRe = new RegExp(`^${escapeRegExp(cleanStudentName)}(?:[\\s_\\-—.]+|$)`);
      if (nameRe.test(base)) {
        base = base.replace(nameRe, '');
        changed = true;
        continue;
      }
    }

    for (const noStr of noPatterns) {
      const noRe = new RegExp(`^${escapeRegExp(noStr)}号?(?:[\\s_\\-—.]+|$)`);
      if (noRe.test(base)) {
        base = base.replace(noRe, '');
        changed = true;
        break;
      }
    }
  }

  base = base.replace(/[\s_\-—.]+$/g, '').replace(/_{2,}/g, '_');
  if (!base) {
    base = '作业';
  }
  return `${base}${ext}`;
}

function buildFormattedSubmissionFilename(studentNo, studentName, cleanOriginalName) {
  const paddedNo = String(studentNo).padStart(2, '0');
  const safeName = sanitizeFilenamePart(studentName || '');
  const namePart = safeName ? `_${safeName}` : '';
  return `${paddedNo}号${namePart}_${cleanOriginalName}`;
}

function cleanupUploadedFiles(files) {
  for (const f of files) {
    if (f && f.path && fs.existsSync(f.path)) {
      try {
        fs.unlinkSync(f.path);
      } catch (e) {
        console.error('清理无效上传文件失败:', e);
      }
    }
  }
}

// Multer storage for teacher materials
const materialStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, db.materialsDir);
  },
  filename: function (req, file, cb) {
    const orig = decodeOriginalName(file.originalname);
    const ext = path.extname(orig);
    const base = sanitizeFilenamePart(path.basename(orig, ext));
    const unique = Date.now() + '_' + Math.floor(Math.random() * 1000);
    cb(null, `${base}_${unique}${ext}`);
  }
});
const uploadMaterial = multer({
  storage: materialStorage,
  limits: { fileSize: 300 * 1024 * 1024 } // 300MB
});

// Multer storage for student homework submissions
const submissionStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const className = sanitizeFilenamePart(req.body.class_name || '未分组');
    const classDir = path.join(db.submissionsDir, className);
    if (!fs.existsSync(classDir)) {
      fs.mkdirSync(classDir, { recursive: true });
    }
    cb(null, classDir);
  },
  filename: function (req, file, cb) {
    const orig = decodeOriginalName(file.originalname);
    const ext = path.extname(orig);
    const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    cb(null, `.__tmp_${unique}${ext}`);
  }
});
const uploadSubmission = multer({
  storage: submissionStorage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

// Multer memory storage for Excel roster import
const uploadRoster = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// -------------------------------------------------------------
// Teacher Authentication
// -------------------------------------------------------------
router.post('/teacher/login', (req, res) => {
  try {
    const password = String((req.body && req.body.password) || '');
    if (!auth.verifyTeacherPassword(password)) {
      return res.status(401).json({ success: false, message: '教师密码错误，请重试' });
    }
    const token = auth.createSessionToken();
    auth.setSessionCookie(res, token);
    res.json({ success: true, message: '登录成功' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/teacher/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

router.post('/teacher/change-password', auth.requireTeacherAuth, (req, res) => {
  try {
    const oldPassword = String((req.body && req.body.old_password) || '');
    const newPassword = String((req.body && req.body.new_password) || '');
    if (!auth.verifyTeacherPassword(oldPassword)) {
      return res.status(400).json({ success: false, message: '原密码不正确' });
    }
    auth.updateTeacherPassword(newPassword);
    auth.setSessionCookie(res, auth.createSessionToken());
    res.json({ success: true, message: '教师管理密码已更新' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || '修改密码失败' });
  }
});

// -------------------------------------------------------------
// Server Information
// -------------------------------------------------------------
router.get('/info', (req, res) => {
  const ipList = getLocalIpAddresses();
  const port = process.env.PORT || 3000;
  res.json({
    success: true,
    data: {
      port,
      ips: ipList,
      primaryUrl: ipList.length > 0 ? `http://${ipList[0].address}:${port}` : `http://localhost:${port}`
    }
  });
});

// -------------------------------------------------------------
// Classes & Roster
// -------------------------------------------------------------
router.get('/classes', (req, res) => {
  try {
    const list = db.getClasses();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Student-safe endpoint: returns ONLY seat numbers (no names)
router.get('/classes/student-nos', (req, res) => {
  try {
    const className = (req.query.class_name || '').trim();
    if (!className) {
      return res.json({ success: true, data: [] });
    }
    const nos = db.getClassStudentNos(className);
    res.json({ success: true, data: nos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/classes', auth.requireTeacherAuth, (req, res) => {
  try {
    const { name, max_student_no } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '请填写班级名称' });
    }
    const created = db.addClass(name, max_student_no || 45);
    res.json({ success: true, data: created });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || '添加班级失败' });
  }
});

router.put('/classes/:id', auth.requireTeacherAuth, (req, res) => {
  try {
    const maxNo = parseInt(req.body.max_student_no, 10);
    if (!maxNo || isNaN(maxNo) || maxNo < 1 || maxNo > 120) {
      return res.status(400).json({ success: false, message: '班级人数请在 1 到 120 之间' });
    }
    db.updateClassMaxNo(req.params.id, maxNo);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/classes/:id', auth.requireTeacherAuth, (req, res) => {
  try {
    db.deleteClass(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Teacher: import Excel roster
router.post('/roster/import', auth.requireTeacherAuth, uploadRoster.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择要导入的名单 Excel 文件' });
    }
    const parsed = parseRosterBuffer(req.file.buffer);
    if (!parsed.classes.length || !parsed.students.length) {
      return res.status(400).json({
        success: false,
        message: '未在 Excel 中识别到有效的学生名单，请确认包含“班级/教学班级”“座号/班内座号”“姓名”列'
      });
    }

    const summary = db.replaceRoster(parsed.classes, parsed.students);
    res.json({
      success: true,
      message: `名单导入成功！共更新 ${summary.classCount} 个班级、${summary.studentCount} 名学生。`,
      data: summary
    });
  } catch (err) {
    console.error('导入名单错误:', err);
    res.status(500).json({ success: false, message: '解析或导入名单失败: ' + err.message });
  }
});

// -------------------------------------------------------------
// Broadcast & Status (Student-safe: strictly NO student names)
// -------------------------------------------------------------
router.get('/broadcast', (req, res) => {
  try {
    const state = db.getBroadcastState();
    if (!state.active || !state.className) {
      return res.json({ success: true, data: { active: false } });
    }
    const summary = db.getClassSubmissionSummary(state.className, false);
    res.json({
      success: true,
      data: {
        active: true,
        updatedAt: state.updatedAt,
        ...summary
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/teacher/events', auth.requireTeacherAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);
  teacherSseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(heartbeat);
      teacherSseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    teacherSseClients.delete(res);
  });
});

router.post('/broadcast/start', auth.requireTeacherAuth, (req, res) => {
  try {
    const className = (req.body.class_name || '').trim();
    if (!className) {
      return res.status(400).json({ success: false, message: '请先选择要广播的班级' });
    }
    const cls = db.getClassByName(className);
    if (!cls) {
      return res.status(404).json({ success: false, message: '未找到指定班级' });
    }
    const state = db.setBroadcastState({ active: true, className });
    notifyTeacherClients('broadcast_updated', { active: true, className });
    res.json({ success: true, data: state, message: `已开启【${className}】未交学号广播` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/broadcast/stop', auth.requireTeacherAuth, (req, res) => {
  try {
    const state = db.setBroadcastState({ active: false, className: '' });
    notifyTeacherClients('broadcast_updated', { active: false, className: '' });
    res.json({ success: true, data: state, message: '已停止未交学号广播' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Student-safe personal submission status check (strictly NO names)
router.get('/submission-status', (req, res) => {
  try {
    const className = (req.query.class_name || '').trim();
    const studentNo = parseInt(req.query.student_no, 10);
    if (!className || !studentNo || isNaN(studentNo) || studentNo <= 0) {
      return res.json({ success: true, data: { submitted: false } });
    }
    const status = db.getSingleSubmissionStatus(className, studentNo);
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Teacher-only class summary (includes names of missing students)
router.get('/teacher/class-summary', auth.requireTeacherAuth, (req, res) => {
  try {
    const className = (req.query.class_name || '').trim();
    if (!className) {
      return res.status(400).json({ success: false, message: '缺少班级参数' });
    }
    const summary = db.getClassSubmissionSummary(className, true);
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// Materials (Teacher upload & Student download)
// -------------------------------------------------------------
router.get('/materials', (req, res) => {
  try {
    const list = db.getMaterials();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const uploadMaterialFields = uploadMaterial.fields([
  { name: 'files', maxCount: 20 },
  { name: 'file', maxCount: 20 }
]);

router.post('/materials', auth.requireTeacherAuth, uploadMaterialFields, (req, res) => {
  const uploadedFiles = [
    ...((req.files && req.files.files) || []),
    ...((req.files && req.files.file) || [])
  ];

  try {
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ success: false, message: '请选择要上传的文件' });
    }
    const customTitle = (req.body.title || '').trim();
    const items = [];

    for (const file of uploadedFiles) {
      const originalName = decodeOriginalName(file.originalname);
      let title = originalName;
      if (customTitle) {
        title = uploadedFiles.length === 1 ? customTitle : `${customTitle} - ${originalName}`;
      }
      const item = db.addMaterial(title, originalName, file.filename, file.path, file.size);
      items.push(item);
    }

    res.json({
      success: true,
      data: items.length === 1 ? items[0] : items,
      items,
      message: items.length === 1 ? '文件上传成功' : `成功发布 ${items.length} 个文件`
    });
  } catch (err) {
    cleanupUploadedFiles(uploadedFiles);
    console.error('上传资料错误:', err);
    res.status(500).json({ success: false, message: err.message || '上传失败' });
  }
});

router.get('/materials/download/:id', (req, res) => {
  try {
    const item = db.getMaterialById(req.params.id);
    if (!item || !fs.existsSync(item.file_path)) {
      return res.status(404).send('文件不存在或已被删除');
    }
    const encodedName = encodeURIComponent(item.original_name);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    res.sendFile(path.resolve(item.file_path));
  } catch (err) {
    res.status(500).send('下载异常: ' + err.message);
  }
});

router.delete('/materials/:id', auth.requireTeacherAuth, (req, res) => {
  try {
    db.deleteMaterial(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// Submissions (Students submit homework)
// -------------------------------------------------------------
router.get('/submissions', auth.requireTeacherAuth, (req, res) => {
  try {
    const { class_name } = req.query;
    const list = db.getSubmissions(class_name);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const uploadSubmissionFields = uploadSubmission.fields([
  { name: 'files', maxCount: 20 },
  { name: 'file', maxCount: 20 }
]);

router.post('/submissions', uploadSubmissionFields, (req, res) => {
  const uploadedFiles = [
    ...((req.files && req.files.files) || []),
    ...((req.files && req.files.file) || [])
  ];

  try {
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ success: false, message: '请选择作业文件' });
    }
    const className = (req.body.class_name || '').trim();
    const studentNo = parseInt(req.body.student_no, 10);
    const note = (req.body.note || '').trim();

    if (!className) {
      cleanupUploadedFiles(uploadedFiles);
      return res.status(400).json({ success: false, message: '请选择所在班级' });
    }
    if (!studentNo || isNaN(studentNo) || studentNo <= 0) {
      cleanupUploadedFiles(uploadedFiles);
      return res.status(400).json({ success: false, message: '请选择有效学号' });
    }

    // Match real name automatically from built-in roster (never exposed back to student)
    const rosterStudent = db.getStudent(className, studentNo);
    const studentName = rosterStudent ? rosterStudent.student_name : '';

    const safeClassDir = path.join(db.submissionsDir, sanitizeFilenamePart(className));
    if (!fs.existsSync(safeClassDir)) {
      fs.mkdirSync(safeClassDir, { recursive: true });
    }

    const paddedNo = String(studentNo).padStart(2, '0');
    const ipAddress = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
    let updateCount = 0;
    const savedFiles = [];

    for (const file of uploadedFiles) {
      const rawOriginalName = decodeOriginalName(file.originalname);
      const cleanOriginalName = normalizeStudentOriginalName(rawOriginalName, studentNo, studentName);
      const formattedStoredName = buildFormattedSubmissionFilename(studentNo, studentName, cleanOriginalName);
      let finalFilePath = path.join(safeClassDir, formattedStoredName);
      let finalStoredName = formattedStoredName;

      if (file.path !== finalFilePath) {
        try {
          fs.renameSync(file.path, finalFilePath);
        } catch (renameErr) {
          console.error('重命名作业文件失败:', renameErr);
          finalFilePath = file.path;
          finalStoredName = file.filename;
        }
      }

      const result = db.saveOrUpdateSubmission({
        className,
        studentNo,
        studentName,
        note,
        originalName: cleanOriginalName,
        storedName: finalStoredName,
        filePath: finalFilePath,
        fileSize: file.size,
        ipAddress
      });

      if (result.isUpdate) updateCount++;
      savedFiles.push({
        id: result.id,
        originalName: cleanOriginalName,
        storedName: finalStoredName,
        fileSize: file.size,
        isUpdate: result.isUpdate
      });
    }

    const totalCount = savedFiles.length;
    let msg;
    if (totalCount === 1) {
      msg = updateCount === 1
        ? `学号 ${paddedNo} 号已有同名作业，已成功为您覆盖更新！`
        : `提交成功！学号 ${paddedNo} 号作业已收到。`;
    } else if (updateCount === 0) {
      msg = `提交成功！学号 ${paddedNo} 号共收到 ${totalCount} 个作业文件。`;
    } else if (updateCount === totalCount) {
      msg = `学号 ${paddedNo} 号的 ${totalCount} 个同名作业文件已全部覆盖更新！`;
    } else {
      msg = `成功提交 ${totalCount} 个文件（其中 ${updateCount} 个同名文件已覆盖更新）。`;
    }

    notifyTeacherClients('submissions_updated', {
      className,
      studentNo,
      count: savedFiles.length
    });

    // Strictly NO studentName returned to student client
    res.json({
      success: true,
      message: msg,
      data: {
        className,
        studentNo,
        originalName: savedFiles.map(f => f.originalName).join('、'),
        fileSize: savedFiles.reduce((sum, f) => sum + f.fileSize, 0),
        files: savedFiles.map(f => ({
          id: f.id,
          originalName: f.originalName,
          fileSize: f.fileSize,
          isUpdate: f.isUpdate
        })),
        submittedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      }
    });
  } catch (err) {
    cleanupUploadedFiles(uploadedFiles);
    console.error('提交作业错误:', err);
    res.status(500).json({ success: false, message: err.message || '提交异常' });
  }
});

router.get('/submissions/download/:id', auth.requireTeacherAuth, (req, res) => {
  try {
    const item = db.getSubmissionById(req.params.id);
    if (!item || !fs.existsSync(item.file_path)) {
      return res.status(404).send('作业文件不存在或已被删除');
    }
    const cleanOrig = normalizeStudentOriginalName(item.original_name, item.student_no, item.student_name);
    const formattedName = buildFormattedSubmissionFilename(item.student_no, item.student_name, cleanOrig);
    const downloadName = `${sanitizeFilenamePart(item.class_name)}_${formattedName}`;
    const encodedName = encodeURIComponent(downloadName);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    res.sendFile(path.resolve(item.file_path));
  } catch (err) {
    res.status(500).send('下载异常: ' + err.message);
  }
});

router.delete('/submissions/:id', auth.requireTeacherAuth, (req, res) => {
  try {
    db.deleteSubmission(req.params.id);
    notifyTeacherClients('submissions_updated', { deletedId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// One-click batch ZIP export
router.get('/submissions/export-zip', auth.requireTeacherAuth, (req, res) => {
  try {
    const { class_name } = req.query;
    const submissions = db.getSubmissions(class_name);

    if (!submissions || submissions.length === 0) {
      return res.status(400).send('当前选定范围内暂无任何已提交作业');
    }

    const zip = new AdmZip();
    const usedZipEntries = new Set();
    let fileCount = 0;

    for (const sub of submissions) {
      if (sub.file_path && fs.existsSync(sub.file_path)) {
        const safeClass = sanitizeFilenamePart(sub.class_name || '未分班');
        const cleanOrig = normalizeStudentOriginalName(sub.original_name, sub.student_no, sub.student_name);
        let inZipFileName = buildFormattedSubmissionFilename(sub.student_no, sub.student_name, cleanOrig);

        // Guard against duplicate entry names inside ZIP if legacy dirty filenames normalize to the same name
        let entryKey = `${safeClass}/${inZipFileName}`.toLowerCase();
        if (usedZipEntries.has(entryKey)) {
          const ext = path.extname(inZipFileName);
          const base = path.basename(inZipFileName, ext);
          let seq = 2;
          while (usedZipEntries.has(`${safeClass}/${base}_${seq}${ext}`.toLowerCase())) {
            seq++;
          }
          inZipFileName = `${base}_${seq}${ext}`;
          entryKey = `${safeClass}/${inZipFileName}`.toLowerCase();
        }
        usedZipEntries.add(entryKey);

        zip.addLocalFile(sub.file_path, safeClass, inZipFileName);
        fileCount++;
      }
    }

    if (fileCount === 0) {
      return res.status(400).send('未在磁盘中找到有效的作业文件');
    }

    const zipBuffer = zip.toBuffer();
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const targetLabel = sanitizeFilenamePart(class_name || '全部班级作业');
    const downloadZipName = `${targetLabel}_${dateStr}.zip`;
    const encodedName = encodeURIComponent(downloadZipName);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    res.end(zipBuffer);
  } catch (err) {
    console.error('ZIP导出错误:', err);
    res.status(500).send('打包导出失败: ' + err.message);
  }
});

module.exports = router;
