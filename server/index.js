const express = require('express');
const path = require('path');
const { getLocalIpAddresses } = require('./utils/ipHelper');
const auth = require('./utils/auth');

auth.ensurePasswordInitialized();

const app = express();
const PORT = process.env.PORT || 3000;

// Request body parser
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Guard teacher page & script before static asset serving
function serveTeacherPage(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (auth.isTeacherAuthenticated(req)) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'teacher.html'));
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'teacher-login.html'));
}

app.get(['/teacher', '/teacher/', '/teacher.html'], serveTeacherPage);

app.get('/teacher-login.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (auth.isTeacherAuthenticated(req)) {
    return res.redirect('/teacher');
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'teacher-login.html'));
});

app.get('/js/teacher.js', (req, res) => {
  if (!auth.isTeacherAuthenticated(req)) {
    return res.status(401).type('application/javascript').send('// auth required');
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'js', 'teacher.js'));
});

// Static assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', require('./routes/api'));

// Front-end route mappings
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Fallback error handler
app.use((err, req, res, next) => {
  console.error('服务异常:', err);
  res.status(500).json({ success: false, message: err.message || '服务器内部异常' });
});

// Start listening
app.listen(PORT, '0.0.0.0', () => {
  const ipList = getLocalIpAddresses();
  console.log('================================================================');
  console.log('            课堂作业收发平台 (服务已启动)                       ');
  console.log('================================================================');
  console.log(`[服务端口] : ${PORT}`);
  console.log(`[本机学生端] : http://localhost:${PORT}`);
  console.log(`[教师管理端] : http://localhost:${PORT}/teacher`);
  console.log('----------------------------------------------------------------');
  console.log('[机房学生端访问地址] (学生在浏览器地址栏输入下列地址直接交作业):');
  if (ipList.length === 0) {
    console.log(`  http://127.0.0.1:${PORT}`);
  } else {
    ipList.forEach((item) => {
      console.log(`  http://${item.address}:${PORT}  (${item.interface})`);
    });
  }
  console.log('================================================================');
});
