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

function sanitizeFilenamePart(str) {
  return String(str || '').trim().replace(/[\\/:*?"<>|]/g, '_');
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
    const studentNoNum = parseInt(req.body.student_no, 10) || 0;
    const studentNo = String(studentNoNum).padStart(2, '0');
    const rosterStudent = db.getStudent(req.body.class_name, studentNoNum);
    const studentName = sanitizeFilenamePart(rosterStudent ? rosterStudent.student_name : '学生');
    const orig = decodeOriginalName(file.originalname);
    const ext = path.extname(orig);
    const base = sanitizeFilenamePart(path.basename(orig, ext));
    const unique = Date.now();
    cb(null, `${studentNo}号_${studentName}_${base}_${unique}${ext}`);
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
    res.json({ success: true, data: state, message: `已开启【${className}】未交学号广播` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/broadcast/stop', auth.requireTeacherAuth, (req, res) => {
  try {
    const state = db.setBroadcastState({ active: false, className: '' });
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

router.post('/materials', auth.requireTeacherAuth, uploadMaterial.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择要上传的文件' });
    }
    const originalName = decodeOriginalName(req.file.originalname);
    const title = (req.body.title || originalName).trim();
    const storedName = req.file.filename;
    const filePath = req.file.path;
    const fileSize = req.file.size;

    const item = db.addMaterial(title, originalName, storedName, filePath, fileSize);
    res.json({ success: true, data: item, message: '文件上传成功' });
  } catch (err) {
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

router.post('/submissions', uploadSubmission.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择作业文件' });
    }
    const className = (req.body.class_name || '').trim();
    const studentNo = parseInt(req.body.student_no, 10);
    const note = (req.body.note || '').trim();

    if (!className) {
      return res.status(400).json({ success: false, message: '请选择所在班级' });
    }
    if (!studentNo || isNaN(studentNo) || studentNo <= 0) {
      return res.status(400).json({ success: false, message: '请选择有效学号' });
    }

    // Match real name automatically from built-in roster (never exposed back to student)
    const rosterStudent = db.getStudent(className, studentNo);
    const studentName = rosterStudent ? rosterStudent.student_name : '';

    const originalName = decodeOriginalName(req.file.originalname);
    let storedName = req.file.filename;
    let filePath = req.file.path;

    // Ensure target folder and stored filename reflect matched class & roster name
    const safeClassDir = path.join(db.submissionsDir, sanitizeFilenamePart(className));
    if (!fs.existsSync(safeClassDir)) {
      fs.mkdirSync(safeClassDir, { recursive: true });
    }
    const paddedNo = String(studentNo).padStart(2, '0');
    const safeName = sanitizeFilenamePart(studentName || '未匹配姓名');
    const ext = path.extname(originalName);
    const base = sanitizeFilenamePart(path.basename(originalName, ext));
    const expectedStoredName = `${paddedNo}号_${safeName}_${base}_${Date.now()}${ext}`;
    const expectedFilePath = path.join(safeClassDir, expectedStoredName);
    if (filePath !== expectedFilePath) {
      try {
        fs.renameSync(filePath, expectedFilePath);
        filePath = expectedFilePath;
        storedName = expectedStoredName;
      } catch (renameErr) {
        console.error('重命名作业文件失败:', renameErr);
      }
    }

    const fileSize = req.file.size;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

    const result = db.saveOrUpdateSubmission({
      className,
      studentNo,
      studentName,
      note,
      originalName,
      storedName,
      filePath,
      fileSize,
      ipAddress: String(ipAddress).replace('::ffff:', '')
    });

    const msg = result.isUpdate
      ? `学号 ${paddedNo} 号已有提交记录，已成功覆盖更新作业！`
      : `提交成功！学号 ${paddedNo} 号作业已收到。`;

    // Strictly NO studentName returned to student client
    res.json({
      success: true,
      message: msg,
      data: {
        className,
        studentNo,
        originalName,
        fileSize,
        submittedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      }
    });
  } catch (err) {
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
    const paddedNo = String(item.student_no).padStart(2, '0');
    const namePart = item.student_name ? `_${item.student_name}` : '';
    const downloadName = `${item.class_name}_${paddedNo}号${namePart}_${item.original_name}`;
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
    let fileCount = 0;

    for (const sub of submissions) {
      if (sub.file_path && fs.existsSync(sub.file_path)) {
        const paddedNo = String(sub.student_no).padStart(2, '0');
        const namePart = sub.student_name ? `_${sub.student_name}` : '';
        const safeClass = sanitizeFilenamePart(sub.class_name || '未分班');
        const safeOriginal = sanitizeFilenamePart(sub.original_name);
        const inZipFileName = `${paddedNo}号${namePart}_${safeOriginal}`;

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
