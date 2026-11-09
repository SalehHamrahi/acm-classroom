import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
PRAGMA synchronous = NORMAL;
PRAGMA wal_autocheckpoint = 1000;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_sessions_expiry ON login_sessions(expires_at);
CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES teacher_classes(id) ON DELETE RESTRICT,
  jalali_date TEXT,
  start_time TEXT,
  end_time TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_contest INTEGER NOT NULL DEFAULT 0,
  is_assignment INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_class_sessions_owner ON class_sessions(created_by, created_at);
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  input_format TEXT NOT NULL DEFAULT '',
  output_format TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 100,
  attempt_limit INTEGER NOT NULL DEFAULT 0,
  time_limit_ms INTEGER NOT NULL DEFAULT 1500,
  comparison TEXT NOT NULL DEFAULT 'tokens' CHECK(comparison IN ('tokens','exact')),
  published INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_bank_id TEXT REFERENCES question_bank(id) ON DELETE SET NULL,
  bank_opt_out INTEGER NOT NULL DEFAULT 0,
  language_mode TEXT NOT NULL DEFAULT 'python' CHECK(language_mode IN ('python','cpp','both')),
  default_language TEXT NOT NULL DEFAULT 'python' CHECK(default_language IN ('python','cpp')),
  cpp_standard TEXT NOT NULL DEFAULT '17' CHECK(cpp_standard IN ('17','20')),
  cpp_optimization TEXT NOT NULL DEFAULT 'O2' CHECK(cpp_optimization IN ('O0','O1','O2','O3'))
);
CREATE INDEX IF NOT EXISTS idx_problems_session ON problems(session_id, position);
CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  input_text TEXT NOT NULL DEFAULT '',
  expected_output TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_test_cases_problem ON test_cases(problem_id, position);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id),
  source_code TEXT NOT NULL,
  verdict TEXT NOT NULL,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  total_cases INTEGER NOT NULL DEFAULT 0,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  runtime_ms INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '[]',
  source_deleted_at TEXT,
  created_at TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'python' CHECK(language IN ('python','cpp')),
  cpp_standard TEXT NOT NULL DEFAULT '17',
  cpp_optimization TEXT NOT NULL DEFAULT 'O2',
  similarity_fingerprint TEXT NOT NULL DEFAULT '',
  ai_flagged INTEGER NOT NULL DEFAULT 0,
  ai_flagged_at TEXT,
  ai_flagged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  ai_flag_note TEXT NOT NULL DEFAULT '',
  ai_flag_original_points INTEGER
);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id, created_at DESC);
CREATE TABLE IF NOT EXISTS teacher_classes (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teacher_classes_teacher ON teacher_classes(teacher_id, created_at DESC);
CREATE TABLE IF NOT EXISTS class_memberships (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES teacher_classes(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  UNIQUE(class_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_class_memberships_class ON class_memberships(class_id, joined_at);
CREATE TABLE IF NOT EXISTS class_schedule_events (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES teacher_classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  jalali_date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '09:00',
  end_time TEXT NOT NULL DEFAULT '10:00',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_class_schedule_date ON class_schedule_events(class_id, jalali_date, start_time);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_security_events_created ON admin_security_events(created_at DESC);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'info',
  target_path TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS bale_links (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL UNIQUE,
  chat_label TEXT NOT NULL DEFAULT '',
  chat_username TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  linked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bale_links_chat ON bale_links(chat_id);
CREATE TABLE IF NOT EXISTS bale_link_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bale_link_codes_user ON bale_link_codes(user_id, expires_at);
CREATE TABLE IF NOT EXISTS bale_notification_outbox (
  notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bale_outbox_pending ON bale_notification_outbox(status, next_attempt_at, created_at);
CREATE TABLE IF NOT EXISTS bale_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bale_processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS code_drafts (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  source_code TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'python' CHECK(language IN ('python','cpp')),
  cpp_standard TEXT NOT NULL DEFAULT '17',
  cpp_optimization TEXT NOT NULL DEFAULT 'O2',
  UNIQUE(student_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_code_drafts_student_updated ON code_drafts(student_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS contests (
  id TEXT PRIMARY KEY,
  class_id TEXT REFERENCES teacher_classes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  penalty_minutes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  freeze_minutes INTEGER NOT NULL DEFAULT 0,
  scoreboard_frozen INTEGER NOT NULL DEFAULT 0,
  scoreboard_frozen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contests_class_start ON contests(class_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_contests_owner_start ON contests(created_by, start_at DESC);
CREATE TABLE IF NOT EXISTS contest_participants (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  invited_at TEXT NOT NULL,
  PRIMARY KEY(contest_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_contest_participants_student ON contest_participants(student_id, contest_id);
CREATE TABLE IF NOT EXISTS contest_problems (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(contest_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_contest_problems_problem ON contest_problems(problem_id, contest_id);
CREATE TABLE IF NOT EXISTS contest_submissions (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  PRIMARY KEY(contest_id, submission_id)
);
CREATE INDEX IF NOT EXISTS idx_contest_submissions_contest ON contest_submissions(contest_id, submission_id);
CREATE TABLE IF NOT EXISTS question_bank (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  input_format TEXT NOT NULL DEFAULT '',
  output_format TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 100,
  attempt_limit INTEGER NOT NULL DEFAULT 0,
  time_limit_ms INTEGER NOT NULL DEFAULT 1500,
  comparison TEXT NOT NULL DEFAULT 'tokens' CHECK(comparison IN ('tokens','exact')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin_problem_id TEXT UNIQUE REFERENCES problems(id) ON DELETE SET NULL,
  language_mode TEXT NOT NULL DEFAULT 'python' CHECK(language_mode IN ('python','cpp','both')),
  default_language TEXT NOT NULL DEFAULT 'python' CHECK(default_language IN ('python','cpp')),
  cpp_standard TEXT NOT NULL DEFAULT '17' CHECK(cpp_standard IN ('17','20')),
  cpp_optimization TEXT NOT NULL DEFAULT 'O2' CHECK(cpp_optimization IN ('O0','O1','O2','O3'))
);
CREATE INDEX IF NOT EXISTS idx_question_bank_teacher_updated ON question_bank(teacher_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS question_bank_tests (
  id TEXT PRIMARY KEY,
  bank_question_id TEXT NOT NULL REFERENCES question_bank(id) ON DELETE CASCADE,
  input_text TEXT NOT NULL DEFAULT '',
  expected_output TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_question_bank_tests_question ON question_bank_tests(bank_question_id, position);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES class_sessions(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  allow_late INTEGER NOT NULL DEFAULT 0,
  late_penalty_percent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_teacher_due ON assignments(teacher_id, due_at DESC);
CREATE TABLE IF NOT EXISTS assignment_participants (
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_class_id TEXT REFERENCES teacher_classes(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY(assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_participants_student ON assignment_participants(student_id, assignment_id);
CREATE TABLE IF NOT EXISTS assignment_problems (
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(assignment_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_problems_problem ON assignment_problems(problem_id, assignment_id);
CREATE TABLE IF NOT EXISTS assignment_submissions (
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  is_late INTEGER NOT NULL DEFAULT 0,
  raw_points INTEGER NOT NULL DEFAULT 0,
  penalty_percent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(assignment_id, submission_id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_assignment ON assignment_submissions(assignment_id, submission_id);

`;

export function createId() {
  return crypto.randomUUID();
}
export function nowIso() {
  return new Date().toISOString();
}
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [scheme, salt, key] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/i.test(key || '')) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function migrateLegacyContestClassRequirement(db) {
  const columns = db.prepare('PRAGMA table_info(contests)').all();
  const classColumn = columns.find((column) => column.name === 'class_id');
  if (!classColumn?.notnull) return false;

  // SQLite table rebuilds must be atomic. A crash between DROP and RENAME in
  // an autocommit migration could otherwise leave the database without contests.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE contests_new (
        id TEXT PRIMARY KEY,
        class_id TEXT REFERENCES teacher_classes(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        penalty_minutes INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        freeze_minutes INTEGER NOT NULL DEFAULT 0,
        scoreboard_frozen INTEGER NOT NULL DEFAULT 0,
        scoreboard_frozen_at TEXT
      );
      INSERT INTO contests_new(id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at)
        SELECT id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at FROM contests;
      DROP TABLE contests;
      ALTER TABLE contests_new RENAME TO contests;`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original migration error */ }
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const brokenReferences = db.prepare('PRAGMA foreign_key_check').all();
  if (brokenReferences.length) throw new Error(`Database migration created ${brokenReferences.length} invalid foreign-key reference(s).`);
  return true;
}

export function openSqliteTestDatabase(options = {}) {
  const dbPath = options.dbPath ?? ':memory:';
  const absolute = dbPath === ':memory:' ? ':memory:' : path.resolve(dbPath);
  if (absolute !== ':memory:') fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const db = new DatabaseSync(absolute);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 1000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -12000;');
  if (absolute !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Small forward-only migrations for databases created by earlier app versions.
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  if (!columns('users').has('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen TEXT');
  if (!columns('submissions').has('source_deleted_at')) db.exec('ALTER TABLE submissions ADD COLUMN source_deleted_at TEXT');
  if (!columns('problems').has('attempt_limit')) db.exec('ALTER TABLE problems ADD COLUMN attempt_limit INTEGER NOT NULL DEFAULT 0');
  if (!columns('class_sessions').has('class_id')) db.exec('ALTER TABLE class_sessions ADD COLUMN class_id TEXT REFERENCES teacher_classes(id) ON DELETE RESTRICT');
  if (!columns('class_sessions').has('jalali_date')) db.exec('ALTER TABLE class_sessions ADD COLUMN jalali_date TEXT');
  if (!columns('class_sessions').has('start_time')) db.exec('ALTER TABLE class_sessions ADD COLUMN start_time TEXT');
  if (!columns('class_sessions').has('end_time')) db.exec('ALTER TABLE class_sessions ADD COLUMN end_time TEXT');
  if (!columns('class_sessions').has('is_contest')) db.exec('ALTER TABLE class_sessions ADD COLUMN is_contest INTEGER NOT NULL DEFAULT 0');
  if (!columns('class_sessions').has('is_assignment')) db.exec('ALTER TABLE class_sessions ADD COLUMN is_assignment INTEGER NOT NULL DEFAULT 0');
  if (!columns('problems').has('source_bank_id')) db.exec('ALTER TABLE problems ADD COLUMN source_bank_id TEXT REFERENCES question_bank(id) ON DELETE SET NULL');
  if (!columns('problems').has('bank_opt_out')) db.exec('ALTER TABLE problems ADD COLUMN bank_opt_out INTEGER NOT NULL DEFAULT 0');
  for (const [name, definition] of Object.entries({
    language_mode: "TEXT NOT NULL DEFAULT 'python'", default_language: "TEXT NOT NULL DEFAULT 'python'",
    cpp_standard: "TEXT NOT NULL DEFAULT '17'", cpp_optimization: "TEXT NOT NULL DEFAULT 'O2'",
  })) if (!columns('problems').has(name)) db.exec(`ALTER TABLE problems ADD COLUMN ${name} ${definition}`);
  for (const [name, definition] of Object.entries({
    language: "TEXT NOT NULL DEFAULT 'python'", cpp_standard: "TEXT NOT NULL DEFAULT '17'", cpp_optimization: "TEXT NOT NULL DEFAULT 'O2'", similarity_fingerprint: "TEXT NOT NULL DEFAULT ''",
    ai_flagged: 'INTEGER NOT NULL DEFAULT 0', ai_flagged_at: 'TEXT', ai_flagged_by: 'TEXT REFERENCES users(id) ON DELETE SET NULL',
    ai_flag_note: "TEXT NOT NULL DEFAULT ''", ai_flag_original_points: 'INTEGER',
  })) if (!columns('submissions').has(name)) db.exec(`ALTER TABLE submissions ADD COLUMN ${name} ${definition}`);
  if (!columns('code_drafts').has('language')) db.exec("ALTER TABLE code_drafts ADD COLUMN language TEXT NOT NULL DEFAULT 'python'");
  if (!columns('code_drafts').has('cpp_standard')) db.exec("ALTER TABLE code_drafts ADD COLUMN cpp_standard TEXT NOT NULL DEFAULT '17'");
  if (!columns('code_drafts').has('cpp_optimization')) db.exec("ALTER TABLE code_drafts ADD COLUMN cpp_optimization TEXT NOT NULL DEFAULT 'O2'");
  for (const [name, definition] of Object.entries({
    language_mode: "TEXT NOT NULL DEFAULT 'python'", default_language: "TEXT NOT NULL DEFAULT 'python'",
    cpp_standard: "TEXT NOT NULL DEFAULT '17'", cpp_optimization: "TEXT NOT NULL DEFAULT 'O2'",
  })) if (!columns('question_bank').has(name)) db.exec(`ALTER TABLE question_bank ADD COLUMN ${name} ${definition}`);
  for (const [name, definition] of Object.entries({
    freeze_minutes: "INTEGER NOT NULL DEFAULT 0", scoreboard_frozen: "INTEGER NOT NULL DEFAULT 0", scoreboard_frozen_at: "TEXT",
  })) if (!columns('contests').has(name)) db.exec(`ALTER TABLE contests ADD COLUMN ${name} ${definition}`);

  if (!columns('question_bank').has('origin_problem_id')) db.exec('ALTER TABLE question_bank ADD COLUMN origin_problem_id TEXT REFERENCES problems(id) ON DELETE SET NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_question_bank_origin_problem ON question_bank(origin_problem_id) WHERE origin_problem_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_question_bank_global_updated ON question_bank(updated_at DESC, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_source_expiry ON submissions(created_at, source_deleted_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_student_problem_created ON submissions(student_id, problem_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_created_id ON submissions(created_at DESC, id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_problems_session_published ON problems(session_id, published, position)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memberships_student ON class_memberships(student_id, class_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_class_sessions_class ON class_sessions(class_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_student_problem_ai_created ON submissions(student_id, problem_id, ai_flagged, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_student_ai_verdict_problem ON submissions(student_id, ai_flagged, verdict, problem_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created_id ON audit_log(created_at DESC, id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role_active_seen ON users(role, active, last_seen DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bale_processed_updates_processed ON bale_processed_updates(processed_at)');
  // Upgrade the old class-required contest relation to an optional legacy label.
  // Existing class contests are retained; new contests are fully independent of classes.
  migrateLegacyContestClassRequirement(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_contests_class_start ON contests(class_id, start_at, end_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contests_owner_start ON contests(created_by, start_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contest_participants_student ON contest_participants(student_id, contest_id)');
  // Contest overlap checks are performed inside BEGIN IMMEDIATE transactions
  // in the application layer. Avoid schema triggers here: they can block safe
  // upgrades when an older contests table is temporarily rebuilt.
  db.exec('DROP TRIGGER IF EXISTS trg_contest_problem_no_overlap_insert');
  db.exec('DROP TRIGGER IF EXISTS trg_contest_time_no_overlap_update');
  // Existing class contests keep the class roster they originally targeted.
  db.exec(`INSERT OR IGNORE INTO contest_participants(contest_id,student_id,invited_by,invited_at)
    SELECT c.id,m.student_id,c.created_by,c.created_at FROM contests c
    JOIN class_memberships m ON m.class_id=c.class_id WHERE c.class_id IS NOT NULL`);
  // Migrate sessions created before classes existed. Preserve old work by assigning it to an existing class
  // where unambiguous, otherwise create a clearly named migration class for that teacher.
  const unassignedOwners = db.prepare('SELECT DISTINCT created_by FROM class_sessions WHERE class_id IS NULL AND is_contest = 0').all();
  for (const owner of unassignedOwners) {
    const oldSessions = db.prepare('SELECT id FROM class_sessions WHERE created_by = ? AND class_id IS NULL AND is_contest = 0').all(owner.created_by);
    if (!oldSessions.length) continue;
    const classes = db.prepare('SELECT id FROM teacher_classes WHERE teacher_id = ? ORDER BY created_at').all(owner.created_by);
    let classId = classes.length === 1 ? classes[0].id : null;
    if (!classId) {
      classId = crypto.randomUUID();
      const stamp = new Date().toISOString();
      const title = classes.length ? 'جلسه‌های منتقل‌شده' : 'کلاس جلسه‌های قبلی';
      db.prepare('INSERT INTO teacher_classes(id, teacher_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(classId, owner.created_by, title, 'این کلاس هنگام ارتقای سامانه برای حفظ جلسه‌های قبلی ساخته شده است.', stamp, stamp);
    }
    db.prepare('UPDATE class_sessions SET class_id = ? WHERE created_by = ? AND class_id IS NULL AND is_contest = 0').run(classId, owner.created_by);
  }
  // Promote all legacy session-created questions into the shared bank. Exact duplicates
  // already authored by the same teacher are linked instead of duplicated.
  const unbankedProblems = db.prepare(`SELECT p.*, s.created_by AS teacher_id FROM problems p
    JOIN class_sessions s ON s.id = p.session_id WHERE p.source_bank_id IS NULL AND p.bank_opt_out = 0 ORDER BY p.created_at, p.id`).all();
  for (const problem of unbankedProblems) {
    const tests = db.prepare('SELECT input_text AS input, expected_output AS output, hidden FROM test_cases WHERE problem_id = ? ORDER BY position').all(problem.id);
    const candidates = db.prepare(`SELECT * FROM question_bank WHERE teacher_id = ? AND title = ? AND statement = ? AND input_format = ? AND output_format = ?
      AND points = ? AND attempt_limit = ? AND time_limit_ms = ? AND comparison = ?`).all(problem.teacher_id, problem.title, problem.statement, problem.input_format, problem.output_format, problem.points, problem.attempt_limit, problem.time_limit_ms, problem.comparison);
    let matched = null;
    for (const candidate of candidates) {
      const savedTests = db.prepare('SELECT input_text AS input, expected_output AS output, hidden FROM question_bank_tests WHERE bank_question_id = ? ORDER BY position').all(candidate.id);
      if (savedTests.length === tests.length && savedTests.every((item, index) => item.input === tests[index].input && item.output === tests[index].output && Boolean(item.hidden) === Boolean(tests[index].hidden))) { matched = candidate; break; }
    }
    if (matched) {
      db.prepare('UPDATE problems SET source_bank_id = ? WHERE id = ?').run(matched.id, problem.id);
      continue;
    }
    const bankId = crypto.randomUUID(); const stamp = problem.updated_at || problem.created_at || new Date().toISOString();
    db.prepare(`INSERT INTO question_bank(id, teacher_id, title, statement, input_format, output_format, points, attempt_limit, time_limit_ms, comparison, created_at, updated_at, origin_problem_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(bankId, problem.teacher_id, problem.title, problem.statement, problem.input_format, problem.output_format, problem.points, problem.attempt_limit, problem.time_limit_ms, problem.comparison, problem.created_at || stamp, stamp, problem.id);
    const addTest = db.prepare('INSERT INTO question_bank_tests(id, bank_question_id, input_text, expected_output, hidden, position) VALUES (?, ?, ?, ?, ?, ?)');
    tests.forEach((item, index) => addTest.run(crypto.randomUUID(), bankId, item.input, item.output, item.hidden ? 1 : 0, index));
    db.prepare('UPDATE problems SET source_bank_id = ? WHERE id = ?').run(bankId, problem.id);
  }
  db.transaction = (fn) => async (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = await fn(...args); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  db.exec('PRAGMA optimize;');
  db.kind = 'sqlite-test';
  db.filePath = absolute;
  return db;
}
export function logAudit(db, actorId, action, targetType, targetId = '', details = '') {
  db.prepare('INSERT INTO audit_log(actor_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(actorId || null, action, targetType, String(targetId || ''), String(details || '').slice(0, 1000), nowIso());
}
export function createUser(db, { username, displayName, role, password, mustChangePassword = false }) {
  const id = createId();
  db.prepare(`INSERT INTO users(id, username, display_name, role, password_hash, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, username.trim().toLowerCase(), displayName.trim(), role, hashPassword(password), mustChangePassword ? 1 : 0, nowIso());
  return id;
}
