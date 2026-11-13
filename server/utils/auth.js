const crypto = require('crypto');
const db = require('../db');

const COOKIE_NAME = 'hp_teacher_session';
const DEFAULT_PASSWORD = '888888';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPasswordHash(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuf);
}

function getSessionSecret() {
  let secret = db.getSetting('teacher_session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.setSetting('teacher_session_secret', secret);
  }
  return secret;
}

function getSessionVersion() {
  let ver = db.getSetting('teacher_session_version');
  if (!ver) {
    ver = '1';
    db.setSetting('teacher_session_version', ver);
  }
  return ver;
}

function ensurePasswordInitialized() {
  let hash = db.getSetting('teacher_password_hash');
  if (!hash) {
    hash = hashPassword(DEFAULT_PASSWORD);
    db.setSetting('teacher_password_hash', hash);
  }
  getSessionSecret();
  getSessionVersion();
  return hash;
}

function verifyTeacherPassword(password) {
  const storedHash = ensurePasswordInitialized();
  return verifyPasswordHash(String(password || ''), storedHash);
}

function updateTeacherPassword(newPassword) {
  const pwd = String(newPassword || '');
  if (pwd.length < 4 || pwd.length > 64) {
    throw new Error('新密码长度请设为 4 到 64 位');
  }
  db.setSetting('teacher_password_hash', hashPassword(pwd));
  const nextVer = String((parseInt(getSessionVersion(), 10) || 1) + 1);
  db.setSetting('teacher_session_version', nextVer);
}

function signToken(payload) {
  const secret = getSessionSecret();
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createSessionToken() {
  ensurePasswordInitialized();
  const exp = Date.now() + SESSION_TTL_MS;
  const ver = getSessionVersion();
  const payload = `${exp}.${ver}`;
  const sig = signToken(payload);
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, ver, sigHex] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  if (ver !== getSessionVersion()) return false;

  const expectedSigHex = signToken(`${expStr}.${ver}`);
  const actualBuf = Buffer.from(sigHex, 'hex');
  const expectedBuf = Buffer.from(expectedSigHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const rawVal = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawVal);
    } catch (e) {
      cookies[key] = rawVal;
    }
  }
  return cookies;
}

function isTeacherAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, token) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
}

function requireTeacherAuth(req, res, next) {
  if (isTeacherAuthenticated(req)) {
    return next();
  }
  return res.status(401).json({
    success: false,
    code: 'AUTH_REQUIRED',
    message: '请先输入教师管理密码登录'
  });
}

module.exports = {
  COOKIE_NAME,
  ensurePasswordInitialized,
  verifyTeacherPassword,
  updateTeacherPassword,
  createSessionToken,
  isTeacherAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  requireTeacherAuth
};
