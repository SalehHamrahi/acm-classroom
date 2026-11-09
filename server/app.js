import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHttpApp, staticFiles } from './http-app.js';
import { createId, nowIso, hashPassword, verifyPassword, logAudit } from './db.js';
import { isUniqueConstraint } from './db-errors.js';
import { runSubmission as defaultRunSubmission } from './judge.js';
import { BoundedWorkerPool } from './worker-pool.js';
import { buildSimilarityFingerprint, findSimilarPairs } from './code-similarity.js';
import { createDatabaseBackup, listDatabaseBackups, resolveDatabaseBackupFile } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_USER_FIELDS = 'id, username, display_name AS displayName, role, active, must_change_password AS mustChangePassword, created_at AS createdAt';
const roles = new Set(['admin', 'teacher', 'student']);
const DUMMY_PASSWORD_HASH = hashPassword('acm-classroom-invalid-login-timing-padding');

const SOURCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function purgeExpiredSubmissionSources(db, now = Date.now()) {
  const cutoff = new Date(now - SOURCE_RETENTION_MS).toISOString();
  return (await db.prepare(`UPDATE submissions SET source_code = '', source_deleted_at = COALESCE(source_deleted_at, ?)
    WHERE source_deleted_at IS NULL AND created_at <= ?`).run(new Date(now).toISOString(), cutoff)).changes;
}
async function purgeExpiredOperationalRows(db, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const processedCutoff = new Date(now - 30 * 86400000).toISOString();
  const expiredSessions = (await db.prepare('DELETE FROM login_sessions WHERE expires_at <= ?').run(now)).changes;
  const expiredLinkCodes = (await db.prepare('DELETE FROM bale_link_codes WHERE expires_at <= ?').run(stamp)).changes;
  const oldProcessedUpdates = (await db.prepare('DELETE FROM bale_processed_updates WHERE processed_at < ?').run(processedCutoff)).changes;
  return { expiredSessions, expiredLinkCodes, oldProcessedUpdates };
}
async function classAccess(db, user, classId) {
  const row = await db.prepare('SELECT * FROM teacher_classes WHERE id = ?').get(classId);
  if (!row) return { row: null, allowed: false };
  return { row, allowed: user.role === 'admin' || row.teacher_id === user.id };
}
function validJalaliDate(value) {
  if (typeof value !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('/').map(Number);
  if (year < 1300 || year > 1600 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Validate real dates (including leap Esfand) against the Persian calendar shipped by Intl.
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  const start = Date.UTC(year + 621, 2, 1, 12);
  const end = Date.UTC(year + 622, 3, 1, 12);
  for (let time = start; time < end; time += 86400000) {
    const parts = formatter.formatToParts(new Date(time));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const jy = get('year'); const jm = get('month'); const jd = get('day');
    if (jy === year && jm === month && jd === day) return true;
  }
  return false;
}
function validTime(value) { return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }

const TEHRAN_JALALI_FORMATTER = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric',
});
const TEHRAN_CLOCK_FORMATTER = new Intl.DateTimeFormat('en-US-u-nu-latn', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const scheduledStartCache = new Map();
function jalaliDateTimeToTehranEpoch(jalaliDate, time) {
  if (!validJalaliDate(jalaliDate) || !validTime(time)) return null;
  const cacheKey = `${jalaliDate} ${time}`;
  if (scheduledStartCache.has(cacheKey)) return scheduledStartCache.get(cacheKey);
  const [targetYear, targetMonth, targetDay] = jalaliDate.split('/').map(Number);
  const [targetHour, targetMinute] = time.split(':').map(Number);
  const dateStart = Date.UTC(targetYear + 621, 0, 1, 12);
  const dateEnd = Date.UTC(targetYear + 623, 0, 1, 12);
  let gregorian = null;
  for (let stamp = dateStart; stamp < dateEnd; stamp += 86400000) {
    const parts = TEHRAN_JALALI_FORMATTER.formatToParts(new Date(stamp));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value);
    if (value('year') === targetYear && value('month') === targetMonth && value('day') === targetDay) {
      const d = new Date(stamp);
      gregorian = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
      break;
    }
  }
  if (!gregorian) return null;
  const desiredAsUtc = Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day, targetHour, targetMinute, 0);
  let guess = desiredAsUtc;
  // Convert Tehran wall-clock time to UTC using the runtime's IANA timezone database.
  for (let i = 0; i < 4; i += 1) {
    const parts = TEHRAN_CLOCK_FORMATTER.formatToParts(new Date(guess));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value);
    const representedAsUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    const delta = desiredAsUtc - representedAsUtc;
    guess += delta;
    if (delta === 0) break;
  }
  if (scheduledStartCache.size > 512) scheduledStartCache.clear();
  scheduledStartCache.set(cacheKey, guess);
  return guess;
}
const SESSION_END_GRACE_MS = 60 * 60 * 1000;
function sessionEndEpoch(session) {
  const date = session.jalali_date || session.jalaliDate;
  const end = session.end_time || session.endTime;
  return date && end ? jalaliDateTimeToTehranEpoch(date, end) : null;
}
function isSessionCalendarVisible(session, now = Date.now()) {
  const endsAt = sessionEndEpoch(session);
  // Sessions with no complete end schedule remain visible for legacy compatibility.
  return endsAt === null || now < endsAt + SESSION_END_GRACE_MS;
}
function isStudentSessionAvailable(session, now = Date.now()) {
  if (!Boolean(session.active)) return false;
  const date = session.jalali_date || session.jalaliDate;
  // A session without a complete schedule is never student-accessible.
  if (!date) return false;
  const start = session.start_time || session.startTime;
  const startsAt = jalaliDateTimeToTehranEpoch(date, start);
  return startsAt !== null && now >= startsAt && isSessionCalendarVisible(session, now);
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    // PostgreSQL folds unquoted camelCase aliases to lowercase. Support all
    // driver shapes so a legacy/uncased row can never crash the dashboard.
    displayName: String(row.displayName || row.displayname || row.display_name || row.username || 'کاربر'),
    role: row.role,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.mustChangePassword ?? row.mustchangepassword ?? row.must_change_password),
    createdAt: row.createdAt ?? row.createdat ?? row.created_at,
  };
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function validUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(value.trim());
}
function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 200;
}
function cleanString(value, max = 10000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}
async function studentTotalPoints(db, studentId) {
  // One aggregate query avoids materializing every problem's score in Node.
  // Points remain attached to the student across class transfers; AI-flagged
  // submissions are excluded and every problem is capped at its configured max.
  const row = await db.prepare(`SELECT COALESCE(SUM(problem_points), 0) AS total_points FROM (
      SELECT CASE WHEN MAX(a.points_awarded) < 0 THEN 0
        WHEN MAX(a.points_awarded) > p.points THEN p.points ELSE MAX(a.points_awarded) END AS problem_points
      FROM submissions a JOIN problems p ON p.id = a.problem_id
      WHERE a.student_id = ? AND a.ai_flagged = 0
      GROUP BY p.id, p.points
    )`).get(studentId);
  return Number(row?.total_points || 0);
}
async function studentProblemStats(db, studentId, problemId, contestId = null) {
  const row = await db.prepare(`SELECT COUNT(*) AS attempt_count, MAX(CASE WHEN verdict = 'accepted' THEN 1 ELSE 0 END) AS accepted,
    COALESCE(MAX(points_awarded), 0) AS best_points FROM submissions a WHERE student_id = ? AND problem_id = ?
    AND a.ai_flagged = 0
    AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM contest_submissions cs WHERE cs.submission_id = a.id AND cs.contest_id = ?))`).get(studentId, problemId, contestId, contestId);
  return { attemptCount: Number(row?.attempt_count || 0), accepted: Boolean(row?.accepted), bestPoints: Number(row?.best_points || 0) };
}

function normalizeTests(tests) {
  if (!Array.isArray(tests) || tests.length < 1 || tests.length > 20) return { error: 'برای هر سؤال بین 1 تا 20 تست تعریف کن.' };
  const normalized = [];
  for (const [index, test] of tests.entries()) {
    if (!test || typeof test !== 'object') return { error: `ساختار تست شمارهٔ ${index + 1} درست نیست.` };
    const input = typeof test.input === 'string' ? test.input : '';
    const output = typeof test.output === 'string' ? test.output : '';
    if (input.length > 10000 || output.length > 10000) return { error: 'ورودی یا خروجی هر تست باید کمتر از 10 هزار نویسه باشد.' };
    normalized.push({ input, output, hidden: Boolean(test.hidden), position: index });
  }
  if (!normalized.some((item) => !item.hidden)) return { error: 'حداقل یک تست نمونهٔ عمومی لازم است.' };
  return { tests: normalized };
}
async function publicProblem(db, row, { includeSamples = true } = {}) {
  const result = {
    id: row.id,
    sessionId: row.session_id,
    sourceBankId: row.source_bank_id || null,
    title: row.title,
    statement: row.statement,
    inputFormat: row.input_format,
    outputFormat: row.output_format,
    points: row.points,
    attemptLimit: Number(row.attempt_limit ?? 0),
    timeLimitMs: row.time_limit_ms,
    comparison: row.comparison,
    published: Boolean(row.published),
    position: row.position,
    languageMode: row.language_mode || 'python',
    defaultLanguage: row.default_language || 'python',
    cppStandard: row.cpp_standard || '17',
    cppOptimization: row.cpp_optimization || 'O2',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeSamples) {
    result.samples = await db.prepare('SELECT input_text AS input, expected_output AS output FROM test_cases WHERE problem_id = ? AND hidden = 0 ORDER BY position').all(row.id);
  }
  return result;
}
async function getSessionAccess(db, user, sessionId, now = Date.now()) {
  const row = await db.prepare(`SELECT s.*, c.title AS class_title, c.teacher_id AS class_teacher_id
    FROM class_sessions s LEFT JOIN teacher_classes c ON c.id = s.class_id WHERE s.id = ?`).get(sessionId);
  if (!row) return { row: null, allowed: false };
  if (user.role === 'admin') return { row, allowed: true };
  if (user.role === 'teacher') return { row, allowed: row.created_by === user.id && row.class_teacher_id === user.id };
  const membership = row.class_id ? await db.prepare('SELECT 1 FROM class_memberships WHERE class_id = ? AND student_id = ?').get(row.class_id, user.id) : null;
  return { row, allowed: Boolean(membership && isStudentSessionAvailable(row, now)) };
}
async function getProblemAccess(db, user, problemId, now = Date.now(), contestId = null, assignmentId = null) {
  const problem = await db.prepare(`SELECT p.*, s.created_by, s.active AS session_active, s.class_id, s.jalali_date AS session_jalali_date,
    s.start_time AS session_start_time, s.end_time AS session_end_time, c.title AS class_title,
    c.teacher_id AS class_teacher_id FROM problems p JOIN class_sessions s ON s.id = p.session_id
    LEFT JOIN teacher_classes c ON c.id = s.class_id WHERE p.id = ?`).get(problemId);
  if (!problem) return { row: null, allowed: false };
  if (user.role === 'admin') return { row: problem, allowed: true };
  if (user.role === 'teacher') return { row: problem, allowed: problem.created_by === user.id && problem.class_teacher_id === user.id };
  if (contestId) {
    const contest = await db.prepare('SELECT * FROM contests WHERE id = ?').get(contestId);
    const attached = contest ? await db.prepare('SELECT 1 FROM contest_problems WHERE contest_id = ? AND problem_id = ?').get(contestId, problemId) : null;
    const invited = contest ? await db.prepare('SELECT 1 FROM contest_participants WHERE contest_id = ? AND student_id = ?').get(contestId, user.id) : null;
    const inWindow = contest && Date.parse(contest.start_at) <= now && now < Date.parse(contest.end_at);
    return { row: problem, contest, allowed: Boolean(problem.published && invited && attached && inWindow) };
  }
  if (assignmentId) {
    const assignment = await db.prepare("SELECT * FROM assignments WHERE id=? AND status='published'").get(assignmentId);
    const participant = assignment ? await db.prepare('SELECT 1 FROM assignment_participants WHERE assignment_id=? AND student_id=?').get(assignmentId, user.id) : null;
    const attached = assignment ? await db.prepare('SELECT 1 FROM assignment_problems WHERE assignment_id=? AND problem_id=?').get(assignmentId, problemId) : null;
    const beforeDue = assignment && now < Date.parse(assignment.due_at);
    const withinWindow = assignment && now >= Date.parse(assignment.start_at) && (beforeDue || Boolean(assignment.allow_late));
    return { row: problem, assignment, allowed: Boolean(problem.published && participant && attached && withinWindow) };
  }
  const membership = problem.class_id ? await db.prepare('SELECT 1 FROM class_memberships WHERE class_id = ? AND student_id = ?').get(problem.class_id, user.id) : null;
  const sessionAvailable = Boolean(problem.published && membership && isStudentSessionAvailable({ active: problem.session_active, jalali_date: problem.session_jalali_date, start_time: problem.session_start_time, end_time: problem.session_end_time }, now));
  const reserved = await db.prepare(`SELECT 1 FROM contest_problems cp JOIN contests c ON c.id = cp.contest_id WHERE cp.problem_id = ? AND c.end_at > ? LIMIT 1`).get(problemId, new Date(now).toISOString());
  return { row: problem, allowed: Boolean(sessionAvailable && !reserved) };
}

function paginationFromRequest(req, defaultLimit = 50, maximum = 100) {
  const limit = Math.max(1, Math.min(maximum, Number.parseInt(req.query?.limit, 10) || defaultLimit));
  const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
  return { limit, offset };
}
async function createNotifications(db, userIds, { title, message = '', type = 'info', targetPath = '' }) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return 0;
  const insert = db.prepare('INSERT INTO notifications(id, user_id, title, message, type, target_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const enqueueBale = db.prepare(`INSERT INTO bale_notification_outbox(notification_id, user_id, status, attempts, next_attempt_at, created_at)
    SELECT ?, ?, 'pending', 0, ?, ? WHERE EXISTS (SELECT 1 FROM bale_links WHERE user_id=? AND enabled=1)
    ON CONFLICT (notification_id) DO NOTHING`);
  const stamp = nowIso();
  const tx = db.transaction(async () => {
    for (const userId of unique) {
      const notificationId = createId();
      await insert.run(notificationId, userId, title.slice(0, 120), message.slice(0, 500), type, targetPath.slice(0, 240), stamp);
      await enqueueBale.run(notificationId, userId, stamp, stamp, userId);
    }
  });
  await tx();
  return unique.length;
}
function contestStatus(contest, now = Date.now()) {
  const start = Date.parse(contest.start_at); const end = Date.parse(contest.end_at);
  return now < start ? 'scheduled' : now < end ? 'active' : 'ended';
}
async function contestLeaderboard(db, contestId, cutoffIso = null) {
  // The contest setting is explicitly a penalty per wrong submission, not an
  // elapsed-time score. Charging contest_start -> accepted_at here caused
  // huge unexplained values (e.g. 1,245 elapsed minutes + a 20-minute fee).
  // AI-flagged submissions are excluded from problem_attempts below, so they
  // neither count as wrong attempts nor create any additional time penalty.
  // Restoring an AI decision naturally puts that submission back into the
  // valid-attempt set and restores its ordinary verdict-based treatment.
  return (await db.prepare(`WITH problem_attempts AS (
      SELECT cs.contest_id, a.student_id, p.id AS problem_id,
        MAX(a.points_awarded) AS best_points,
        MAX(CASE WHEN a.verdict = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN a.verdict <> 'accepted' THEN 1 ELSE 0 END) AS wrong_attempts,
        c.penalty_minutes AS wrong_penalty_minutes
      FROM contest_submissions cs JOIN submissions a ON a.id = cs.submission_id
      JOIN problems p ON p.id = a.problem_id JOIN contests c ON c.id = cs.contest_id
      WHERE cs.contest_id = ? AND a.ai_flagged = 0 AND (CAST(? AS TEXT) IS NULL OR a.created_at <= ?)
      GROUP BY cs.contest_id, a.student_id, p.id, c.penalty_minutes
    ), problem_scores AS (
      SELECT pa.contest_id, pa.student_id, pa.problem_id,
        pa.best_points, pa.accepted, pa.wrong_attempts,
        (pa.wrong_attempts * pa.wrong_penalty_minutes) AS penalty_minutes
      FROM problem_attempts pa
    ), participant_scores AS (
      SELECT contest_id, student_id,
        SUM(best_points) AS best_points,
        SUM(accepted) AS accepted,
        SUM(wrong_attempts) AS wrong_attempts,
        SUM(penalty_minutes) AS penalty_minutes
      FROM problem_scores
      GROUP BY contest_id, student_id
    )
    SELECT u.id AS student_id, u.username, u.display_name AS display_name,
      COALESCE(SUM(best.best_points), 0) AS points,
      COALESCE(SUM(best.accepted), 0) AS solved,
      COALESCE(SUM(best.wrong_attempts), 0) AS wrong_attempts,
      COALESCE(SUM(best.penalty_minutes), 0) AS penalty_minutes
    FROM contest_participants cp JOIN users u ON u.id = cp.student_id
    LEFT JOIN participant_scores best ON best.contest_id = cp.contest_id AND best.student_id = u.id
    WHERE cp.contest_id = ?
    GROUP BY u.id, u.username, u.display_name ORDER BY points DESC, solved DESC, penalty_minutes ASC, u.display_name`).all(contestId, cutoffIso, cutoffIso, contestId))
    .map((row, index) => ({ rank: index + 1, studentId: row.student_id, username: row.username, displayName: row.display_name, points: Number(row.points || 0), solved: Number(row.solved || 0), wrongAttempts: Number(row.wrong_attempts || 0), penaltyMinutes: Number(row.penalty_minutes || 0) }));
}

async function classLeaderboard(db, classId) {
  // Calculate all class members' points in one grouped query instead of the
  // previous N+1 pattern (one additional submissions query per student).
  const rows = await db.prepare(`WITH class_students AS (
      SELECT u.id, u.username, u.display_name
      FROM class_memberships m JOIN users u ON u.id = m.student_id
      WHERE m.class_id = ? AND u.role = 'student'
    ), per_problem AS (
      SELECT a.student_id,
        CASE WHEN MAX(a.points_awarded) < 0 THEN 0
          WHEN MAX(a.points_awarded) > p.points THEN p.points ELSE MAX(a.points_awarded) END AS problem_points
      FROM submissions a JOIN problems p ON p.id = a.problem_id
      JOIN class_students cs ON cs.id = a.student_id
      WHERE a.ai_flagged = 0
      GROUP BY a.student_id, p.id, p.points
    ), student_scores AS (
      SELECT student_id, SUM(problem_points) AS points FROM per_problem GROUP BY student_id
    )
    SELECT cs.id, cs.username, cs.display_name,
      COALESCE(ss.points, 0) AS points
    FROM class_students cs LEFT JOIN student_scores ss ON ss.student_id = cs.id`).all(classId);
  return rows.sort((a, b) => Number(b.points) - Number(a.points)
      || a.display_name.localeCompare(b.display_name, 'fa') || a.id.localeCompare(b.id))
    .map((row, index) => ({ rank: index + 1, studentId: row.id, username: row.username, displayName: row.display_name, points: Number(row.points || 0) }));
}
async function adminStudentLeaderboard(db) {
  // Same one-pass aggregate for the global leaderboard; empty-score students
  // remain visible because the student list is the left-hand side.
  const rows = await db.prepare(`WITH per_problem AS (
      SELECT a.student_id,
        CASE WHEN MAX(a.points_awarded) < 0 THEN 0
          WHEN MAX(a.points_awarded) > p.points THEN p.points ELSE MAX(a.points_awarded) END AS problem_points
      FROM submissions a JOIN problems p ON p.id = a.problem_id
      JOIN users students ON students.id = a.student_id AND students.role = 'student'
      WHERE a.ai_flagged = 0
      GROUP BY a.student_id, p.id, p.points
    ), student_scores AS (
      SELECT student_id, SUM(problem_points) AS points FROM per_problem GROUP BY student_id
    )
    SELECT u.id, u.username, u.display_name AS display_name, u.active,
      c.id AS class_id, c.title AS class_title, t.display_name AS teacher_name,
      COALESCE(ss.points, 0) AS points
    FROM users u LEFT JOIN class_memberships m ON m.student_id = u.id
    LEFT JOIN teacher_classes c ON c.id = m.class_id LEFT JOIN users t ON t.id = c.teacher_id
    LEFT JOIN student_scores ss ON ss.student_id = u.id
    WHERE u.role = 'student'`).all();
  return rows.map((row) => ({ ...row, active: Boolean(row.active), points: Number(row.points || 0) }))
    .sort((a, b) => b.points - a.points || a.display_name.localeCompare(b.display_name, 'fa') || a.id.localeCompare(b.id))
    .map((row, index) => ({ rank: index + 1, studentId: row.id, username: row.username, displayName: row.display_name, points: row.points, classId: row.class_id, classTitle: row.class_title || 'بدون کلاس', teacherName: row.teacher_name || '' }));
}

async function reportCardData(db, studentId, now = Date.now()) {
  const totalPoints = await studentTotalPoints(db, studentId);
  const summary = await db.prepare(`SELECT COUNT(*) AS attempts,
      COUNT(DISTINCT problem_id) AS attempted_problems,
      COUNT(DISTINCT CASE WHEN verdict = 'accepted' THEN problem_id END) AS solved_problems,
      SUM(CASE WHEN verdict = 'accepted' THEN 1 ELSE 0 END) AS accepted_attempts,
      COALESCE(SUM(passed_cases), 0) AS passed_cases,
      COALESCE(SUM(total_cases), 0) AS total_cases
    FROM submissions WHERE student_id = ? AND ai_flagged = 0`).get(studentId);
  // Include both the current class sessions and every historical session in which
  // the student has submitted work. A class transfer must not hide prior learning.
  const sessions = (await db.prepare(`WITH relevant_sessions AS (
      SELECT s.id FROM class_sessions s JOIN problems p ON p.session_id=s.id
        JOIN submissions a ON a.problem_id=p.id WHERE a.student_id=? AND a.ai_flagged=0
      UNION
      SELECT s.id FROM class_memberships m JOIN class_sessions s ON s.class_id=m.class_id
        WHERE m.student_id=?
    )
    SELECT s.id, s.title,
      CASE WHEN c.title IS NOT NULL THEN c.title
        WHEN s.is_contest=1 THEN 'مسابقه'
        WHEN s.is_assignment=1 THEN 'تکلیف'
        ELSE 'بدون کلاس' END AS class_title,
      COUNT(DISTINCT p.id) AS problem_count,
      COUNT(DISTINCT CASE WHEN solved.problem_id IS NOT NULL THEN solved.problem_id END) AS solved_count,
      COALESCE(SUM(best.best_points),0) AS points
    FROM relevant_sessions rs JOIN class_sessions s ON s.id=rs.id
    LEFT JOIN teacher_classes c ON c.id=s.class_id
    LEFT JOIN problems p ON p.session_id=s.id AND p.published=1
    LEFT JOIN (SELECT DISTINCT problem_id FROM submissions WHERE student_id=? AND ai_flagged=0 AND verdict='accepted') solved ON solved.problem_id=p.id
    LEFT JOIN (SELECT a.problem_id, MAX(a.points_awarded) AS best_points FROM submissions a WHERE a.student_id=? AND a.ai_flagged=0 GROUP BY a.problem_id) best ON best.problem_id=p.id
    GROUP BY s.id, s.title, c.title, s.is_contest, s.is_assignment, s.created_at ORDER BY s.created_at DESC`).all(studentId, studentId, studentId, studentId))
    .map((row) => ({ id: row.id, title: row.title, classTitle: row.class_title, problemCount: Number(row.problem_count), solvedCount: Number(row.solved_count), points: Number(row.points || 0), progress: row.problem_count ? Math.round(row.solved_count * 100 / row.problem_count) : 0 }));
  const classRow = await db.prepare(`SELECT c.id, c.title FROM class_memberships m JOIN teacher_classes c ON c.id = m.class_id WHERE m.student_id = ?`).get(studentId);
  const rankRows = classRow ? await classLeaderboard(db, classRow.id) : [];
  const rank = rankRows.findIndex((row) => row.studentId === studentId) + 1;
  const activity = await db.prepare(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS attempts,
    SUM(CASE WHEN verdict='accepted' THEN 1 ELSE 0 END) AS accepted
    FROM submissions WHERE student_id=? AND ai_flagged=0 AND created_at >= ? GROUP BY substr(created_at,1,10) ORDER BY day`).all(studentId, new Date(now - 30 * 86400000).toISOString());
  return {
    totalPoints,
    solvedProblems: Number(summary.solved_problems || 0),
    attempts: Number(summary.attempts || 0),
    acceptedAttempts: Number(summary.accepted_attempts || 0),
    successRate: summary.attempts ? Math.round(Number(summary.solved_problems || 0) * 100 / Math.max(1, Number(summary.attempted_problems || 0))) : 0,
    testPassRate: summary.total_cases ? Math.round(Number(summary.passed_cases || 0) * 100 / Number(summary.total_cases)) : 0,
    class: classRow ? { ...classRow, rank, size: rankRows.length } : null,
    sessions, activity,
  };
}

async function adminLearningDataSummary(db) {
  const count = async (table) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n || 0);
  const [classes, sessions, problems, bankQuestions, contests, assignments, submissions, activityEvents, scheduleEvents, notifications, pointsRow] = await Promise.all([
    count('teacher_classes'), count('class_sessions'), count('problems'), count('question_bank'), count('contests'),
    count('assignments'), count('submissions'), count('audit_log'), count('class_schedule_events'), count('notifications'),
    db.prepare('SELECT COALESCE(SUM(points_awarded),0) AS n FROM submissions WHERE ai_flagged=0').get(),
  ]);
  return { classes, sessions, questions: problems + bankQuestions, contests, assignments, submissions,
    points: Number(pointsRow?.n || 0), activityEvents, scheduleEvents, notifications };
}

export async function createApp({ db, runJudge = defaultRunSubmission, config = {} }) {
  const app = createHttpApp();
  const clockNow = () => typeof config.now === 'function' ? Number(config.now()) : Date.now();
  await purgeExpiredSubmissionSources(db);
  await purgeExpiredOperationalRows(db);
  const sourceCleanupTimer = setInterval(async () => {
    try {
      await purgeExpiredSubmissionSources(db);
      await purgeExpiredOperationalRows(db);
    } catch (error) { console.error('[database maintenance]', error); }
  }, 15 * 60 * 1000);
  sourceCleanupTimer.unref?.();
  const sessionHours = boundedInteger(config.sessionHours ?? process.env.SESSION_HOURS, 12, 1, 720);
  const appOrigins = new Set(String(config.appOrigin || process.env.APP_ORIGIN || 'http://127.0.0.1:3000')
    .split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean));
  const appOrigin = [...appOrigins][0] || 'http://127.0.0.1:3000';
  const cookieSecure = [...appOrigins].some((origin) => origin.startsWith('https://'));
  const loginAttempts = new Map();
  const recentSubmissions = new Map();
  const activeStudentSubmissions = new Set();
  const backupDir = path.resolve(config.backupDir || process.env.BACKUP_DIR || (process.env.NODE_ENV === 'production' ? '/var/backups/acm-classroom' : './backups'));
  let lastManualBackupAt = 0;
  const judgePool = new BoundedWorkerPool({ concurrency: boundedInteger(process.env.MAX_CONCURRENT_JUDGES, 3, 1, 8), maxQueue: boundedInteger(process.env.MAX_JUDGE_QUEUE, 100, 0, 1000) });
  const runtimeCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, attempt] of loginAttempts) if (attempt.resetAt <= now) loginAttempts.delete(ip);
    for (const [studentId, timestamps] of recentSubmissions) {
      const fresh = timestamps.filter((timestamp) => now - timestamp < 60_000);
      if (fresh.length) recentSubmissions.set(studentId, fresh); else recentSubmissions.delete(studentId);
    }
    // Bound in-memory limiter maps without clearing every active limit at once.
    // Clearing the whole map would let an attacker reset throttling by filling it.
    if (loginAttempts.size > 50_000) {
      const excess = loginAttempts.size - 40_000;
      let removed = 0;
      for (const key of loginAttempts.keys()) {
        loginAttempts.delete(key);
        if (++removed >= excess) break;
      }
    }
    if (recentSubmissions.size > 50_000) {
      const excess = recentSubmissions.size - 40_000;
      let removed = 0;
      for (const key of recentSubmissions.keys()) {
        recentSubmissions.delete(key);
        if (++removed >= excess) break;
      }
    }
  }, 60_000);
  runtimeCleanupTimer.unref?.();
  app.disable('x-powered-by');

  const devOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || (!appOrigins.has(origin) && !(process.env.NODE_ENV === 'development' && devOrigins.has(origin)))) {
      return res.status(403).json({ error: 'درخواست از مبدأ مجاز ارسال نشده است.' });
    }
    return next();
  });

  const getUser = async (req) => {
    const token = req.cookies?.acm_session || parseCookies(req.headers.cookie || '').acm_session;
    if (!token) return null;
    const session = await db.prepare(`SELECT u.${PUBLIC_USER_FIELDS.split(', ').join(', u.')}, u.password_hash AS _passwordHash
      FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(tokenHash(token), Date.now());
    if (!session || !session.active) return null;
    return { ...safeUser(session), passwordHash: session._passwordHash };
  };
  const auth = async (req, res, next) => {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'برای ادامه وارد حساب خودت شو.' });
    req.user = user;
    const authPath = req.path.replace(/^\/api/, '');
    const permitPasswordChange = authPath === '/auth/me' || authPath === '/auth/logout' || authPath === '/auth/change-password';
    if (user.mustChangePassword && !permitPasswordChange) return res.status(428).json({ error: 'قبل از ادامه باید گذرواژهٔ موقتت را تغییر بدهی.', mustChangePassword: true });
    next();
  };
  const requireRole = (...allowed) => (req, res, next) => {
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'برای این عملیات دسترسی نداری.' });
    next();
  };
  const audit = async (req, action, type, id = '', details = '') => await logAudit(db, req.user?.id, action, type, id, details);

  app.post('/api/auth/login', async (req, res) => {
    const remote = req.ip || req.socket.remoteAddress || 'unknown';
    const current = loginAttempts.get(remote) || { count: 0, resetAt: Date.now() + 60_000 };
    if (current.resetAt < Date.now()) { current.count = 0; current.resetAt = Date.now() + 60_000; }
    if (current.count >= 10) return res.status(429).json({ error: 'تعداد تلاش‌ها زیاد است؛ یک دقیقه بعد دوباره امتحان کن.' });
    const username = cleanString(req.body?.username, 32).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const row = await db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, password_hash FROM users WHERE username = ?`).get(username);
    // Run the same password KDF for unknown/inactive accounts to reduce username timing leaks.
    // Reject oversized passwords before invoking scrypt to keep login cost bounded.
    const passwordMatches = password.length <= 200 && verifyPassword(password, row?.password_hash || DUMMY_PASSWORD_HASH);
    if (!row || !row.active || !passwordMatches) {
      current.count += 1; loginAttempts.set(remote, current);
      return res.status(401).json({ error: 'نام کاربری یا گذرواژه درست نیست.' });
    }
    // Do not clear the IP failure bucket on a successful login: otherwise an attacker
    // could reset brute-force throttling by logging in to a different account from the same IP.
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = Date.now() + sessionHours * 60 * 60 * 1000;
    await db.prepare('INSERT INTO login_sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash(token), row.id, expires, nowIso());
    res.cookie('acm_session', token, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/', maxAge: sessionHours * 60 * 60 * 1000 });
    await logAudit(db, row.id, 'login', 'auth', row.id, 'ورود موفق');
    res.json({ user: safeUser(row) });
  });
  app.get('/api/auth/me', auth, async (req, res) => {
    await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(nowIso(), req.user.id);
    res.json({ user: safeUser(req.user) });
  });
  app.post('/api/presence/heartbeat', auth, async (req, res) => {
    const seenAt = nowIso();
    await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(seenAt, req.user.id);
    res.json({ ok: true, lastSeen: seenAt });
  });
  app.post('/api/auth/logout', auth, async (req, res) => {
    const token = parseCookies(req.headers.cookie || '').acm_session;
    if (token) await db.prepare('DELETE FROM login_sessions WHERE token_hash = ?').run(tokenHash(token));
    await db.prepare('UPDATE users SET last_seen = NULL WHERE id = ?').run(req.user.id);
    res.clearCookie('acm_session', { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/' });
    await audit(req, 'logout', 'auth', req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/auth/change-password', auth, async (req, res) => {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (currentPassword.length > 200 || !verifyPassword(currentPassword, req.user.passwordHash)) return res.status(400).json({ error: 'گذرواژهٔ فعلی درست نیست.' });
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'گذرواژهٔ جدید باید حداقل 12 نویسه داشته باشد.' });
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword), req.user.id);
    const oldToken = parseCookies(req.headers.cookie || '').acm_session;
    await db.prepare('DELETE FROM login_sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, oldToken ? tokenHash(oldToken) : '');
    await audit(req, 'change_password', 'user', req.user.id);
    res.json({ ok: true });
  });
  app.patch('/api/auth/profile', auth, async (req, res) => {
    const username = cleanString(req.body?.username, 32).toLowerCase();
    const displayName = cleanString(req.body?.displayName, 80);
    if (!validUsername(username)) return res.status(400).json({ error: 'نام کاربری باید 3 تا 32 نویسه و شامل حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.' });
    if (!displayName) return res.status(400).json({ error: 'نام نمایشی الزامی است.' });
    try {
      await db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?').run(username, displayName, req.user.id);
    } catch (error) {
      if (isUniqueConstraint(error)) return res.status(409).json({ error: 'این نام کاربری قبلاً استفاده شده است.' });
      throw error;
    }
    await audit(req, 'update_profile', 'user', req.user.id);
    res.json({ user: safeUser(await db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = ?`).get(req.user.id)) });
  });

  const baleEnabled = config.baleEnabled ?? Boolean(process.env.BALE_BOT_TOKEN);
  app.get('/api/bale/status', auth, async (req, res) => {
    const link = await db.prepare('SELECT chat_label AS chatLabel, chat_username AS chatUsername, enabled, linked_at AS linkedAt FROM bale_links WHERE user_id=?').get(req.user.id);
    const botUsername = (await db.prepare("SELECT value FROM bale_state WHERE key='bot_username'").get())?.value || '';
    res.json({
      configured: Boolean(baleEnabled),
      botUsername,
      linked: Boolean(link),
      enabled: Boolean(link?.enabled),
      chatLabel: link?.chatLabel || '',
      chatUsername: link?.chatUsername || '',
      linkedAt: link?.linkedAt || null,
    });
  });
  app.post('/api/bale/link-code', auth, async (req, res) => {
    if (!baleEnabled) return res.status(503).json({ error: 'اتصال بله هنوز توسط مدیر سرور پیکربندی نشده است.' });
    if (await db.prepare('SELECT 1 FROM bale_links WHERE user_id=?').get(req.user.id)) return res.status(409).json({ error: 'ابتدا اتصال فعلی بله را قطع کن و سپس کد تازه بساز.' });
    const code = crypto.randomBytes(12).toString('base64url');
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const tx = db.transaction(async () => {
      await db.prepare('DELETE FROM bale_link_codes WHERE user_id=? OR expires_at<=?').run(req.user.id, createdAt);
      await db.prepare('INSERT INTO bale_link_codes(code_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
        .run(codeHash, req.user.id, expiresAt, createdAt);
    });
    await tx();
    const botUsername = (await db.prepare("SELECT value FROM bale_state WHERE key='bot_username'").get())?.value || '';
    await audit(req, 'create_bale_link_code', 'bale', req.user.id);
    res.status(201).json({ code, command: `/start ${code}`, expiresAt, botUsername });
  });
  app.patch('/api/bale/settings', auth, async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'وضعیت ارسال اعلان باید مشخص باشد.' });
    const linked = await db.prepare('SELECT 1 FROM bale_links WHERE user_id=?').get(req.user.id);
    if (!linked) return res.status(404).json({ error: 'ابتدا حساب بله را متصل کن.' });
    const stamp = nowIso();
    const tx = db.transaction(async () => {
      await db.prepare('UPDATE bale_links SET enabled=? WHERE user_id=?').run(req.body.enabled ? 1 : 0, req.user.id);
      if (req.body.enabled) await db.prepare("UPDATE bale_notification_outbox SET next_attempt_at=? WHERE user_id=? AND status='pending'").run(stamp, req.user.id);
    });
    await tx();
    await audit(req, req.body.enabled ? 'enable_bale_notifications' : 'disable_bale_notifications', 'bale', req.user.id);
    res.json({ ok: true, enabled: req.body.enabled });
  });
  app.delete('/api/bale/link', auth, async (req, res) => {
    const tx = db.transaction(async () => {
      await db.prepare("UPDATE bale_notification_outbox SET status='cancelled' WHERE user_id=? AND status IN ('pending','processing')").run(req.user.id);
      await db.prepare('DELETE FROM bale_links WHERE user_id=?').run(req.user.id);
      await db.prepare('DELETE FROM bale_link_codes WHERE user_id=?').run(req.user.id);
    });
    await tx();
    await audit(req, 'unlink_bale', 'bale', req.user.id);
    res.json({ ok: true });
  });

  app.get('/api/student/report-card', auth, requireRole('student'), async (req, res) => {
    res.json({ report: await reportCardData(db, req.user.id, clockNow()) });
  });
  app.get('/api/notifications', auth, async (req, res) => {
    await db.prepare("DELETE FROM notifications WHERE user_id = ? AND created_at < ?").run(req.user.id, new Date(clockNow() - 90 * 86400000).toISOString());
    const notifications = await db.prepare(`SELECT id, title, message, type, target_path AS targetPath, read_at AS readAt, created_at AS createdAt
      FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40`).all(req.user.id);
    const unread = (await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id)).n;
    res.json({ notifications, unread });
  });
  app.patch('/api/notifications/:id/read', auth, async (req, res) => {
    const result = await db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(nowIso(), req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'اعلان پیدا نشد.' });
    res.json({ ok: true });
  });
  app.post('/api/notifications/read-all', auth, async (req, res) => {
    await db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ?').run(nowIso(), req.user.id);
    res.json({ ok: true });
  });
  app.get('/api/admin/leaderboard', auth, requireRole('admin'), async (req, res) => {
    res.json({ leaderboard: await adminStudentLeaderboard(db), generatedAt: new Date(clockNow()).toISOString() });
  });

  app.get('/api/admin/system', auth, requireRole('admin'), async (req, res) => {
    const postgresStats = await db.prepare(`SELECT current_setting('server_version') AS server_version,
      pg_database_size(current_database())::bigint AS database_bytes,
      (SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database())::integer AS connections,
      current_setting('max_connections')::integer AS max_connections`).get();
    let disk = null;
    try {
      const stat = fs.statfsSync(process.cwd());
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      disk = { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), usedPercent: totalBytes ? Math.round((totalBytes - freeBytes) * 100 / totalBytes) : 0 };
    } catch { /* statfs is not available on every supported filesystem */ }
    const memory = process.memoryUsage();
    const systemMemoryTotal = os.totalmem();
    const systemMemoryFree = os.freemem();
    const outbox = await db.prepare(`SELECT status, COUNT(*) AS count FROM bale_notification_outbox GROUP BY status`).all();
    const backupList = listDatabaseBackups(backupDir);
    res.json({
      runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), systemUptimeSeconds: Math.floor(os.uptime()), cpuCount: os.cpus().length, loadAverage: os.loadavg(), database: 'PostgreSQL', databaseEngine: 'PostgreSQL', horizontalScaling: false, nextStep: 'Async pg connection pool + Redis + dedicated judge workers' },
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, systemTotalBytes: systemMemoryTotal, systemFreeBytes: systemMemoryFree, systemUsedPercent: systemMemoryTotal ? Math.round((systemMemoryTotal - systemMemoryFree) * 100 / systemMemoryTotal) : 0 },
      disk,
      database: { fileBytes: Number(postgresStats?.database_bytes || 0), pageCount: 0, pageSize: 0, walBytes: 0, serverVersion: postgresStats?.server_version || null, connections: Number(postgresStats?.connections || 0), maxConnections: Number(postgresStats?.max_connections || 0) },
      backups: { count: backupList.length, latest: backupList[0] || null },
      judge: judgePool.stats(),
      baleOutbox: Object.fromEntries(outbox.map((row) => [row.status, Number(row.count)])),
      counts: {
        users: (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE active=1').get()).n,
        classes: (await db.prepare('SELECT COUNT(*) AS n FROM teacher_classes').get()).n,
        submissions: (await db.prepare('SELECT COUNT(*) AS n FROM submissions').get()).n,
        drafts: (await db.prepare('SELECT COUNT(*) AS n FROM code_drafts').get()).n,
        contestsActive: (await db.prepare('SELECT COUNT(*) AS n FROM contests WHERE start_at <= ? AND end_at > ?').get(new Date(clockNow()).toISOString(), new Date(clockNow()).toISOString())).n,
        unreadNotifications: (await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get()).n,
      },
    });
  });

  app.get('/api/admin/backups', auth, requireRole('admin'), (req, res) => {
    res.json({ backups: listDatabaseBackups(backupDir), retentionDays: boundedInteger(process.env.BACKUP_RETENTION_DAYS, 30, 1, 365) });
  });
  app.post('/api/admin/backups', auth, requireRole('admin'), async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length > 200 || !verifyPassword(password, req.user.passwordHash)) return res.status(403).json({ error: 'برای ساخت پشتیبان، گذرواژهٔ فعلی مدیر را وارد کن.' });
    if (clockNow() - lastManualBackupAt < 60_000) return res.status(429).json({ error: 'برای جلوگیری از فشار بی‌مورد به دیسک، هر دقیقه فقط یک پشتیبان دستی ساخته می‌شود.' });
    lastManualBackupAt = clockNow();
    try {
      const created = await createDatabaseBackup(db, backupDir, clockNow());
      await audit(req, 'create_database_backup', 'backup', created.filename, `size=${created.size}`);
      return res.status(201).json({ backup: { filename: created.filename, size: created.size, createdAt: created.createdAt } });
    } catch (error) {
      console.error('[database backup]', error?.stack || error);
      return res.status(500).json({ error: 'ساخت یا بررسی سلامت پشتیبان ناموفق بود. فضای دیسک و گزارش سرور را بررسی کن.' });
    }
  });
  app.get('/api/admin/backups/:filename/download', auth, requireRole('admin'), (req, res) => {
    const file = resolveDatabaseBackupFile(backupDir, req.params.filename);
    if (!file) return res.status(404).json({ error: 'فایل پشتیبان پیدا نشد.' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    res.setHeader('Content-Disposition', `attachment; filename=\"${path.basename(file)}\"`);
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(file);
    stream.on('error', () => { if (!res.writableEnded) { res.statusCode = 500; res.end(); } });
    stream.pipe(res);
  });

  app.get('/api/dashboard', auth, async (req, res) => {
    const user = req.user;
    let stats;
    if (user.role === 'admin') {
      stats = {
        users: (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get()).n,
        teachers: (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher' AND active = 1").get()).n,
        students: (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND active = 1").get()).n,
        sessions: (await db.prepare('SELECT COUNT(*) AS n FROM class_sessions').get()).n,
        activeSessions: (await db.prepare('SELECT COUNT(*) AS n FROM class_sessions WHERE active = 1').get()).n,
        problems: (await db.prepare('SELECT COUNT(*) AS n FROM problems').get()).n,
        submissions: (await db.prepare('SELECT COUNT(*) AS n FROM submissions').get()).n,
        accepted: (await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE ai_flagged=0 AND verdict = 'accepted'").get()).n,
      };
    } else if (user.role === 'teacher') {
      stats = {
        classes: (await db.prepare('SELECT COUNT(*) AS n FROM teacher_classes WHERE teacher_id = ?').get(user.id)).n,
        sessions: (await db.prepare('SELECT COUNT(*) AS n FROM class_sessions WHERE created_by = ?').get(user.id)).n,
        activeSessions: (await db.prepare('SELECT COUNT(*) AS n FROM class_sessions WHERE created_by = ? AND active = 1').get(user.id)).n,
        problems: (await db.prepare('SELECT COUNT(*) AS n FROM problems p JOIN class_sessions s ON s.id = p.session_id WHERE s.created_by = ?').get(user.id)).n,
        submissions: (await db.prepare('SELECT COUNT(*) AS n FROM submissions a JOIN problems p ON p.id = a.problem_id JOIN class_sessions s ON s.id = p.session_id WHERE s.created_by = ? AND a.ai_flagged=0').get(user.id)).n,
      };
    } else {
      stats = {
        activeSessions: (await db.prepare(`SELECT s.* FROM class_sessions s JOIN class_memberships m ON m.class_id = s.class_id
          WHERE m.student_id = ? AND s.active = 1`).all(user.id)).filter((session) => isStudentSessionAvailable(session, clockNow())).length,
        submissions: (await db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE student_id = ? AND ai_flagged=0').get(user.id)).n,
        accepted: (await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE student_id = ? AND ai_flagged=0 AND verdict = 'accepted'").get(user.id)).n,
        totalPoints: await studentTotalPoints(db, user.id),
        problemsSolved: (await db.prepare("SELECT COUNT(DISTINCT problem_id) AS n FROM submissions WHERE student_id = ? AND ai_flagged=0 AND verdict = 'accepted'").get(user.id)).n,
      };
    }
    res.json({ stats });
  });

  // Admin-only account management. Account removal is a reversible deactivation to preserve submissions and audit history.
  app.get('/api/admin/users', auth, requireRole('admin'), async (req, res) => {
    res.json({ users: (await db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'teacher' THEN 1 ELSE 2 END, username`).all()).map(safeUser) });
  });
  app.post('/api/admin/users', auth, requireRole('admin'), async (req, res) => {
    const username = cleanString(req.body?.username, 32).toLowerCase();
    const displayName = cleanString(req.body?.displayName, 80);
    const role = req.body?.role;
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!validUsername(username)) return res.status(400).json({ error: 'نام کاربری باید 3 تا 32 نویسه باشد و فقط حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط داشته باشد.' });
    if (!displayName) return res.status(400).json({ error: 'نام و نام خانوادگی الزامی است.' });
    if (!roles.has(role)) return res.status(400).json({ error: 'نقش انتخاب‌شده معتبر نیست.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'گذرواژهٔ اولیه باید حداقل 12 نویسه داشته باشد.' });
    const id = createId();
    try {
      await db.prepare('INSERT INTO users(id, username, display_name, role, password_hash, active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)')
        .run(id, username, displayName, role, hashPassword(password), nowIso());
    } catch (error) {
      if (isUniqueConstraint(error)) return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
      throw error;
    }
    await audit(req, 'create_user', 'user', id, `role=${role}; username=${username}`);
    res.status(201).json({ user: safeUser(await db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = ?`).get(id)) });
  });
  app.patch('/api/admin/users/:id', auth, requireRole('admin'), async (req, res) => {
    const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    if (target.role === 'admin' && (req.body?.active === false || req.body?.role === 'student' || req.body?.role === 'teacher')) {
      const otherAdmins = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(target.id)).n;
      if (!otherAdmins) return res.status(400).json({ error: 'حداقل یک حساب مدیر فعال باید باقی بماند.' });
    }
    const displayName = req.body?.displayName === undefined ? target.display_name : cleanString(req.body.displayName, 80);
    const username = req.body?.username === undefined ? target.username : cleanString(req.body.username, 32);
    const role = req.body?.role === undefined ? target.role : req.body.role;
    const active = req.body?.active === undefined ? target.active : (req.body.active ? 1 : 0);
    if (!validUsername(username) || !displayName || !roles.has(role)) return res.status(400).json({ error: 'اطلاعات و نقش کاربر درست نیست.' });
    try {
      await db.prepare('UPDATE users SET username = ?, display_name = ?, role = ?, active = ? WHERE id = ?').run(username, displayName, role, active, target.id);
    } catch (error) {
      if (isUniqueConstraint(error)) return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
      throw error;
    }
    if (!active) await db.prepare('DELETE FROM login_sessions WHERE user_id = ?').run(target.id);
    await audit(req, active ? 'update_user' : 'deactivate_user', 'user', target.id, `role=${role}; active=${active}`);
    res.json({ user: safeUser(await db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = ?`).get(target.id)) });
  });
  app.post('/api/admin/users/:id/reset-password', auth, requireRole('admin'), async (req, res) => {
    const target = await db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!validPassword(password)) return res.status(400).json({ error: 'گذرواژهٔ موقت باید حداقل 12 نویسه داشته باشد.' });
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), target.id);
    await db.prepare('DELETE FROM login_sessions WHERE user_id = ?').run(target.id);
    await audit(req, 'reset_password', 'user', target.id);
    res.json({ ok: true, mustChangePassword: true });
  });
  app.get('/api/admin/data-summary', auth, requireRole('admin'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ summary: await adminLearningDataSummary(db) });
  });
  app.post('/api/admin/data/purge', auth, requireRole('admin'), async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirmation = cleanString(req.body?.confirmation, 80);
    if (confirmation !== 'حذف کامل سوابق') return res.status(400).json({ error: 'برای تأیید، عبارت «حذف کامل سوابق» را دقیقاً وارد کن.' });
    const recentFailures = Number((await db.prepare(`SELECT COUNT(*) AS n FROM admin_security_events
      WHERE actor_id=? AND event_type='purge_rejected_password' AND created_at>=?`).get(req.user.id, new Date(Date.now() - 10 * 60 * 1000).toISOString())).n || 0);
    if (recentFailures >= 5) return res.status(429).json({ error: 'به‌دلیل چند تلاش ناموفق، حذف کامل موقتاً مسدود شده است. ده دقیقه بعد دوباره تلاش کن.' });
    if (password.length > 200 || !verifyPassword(password, req.user.passwordHash)) {
      await db.prepare(`INSERT INTO admin_security_events(actor_id,event_type,details,created_at) VALUES(?,?,?,?)`)
        .run(req.user.id, 'purge_rejected_password', 'گذرواژهٔ نادرست برای درخواست حذف کامل سوابق', nowIso());
      return res.status(403).json({ error: 'گذرواژهٔ مدیر درست نیست؛ هیچ داده‌ای حذف نشد.' });
    }
    const before = await adminLearningDataSummary(db);
    const stamp = nowIso();
    await db.transaction(async () => {
      // Delete child/relationship tables first. Accounts, credentials and login sessions are retained.
      await db.exec(`
        DELETE FROM assignment_submissions;
        DELETE FROM assignment_problems;
        DELETE FROM assignment_participants;
        DELETE FROM assignments;
        DELETE FROM contest_submissions;
        DELETE FROM contest_problems;
        DELETE FROM contest_participants;
        DELETE FROM contests;
        DELETE FROM code_drafts;
        DELETE FROM submissions;
        DELETE FROM test_cases;
        DELETE FROM question_bank_tests;
        DELETE FROM problems;
        DELETE FROM question_bank;
        DELETE FROM class_schedule_events;
        DELETE FROM class_memberships;
        DELETE FROM class_sessions;
        DELETE FROM teacher_classes;
        DELETE FROM notifications;
        DELETE FROM audit_log;
      `);
      await db.prepare(`INSERT INTO admin_security_events(actor_id,event_type,details,created_at) VALUES(?,?,?,?)`)
        .run(req.user.id, 'learning_data_purge', JSON.stringify({ before, note: 'سوابق آموزشی، امتیازها، ارسال‌ها و گزارش فعالیت‌ها حذف شدند؛ حساب‌های کاربران و نشست‌های ورود حفظ شدند.' }), stamp);
    })();
    // PostgreSQL manages WAL/checkpoints; do not issue SQLite PRAGMAs here.
    const after = await adminLearningDataSummary(db);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, deleted: before, summary: after, message: 'سوابق آموزشی حذف شد. حساب‌های کاربری و گذرواژه‌ها حفظ شده‌اند.' });
  });

  app.get('/api/admin/sessions', auth, requireRole('admin'), async (req, res) => {
    const rows = await db.prepare(`SELECT s.*, u.username AS teacher_username, u.display_name AS teacher_name, c.title AS class_title,
      (SELECT COUNT(*) FROM problems p WHERE p.session_id = s.id) AS problem_count
      FROM class_sessions s JOIN users u ON u.id = s.created_by LEFT JOIN teacher_classes c ON c.id = s.class_id ORDER BY s.created_at DESC`).all();
    res.json({ sessions: rows.map((r) => ({ id: r.id, classId: r.class_id, classTitle: r.class_title || 'کلاس نامشخص', title: r.title, description: r.description, jalaliDate: r.jalali_date || null, startTime: r.start_time || null, endTime: r.end_time || null, active: Boolean(r.active), createdAt: r.created_at, updatedAt: r.updated_at, teacherUsername: r.teacher_username, teacherName: r.teacher_name, problemCount: r.problem_count })) });
  });
  app.get('/api/admin/submissions', auth, requireRole('admin'), async (req, res) => {
    await purgeExpiredSubmissionSources(db);
    const {limit,offset}=paginationFromRequest(req);
    const total=(await db.prepare('SELECT COUNT(*) AS n FROM submissions').get()).n;
    const rows = await db.prepare(`SELECT a.id, a.verdict, a.passed_cases, a.total_cases, a.points_awarded, a.runtime_ms, a.created_at, a.source_deleted_at, a.source_code, a.language, a.ai_flagged, a.ai_flagged_at, a.ai_flag_note,
      u.username AS student_username, u.display_name AS student_name, p.title AS problem_title, s.title AS session_title, c.title AS class_title, s.created_by,
      (SELECT ct.title FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id ORDER BY ct.created_at DESC LIMIT 1) AS contest_title,
      (SELECT ax.title FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id ORDER BY ax.created_at DESC LIMIT 1) AS assignment_title
      FROM submissions a JOIN users u ON u.id = a.student_id JOIN problems p ON p.id = a.problem_id JOIN class_sessions s ON s.id = p.session_id LEFT JOIN teacher_classes c ON c.id = s.class_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`).all(limit,offset);
    res.json({ submissions: rows.map(submissionSummary), pagination:{total,limit,offset,hasMore:offset+rows.length<total} });
  });
  app.get('/api/admin/submissions/:id/source', auth, requireRole('admin'), async (req, res) => {
    await purgeExpiredSubmissionSources(db);
    const row = await db.prepare(`SELECT a.id,a.source_code,a.source_deleted_at,a.created_at,a.language,u.username AS student_username,
      p.title AS problem_title,s.title AS session_title,c.title AS class_title,
      (SELECT ct.title FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id ORDER BY ct.created_at DESC LIMIT 1) AS contest_title
      FROM submissions a JOIN users u ON u.id=a.student_id JOIN problems p ON p.id=a.problem_id
      JOIN class_sessions s ON s.id=p.session_id LEFT JOIN teacher_classes c ON c.id=s.class_id WHERE a.id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'ارسال پیدا نشد.' });
    if (row.source_deleted_at || !row.source_code || Date.parse(row.created_at) <= Date.now() - SOURCE_RETENTION_MS) {
      if (!row.source_deleted_at) await db.prepare('UPDATE submissions SET source_code = ?, source_deleted_at = ? WHERE id = ?').run('', nowIso(), row.id);
      return res.status(410).json({ error: 'مهلت نگهداری کد به پایان رسیده است؛ کد پس از 7 روز حذف می‌شود.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ id: row.id, sourceCode: row.source_code, language: row.language || 'python', studentUsername: row.student_username,
      classTitle: row.contest_title ? 'مسابقه' : row.class_title, sessionTitle: row.contest_title ? `مسابقه: ${row.contest_title}` : row.session_title,
      problemTitle: row.problem_title, createdAt: row.created_at, expiresAt: new Date(Date.parse(row.created_at) + SOURCE_RETENTION_MS).toISOString() });
  });

  app.get('/api/admin/audit', auth, requireRole('admin'), async (req, res) => {
    res.json({ events: await db.prepare(`SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId, a.details, a.created_at AS createdAt, u.username AS actorUsername, u.display_name AS actorName
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 300`).all() });
  });
  app.get('/api/admin/presence', auth, requireRole('admin'), async (req, res) => {
    const threshold = Date.now() - 75_000;
    const users = await db.prepare(`SELECT id, username, display_name AS displayName, role, active, last_seen AS lastSeen,
      (SELECT title FROM teacher_classes WHERE teacher_id = users.id ORDER BY created_at LIMIT 1) AS firstClass
      FROM users WHERE active = 1 ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'teacher' THEN 1 ELSE 2 END, display_name`).all();
    res.json({ users: users.map((u) => ({ ...u, active: Boolean(u.active), online: Boolean(u.lastSeen && Date.parse(u.lastSeen) >= threshold) })) });
  });

  // Teacher classes, one-class-per-student membership, attendance heartbeat and Shamsi calendar.
  app.get('/api/teacher/classes', auth, requireRole('teacher'), async (req, res) => {
    const rows = await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM class_memberships m WHERE m.class_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM class_schedule_events e WHERE e.class_id = c.id) AS event_count,
      (SELECT COUNT(*) FROM class_sessions s WHERE s.class_id = c.id) AS session_count
      FROM teacher_classes c WHERE c.teacher_id = ? ORDER BY c.created_at DESC`).all(req.user.id);
    res.json({ classes: rows.map((r) => ({ id: r.id, title: r.title, description: r.description, studentCount: r.student_count, eventCount: r.event_count, sessionCount: r.session_count, createdAt: r.created_at, updatedAt: r.updated_at })) });
  });
  app.post('/api/teacher/classes', auth, requireRole('teacher'), async (req, res) => {
    const title = cleanString(req.body?.title, 120);
    const description = cleanString(req.body?.description, 2000);
    if (!title) return res.status(400).json({ error: 'نام کلاس الزامی است.' });
    const id = createId(); const now = nowIso();
    await db.prepare('INSERT INTO teacher_classes(id, teacher_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, title, description, now, now);
    await audit(req, 'create_class', 'class', id, title);
    res.status(201).json({ class: { id, title, description, studentCount: 0, eventCount: 0, createdAt: now, updatedAt: now } });
  });
  app.patch('/api/teacher/classes/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.id);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const title = req.body?.title === undefined ? access.row.title : cleanString(req.body.title, 120);
    const description = req.body?.description === undefined ? access.row.description : cleanString(req.body.description, 2000);
    if (!title) return res.status(400).json({ error: 'نام کلاس الزامی است.' });
    const now = nowIso();
    await db.prepare('UPDATE teacher_classes SET title = ?, description = ?, updated_at = ? WHERE id = ?').run(title, description, now, access.row.id);
    await audit(req, 'update_class', 'class', access.row.id, title);
    res.json({ class: { ...access.row, title, description, updatedAt: now } });
  });
  app.delete('/api/teacher/classes/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.id);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const linkedSessions = (await db.prepare('SELECT COUNT(*) AS n FROM class_sessions WHERE class_id = ?').get(access.row.id)).n;
    if (linkedSessions) return res.status(409).json({ error: `این کلاس ${linkedSessions} جلسه دارد. ابتدا جلسه‌ها را حذف یا منتقل کن؛ برای جلوگیری از حذف تصادفی ارسال‌ها، حذف کلاس متوقف شد.` });
    await db.prepare('DELETE FROM teacher_classes WHERE id = ?').run(access.row.id);
    await audit(req, 'delete_class', 'class', access.row.id, access.row.title);
    res.json({ ok: true });
  });
  app.get('/api/teacher/students/available', auth, requireRole('teacher'), async (req, res) => {
    const students = await db.prepare(`SELECT u.id, u.username, u.display_name AS displayName
      FROM users u LEFT JOIN class_memberships m ON m.student_id = u.id
      WHERE u.role = 'student' AND u.active = 1 AND m.student_id IS NULL ORDER BY u.display_name`).all();
    res.json({ students });
  });
  app.get('/api/teacher/classes/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.id);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const threshold = Date.now() - 75_000;
    const leaderboard = await classLeaderboard(db, access.row.id);
    const membersById = new Map((await db.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.last_seen AS lastSeen, m.joined_at AS joinedAt
      FROM class_memberships m JOIN users u ON u.id = m.student_id WHERE m.class_id = ?`).all(access.row.id)).map((u) => [u.id, u]));
    const members = leaderboard.map((row) => {
      const member = membersById.get(row.studentId);
      return { ...member, online: Boolean(member.lastSeen && Date.parse(member.lastSeen) >= threshold), totalPoints: row.points, rank: row.rank };
    });
    const events = await db.prepare('SELECT id, title, description, jalali_date AS jalaliDate, start_time AS startTime, end_time AS endTime, created_at AS createdAt FROM class_schedule_events WHERE class_id = ? ORDER BY jalali_date, start_time').all(access.row.id);
    const sessions = (await db.prepare(`SELECT s.id, s.title, s.description, s.jalali_date AS jalaliDate, s.start_time AS startTime, s.end_time AS endTime, s.active, s.created_at AS createdAt, s.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM problems p WHERE p.session_id = s.id) AS problemCount,
      (SELECT COUNT(*) FROM submissions a JOIN problems p ON p.id = a.problem_id WHERE p.session_id = s.id) AS submissionCount
      FROM class_sessions s WHERE s.class_id = ? ORDER BY s.created_at DESC`).all(access.row.id))
      .map((s) => ({ ...s, active: Boolean(s.active), calendarVisible: isSessionCalendarVisible(s, clockNow()) }));
    res.json({ class: { id: access.row.id, title: access.row.title, description: access.row.description, createdAt: access.row.created_at, updatedAt: access.row.updated_at }, members, leaderboard, events, sessions });
  });
  app.post('/api/teacher/classes/:id/members', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.id);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const studentId = cleanString(req.body?.studentId, 80);
    const student = await db.prepare("SELECT id, username, display_name AS displayName FROM users WHERE id = ? AND role = 'student' AND active = 1").get(studentId);
    if (!student) return res.status(404).json({ error: 'دانش‌آموز فعال پیدا نشد.' });
    const existing = await db.prepare('SELECT m.class_id, c.title, c.teacher_id FROM class_memberships m JOIN teacher_classes c ON c.id = m.class_id WHERE m.student_id = ?').get(studentId);
    if (existing) return res.status(409).json({ error: 'هر دانش‌آموز فقط می‌تواند عضو یک کلاس باشد. ابتدا او را از کلاس فعلی خارج کن.' });
    const id = createId();
    try { await db.prepare('INSERT INTO class_memberships(id, class_id, student_id, joined_at) VALUES (?, ?, ?, ?)').run(id, access.row.id, studentId, nowIso()); }
    catch (error) { if (isUniqueConstraint(error)) return res.status(409).json({ error: 'این دانش‌آموز قبلاً عضو کلاسی شده است.' }); throw error; }
    await audit(req, 'add_student_to_class', 'class_membership', id, `student=${studentId}; class=${access.row.id}`);
    res.status(201).json({ student });
  });
  app.delete('/api/teacher/classes/:id/members/:studentId', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.id);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const result = await db.prepare('DELETE FROM class_memberships WHERE class_id = ? AND student_id = ?').run(access.row.id, req.params.studentId);
    if (!result.changes) return res.status(404).json({ error: 'این دانش‌آموز عضو این کلاس نیست.' });
    await audit(req, 'remove_student_from_class', 'class', access.row.id, `student=${req.params.studentId}`);
    res.json({ ok: true });
  });
  app.post('/api/teacher/classes/:id/events', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.id);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const title = cleanString(req.body?.title, 140);
    const description = cleanString(req.body?.description, 2000);
    const jalaliDate = cleanString(req.body?.jalaliDate, 10).replace(/-/g, '/');
    const startTime = cleanString(req.body?.startTime, 5) || '09:00';
    const endTime = cleanString(req.body?.endTime, 5) || '10:00';
    if (!title || !validJalaliDate(jalaliDate)) return res.status(400).json({ error: 'عنوان و تاریخ شمسی معتبر لازم است؛ تاریخ را به شکل 1405/08/12 وارد کن.' });
    if (!validTime(startTime) || !validTime(endTime) || startTime >= endTime) return res.status(400).json({ error: 'ساعت شروع و پایان معتبر نیست؛ پایان باید بعد از شروع باشد.' });
    const id = createId(); const now = nowIso();
    await db.prepare('INSERT INTO class_schedule_events(id, class_id, title, description, jalali_date, start_time, end_time, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, access.row.id, title, description, jalaliDate, startTime, endTime, req.user.id, now, now);
    await audit(req, 'create_class_event', 'class_event', id, `${title}; ${jalaliDate}`);
    res.status(201).json({ event: { id, title, description, jalaliDate, startTime, endTime, createdAt: now } });
  });
  app.patch('/api/teacher/classes/:classId/events/:eventId', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.classId);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const old = await db.prepare('SELECT * FROM class_schedule_events WHERE id = ? AND class_id = ?').get(req.params.eventId, access.row.id);
    if (!old) return res.status(404).json({ error: 'رویداد تقویم پیدا نشد.' });
    const title = req.body?.title === undefined ? old.title : cleanString(req.body.title, 140);
    const description = req.body?.description === undefined ? old.description : cleanString(req.body.description, 2000);
    const jalaliDate = req.body?.jalaliDate === undefined ? old.jalali_date : cleanString(req.body.jalaliDate, 10).replace(/-/g, '/');
    const startTime = req.body?.startTime === undefined ? old.start_time : cleanString(req.body.startTime, 5);
    const endTime = req.body?.endTime === undefined ? old.end_time : cleanString(req.body.endTime, 5);
    if (!title || !validJalaliDate(jalaliDate) || !validTime(startTime) || !validTime(endTime) || startTime >= endTime) return res.status(400).json({ error: 'عنوان، تاریخ شمسی و ساعت‌های رویداد معتبر نیستند.' });
    const now = nowIso();
    await db.prepare('UPDATE class_schedule_events SET title = ?, description = ?, jalali_date = ?, start_time = ?, end_time = ?, updated_at = ? WHERE id = ?')
      .run(title, description, jalaliDate, startTime, endTime, now, old.id);
    await audit(req, 'update_class_event', 'class_event', old.id, `${title}; ${jalaliDate}`);
    res.json({ event: { id: old.id, title, description, jalaliDate, startTime, endTime, createdAt: old.created_at } });
  });
  app.delete('/api/teacher/classes/:classId/events/:eventId', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.classId);
    if (!access.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const result = await db.prepare('DELETE FROM class_schedule_events WHERE id = ? AND class_id = ?').run(req.params.eventId, access.row.id);
    if (!result.changes) return res.status(404).json({ error: 'رویداد تقویم پیدا نشد.' });
    await audit(req, 'delete_class_event', 'class_event', req.params.eventId);
    res.json({ ok: true });
  });
  app.get('/api/student/my-class', auth, requireRole('student'), async (req, res) => {
    const row = await db.prepare(`SELECT c.*, u.display_name AS teacher_name, u.username AS teacher_username
      FROM class_memberships m JOIN teacher_classes c ON c.id = m.class_id JOIN users u ON u.id = c.teacher_id WHERE m.student_id = ?`).get(req.user.id);
    if (!row) return res.json({ class: null, events: [], sessions: [] });
    const events = await db.prepare('SELECT id, title, description, jalali_date AS jalaliDate, start_time AS startTime, end_time AS endTime, created_at AS createdAt FROM class_schedule_events WHERE class_id = ? ORDER BY jalali_date, start_time').all(row.id);
    const sessions = (await db.prepare(`SELECT s.id, s.title, s.description, s.jalali_date AS jalaliDate, s.start_time AS startTime, s.end_time AS endTime,
      s.active, s.created_at AS createdAt, s.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM problems p WHERE p.session_id = s.id AND p.published = 1) AS problemCount
      FROM class_sessions s WHERE s.class_id = ? AND s.jalali_date IS NOT NULL ORDER BY s.jalali_date, s.start_time, s.created_at`).all(row.id))
      .map((session) => ({ ...session, active: Boolean(session.active), isCodingSession: true, calendarVisible: isSessionCalendarVisible(session, clockNow()), available: isStudentSessionAvailable({ active: session.active, jalaliDate: session.jalaliDate, startTime: session.startTime, endTime: session.endTime }, clockNow()) }));
    res.json({ class: { id: row.id, title: row.title, description: row.description, teacherName: row.teacher_name, teacherUsername: row.teacher_username }, events, sessions });
  });
  app.get('/api/admin/classes', auth, requireRole('admin'), async (req, res) => {
    const rows = await db.prepare(`SELECT c.*, u.username AS teacher_username, u.display_name AS teacher_name,
      (SELECT COUNT(*) FROM class_memberships m WHERE m.class_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM class_schedule_events e WHERE e.class_id = c.id) AS event_count
      FROM teacher_classes c JOIN users u ON u.id = c.teacher_id ORDER BY c.created_at DESC`).all();
    res.json({ classes: rows.map((r) => ({ id: r.id, title: r.title, description: r.description, teacherUsername: r.teacher_username, teacherName: r.teacher_name, studentCount: r.student_count, eventCount: r.event_count, createdAt: r.created_at })) });
  });

  // Shared teacher question bank. Every teacher can browse and copy questions;
  // only the original author can edit or delete the shared template.
  app.get('/api/teacher/question-bank', auth, requireRole('teacher'), async (req, res) => {
    const rows = await db.prepare(`SELECT q.*, u.id AS author_id, u.display_name AS author_name, u.username AS author_username
      FROM question_bank q JOIN users u ON u.id = q.teacher_id ORDER BY q.updated_at DESC, q.created_at DESC`).all();
    res.json({ questions: await Promise.all(rows.map((row) => questionBankRecord(db, row))) });
  });
  app.post('/api/teacher/question-bank', auth, requireRole('teacher'), async (req, res) => {
    const payload = validateProblemPayload({ ...req.body, published: false });
    if (payload.error) return res.status(400).json({ error: payload.error });
    const normalized = normalizeTests(payload.tests);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const id = createId(); const stamp = nowIso();
    const tx = db.transaction(async () => {
      await db.prepare(`INSERT INTO question_bank(id,teacher_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,created_at,updated_at,language_mode,default_language,cpp_standard,cpp_optimization)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, req.user.id, payload.title, payload.statement, payload.inputFormat, payload.outputFormat, payload.points, payload.attemptLimit, payload.timeLimitMs, payload.comparison, stamp, stamp, payload.languageMode, payload.defaultLanguage, payload.cppStandard, payload.cppOptimization);
      await insertQuestionBankTests(db, id, normalized.tests);
    });
    await tx(); await audit(req, 'create_bank_question', 'question_bank', id, payload.title);
    res.status(201).json({ question: await questionBankRecord(db, await db.prepare(`SELECT q.*, u.id AS author_id, u.display_name AS author_name, u.username AS author_username FROM question_bank q JOIN users u ON u.id=q.teacher_id WHERE q.id=?`).get(id), { includeTests: true }) });
  });
  app.get('/api/teacher/question-bank/:id', auth, requireRole('teacher'), async (req, res) => {
    const row = await db.prepare(`SELECT q.*, u.id AS author_id, u.display_name AS author_name, u.username AS author_username FROM question_bank q JOIN users u ON u.id=q.teacher_id WHERE q.id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'سؤال بانک پیدا نشد.' });
    res.json({ question: await questionBankRecord(db, row, { includeTests: true }) });
  });
  app.patch('/api/teacher/question-bank/:id', auth, requireRole('teacher'), async (req, res) => {
    const row = await db.prepare('SELECT * FROM question_bank WHERE id=? AND teacher_id=?').get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'سؤال بانک پیدا نشد.' });
    const existingTests = req.body?.tests === undefined ? (await db.prepare('SELECT input_text AS input, expected_output AS output, hidden FROM question_bank_tests WHERE bank_question_id=? ORDER BY position').all(row.id)).map((t) => ({ input: t.input, output: t.output, hidden: Boolean(t.hidden) })) : req.body.tests;
    const payload = validateProblemPayload({
      title: req.body?.title ?? row.title, statement: req.body?.statement ?? row.statement,
      inputFormat: req.body?.inputFormat ?? row.input_format, outputFormat: req.body?.outputFormat ?? row.output_format,
      points: req.body?.points ?? row.points, attemptLimit: req.body?.attemptLimit ?? row.attempt_limit,
      timeLimitMs: req.body?.timeLimitMs ?? row.time_limit_ms, comparison: req.body?.comparison ?? row.comparison,
      languageMode: req.body?.languageMode ?? row.language_mode, defaultLanguage: req.body?.defaultLanguage ?? row.default_language, cppStandard: req.body?.cppStandard ?? row.cpp_standard, cppOptimization: req.body?.cppOptimization ?? row.cpp_optimization,
      published: false, tests: existingTests,
    });
    if (payload.error) return res.status(400).json({ error: payload.error });
    const normalized = normalizeTests(existingTests);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const stamp = nowIso();
    const tx = db.transaction(async () => {
      await db.prepare(`UPDATE question_bank SET title=?,statement=?,input_format=?,output_format=?,points=?,attempt_limit=?,time_limit_ms=?,comparison=?,updated_at=?,language_mode=?,default_language=?,cpp_standard=?,cpp_optimization=? WHERE id=? AND teacher_id=?`)
        .run(payload.title,payload.statement,payload.inputFormat,payload.outputFormat,payload.points,payload.attemptLimit,payload.timeLimitMs,payload.comparison,stamp,payload.languageMode,payload.defaultLanguage,payload.cppStandard,payload.cppOptimization,row.id,req.user.id);
      if (req.body?.tests !== undefined) { await db.prepare('DELETE FROM question_bank_tests WHERE bank_question_id=?').run(row.id); await insertQuestionBankTests(db,row.id,normalized.tests); }
    });
    await tx(); await audit(req, 'update_bank_question', 'question_bank', row.id, payload.title);
    res.json({ question: await questionBankRecord(db, await db.prepare(`SELECT q.*, u.id AS author_id, u.display_name AS author_name, u.username AS author_username FROM question_bank q JOIN users u ON u.id=q.teacher_id WHERE q.id=?`).get(row.id), { includeTests: true }) });
  });
  app.delete('/api/teacher/question-bank/:id', auth, requireRole('teacher'), async (req, res) => {
    const row = await db.prepare('SELECT * FROM question_bank WHERE id=? AND teacher_id=?').get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'سؤال بانک پیدا نشد.' });
    await db.transaction(async () => {
      await db.prepare('UPDATE problems SET source_bank_id=NULL, bank_opt_out=1 WHERE source_bank_id=?').run(row.id);
      await db.prepare('DELETE FROM question_bank WHERE id=? AND teacher_id=?').run(row.id, req.user.id);
    })();
    await audit(req, 'delete_bank_question', 'question_bank', row.id, row.title);
    res.json({ ok: true });
  });
  app.post('/api/teacher/question-bank/:id/copy-to-session', auth, requireRole('teacher'), async (req, res) => {
    const bank = await db.prepare('SELECT * FROM question_bank WHERE id=?').get(req.params.id);
    if (!bank) return res.status(404).json({ error: 'سؤال بانک پیدا نشد.' });
    const access = await getSessionAccess(db, req.user, cleanString(req.body?.sessionId, 80), clockNow());
    if (!access.row || !access.allowed) return res.status(404).json({ error: 'جلسهٔ مقصد پیدا نشد یا متعلق به حساب تو نیست.' });
    const tests = (await db.prepare('SELECT input_text AS input, expected_output AS output, hidden FROM question_bank_tests WHERE bank_question_id=? ORDER BY position').all(bank.id)).map((t) => ({ input: t.input, output: t.output, hidden: Boolean(t.hidden) }));
    const normalized = normalizeTests(tests);
    if (normalized.error) return res.status(409).json({ error: 'تست‌های سؤال بانک معتبر نیستند؛ ابتدا آن را ویرایش کن.' });
    const id = createId(); const stamp = nowIso();
    const position = (await db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM problems WHERE session_id=?').get(access.row.id)).next;
    const tx = db.transaction(async () => {
      await db.prepare(`INSERT INTO problems(id,session_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,published,position,created_at,updated_at,source_bank_id,language_mode,default_language,cpp_standard,cpp_optimization)
        VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`).run(id,access.row.id,bank.title,bank.statement,bank.input_format,bank.output_format,bank.points,bank.attempt_limit,bank.time_limit_ms,bank.comparison,position,stamp,stamp,bank.id,bank.language_mode||'python',bank.default_language||'python',bank.cpp_standard||'17',bank.cpp_optimization||'O2');
      await insertTests(db,id,normalized.tests);
    });
    await tx(); await audit(req,'copy_bank_question','problem',id,`bank=${bank.id}; session=${access.row.id}; title=${bank.title}`);
    res.status(201).json({ problem: await publicProblem(db, await db.prepare('SELECT * FROM problems WHERE id=?').get(id)) });
  });

  // Teacher-only sandbox preview. Runs all test cases without persisting attempts, points, or source code.
  app.post('/api/teacher/question-bank/preview', auth, requireRole('teacher'), async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const language = req.body?.language === 'cpp' ? 'cpp' : 'python';
    const cppStandard = ['17','20'].includes(String(req.body?.cppStandard)) ? String(req.body.cppStandard) : '17';
    const optimization = ['O0','O1','O2','O3'].includes(String(req.body?.cppOptimization)) ? String(req.body.cppOptimization) : 'O2';
    if (!code.trim()) return res.status(400).json({ error: 'ابتدا کد را وارد کن.' });
    if (code.length > 50000) return res.status(400).json({ error: 'حجم کد نباید بیشتر از 50 کیلوبایت باشد.' });
    const normalized = normalizeTests(req.body?.tests);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const timeLimitMs = Number(req.body?.timeLimitMs ?? 1500);
    const comparison = req.body?.comparison ?? 'tokens';
    if (!Number.isInteger(timeLimitMs) || timeLimitMs < 500 || timeLimitMs > 5000) return res.status(400).json({ error: 'محدودیت زمان باید بین 500 تا 5000 میلی‌ثانیه باشد.' });
    if (!['tokens','exact'].includes(comparison)) return res.status(400).json({ error: 'روش مقایسهٔ خروجی معتبر نیست.' });
    try {
      const judgeTests = normalized.tests.map((test) => ({ input_text: test.input, expected_output: test.output, hidden: test.hidden, position: test.position }));
      const result = await judgePool.run(() => runJudge({ code, tests: judgeTests, timeLimitMs, comparison, language, cppStandard, optimization }));
      if (result.verdict === 'judge_error') return res.status(503).json({ error: result.message || 'سامانهٔ داوری موقتاً در دسترس نیست.' });
      res.json({ verdict: result.verdict, passedCases: result.passedCases, totalCases: result.totalCases, runtimeMs: result.runtimeMs || 0,
        compileError: result.compileError || '', cases: (result.results || []).map((item,index) => ({ index:index+1, hidden:Boolean(normalized.tests[index]?.hidden), passed:Boolean(item.passed), status:item.status, runtimeMs:item.runtimeMs || 0, error:item.error || '' })) });
    } catch (error) {
      if (error.code === 'QUEUE_FULL') return res.status(503).json({ error: 'صف داوری اکنون پر است؛ کمی بعد دوباره تلاش کن.' });
      return res.status(503).json({ error: 'اجرای آزمایشی کد ناموفق بود.' });
    }
  });

  // Teacher session and problem management.
  app.get('/api/teacher/sessions', auth, requireRole('teacher'), async (req, res) => {
    const sessions = await db.prepare(`SELECT s.*, c.title AS class_title, (SELECT COUNT(*) FROM problems p WHERE p.session_id = s.id) AS problem_count,
      (SELECT COUNT(*) FROM problems p JOIN submissions a ON a.problem_id = p.id WHERE p.session_id = s.id) AS submission_count
      FROM class_sessions s JOIN teacher_classes c ON c.id = s.class_id WHERE s.created_by = ? AND c.teacher_id = ? AND s.is_contest = 0 ORDER BY s.created_at DESC`).all(req.user.id, req.user.id);
    res.json({ sessions: sessions.map((r) => ({ id: r.id, classId: r.class_id, classTitle: r.class_title, title: r.title, description: r.description, jalaliDate: r.jalali_date || null, startTime: r.start_time || null, endTime: r.end_time || null, active: Boolean(r.active), calendarVisible: isSessionCalendarVisible(r, clockNow()), createdAt: r.created_at, updatedAt: r.updated_at, problemCount: r.problem_count, submissionCount: r.submission_count })) });
  });
  app.post('/api/teacher/sessions', auth, requireRole('teacher'), async (req, res) => {
    const title = cleanString(req.body?.title, 120);
    const description = cleanString(req.body?.description, 2000);
    const classId = cleanString(req.body?.classId, 80);
    const rawDate = cleanString(req.body?.jalaliDate, 10).replace(/-/g, '/');
    const hasDate = Boolean(rawDate);
    const startTime = cleanString(req.body?.startTime, 5);
    const endTime = cleanString(req.body?.endTime, 5);
    if (!title) return res.status(400).json({ error: 'عنوان جلسه الزامی است.' });
    if (!classId) return res.status(400).json({ error: 'باید کلاس مربوط به این جلسه را انتخاب کنی.' });
    if (hasDate && (!validJalaliDate(rawDate) || !validTime(startTime) || !validTime(endTime) || startTime >= endTime)) {
      return res.status(400).json({ error: 'برای زمان‌بندی جلسه، تاریخ شمسی معتبر و ساعت پایان بعد از ساعت شروع وارد کن.' });
    }
    if (!hasDate && (startTime || endTime)) return res.status(400).json({ error: 'برای ثبت ساعت، ابتدا تاریخ شمسی جلسه را وارد کن.' });
    const scheduledDate = hasDate ? rawDate : null;
    const scheduledStart = hasDate ? startTime : null;
    const scheduledEnd = hasDate ? endTime : null;
    const selectedClass = await db.prepare('SELECT id, title FROM teacher_classes WHERE id = ? AND teacher_id = ?').get(classId, req.user.id);
    if (!selectedClass) return res.status(404).json({ error: 'کلاس انتخاب‌شده پیدا نشد یا متعلق به حساب تو نیست.' });
    const id = createId();
    const now = nowIso();
    await db.prepare('INSERT INTO class_sessions(id, class_id, jalali_date, start_time, end_time, title, description, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, classId, scheduledDate, scheduledStart, scheduledEnd, title, description, req.user.id, now, now);
    await audit(req, 'create_session', 'session', id, `class=${classId}; ${scheduledDate || 'unscheduled'}; ${title}`);
    res.status(201).json({ session: { id, classId, classTitle: selectedClass.title, title, description, jalaliDate: scheduledDate, startTime: scheduledStart, endTime: scheduledEnd, active: false, createdAt: now, updatedAt: now, problemCount: 0, submissionCount: 0 } });
  });
  app.patch('/api/teacher/sessions/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await getSessionAccess(db, req.user, req.params.id, clockNow());
    if (!access.row) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این جلسه متعلق به حساب تو نیست.' });
    const title = req.body?.title === undefined ? access.row.title : cleanString(req.body.title, 120);
    const description = req.body?.description === undefined ? access.row.description : cleanString(req.body.description, 2000);
    const active = req.body?.active === undefined ? access.row.active : (req.body.active ? 1 : 0);
    const rawDate = req.body?.jalaliDate === undefined ? (access.row.jalali_date || '') : cleanString(req.body.jalaliDate, 10).replace(/-/g, '/');
    const startTime = req.body?.startTime === undefined ? (access.row.start_time || '') : cleanString(req.body.startTime, 5);
    const endTime = req.body?.endTime === undefined ? (access.row.end_time || '') : cleanString(req.body.endTime, 5);
    const hasDate = Boolean(rawDate);
    if (!title) return res.status(400).json({ error: 'عنوان جلسه الزامی است.' });
    if (hasDate && (!validJalaliDate(rawDate) || !validTime(startTime) || !validTime(endTime) || startTime >= endTime)) return res.status(400).json({ error: 'تاریخ شمسی و ساعت‌های جلسه معتبر نیستند.' });
    if (!hasDate && (startTime || endTime)) return res.status(400).json({ error: 'برای ثبت ساعت، تاریخ شمسی جلسه را نیز وارد کن.' });
    const scheduledDate = hasDate ? rawDate : null;
    const scheduledStart = hasDate ? startTime : null;
    const scheduledEnd = hasDate ? endTime : null;
    if (active && (!scheduledDate || !scheduledStart || !scheduledEnd)) {
      return res.status(400).json({ error: 'برای فعال‌سازی جلسه، ابتدا تاریخ شمسی و ساعت شروع و پایان را تعیین کن.' });
    }
    const stamp = nowIso();
    await db.prepare('UPDATE class_sessions SET title = ?, description = ?, jalali_date = ?, start_time = ?, end_time = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(title, description, scheduledDate, scheduledStart, scheduledEnd, active, stamp, access.row.id);
    await audit(req, active ? 'activate_session' : 'update_session', 'session', access.row.id, `active=${active}; date=${scheduledDate || 'unscheduled'}`);
    if (active && !access.row.active) {
      const members = (await db.prepare('SELECT student_id FROM class_memberships WHERE class_id = ?').all(access.row.class_id)).map((r) => r.student_id);
      await createNotifications(db, members, { title: 'جلسهٔ جدید فعال شد', message: `جلسهٔ «${title}» اکنون برای کلاس ${access.row.class_title} فعال است.`, type: 'session', targetPath: '/my-class' });
    }
    res.json({ ok: true, session: { id: access.row.id, classId: access.row.class_id, classTitle: access.row.class_title, title, description, jalaliDate: scheduledDate, startTime: scheduledStart, endTime: scheduledEnd, active: Boolean(active), updatedAt: stamp } });
  });
  app.delete('/api/teacher/sessions/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await getSessionAccess(db, req.user, req.params.id, clockNow());
    if (!access.row) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این جلسه متعلق به حساب تو نیست.' });
    const counts = await db.prepare(`SELECT (SELECT COUNT(*) FROM problems WHERE session_id = ?) AS problems,
      (SELECT COUNT(*) FROM submissions a JOIN problems p ON p.id = a.problem_id WHERE p.session_id = ?) AS submissions`).get(access.row.id, access.row.id);
    const title = access.row.title;
    const remove = db.transaction(async () => {
      await db.prepare('DELETE FROM class_sessions WHERE id = ?').run(access.row.id);
      await audit(req, 'delete_session', 'session', access.row.id, `class=${access.row.class_id}; problems=${counts.problems}; submissions=${counts.submissions}; title=${title}`);
    });
    await remove();
    res.json({ ok: true, deletedProblems: counts.problems, deletedSubmissions: counts.submissions });
  });

  app.get('/api/teacher/sessions/:id/export', auth, requireRole('teacher'), async (req, res) => {
    const access = await getSessionAccess(db, req.user, req.params.id, clockNow());
    if (!access.row) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این جلسه متعلق به حساب تو نیست.' });
    const problems = await Promise.all((await db.prepare('SELECT * FROM problems WHERE session_id = ? ORDER BY position, created_at').all(access.row.id))
      .map(async (problem) => ({
        title: problem.title,
        statement: problem.statement,
        inputFormat: problem.input_format,
        outputFormat: problem.output_format,
        points: problem.points,
        attemptLimit: Number(problem.attempt_limit || 0),
        timeLimitMs: problem.time_limit_ms,
        comparison: problem.comparison,
        published: Boolean(problem.published),
        tests: (await db.prepare('SELECT input_text AS input, expected_output AS output, hidden FROM test_cases WHERE problem_id = ? ORDER BY position')
          .all(problem.id)).map((test) => ({ input: test.input, output: test.output, hidden: Boolean(test.hidden) })),
      })));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      format: 'acm-classroom-session',
      formatVersion: 1,
      exportedAt: nowIso(),
      session: {
        title: access.row.title,
        description: access.row.description,
        jalaliDate: access.row.jalali_date || '',
        startTime: access.row.start_time || '',
        endTime: access.row.end_time || '',
      },
      problems,
    });
  });

  app.post('/api/teacher/classes/:classId/sessions/import', auth, requireRole('teacher'), async (req, res) => {
    const classRecord = await classAccess(db, req.user, req.params.classId);
    if (!classRecord.row) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    if (!classRecord.allowed) return res.status(403).json({ error: 'این کلاس متعلق به حساب تو نیست.' });
    const document = req.body;
    if (!document || document.format !== 'acm-classroom-session' || document.formatVersion !== 1) {
      return res.status(400).json({ error: 'قالب فایل جلسه پشتیبانی نمی‌شود؛ یک فایل خروجی ACM Classroom نسخهٔ 1 انتخاب کن.' });
    }
    if (!document.session || typeof document.session !== 'object' || Array.isArray(document.session) || !Array.isArray(document.problems) || document.problems.length > 100) {
      return res.status(400).json({ error: 'ساختار فایل جلسه معتبر نیست؛ حداکثر 100 سؤال قابل واردکردن است.' });
    }
    const title = cleanString(document.session.title, 120);
    const description = cleanString(document.session.description, 2000);
    const rawDate = cleanString(document.session.jalaliDate, 10).replace(/-/g, '/');
    const startTime = cleanString(document.session.startTime, 5);
    const endTime = cleanString(document.session.endTime, 5);
    const hasDate = Boolean(rawDate);
    if (!title) return res.status(400).json({ error: 'عنوان جلسه در فایل خالی است.' });
    if (hasDate && (!validJalaliDate(rawDate) || !validTime(startTime) || !validTime(endTime) || startTime >= endTime)) {
      return res.status(400).json({ error: 'تاریخ یا ساعت جلسه در فایل JSON معتبر نیست.' });
    }
    if (!hasDate && (startTime || endTime)) return res.status(400).json({ error: 'ساعت‌های جلسه بدون تاریخ شمسی معتبر نیستند.' });
    const validatedProblems = [];
    for (const [index, problem] of document.problems.entries()) {
      const payload = validateProblemPayload(problem);
      if (payload.error) return res.status(400).json({ error: `سؤال ${index + 1}: ${payload.error}` });
      const normalized = normalizeTests(payload.tests);
      if (normalized.error) return res.status(400).json({ error: `تست‌های سؤال ${index + 1}: ${normalized.error}` });
      validatedProblems.push({ payload, tests: normalized.tests });
    }
    const sessionId = createId();
    const createdAt = nowIso();
    const importedIds = [];
    const importTransaction = db.transaction(async () => {
      await db.prepare(`INSERT INTO class_sessions(id, class_id, jalali_date, start_time, end_time, title, description, active, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
        .run(sessionId, classRecord.row.id, hasDate ? rawDate : null, hasDate ? startTime : null, hasDate ? endTime : null, title, description, req.user.id, createdAt, createdAt);
      for (const [index, { payload, tests }] of validatedProblems.entries()) {
        const problemId = createId();
        importedIds.push(problemId);
        await db.prepare(`INSERT INTO problems(id, session_id, title, statement, input_format, output_format, points, attempt_limit, time_limit_ms, comparison, published, position, created_at, updated_at,language_mode,default_language,cpp_standard,cpp_optimization)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(problemId, sessionId, payload.title, payload.statement, payload.inputFormat, payload.outputFormat, payload.points, payload.attemptLimit, payload.timeLimitMs, payload.comparison, payload.published ? 1 : 0, index, createdAt, createdAt,payload.languageMode,payload.defaultLanguage,payload.cppStandard,payload.cppOptimization);
        await insertTests(db, problemId, tests);
        await addProblemToSharedBank(db, { problemId, teacherId: req.user.id, payload, tests, stamp: createdAt });
      }
    });
    await importTransaction();
    await audit(req, 'import_session', 'session', sessionId, `class=${classRecord.row.id}; problems=${validatedProblems.length}; title=${title}`);
    res.status(201).json({ importedProblems: validatedProblems.length, session: { id: sessionId, classId: classRecord.row.id, classTitle: classRecord.row.title, title, description, jalaliDate: hasDate ? rawDate : null, startTime: hasDate ? startTime : null, endTime: hasDate ? endTime : null, active: false, createdAt, updatedAt: createdAt, problemCount: validatedProblems.length, imported: true } });
  });

  app.get('/api/teacher/sessions/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await getSessionAccess(db, req.user, req.params.id, clockNow());
    if (!access.row) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این جلسه متعلق به حساب تو نیست.' });
    const problemRows = await db.prepare('SELECT * FROM problems WHERE session_id = ? ORDER BY position, created_at').all(access.row.id);
    const problems = await Promise.all(problemRows.map(async (problem) => ({ ...await publicProblem(db, problem, { includeSamples: false }), tests: [] })));
    if (problemRows.length) {
      const byId = new Map(problems.map((problem) => [problem.id, problem]));
      const testRows = await db.prepare(`SELECT t.problem_id, t.input_text AS input, t.expected_output AS output, t.hidden
        FROM test_cases t JOIN problems p ON p.id = t.problem_id
        WHERE p.session_id = ? ORDER BY p.position, p.created_at, t.position`).all(access.row.id);
      for (const testCase of testRows) byId.get(testCase.problem_id)?.tests.push({ input: testCase.input, output: testCase.output, hidden: Boolean(testCase.hidden) });
    }
    const submissions = await db.prepare(`SELECT a.id, a.verdict, a.passed_cases, a.total_cases, a.points_awarded, a.runtime_ms, a.created_at, a.source_deleted_at, a.source_code, a.ai_flagged, a.ai_flagged_at, a.ai_flag_note,
      u.username AS student_username, u.display_name AS student_name, p.title AS problem_title, s.title AS session_title, c.title AS class_title, s.created_by
      FROM submissions a JOIN users u ON u.id = a.student_id JOIN problems p ON p.id = a.problem_id JOIN class_sessions s ON s.id = p.session_id LEFT JOIN teacher_classes c ON c.id = s.class_id
      WHERE s.id = ? ORDER BY a.created_at DESC LIMIT 300`).all(access.row.id);
    res.json({ session: { id: access.row.id, classId: access.row.class_id, classTitle: access.row.class_title, title: access.row.title, description: access.row.description, jalaliDate: access.row.jalali_date || null, startTime: access.row.start_time || null, endTime: access.row.end_time || null, active: Boolean(access.row.active), createdAt: access.row.created_at }, problems, submissions: submissions.map(submissionSummary) });
  });
  app.post('/api/teacher/sessions/:id/problems', auth, requireRole('teacher'), async (req, res) => {
    const access = await getSessionAccess(db, req.user, req.params.id, clockNow());
    if (!access.row) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این جلسه متعلق به حساب تو نیست.' });
    const payload = validateProblemPayload(req.body);
    if (payload.error) return res.status(400).json({ error: payload.error });
    const normalized = normalizeTests(payload.tests);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const id = createId(); const now = nowIso();
    const position = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM problems WHERE session_id = ?').get(access.row.id)).next;
    const trx = db.transaction(async () => {
      await db.prepare(`INSERT INTO problems(id, session_id, title, statement, input_format, output_format, points, attempt_limit, time_limit_ms, comparison, published, position, created_at, updated_at,language_mode,default_language,cpp_standard,cpp_optimization)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, access.row.id, payload.title, payload.statement, payload.inputFormat, payload.outputFormat, payload.points, payload.attemptLimit, payload.timeLimitMs, payload.comparison, payload.published ? 1 : 0, position, now, now,payload.languageMode,payload.defaultLanguage,payload.cppStandard,payload.cppOptimization);
      await insertTests(db, id, normalized.tests);
      await addProblemToSharedBank(db, { problemId: id, teacherId: req.user.id, payload, tests: normalized.tests, stamp: now });
    });
    await trx();
    await audit(req, 'create_problem', 'problem', id, payload.title);
    if (payload.published) {
      const members = (await db.prepare('SELECT student_id FROM class_memberships WHERE class_id = ?').all(access.row.class_id)).map((r) => r.student_id);
      await createNotifications(db, members, { title: 'سؤال جدید منتشر شد', message: `سؤال «${payload.title}» در جلسهٔ «${access.row.title}» منتشر شد.`, type: 'problem', targetPath: '/my-class' });
    }
    res.status(201).json({ problem: await publicProblem(db, await db.prepare('SELECT * FROM problems WHERE id = ?').get(id)) });
  });
  app.patch('/api/teacher/problems/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await getProblemAccess(db, req.user, req.params.id, clockNow());
    if (!access.row) return res.status(404).json({ error: 'سؤال پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این سؤال متعلق به حساب تو نیست.' });
    const payload = validateProblemPayload({
      title: req.body?.title ?? access.row.title,
      statement: req.body?.statement ?? access.row.statement,
      inputFormat: req.body?.inputFormat ?? access.row.input_format,
      outputFormat: req.body?.outputFormat ?? access.row.output_format,
      points: req.body?.points ?? access.row.points,
      attemptLimit: req.body?.attemptLimit ?? access.row.attempt_limit ?? 0,
      timeLimitMs: req.body?.timeLimitMs ?? access.row.time_limit_ms,
      comparison: req.body?.comparison ?? access.row.comparison,
      published: req.body?.published ?? Boolean(access.row.published),
      tests: req.body?.tests,
    }, { testsOptional: req.body?.tests === undefined });
    if (payload.error) return res.status(400).json({ error: payload.error });
    let normalized = null;
    if (req.body?.tests !== undefined) {
      normalized = normalizeTests(payload.tests);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
    }
    const trx = db.transaction(async () => {
      await db.prepare(`UPDATE problems SET title = ?, statement = ?, input_format = ?, output_format = ?, points = ?, attempt_limit = ?, time_limit_ms = ?, comparison = ?, published = ?, updated_at = ? WHERE id = ?`)
        .run(payload.title, payload.statement, payload.inputFormat, payload.outputFormat, payload.points, payload.attemptLimit, payload.timeLimitMs, payload.comparison, payload.published ? 1 : 0, nowIso(), access.row.id);
      if (normalized) {
        await db.prepare('DELETE FROM test_cases WHERE problem_id = ?').run(access.row.id);
        await insertTests(db, access.row.id, normalized.tests);
      }
      const bankTests = normalized ? normalized.tests : (await db.prepare('SELECT input_text AS input, expected_output AS output, hidden, position FROM test_cases WHERE problem_id=? ORDER BY position').all(access.row.id)).map((test) => ({ input:test.input, output:test.output, hidden:Boolean(test.hidden), position:test.position }));
      await updateOriginBankQuestion(db, access.row.id, req.user.id, payload, bankTests, nowIso());
    });
    await trx();
    await audit(req, payload.published ? 'publish_problem' : 'update_problem', 'problem', access.row.id, payload.title);
    if (payload.published && !access.row.published) {
      const session = await db.prepare('SELECT s.id, s.title, s.class_id FROM class_sessions s JOIN problems p ON p.session_id=s.id WHERE p.id=?').get(access.row.id);
      const members = (await db.prepare('SELECT student_id FROM class_memberships WHERE class_id = ?').all(session.class_id)).map((r) => r.student_id);
      await createNotifications(db, members, { title: 'سؤال جدید منتشر شد', message: `سؤال «${payload.title}» در جلسهٔ «${session.title}» منتشر شد.`, type: 'problem', targetPath: '/my-class' });
    }
    res.json({ problem: await publicProblem(db, await db.prepare('SELECT * FROM problems WHERE id = ?').get(access.row.id)) });
  });

  app.delete('/api/teacher/problems/:id', auth, requireRole('teacher'), async (req, res) => {
    const access = await getProblemAccess(db, req.user, req.params.id, clockNow());
    if (!access.row) return res.status(404).json({ error: 'سؤال پیدا نشد.' });
    if (!access.allowed) return res.status(403).json({ error: 'این سؤال متعلق به حساب تو نیست.' });
    const activeContest = await db.prepare(`SELECT c.title FROM contest_problems cp JOIN contests c ON c.id=cp.contest_id WHERE cp.problem_id=? AND c.start_at<=? AND c.end_at>? LIMIT 1`)
      .get(access.row.id, new Date(clockNow()).toISOString(), new Date(clockNow()).toISOString());
    if (activeContest) return res.status(409).json({ error: `این سؤال در مسابقهٔ «${activeContest.title}» در حال استفاده است و تا پایان مسابقه قابل حذف نیست.` });
    const counts = await db.prepare('SELECT (SELECT COUNT(*) FROM submissions WHERE problem_id=?) AS submissions,(SELECT COUNT(*) FROM test_cases WHERE problem_id=?) AS tests').get(access.row.id, access.row.id);
    const title = access.row.title;
    const tx = db.transaction(async () => await db.prepare('DELETE FROM problems WHERE id=?').run(access.row.id));
    await tx(); await audit(req, 'delete_problem', 'problem', access.row.id, `title=${title}; submissions=${counts.submissions}; tests=${counts.tests}`);
    res.json({ ok: true, deletedSubmissions: counts.submissions, deletedTests: counts.tests });
  });

  // Teacher contest management: contests are class-scoped and reserve selected published problems.
  app.get('/api/teacher/classes/:classId/contest-problems', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.classId);
    if (!access.row || !access.allowed) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    const problems = await db.prepare(`SELECT p.id, p.title, p.points, s.id AS session_id, s.title AS session_title
      FROM problems p JOIN class_sessions s ON s.id=p.session_id WHERE s.class_id=? AND s.active=1 AND p.published=1
      ORDER BY s.created_at DESC,p.position`).all(access.row.id);
    res.json({ problems: problems.map((p) => ({ id: p.id, title: p.title, points: p.points, sessionId: p.session_id, sessionTitle: p.session_title })) });
  });
  app.get('/api/teacher/classes/:classId/contests', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.classId);
    if (!access.row || !access.allowed) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    const contests = await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM contest_problems p WHERE p.contest_id=c.id) AS problem_count,
      (SELECT COUNT(*) FROM contest_participants cp WHERE cp.contest_id=c.id) AS participant_count
      FROM contests c WHERE c.class_id=? ORDER BY c.start_at DESC`).all(access.row.id);
    res.json({ contests: contests.map((c) => ({ id:c.id,title:c.title,description:c.description,startAt:c.start_at,endAt:c.end_at,penaltyMinutes:c.penalty_minutes,problemCount:c.problem_count,participantCount:c.participant_count,status:contestStatus(c,clockNow()) })) });
  });
  app.post('/api/teacher/classes/:classId/contests', auth, requireRole('teacher'), async (req, res) => {
    const access = await classAccess(db, req.user, req.params.classId);
    if (!access.row || !access.allowed) return res.status(404).json({ error: 'کلاس پیدا نشد.' });
    const title = cleanString(req.body?.title,120); const description = cleanString(req.body?.description,2000);
    const startDate = cleanString(req.body?.startJalaliDate, 10).replace(/-/g, '/');
    const endDate = cleanString(req.body?.endJalaliDate, 10).replace(/-/g, '/');
    const startTime = cleanString(req.body?.startTime, 5);
    const endTime = cleanString(req.body?.endTime, 5);
    const startStamp = startDate && validJalaliDate(startDate) ? jalaliDateTimeToTehranEpoch(startDate, startTime) : NaN;
    const endStamp = endDate && validJalaliDate(endDate) ? jalaliDateTimeToTehranEpoch(endDate, endTime) : NaN;
    const startAt = Number.isFinite(startStamp) ? new Date(startStamp).toISOString() : '';
    const endAt = Number.isFinite(endStamp) ? new Date(endStamp).toISOString() : '';
    const penaltyMinutes = Number(req.body?.penaltyMinutes ?? 0);
    const problemIds = Array.isArray(req.body?.problemIds) ? [...new Set(req.body.problemIds.map((x)=>cleanString(x,80)).filter(Boolean))] : [];
    if (!title) return res.status(400).json({error:'عنوان مسابقه الزامی است.'});
    if (!startAt || !endAt || Date.parse(startAt)>=Date.parse(endAt)) return res.status(400).json({error:'تاریخ شمسی و ساعت شروع و پایان مسابقه معتبر نیست؛ زمان پایان باید بعد از شروع باشد.'});
    if (!Number.isInteger(penaltyMinutes) || penaltyMinutes<0 || penaltyMinutes>120) return res.status(400).json({error:'جریمهٔ زمانی باید بین 0 تا 120 دقیقه باشد.'});
    if (problemIds.length<1 || problemIds.length>30) return res.status(400).json({error:'برای مسابقه بین 1 تا 30 سؤال انتخاب کن.'});
    const placeholders=problemIds.map(()=>'?').join(',');
    const selected=await db.prepare(`SELECT p.id FROM problems p JOIN class_sessions s ON s.id=p.session_id WHERE s.class_id=? AND s.active=1 AND p.published=1 AND p.id IN (${placeholders})`).all(access.row.id,...problemIds);
    if (selected.length!==problemIds.length) return res.status(400).json({error:'همهٔ سؤال‌ها باید منتشرشده و متعلق به همین کلاس باشند.'});
    const overlap=await db.prepare(`SELECT p.id FROM contest_problems cp JOIN contests c ON c.id=cp.contest_id JOIN problems p ON p.id=cp.problem_id
      WHERE cp.problem_id IN (${placeholders}) AND c.start_at < ? AND c.end_at > ? LIMIT 1`).get(...problemIds,endAt,startAt);
    if (overlap) return res.status(409).json({error:'یکی از سؤال‌های انتخابی در بازهٔ زمانی مسابقهٔ دیگری رزرو شده است.'});
    const id=createId(); const stamp=nowIso();
    const members=(await db.prepare('SELECT student_id FROM class_memberships WHERE class_id=?').all(access.row.id)).map((r)=>r.student_id);
    const tx=db.transaction(async ()=>{
      // Recheck inside a serializable PostgreSQL transaction. This closes the race where
      // two teachers submit overlapping contest reservations simultaneously.
      const conflict=await db.prepare(`SELECT 1 FROM contest_problems cp JOIN contests c ON c.id=cp.contest_id
        WHERE cp.problem_id IN (${placeholders}) AND c.start_at < ? AND c.end_at > ? LIMIT 1`).get(...problemIds,endAt,startAt);
      if(conflict)return false;
      await db.prepare('INSERT INTO contests(id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,access.row.id,title,description,startAt,endAt,penaltyMinutes,req.user.id,stamp,stamp);
      const add=db.prepare('INSERT INTO contest_problems(contest_id,problem_id,position) VALUES(?,?,?)');
      for (const [index, problemId] of problemIds.entries()) await add.run(id,problemId,index);
      const invite=db.prepare('INSERT INTO contest_participants(contest_id,student_id,invited_by,invited_at) VALUES(?,?,?,?) ON CONFLICT (contest_id,student_id) DO NOTHING');
      for (const studentId of members) await invite.run(id,studentId,req.user.id,stamp);
      return true;
    });
    if(!await tx())return res.status(409).json({error:'یکی از سؤال‌های انتخابی هم‌زمان در مسابقهٔ دیگری رزرو شده است.'});
    await createNotifications(db,members,{title:'مسابقهٔ جدید برنامه‌نویسی',message:`مسابقهٔ «${title}» برای شما برنامه‌ریزی شد.`,type:'contest',targetPath:'/contests'});
    await audit(req,'create_contest','contest',id,`class=${access.row.id}; problems=${problemIds.length}`);
    res.status(201).json({contest:{id,title,description,startAt,endAt,penaltyMinutes,problemCount:problemIds.length,status:contestStatus({start_at:startAt,end_at:endAt},clockNow())}});
  });
  app.get('/api/teacher/contests/:id', auth, requireRole('teacher'), async (req,res)=>{
    const contest=await db.prepare(`SELECT c.*,cl.title AS class_title,u.display_name AS creator_name FROM contests c LEFT JOIN teacher_classes cl ON cl.id=c.class_id JOIN users u ON u.id=c.created_by WHERE c.id=? AND c.created_by=?`).get(req.params.id,req.user.id);
    if(!contest)return res.status(404).json({error:'مسابقه پیدا نشد.'});
    const problems=await db.prepare(`SELECT p.id,p.title,p.points FROM contest_problems cp JOIN problems p ON p.id=cp.problem_id WHERE cp.contest_id=? ORDER BY cp.position`).all(contest.id);
    const participants=await db.prepare(`SELECT u.id AS studentId,u.username,u.display_name AS displayName,c.title AS classTitle FROM contest_participants cp JOIN users u ON u.id=cp.student_id LEFT JOIN class_memberships m ON m.student_id=u.id LEFT JOIN teacher_classes c ON c.id=m.class_id WHERE cp.contest_id=? ORDER BY u.display_name`).all(contest.id);
    const autoFreezeAt=Number(contest.freeze_minutes||0)>0?Date.parse(contest.end_at)-Number(contest.freeze_minutes)*60000:Infinity;
    const contestState=contestStatus(contest,clockNow());
    const effectiveFreeze=contestState==='active'&&Boolean(contest.scoreboard_frozen||clockNow()>=autoFreezeAt);
    const effectiveFreezeAt=effectiveFreeze?(contest.scoreboard_frozen_at||(Number.isFinite(autoFreezeAt)?new Date(autoFreezeAt).toISOString():null)):null;
    res.json({contest:{id:contest.id,classId:contest.class_id,classTitle:contest.class_title,creatorName:contest.creator_name,title:contest.title,description:contest.description,startAt:contest.start_at,endAt:contest.end_at,penaltyMinutes:contest.penalty_minutes,freezeMinutes:Number(contest.freeze_minutes||0),scoreboardFrozen:Boolean(contest.scoreboard_frozen),studentScoreboardFrozen:effectiveFreeze,scoreboardFrozenAt:contest.scoreboard_frozen_at,studentScoreboardFrozenAt:effectiveFreezeAt,status:contestState},problems,participants,leaderboard:await contestLeaderboard(db,contest.id)});
  });
  app.patch('/api/teacher/contests/:id', auth, requireRole('teacher'), async (req,res)=>{
    const contest=await db.prepare('SELECT * FROM contests WHERE id=? AND created_by=?').get(req.params.id,req.user.id);
    if(!contest)return res.status(404).json({error:'مسابقه پیدا نشد.'});
    const status=contestStatus(contest,clockNow());
    const title=cleanString(req.body?.title??contest.title,120);const description=cleanString(req.body?.description??contest.description,2000);
    const freezeMinutes=Number(req.body?.freezeMinutes??contest.freeze_minutes??0);
    if(!title||!Number.isInteger(freezeMinutes)||freezeMinutes<0||freezeMinutes>180)return res.status(400).json({error:'عنوان یا زمان فریز معتبر نیست.'});
    let startAt=contest.start_at,endAt=contest.end_at;
    if(freezeMinutes>0&&freezeMinutes*60000>=Date.parse(endAt)-Date.parse(startAt))return res.status(400).json({error:'مدت فریز خودکار باید از طول مسابقه کمتر باشد.'});
    if(status==='scheduled'&&(req.body?.startAt||req.body?.endAt)){
      startAt=cleanString(req.body?.startAt??contest.start_at,40);endAt=cleanString(req.body?.endAt??contest.end_at,40);
      if(!Number.isFinite(Date.parse(startAt))||!Number.isFinite(Date.parse(endAt))||Date.parse(startAt)>=Date.parse(endAt))return res.status(400).json({error:'زمان‌بندی جدید معتبر نیست.'});
    }else if(status==='active'&&req.body?.endAt){
      endAt=cleanString(req.body.endAt,40);
      if(!Number.isFinite(Date.parse(endAt))||Date.parse(endAt)<=clockNow()||Date.parse(endAt)<Date.parse(contest.end_at))return res.status(400).json({error:'در مسابقهٔ فعال فقط می‌توان زمان پایان را تمدید کرد.'});
    }
    if(freezeMinutes>0&&freezeMinutes*60000>=Date.parse(endAt)-Date.parse(startAt))return res.status(400).json({error:'مدت فریز خودکار باید از طول مسابقه کمتر باشد.'});
        const addIds=Array.isArray(req.body?.addStudentIds)?[...new Set(req.body.addStudentIds.map(v=>cleanString(v,80)).filter(Boolean))]:[];
    const removeIds=Array.isArray(req.body?.removeStudentIds)?[...new Set(req.body.removeStudentIds.map(v=>cleanString(v,80)).filter(Boolean))]:[];
    if((addIds.length||removeIds.length)&&status!=='scheduled')return res.status(409).json({error:'فهرست دعوت‌شدگان فقط پیش از شروع مسابقه قابل تغییر است.'});
    if(addIds.length){const valid=await db.prepare(`SELECT id FROM users WHERE role='student' AND active=1 AND id IN (${addIds.map(()=>'?').join(',')})`).all(...addIds);if(valid.length!==addIds.length)return res.status(400).json({error:'یکی از دانش‌آموزان جدید معتبر نیست.'});}
    if(req.body?.frozen===true&&status!=='active')return res.status(409).json({error:'فریز دستی جدول فقط هنگام برگزاری مسابقه مجاز است؛ برای فریز پایانی، زمان فریز خودکار را تنظیم کن.'});
    const manualFreeze=req.body?.frozen===undefined?Boolean(contest.scoreboard_frozen):Boolean(req.body.frozen);
    const frozenAt=manualFreeze?(contest.scoreboard_frozen_at||new Date(clockNow()).toISOString()):null;
    const stamp=nowIso();
    const saved=await db.transaction(async ()=>{
      const conflict=await db.prepare(`SELECT 1 FROM contest_problems own
        JOIN contest_problems other_problem ON other_problem.problem_id=own.problem_id
        JOIN contests other ON other.id=other_problem.contest_id
        WHERE own.contest_id=? AND other.id<>? AND other.start_at < ? AND other.end_at > ? LIMIT 1`)
        .get(contest.id,contest.id,endAt,startAt);
      if(conflict)return false;
      await db.prepare('UPDATE contests SET title=?,description=?,start_at=?,end_at=?,freeze_minutes=?,scoreboard_frozen=?,scoreboard_frozen_at=?,updated_at=? WHERE id=?')
        .run(title,description,startAt,endAt,freezeMinutes,manualFreeze?1:0,frozenAt,stamp,contest.id);
      if(addIds.length){const insert=db.prepare('INSERT INTO contest_participants(contest_id,student_id,invited_by,invited_at) VALUES(?,?,?,?) ON CONFLICT (contest_id,student_id) DO NOTHING');for(const studentId of addIds)await insert.run(contest.id,studentId,req.user.id,stamp);}
      if(removeIds.length){const placeholders=removeIds.map(()=>'?').join(',');await db.prepare(`DELETE FROM contest_participants WHERE contest_id=? AND student_id IN (${placeholders})`).run(contest.id,...removeIds);}
      return true;
    })();
    if(!saved)return res.status(409).json({error:'زمان‌بندی جدید با مسابقهٔ دیگری که از همین سؤال استفاده می‌کند تداخل دارد.'});
    if(addIds.length)await createNotifications(db,addIds,{title:'دعوت به مسابقهٔ برنامه‌نویسی',message:`به مسابقهٔ «${title}» دعوت شده‌ای.`,type:'contest',targetPath:'/contests'});
    await audit(req,'manage_contest','contest',contest.id,`added=${addIds.length}; removed=${removeIds.length}; frozen=${manualFreeze}`);
    res.json({ok:true,contest:{id:contest.id,title,description,startAt,endAt,freezeMinutes,scoreboardFrozen:manualFreeze,status:contestStatus({start_at:startAt,end_at:endAt},clockNow())}});
  });
  app.delete('/api/teacher/contests/:id', auth, requireRole('teacher'), async (req,res)=>{
    const contest=await db.prepare('SELECT c.* FROM contests c WHERE c.id=? AND c.created_by=?').get(req.params.id,req.user.id);
    if(!contest)return res.status(404).json({error:'مسابقه پیدا نشد.'});
    if(contestStatus(contest,clockNow())==='active')return res.status(409).json({error:'مسابقهٔ در حال برگزاری قابل حذف نیست.'});
    const backingSession=await db.prepare(`SELECT DISTINCT s.id,s.is_contest FROM contest_problems cp JOIN problems p ON p.id=cp.problem_id JOIN class_sessions s ON s.id=p.session_id WHERE cp.contest_id=? AND s.is_contest=1`).get(contest.id);
    await db.transaction(async ()=>{
      await db.prepare('DELETE FROM contests WHERE id=?').run(contest.id);
      if(backingSession){
        const hasSubmissions=await db.prepare('SELECT 1 FROM submissions a JOIN problems p ON p.id=a.problem_id WHERE p.session_id=? LIMIT 1').get(backingSession.id);
        if(!hasSubmissions)await db.prepare('DELETE FROM class_sessions WHERE id=? AND is_contest=1').run(backingSession.id);
      }
    })();
    await audit(req,'delete_contest','contest',contest.id,contest.title); res.json({ok:true});
  });
  app.get('/api/student/contests', auth, requireRole('student'), async (req,res)=>{
    const contests=await db.prepare(`SELECT c.*,u.display_name AS creator_name,cl.title AS class_title,
      (SELECT COUNT(*) FROM contest_problems cp2 WHERE cp2.contest_id=c.id) AS problem_count
      FROM contest_participants cp JOIN contests c ON c.id=cp.contest_id JOIN users u ON u.id=c.created_by
      LEFT JOIN teacher_classes cl ON cl.id=c.class_id WHERE cp.student_id=? ORDER BY c.start_at DESC`).all(req.user.id);
    res.json({contests:contests.map(c=>({id:c.id,title:c.title,description:c.description,classTitle:c.class_title||'',teacherName:c.creator_name,startAt:c.start_at,endAt:c.end_at,freezeMinutes:Number(c.freeze_minutes||0),problemCount:Number(c.problem_count||0),status:contestStatus(c,clockNow())}))});
  });
  app.get('/api/student/contests/:id', auth, requireRole('student'), async (req,res)=>{
    const contest=await db.prepare(`SELECT c.*,u.display_name AS creator_name,cl.title AS class_title FROM contest_participants cp JOIN contests c ON c.id=cp.contest_id JOIN users u ON u.id=c.created_by LEFT JOIN teacher_classes cl ON cl.id=c.class_id WHERE cp.student_id=? AND c.id=?`).get(req.user.id,req.params.id);
    if(!contest)return res.status(404).json({error:'مسابقه پیدا نشد یا به این مسابقه دعوت نشده‌ای.'});
    const status=contestStatus(contest,clockNow());
    const problems=status==='active'?await db.prepare(`SELECT p.id,p.title,p.statement,p.input_format AS inputFormat,p.output_format AS outputFormat,p.points,p.time_limit_ms AS timeLimitMs
      FROM contest_problems cp JOIN problems p ON p.id=cp.problem_id WHERE cp.contest_id=? ORDER BY cp.position`).all(contest.id):[];
    const autoFreezeAt=contest.freeze_minutes>0?Date.parse(contest.end_at)-Number(contest.freeze_minutes)*60000:Infinity;
    // Freeze only the live board while the contest is active. Once it ends,
    // participants receive the final, fully updated ranking.
    const activeFreezeCutoff= status==='active' && Number.isFinite(autoFreezeAt) && clockNow()>=autoFreezeAt;
    const frozen=status==='active' && Boolean(contest.scoreboard_frozen||activeFreezeCutoff);
    const cutoffIso=status==='active'?(contest.scoreboard_frozen_at||(activeFreezeCutoff?new Date(autoFreezeAt).toISOString():null)):null;
    res.json({contest:{id:contest.id,title:contest.title,description:contest.description,classTitle:contest.class_title||'',teacherName:contest.creator_name,startAt:contest.start_at,endAt:contest.end_at,penaltyMinutes:contest.penalty_minutes,status,scoreboardFrozen:frozen,freezeMinutes:Number(contest.freeze_minutes||0)},problems,leaderboard:await contestLeaderboard(db,contest.id,frozen?cutoffIso:null)});
  });

  // Independent teacher contests. Questions are snapshotted from the shared bank,
  // and invitees are selected from every active student account regardless of class.
  app.get('/api/teacher/contest-bank-questions', auth, requireRole('teacher'), async (req,res)=>{
    const rows=await db.prepare(`SELECT q.*,u.id AS author_id,u.display_name AS author_name,u.username AS author_username
      FROM question_bank q JOIN users u ON u.id=q.teacher_id ORDER BY q.updated_at DESC,q.created_at DESC`).all();
    res.json({questions:await Promise.all(rows.map((row)=>questionBankRecord(db,row)))});
  });
  app.get('/api/teacher/contest-students', auth, requireRole('teacher'), async (req,res)=>{
    const students=await db.prepare(`SELECT u.id,u.username,u.display_name AS displayName,c.title AS classTitle,cu.display_name AS classTeacherName
      FROM users u LEFT JOIN class_memberships m ON m.student_id=u.id LEFT JOIN teacher_classes c ON c.id=m.class_id
      LEFT JOIN users cu ON cu.id=c.teacher_id WHERE u.role='student' AND u.active=1 ORDER BY u.display_name,u.username`).all();
    res.json({students});
  });
  app.get('/api/teacher/contests', auth, requireRole('teacher'), async (req,res)=>{
    const rows=await db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM contest_problems cp WHERE cp.contest_id=c.id) AS problem_count,
      (SELECT COUNT(*) FROM contest_participants p WHERE p.contest_id=c.id) AS participant_count
      FROM contests c WHERE c.created_by=? ORDER BY c.start_at DESC,c.created_at DESC`).all(req.user.id);
    res.json({contests:rows.map((c)=>({id:c.id,title:c.title,description:c.description,startAt:c.start_at,endAt:c.end_at,penaltyMinutes:c.penalty_minutes,problemCount:c.problem_count,participantCount:c.participant_count,freezeMinutes:Number(c.freeze_minutes||0),scoreboardFrozen:Boolean(c.scoreboard_frozen),status:contestStatus(c,clockNow())}))});
  });
  app.post('/api/teacher/contests', auth, requireRole('teacher'), async (req,res)=>{
    const title=cleanString(req.body?.title,120);const description=cleanString(req.body?.description,2000);
    const startDate=cleanString(req.body?.startJalaliDate,10).replace(/-/g,'/');const endDate=cleanString(req.body?.endJalaliDate,10).replace(/-/g,'/');
    const startTime=cleanString(req.body?.startTime,5);const endTime=cleanString(req.body?.endTime,5);
    const startStamp=startDate&&validJalaliDate(startDate)&&validTime(startTime)?jalaliDateTimeToTehranEpoch(startDate,startTime):NaN;
    const endStamp=endDate&&validJalaliDate(endDate)&&validTime(endTime)?jalaliDateTimeToTehranEpoch(endDate,endTime):NaN;
    const startAt=Number.isFinite(startStamp)?new Date(startStamp).toISOString():'';const endAt=Number.isFinite(endStamp)?new Date(endStamp).toISOString():'';
    const penaltyMinutes=Number(req.body?.penaltyMinutes??0);
    const freezeMinutes=Number(req.body?.freezeMinutes??0);
    const bankQuestionIds=Array.isArray(req.body?.bankQuestionIds)?[...new Set(req.body.bankQuestionIds.map((x)=>cleanString(x,80)).filter(Boolean))]:[];
    const studentIds=Array.isArray(req.body?.studentIds)?[...new Set(req.body.studentIds.map((x)=>cleanString(x,80)).filter(Boolean))]:[];
    if(!title)return res.status(400).json({error:'عنوان مسابقه الزامی است.'});
    if(!startAt||!endAt||Date.parse(startAt)>=Date.parse(endAt))return res.status(400).json({error:'تاریخ شمسی و ساعت شروع و پایان مسابقه معتبر نیست؛ زمان پایان باید بعد از شروع باشد.'});
    if(!Number.isInteger(penaltyMinutes)||penaltyMinutes<0||penaltyMinutes>120)return res.status(400).json({error:'جریمهٔ زمانی باید بین 0 تا 120 دقیقه باشد.'});
    if(!Number.isInteger(freezeMinutes)||freezeMinutes<0||freezeMinutes>180)return res.status(400).json({error:'فریز خودکار باید بین صفر تا ۱۸۰ دقیقه باشد.'});
    if(freezeMinutes>0&&freezeMinutes*60000>=endStamp-startStamp)return res.status(400).json({error:'مدت فریز خودکار باید از طول مسابقه کمتر باشد.'});
    if(bankQuestionIds.length<1||bankQuestionIds.length>30)return res.status(400).json({error:'برای مسابقه بین 1 تا 30 سؤال از بانک مشترک انتخاب کن.'});
    if(studentIds.length<1||studentIds.length>1000)return res.status(400).json({error:'حداقل یک و حداکثر 1000 دانش‌آموز را به مسابقه دعوت کن.'});
    const questionPlaceholders=bankQuestionIds.map(()=>'?').join(',');
    const bankRows=await db.prepare(`SELECT * FROM question_bank WHERE id IN (${questionPlaceholders})`).all(...bankQuestionIds);
    if(bankRows.length!==bankQuestionIds.length)return res.status(400).json({error:'یکی از سؤال‌های انتخابی دیگر در بانک مشترک وجود ندارد.'});
    const studentPlaceholders=studentIds.map(()=>'?').join(',');
    const students=await db.prepare(`SELECT id FROM users WHERE role='student' AND active=1 AND id IN (${studentPlaceholders})`).all(...studentIds);
    if(students.length!==studentIds.length)return res.status(400).json({error:'یکی از دانش‌آموزان انتخابی غیرفعال است یا حساب دانش‌آموزی ندارد.'});
    const questionSnapshots=await Promise.all(bankRows.map(async (bank)=>{
      const tests=(await db.prepare('SELECT input_text AS input,expected_output AS output,hidden FROM question_bank_tests WHERE bank_question_id=? ORDER BY position').all(bank.id)).map((t)=>({input:t.input,output:t.output,hidden:Boolean(t.hidden)}));
      const normalized=normalizeTests(tests);
      return {bank,tests:normalized.tests,error:normalized.error};
    }));
    const invalidQuestion=questionSnapshots.find((item)=>item.error);
    if(invalidQuestion)return res.status(409).json({error:`تست‌های سؤال «${invalidQuestion.bank.title}» معتبر نیستند؛ ابتدا آن را در بانک اصلاح کن.`});
    const id=createId();const sessionId=createId();const stamp=nowIso();
    const tx=db.transaction(async ()=>{
      await db.prepare('INSERT INTO contests(id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at,freeze_minutes) VALUES(?,NULL,?,?,?,?,?,?,?,?,?)')
        .run(id,title,description,startAt,endAt,penaltyMinutes,req.user.id,stamp,stamp,freezeMinutes);
      await db.prepare(`INSERT INTO class_sessions(id,class_id,jalali_date,start_time,end_time,title,description,active,created_by,created_at,updated_at,is_contest)
        VALUES(?,NULL,NULL,NULL,NULL,?,?,1,?,?,?,1)`).run(sessionId,`مسابقه: ${title}`,description,req.user.id,stamp,stamp);
      const addProblem=db.prepare(`INSERT INTO problems(id,session_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,published,position,created_at,updated_at,source_bank_id,language_mode,default_language,cpp_standard,cpp_optimization)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`);
      const addContestProblem=db.prepare('INSERT INTO contest_problems(contest_id,problem_id,position) VALUES(?,?,?)');
      const addParticipant=db.prepare('INSERT INTO contest_participants(contest_id,student_id,invited_by,invited_at) VALUES(?,?,?,?)');
      for (const [index, {bank,tests}] of questionSnapshots.entries()) {
        const problemId=createId();
        await addProblem.run(problemId,sessionId,bank.title,bank.statement,bank.input_format,bank.output_format,bank.points,bank.attempt_limit,bank.time_limit_ms,bank.comparison,index,stamp,stamp,bank.id,bank.language_mode||'python',bank.default_language||'python',bank.cpp_standard||'17',bank.cpp_optimization||'O2');
        await insertTests(db,problemId,tests);
        await addContestProblem.run(id,problemId,index);
      }
      for (const studentId of studentIds) await addParticipant.run(id,studentId,req.user.id,stamp);
    });
    await tx();
    await createNotifications(db,studentIds,{title:'دعوت به مسابقهٔ برنامه‌نویسی',message:`به مسابقهٔ «${title}» دعوت شده‌ای.`,type:'contest',targetPath:'/contests'});
    await audit(req,'create_independent_contest','contest',id,`questions=${bankQuestionIds.length}; participants=${studentIds.length}`);
    res.status(201).json({contest:{id,title,description,startAt,endAt,penaltyMinutes,problemCount:bankQuestionIds.length,participantCount:studentIds.length,status:contestStatus({start_at:startAt,end_at:endAt},clockNow())}});
  });

  // Assignment/homework APIs. Assignments snapshot shared-bank problems and their test data;
  // their roster is fixed at publication time and is independent of later class transfers.
  app.get('/api/teacher/assignments', auth, requireRole('teacher'), async (req,res)=>{
    const rows=await db.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM assignment_participants ap WHERE ap.assignment_id=a.id) AS participant_count,
      (SELECT COUNT(*) FROM (SELECT s.student_id FROM assignment_submissions ass JOIN submissions s ON s.id=ass.submission_id
        JOIN (SELECT assignment_id,COUNT(*) AS problem_count FROM assignment_problems GROUP BY assignment_id) pc ON pc.assignment_id=ass.assignment_id
        WHERE ass.assignment_id=a.id AND s.ai_flagged=0 GROUP BY s.student_id,pc.problem_count HAVING COUNT(DISTINCT s.problem_id)>=pc.problem_count)) AS submitted_count,
      (SELECT COUNT(*) FROM assignment_submissions ass JOIN submissions s ON s.id=ass.submission_id WHERE ass.assignment_id=a.id AND ass.is_late=1 AND s.ai_flagged=0) AS late_submission_count,
      (SELECT COUNT(*) FROM assignment_problems p WHERE p.assignment_id=a.id) AS problem_count
      FROM assignments a WHERE a.teacher_id=? ORDER BY a.due_at DESC,a.created_at DESC`).all(req.user.id);
    res.json({assignments:rows.map(a=>({id:a.id,title:a.title,description:a.description,startAt:a.start_at,dueAt:a.due_at,allowLate:Boolean(a.allow_late),latePenaltyPercent:a.late_penalty_percent,status:a.status,participantCount:a.participant_count,submittedCount:a.submitted_count,lateSubmissionCount:a.late_submission_count,problemCount:a.problem_count}))});
  });
  app.post('/api/teacher/assignments', auth, requireRole('teacher'), async (req,res)=>{
    const title=cleanString(req.body?.title,160); const description=cleanString(req.body?.description,3000);
    const startAt=cleanString(req.body?.startAt,40); const dueAt=cleanString(req.body?.dueAt,40);
    const allowLate=Boolean(req.body?.allowLate); const latePenaltyPercent=Number(req.body?.latePenaltyPercent??0);
    const classIds=Array.isArray(req.body?.classIds)?[...new Set(req.body.classIds.map(v=>cleanString(v,80)).filter(Boolean))]:[];
    const explicitStudentIds=Array.isArray(req.body?.studentIds)?[...new Set(req.body.studentIds.map(v=>cleanString(v,80)).filter(Boolean))]:[];
    const bankQuestionIds=Array.isArray(req.body?.bankQuestionIds)?[...new Set(req.body.bankQuestionIds.map(v=>cleanString(v,80)).filter(Boolean))]:[];
    if(!title)return res.status(400).json({error:'عنوان تکلیف الزامی است.'});
    if(!Number.isFinite(Date.parse(startAt))||!Number.isFinite(Date.parse(dueAt))||Date.parse(startAt)>=Date.parse(dueAt))return res.status(400).json({error:'زمان شروع و مهلت تحویل معتبر نیست؛ مهلت باید پس از شروع باشد.'});
    if(!Number.isInteger(latePenaltyPercent)||latePenaltyPercent<0||latePenaltyPercent>100)return res.status(400).json({error:'جریمهٔ دیرکرد باید بین صفر تا ۱۰۰ درصد باشد.'});
    if(!classIds.length&&!explicitStudentIds.length)return res.status(400).json({error:'حداقل یک کلاس یا یک دانش‌آموز برای تکلیف انتخاب کن.'});
    if(classIds.length>50||explicitStudentIds.length>1000||bankQuestionIds.length<1||bankQuestionIds.length>50)return res.status(400).json({error:'تعداد کلاس، دانش‌آموز یا سؤال‌های انتخابی از حد مجاز بیشتر است.'});
    const classes=classIds.length?await db.prepare(`SELECT id,title FROM teacher_classes WHERE teacher_id=? AND id IN (${classIds.map(()=>'?').join(',')})`).all(req.user.id,...classIds):[];
    if(classes.length!==classIds.length)return res.status(403).json({error:'یکی از کلاس‌های انتخابی متعلق به حساب تو نیست.'});
    const participantMap=new Map();
    for(const classRow of classes){
      const members=await db.prepare('SELECT m.student_id,u.active FROM class_memberships m JOIN users u ON u.id=m.student_id WHERE m.class_id=? AND u.role=\'student\'').all(classRow.id);
      for(const member of members)if(member.active)participantMap.set(member.student_id,classRow.id);
    }
    if(explicitStudentIds.length){
      const valid=await db.prepare(`SELECT id FROM users WHERE role='student' AND active=1 AND id IN (${explicitStudentIds.map(()=>'?').join(',')})`).all(...explicitStudentIds);
      if(valid.length!==explicitStudentIds.length)return res.status(400).json({error:'یکی از دانش‌آموزان انتخابی فعال نیست یا حساب دانش‌آموزی ندارد.'});
      for(const student of valid)if(!participantMap.has(student.id))participantMap.set(student.id,null);
    }
    if(!participantMap.size)return res.status(400).json({error:'کلاس‌های انتخابی دانش‌آموز فعالی ندارند.'});
    const bankRows=await db.prepare(`SELECT * FROM question_bank WHERE id IN (${bankQuestionIds.map(()=>'?').join(',')})`).all(...bankQuestionIds);
    if(bankRows.length!==bankQuestionIds.length)return res.status(400).json({error:'یکی از سؤال‌های انتخابی در بانک مشترک پیدا نشد.'});
    const snapshots=await Promise.all(bankRows.map(async bank=>{
      const tests=(await db.prepare('SELECT input_text AS input,expected_output AS output,hidden FROM question_bank_tests WHERE bank_question_id=? ORDER BY position').all(bank.id)).map(t=>({input:t.input,output:t.output,hidden:Boolean(t.hidden)}));
      const normalized=normalizeTests(tests);return {bank,tests:normalized.tests,error:normalized.error};
    }));
    const invalid=snapshots.find(item=>item.error);if(invalid)return res.status(409).json({error:`تست‌های سؤال «${invalid.bank.title}» معتبر نیستند: ${invalid.error}`});
    const id=createId(),sessionId=createId(),stamp=nowIso();
    await db.transaction(async ()=>{
      await db.prepare(`INSERT INTO class_sessions(id,class_id,jalali_date,start_time,end_time,title,description,active,created_by,created_at,updated_at,is_assignment)
        VALUES(?,NULL,NULL,NULL,NULL,?,?,1,?,?,?,1)`).run(sessionId,`تکلیف: ${title}`,description,req.user.id,stamp,stamp);
      await db.prepare(`INSERT INTO assignments(id,session_id,teacher_id,title,description,start_at,due_at,allow_late,late_penalty_percent,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'published',?,?)`).run(id,sessionId,req.user.id,title,description,startAt,dueAt,allowLate?1:0,latePenaltyPercent,stamp,stamp);
      const addProblem=db.prepare(`INSERT INTO problems(id,session_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,published,position,created_at,updated_at,source_bank_id,language_mode,default_language,cpp_standard,cpp_optimization)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`);
      const addAssignmentProblem=db.prepare('INSERT INTO assignment_problems(assignment_id,problem_id,position) VALUES(?,?,?)');
      for(const [index,{bank,tests}] of snapshots.entries()){
        const problemId=createId();
        await addProblem.run(problemId,sessionId,bank.title,bank.statement,bank.input_format,bank.output_format,bank.points,bank.attempt_limit,bank.time_limit_ms,bank.comparison,index,stamp,stamp,bank.id,bank.language_mode||'python',bank.default_language||'python',bank.cpp_standard||'17',bank.cpp_optimization||'O2');
        await insertTests(db,problemId,tests);await addAssignmentProblem.run(id,problemId,index);
      }
      const addParticipant=db.prepare('INSERT INTO assignment_participants(assignment_id,student_id,source_class_id,assigned_at) VALUES(?,?,?,?)');
      for(const [studentId,sourceClassId] of participantMap)await addParticipant.run(id,studentId,sourceClassId,stamp);
    })();
    const participantIds=[...participantMap.keys()];
    await createNotifications(db,participantIds,{title:'تکلیف جدید',message:`تکلیف «${title}» برای شما ثبت شده است. مهلت تحویل: ${new Date(dueAt).toLocaleString('fa-IR',{timeZone:'Asia/Tehran'})}`,type:'assignment',targetPath:'/assignments'});
    await audit(req,'create_assignment','assignment',id,`participants=${participantIds.length}; questions=${snapshots.length}`);
    res.status(201).json({assignment:{id,title,description,startAt,dueAt,allowLate,latePenaltyPercent,participantCount:participantIds.length,problemCount:snapshots.length,status:'published'}});
  });
  app.get('/api/teacher/assignments/:id', auth, requireRole('teacher'), async (req,res)=>{
    const assignment=await db.prepare('SELECT * FROM assignments WHERE id=? AND teacher_id=?').get(req.params.id,req.user.id);
    if(!assignment)return res.status(404).json({error:'تکلیف پیدا نشد.'});
    const problems=await db.prepare(`SELECT p.id,p.title,p.points,p.language_mode AS languageMode,p.default_language AS defaultLanguage,ap.position,
      (SELECT COUNT(*) FROM submissions s WHERE s.problem_id=p.id) AS submissionCount FROM assignment_problems ap JOIN problems p ON p.id=ap.problem_id
      WHERE ap.assignment_id=? ORDER BY ap.position`).all(assignment.id);
    const participants=(await db.prepare(`SELECT u.id AS studentId,u.username,u.display_name AS displayName,ap.source_class_id AS sourceClassId,c.title AS sourceClassTitle,
      COUNT(s.id) AS attemptCount,COUNT(DISTINCT CASE WHEN s.id IS NOT NULL THEN aproblem.problem_id END) AS attemptedProblemCount,
      (SELECT COALESCE(SUM(best_points),0) FROM (SELECT MAX(ss.points_awarded) AS best_points FROM assignment_problems qp
        JOIN submissions ss ON ss.problem_id=qp.problem_id AND ss.student_id=ap.student_id
        WHERE qp.assignment_id=ap.assignment_id AND ss.ai_flagged=0 GROUP BY qp.problem_id)) AS bestPoints,
      (SELECT COUNT(*) FROM assignment_problems qp WHERE qp.assignment_id=ap.assignment_id) AS problemCount,
      MAX(s.created_at) AS lastSubmissionAt,MAX(ass.is_late) AS hasLateSubmission FROM assignment_participants ap JOIN users u ON u.id=ap.student_id
      LEFT JOIN teacher_classes c ON c.id=ap.source_class_id
      LEFT JOIN assignment_problems aproblem ON aproblem.assignment_id=ap.assignment_id
      LEFT JOIN submissions s ON s.student_id=ap.student_id AND s.problem_id=aproblem.problem_id AND s.ai_flagged=0
      LEFT JOIN assignment_submissions ass ON ass.assignment_id=ap.assignment_id AND ass.submission_id=s.id
      WHERE ap.assignment_id=? GROUP BY u.id, u.username, u.display_name, ap.source_class_id, c.title, ap.student_id, ap.assignment_id ORDER BY u.display_name`).all(assignment.id)).map(row=>{
        const attempted=Number(row.attemptCount)>0;const complete=Number(row.problemCount)>0&&Number(row.attemptedProblemCount)>=Number(row.problemCount);const overdue=clockNow()>Date.parse(assignment.due_at);
        const status=attempted?(complete?(Boolean(row.hasLateSubmission)?'late':'submitted'):'in_progress'):(overdue?(assignment.allow_late?'late_allowed':'overdue'):clockNow()<Date.parse(assignment.start_at)?'pending':'in_progress');
        return {...row,attemptCount:Number(row.attemptCount),attemptedProblemCount:Number(row.attemptedProblemCount),problemCount:Number(row.problemCount),bestPoints:Number(row.bestPoints),hasLateSubmission:Boolean(row.hasLateSubmission),status};
      });
    res.json({assignment:{id:assignment.id,title:assignment.title,description:assignment.description,startAt:assignment.start_at,dueAt:assignment.due_at,allowLate:Boolean(assignment.allow_late),latePenaltyPercent:assignment.late_penalty_percent,status:assignment.status,createdAt:assignment.created_at},problems,participants});
  });
  app.patch('/api/teacher/assignments/:id', auth, requireRole('teacher'), async (req,res)=>{
    const assignment=await db.prepare('SELECT * FROM assignments WHERE id=? AND teacher_id=?').get(req.params.id,req.user.id);
    if(!assignment)return res.status(404).json({error:'تکلیف پیدا نشد.'});
    const title=cleanString(req.body?.title??assignment.title,160);const description=cleanString(req.body?.description??assignment.description,3000);
    const dueAt=cleanString(req.body?.dueAt??assignment.due_at,40);const allowLate=req.body?.allowLate===undefined?Boolean(assignment.allow_late):Boolean(req.body.allowLate);
    const latePenaltyPercent=Number(req.body?.latePenaltyPercent??assignment.late_penalty_percent);
    if(!title||!Number.isFinite(Date.parse(dueAt))||Date.parse(dueAt)<=Date.parse(assignment.start_at))return res.status(400).json({error:'عنوان و مهلت جدید معتبر نیست.'});
    if(!Number.isInteger(latePenaltyPercent)||latePenaltyPercent<0||latePenaltyPercent>100)return res.status(400).json({error:'جریمهٔ دیرکرد باید بین صفر تا ۱۰۰ باشد.'});
    const status=req.body?.archived===true?'archived':assignment.status;const stamp=nowIso();
    await db.prepare('UPDATE assignments SET title=?,description=?,due_at=?,allow_late=?,late_penalty_percent=?,status=?,updated_at=? WHERE id=?').run(title,description,dueAt,allowLate?1:0,latePenaltyPercent,status,stamp,assignment.id);
    await audit(req,'update_assignment','assignment',assignment.id,`status=${status}; due=${dueAt}`);
    res.json({ok:true});
  });
  app.get('/api/student/assignments', auth, requireRole('student'), async (req,res)=>{
    const rows=await db.prepare(`SELECT a.*,u.display_name AS teacher_name,
      (SELECT COUNT(*) FROM assignment_problems ap WHERE ap.assignment_id=a.id) AS problem_count,
      (SELECT COUNT(DISTINCT ass.submission_id) FROM assignment_submissions ass JOIN submissions s ON s.id=ass.submission_id WHERE ass.assignment_id=a.id AND s.student_id=? AND s.ai_flagged=0) AS own_attempts,
      (SELECT COUNT(DISTINCT s.problem_id) FROM assignment_submissions ass JOIN submissions s ON s.id=ass.submission_id WHERE ass.assignment_id=a.id AND s.student_id=? AND s.ai_flagged=0) AS own_attempted_problems,
      (SELECT COALESCE(SUM(best_points),0) FROM (SELECT MAX(s.points_awarded) AS best_points FROM assignment_submissions ass JOIN submissions s ON s.id=ass.submission_id WHERE ass.assignment_id=a.id AND s.student_id=? AND s.ai_flagged=0 GROUP BY s.problem_id)) AS own_points
      FROM assignment_participants ap JOIN assignments a ON a.id=ap.assignment_id JOIN users u ON u.id=a.teacher_id
      WHERE ap.student_id=? AND a.status='published' ORDER BY a.due_at DESC`).all(req.user.id,req.user.id,req.user.id,req.user.id);
    res.json({assignments:rows.map(a=>({id:a.id,title:a.title,description:a.description,teacherName:a.teacher_name,startAt:a.start_at,dueAt:a.due_at,allowLate:Boolean(a.allow_late),latePenaltyPercent:a.late_penalty_percent,problemCount:a.problem_count,attempts:a.own_attempts,attemptedProblems:a.own_attempted_problems,points:a.own_points,status:clockNow()<Date.parse(a.start_at)?'scheduled':clockNow()<=Date.parse(a.due_at)?'open':a.allow_late?'late_allowed':'ended'}))});
  });
  app.get('/api/student/assignments/:id', auth, requireRole('student'), async (req,res)=>{
    const assignment=await db.prepare(`SELECT a.*,u.display_name AS teacher_name FROM assignments a JOIN users u ON u.id=a.teacher_id
      JOIN assignment_participants ap ON ap.assignment_id=a.id AND ap.student_id=? WHERE a.id=? AND a.status='published'`).get(req.user.id,req.params.id);
    if(!assignment)return res.status(404).json({error:'تکلیف پیدا نشد یا به تو اختصاص داده نشده است.'});
    if(clockNow()<Date.parse(assignment.start_at))return res.status(403).json({error:'این تکلیف هنوز شروع نشده است.'});
    const problems=(await db.prepare(`SELECT p.id,p.title,p.statement,p.input_format AS inputFormat,p.output_format AS outputFormat,p.points,p.time_limit_ms AS timeLimitMs,
      p.attempt_limit AS attemptLimit,p.language_mode AS languageMode,p.default_language AS defaultLanguage,p.cpp_standard AS cppStandard,p.cpp_optimization AS cppOptimization,
      (SELECT COUNT(*) FROM submissions s WHERE s.student_id=? AND s.problem_id=p.id AND s.ai_flagged=0) AS attemptCount,
      (SELECT MAX(points_awarded) FROM submissions s WHERE s.student_id=? AND s.problem_id=p.id AND s.ai_flagged=0) AS bestPoints,
      (SELECT MAX(CASE WHEN verdict='accepted' THEN 1 ELSE 0 END) FROM submissions s WHERE s.student_id=? AND s.problem_id=p.id AND s.ai_flagged=0) AS accepted,
      COALESCE((SELECT json_agg(json_build_object('input',t.input_text,'output',t.expected_output) ORDER BY t.position) FROM test_cases t WHERE t.problem_id=p.id AND t.hidden=0), '[]'::json) AS samples
      FROM assignment_problems ap JOIN problems p ON p.id=ap.problem_id WHERE ap.assignment_id=? ORDER BY ap.position`).all(req.user.id,req.user.id,req.user.id,assignment.id)).map(p=>({...p,attemptCount:Number(p.attemptCount||0),bestPoints:Number(p.bestPoints||0),accepted:Boolean(p.accepted),samples:Array.isArray(p.samples)?p.samples:(p.samples?JSON.parse(p.samples):[])}));
    res.json({assignment:{id:assignment.id,title:assignment.title,description:assignment.description,teacherName:assignment.teacher_name,startAt:assignment.start_at,dueAt:assignment.due_at,allowLate:Boolean(assignment.allow_late),latePenaltyPercent:assignment.late_penalty_percent,status:clockNow()<Date.parse(assignment.due_at)?'open':assignment.allow_late?'late_allowed':'ended'},problems});
  });

  // Teacher analytics: every requested class and student is checked against teacher-owned data.
  app.get('/api/teacher/reports/classes', auth, requireRole('teacher'), async (req,res)=>{
    const classes=await db.prepare(`SELECT c.id,c.title,(SELECT COUNT(*) FROM class_memberships m WHERE m.class_id=c.id) AS student_count
      FROM teacher_classes c WHERE c.teacher_id=? ORDER BY c.title`).all(req.user.id);
    res.json({classes:classes.map(c=>({id:c.id,title:c.title,studentCount:c.student_count}))});
  });
  app.get('/api/teacher/reports/compare', auth, requireRole('teacher'), async (req,res)=>{
    const ids=[...new Set(String(req.query?.ids||'').split(',').map(v=>cleanString(v,80)).filter(Boolean))];
    if(ids.length<2||ids.length>5)return res.status(400).json({error:'برای مقایسه بین ۲ تا ۵ کلاس انتخاب کن.'});
    const owned=await db.prepare(`SELECT id,title FROM teacher_classes WHERE teacher_id=? AND id IN (${ids.map(()=>'?').join(',')})`).all(req.user.id,...ids);
    if(owned.length!==ids.length)return res.status(403).json({error:'فقط کلاس‌های خودت را می‌توانی مقایسه کنی.'});
    const rows=await Promise.all(owned.map(async c=>{
      const members=(await db.prepare('SELECT student_id FROM class_memberships WHERE class_id=?').all(c.id)).map(r=>r.student_id);
      const sessionStats=await db.prepare(`SELECT COUNT(DISTINCT a.id) AS submissions,COUNT(DISTINCT CASE WHEN a.verdict='accepted' THEN a.id END) AS accepted,
        COUNT(DISTINCT CASE WHEN a.verdict='accepted' THEN a.problem_id END) AS solvedProblems,COALESCE(SUM(a.points_awarded),0) AS points
        FROM class_sessions s JOIN problems p ON p.session_id=s.id LEFT JOIN submissions a ON a.problem_id=p.id AND a.ai_flagged=0 WHERE s.class_id=? AND s.created_by=?`).get(c.id,req.user.id);
      const classPoints=members.length?(await db.prepare(`SELECT COALESCE(SUM(student_points),0) AS total FROM (
        SELECT a.student_id,COALESCE(SUM(best_points),0) AS student_points FROM (
          SELECT s.student_id,s.problem_id,MAX(s.points_awarded) AS best_points FROM submissions s
          JOIN problems p ON p.id=s.problem_id JOIN class_sessions cs ON cs.id=p.session_id
          WHERE cs.class_id=? AND cs.created_by=? AND s.ai_flagged=0 GROUP BY s.student_id,s.problem_id
        ) a GROUP BY a.student_id
      )`).get(c.id,req.user.id)).total:0;
      const assignmentStats=await db.prepare(`SELECT COUNT(DISTINCT s.id) AS attempts,
        COUNT(DISTINCT CASE WHEN s.verdict='accepted' THEN s.id END) AS accepted,
        COUNT(DISTINCT CASE WHEN s.verdict='accepted' THEN a.id || ':' || s.problem_id END) AS solvedProblems,
        COALESCE(SUM(s.points_awarded),0) AS attemptPoints FROM assignment_participants ap
        JOIN assignments a ON a.id=ap.assignment_id JOIN assignment_problems qp ON qp.assignment_id=a.id
        JOIN submissions s ON s.student_id=ap.student_id AND s.problem_id=qp.problem_id
        JOIN assignment_submissions ass ON ass.assignment_id=a.id AND ass.submission_id=s.id
        WHERE ap.source_class_id=? AND a.teacher_id=? AND s.ai_flagged=0`).get(c.id,req.user.id);
      const assignmentBestPoints=(await db.prepare(`SELECT COALESCE(SUM(best_points),0) AS total FROM (
        SELECT ap.student_id,a.id AS assignment_id,s.problem_id,MAX(s.points_awarded) AS best_points
        FROM assignment_participants ap JOIN assignments a ON a.id=ap.assignment_id
        JOIN assignment_problems qp ON qp.assignment_id=a.id
        JOIN assignment_submissions ass ON ass.assignment_id=a.id
        JOIN submissions s ON s.id=ass.submission_id AND s.student_id=ap.student_id AND s.problem_id=qp.problem_id
        WHERE ap.source_class_id=? AND a.teacher_id=? AND s.ai_flagged=0 GROUP BY ap.student_id,a.id,s.problem_id
      )`).get(c.id,req.user.id)).total;
      const activeStudents=Number((await db.prepare(`SELECT COUNT(DISTINCT student_id) AS n FROM (
        SELECT s.student_id FROM class_sessions cs JOIN problems p ON p.session_id=cs.id JOIN submissions s ON s.problem_id=p.id WHERE cs.class_id=? AND cs.created_by=? AND s.ai_flagged=0
        UNION SELECT ap.student_id FROM assignment_participants ap JOIN assignments a ON a.id=ap.assignment_id
        JOIN assignment_submissions ass ON ass.assignment_id=a.id JOIN submissions s ON s.id=ass.submission_id AND s.student_id=ap.student_id AND s.ai_flagged=0
        WHERE ap.source_class_id=? AND a.teacher_id=?
      )`).get(c.id,req.user.id,c.id,req.user.id)).n||0);
      return {id:c.id,title:c.title,studentCount:members.length,submissionCount:Number(sessionStats.submissions)+Number(assignmentStats.attempts),acceptedCount:Number(sessionStats.accepted)+Number(assignmentStats.accepted),solvedProblemCount:Number(sessionStats.solvedProblems)+Number(assignmentStats.solvedProblems),submissionPoints:Number(sessionStats.points)+Number(assignmentStats.attemptPoints),assignmentAttemptCount:Number(assignmentStats.attempts),assignmentAcceptedCount:Number(assignmentStats.accepted),assignmentPoints:Number(assignmentBestPoints||0),averageStudentPoints:members.length?Math.round((Number(classPoints)+Number(assignmentBestPoints||0))/members.length):0,activeStudents};
    }));
    res.json({classes:rows});
  });
  app.get('/api/teacher/reports/students', auth, requireRole('teacher'), async (req,res)=>{
    const students=await db.prepare(`SELECT DISTINCT u.id,u.username,u.display_name AS displayName FROM users u WHERE u.role='student' AND (
      EXISTS(SELECT 1 FROM class_memberships m JOIN teacher_classes c ON c.id=m.class_id WHERE m.student_id=u.id AND c.teacher_id=?) OR
      EXISTS(SELECT 1 FROM submissions a JOIN problems p ON p.id=a.problem_id JOIN class_sessions s ON s.id=p.session_id WHERE a.student_id=u.id AND s.created_by=?) OR
      EXISTS(SELECT 1 FROM assignment_participants ap JOIN assignments a ON a.id=ap.assignment_id WHERE ap.student_id=u.id AND a.teacher_id=?) OR
      EXISTS(SELECT 1 FROM contest_participants cp JOIN contests ct ON ct.id=cp.contest_id WHERE cp.student_id=u.id AND ct.created_by=?) OR
      EXISTS(SELECT 1 FROM contest_submissions cs JOIN submissions sx ON sx.id=cs.submission_id JOIN contests ct ON ct.id=cs.contest_id WHERE sx.student_id=u.id AND ct.created_by=?)) ORDER BY u.display_name`).all(req.user.id,req.user.id,req.user.id,req.user.id,req.user.id);
    res.json({students});
  });
  app.get('/api/teacher/reports/students/:id', auth, requireRole('teacher'), async (req,res)=>{
    const student=await db.prepare(`SELECT u.id,u.username,u.display_name AS displayName FROM users u WHERE u.id=? AND u.role='student' AND (
      EXISTS(SELECT 1 FROM class_memberships m JOIN teacher_classes c ON c.id=m.class_id WHERE m.student_id=u.id AND c.teacher_id=?) OR
      EXISTS(SELECT 1 FROM submissions a JOIN problems p ON p.id=a.problem_id JOIN class_sessions s ON s.id=p.session_id WHERE a.student_id=u.id AND s.created_by=?) OR
      EXISTS(SELECT 1 FROM assignment_participants ap JOIN assignments a ON a.id=ap.assignment_id WHERE ap.student_id=u.id AND a.teacher_id=?) OR
      EXISTS(SELECT 1 FROM contest_participants cp JOIN contests ct ON ct.id=cp.contest_id WHERE cp.student_id=u.id AND ct.created_by=?) OR
      EXISTS(SELECT 1 FROM contest_submissions cs JOIN submissions sx ON sx.id=cs.submission_id JOIN contests ct ON ct.id=cs.contest_id WHERE sx.student_id=u.id AND ct.created_by=?))`).get(req.params.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id);
    if(!student)return res.status(404).json({error:'دانش‌آموز در داده‌های آموزشی تو پیدا نشد.'});
    const submissions=await db.prepare(`SELECT a.id,a.verdict,a.points_awarded AS points,a.ai_flagged AS aiFlagged,a.ai_flag_note AS aiFlagNote,a.passed_cases AS passedCases,a.total_cases AS totalCases,a.runtime_ms AS runtimeMs,a.language,a.created_at AS createdAt,
      p.title AS problemTitle,s.title AS sessionTitle,c.title AS classTitle,
      (SELECT ct.title FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=? LIMIT 1) AS contestTitle,
      (SELECT ax.title FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id AND ax.teacher_id=? LIMIT 1) AS assignmentTitle
      FROM submissions a JOIN problems p ON p.id=a.problem_id JOIN class_sessions s ON s.id=p.session_id LEFT JOIN teacher_classes c ON c.id=s.class_id
      WHERE a.student_id=? AND (s.created_by=? OR EXISTS(SELECT 1 FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=?)
        OR EXISTS(SELECT 1 FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id AND ax.teacher_id=? WHERE ass.submission_id=a.id))
      ORDER BY a.created_at DESC LIMIT 200`).all(req.user.id,req.user.id,student.id,req.user.id,req.user.id,req.user.id);
    const assignmentStats=await db.prepare(`SELECT
      (SELECT COUNT(*) FROM assignment_participants ap JOIN assignments a ON a.id=ap.assignment_id WHERE ap.student_id=? AND a.teacher_id=?) AS assigned,
      (SELECT COUNT(*) FROM (SELECT ass.assignment_id FROM assignment_submissions ass JOIN submissions s ON s.id=ass.submission_id
        JOIN assignments a ON a.id=ass.assignment_id
        JOIN (SELECT assignment_id,COUNT(*) AS problem_count FROM assignment_problems GROUP BY assignment_id) pc ON pc.assignment_id=ass.assignment_id
        WHERE s.student_id=? AND a.teacher_id=? AND s.ai_flagged=0 GROUP BY ass.assignment_id,pc.problem_count
        HAVING COUNT(DISTINCT s.problem_id)>=pc.problem_count)) AS submitted,
      (SELECT COUNT(*) FROM assignment_submissions ass JOIN submissions s ON s.id=ass.submission_id JOIN assignments a ON a.id=ass.assignment_id WHERE s.student_id=? AND a.teacher_id=? AND s.ai_flagged=0 AND ass.is_late=1) AS late`).get(student.id,req.user.id,student.id,req.user.id,student.id,req.user.id);
    const totalRows=await db.prepare(`SELECT COUNT(*) AS submissions,COUNT(CASE WHEN a.verdict='accepted' THEN 1 END) AS accepted,
      COALESCE(SUM(a.passed_cases),0) AS passedCases,COALESCE(SUM(a.total_cases),0) AS totalCases,
      COALESCE(AVG(a.runtime_ms),0) AS averageRuntimeMs FROM submissions a JOIN problems p ON p.id=a.problem_id
      JOIN class_sessions s ON s.id=p.session_id WHERE a.student_id=? AND a.ai_flagged=0 AND (s.created_by=? OR EXISTS(SELECT 1 FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=?)
        OR EXISTS(SELECT 1 FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id AND ax.teacher_id=?))`).get(student.id,req.user.id,req.user.id,req.user.id);
    const bestPoints=(await db.prepare(`SELECT COALESCE(SUM(best_points),0) AS points FROM (
      SELECT MAX(a.points_awarded) AS best_points FROM submissions a JOIN problems p ON p.id=a.problem_id
      JOIN class_sessions s ON s.id=p.session_id WHERE a.student_id=? AND a.ai_flagged=0 AND (s.created_by=? OR EXISTS(SELECT 1 FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=?)
        OR EXISTS(SELECT 1 FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id AND ax.teacher_id=?)) GROUP BY p.id
    )`).get(student.id,req.user.id,req.user.id,req.user.id)).points;
    const totals={submissions:Number(totalRows.submissions),accepted:Number(totalRows.accepted),points:Number(bestPoints||0),passedCases:Number(totalRows.passedCases),totalCases:Number(totalRows.totalCases),averageRuntimeMs:Math.round(Number(totalRows.averageRuntimeMs||0))};
    const grouped=await db.prepare(`SELECT "classId","classTitle",SUM(submissions) AS submissions,SUM(points) AS points,SUM(accepted) AS accepted FROM (
      SELECT c.id AS classId,c.title AS classTitle,COUNT(a.id) AS submissions,COALESCE(SUM(a.points_awarded),0) AS points,
        COUNT(CASE WHEN a.verdict='accepted' THEN 1 END) AS accepted FROM submissions a JOIN problems p ON p.id=a.problem_id
        JOIN class_sessions s ON s.id=p.session_id JOIN teacher_classes c ON c.id=s.class_id
        WHERE a.student_id=? AND s.created_by=? AND a.ai_flagged=0 GROUP BY c.id, c.title
      UNION ALL
      SELECT c.id AS classId,c.title AS classTitle,COUNT(s.id) AS submissions,COALESCE(SUM(s.points_awarded),0) AS points,
        COUNT(CASE WHEN s.verdict='accepted' THEN 1 END) AS accepted FROM assignment_participants ap
        JOIN assignments a ON a.id=ap.assignment_id JOIN assignment_submissions ass ON ass.assignment_id=a.id
        JOIN submissions s ON s.id=ass.submission_id AND s.student_id=ap.student_id
        JOIN teacher_classes c ON c.id=ap.source_class_id
        WHERE ap.student_id=? AND a.teacher_id=? AND s.ai_flagged=0 GROUP BY c.id, c.title
      UNION ALL
      SELECT 'contest:'||ct.id AS classId,'مسابقه: '||ct.title AS classTitle,COUNT(s.id) AS submissions,COALESCE(SUM(s.points_awarded),0) AS points,
        COUNT(CASE WHEN s.verdict='accepted' THEN 1 END) AS accepted FROM contest_submissions cs
        JOIN contests ct ON ct.id=cs.contest_id JOIN submissions s ON s.id=cs.submission_id
        WHERE s.student_id=? AND ct.created_by=? AND s.ai_flagged=0 GROUP BY ct.id, ct.title
    ) GROUP BY "classId","classTitle" ORDER BY "classTitle"`).all(student.id,req.user.id,student.id,req.user.id,student.id,req.user.id);
    res.json({student,totals,assignments:{assigned:Number(assignmentStats.assigned||0),submitted:Number(assignmentStats.submitted||0),late:Number(assignmentStats.late||0)},classes:grouped,submissions});
  });

  // Token-based source similarity. Fingerprints persist after source text retention expires.
  app.post('/api/teacher/similarity/scan', auth, requireRole('teacher'), async (req,res)=>{
    const type=req.body?.type==='contest'?'contest':'assignment';const id=cleanString(req.body?.id,80);const threshold=Number(req.body?.threshold??45);
    if(!id||!Number.isInteger(threshold)||threshold<25||threshold>95)return res.status(400).json({error:'شناسه و آستانهٔ شباهت معتبر نیست.'});
    let rows=[];
    if(type==='assignment'){
      const owned=await db.prepare('SELECT id FROM assignments WHERE id=? AND teacher_id=?').get(id,req.user.id);if(!owned)return res.status(404).json({error:'تکلیف پیدا نشد.'});
      rows=await db.prepare(`SELECT a.id,a.student_id AS studentId,u.display_name AS studentName,u.username,p.id AS problemId,p.title AS problemTitle,a.language,a.similarity_fingerprint AS fingerprint,a.source_code AS sourceCode,a.source_deleted_at AS sourceDeletedAt,a.created_at AS createdAt
        FROM assignment_submissions ass JOIN submissions a ON a.id=ass.submission_id JOIN users u ON u.id=a.student_id JOIN problems p ON p.id=a.problem_id WHERE ass.assignment_id=? ORDER BY a.created_at`).all(id);
    }else{
      const owned=await db.prepare('SELECT id FROM contests WHERE id=? AND created_by=?').get(id,req.user.id);if(!owned)return res.status(404).json({error:'مسابقه پیدا نشد.'});
      rows=await db.prepare(`SELECT a.id,a.student_id AS studentId,u.display_name AS studentName,u.username,p.id AS problemId,p.title AS problemTitle,a.language,a.similarity_fingerprint AS fingerprint,a.source_code AS sourceCode,a.source_deleted_at AS sourceDeletedAt,a.created_at AS createdAt
        FROM contest_submissions cs JOIN submissions a ON a.id=cs.submission_id JOIN users u ON u.id=a.student_id JOIN problems p ON p.id=a.problem_id WHERE cs.contest_id=? ORDER BY a.created_at`).all(id);
    }
    const items=rows.map(row=>{let fingerprint=null;try{fingerprint=row.fingerprint?JSON.parse(row.fingerprint):null;}catch{}if(!fingerprint&&row.sourceCode&&!row.sourceDeletedAt)fingerprint=buildSimilarityFingerprint(row.sourceCode,row.language);return {...row,fingerprint};}).filter(row=>row.fingerprint);
    const pairs=findSimilarPairs(items,{threshold,maxPairs:200}).map(pair=>({similarity:pair.score,jaccard:pair.jaccard,containment:pair.containment,sharedTokens:pair.shared,problemId:pair.left.problemId,problemTitle:pair.left.problemTitle,language:pair.left.language,left:{submissionId:pair.left.id,studentId:pair.left.studentId,studentName:pair.left.studentName,username:pair.left.username,createdAt:pair.left.createdAt,sourceAvailable:Boolean(pair.left.sourceCode&&!pair.left.sourceDeletedAt)},right:{submissionId:pair.right.id,studentId:pair.right.studentId,studentName:pair.right.studentName,username:pair.right.username,createdAt:pair.right.createdAt,sourceAvailable:Boolean(pair.right.sourceCode&&!pair.right.sourceDeletedAt)}}));
    res.json({type,id,threshold,comparedSubmissions:items.length,pairs,notice:'شباهت بالا فقط یک نشانه برای بررسی انسانی است و به‌تنهایی اثبات تقلب نیست.'});
  });

  // Student-facing endpoints never return hidden tests or expected outputs for submissions.
  app.get('/api/student/sessions', auth, requireRole('student'), async (req, res) => {
    const sessions = await db.prepare(`SELECT s.*, u.display_name AS teacher_name, c.title AS class_title,
      (SELECT COUNT(*) FROM problems p WHERE p.session_id = s.id AND p.published = 1 AND NOT EXISTS (
        SELECT 1 FROM contest_problems cp JOIN contests ct ON ct.id=cp.contest_id WHERE cp.problem_id=p.id AND ct.end_at > ?)) AS problem_count
      FROM class_sessions s JOIN users u ON u.id = s.created_by JOIN class_memberships m ON m.class_id = s.class_id AND m.student_id = ?
      JOIN teacher_classes c ON c.id = s.class_id WHERE s.active = 1 AND c.teacher_id = s.created_by
      AND EXISTS (SELECT 1 FROM problems p WHERE p.session_id = s.id AND p.published = 1 AND NOT EXISTS (
        SELECT 1 FROM contest_problems cp JOIN contests ct ON ct.id=cp.contest_id WHERE cp.problem_id=p.id AND ct.end_at > ?))
      ORDER BY s.updated_at DESC`).all(new Date(clockNow()).toISOString(), req.user.id, new Date(clockNow()).toISOString());
    res.json({ sessions: sessions.filter((session) => isStudentSessionAvailable(session, clockNow())).map((s) => ({ id: s.id, classId: s.class_id, classTitle: s.class_title, title: s.title, description: s.description, jalaliDate: s.jalali_date || null, startTime: s.start_time || null, endTime: s.end_time || null, teacherName: s.teacher_name, problemCount: s.problem_count, createdAt: s.created_at })) });
  });
  app.get('/api/student/sessions/:id', auth, requireRole('student'), async (req, res) => {
    const access = await getSessionAccess(db, req.user, req.params.id, clockNow());
    if (!access.row || !access.allowed) return res.status(404).json({ error: 'این جلسه در دسترس نیست.' });
    const problems = await Promise.all((await db.prepare(`SELECT * FROM problems p WHERE p.session_id = ? AND p.published = 1 AND NOT EXISTS (SELECT 1 FROM contest_problems cp JOIN contests ct ON ct.id=cp.contest_id WHERE cp.problem_id=p.id AND ct.end_at > ?) ORDER BY p.position,p.created_at`).all(access.row.id,new Date(clockNow()).toISOString())).map((p) => publicProblem(db, p)));
    const attempts = await db.prepare('SELECT problem_id, verdict, passed_cases, total_cases, points_awarded, created_at, ai_flagged, ai_flag_note, ai_flagged_at FROM submissions WHERE student_id = ? ORDER BY created_at DESC').all(req.user.id);
    const latest = new Map(); const attemptCounts = new Map(); const acceptedProblems = new Set(); const bestPoints = new Map();
    for (const attempt of attempts) {
      if (!attempt.ai_flagged) {
        attemptCounts.set(attempt.problem_id, (attemptCounts.get(attempt.problem_id) || 0) + 1);
        bestPoints.set(attempt.problem_id, Math.max(bestPoints.get(attempt.problem_id) || 0, Number(attempt.points_awarded) || 0));
        if (attempt.verdict === 'accepted') acceptedProblems.add(attempt.problem_id);
      }
      if (!latest.has(attempt.problem_id)) latest.set(attempt.problem_id, { ...attempt, aiFlagged: Boolean(attempt.ai_flagged), aiFlagNote: attempt.ai_flag_note || '', aiFlaggedAt: attempt.ai_flagged_at || null });
    }
    res.json({ session: { id: access.row.id, classId: access.row.class_id, classTitle: access.row.class_title, title: access.row.title, description: access.row.description, jalaliDate: access.row.jalali_date || null, startTime: access.row.start_time || null, endTime: access.row.end_time || null }, problems: problems.map((p) => ({ ...p, latestAttempt: latest.get(p.id) || null, attemptCount: attemptCounts.get(p.id) || 0, accepted: acceptedProblems.has(p.id), bestPoints: Math.min(Number(p.points) || 0, bestPoints.get(p.id) || 0) })) });
  });
  app.get('/api/student/problems/:id', auth, requireRole('student'), async (req, res) => {
    const contestId = cleanString(req.query?.contestId, 80) || null;
    const assignmentId = cleanString(req.query?.assignmentId, 80) || null;
    const access = await getProblemAccess(db, req.user, req.params.id, clockNow(), contestId, assignmentId);
    if (!access.row || !access.allowed) return res.status(404).json({ error: 'این سؤال فعال نیست یا در دسترس تو قرار ندارد.' });
    const problem = await publicProblem(db, access.row);
    const attempts = (await db.prepare(`SELECT a.id, a.verdict, a.passed_cases AS passedCases, a.total_cases AS totalCases, a.points_awarded AS pointsAwarded,
      a.runtime_ms AS runtimeMs, a.language, a.created_at AS createdAt, a.source_code AS sourceCode, a.source_deleted_at AS sourceDeletedAt,
      a.ai_flagged AS aiFlagged, a.ai_flagged_at AS aiFlaggedAt, a.ai_flag_note AS aiFlagNote
      FROM submissions a WHERE a.student_id = ? AND a.problem_id = ?
      AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM contest_submissions cs WHERE cs.submission_id = a.id AND cs.contest_id = ?))
      AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM assignment_submissions ass WHERE ass.submission_id=a.id AND ass.assignment_id=?)) ORDER BY a.created_at ASC`).all(
      req.user.id, access.row.id, contestId, contestId, assignmentId, assignmentId)).map((attempt) => ({
        id: attempt.id, verdict: attempt.verdict, passedCases: attempt.passedCases, totalCases: attempt.totalCases,
        pointsAwarded: attempt.pointsAwarded, runtimeMs: attempt.runtimeMs, language: attempt.language,
        createdAt: attempt.createdAt, aiFlagged: Boolean(attempt.aiFlagged), aiFlaggedAt: attempt.aiFlaggedAt, aiFlagNote: attempt.aiFlagNote || '',
        sourceAvailable: Boolean(attempt.sourceCode && !attempt.sourceDeletedAt && Date.parse(attempt.createdAt) > Date.now() - SOURCE_RETENTION_MS),
      }));
    const stats = await studentProblemStats(db, req.user.id, access.row.id, access.contest?.id || null);
    const remainingAttempts = problem.attemptLimit > 0 ? Math.max(0, problem.attemptLimit - stats.attemptCount) : null;
    const draft = await db.prepare('SELECT source_code AS sourceCode, updated_at AS updatedAt, language, cpp_standard AS cppStandard, cpp_optimization AS cppOptimization FROM code_drafts WHERE student_id=? AND problem_id=?').get(req.user.id, access.row.id);
    res.json({ problem, attempts, latestAttempt: attempts.at(-1) || null, attemptCount: stats.attemptCount, accepted: stats.accepted,
      bestPoints: Math.min(problem.points, stats.bestPoints), remainingAttempts, totalPoints: await studentTotalPoints(db, req.user.id),
      draft: draft || { sourceCode: '', language: problem.defaultLanguage, cppStandard: problem.cppStandard, cppOptimization: problem.cppOptimization }, contestId: access.contest?.id || null,
      assignment: access.assignment ? { id: access.assignment.id, title: access.assignment.title, dueAt: access.assignment.due_at, allowLate: Boolean(access.assignment.allow_late), latePenaltyPercent: Number(access.assignment.late_penalty_percent || 0) } : null });
  });
  app.get('/api/student/problems/:id/status', auth, requireRole('student'), async (req, res) => {
    const contestId = cleanString(req.query?.contestId, 80) || null;
    const assignmentId = cleanString(req.query?.assignmentId, 80) || null;
    const access = await getProblemAccess(db, req.user, req.params.id, clockNow(), contestId, assignmentId);
    if (!access.row || !access.allowed) return res.status(404).json({ error: 'سؤال در دسترس نیست.' });
    const stats = await studentProblemStats(db, req.user.id, access.row.id, access.contest?.id || null);
    const attempts = (await db.prepare(`SELECT a.id, a.verdict, a.passed_cases AS passedCases, a.total_cases AS totalCases,
      a.points_awarded AS pointsAwarded, a.runtime_ms AS runtimeMs, a.language, a.created_at AS createdAt,
      a.source_code AS sourceCode, a.source_deleted_at AS sourceDeletedAt,
      a.ai_flagged AS aiFlagged, a.ai_flagged_at AS aiFlaggedAt, a.ai_flag_note AS aiFlagNote
      FROM submissions a WHERE a.student_id=? AND a.problem_id=?
      AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM contest_submissions cs WHERE cs.submission_id=a.id AND cs.contest_id=?))
      AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM assignment_submissions ass WHERE ass.submission_id=a.id AND ass.assignment_id=?))
      ORDER BY a.created_at ASC`).all(req.user.id, access.row.id, contestId, contestId, assignmentId, assignmentId)).map((attempt) => ({
        id: attempt.id, verdict: attempt.verdict, passedCases: attempt.passedCases, totalCases: attempt.totalCases,
        pointsAwarded: attempt.pointsAwarded, runtimeMs: attempt.runtimeMs, language: attempt.language, createdAt: attempt.createdAt,
        aiFlagged: Boolean(attempt.aiFlagged), aiFlaggedAt: attempt.aiFlaggedAt, aiFlagNote: attempt.aiFlagNote || '',
        sourceAvailable: Boolean(attempt.sourceCode && !attempt.sourceDeletedAt && Date.parse(attempt.createdAt) > Date.now() - SOURCE_RETENTION_MS),
      }));
    const problem = await publicProblem(db, access.row);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ attempts, latestAttempt: attempts.at(-1) || null, attemptCount: stats.attemptCount, accepted: stats.accepted,
      bestPoints: Math.min(Number(problem.points) || 0, stats.bestPoints),
      remainingAttempts: problem.attemptLimit > 0 ? Math.max(0, problem.attemptLimit - stats.attemptCount) : null,
      totalPoints: await studentTotalPoints(db, req.user.id) });
  });

  app.put('/api/student/problems/:id/draft', auth, requireRole('student'), async (req,res)=>{
    const contestId=cleanString(req.body?.contestId,80)||null;
    const assignmentId=cleanString(req.body?.assignmentId,80)||null;
    const access=await getProblemAccess(db,req.user,req.params.id,clockNow(),contestId,assignmentId);
    if(!access.row||!access.allowed)return res.status(404).json({error:'سؤال در دسترس نیست.'});
    if((await studentProblemStats(db,req.user.id,access.row.id,access.contest?.id||null)).accepted)return res.status(409).json({error:'این سؤال قبلاً پذیرفته شده است؛ پیش‌نویس جدید ذخیره نمی‌شود.'});
    const code=typeof req.body?.code==='string'?req.body.code:'';
    const language=req.body?.language==='cpp'?'cpp':'python';
    if(language==='cpp' && !['cpp','both'].includes(access.row.language_mode||'python'))return res.status(400).json({error:'این سؤال اجازهٔ ارسال C++ را نمی‌دهد.'});
    if(language==='python' && !['python','both'].includes(access.row.language_mode||'python'))return res.status(400).json({error:'این سؤال اجازهٔ ارسال Python را نمی‌دهد.'});
    if(code.length>50000)return res.status(413).json({error:'پیش‌نویس حداکثر 50 هزار نویسه می‌تواند باشد.'});
    const cppStandard=['17','20'].includes(String(req.body?.cppStandard||''))?String(req.body.cppStandard):String(access.row.cpp_standard||'17');
    const cppOptimization=['O0','O1','O2','O3'].includes(String(req.body?.cppOptimization||''))?String(req.body.cppOptimization):String(access.row.cpp_optimization||'O2');
    const stamp=nowIso();
    await db.prepare(`INSERT INTO code_drafts(id,student_id,problem_id,source_code,updated_at,language,cpp_standard,cpp_optimization) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(student_id,problem_id) DO UPDATE SET source_code=excluded.source_code,updated_at=excluded.updated_at,language=excluded.language,cpp_standard=excluded.cpp_standard,cpp_optimization=excluded.cpp_optimization`).run(createId(),req.user.id,access.row.id,code,stamp,language,cppStandard,cppOptimization);
    res.json({ok:true,updatedAt:stamp,language,cppStandard,cppOptimization});
  });
  app.delete('/api/student/problems/:id/draft', auth, requireRole('student'), async (req,res)=>{
    const contestId=cleanString(req.body?.contestId,80)||null;
    const assignmentId=cleanString(req.body?.assignmentId,80)||null;
    const access=await getProblemAccess(db,req.user,req.params.id,clockNow(),contestId,assignmentId);
    if(!access.row||!access.allowed)return res.status(404).json({error:'سؤال در دسترس نیست.'});
    const result=await db.prepare('DELETE FROM code_drafts WHERE student_id=? AND problem_id=?').run(req.user.id,req.params.id);
    res.json({ok:true,deleted:result.changes>0});
  });
  app.get('/api/student/problems/:id/compare', auth, requireRole('student'), async (req,res)=>{
    const contestId=cleanString(req.query?.contestId,80)||null;
    const assignmentId=cleanString(req.query?.assignmentId,80)||null;
    const access=await getProblemAccess(db,req.user,req.params.id,clockNow(),contestId,assignmentId);
    if(!access.row||!access.allowed)return res.status(404).json({error:'سؤال در دسترس نیست.'});
    const leftId=cleanString(req.query?.left,80);const rightId=cleanString(req.query?.right,80);
    if(!leftId||!rightId||leftId===rightId)return res.status(400).json({error:'دو تلاش متفاوت انتخاب کن.'});
    const rows=await db.prepare(`SELECT a.id,a.source_code AS sourceCode,a.verdict,a.points_awarded AS pointsAwarded,a.created_at AS createdAt,a.source_deleted_at AS sourceDeletedAt,a.language
      FROM submissions a WHERE a.id IN (?,?) AND a.student_id=? AND a.problem_id=?
      AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM contest_submissions cs WHERE cs.submission_id=a.id AND cs.contest_id=?))
      AND (CAST(? AS TEXT) IS NULL OR EXISTS (SELECT 1 FROM assignment_submissions ass WHERE ass.submission_id=a.id AND ass.assignment_id=?))`).all(leftId,rightId,req.user.id,access.row.id,contestId,contestId,assignmentId,assignmentId);
    if(rows.length!==2)return res.status(404).json({error:'هر دو تلاش باید متعلق به خودت و همین سؤال باشند.'});
    if(rows.some(r=>r.sourceDeletedAt||!r.sourceCode||Date.parse(r.createdAt)<=clockNow()-SOURCE_RETENTION_MS))return res.status(410).json({error:'کد یکی از تلاش‌ها پس از 7 روز حذف شده و دیگر قابل مقایسه نیست.'});
    res.json({left:rows.find(r=>r.id===leftId),right:rows.find(r=>r.id===rightId)});
  });

  app.post('/api/student/problems/:id/submissions', auth, requireRole('student'), async (req, res, next) => {
    try {
      const contestId = cleanString(req.body?.contestId, 80) || null;
      const assignmentId = cleanString(req.body?.assignmentId, 80) || null;
      const access = await getProblemAccess(db, req.user, req.params.id, clockNow(), contestId, assignmentId);
      if (!access.row || !access.allowed) return res.status(404).json({ error: 'این سؤال فعال نیست یا در دسترس تو قرار ندارد.' });
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const language = req.body?.language === 'cpp' ? 'cpp' : 'python';
      const cppStandard = ['17','20'].includes(String(req.body?.cppStandard || access.row.cpp_standard || '17')) ? String(req.body?.cppStandard || access.row.cpp_standard || '17') : '17';
      const optimization = ['O0','O1','O2','O3'].includes(String(req.body?.cppOptimization || access.row.cpp_optimization || 'O2')) ? String(req.body?.cppOptimization || access.row.cpp_optimization || 'O2') : 'O2';
      const languageMode = access.row.language_mode || 'python';
      if ((language === 'cpp' && !['cpp','both'].includes(languageMode)) || (language === 'python' && !['python','both'].includes(languageMode))) return res.status(400).json({ error: 'زبان انتخاب‌شده برای این سؤال مجاز نیست.' });
      if (!code.trim()) return res.status(400).json({ error: 'کد ارسالی خالی است.' });
      if (code.length > 50000) return res.status(413).json({ error: 'کد ارسالی بیش از 50 هزار نویسه است.' });
      const tests = await db.prepare('SELECT id, input_text, expected_output, hidden FROM test_cases WHERE problem_id = ? ORDER BY position').all(access.row.id);
      if (!tests.length) return res.status(500).json({ error: 'برای این سؤال تستی تعریف نشده است؛ با معلم تماس بگیر.' });
      const prior = await studentProblemStats(db, req.user.id, access.row.id, access.contest?.id || null);
      if (prior.accepted) return res.status(409).json({ error: 'این سؤال را قبلاً با پاسخ کامل حل کرده‌ای؛ ارسال دوباره مجاز نیست.', acceptedAlready: true, attemptCount: prior.attemptCount, attemptLimit: Number(access.row.attempt_limit || 0), bestPoints: Math.min(Number(access.row.points) || 0, prior.bestPoints) });
      const attemptLimit = Number(access.row.attempt_limit || 0);
      if (attemptLimit > 0 && prior.attemptCount >= attemptLimit) return res.status(409).json({ error: `محدودیت ${attemptLimit} تلاش این سؤال را مصرف کرده‌ای.`, attemptLimit, attemptCount: prior.attemptCount });
      const nowMs = Date.now();
      const recent = (recentSubmissions.get(req.user.id) || []).filter((timestamp) => nowMs - timestamp < 60_000);
      if (recent.length >= 25) return res.status(429).json({ error: 'تعداد ارسال‌ها در یک دقیقه زیاد است؛ کمی بعد دوباره تلاش کن.' });
      if (activeStudentSubmissions.has(req.user.id)) return res.status(429).json({ error: 'یک ارسال دیگر از حساب تو در حال داوری است؛ پس از پایان آن دوباره تلاش کن.' });
      recent.push(nowMs); recentSubmissions.set(req.user.id, recent); activeStudentSubmissions.add(req.user.id);
      let result;
      const abortController = new AbortController();
      const abortQueuedJobOnDisconnect = () => { if (!res.writableEnded) abortController.abort(new Error('Client disconnected before judging started')); };
      res.once('close', abortQueuedJobOnDisconnect);
      try {
        result = await judgePool.run(() => runJudge({ code, tests, timeLimitMs: access.row.time_limit_ms, comparison: access.row.comparison, language, cppStandard, optimization }), { signal: abortController.signal });
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (error.code === 'QUEUE_FULL') return res.status(503).json({ error: 'صف داوری اکنون پر است؛ لطفاً چند لحظه دیگر دوباره تلاش کن.' });
        throw error;
      } finally { res.off('close', abortQueuedJobOnDisconnect); activeStudentSubmissions.delete(req.user.id); }
      if (result.verdict === 'judge_error') return res.status(503).json({ error: result.message || 'سامانهٔ داوری موقتاً در دسترس نیست.' });
      // A job may wait in the judge queue or execute across the contest end time.
      // Re-check authorization against the server clock immediately before commit.
      const commitAccess = await getProblemAccess(db, req.user, access.row.id, clockNow(), contestId, assignmentId);
      if (!commitAccess.row || !commitAccess.allowed) return res.status(409).json({ error: contestId ? 'زمان مسابقه هنگام داوری این ارسال به پایان رسیده است؛ پاسخ ثبت نشد.' : 'مهلت یا دسترسی این سؤال هنگام داوری تغییر کرده است؛ پاسخ ثبت نشد.' });
      const latestStats = await studentProblemStats(db, req.user.id, access.row.id, access.contest?.id || null);
      if (latestStats.accepted) return res.status(409).json({ error: 'این سؤال هم‌زمان با ارسال تو پذیرفته شده است؛ پاسخ جدید ثبت نشد.', acceptedAlready: true });
      const attemptLimitNow = Number(access.row.attempt_limit || 0);
      if (attemptLimitNow > 0 && latestStats.attemptCount >= attemptLimitNow) return res.status(409).json({ error: 'محدودیت تلاش این سؤال هنگام داوری تکمیل شده است؛ پاسخ جدید ثبت نشد.', attemptLimit: attemptLimitNow, attemptCount: latestStats.attemptCount });
      const rawPoints = Math.min(Number(access.row.points) || 0, Math.floor((result.passedCases / Math.max(1, result.totalCases)) * access.row.points));
      const now = nowIso();
      const isLate = Boolean(access.assignment && Date.parse(now) > Date.parse(access.assignment.due_at));
      const penaltyPercent = isLate ? Number(access.assignment.late_penalty_percent || 0) : 0;
      const points = Math.max(0, Math.floor(rawPoints * (100 - penaltyPercent) / 100));
      const details = (result.results || []).map((r, i) => {
        const detail = { index: i + 1, passed: Boolean(r.passed), status: r.status, runtimeMs: r.runtimeMs };
        const test = tests[i];
        // Only public testcase diagnostics may be stored in student-visible details.
        // Hidden stderr/tracebacks are intentionally omitted too: submitted code can
        // echo hidden input to stderr, so exposing a hidden error can leak its payload.
        if (test && !test.hidden) {
          const rawOutput = typeof r.output === 'string' ? r.output : '';
          const outputLimit = 16000;
          detail.isPublic = true;
          detail.input = String(test.input_text || '');
          detail.expectedOutput = String(test.expected_output || '');
          detail.actualOutput = rawOutput.slice(0, outputLimit);
          detail.outputTruncated = rawOutput.length > outputLimit || r.status === 'output_limit';
          detail.outputAvailable = Boolean(r.outputAvailable || typeof r.output === 'string');
          detail.error = r.error ? String(r.error).slice(0, 1200) : '';
        }
        return detail;
      });
      const id = createId();
      const fingerprint = JSON.stringify(buildSimilarityFingerprint(code, language));
      await db.transaction(async () => {
        await db.prepare(`INSERT INTO submissions(id,problem_id,student_id,source_code,verdict,passed_cases,total_cases,points_awarded,runtime_ms,details_json,created_at,language,cpp_standard,cpp_optimization,similarity_fingerprint)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,access.row.id,req.user.id,code,result.verdict,result.passedCases,result.totalCases,points,result.runtimeMs||0,JSON.stringify(details),now,language,cppStandard,optimization,fingerprint);
        if (access.contest?.id) await db.prepare('INSERT INTO contest_submissions(contest_id,submission_id) VALUES (?, ?)').run(access.contest.id,id);
        if (access.assignment?.id) await db.prepare('INSERT INTO assignment_submissions(assignment_id,submission_id,is_late,raw_points,penalty_percent) VALUES(?,?,?,?,?)').run(access.assignment.id,id,isLate?1:0,rawPoints,penaltyPercent);
        await db.prepare('DELETE FROM code_drafts WHERE student_id=? AND problem_id=?').run(req.user.id,access.row.id);
      })();
      const teacherIds = (await db.prepare('SELECT DISTINCT s.created_by AS id FROM problems p JOIN class_sessions s ON s.id=p.session_id WHERE p.id=?').all(access.row.id)).map((r)=>r.id);
      await createNotifications(db, teacherIds, { title: access.assignment ? 'تحویل تکلیف جدید' : 'ارسال کد جدید', message: `${req.user.displayName || req.user.username} برای سؤال «${access.row.title}» ${access.assignment ? 'تکلیف را ارسال کرد.' : 'کد ارسال کرد.'}`, type: 'submission', targetPath: '/submissions' });
      const after = await studentProblemStats(db, req.user.id, access.row.id, access.contest?.id || null);
      const totalPoints = await studentTotalPoints(db, req.user.id);
      const remainingAttempts = attemptLimit > 0 ? Math.max(0, attemptLimit - after.attemptCount) : null;
      await audit(req, 'submit_solution', 'submission', id, `problem=${access.row.id}; language=${language}; verdict=${result.verdict}; passed=${result.passedCases}/${result.totalCases}; points=${points}; attempt=${after.attemptCount}; assignment=${assignmentId||''}`);
      res.status(201).json({ submission: { id, verdict: result.verdict, passedCases: result.passedCases, totalCases: result.totalCases, pointsAwarded: points, rawPoints, late: isLate, latePenaltyPercent: penaltyPercent, language, cppStandard, cppOptimization: optimization, bestPoints: Math.min(Number(access.row.points) || 0, after.bestPoints), totalPoints, maxPoints: access.row.points, runtimeMs: result.runtimeMs || 0, compileTimeMs: result.compileTimeMs || 0, createdAt: now, attemptCount: after.attemptCount, attemptLimit, remainingAttempts, accepted: after.accepted, compileError: result.compileError || '', cases: details } });
    } catch (err) { next(err); }
  });

  app.get('/api/student/submissions', auth, requireRole('student'), async (req, res) => {
    const {limit,offset}=paginationFromRequest(req);
    const total=(await db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE student_id=?').get(req.user.id)).n;
    const rows = await db.prepare(`SELECT a.id, a.verdict, a.passed_cases, a.total_cases, a.points_awarded, a.runtime_ms, a.created_at, a.source_deleted_at, a.source_code, a.language, a.ai_flagged, a.ai_flagged_at, a.ai_flag_note,
      u.username AS student_username, u.display_name AS student_name, p.title AS problem_title, s.title AS session_title, c.title AS class_title, s.created_by,
      (SELECT ct.title FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id ORDER BY ct.created_at DESC LIMIT 1) AS contest_title,
      (SELECT ax.title FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id ORDER BY ax.created_at DESC LIMIT 1) AS assignment_title
      FROM submissions a JOIN users u ON u.id = a.student_id JOIN problems p ON p.id = a.problem_id JOIN class_sessions s ON s.id = p.session_id LEFT JOIN teacher_classes c ON c.id = s.class_id
      WHERE a.student_id = ? ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(req.user.id,limit,offset);
    res.json({ submissions: rows.map(submissionSummary),pagination:{total,limit,offset,hasMore:offset+rows.length<total} });
  });
  app.get('/api/teacher/submissions', auth, requireRole('teacher'), async (req, res) => {
    await purgeExpiredSubmissionSources(db);
    const {limit,offset}=paginationFromRequest(req);
    const teacherSubmissionScope = `s.created_by = ? OR EXISTS (SELECT 1 FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=?) OR EXISTS (SELECT 1 FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id AND ax.teacher_id=?)`;
    const total=(await db.prepare(`SELECT COUNT(DISTINCT a.id) AS n FROM submissions a JOIN problems p ON p.id=a.problem_id JOIN class_sessions s ON s.id=p.session_id WHERE ${teacherSubmissionScope}`).get(req.user.id,req.user.id,req.user.id)).n;
    const rows = await db.prepare(`SELECT DISTINCT a.id, a.verdict, a.passed_cases, a.total_cases, a.points_awarded, a.runtime_ms, a.created_at, a.source_deleted_at, a.source_code, a.language, a.ai_flagged, a.ai_flagged_at, a.ai_flag_note,
      u.username AS student_username, u.display_name AS student_name, p.title AS problem_title, s.title AS session_title, c.title AS class_title, s.created_by,
      (SELECT ct.title FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=? LIMIT 1) AS contest_title,
      (SELECT ax.title FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id AND ax.teacher_id=? LIMIT 1) AS assignment_title
      FROM submissions a JOIN users u ON u.id = a.student_id JOIN problems p ON p.id = a.problem_id JOIN class_sessions s ON s.id = p.session_id LEFT JOIN teacher_classes c ON c.id = s.class_id
      WHERE ${teacherSubmissionScope} ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,limit,offset);
    res.json({ submissions: rows.map(submissionSummary),pagination:{total,limit,offset,hasMore:offset+rows.length<total} });
  });
  app.patch('/api/teacher/submissions/:id/ai-review', auth, requireRole('teacher'), async (req, res) => {
    const decision = cleanString(req.body?.decision, 16);
    if (!['flag', 'restore'].includes(decision)) return res.status(400).json({ error: 'تصمیم بررسی معتبر نیست.' });
    const note = cleanString(req.body?.note, 300);
    const row = await db.prepare(`SELECT a.id, a.student_id, a.problem_id, a.points_awarded, a.ai_flagged,
      a.ai_flag_original_points, p.title AS problem_title, s.created_by AS session_teacher_id,
      (SELECT ct.created_by FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=? LIMIT 1) AS contest_teacher_id,
      (SELECT ax.teacher_id FROM assignment_submissions ass JOIN assignments ax ON ax.id=ass.assignment_id WHERE ass.submission_id=a.id AND ax.teacher_id=? LIMIT 1) AS assignment_teacher_id
      FROM submissions a JOIN problems p ON p.id=a.problem_id JOIN class_sessions s ON s.id=p.session_id WHERE a.id=?`)
      .get(req.user.id, req.user.id, req.params.id);
    if (!row || (row.session_teacher_id !== req.user.id && row.contest_teacher_id !== req.user.id && row.assignment_teacher_id !== req.user.id)) {
      return res.status(404).json({ error: 'ارسال پیدا نشد یا متعلق به جلسه، مسابقه یا تکلیف تو نیست.' });
    }
    const stamp = nowIso();
    if (decision === 'flag') {
      if (row.ai_flagged) return res.status(409).json({ error: 'این ارسال قبلاً به‌دلیل تشخیص استفاده از هوش مصنوعی علامت‌گذاری شده است.', aiFlagged: true, pointsAwarded: 0 });
      const update = await db.prepare(`UPDATE submissions SET ai_flagged=1, ai_flagged_at=?, ai_flagged_by=?, ai_flag_note=?,
        ai_flag_original_points=points_awarded, points_awarded=0 WHERE id=? AND ai_flagged=0`).run(stamp, req.user.id, note, row.id);
      if (!update.changes) return res.status(409).json({ error: 'وضعیت این ارسال هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی کن.' });
      await createNotifications(db, [row.student_id], {
        title: 'تشخیص استفاده از هوش مصنوعی در کد ارسالی',
        message: `معلم تشخیص داده است که کد ارسالی شما برای سؤال «${row.problem_title}» با استفاده از هوش مصنوعی تهیه شده است. امتیاز این ارسال صفر شد و فرصت حل دوبارهٔ سؤال برایت فعال شد.${note ? ` توضیح معلم: ${note}` : ''}`,
        type: 'warning', targetPath: '/',
      });
      await audit(req, 'flag_ai_submission', 'submission', row.id, `student=${row.student_id}; problem=${row.problem_id}; original_points=${row.points_awarded}; note=${note}`);
      return res.json({ ok: true, aiFlagged: true, pointsAwarded: 0, message: 'ارسال علامت‌گذاری شد؛ امتیاز صفر و فرصت حل دوباره فعال شد.' });
    }
    if (!row.ai_flagged) return res.status(409).json({ error: 'این ارسال در وضعیت علامت‌گذاری‌شده نیست.' });
    const restored = Math.max(0, Number(row.ai_flag_original_points ?? 0));
    const update = await db.prepare(`UPDATE submissions SET ai_flagged=0, ai_flagged_at=NULL, ai_flagged_by=NULL, ai_flag_note='',
      points_awarded=COALESCE(ai_flag_original_points, points_awarded), ai_flag_original_points=NULL WHERE id=? AND ai_flagged=1`).run(row.id);
    if (!update.changes) return res.status(409).json({ error: 'وضعیت این ارسال هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی کن.' });
    await createNotifications(db, [row.student_id], {
      title: 'بازگشت تصمیم بررسی کد',
      message: `تصمیم معلم دربارهٔ استفاده از هوش مصنوعی برای ارسال سؤال «${row.problem_title}» بازگشت داده شد. امتیاز قبلی داوری بازیابی شد و وضعیت حل سؤال دوباره بر اساس نتیجهٔ اصلی محاسبه می‌شود.`,
      type: 'success', targetPath: '/',
    });
    await audit(req, 'restore_ai_submission', 'submission', row.id, `student=${row.student_id}; problem=${row.problem_id}; restored_points=${restored}`);
    return res.json({ ok: true, aiFlagged: false, pointsAwarded: restored, message: 'تصمیم بازگشت داده شد و امتیاز قبلی بازیابی شد.' });
  });

  app.get('/api/student/submissions/:id/results', auth, requireRole('student'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const row = await db.prepare('SELECT id, details_json, created_at FROM submissions WHERE id=? AND student_id=?').get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'ارسال پیدا نشد یا متعلق به حساب تو نیست.' });
    let details = [];
    try { details = JSON.parse(row.details_json || '[]'); } catch { details = []; }
    const tests = Array.isArray(details) ? details.filter((item) => item?.isPublic === true && item.outputAvailable === true).map((item) => ({
      index: Number(item.index) || 0,
      passed: Boolean(item.passed),
      status: String(item.status || 'unknown'),
      runtimeMs: Number(item.runtimeMs) || 0,
      input: typeof item.input === 'string' ? item.input.slice(0, 16000) : '',
      expectedOutput: typeof item.expectedOutput === 'string' ? item.expectedOutput.slice(0, 16000) : '',
      actualOutput: typeof item.actualOutput === 'string' ? item.actualOutput.slice(0, 16000) : '',
      outputTruncated: Boolean(item.outputTruncated),
    })) : [];
    if (!tests.length) return res.json({ available: false, tests: [], createdAt: row.created_at, message: 'برای این ارسال خروجی تست‌های عمومی ذخیره نشده است. خروجی ارسال‌های جدید از این پس قابل مشاهده خواهد بود.' });
    res.json({ available: true, tests, createdAt: row.created_at });
  });

  app.get('/api/student/submissions/:id/source', auth, requireRole('student'), async (req, res) => {
    await purgeExpiredSubmissionSources(db);
    const row = await db.prepare(`SELECT a.id, a.source_code, a.source_deleted_at, a.created_at, a.language, p.title AS problem_title,
      s.title AS session_title, c.title AS class_title FROM submissions a
      JOIN problems p ON p.id=a.problem_id JOIN class_sessions s ON s.id=p.session_id
      LEFT JOIN teacher_classes c ON c.id=s.class_id WHERE a.id=? AND a.student_id=?`).get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'ارسال پیدا نشد یا متعلق به حساب تو نیست.' });
    if (row.source_deleted_at || !row.source_code || Date.parse(row.created_at) <= Date.now() - SOURCE_RETENTION_MS) {
      if (!row.source_deleted_at) await db.prepare('UPDATE submissions SET source_code = ?, source_deleted_at = ? WHERE id = ?').run('', nowIso(), row.id);
      return res.status(410).json({ error: 'مهلت نگهداری کد به پایان رسیده است؛ کد پس از 7 روز حذف می‌شود.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ id: row.id, sourceCode: row.source_code, language: row.language, classTitle: row.class_title, sessionTitle: row.session_title, problemTitle: row.problem_title,
      createdAt: row.created_at, expiresAt: new Date(Date.parse(row.created_at) + SOURCE_RETENTION_MS).toISOString() });
  });

  app.get('/api/teacher/submissions/:id/source', auth, requireRole('teacher'), async (req, res) => {
    const row = await db.prepare(`SELECT a.id, a.source_code, a.source_deleted_at, a.created_at, a.language, u.username AS student_username,
      p.title AS problem_title, s.title AS session_title, c.title AS class_title, s.created_by,
      (SELECT ct.created_by FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=? LIMIT 1) AS contest_created_by,
      (SELECT ct.title FROM contest_submissions cs JOIN contests ct ON ct.id=cs.contest_id WHERE cs.submission_id=a.id AND ct.created_by=? LIMIT 1) AS contest_title
      FROM submissions a JOIN users u ON u.id = a.student_id JOIN problems p ON p.id = a.problem_id JOIN class_sessions s ON s.id = p.session_id
      LEFT JOIN teacher_classes c ON c.id = s.class_id WHERE a.id = ?`).get(req.user.id,req.user.id,req.params.id);
    if (!row || (row.created_by !== req.user.id && row.contest_created_by !== req.user.id)) return res.status(404).json({ error: 'ارسال پیدا نشد یا متعلق به جلسه‌ها و مسابقه‌های تو نیست.' });
    if (row.source_deleted_at || !row.source_code || Date.parse(row.created_at) <= Date.now() - SOURCE_RETENTION_MS) {
      if (!row.source_deleted_at) await db.prepare('UPDATE submissions SET source_code = ?, source_deleted_at = ? WHERE id = ?').run('', nowIso(), row.id);
      return res.status(410).json({ error: 'مهلت نگهداری کد به پایان رسیده است؛ کد پس از 7 روز حذف می‌شود.' });
    }
    res.json({ id: row.id, sourceCode: row.source_code, language: row.language || 'python', studentUsername: row.student_username, classTitle: row.class_title, sessionTitle: row.contest_title ? `مسابقه: ${row.contest_title}` : row.session_title, problemTitle: row.problem_title,
      createdAt: row.created_at, expiresAt: new Date(Date.parse(row.created_at) + SOURCE_RETENTION_MS).toISOString() });
  });

  // Health endpoint intentionally discloses no configuration or user data.
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'acm-classroom', version: '2.13.0' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'نشانی API پیدا نشد.' }));
  const distPath = path.resolve(__dirname, '../dist');
  if (fs.existsSync(distPath)) {
    app.use(staticFiles(distPath, { index: false, maxAge: process.env.NODE_ENV === 'production' ? 3600 : 0 }));
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => res.status(503).send('Frontend is not built yet. Run npm run build.'));
  }
  return app;
}

function parseCookies(header) {
  const cookies = {};
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}
function validateProblemPayload(body, { testsOptional = false } = {}) {
  const title = cleanString(body?.title, 180);
  const statement = typeof body?.statement === 'string' ? body.statement.trim().slice(0, 20000) : '';
  const inputFormat = cleanString(body?.inputFormat, 3000);
  const outputFormat = cleanString(body?.outputFormat, 3000);
  const points = Number(body?.points ?? 100);
  const attemptLimit = Number(body?.attemptLimit ?? 0);
  const timeLimitMs = Number(body?.timeLimitMs ?? 1500);
  const comparison = body?.comparison ?? 'tokens';
  const published = Boolean(body?.published);
  const languageMode = ['python','cpp','both'].includes(body?.languageMode) ? body.languageMode : 'python';
  const defaultLanguage = ['python','cpp'].includes(body?.defaultLanguage) ? body.defaultLanguage : 'python';
  const cppStandard = ['17','20'].includes(String(body?.cppStandard ?? '17')) ? String(body?.cppStandard ?? '17') : '17';
  const cppOptimization = ['O0','O1','O2','O3'].includes(String(body?.cppOptimization ?? 'O2')) ? String(body?.cppOptimization ?? 'O2') : 'O2';
  if (defaultLanguage === 'cpp' && languageMode === 'python') return { error: 'زبان پیش‌فرض با زبان‌های فعال سؤال سازگار نیست.' };
  if (!title || !statement) return { error: 'عنوان و صورت سؤال الزامی هستند.' };
  if (!Number.isInteger(points) || points < 1 || points > 1000) return { error: 'امتیاز سؤال باید عدد صحیح بین 1 تا 1000 باشد.' };
  if (!Number.isInteger(attemptLimit) || attemptLimit < 0 || attemptLimit > 100) return { error: 'محدودیت تلاش باید عدد صحیح بین صفر تا 100 باشد؛ صفر یعنی نامحدود.' };
  if (!Number.isInteger(timeLimitMs) || timeLimitMs < 500 || timeLimitMs > 5000) return { error: 'محدودیت زمان باید بین 500 تا 5000 میلی‌ثانیه باشد.' };
  if (!['tokens', 'exact'].includes(comparison)) return { error: 'روش مقایسهٔ خروجی نامعتبر است.' };
  if (!testsOptional && body?.tests === undefined) return { error: 'تست‌های سؤال را وارد کن.' };
  return { title, statement, inputFormat, outputFormat, points, attemptLimit, timeLimitMs, comparison, published, languageMode, defaultLanguage, cppStandard, cppOptimization, tests: body?.tests };
}
async function insertTests(db, problemId, tests) {
  const insert = db.prepare('INSERT INTO test_cases(id, problem_id, input_text, expected_output, hidden, position) VALUES (?, ?, ?, ?, ?, ?)');
  for (const test of tests) await insert.run(createId(), problemId, test.input, test.output, test.hidden ? 1 : 0, test.position);
}
async function questionBankRecord(db, row, { includeTests = false } = {}) {
  const author = row.author_id ? row : await db.prepare('SELECT id AS author_id, display_name AS author_name, username AS author_username FROM users WHERE id=?').get(row.teacher_id);
  const record = {
    id: row.id, title: row.title, statement: row.statement,
    inputFormat: row.input_format, outputFormat: row.output_format,
    points: row.points, attemptLimit: Number(row.attempt_limit || 0),
    timeLimitMs: row.time_limit_ms, comparison: row.comparison,
    languageMode: row.language_mode || 'python', defaultLanguage: row.default_language || 'python', cppStandard: row.cpp_standard || '17', cppOptimization: row.cpp_optimization || 'O2',
    authorId: author?.author_id || row.teacher_id, authorName: author?.author_name || 'معلم', authorUsername: author?.author_username || '',
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (includeTests) record.tests = (await db.prepare('SELECT input_text AS input, expected_output AS output, hidden FROM question_bank_tests WHERE bank_question_id = ? ORDER BY position').all(row.id)).map((test) => ({ input: test.input, output: test.output, hidden: Boolean(test.hidden) }));
  else record.testCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM question_bank_tests WHERE bank_question_id = ?').get(row.id)).n);
  return record;
}
async function insertQuestionBankTests(db, questionId, tests) {
  const insert = db.prepare('INSERT INTO question_bank_tests(id, bank_question_id, input_text, expected_output, hidden, position) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [index, test] of tests.entries()) await insert.run(createId(), questionId, test.input, test.output, test.hidden ? 1 : 0, test.position ?? index);
}
async function addProblemToSharedBank(db, { problemId, teacherId, payload, tests, stamp = nowIso() }) {
  const candidates = await db.prepare(`SELECT * FROM question_bank WHERE teacher_id = ? AND title = ? AND statement = ? AND input_format = ? AND output_format = ?
    AND points = ? AND attempt_limit = ? AND time_limit_ms = ? AND comparison = ? AND language_mode = ? AND default_language = ? AND cpp_standard = ? AND cpp_optimization = ?`).all(teacherId, payload.title, payload.statement, payload.inputFormat, payload.outputFormat, payload.points, payload.attemptLimit, payload.timeLimitMs, payload.comparison, payload.languageMode, payload.defaultLanguage, payload.cppStandard, payload.cppOptimization);
  for (const candidate of candidates) {
    const saved = await db.prepare('SELECT input_text AS input, expected_output AS output, hidden FROM question_bank_tests WHERE bank_question_id=? ORDER BY position').all(candidate.id);
    if (saved.length === tests.length && saved.every((item, index) => item.input === tests[index].input && item.output === tests[index].output && Boolean(item.hidden) === Boolean(tests[index].hidden))) {
      await db.prepare('UPDATE problems SET source_bank_id=?, bank_opt_out=0 WHERE id=?').run(candidate.id, problemId);
      return candidate.id;
    }
  }
  const bankId = createId();
  await db.prepare(`INSERT INTO question_bank(id,teacher_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,created_at,updated_at,origin_problem_id,language_mode,default_language,cpp_standard,cpp_optimization)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(bankId, teacherId, payload.title, payload.statement, payload.inputFormat, payload.outputFormat, payload.points, payload.attemptLimit, payload.timeLimitMs, payload.comparison, stamp, stamp, problemId,payload.languageMode,payload.defaultLanguage,payload.cppStandard,payload.cppOptimization);
  await insertQuestionBankTests(db, bankId, tests);
  await db.prepare('UPDATE problems SET source_bank_id=?, bank_opt_out=0 WHERE id=?').run(bankId, problemId);
  return bankId;
}
async function updateOriginBankQuestion(db, problemId, teacherId, payload, tests, stamp = nowIso()) {
  const bank = await db.prepare('SELECT * FROM question_bank WHERE origin_problem_id=? AND teacher_id=?').get(problemId, teacherId);
  if (!bank) return false;
  await db.prepare(`UPDATE question_bank SET title=?,statement=?,input_format=?,output_format=?,points=?,attempt_limit=?,time_limit_ms=?,comparison=?,updated_at=?,language_mode=?,default_language=?,cpp_standard=?,cpp_optimization=? WHERE id=?`)
    .run(payload.title, payload.statement, payload.inputFormat, payload.outputFormat, payload.points, payload.attemptLimit, payload.timeLimitMs, payload.comparison, stamp,payload.languageMode,payload.defaultLanguage,payload.cppStandard,payload.cppOptimization, bank.id);
  await db.prepare('DELETE FROM question_bank_tests WHERE bank_question_id=?').run(bank.id);
  await insertQuestionBankTests(db, bank.id, tests);
  return true;
}
function submissionSummary(row) {
  return {
    id: row.id, verdict: row.verdict, passedCases: row.passed_cases, totalCases: row.total_cases,
    pointsAwarded: row.points_awarded, runtimeMs: row.runtime_ms, createdAt: row.created_at,
    aiFlagged: Boolean(row.ai_flagged), aiFlaggedAt: row.ai_flagged_at || null, aiFlagNote: row.ai_flag_note || '',
    studentUsername: row.student_username, studentName: row.student_name,
    problemTitle: row.problem_title, sessionTitle: row.contest_title ? `مسابقه: ${row.contest_title}` : row.assignment_title ? `تکلیف: ${row.assignment_title}` : row.session_title, contestTitle: row.contest_title || null, assignmentTitle: row.assignment_title || null, classTitle: row.class_title, teacherId: row.created_by, language: row.language || 'python',
    sourceAvailable: typeof row.source_code === 'string' && row.source_code.length > 0 && !row.source_deleted_at && Date.parse(row.created_at) > Date.now() - SOURCE_RETENTION_MS,
    sourceExpiresAt: row.created_at ? new Date(Date.parse(row.created_at) + SOURCE_RETENTION_MS).toISOString() : null,
  };
}
