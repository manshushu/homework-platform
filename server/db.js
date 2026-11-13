const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const storageDir = path.join(__dirname, '..', 'storage');
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

const materialsDir = path.join(storageDir, 'materials');
if (!fs.existsSync(materialsDir)) {
  fs.mkdirSync(materialsDir, { recursive: true });
}

const submissionsDir = path.join(storageDir, 'submissions');
if (!fs.existsSync(submissionsDir)) {
  fs.mkdirSync(submissionsDir, { recursive: true });
}

const dbPath = path.join(storageDir, 'homework_platform.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function seedRosterIfEmpty() {
  const studentCountRow = db.prepare('SELECT COUNT(*) AS count FROM students').get();
  if (studentCountRow.count > 0) return;

  const rosterFile = path.join(__dirname, 'data', 'roster.json');
  if (!fs.existsSync(rosterFile)) return;

  let roster;
  try {
    roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
  } catch (err) {
    console.error('读取内置名单失败:', err);
    return;
  }

  const classes = Array.isArray(roster.classes) ? roster.classes : [];
  const students = Array.isArray(roster.students) ? roster.students : [];
  if (classes.length === 0 || students.length === 0) return;

  const existingClasses = db.prepare('SELECT id, name, max_student_no FROM classes').all();
  const subCount = db.prepare('SELECT COUNT(*) AS count FROM submissions').get().count;
  const looksLikeOldDefault66 =
    existingClasses.length === 66 &&
    existingClasses.every((c) => c.max_student_no === 55 && /^(六|七|八)年级\d+班$/.test(c.name));

  db.exec('BEGIN');
  try {
    if (existingClasses.length === 0 || (subCount === 0 && looksLikeOldDefault66)) {
      db.exec('DELETE FROM classes');
      const insertClass = db.prepare('INSERT INTO classes (name, max_student_no) VALUES (?, ?)');
      for (const cls of classes) {
        insertClass.run(cls.name, Number(cls.max_student_no) || 45);
      }
    } else {
      const upsertClass = db.prepare(`
        INSERT INTO classes (name, max_student_no) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET max_student_no = excluded.max_student_no
      `);
      for (const cls of classes) {
        upsertClass.run(cls.name, Number(cls.max_student_no) || 45);
      }
    }

    const insertStudent = db.prepare(`
      INSERT OR REPLACE INTO students (class_name, student_no, student_name, student_code)
      VALUES (?, ?, ?, ?)
    `);
    for (const st of students) {
      insertStudent.run(st.class_name, Number(st.student_no), st.student_name, st.student_code || '');
    }

    db.exec('COMMIT');
    console.log(`已初始化内置名单: ${classes.length} 个班级，${students.length} 名学生`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('初始化内置名单失败:', err);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      max_student_no INTEGER DEFAULT 55,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_name TEXT NOT NULL,
      student_no INTEGER NOT NULL,
      student_name TEXT NOT NULL,
      student_code TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(class_name, student_no)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_name TEXT NOT NULL,
      student_no INTEGER NOT NULL,
      student_name TEXT DEFAULT '',
      note TEXT DEFAULT '',
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      ip_address TEXT DEFAULT '',
      submitted_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(class_name, student_no, original_name)
    );

    CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_name);
    CREATE INDEX IF NOT EXISTS idx_submissions_class ON submissions(class_name);
    CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(class_name, student_no);
  `);

  // Migrate legacy submissions table that enforced UNIQUE(class_name, student_no)
  const tableRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='submissions'").get();
  if (tableRow && tableRow.sql && !tableRow.sql.includes('original_name)')) {
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE submissions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name TEXT NOT NULL,
        student_no INTEGER NOT NULL,
        student_name TEXT DEFAULT '',
        note TEXT DEFAULT '',
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        ip_address TEXT DEFAULT '',
        submitted_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(class_name, student_no, original_name)
      );
      INSERT INTO submissions_new (id, class_name, student_no, student_name, note, original_name, stored_name, file_path, file_size, ip_address, submitted_at, updated_at)
      SELECT id, class_name, student_no, student_name, note, original_name, stored_name, file_path, file_size, ip_address, submitted_at, updated_at FROM submissions;
      DROP TABLE submissions;
      ALTER TABLE submissions_new RENAME TO submissions;
      CREATE INDEX IF NOT EXISTS idx_submissions_class ON submissions(class_name);
      CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(class_name, student_no);
      COMMIT;
    `);
  }

  seedRosterIfEmpty();
}

initSchema();

// Database operations
const dbOperations = {
  // Classes
  getClasses() {
    return db.prepare(`
      SELECT
        c.id,
        c.name,
        c.max_student_no,
        c.created_at,
        COALESCE(s.roster_count, 0) AS roster_count
      FROM classes c
      LEFT JOIN (
        SELECT class_name, COUNT(*) AS roster_count
        FROM students
        GROUP BY class_name
      ) s ON s.class_name = c.name
      ORDER BY c.id ASC
    `).all();
  },
  getClassByName(name) {
    return db.prepare('SELECT id, name, max_student_no, created_at FROM classes WHERE name = ?').get(name);
  },
  addClass(name, maxStudentNo = 45) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('班级名称不能为空');
    const maxNo = parseInt(maxStudentNo, 10) || 45;
    const stmt = db.prepare('INSERT INTO classes (name, max_student_no) VALUES (?, ?)');
    const res = stmt.run(trimmed, maxNo);
    return { id: res.lastInsertRowid, name: trimmed, max_student_no: maxNo };
  },
  deleteClass(id) {
    const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(Number(id));
    if (cls) {
      db.prepare('DELETE FROM students WHERE class_name = ?').run(cls.name);
    }
    return db.prepare('DELETE FROM classes WHERE id = ?').run(Number(id));
  },
  updateClassMaxNo(id, maxNo) {
    return db.prepare('UPDATE classes SET max_student_no = ? WHERE id = ?').run(Number(maxNo), Number(id));
  },

  // Students Roster (Teacher & internal lookup only)
  getStudent(className, studentNo) {
    if (!className || !studentNo) return null;
    return db.prepare(`
      SELECT id, class_name, student_no, student_name, student_code
      FROM students
      WHERE class_name = ? AND student_no = ?
    `).get(String(className).trim(), Number(studentNo));
  },
  getClassStudents(className) {
    return db.prepare(`
      SELECT student_no, student_name, student_code
      FROM students
      WHERE class_name = ?
      ORDER BY student_no ASC
    `).all(String(className || '').trim());
  },
  getClassStudentNos(className) {
    const name = String(className || '').trim();
    if (!name) return [];
    const rows = db.prepare('SELECT student_no FROM students WHERE class_name = ? ORDER BY student_no ASC').all(name);
    if (rows.length > 0) {
      return rows.map((r) => Number(r.student_no));
    }
    const cls = this.getClassByName(name);
    const maxNo = cls ? (Number(cls.max_student_no) || 45) : 0;
    const list = [];
    for (let i = 1; i <= maxNo; i++) list.push(i);
    return list;
  },
  replaceRoster(classes, students) {
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM students');
      db.exec('DELETE FROM classes');

      const insertClass = db.prepare('INSERT INTO classes (name, max_student_no) VALUES (?, ?)');
      for (const cls of classes) {
        insertClass.run(cls.name, Number(cls.max_student_no) || 45);
      }

      const insertStudent = db.prepare(`
        INSERT OR REPLACE INTO students (class_name, student_no, student_name, student_code)
        VALUES (?, ?, ?, ?)
      `);
      for (const st of students) {
        insertStudent.run(st.class_name, Number(st.student_no), st.student_name, st.student_code || '');
      }

      db.exec('COMMIT');
      return { classCount: classes.length, studentCount: students.length };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },

  // Key-Value Settings
  getSetting(key, defaultValue = '') {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row && typeof row.value === 'string' ? row.value : defaultValue;
  },
  setSetting(key, value) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), String(value ?? ''));
  },

  // Broadcast Settings
  getBroadcastState() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'broadcast_state'").get();
    if (!row || !row.value) {
      return { active: false, className: '', updatedAt: '' };
    }
    try {
      const parsed = JSON.parse(row.value);
      return {
        active: Boolean(parsed.active),
        className: String(parsed.className || ''),
        updatedAt: String(parsed.updatedAt || '')
      };
    } catch (e) {
      return { active: false, className: '', updatedAt: '' };
    }
  },
  setBroadcastState({ active, className }) {
    const nowStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const state = {
      active: Boolean(active),
      className: active ? String(className || '').trim() : '',
      updatedAt: nowStr
    };
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('broadcast_state', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(state));
    return state;
  },
  getClassSubmissionSummary(className, includeNames = false) {
    const name = String(className || '').trim();
    const validNos = this.getClassStudentNos(name);
    const subs = db.prepare('SELECT student_no, updated_at FROM submissions WHERE class_name = ?').all(name);
    const submittedSet = new Set(subs.map((s) => Number(s.student_no)));

    const submittedNos = validNos.filter((no) => submittedSet.has(no));
    const missingNos = validNos.filter((no) => !submittedSet.has(no));

    const summary = {
      className: name,
      totalCount: validNos.length,
      submittedCount: submittedNos.length,
      missingCount: missingNos.length,
      allNos: validNos,
      submittedNos,
      missingNos
    };

    if (includeNames) {
      const rosterRows = this.getClassStudents(name);
      const nameMap = new Map(rosterRows.map((r) => [Number(r.student_no), r.student_name]));
      summary.missingDetails = missingNos.map((no) => ({
        student_no: no,
        student_name: nameMap.get(no) || ''
      }));
    }

    return summary;
  },

  // Materials (Teacher uploads)
  getMaterials() {
    return db.prepare('SELECT id, title, original_name, stored_name, file_size, created_at FROM materials ORDER BY id DESC').all();
  },
  getMaterialById(id) {
    return db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(id));
  },
  addMaterial(title, originalName, storedName, filePath, fileSize) {
    const stmt = db.prepare(`
      INSERT INTO materials (title, original_name, stored_name, file_path, file_size)
      VALUES (?, ?, ?, ?, ?)
    `);
    const res = stmt.run(title, originalName, storedName, filePath, Number(fileSize) || 0);
    return { id: res.lastInsertRowid, title, original_name: originalName, file_size: fileSize };
  },
  deleteMaterial(id) {
    const item = this.getMaterialById(id);
    if (item && item.file_path && fs.existsSync(item.file_path)) {
      try {
        fs.unlinkSync(item.file_path);
      } catch (e) {
        console.error('删除原文件失败:', e);
      }
    }
    return db.prepare('DELETE FROM materials WHERE id = ?').run(Number(id));
  },

  // Submissions (Student homework)
  getSubmissions(className = '') {
    const sqlBase = `
      SELECT
        sub.id,
        sub.class_name,
        sub.student_no,
        CASE WHEN TRIM(sub.student_name) <> '' THEN sub.student_name ELSE COALESCE(st.student_name, '') END AS student_name,
        sub.note,
        sub.original_name,
        sub.stored_name,
        sub.file_path,
        sub.file_size,
        sub.ip_address,
        sub.submitted_at,
        sub.updated_at
      FROM submissions sub
      LEFT JOIN students st ON st.class_name = sub.class_name AND st.student_no = sub.student_no
    `;
    if (className) {
      return db.prepare(`${sqlBase} WHERE sub.class_name = ? ORDER BY sub.student_no ASC, sub.id ASC`).all(className);
    }
    return db.prepare(`${sqlBase} ORDER BY sub.class_name ASC, sub.student_no ASC, sub.id ASC`).all();
  },
  getSubmissionById(id) {
    return db.prepare(`
      SELECT
        sub.*,
        CASE WHEN TRIM(sub.student_name) <> '' THEN sub.student_name ELSE COALESCE(st.student_name, '') END AS student_name
      FROM submissions sub
      LEFT JOIN students st ON st.class_name = sub.class_name AND st.student_no = sub.student_no
      WHERE sub.id = ?
    `).get(Number(id));
  },
  getSingleSubmissionStatus(className, studentNo) {
    const cleanClass = String(className || '').trim();
    const numNo = Number(studentNo);
    const rows = db.prepare(`
      SELECT class_name, student_no, original_name, file_size, submitted_at, updated_at
      FROM submissions
      WHERE class_name = ? AND student_no = ?
      ORDER BY id ASC
    `).all(cleanClass, numNo);
    if (!rows || rows.length === 0) {
      return {
        submitted: false,
        className: cleanClass,
        studentNo: numNo,
        fileCount: 0,
        files: []
      };
    }
    const totalSize = rows.reduce((sum, r) => sum + (Number(r.file_size) || 0), 0);
    const latestRow = rows.reduce((latest, r) => {
      const curTime = r.updated_at || r.submitted_at || '';
      const bestTime = latest.updated_at || latest.submitted_at || '';
      return curTime >= bestTime ? r : latest;
    }, rows[0]);
    return {
      submitted: true,
      className: rows[0].class_name,
      studentNo: Number(rows[0].student_no),
      fileCount: rows.length,
      originalName: rows.map(r => r.original_name).join('、'),
      fileSize: totalSize,
      updatedAt: latestRow.updated_at || latestRow.submitted_at,
      files: rows.map(r => ({
        originalName: r.original_name,
        fileSize: Number(r.file_size) || 0,
        updatedAt: r.updated_at || r.submitted_at
      }))
    };
  },
  saveOrUpdateSubmission({ className, studentNo, studentName, note, originalName, storedName, filePath, fileSize, ipAddress }) {
    const existing = db.prepare('SELECT * FROM submissions WHERE class_name = ? AND student_no = ? AND original_name = ?').get(className, studentNo, originalName);
    if (existing) {
      if (existing.file_path && existing.file_path !== filePath && fs.existsSync(existing.file_path)) {
        try {
          fs.unlinkSync(existing.file_path);
        } catch (e) {
          console.error('清理旧作业文件失败:', e);
        }
      }

      const updateStmt = db.prepare(`
        UPDATE submissions
        SET student_name = ?, note = ?, original_name = ?, stored_name = ?, file_path = ?, file_size = ?, ip_address = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `);
      updateStmt.run(studentName || '', note || '', originalName, storedName, filePath, fileSize, ipAddress || '', existing.id);
      return { id: existing.id, isUpdate: true };
    } else {
      const insertStmt = db.prepare(`
        INSERT INTO submissions (class_name, student_no, student_name, note, original_name, stored_name, file_path, file_size, ip_address)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const res = insertStmt.run(className, studentNo, studentName || '', note || '', originalName, storedName, filePath, fileSize, ipAddress || '');
      return { id: res.lastInsertRowid, isUpdate: false };
    }
  },
  deleteSubmission(id) {
    const item = this.getSubmissionById(id);
    if (item && item.file_path && fs.existsSync(item.file_path)) {
      try {
        fs.unlinkSync(item.file_path);
      } catch (e) {
        console.error('删除作业物理文件失败:', e);
      }
    }
    return db.prepare('DELETE FROM submissions WHERE id = ?').run(Number(id));
  }
};

module.exports = {
  db,
  storageDir,
  materialsDir,
  submissionsDir,
  ...dbOperations
};
