import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { createUser } from './server/db.js';
import { openSqliteTestDatabase, migrateLegacyContestClassRequirement } from './server/sqlite-test-database.js';
import { openPostgresDatabase } from './server/postgres-database.js';
import crypto from 'node:crypto';
import { createApp } from './server/app.js';
import { resolveClientIp } from './server/http-app.js';

const ORIGIN = 'http://127.0.0.1:3000';
const PASSWORD = 'Str0ng-Test-Pass-123!';

async function createPostgresFixtureDatabase() {
  const sourceUrl = process.env.ACM_TEST_DATABASE_URL;
  const base = new URL(sourceUrl);
  const schema = `acm_test_${crypto.randomBytes(8).toString('hex')}`;
  const { Client } = await import('pg');
  const adminClient = new Client({ connectionString: base.toString() });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE SCHEMA \"${schema}\"`);
  } finally {
    await adminClient.end();
  }
  const scoped = new URL(base.toString());
  scoped.searchParams.set('options', `-csearch_path=${schema},public`);
  let db;
  try {
    db = await openPostgresDatabase({ databaseUrl: scoped.toString() });
  } catch (error) {
    const cleanup = new Client({ connectionString: base.toString() });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA IF EXISTS \"${schema}\" CASCADE`); }
    finally { await cleanup.end(); }
    throw error;
  }
  return {
    db,
    async drop() {
      const client = new Client({ connectionString: base.toString() });
      await client.connect();
      try { await client.query(`DROP SCHEMA IF EXISTS \"${schema}\" CASCADE`); }
      finally { await client.end(); }
    },
  };
}

async function fixture(t, appOrigin = ORIGIN, clock = { now: Date.now() }, extraConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-classroom-test-'));
  const pgFixture = process.env.ACM_TEST_DATABASE_URL ? await createPostgresFixtureDatabase() : null;
  const db = pgFixture?.db || openSqliteTestDatabase({ dbPath: path.join(dir, 'test.sqlite') });
  let server = null;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    try { await db.close(); } finally {
      try { await pgFixture?.drop(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });
  const adminId = await createUser(db, { username: 'admin.test', displayName: 'Admin', role: 'admin', password: PASSWORD });
  const teacherId = await createUser(db, { username: 'teacher.test', displayName: 'Teacher', role: 'teacher', password: PASSWORD });
  const studentId = await createUser(db, { username: 'student.test', displayName: 'Student', role: 'student', password: PASSWORD });
  const judgeCalls = [];
  const runJudge = async (args) => {
    judgeCalls.push({ ...args });
    const { tests, code = '' } = args;
    const forcedAccepted = code.includes('__ACCEPTED_TEST_ONLY__');
    const passedCases = forcedAccepted ? tests.length : code.includes('__PARTIAL_TWO_OF_FOUR__') ? Math.min(2, tests.length) : Math.min(1, tests.length);
    return {
      verdict: forcedAccepted ? 'accepted' : 'wrong_answer', passedCases, totalCases: tests.length, runtimeMs: 24,
      results: tests.map((test, i) => ({ passed: i < passedCases, status: 'ok', runtimeMs: 12, output: test.hidden ? `HIDDEN_ACTUAL_OUTPUT_${i + 1}_SECRET\n` : `ACTUAL_PUBLIC_OUTPUT_${i + 1}\n`, outputAvailable: true, error: test.hidden ? 'HIDDEN_STDERR_SECRET_INPUT_ECHO' : '' })), message: '',
    };
  };
  server = http.createServer(await createApp({ db, runJudge, config: { appOrigin, backupDir: path.join(dir, 'backups'), now: () => clock.now, ...extraConfig } }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, { method = 'GET', body, token, origin = ORIGIN } = {}) {
    const headers = { Origin: origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Cookie = `acm_session=${token}`;
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {};
    try { data = await response.json(); } catch {}
    const setCookie = response.headers.get('set-cookie') || '';
    const match = setCookie.match(/acm_session=([^;]+)/);
    return { status: response.status, data, token: match?.[1] || token };
  }
  async function login(username, password = PASSWORD) {
    const r = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.token;
  }
  return { db, adminId, teacherId, studentId, request, login, clock, judgeCalls };
}

async function makeClass(f, teacherToken, { title = 'Test class', addStudent = false } = {}) {
  const created = await f.request('/api/teacher/classes', { method: 'POST', token: teacherToken, body: { title, description: '' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  if (addStudent) {
    const member = await f.request(`/api/teacher/classes/${created.data.class.id}/members`, { method: 'POST', token: teacherToken, body: { studentId: f.studentId } });
    assert.equal(member.status, 201, JSON.stringify(member.data));
  }
  return created.data.class;
}

test('health endpoint reports release 2.13.0 without exposing configuration', async (t) => {
  const f = await fixture(t);
  const health = await f.request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, { ok: true, service: 'acm-classroom', version: '2.13.0' });
});

test('login works, stores opaque cookie and does not leak password hashes', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: PASSWORD } });
  assert.equal(result.status, 200);
  assert.ok(result.token);
  assert.equal(result.data.user.role, 'admin');
  assert.equal('password_hash' in result.data.user, false);
  assert.equal('passwordHash' in result.data.user, false);
  const list = await f.request('/api/admin/users', { token: result.token });
  assert.equal(list.status, 200);
  assert.ok(list.data.users.every((u) => !('password_hash' in u) && !('passwordHash' in u)));
});



test('Bale status and one-time link codes are scoped to the authenticated account', async (t) => {
  const f = await fixture(t, ORIGIN, undefined, { baleEnabled: true });
  const studentToken = await f.login('student.test');
  const status = await f.request('/api/bale/status', { token: studentToken });
  assert.equal(status.status, 200);
  assert.equal(status.data.configured, true);
  assert.equal(status.data.linked, false);

  const first = await f.request('/api/bale/link-code', { method: 'POST', token: studentToken, body: {} });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.match(first.data.command, /^\/start [A-Za-z0-9_-]{16}$/);
  const firstHash = (await import('./server/bale-bot.js')).hashBaleLinkCode(first.data.code);
  const stored = await f.db.prepare('SELECT code_hash, expires_at FROM bale_link_codes WHERE user_id=?').get(f.studentId);
  assert.equal(stored.code_hash, firstHash);
  assert.notEqual(stored.code_hash, first.data.code);
  assert.ok(Date.parse(stored.expires_at) > f.clock.now);

  const second = await f.request('/api/bale/link-code', { method: 'POST', token: studentToken, body: {} });
  assert.equal(second.status, 201);
  assert.notEqual(second.data.code, first.data.code);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM bale_link_codes WHERE user_id=?').get(f.studentId)).n, 1);
});

test('Bale connection can be paused, resumed and removed by its owner', async (t) => {
  const f = await fixture(t, ORIGIN, undefined, { baleEnabled: true });
  const studentToken = await f.login('student.test');
  await f.db.prepare('INSERT INTO bale_links(user_id,chat_id,chat_label,chat_username,enabled,linked_at) VALUES(?,?,?,?,1,?)')
    .run(f.studentId, 'bale-chat-123', 'Student Bale', 'student_bale', new Date().toISOString());
  const pause = await f.request('/api/bale/settings', { method: 'PATCH', token: studentToken, body: { enabled: false } });
  assert.equal(pause.status, 200);
  assert.equal(pause.data.enabled, false);
  assert.equal((await f.db.prepare('SELECT enabled FROM bale_links WHERE user_id=?').get(f.studentId)).enabled, 0);
  const resume = await f.request('/api/bale/settings', { method: 'PATCH', token: studentToken, body: { enabled: true } });
  assert.equal(resume.status, 200);
  assert.equal((await f.db.prepare('SELECT enabled FROM bale_links WHERE user_id=?').get(f.studentId)).enabled, 1);
  const remove = await f.request('/api/bale/link', { method: 'DELETE', token: studentToken, body: {} });
  assert.equal(remove.status, 200);
  assert.equal(await f.db.prepare('SELECT 1 FROM bale_links WHERE user_id=?').get(f.studentId), undefined);
});

test('Bale connection cannot be created when server token is not configured', async (t) => {
  const f = await fixture(t);
  const studentToken = await f.login('student.test');
  const result = await f.request('/api/bale/link-code', { method: 'POST', token: studentToken, body: {} });
  assert.equal(result.status, 503);
});

test('new website notifications are queued for connected Bale users without changing in-site notifications', async (t) => {
  const f = await fixture(t, ORIGIN, undefined, { baleEnabled: true });
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { addStudent: true, title: 'Bale notifications class' });
  const stamp = new Date().toISOString();
  await f.db.prepare('INSERT INTO bale_links(user_id,chat_id,chat_label,enabled,linked_at) VALUES(?,?,?,?,?)')
    .run(f.studentId, 'bale-student-chat', 'Student', 1, stamp);
  const created = await f.request('/api/teacher/sessions', {
    method: 'POST', token: teacherToken,
    body: { classId: room.id, title: 'Bale notice test', description: '' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const activated = await f.request(`/api/teacher/sessions/${created.data.session.id}`, {
    method: 'PATCH', token: teacherToken,
    body: { active: true, jalaliDate: '1405/08/12', startTime: '09:00', endTime: '10:00' },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.data));
  const notification = await f.db.prepare("SELECT id,title FROM notifications WHERE user_id=? AND type='session' ORDER BY created_at DESC LIMIT 1").get(f.studentId);
  assert.ok(notification);
  const queued = await f.db.prepare('SELECT user_id,status FROM bale_notification_outbox WHERE notification_id=?').get(notification.id);
  assert.deepEqual({ user_id: queued.user_id, status: queued.status }, { user_id: f.studentId, status: 'pending' });
  const visible = await f.request('/api/notifications', { token: studentToken });
  assert.ok(visible.data.notifications.some((item) => item.title === notification.title));
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM bale_notification_outbox').get()).n, 1);
});

test('successful login does not reset the IP failed-login throttle', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 9; index += 1) {
    const failed = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: 'incorrect-password' } });
    assert.equal(failed.status, 401);
  }
  const success = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: PASSWORD } });
  assert.equal(success.status, 200);
  const tenthFailure = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: 'incorrect-password' } });
  assert.equal(tenthFailure.status, 401);
  const blocked = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: PASSWORD } });
  assert.equal(blocked.status, 429, 'a successful login must not clear previous failed attempts from this IP');
});

test('oversized login passwords are rejected before password hashing', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: 'x'.repeat(10000) } });
  assert.equal(response.status, 401);
});

test('origin validation rejects requests from an unapproved website', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: PASSWORD }, origin: 'https://not-our-site.example' });
  assert.equal(result.status, 403);
  assert.match(result.data.error, /مبدأ مجاز/);
});

test('origin allowlist accepts multiple exact production origins', async (t) => {
  const f = await fixture(t, `${ORIGIN},https://acm-classroom.ir`);
  const local = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: PASSWORD } });
  const domain = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: PASSWORD }, origin: 'https://acm-classroom.ir' });
  const unlisted = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: PASSWORD }, origin: 'https://unlisted.example' });
  assert.equal(local.status, 200);
  assert.equal(domain.status, 200);
  assert.equal(unlisted.status, 403);
});

test('public signup does not exist and only admin can create accounts', async (t) => {
  const f = await fixture(t);
  const studentToken = await f.login('student.test');
  const denied = await f.request('/api/admin/users', { method: 'POST', token: studentToken, body: { username: 'other.user', displayName: 'Other', role: 'student', password: PASSWORD } });
  assert.equal(denied.status, 403);
  const signup = await f.request('/api/auth/register', { method: 'POST', body: { username: 'open.signup', password: PASSWORD } });
  assert.equal(signup.status, 404);
  const adminToken = await f.login('admin.test');
  const created = await f.request('/api/admin/users', { method: 'POST', token: adminToken, body: { username: 'student.new', displayName: 'New Student', role: 'student', password: PASSWORD } });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.mustChangePassword, true);
});

test('students only see active sessions and published problems; hidden test data stays private', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const testClass = await makeClass(f, teacherToken, { title: 'Loops class', addStudent: true });
  const created = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: testClass.id, title: 'Loops', description: 'Practice loops', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  assert.equal(created.status, 201);
  const sessionId = created.data.session.id;
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, {
    method: 'POST', token: teacherToken,
    body: { title: 'Sum', statement: 'Read two integers and print their sum.', points: 100, timeLimitMs: 1000, comparison: 'tokens', published: true,
      tests: [{ input: '2 3\n', output: '5\n', hidden: false }, { input: 'HIDDEN_CASE_INPUT_987XYZ\n', output: 'HIDDEN_EXPECTED_OUTPUT_987XYZ\n', hidden: true }] },
  });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));
  const studentToken = await f.login('student.test');
  let sessions = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.data.sessions.length, 0, 'inactive session must not be listed');
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  sessions = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(sessions.data.sessions.length, 1);
  const studentSession = await f.request(`/api/student/sessions/${sessionId}`, { token: studentToken });
  assert.equal(studentSession.status, 200);
  assert.equal(studentSession.data.problems.length, 1);
  assert.equal(studentSession.data.problems[0].samples.length, 1);
  assert.equal(JSON.stringify(studentSession.data).includes('HIDDEN_CASE_INPUT_987XYZ'), false, 'hidden input must not leak');
  assert.equal(JSON.stringify(studentSession.data).includes('HIDDEN_EXPECTED_OUTPUT_987XYZ'), false, 'hidden expected output must not leak');
});

test('students cannot manage teacher sessions and teacher isolation is enforced', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const testClass = await makeClass(f, teacherToken, { title: 'Private class' });
  const created = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: testClass.id, title: 'Private session', description: '' } });
  assert.equal(created.status, 201);
  const studentToken = await f.login('student.test');
  const denied = await f.request(`/api/teacher/sessions/${created.data.session.id}`, { token: studentToken });
  assert.equal(denied.status, 403);
  const otherTeacherId = await createUser(f.db, { username: 'teacher.other', displayName: 'Other Teacher', role: 'teacher', password: PASSWORD });
  const otherTeacherToken = await f.login('teacher.other');
  const deniedOther = await f.request(`/api/teacher/sessions/${created.data.session.id}`, { token: otherTeacherToken });
  assert.equal(deniedOther.status, 403);
});

test('students can inspect actual stdout for every public testcase on a partial 2-of-4 submission without hidden-data leakage', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const testClass = await makeClass(f, teacherToken, { title: 'Scoring class', addStudent: true });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: testClass.id, title: 'Active session', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  await f.request(`/api/teacher/sessions/${session.data.session.id}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const problem = await f.request(`/api/teacher/sessions/${session.data.session.id}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Four cases', statement: 'Output values.', points: 100, timeLimitMs: 1000, published: true, comparison: 'tokens',
    tests: [
      { input: 'public input one', output: 'public expected one', hidden: false },
      { input: 'public input two', output: 'public expected two', hidden: false },
      { input: 'HIDDEN_INPUT_3_SECRET', output: 'HIDDEN_EXPECTED_3_SECRET', hidden: true },
      { input: 'HIDDEN_INPUT_4_SECRET', output: 'HIDDEN_EXPECTED_4_SECRET', hidden: true },
    ],
  } });
  const studentToken = await f.login('student.test');
  const submission = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: '__PARTIAL_TWO_OF_FOUR__' } });
  assert.equal(submission.status, 201, JSON.stringify(submission.data));
  assert.equal(submission.data.submission.passedCases, 2);
  assert.equal(submission.data.submission.totalCases, 4);
  assert.equal(submission.data.submission.pointsAwarded, 50);
  assert.equal(submission.data.submission.cases[0].actualOutput, 'ACTUAL_PUBLIC_OUTPUT_1\n');
  assert.equal(submission.data.submission.cases[1].actualOutput, 'ACTUAL_PUBLIC_OUTPUT_2\n');
  assert.equal(submission.data.submission.cases[2].isPublic, undefined);
  const responseJson = JSON.stringify(submission.data);
  for (const secret of ['HIDDEN_INPUT_3_SECRET', 'HIDDEN_INPUT_4_SECRET', 'HIDDEN_EXPECTED_3_SECRET', 'HIDDEN_EXPECTED_4_SECRET', 'HIDDEN_ACTUAL_OUTPUT_3_SECRET', 'HIDDEN_ACTUAL_OUTPUT_4_SECRET', 'HIDDEN_STDERR_SECRET_INPUT_ECHO']) {
    assert.equal(responseJson.includes(secret), false, `student response must not expose ${secret}`);
  }
  const stored = JSON.parse((await f.db.prepare('SELECT details_json FROM submissions WHERE id = ?').get(submission.data.submission.id)).details_json);
  assert.equal(stored.length, 4);
  assert.deepEqual(stored.filter((item) => item.isPublic).map((item) => item.actualOutput), ['ACTUAL_PUBLIC_OUTPUT_1\n', 'ACTUAL_PUBLIC_OUTPUT_2\n']);
  for (const hidden of stored.filter((item) => !item.isPublic)) {
    for (const key of ['input', 'expectedOutput', 'actualOutput', 'error']) assert.equal(key in hidden, false, `hidden testcase must not persist ${key} in student details`);
  }
  const publicResults = await f.request(`/api/student/submissions/${submission.data.submission.id}/results`, { token: studentToken });
  assert.equal(publicResults.status, 200);
  assert.equal(publicResults.data.available, true);
  assert.equal(publicResults.data.tests.length, 2);
  assert.deepEqual(publicResults.data.tests.map((item) => item.actualOutput), ['ACTUAL_PUBLIC_OUTPUT_1\n', 'ACTUAL_PUBLIC_OUTPUT_2\n']);
  assert.equal(JSON.stringify(publicResults.data).includes('HIDDEN_'), false);
  const otherStudentId = await createUser(f.db, { username: 'student.other.outputs', displayName: 'Other Student', role: 'student', password: PASSWORD });
  const otherStudentToken = await f.login('student.other.outputs');
  assert.equal((await f.request(`/api/student/submissions/${submission.data.submission.id}/results`, { token: otherStudentToken })).status, 404);
  assert.equal((await f.request(`/api/student/submissions/${submission.data.submission.id}/results`, { token: teacherToken })).status, 403);
  const adminToken = await f.login('admin.test');
  assert.equal((await f.request(`/api/student/submissions/${submission.data.submission.id}/results`, { token: adminToken })).status, 403);
});

test('admins can create an unrestricted number of additional admin accounts', async (t) => {
  const f = await fixture(t);
  const adminToken = await f.login('admin.test');
  const created = [];
  for (let index = 1; index <= 5; index += 1) {
    const result = await f.request('/api/admin/users', { method: 'POST', token: adminToken, body: {
      username: `admin.extra.${index}`, displayName: `Additional Admin ${index}`, role: 'admin', password: PASSWORD,
    } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.user.role, 'admin');
    created.push(result.data.user);
  }
  const list = await f.request('/api/admin/users', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.users.filter((user) => user.role === 'admin').length, 6);
  const secondAdminToken = await f.login('admin.extra.1');
  const changedPassword = await f.request('/api/auth/change-password', { method: 'POST', token: secondAdminToken, body: { currentPassword: PASSWORD, newPassword: 'New-Admin-Password-123!' } });
  assert.equal(changedPassword.status, 200, JSON.stringify(changedPassword.data));
  const canManage = await f.request('/api/admin/users', { token: secondAdminToken });
  assert.equal(canManage.status, 200, 'a newly created administrator must have full admin access after changing the temporary password');
  const deactivateOriginal = await f.request(`/api/admin/users/${f.adminId}`, { method: 'PATCH', token: secondAdminToken, body: { active: false } });
  assert.equal(deactivateOriginal.status, 200, 'an administrator can be deactivated while other active admins remain');
  for (const admin of created.slice(1)) {
    const deactivated = await f.request(`/api/admin/users/${admin.id}`, { method: 'PATCH', token: secondAdminToken, body: { active: false } });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.data));
  }
  const cannotDeactivateLastAdmin = await f.request(`/api/admin/users/${created[0].id}`, { method: 'PATCH', token: secondAdminToken, body: { active: false } });
  assert.equal(cannotDeactivateLastAdmin.status, 400, 'the system must retain at least one active administrator');
  const remainingAdmins = await f.request('/api/admin/users', { token: secondAdminToken });
  assert.equal(remainingAdmins.data.users.filter((user) => user.role === 'admin' && user.active).length, 1);
});

test('new users are forced to change their temporary password before using the site', async (t) => {
  const f = await fixture(t);
  const adminToken = await f.login('admin.test');
  const made = await f.request('/api/admin/users', { method: 'POST', token: adminToken, body: { username: 'new.student', displayName: 'New Student', role: 'student', password: PASSWORD } });
  assert.equal(made.status, 201);
  const studentToken = await f.login('new.student');
  const denied = await f.request('/api/dashboard', { token: studentToken });
  assert.equal(denied.status, 428);
  const changed = await f.request('/api/auth/change-password', { method: 'POST', token: studentToken, body: { currentPassword: PASSWORD, newPassword: 'New-Strong-Password-123!' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const allowed = await f.request('/api/dashboard', { token: studentToken });
  assert.equal(allowed.status, 200);
  const oldLogin = await f.request('/api/auth/login', { method: 'POST', body: { username: 'new.student', password: PASSWORD } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await f.request('/api/auth/login', { method: 'POST', body: { username: 'new.student', password: 'New-Strong-Password-123!' } });
  assert.equal(newLogin.status, 200);
});

test('teacher classes enforce one class per student and expose Shamsi calendar plus online status', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const adminToken = await f.login('admin.test');

  const made = await f.request('/api/teacher/classes', { method: 'POST', token: teacherToken, body: { title: 'پایتون مقدماتی', description: 'گروه اول' } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const classId = made.data.class.id;
  const second = await f.request('/api/teacher/classes', { method: 'POST', token: teacherToken, body: { title: 'گروه دوم' } });
  assert.equal(second.status, 201);

  const add = await f.request(`/api/teacher/classes/${classId}/members`, { method: 'POST', token: teacherToken, body: { studentId: f.studentId } });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const duplicate = await f.request(`/api/teacher/classes/${second.data.class.id}/members`, { method: 'POST', token: teacherToken, body: { studentId: f.studentId } });
  assert.equal(duplicate.status, 409, 'a student must not be in two classes');

  await f.request('/api/presence/heartbeat', { method: 'POST', token: studentToken, body: {} });
  await f.request('/api/presence/heartbeat', { method: 'POST', token: teacherToken, body: {} });
  const event = await f.request(`/api/teacher/classes/${classId}/events`, { method: 'POST', token: teacherToken, body: { title: 'جلسهٔ حلقه‌ها', description: 'تمرین حلقه for', jalaliDate: '1405/08/12', startTime: '09:30', endTime: '11:00' } });
  assert.equal(event.status, 201, JSON.stringify(event.data));
  assert.equal(event.data.event.jalaliDate, '1405/08/12');

  const detail = await f.request(`/api/teacher/classes/${classId}`, { token: teacherToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.members.length, 1);
  assert.equal(detail.data.members[0].online, true);
  assert.equal(detail.data.events.length, 1);

  const mine = await f.request('/api/student/my-class', { token: studentToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.class.title, 'پایتون مقدماتی');
  assert.equal(mine.data.events[0].jalaliDate, '1405/08/12');
  const presence = await f.request('/api/admin/presence', { token: adminToken });
  assert.equal(presence.status, 200);
  assert.equal(presence.data.users.find((u) => u.id === f.studentId).online, true);
  assert.equal(presence.data.users.find((u) => u.username === 'teacher.test').online, true);

  const otherTeacherId = await createUser(f.db, { username: 'teacher.other', displayName: 'Other Teacher', role: 'teacher', password: PASSWORD });
  const otherTeacherToken = await f.login('teacher.other');
  const forbidden = await f.request(`/api/teacher/classes/${classId}`, { token: otherTeacherToken });
  assert.equal(forbidden.status, 403);
  assert.ok(otherTeacherId);
});

test('coding sessions belong to one class and submissions retain class/session context', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const adminToken = await f.login('admin.test');
  const enrolledClass = await makeClass(f, teacherToken, { title: 'کلاس مجاز', addStudent: true });
  const otherClass = await makeClass(f, teacherToken, { title: 'کلاس دیگر' });
  const invalidSchedule = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: enrolledClass.id, title: 'تاریخ نامعتبر', description: '', jalaliDate: '1405/15/60', startTime: '11:00', endTime: '10:00' } });
  assert.equal(invalidSchedule.status, 400, 'invalid Jalali dates and invalid time ranges must be rejected');

  async function createActiveSession(classId, title) {
    const made = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId, title, description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const sessionId = made.data.session.id;
    const activated = await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
      title: `${title} — سؤال`, statement: 'Print a fixed string.', points: 100, timeLimitMs: 1000, published: true,
      tests: [{ input: '', output: 'class session\n', hidden: false }],
    } });
    assert.equal(problem.status, 201, JSON.stringify(problem.data));
    return { sessionId, problemId: problem.data.problem.id };
  }

  const own = await createActiveSession(enrolledClass.id, 'جلسهٔ کلاس مجاز');
  const foreign = await createActiveSession(otherClass.id, 'جلسهٔ کلاس دیگر');
  const studentSessions = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(studentSessions.status, 200);
  assert.deepEqual(studentSessions.data.sessions.map((s) => s.id), [own.sessionId]);
  assert.equal(studentSessions.data.sessions[0].classTitle, 'کلاس مجاز');
  assert.equal(studentSessions.data.sessions[0].jalaliDate, currentTehranJalaliDate());
  assert.equal(studentSessions.data.sessions[0].startTime, '00:00');
  const studentCalendar = await f.request('/api/student/my-class', { token: studentToken });
  assert.equal(studentCalendar.status, 200);
  assert.equal(studentCalendar.data.sessions.some((item) => item.id === own.sessionId && item.jalaliDate === currentTehranJalaliDate() && item.available === true), true, 'scheduled coding sessions must appear on the student class calendar');
  const teacherClassDetails = await f.request(`/api/teacher/classes/${enrolledClass.id}`, { token: teacherToken });
  assert.equal(teacherClassDetails.data.sessions.find((item) => item.id === own.sessionId).jalaliDate, currentTehranJalaliDate());

  const blockedSession = await f.request(`/api/student/sessions/${foreign.sessionId}`, { token: studentToken });
  assert.equal(blockedSession.status, 404, 'a student must not open a session from another class');
  const blockedProblem = await f.request(`/api/student/problems/${foreign.problemId}`, { token: studentToken });
  assert.equal(blockedProblem.status, 404, 'a student must not open a problem from another class');

  const sent = await f.request(`/api/student/problems/${own.problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: 'print("class session")' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const teacherRows = await f.request('/api/teacher/submissions', { token: teacherToken });
  const teacherRow = teacherRows.data.submissions.find((row) => row.id === sent.data.submission.id);
  assert.equal(teacherRow.classTitle, 'کلاس مجاز');
  assert.equal(teacherRow.sessionTitle, 'جلسهٔ کلاس مجاز');
  assert.equal(teacherRow.problemTitle, 'جلسهٔ کلاس مجاز — سؤال');

  const rescheduled = await f.request(`/api/teacher/sessions/${own.sessionId}`, { method: 'PATCH', token: teacherToken, body: { jalaliDate: '1405/08/13', startTime: '10:00', endTime: '11:30' } });
  assert.equal(rescheduled.status, 200, JSON.stringify(rescheduled.data));
  assert.equal(rescheduled.data.session.jalaliDate, '1405/08/13');
  const updatedCalendar = await f.request('/api/student/my-class', { token: studentToken });
  assert.equal(updatedCalendar.data.sessions.find((item) => item.id === own.sessionId).jalaliDate, '1405/08/13');

  const adminSessions = await f.request('/api/admin/sessions', { token: adminToken });
  assert.equal(adminSessions.status, 200);
  assert.equal(adminSessions.data.sessions.find((row) => row.id === own.sessionId).classTitle, 'کلاس مجاز');
  assert.equal(adminSessions.data.sessions.find((row) => row.id === own.sessionId).jalaliDate, '1405/08/13');
  const adminRows = await f.request('/api/admin/submissions', { token: adminToken });
  assert.equal(adminRows.data.submissions.find((row) => row.id === sent.data.submission.id).classTitle, 'کلاس مجاز');
});

test('scheduled sessions are hidden until the Tehran start time and become reachable at that time', async (t) => {
  const clock = { now: Date.UTC(2026, 9, 30, 8, 0, 0) }; // 11:30 in Tehran, 1405/08/08
  const f = await fixture(t, ORIGIN, clock);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { title: 'Timed class', addStudent: true });
  const created = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: {
    classId: room.id, title: '12 o’clock session', description: '', jalaliDate: '1405/08/08', startTime: '12:00', endTime: '13:00',
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const sessionId = created.data.session.id;
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Timed question', statement: 'Only visible after the scheduled start.', points: 100, timeLimitMs: 1000, published: true,
    tests: [{ input: '', output: 'ok\n', hidden: false }],
  } });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));
  const activated = await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  assert.equal(activated.status, 200, JSON.stringify(activated.data));

  const beforeList = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(beforeList.status, 200);
  assert.equal(beforeList.data.sessions.some((session) => session.id === sessionId), false, 'future sessions are excluded from the enterable sessions list');
  const beforeDirect = await f.request(`/api/student/sessions/${sessionId}`, { token: studentToken });
  assert.equal(beforeDirect.status, 404, 'opening a future session directly must be blocked');
  const beforeProblem = await f.request(`/api/student/problems/${problem.data.problem.id}`, { token: studentToken });
  assert.equal(beforeProblem.status, 404, 'opening a future problem directly must be blocked');
  const beforeCalendar = await f.request('/api/student/my-class', { token: studentToken });
  const calendarEntry = beforeCalendar.data.sessions.find((session) => session.id === sessionId);
  assert.ok(calendarEntry, 'the upcoming session remains visible as a locked calendar item');
  assert.equal(calendarEntry.available, false);

  clock.now = Date.UTC(2026, 9, 30, 8, 30, 0); // exactly 12:00 in Tehran
  const atStartList = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(atStartList.data.sessions.some((session) => session.id === sessionId), true, 'session becomes listable at the scheduled start minute');
  const atStartDirect = await f.request(`/api/student/sessions/${sessionId}`, { token: studentToken });
  assert.equal(atStartDirect.status, 200);
  const atStartProblem = await f.request(`/api/student/problems/${problem.data.problem.id}`, { token: studentToken });
  assert.equal(atStartProblem.status, 200);
  const afterCalendar = await f.request('/api/student/my-class', { token: studentToken });
  assert.equal(afterCalendar.data.sessions.find((session) => session.id === sessionId).available, true);
});

test('sessions remain available for one hour after the scheduled end, then disappear from student calendars', async (t) => {
  const clock = { now: Date.UTC(2026, 9, 29, 6, 0, 0) }; // 09:30 Tehran, 1405/08/07
  const f = await fixture(t, ORIGIN, clock);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { title: 'Session expiry class', addStudent: true });
  const created = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: {
    classId: room.id, title: 'One-hour grace session', description: '', jalaliDate: '1405/08/07', startTime: '09:00', endTime: '10:00',
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const sessionId = created.data.session.id;
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Expiry test problem', statement: 'Print one value.', points: 10, timeLimitMs: 1000, published: true,
    tests: [{ input: '1', output: '1', hidden: false }],
  } });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));

  let visible = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(visible.data.sessions.some((item) => item.id === sessionId), true);
  let calendar = await f.request('/api/student/my-class', { token: studentToken });
  assert.equal(calendar.data.sessions.find((item) => item.id === sessionId).calendarVisible, true);

  clock.now = Date.UTC(2026, 9, 29, 7, 29, 59); // 10:59:59 Tehran; still within the grace period
  visible = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(visible.data.sessions.some((item) => item.id === sessionId), true);
  assert.equal((await f.request(`/api/student/sessions/${sessionId}`, { token: studentToken })).status, 200);

  clock.now = Date.UTC(2026, 9, 29, 7, 30, 0); // exactly 11:00 Tehran; end + one hour
  visible = await f.request('/api/student/sessions', { token: studentToken });
  assert.equal(visible.data.sessions.some((item) => item.id === sessionId), false);
  assert.equal((await f.request(`/api/student/sessions/${sessionId}`, { token: studentToken })).status, 404);
  calendar = await f.request('/api/student/my-class', { token: studentToken });
  assert.equal(calendar.data.sessions.find((item) => item.id === sessionId).calendarVisible, false);
  const teacherClass = await f.request(`/api/teacher/classes/${room.id}`, { token: teacherToken });
  assert.equal(teacherClass.data.sessions.find((item) => item.id === sessionId).calendarVisible, false);
});

test('activating an unscheduled session is rejected', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const room = await makeClass(f, teacherToken, { title: 'Unscheduled class' });
  const created = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'No schedule', description: '' } });
  assert.equal(created.status, 201);
  const activation = await f.request(`/api/teacher/sessions/${created.data.session.id}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  assert.equal(activation.status, 400);
  assert.match(activation.data.error, /تاریخ شمسی/);
});

test('teacher can view submission source for seven days only and expired code is erased', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const testClass = await makeClass(f, teacherToken, { title: 'Retention class', addStudent: true });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: testClass.id, title: 'Retention tests', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  const sessionId = session.data.session.id;
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Source retention', statement: 'print a value', points: 100, timeLimitMs: 1000, published: true,
    tests: [{ input: '', output: 'saved source\n', hidden: false }],
  } });
  const studentToken = await f.login('student.test');
  const submitted = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: 'print("saved source")' } });
  assert.equal(submitted.status, 201);
  const submissionId = submitted.data.submission.id;
  const source = await f.request(`/api/teacher/submissions/${submissionId}/source`, { token: teacherToken });
  assert.equal(source.status, 200, JSON.stringify(source.data));
  assert.equal(source.data.sourceCode, 'print("saved source")');
  assert.ok(Date.parse(source.data.expiresAt) - Date.parse(source.data.createdAt) === 7 * 24 * 60 * 60 * 1000);
  const studentSource = await f.request(`/api/student/submissions/${submissionId}/source`, { token: studentToken });
  assert.equal(studentSource.status, 200, JSON.stringify(studentSource.data));
  assert.equal(studentSource.data.sourceCode, 'print("saved source")');
  assert.ok(Date.parse(studentSource.data.expiresAt) - Date.parse(studentSource.data.createdAt) === 7 * 24 * 60 * 60 * 1000);
  const otherStudentId = await createUser(f.db, { username: 'student.source.other', displayName: 'Other Student', role: 'student', password: PASSWORD });
  const otherStudentToken = await f.login('student.source.other');
  assert.equal((await f.request(`/api/student/submissions/${submissionId}/source`, { token: otherStudentToken })).status, 404);
  const studentList = await f.request('/api/student/submissions', { token: studentToken });
  assert.equal(studentList.data.submissions.find((item) => item.id === submissionId).sourceAvailable, true);

  await f.db.prepare('UPDATE submissions SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), submissionId);
  const expired = await f.request(`/api/teacher/submissions/${submissionId}/source`, { token: teacherToken });
  assert.equal(expired.status, 410);
  const studentExpired = await f.request(`/api/student/submissions/${submissionId}/source`, { token: studentToken });
  assert.equal(studentExpired.status, 410);
  assert.equal((await f.db.prepare('SELECT source_code FROM submissions WHERE id = ?').get(submissionId)).source_code, '');
  const list = await f.request('/api/teacher/submissions', { token: teacherToken });
  assert.equal(list.data.submissions.find((s) => s.id === submissionId).sourceAvailable, false);
});


test('attempt limits are enforced and a solved problem cannot be submitted again', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { title: 'Attempt limit class', addStudent: true });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Attempt limit session', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  const sessionId = session.data.session.id;
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Limited attempts', statement: 'Pass all four tests.', points: 100, attemptLimit: 1, timeLimitMs: 1000, published: true,
    tests: [
      { input: '1', output: '1', hidden: false }, { input: '2', output: '2', hidden: false },
      { input: '3', output: '3', hidden: true }, { input: '4', output: '4', hidden: true },
    ],
  } });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));
  assert.equal(problem.data.problem.attemptLimit, 1);
  const first = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: 'print(1)' } });
  assert.equal(first.status, 201);
  assert.equal(first.data.submission.pointsAwarded, 25);
  const overLimit = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(overLimit.status, 409);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM submissions WHERE problem_id = ? AND student_id = ?').get(problem.data.problem.id, f.studentId)).count, 1);
  const detail = await f.request(`/api/student/problems/${problem.data.problem.id}`, { token: studentToken });
  assert.equal(detail.data.attemptCount, 1);
  assert.equal(detail.data.remainingAttempts, 0);
  assert.equal(detail.data.attempts.length, 1);
});

test('teacher can flag an AI-generated submission, reopen one allowed attempt, notify student, and restore the original score', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { title: 'AI review class', addStudent: true });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: {
    classId: room.id, title: 'AI review session', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59',
  } });
  assert.equal(session.status, 201, JSON.stringify(session.data));
  const sessionId = session.data.session.id;
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'AI review problem', statement: 'Solve this problem.', points: 100, attemptLimit: 1, timeLimitMs: 1000, published: true,
    tests: [{ input: '1', output: '1', hidden: false }],
  } });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));
  const problemId = problem.data.problem.id;
  const first = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.submission.pointsAwarded, 100);
  assert.equal(first.data.submission.accepted, true);
  const submissionId = first.data.submission.id;
  const locked = await f.request(`/api/student/problems/${problemId}`, { token: studentToken });
  assert.equal(locked.data.accepted, true);
  assert.equal(locked.data.remainingAttempts, 0);

  const denied = await f.request(`/api/teacher/submissions/${submissionId}/ai-review`, { method: 'PATCH', token: studentToken, body: { decision: 'flag' } });
  assert.equal(denied.status, 403, 'students must not be able to make moderation decisions');
  const flagged = await f.request(`/api/teacher/submissions/${submissionId}/ai-review`, { method: 'PATCH', token: teacherToken, body: { decision: 'flag', note: 'بازبینی دستی معلم' } });
  assert.equal(flagged.status, 200, JSON.stringify(flagged.data));
  assert.equal(flagged.data.aiFlagged, true);
  assert.equal(flagged.data.pointsAwarded, 0);

  const reopened = await f.request(`/api/student/problems/${problemId}`, { token: studentToken });
  assert.equal(reopened.data.accepted, false, 'flagging must revoke the accepted state');
  assert.equal(reopened.data.attemptCount, 0, 'flagged submissions must not consume the configured attempt quota');
  assert.equal(reopened.data.remainingAttempts, 1);
  assert.equal(reopened.data.bestPoints, 0);
  assert.equal(reopened.data.attempts[0].aiFlagged, true);
  assert.equal(reopened.data.attempts[0].pointsAwarded, 0);
  assert.equal(reopened.data.attempts[0].aiFlagNote, 'بازبینی دستی معلم');
  assert.equal(reopened.data.totalPoints, 0);
  const liveStatus = await f.request(`/api/student/problems/${problemId}/status`, { token: studentToken });
  assert.equal(liveStatus.status, 200);
  assert.equal(liveStatus.data.accepted, false);
  assert.equal(liveStatus.data.attemptCount, 0);
  assert.equal(liveStatus.data.attempts[0].aiFlagged, true);

  const afterReopen = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(afterReopen.status, 201, 'a valid new attempt must be permitted after the AI flag');
  assert.equal(afterReopen.data.submission.accepted, true);
  assert.equal(afterReopen.data.submission.attemptCount, 1);

  const restore = await f.request(`/api/teacher/submissions/${submissionId}/ai-review`, { method: 'PATCH', token: teacherToken, body: { decision: 'restore' } });
  assert.equal(restore.status, 200, JSON.stringify(restore.data));
  assert.equal(restore.data.aiFlagged, false);
  assert.equal(restore.data.pointsAwarded, 100);
  const finalDetail = await f.request(`/api/student/problems/${problemId}`, { token: studentToken });
  assert.equal(finalDetail.data.accepted, true, 'restoring an accepted attempt must restore the solved state');
  assert.equal(finalDetail.data.attempts[0].aiFlagged, false);
  assert.equal(finalDetail.data.attempts[0].pointsAwarded, 100);
  assert.equal(finalDetail.data.bestPoints, 100);
  assert.equal(finalDetail.data.totalPoints, 100, 'the best score must not be duplicated when two accepted attempts exist');

  const inbox = await f.request('/api/notifications', { token: studentToken });
  assert.ok(inbox.data.notifications.some((item) => item.title === 'تشخیص استفاده از هوش مصنوعی در کد ارسالی' && item.message.includes('فرصت حل دوباره')));
  assert.ok(inbox.data.notifications.some((item) => item.title === 'بازگشت تصمیم بررسی کد'));
  const teacherRows = await f.request('/api/teacher/submissions', { token: teacherToken });
  assert.ok(teacherRows.data.submissions.some((item) => item.id === submissionId && item.aiFlagged === false && item.pointsAwarded === 100));
});

test('AI moderation adds no contest penalty; only genuine wrong submissions are charged', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const { room, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Reopened contest question' });

  const startParts = tehranJalaliDateTime(f.clock.now + 180_000);
  const endParts = tehranJalaliDateTime(f.clock.now + 12 * 60 * 60 * 1000);
  const created = await f.request(`/api/teacher/classes/${room.id}/contests`, {
    method: 'POST', token: teacherToken,
    body: {
      title: 'AI reopen penalty contest', description: '',
      startJalaliDate: startParts.date, startTime: startParts.time,
      endJalaliDate: endParts.date, endTime: endParts.time,
      penaltyMinutes: 20, problemIds: [problemId],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const contestId = created.data.contest.id;
  const startAt = Date.parse((await f.db.prepare('SELECT start_at FROM contests WHERE id=?').get(contestId)).start_at);

  // One genuine wrong answer should keep its configured 20-minute penalty.
  f.clock.now = startAt + 60_000;
  const wrong = await f.request(`/api/student/problems/${problemId}/submissions`, {
    method: 'POST', token: studentToken, body: { contestId, code: 'print(0)' },
  });
  assert.equal(wrong.status, 201, JSON.stringify(wrong.data));
  await f.db.prepare('UPDATE submissions SET created_at=? WHERE id=?')
    .run(new Date(startAt + 60_000).toISOString(), wrong.data.submission.id);

  // A successful submission at the beginning is later voided by the teacher.
  f.clock.now = startAt + 5 * 60_000;
  const original = await f.request(`/api/student/problems/${problemId}/submissions`, {
    method: 'POST', token: studentToken, body: { contestId, code: '__ACCEPTED_TEST_ONLY__' },
  });
  assert.equal(original.status, 201, JSON.stringify(original.data));
  const originalId = original.data.submission.id;
  await f.db.prepare('UPDATE submissions SET created_at=? WHERE id=?')
    .run(new Date(startAt + 5 * 60_000).toISOString(), originalId);

  const flagged = await f.request(`/api/teacher/submissions/${originalId}/ai-review`, {
    method: 'PATCH', token: teacherToken, body: { decision: 'flag', note: 'تشخیص هوش مصنوعی' },
  });
  assert.equal(flagged.status, 200, JSON.stringify(flagged.data));

  // Simulate moderation after 432 minutes of contest time, then a new accepted
  // attempt two minutes after the student receives the reopened opportunity.
  const reopenedAt = startAt + 432 * 60_000;
  await f.db.prepare('UPDATE submissions SET ai_flagged_at=? WHERE id=?').run(new Date(reopenedAt).toISOString(), originalId);
  f.clock.now = reopenedAt + 2 * 60_000;
  const retry = await f.request(`/api/student/problems/${problemId}/submissions`, {
    method: 'POST', token: studentToken, body: { contestId, code: '__ACCEPTED_TEST_ONLY__' },
  });
  assert.equal(retry.status, 201, JSON.stringify(retry.data));
  const retryId = retry.data.submission.id;
  await f.db.prepare('UPDATE submissions SET created_at=? WHERE id=?')
    .run(new Date(reopenedAt + 2 * 60_000).toISOString(), retryId);

  const board = await f.request(`/api/student/contests/${contestId}`, { token: studentToken });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  assert.equal(board.data.leaderboard[0].solved, 1);
  assert.equal(board.data.leaderboard[0].wrongAttempts, 1,
    'the genuinely wrong, non-flagged submission must still count');
  assert.equal(board.data.leaderboard[0].penaltyMinutes, 20,
    'the AI-reviewed submission and elapsed time after reopening must add no penalty; only the genuine wrong answer is charged');

  const restored = await f.request(`/api/teacher/submissions/${originalId}/ai-review`, {
    method: 'PATCH', token: teacherToken, body: { decision: 'restore' },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const restoredBoard = await f.request(`/api/student/contests/${contestId}`, { token: studentToken });
  assert.equal(restoredBoard.data.leaderboard[0].points, 100, 'restoring the original AI decision must not duplicate question points');
  assert.equal(restoredBoard.data.leaderboard[0].penaltyMinutes, 20,
    'restoring an AI decision must not introduce elapsed-time penalties; genuine wrong answers remain charged');
});

test('contest penalty is never increased by elapsed time from contest start', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const { room, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Long elapsed contest question' });
  const startParts = tehranJalaliDateTime(f.clock.now + 180_000);
  const endParts = tehranJalaliDateTime(f.clock.now + 48 * 60 * 60 * 1000);
  const created = await f.request(`/api/teacher/classes/${room.id}/contests`, {
    method: 'POST', token: teacherToken,
    body: {
      title: 'Long elapsed contest', description: '',
      startJalaliDate: startParts.date, startTime: startParts.time,
      endJalaliDate: endParts.date, endTime: endParts.time,
      penaltyMinutes: 20, problemIds: [problemId],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const contestId = created.data.contest.id;
  const startAt = Date.parse((await f.db.prepare('SELECT start_at FROM contests WHERE id=?').get(contestId)).start_at);

  f.clock.now = startAt + 60_000;
  const wrong = await f.request(`/api/student/problems/${problemId}/submissions`, {
    method: 'POST', token: studentToken, body: { contestId, code: 'print(0)' },
  });
  assert.equal(wrong.status, 201, JSON.stringify(wrong.data));
  await f.db.prepare('UPDATE submissions SET created_at=? WHERE id=?')
    .run(new Date(startAt + 60_000).toISOString(), wrong.data.submission.id);

  // Reproduce the reported 1,265-minute result: 1,245 minutes of wall time
  // plus one configured 20-minute wrong-answer penalty.
  const acceptedAt = startAt + 1265 * 60_000;
  f.clock.now = acceptedAt;
  const accepted = await f.request(`/api/student/problems/${problemId}/submissions`, {
    method: 'POST', token: studentToken, body: { contestId, code: '__ACCEPTED_TEST_ONLY__' },
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  await f.db.prepare('UPDATE submissions SET created_at=? WHERE id=?')
    .run(new Date(acceptedAt).toISOString(), accepted.data.submission.id);

  const board = await f.request(`/api/student/contests/${contestId}`, { token: studentToken });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  assert.equal(board.data.leaderboard[0].wrongAttempts, 1);
  assert.equal(board.data.leaderboard[0].solved, 1);
  assert.equal(board.data.leaderboard[0].penaltyMinutes, 20,
    '1,245 minutes of elapsed contest time must not be added to the configured 20-minute wrong-submission fee');
});

test('student points use the best score per problem, show full attempt history and lock after accepted', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { title: 'Points class', addStudent: true });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Points session', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  const sessionId = session.data.session.id;
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Four tests', statement: 'Two of four tests grant half credit; all tests grant full credit.', points: 100, attemptLimit: 5, timeLimitMs: 1000, published: true,
    tests: [
      { input: '1', output: '1', hidden: false }, { input: '2', output: '2', hidden: false },
      { input: '3', output: '3', hidden: true }, { input: '4', output: '4', hidden: true },
    ],
  } });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));
  const partial = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: '__PARTIAL_TWO_OF_FOUR__' } });
  assert.equal(partial.status, 201);
  assert.equal(partial.data.submission.passedCases, 2);
  assert.equal(partial.data.submission.pointsAwarded, 50);
  assert.equal(partial.data.submission.totalPoints, 50);
  const accepted = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.submission.pointsAwarded, 100);
  assert.equal(accepted.data.submission.bestPoints, 100);
  assert.equal(accepted.data.submission.totalPoints, 100, 'partial score and accepted score must not add together to 150');
  assert.equal(accepted.data.submission.accepted, true);
  const third = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(third.status, 409);
  assert.equal(third.data.acceptedAlready, true);

  const questionDetail = await f.request(`/api/student/problems/${problem.data.problem.id}`, { token: studentToken });
  assert.equal(questionDetail.data.accepted, true);
  assert.equal(questionDetail.data.attemptCount, 2);
  assert.equal(questionDetail.data.attempts.length, 2, 'all attempts must appear, not just the latest');
  assert.deepEqual(questionDetail.data.attempts.map((attempt) => attempt.pointsAwarded), [50, 100]);
  assert.deepEqual(questionDetail.data.attempts.map((attempt) => attempt.sourceAvailable), [true, true], 'attempt history exposes source availability without returning source text');
  assert.equal('sourceCode' in questionDetail.data.attempts[0], false, 'attempt history must not inline raw source before the explicit view action');
  const firstAttemptCode = await f.request(`/api/student/submissions/${questionDetail.data.attempts[0].id}/source`, { token: studentToken });
  assert.equal(firstAttemptCode.status, 200);
  assert.equal(firstAttemptCode.data.sourceCode, '__PARTIAL_TWO_OF_FOUR__');
  const studentDash = await f.request('/api/dashboard', { token: studentToken });
  assert.equal(studentDash.data.stats.totalPoints, 100);
  const classDetail = await f.request(`/api/teacher/classes/${room.id}`, { token: teacherToken });
  assert.equal(classDetail.data.members.find((member) => member.id === f.studentId).totalPoints, 100);
});


test('client IP uses forwarded address only behind loopback reverse proxy', () => {
  assert.equal(resolveClientIp('127.0.0.1', '203.0.113.12'), '203.0.113.12');
  assert.equal(resolveClientIp('::ffff:127.0.0.1', '2001:db8::12, 127.0.0.1'), '2001:db8::12');
  assert.equal(resolveClientIp('198.51.100.20', '203.0.113.12'), '198.51.100.20', 'untrusted remotes cannot spoof X-Forwarded-For');
  assert.equal(resolveClientIp('127.0.0.1', 'not-an-ip'), '127.0.0.1');
});


test('teacher can delete a session and its dependent questions, tests, and submissions', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { title: 'Delete session class', addStudent: true });
  const made = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Delete me', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  assert.equal(made.status, 201);
  const problem = await f.request(`/api/teacher/sessions/${made.data.session.id}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Dependent question', statement: 'x', points: 100, timeLimitMs: 1000, published: true,
    tests: [{ input: '1', output: '1', hidden: false }],
  } });
  assert.equal(problem.status, 201);
  const activated = await f.request(`/api/teacher/sessions/${made.data.session.id}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  assert.equal(activated.status, 200, JSON.stringify(activated.data));
  const submission = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: 'print(1)' } });
  assert.equal(submission.status, 201);
  const blockedClassDelete = await f.request(`/api/teacher/classes/${room.id}`, { method: 'DELETE', token: teacherToken, body: {} });
  assert.equal(blockedClassDelete.status, 409, 'a class cannot be deleted while it still owns a session');
  const deleted = await f.request(`/api/teacher/sessions/${made.data.session.id}`, { method: 'DELETE', token: teacherToken, body: {} });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM class_sessions WHERE id = ?').get(made.data.session.id)).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM problems WHERE id = ?').get(problem.data.problem.id)).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE id = ?').get(submission.data.submission.id)).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM test_cases WHERE problem_id = ?').get(problem.data.problem.id)).n, 0);
  const deleteClass = await f.request(`/api/teacher/classes/${room.id}`, { method: 'DELETE', token: teacherToken, body: {} });
  assert.equal(deleteClass.status, 200, JSON.stringify(deleteClass.data));
});

test('teacher can export a full session JSON and import all questions/tests into another class', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const sourceClass = await makeClass(f, teacherToken, { title: 'Source class' });
  const destinationClass = await makeClass(f, teacherToken, { title: 'Destination class' });
  const made = await f.request('/api/teacher/sessions', {
    method: 'POST', token: teacherToken,
    body: { classId: sourceClass.id, title: 'Loops and conditions', description: 'A reusable lesson', jalaliDate: '1405/08/12', startTime: '09:30', endTime: '11:00' },
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const sessionId = made.data.session.id;
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, {
    method: 'POST', token: teacherToken,
    body: {
      title: 'Sum two numbers', statement: 'Read two integers and print their sum.', inputFormat: 'Two integers.', outputFormat: 'Their sum.',
      points: 80, attemptLimit: 4, timeLimitMs: 2000, comparison: 'exact', published: true,
      tests: [
        { input: '2 3\n', output: '5\n', hidden: false },
        { input: '10 12\n', output: '22\n', hidden: true },
      ],
    },
  });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));

  const exported = await f.request(`/api/teacher/sessions/${sessionId}/export`, { token: teacherToken });
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  assert.equal(exported.data.format, 'acm-classroom-session');
  assert.equal(exported.data.formatVersion, 1);
  assert.deepEqual(exported.data.session, {
    title: 'Loops and conditions', description: 'A reusable lesson', jalaliDate: '1405/08/12', startTime: '09:30', endTime: '11:00',
  });
  assert.equal(exported.data.problems.length, 1);
  assert.equal(exported.data.problems[0].attemptLimit, 4);
  assert.deepEqual(exported.data.problems[0].tests, [
    { input: '2 3\n', output: '5\n', hidden: false },
    { input: '10 12\n', output: '22\n', hidden: true },
  ]);
  assert.equal('id' in exported.data.problems[0], false, 'portable files must not carry database IDs');

  const imported = await f.request(`/api/teacher/classes/${destinationClass.id}/sessions/import`, {
    method: 'POST', token: teacherToken, body: exported.data,
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  assert.equal(imported.data.session.classId, destinationClass.id);
  assert.equal(imported.data.session.active, false, 'an imported session must remain inactive until the teacher reviews and activates it');
  assert.equal(imported.data.importedProblems, 1);
  assert.notEqual(imported.data.session.id, sessionId);

  const importedDetail = await f.request(`/api/teacher/sessions/${imported.data.session.id}`, { token: teacherToken });
  assert.equal(importedDetail.status, 200);
  assert.equal(importedDetail.data.session.classTitle, 'Destination class');
  assert.equal(importedDetail.data.problems.length, 1);
  assert.equal(importedDetail.data.problems[0].title, 'Sum two numbers');
  assert.equal(importedDetail.data.problems[0].published, true);
  assert.equal(importedDetail.data.problems[0].tests.length, 2);
  assert.equal(importedDetail.data.problems[0].tests[1].hidden, true);
  assert.deepEqual(importedDetail.data.problems[0].tests.map((item) => item.input), ['2 3\n', '10 12\n']);
  assert.equal(importedDetail.data.submissions.length, 0, 'student submission history must not be copied with a reusable session template');

  const countBeforeInvalidImport = (await f.db.prepare('SELECT COUNT(*) AS n FROM class_sessions').get()).n;
  const invalid = await f.request(`/api/teacher/classes/${destinationClass.id}/sessions/import`, {
    method: 'POST', token: teacherToken,
    body: { ...exported.data, problems: [{ ...exported.data.problems[0], tests: [{ input: 'x', output: 'x', hidden: true }] }] },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM class_sessions').get()).n, countBeforeInvalidImport, 'invalid imports must not leave a partial session behind');
});

test('session JSON export and import are restricted to the owning teacher', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const otherTeacherId = await createUser(f.db, { username: 'teacher.other', displayName: 'Other Teacher', role: 'teacher', password: PASSWORD });
  const otherTeacherToken = await f.login('teacher.other');
  const ownClass = await makeClass(f, teacherToken, { title: 'Owned class' });
  const otherClass = await makeClass(f, otherTeacherToken, { title: 'Other class' });
  const session = await f.request('/api/teacher/sessions', {
    method: 'POST', token: teacherToken,
    body: { classId: ownClass.id, title: 'Private export', description: '' },
  });
  assert.equal(session.status, 201);
  const deniedExport = await f.request(`/api/teacher/sessions/${session.data.session.id}/export`, { token: otherTeacherToken });
  assert.equal(deniedExport.status, 403);
  const deniedImport = await f.request(`/api/teacher/classes/${ownClass.id}/sessions/import`, {
    method: 'POST', token: otherTeacherToken,
    body: { format: 'acm-classroom-session', formatVersion: 1, session: { title: 'Copied' }, problems: [] },
  });
  assert.equal(deniedImport.status, 403);
  const invalidVersion = await f.request(`/api/teacher/classes/${otherClass.id}/sessions/import`, {
    method: 'POST', token: otherTeacherToken,
    body: { format: 'acm-classroom-session', formatVersion: 99, session: { title: 'Copied' }, problems: [] },
  });
  assert.equal(invalidVersion.status, 400);
});

function currentTehranJalaliDate() {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}/${String(value('month')).padStart(2, '0')}/${String(value('day')).padStart(2, '0')}`;
}
function tehranJalaliDateTime(epoch) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epoch));
  const value = (type) => parts.find((part) => part.type === type)?.value || '00';
  return { date: `${value('year')}/${value('month')}/${value('day')}`, time: `${value('hour')}:${value('minute')}` };
}

async function makeActiveProblem(f, teacherToken, { title = 'Scale test problem', studentId = null, points = 100 } = {}) {
  const room = await makeClass(f, teacherToken, { title: `${title} class`, addStudent: true });
  if (studentId && studentId !== f.studentId) {
    const member = await f.request(`/api/teacher/classes/${room.id}/members`, { method: 'POST', token: teacherToken, body: { studentId } });
    assert.equal(member.status, 201, JSON.stringify(member.data));
  }
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: {
    classId: room.id, title: `${title} session`, description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59',
  } });
  assert.equal(session.status, 201, JSON.stringify(session.data));
  const sessionId = session.data.session.id;
  const activated = await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  assert.equal(activated.status, 200, JSON.stringify(activated.data));
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title, statement: 'Solve the task.', points, attemptLimit: 0, timeLimitMs: 1000, published: true,
    tests: [
      { input: '1', output: '1', hidden: false }, { input: '2', output: '2', hidden: false },
      { input: '3', output: '3', hidden: true }, { input: '4', output: '4', hidden: true },
    ],
  } });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));
  return { room, sessionId, problemId: problem.data.problem.id };
}

test('student report card returns analytical metrics, class rank, session progress, and recent activity', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const otherId = await createUser(f.db, { username: 'student.other', displayName: 'Other Student', role: 'student', password: PASSWORD });
  const { room, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Report card question', studentId: otherId });
  const partial = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: '__PARTIAL_TWO_OF_FOUR__' } });
  assert.equal(partial.status, 201);
  const report = await f.request('/api/student/report-card', { token: studentToken });
  assert.equal(report.status, 200);
  assert.equal(report.data.report.totalPoints, 50);
  assert.equal(report.data.report.attempts, 1);
  assert.equal(report.data.report.solvedProblems, 0);
  assert.equal(report.data.report.class.id, room.id);
  assert.equal(report.data.report.class.rank, 1);
  assert.equal(report.data.report.class.size, 2);
  assert.equal(report.data.report.sessions[0].problemCount, 1);
  assert.equal(report.data.report.sessions[0].progress, 0);
  assert.equal(report.data.report.activity.length, 1);
});

test('class leaderboard is class-scoped and student points survive a transfer between teachers', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const { room, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Transfer score question', points: 100 });
  const studentToken = await f.login('student.test');
  const accepted = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));

  const beforeMove = await f.request(`/api/teacher/classes/${room.id}`, { token: teacherToken });
  assert.equal(beforeMove.status, 200);
  assert.deepEqual(beforeMove.data.leaderboard.map((row) => [row.studentId, row.rank, row.points]), [[f.studentId, 1, 100]]);

  // A teacher's second class has its own independent ranking, not a combined roster.
  const peerStudentId = await createUser(f.db, { username: 'student.peer', displayName: 'Peer Student', role: 'student', password: PASSWORD });
  const secondClass = await makeClass(f, teacherToken, { title: 'Second class' });
  const secondClassMember = await f.request(`/api/teacher/classes/${secondClass.id}/members`, { method: 'POST', token: teacherToken, body: { studentId: peerStudentId } });
  assert.equal(secondClassMember.status, 201);
  const secondClassDetail = await f.request(`/api/teacher/classes/${secondClass.id}`, { token: teacherToken });
  assert.deepEqual(secondClassDetail.data.leaderboard.map((row) => row.studentId), [peerStudentId]);
  assert.equal(secondClassDetail.data.members.length, 1);

  await createUser(f.db, { username: 'teacher.transfer', displayName: 'Next Teacher', role: 'teacher', password: PASSWORD });
  const nextTeacherToken = await f.login('teacher.transfer');
  const nextClass = await makeClass(f, nextTeacherToken, { title: 'Transferred student class' });
  const removed = await f.request(`/api/teacher/classes/${room.id}/members/${f.studentId}`, { method: 'DELETE', token: teacherToken, body: {} });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const added = await f.request(`/api/teacher/classes/${nextClass.id}/members`, { method: 'POST', token: nextTeacherToken, body: { studentId: f.studentId } });
  assert.equal(added.status, 201, JSON.stringify(added.data));

  const afterMove = await f.request(`/api/teacher/classes/${nextClass.id}`, { token: nextTeacherToken });
  assert.equal(afterMove.status, 200);
  assert.equal(afterMove.data.members.length, 1, 'the destination class ranks only its own member');
  assert.equal(afterMove.data.members[0].rank, 1);
  assert.equal(afterMove.data.members[0].totalPoints, 100, 'the teacher sees points earned before the transfer');
  assert.equal(afterMove.data.leaderboard[0].points, 100);

  const report = await f.request('/api/student/report-card', { token: studentToken });
  assert.equal(report.data.report.totalPoints, 100, 'the student report keeps the same total');
  assert.equal(report.data.report.class.rank, 1, "the student's new class rank is recomputed in the destination class");
  assert.equal(report.data.report.class.id, nextClass.id);
  assert.ok(report.data.report.sessions.some((session) => session.classTitle === room.title), 'historical learning from the previous class remains in the individual report');

  const adminToken = await f.login('admin.test');
  const global = await f.request('/api/admin/leaderboard', { token: adminToken });
  assert.equal(global.status, 200);
  assert.equal(global.data.leaderboard.find((row) => row.studentId === f.studentId).points, 100);
  assert.equal(global.data.leaderboard[0].studentId, f.studentId);
  assert.equal((await f.request('/api/admin/leaderboard', { token: teacherToken })).status, 403);
  assert.equal((await f.request('/api/admin/leaderboard', { token: studentToken })).status, 403);
});

test('notifications are user-private, support read state, and are generated for learning events', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const otherId = await createUser(f.db, { username: 'student.other', displayName: 'Other Student', role: 'student', password: PASSWORD });
  const room = await makeClass(f, teacherToken, { title: 'Notification class', addStudent: true });
  const addOther = await f.request(`/api/teacher/classes/${room.id}/members`, { method: 'POST', token: teacherToken, body: { studentId: otherId } });
  assert.equal(addOther.status, 201);
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Notification session', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  const sessionId = session.data.session.id;
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const createdProblem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Notification problem', statement: 'Solve.', points: 100, timeLimitMs: 1000, published: true,
    tests: [{ input: '', output: 'ok', hidden: false }],
  } });
  assert.equal(createdProblem.status, 201);
  const studentInbox = await f.request('/api/notifications', { token: studentToken });
  assert.equal(studentInbox.status, 200);
  assert.ok(studentInbox.data.notifications.some((n) => n.title.includes('جلسه')));
  assert.ok(studentInbox.data.notifications.some((n) => n.title.includes('سؤال')));
  assert.ok(studentInbox.data.unread >= 2);
  const unreadItem = studentInbox.data.notifications.find((n) => !n.readAt);
  const marked = await f.request(`/api/notifications/${unreadItem.id}/read`, { method: 'PATCH', token: studentToken, body: {} });
  assert.equal(marked.status, 200);
  const teacherInboxBefore = await f.request('/api/notifications', { token: teacherToken });
  assert.equal(teacherInboxBefore.data.unread, 0);
  const submit = await f.request(`/api/student/problems/${createdProblem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: '__PARTIAL_TWO_OF_FOUR__' } });
  assert.equal(submit.status, 201);
  const teacherInboxAfter = await f.request('/api/notifications', { token: teacherToken });
  assert.ok(teacherInboxAfter.data.notifications.some((n) => n.title === 'ارسال کد جدید'));
  await f.request('/api/notifications/read-all', { method: 'POST', token: teacherToken, body: {} });
  assert.equal((await f.request('/api/notifications', { token: teacherToken })).data.unread, 0);
  const otherInbox = await f.request('/api/notifications', { token: (await f.login('student.other')) });
  assert.equal(otherInbox.data.notifications.length, 2, 'notifications are sent only to class members');
});

test('code drafts are saved on the server, restored after reload, private, and cleared after acceptance', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const { problemId } = await makeActiveProblem(f, teacherToken, { title: 'Draft restore problem' });
  const saved = await f.request(`/api/student/problems/${problemId}/draft`, { method: 'PUT', token: studentToken, body: { code: 'print("draft survives reload")' } });
  assert.equal(saved.status, 200);
  const restored = await f.request(`/api/student/problems/${problemId}`, { token: studentToken });
  assert.equal(restored.data.draft.sourceCode, 'print("draft survives reload")');
  const denied = await f.request(`/api/student/problems/${problemId}/draft`, { method: 'PUT', token: teacherToken, body: { code: 'steal draft' } });
  assert.equal(denied.status, 403);
  const accepted = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(accepted.status, 201);
  const draftCount = (await f.db.prepare('SELECT COUNT(*) AS n FROM code_drafts WHERE student_id=? AND problem_id=?').get(f.studentId, problemId)).n;
  assert.equal(draftCount, 0);
});

test('student can compare two own attempts while code is retained, but cannot read another student source', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const otherId = await createUser(f.db, { username: 'student.other', displayName: 'Other Student', role: 'student', password: PASSWORD });
  const { room, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Compare attempts problem', studentId: otherId });
  const first = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: 'print("first attempt")' } });
  const second = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: 'print("second attempt")' } });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const compare = await f.request(`/api/student/problems/${problemId}/compare?left=${first.data.submission.id}&right=${second.data.submission.id}`, { token: studentToken });
  assert.equal(compare.status, 200);
  assert.equal(compare.data.left.sourceCode, 'print("first attempt")');
  assert.equal(compare.data.right.sourceCode, 'print("second attempt")');
  const forged = await f.request(`/api/student/problems/${problemId}/compare?left=${first.data.submission.id}&right=${second.data.submission.id}`, { token: await f.login('student.other') });
  assert.equal(forged.status, 404);
});

test('question bank is shared with author attribution; only its author can edit/delete and all teachers can copy', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const otherTeacherId = await createUser(f.db, { username: 'teacher.bank.other', displayName: 'Other Teacher', role: 'teacher', password: PASSWORD });
  const otherTeacherToken = await f.login('teacher.bank.other');
  const room = await makeClass(f, teacherToken, { title: 'Question Bank destination' });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Bank destination session', description: '' } });
  assert.equal(session.status, 201);

  const created = await f.request('/api/teacher/question-bank', { method: 'POST', token: teacherToken, body: {
    title: 'Banked sum', statement: 'Read two numbers and print their sum.', points: 70, attemptLimit: 4, timeLimitMs: 1000, comparison: 'tokens',
    tests: [{ input: '2 3\n', output: '5\n', hidden: false }, { input: '10 12\n', output: '22\n', hidden: true }],
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const questionId = created.data.question.id;
  const list = await f.request('/api/teacher/question-bank', { token: teacherToken });
  assert.equal(list.data.questions.length, 1);
  assert.equal(list.data.questions[0].testCount, 2);
  const details = await f.request(`/api/teacher/question-bank/${questionId}`, { token: teacherToken });
  assert.equal(details.data.question.tests[1].hidden, true);
  const sharedList = await f.request('/api/teacher/question-bank', { token: otherTeacherToken });
  assert.equal(sharedList.data.questions.length, 1);
  assert.equal(sharedList.data.questions[0].authorId, f.teacherId);
  assert.equal(sharedList.data.questions[0].authorName, 'Teacher');
  assert.equal((await f.request(`/api/teacher/question-bank/${questionId}`, { token: otherTeacherToken })).status, 200);
  assert.equal((await f.request(`/api/teacher/question-bank/${questionId}`, { method: 'PATCH', token: otherTeacherToken, body: { title: 'Unauthorized edit' } })).status, 404);
  assert.equal((await f.request(`/api/teacher/question-bank/${questionId}`, { method: 'DELETE', token: otherTeacherToken, body: {} })).status, 404);

  const updated = await f.request(`/api/teacher/question-bank/${questionId}`, { method: 'PATCH', token: teacherToken, body: { title: 'Banked sum edited' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.question.title, 'Banked sum edited');
  const otherRoom = await makeClass(f, otherTeacherToken, { title: 'Other teacher destination' });
  const otherSession = await f.request('/api/teacher/sessions', { method: 'POST', token: otherTeacherToken, body: { classId: otherRoom.id, title: 'Other teacher session', description: '' } });
  const sharedCopy = await f.request(`/api/teacher/question-bank/${questionId}/copy-to-session`, { method: 'POST', token: otherTeacherToken, body: { sessionId: otherSession.data.session.id } });
  assert.equal(sharedCopy.status, 201, JSON.stringify(sharedCopy.data));
  const copied = await f.request(`/api/teacher/question-bank/${questionId}/copy-to-session`, { method: 'POST', token: teacherToken, body: { sessionId: session.data.session.id } });
  assert.equal(copied.status, 201, JSON.stringify(copied.data));
  assert.equal(copied.data.problem.published, false, 'copied bank question must start as a draft');
  assert.equal(copied.data.problem.sourceBankId, questionId, 'copied session problem keeps the shared bank source identifier');
  const copiedDetail = await f.request(`/api/teacher/sessions/${session.data.session.id}`, { token: teacherToken });
  assert.equal(copiedDetail.data.problems[0].tests.length, 2);
  assert.equal(copiedDetail.data.problems[0].tests[1].hidden, true);
  assert.equal(copiedDetail.data.problems[0].sourceBankId, questionId, 'session details expose source id so the teacher UI can prevent duplicate imports');

  const deleted = await f.request(`/api/teacher/question-bank/${questionId}`, { method: 'DELETE', token: teacherToken, body: {} });
  assert.equal(deleted.status, 200);
  assert.equal((await f.request('/api/teacher/question-bank', { token: teacherToken })).data.questions.length, 0);
  assert.equal((await f.request(`/api/teacher/sessions/${session.data.session.id}`, { token: teacherToken })).data.problems.length, 1, 'deleting the bank template must not delete the copied session problem');
  const excludedCopies = await f.db.prepare('SELECT source_bank_id, bank_opt_out FROM problems WHERE source_bank_id IS NULL AND bank_opt_out=1').all();
  assert.equal(excludedCopies.length, 2, 'deleting a template marks all already-created copies as intentionally excluded from automatic bank migration');
  assert.equal((await f.request(`/api/teacher/sessions/${otherSession.data.session.id}`, { token: otherTeacherToken })).data.problems.length, 1);
});

test('database upgrade promotes legacy session questions to the shared bank and avoids exact duplicates', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-bank-migration-'));
  const dbPath = path.join(dir, 'legacy.sqlite');
  let db = openSqliteTestDatabase({ dbPath });
  t.after(async () => { try { await db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const teacherId = await createUser(db, { username: 'teacher.legacy', displayName: 'Legacy Teacher', role: 'teacher', password: PASSWORD });
  const stamp = new Date().toISOString();
  await db.prepare('INSERT INTO teacher_classes(id,teacher_id,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('legacy-class', teacherId, 'Legacy class', '', stamp, stamp);
  await db.prepare(`INSERT INTO class_sessions(id,class_id,jalali_date,start_time,end_time,title,description,active,created_by,created_at,updated_at)
    VALUES(?, ?, NULL, NULL, NULL, ?, '', 0, ?, ?, ?)`)
    .run('legacy-session', 'legacy-class', 'Legacy session', teacherId, stamp, stamp);
  await db.prepare(`INSERT INTO question_bank(id,teacher_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('legacy-bank-duplicate', teacherId, 'Existing template', 'Print the sum', '', '', 100, 0, 1000, 'tokens', stamp, stamp);
  await db.prepare('INSERT INTO question_bank_tests(id,bank_question_id,input_text,expected_output,hidden,position) VALUES(?,?,?,?,?,?)')
    .run('legacy-bank-test', 'legacy-bank-duplicate', '2 3\n', '5\n', 0, 0);
  const insertProblem = await db.prepare(`INSERT INTO problems(id,session_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,published,position,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  await insertProblem.run('legacy-problem-match', 'legacy-session', 'Existing template', 'Print the sum', '', '', 100, 0, 1000, 'tokens', 0, 0, stamp, stamp);
  await db.prepare('INSERT INTO test_cases(id,problem_id,input_text,expected_output,hidden,position) VALUES(?,?,?,?,?,?)').run('legacy-case-match', 'legacy-problem-match', '2 3\n', '5\n', 0, 0);
  await insertProblem.run('legacy-problem-new', 'legacy-session', 'New legacy question', 'Print a value', '', '', 50, 2, 1000, 'tokens', 0, 1, stamp, stamp);
  await db.prepare('INSERT INTO test_cases(id,problem_id,input_text,expected_output,hidden,position) VALUES(?,?,?,?,?,?)').run('legacy-case-new', 'legacy-problem-new', '', 'ok\n', 0, 0);
  await db.close();
  db = openSqliteTestDatabase({ dbPath });
  const matched = await db.prepare('SELECT source_bank_id FROM problems WHERE id=?').get('legacy-problem-match');
  assert.equal(matched.source_bank_id, 'legacy-bank-duplicate', 'an exact same-teacher bank entry should be reused');
  const promoted = await db.prepare('SELECT id,origin_problem_id,teacher_id FROM question_bank WHERE origin_problem_id=?').get('legacy-problem-new');
  assert.ok(promoted);
  assert.equal(promoted.teacher_id, teacherId);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM question_bank').get()).n, 2, 'legacy migration should not create an unnecessary duplicate');
  assert.equal((await db.prepare('SELECT source_bank_id FROM problems WHERE id=?').get('legacy-problem-new')).source_bank_id, promoted.id);
});

test('questions created inside sessions are automatically added to the shared bank with the session teacher as author', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const otherTeacherId = await createUser(f.db, { username: 'teacher.shared.viewer', displayName: 'Shared Viewer', role: 'teacher', password: PASSWORD });
  const otherTeacherToken = await f.login('teacher.shared.viewer');
  const room = await makeClass(f, teacherToken, { title: 'Auto-bank class' });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Auto-bank session', description: '' } });
  const created = await f.request(`/api/teacher/sessions/${session.data.session.id}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Created in session', statement: 'Print the sum.', points: 80, attemptLimit: 4, timeLimitMs: 1000, comparison: 'tokens', published: false,
    tests: [{ input: '2 3\n', output: '5\n', hidden: false }, { input: '10 12\n', output: '22\n', hidden: true }],
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const linkedBankId = (await f.db.prepare('SELECT source_bank_id FROM problems WHERE id = ?').get(created.data.problem.id))?.source_bank_id;
  assert.ok(linkedBankId, 'the persisted session problem must be linked to its shared-bank entry');
  const shared = await f.request('/api/teacher/question-bank', { token: otherTeacherToken });
  const entry = shared.data.questions.find((item) => item.title === 'Created in session');
  assert.ok(entry, 'session-created question must appear in shared bank');
  assert.equal(entry.authorId, f.teacherId);
  assert.equal(entry.authorName, 'Teacher');
  assert.equal(entry.testCount, 2);
  const details = await f.request(`/api/teacher/question-bank/${entry.id}`, { token: otherTeacherToken });
  assert.equal(details.status, 200);
  assert.equal(details.data.question.tests[1].hidden, true);

  const updated = await f.request(`/api/teacher/problems/${created.data.problem.id}`, { method: 'PATCH', token: teacherToken, body: { title: 'Updated from session', tests: [{ input: '4 5\n', output: '9\n', hidden: false }] } });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  const refreshed = await f.request(`/api/teacher/question-bank/${entry.id}`, { token: otherTeacherToken });
  assert.equal(refreshed.data.question.title, 'Updated from session');
  assert.deepEqual(refreshed.data.question.tests, [{ input: '4 5\n', output: '9\n', hidden: false }]);

  const importedSession = await f.request(`/api/teacher/classes/${room.id}/sessions/import`, { method: 'POST', token: teacherToken, body: {
    format: 'acm-classroom-session', formatVersion: 1,
    session: { title: 'Imported question session', description: '', jalaliDate: '', startTime: '', endTime: '' },
    problems: [{ title: 'Imported question', statement: 'Imported statement', points: 50, timeLimitMs: 1000, tests: [{ input: '', output: 'ok\n', hidden: false }] }],
  } });
  assert.equal(importedSession.status, 201, JSON.stringify(importedSession.data));
  const afterImport = await f.request('/api/teacher/question-bank', { token: otherTeacherToken });
  assert.equal(afterImport.data.questions.some((item) => item.title === 'Imported question' && item.authorId === f.teacherId), true);
  assert.ok(otherTeacherId);
});

test('teacher can preview every public and hidden testcase without creating submissions or leaking testcase payloads', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const room = await makeClass(f, teacherToken, { title: 'Preview tests' });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Preview session', description: '' } });
  const payload = {
    code: 'print(1)', timeLimitMs: 1200, comparison: 'exact',
    tests: [
      { input: 'public input', output: 'public output', hidden: false },
      { input: 'secret hidden input', output: 'secret hidden output', hidden: true },
      { input: 'another hidden input', output: 'another hidden output', hidden: true },
    ],
  };
  const before = (await f.db.prepare('SELECT COUNT(*) AS n FROM submissions').get()).n;
  const preview = await f.request('/api/teacher/question-bank/preview', { method: 'POST', token: teacherToken, body: payload });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.totalCases, 3);
  assert.deepEqual(preview.data.cases.map((item) => item.hidden), [false, true, true]);
  assert.deepEqual(preview.data.cases.map((item) => item.passed), [true, false, false]);
  assert.equal(JSON.stringify(preview.data).includes('secret hidden input'), false);
  assert.equal(JSON.stringify(preview.data).includes('secret hidden output'), false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM submissions').get()).n, before, 'preview must not persist a submission or award points');
  assert.equal((await f.request('/api/teacher/question-bank/preview', { method: 'POST', token: studentToken, body: payload })).status, 403);
  assert.equal((await f.request('/api/teacher/question-bank/preview', { method: 'POST', token: teacherToken, body: { ...payload, tests: [] } })).status, 400);
  assert.equal(session.status, 201);
});

test('teacher can delete a question and its dependent tests, drafts, submissions and contest references', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const { room, sessionId, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Question to delete' });
  const studentToken = await f.login('student.test');
  const submission = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: 'print(1)' } });
  assert.equal(submission.status, 201);
  const deleted = await f.request(`/api/teacher/problems/${problemId}`, { method: 'DELETE', token: teacherToken, body: {} });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.deletedSubmissions, 1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM problems WHERE id=?').get(problemId)).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM test_cases WHERE problem_id=?').get(problemId)).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE problem_id=?').get(problemId)).n, 0);
  await createUser(f.db, { username: 'teacher.delete.other', displayName: 'Other Teacher', role: 'teacher', password: PASSWORD });
  const denied = await f.request(`/api/teacher/problems/${problemId}`, { method: 'DELETE', token: await f.login('teacher.delete.other'), body: {} });
  assert.equal(denied.status, 404);
});

test('teacher can edit the session title and description without changing its schedule or active state', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const room = await makeClass(f, teacherToken, { title: 'Session edit class' });
  const created = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Old title', description: 'Old description', jalaliDate: '1405/08/12', startTime: '09:00', endTime: '11:00' } });
  assert.equal(created.status, 201);
  const sessionId = created.data.session.id;
  const edited = await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { title: 'New title', description: 'New description' } });
  assert.equal(edited.status, 200);
  const details = await f.request(`/api/teacher/sessions/${sessionId}`, { token: teacherToken });
  assert.equal(details.data.session.title, 'New title');
  assert.equal(details.data.session.description, 'New description');
  assert.equal(details.data.session.jalaliDate, '1405/08/12');
  assert.equal(details.data.session.startTime, '09:00');
});

test('contest mode reserves problems, reveals them only during contest, and produces final leaderboard', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const { room, sessionId, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Contest problem' });
  // Prior practice attempts must not consume a student's contest-specific attempt budget.
  const practiceAttempt = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(practiceAttempt.status, 201);
  const startParts = tehranJalaliDateTime(f.clock.now + 180_000); const endParts = tehranJalaliDateTime(f.clock.now + 3_600_000);
  const invalidContest = await f.request(`/api/teacher/classes/${room.id}/contests`, { method: 'POST', token: teacherToken, body: {
    title: 'Bad date', description: '', startJalaliDate: '1405/13/40', startTime: '10:00', endJalaliDate: '1405/08/12', endTime: '11:00', penaltyMinutes: 0, problemIds: [problemId],
  } });
  assert.equal(invalidContest.status, 400, 'contest dates must be real Jalali dates');
  const contest = await f.request(`/api/teacher/classes/${room.id}/contests`, { method: 'POST', token: teacherToken, body: {
    title: 'First classroom contest', description: 'Contest test', startJalaliDate: startParts.date, startTime: startParts.time,
    endJalaliDate: endParts.date, endTime: endParts.time, penaltyMinutes: 10, problemIds: [problemId],
  } });
  assert.equal(contest.status, 201, JSON.stringify(contest.data));
  const contestId = contest.data.contest.id;
  const storedContest = await f.db.prepare('SELECT start_at,end_at FROM contests WHERE id=?').get(contestId);
  const storedStartParts = tehranJalaliDateTime(Date.parse(storedContest.start_at));
  const storedEndParts = tehranJalaliDateTime(Date.parse(storedContest.end_at));
  assert.equal(storedStartParts.date, startParts.date);
  assert.equal(storedStartParts.time, startParts.time);
  assert.equal(storedEndParts.date, endParts.date);
  assert.equal(storedEndParts.time, endParts.time);
  const start = Date.parse(storedContest.start_at); const end = Date.parse(storedContest.end_at);
  const studentContests = await f.request('/api/student/contests', { token: studentToken });
  assert.equal(studentContests.data.contests[0].status, 'scheduled');
  assert.equal(studentContests.data.contests[0].problemCount, 1);
  const scheduled = await f.request(`/api/student/contests/${contestId}`, { token: studentToken });
  assert.equal(scheduled.data.problems.length, 0);
  const normalSession = await f.request(`/api/student/sessions/${sessionId}`, { token: studentToken });
  assert.equal(normalSession.data.problems.some((p) => p.id === problemId), false, 'reserved problems must not leak into ordinary practice');
  const normalProblem = await f.request(`/api/student/problems/${problemId}`, { token: studentToken });
  assert.equal(normalProblem.status, 404);
  f.clock.now = start + 1000;
  const active = await f.request(`/api/student/contests/${contestId}`, { token: studentToken });
  assert.equal(active.data.contest.status, 'active');
  assert.equal(active.data.problems.length, 1);
  const access = await f.request(`/api/student/problems/${problemId}?contestId=${contestId}`, { token: studentToken });
  assert.equal(access.status, 200);
  assert.equal(access.data.accepted, false, 'a practice acceptance must not mark the contest attempt as already solved');
  assert.equal(access.data.attemptCount, 0, 'contest attempts start with a separate attempt counter');
  const submission = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { contestId, code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(submission.status, 201);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM contest_submissions WHERE contest_id=?').get(contestId)).n, 1);
  f.clock.now = end + 1000;
  const ended = await f.request(`/api/student/contests/${contestId}`, { token: studentToken });
  assert.equal(ended.data.contest.status, 'ended');
  assert.equal(ended.data.leaderboard[0].points, 100);
  assert.equal(ended.data.leaderboard[0].solved, 1);
});

test('independent contests snapshot shared-bank questions and invite students across every class', async (t) => {
  const f = await fixture(t, ORIGIN, { now: Date.now() });
  const teacherToken = await f.login('teacher.test');
  const otherTeacherId = await createUser(f.db, { username: 'teacher.external', displayName: 'External Teacher', role: 'teacher', password: PASSWORD });
  const otherTeacherToken = await f.login('teacher.external');
  const externalStudentId = await createUser(f.db, { username: 'student.external', displayName: 'External Student', role: 'student', password: PASSWORD });
  const uninvitedStudentId = await createUser(f.db, { username: 'student.uninvited', displayName: 'Uninvited Student', role: 'student', password: PASSWORD });
  const externalClass = await makeClass(f, otherTeacherToken, { title: 'Another teacher class' });
  const enrolled = await f.request(`/api/teacher/classes/${externalClass.id}/members`, { method: 'POST', token: otherTeacherToken, body: { studentId: externalStudentId } });
  assert.equal(enrolled.status, 201);

  const bankQuestion = await f.request('/api/teacher/question-bank', { method: 'POST', token: teacherToken, body: {
    title: 'Shared bank contest question', statement: 'Print the expected answer.', points: 80, attemptLimit: 5, timeLimitMs: 1200, comparison: 'tokens',
    tests: [{ input: '1 2\n', output: '3\n', hidden: false }, { input: '9 8\n', output: '17\n', hidden: true }],
  } });
  assert.equal(bankQuestion.status, 201, JSON.stringify(bankQuestion.data));

  const startParts = tehranJalaliDateTime(f.clock.now + 180_000);
  const endParts = tehranJalaliDateTime(f.clock.now + 3_600_000);
  const created = await f.request('/api/teacher/contests', { method: 'POST', token: teacherToken, body: {
    title: 'Cross-class open contest', description: 'A contest not tied to any class',
    startJalaliDate: startParts.date, startTime: startParts.time, endJalaliDate: endParts.date, endTime: endParts.time,
    penaltyMinutes: 7, freezeMinutes: 5, bankQuestionIds: [bankQuestion.data.question.id], studentIds: [f.studentId, externalStudentId],
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.contest.participantCount, 2);
  const contestId = created.data.contest.id;
  const stored = await f.db.prepare(`SELECT c.class_id,s.class_id AS session_class_id,s.is_contest,p.id AS problem_id,p.title
    FROM contests c JOIN contest_problems cp ON cp.contest_id=c.id JOIN problems p ON p.id=cp.problem_id
    JOIN class_sessions s ON s.id=p.session_id WHERE c.id=?`).get(contestId);
  assert.equal(stored.class_id, null, 'the contest itself must not reference a class');
  assert.equal(stored.session_class_id, null, 'contest backing session must not reference a class');
  assert.equal(stored.is_contest, 1);
  assert.equal(stored.title, 'Shared bank contest question');
  const snapshotTests = await f.db.prepare('SELECT input_text,expected_output,hidden FROM test_cases WHERE problem_id=? ORDER BY position').all(stored.problem_id);
  assert.equal(snapshotTests.length, 2);
  assert.equal(snapshotTests[1].expected_output, '17\n');
  assert.equal(snapshotTests[1].hidden, 1);

  const editedBank = await f.request(`/api/teacher/question-bank/${bankQuestion.data.question.id}`, { method: 'PATCH', token: teacherToken, body: {
    title: 'Changed after scheduling', tests: [{ input: '1 2\n', output: '999\n', hidden: false }],
  } });
  assert.equal(editedBank.status, 200);
  const unchangedSnapshot = await f.db.prepare(`SELECT p.title,t.expected_output FROM problems p JOIN test_cases t ON t.problem_id=p.id
    WHERE p.id=? ORDER BY t.position LIMIT 1`).get(stored.problem_id);
  assert.equal(unchangedSnapshot.title, 'Shared bank contest question');
  assert.equal(unchangedSnapshot.expected_output, '3\n', 'editing the bank after creation must not alter the contest snapshot');

  const allStudents = await f.request('/api/teacher/contest-students', { token: teacherToken });
  assert.equal(allStudents.status, 200);
  assert.ok(allStudents.data.students.some((student) => student.id === externalStudentId && student.classTitle === 'Another teacher class'));
  assert.ok(allStudents.data.students.some((student) => student.id === uninvitedStudentId));
  const contestList = await f.request('/api/teacher/contests', { token: teacherToken });
  assert.equal(contestList.data.contests[0].participantCount, 2);
  const details = await f.request(`/api/teacher/contests/${contestId}`, { token: teacherToken });
  assert.equal(details.status, 200);
  assert.equal(details.data.participants.length, 2);
  assert.equal(details.data.contest.freezeMinutes, 5);
  assert.equal(details.data.problems[0].title, 'Shared bank contest question');
  const rescheduledStart = new Date(Date.parse(created.data.contest.startAt) + 60_000).toISOString();
  const rescheduledEnd = new Date(Date.parse(created.data.contest.endAt) + 60_000).toISOString();
  const managed = await f.request(`/api/teacher/contests/${contestId}`, { method: 'PATCH', token: teacherToken, body: { title: 'Managed cross-class contest', startAt: rescheduledStart, endAt: rescheduledEnd, freezeMinutes: 6, addStudentIds: [uninvitedStudentId] } });
  assert.equal(managed.status, 200, JSON.stringify(managed.data));
  assert.equal(managed.data.contest.title, 'Managed cross-class contest');
  assert.equal(managed.data.contest.startAt, rescheduledStart);
  assert.equal(managed.data.contest.endAt, rescheduledEnd);
  assert.equal((await f.request(`/api/teacher/contests/${contestId}`, { token: teacherToken })).data.participants.length, 3);

  const inviteeToken = await f.login('student.test');
  const crossClassToken = await f.login('student.external');
  const uninvitedToken = await f.login('student.uninvited');
  assert.equal((await f.request('/api/student/contests', { token: inviteeToken })).data.contests.length, 1);
  assert.equal((await f.request('/api/student/contests', { token: crossClassToken })).data.contests.length, 1, 'an invitee in another teacher class must see the contest');
  assert.equal((await f.request('/api/student/contests', { token: uninvitedToken })).data.contests.length, 1, 'a student invited through advanced management can see the contest');
  assert.equal((await f.request(`/api/student/contests/${contestId}`, { token: uninvitedToken })).status, 200, 'the newly invited student can open contest details');
  assert.equal((await f.request('/api/teacher/sessions', { token: teacherToken })).data.sessions.length, 0, 'the hidden backing session must not show up as a normal lesson');

  f.clock.now = Date.parse((await f.db.prepare('SELECT start_at FROM contests WHERE id=?').get(contestId)).start_at) + 1000;
  const contestDetail = await f.request(`/api/student/contests/${contestId}`, { token: crossClassToken });
  assert.equal(contestDetail.status, 200);
  assert.equal(contestDetail.data.contest.scoreboardFrozen, false);
  const frozenManually = await f.request(`/api/teacher/contests/${contestId}`, { method: 'PATCH', token: teacherToken, body: { frozen: true } });
  assert.equal(frozenManually.status, 200);
  assert.equal((await f.request(`/api/student/contests/${contestId}`, { token: crossClassToken })).data.contest.scoreboardFrozen, true);
  const unfrozen = await f.request(`/api/teacher/contests/${contestId}`, { method: 'PATCH', token: teacherToken, body: { frozen: false } });
  assert.equal(unfrozen.status, 200);
  assert.equal((await f.request(`/api/student/contests/${contestId}`, { token: crossClassToken })).data.contest.scoreboardFrozen, false);
  const beforeExtension = Date.parse((await f.db.prepare('SELECT end_at FROM contests WHERE id=?').get(contestId)).end_at);
  const extended = await f.request(`/api/teacher/contests/${contestId}`, { method: 'PATCH', token: teacherToken, body: { endAt: new Date(beforeExtension + 120_000).toISOString() } });
  assert.equal(extended.status, 200, JSON.stringify(extended.data));
  assert.equal(Date.parse(extended.data.contest.endAt), beforeExtension + 120_000);
  assert.equal(contestDetail.data.problems.length, 1);
  const problemId = contestDetail.data.problems[0].id;
  const problemAccess = await f.request(`/api/student/problems/${problemId}?contestId=${contestId}`, { token: crossClassToken });
  assert.equal(problemAccess.status, 200, 'contest access must not depend on membership in the creator teacher class');
  const submitted = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: crossClassToken, body: { contestId, code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  const teacherSubmissionRows = await f.request('/api/teacher/submissions', { token: teacherToken });
  assert.ok(teacherSubmissionRows.data.submissions.some((row) => row.id === submitted.data.submission.id && row.contestTitle === 'Managed cross-class contest'), 'contest owner must see submissions from invitees outside their classes');
  const contestSource = await f.request(`/api/teacher/submissions/${submitted.data.submission.id}/source`, { token: teacherToken });
  assert.equal(contestSource.status, 200, JSON.stringify(contestSource.data));
  assert.match(contestSource.data.sourceCode, /__ACCEPTED_TEST_ONLY__/);
  const creatorReportStudents = await f.request('/api/teacher/reports/students', { token: teacherToken });
  assert.ok(creatorReportStudents.data.students.some((person) => person.id === externalStudentId), 'contest invitees from another teacher class must be selectable in individual reports');
  const creatorIndividualReport = await f.request(`/api/teacher/reports/students/${externalStudentId}`, { token: teacherToken });
  assert.equal(creatorIndividualReport.status, 200);
  assert.equal(creatorIndividualReport.data.totals.submissions, 1);
  const externalTeacherRows = await f.request('/api/teacher/submissions', { token: otherTeacherToken });
  assert.equal(externalTeacherRows.data.submissions.some((row) => row.id === submitted.data.submission.id), false, 'other teacher must not see a contest they do not own');
  assert.equal((await f.request(`/api/teacher/submissions/${submitted.data.submission.id}/source`, { token: otherTeacherToken })).status, 404);
  const adminToken = await f.login('admin.test');
  const adminSubmissionRows = await f.request('/api/admin/submissions', { token: adminToken });
  assert.ok(adminSubmissionRows.data.submissions.some((row) => row.id === submitted.data.submission.id), 'admin must see all submissions including contests');
  const adminSource = await f.request(`/api/admin/submissions/${submitted.data.submission.id}/source`, { token: adminToken });
  assert.equal(adminSource.status, 200, JSON.stringify(adminSource.data));
  assert.match(adminSource.data.sourceCode, /__ACCEPTED_TEST_ONLY__/);
  const liveBoard = await f.request(`/api/student/contests/${contestId}`, { token: inviteeToken });
  assert.equal(liveBoard.data.contest.status, 'active');
  assert.equal(liveBoard.data.leaderboard.length, 3, 'the participant leaderboard is visible while the contest is running');
  assert.equal(liveBoard.data.leaderboard[0].points, 80, 'the in-progress leaderboard includes newly awarded points');
  f.clock.now = Date.parse((await f.db.prepare('SELECT end_at FROM contests WHERE id=?').get(contestId)).end_at) - 60_000;
  const duringFreeze = await f.request(`/api/student/contests/${contestId}`, { token: inviteeToken });
  assert.equal(duringFreeze.data.contest.scoreboardFrozen, true, 'automatic freeze must begin in the configured final window');
  f.clock.now = Date.parse((await f.db.prepare('SELECT end_at FROM contests WHERE id=?').get(contestId)).end_at) + 1000;
  const final = await f.request(`/api/student/contests/${contestId}`, { token: inviteeToken });
  assert.equal(final.status, 200);
  assert.equal(final.data.contest.scoreboardFrozen, false, 'the final scoreboard is revealed when the contest ends');
  assert.equal(final.data.leaderboard.length, 3, 'the leaderboard includes every invitee, including those who did not submit');
  assert.equal(final.data.leaderboard[0].studentId, externalStudentId);
  assert.equal(final.data.leaderboard[0].points, 80);
  assert.equal(final.data.leaderboard[1].studentId, f.studentId);
  assert.equal(final.data.leaderboard[1].points, 0);
  assert.ok(final.data.leaderboard.some(row => row.studentId === uninvitedStudentId && row.points === 0));
});

test('assignments snapshot shared questions, accept C++ settings, report every invitee, and scan similar source fingerprints', { skip: !process.env.ACM_TEST_DATABASE_URL }, async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const externalStudentId = await createUser(f.db, { username: 'student.assignment.external', displayName: 'External Student', role: 'student', password: PASSWORD });
  const externalToken = await f.login('student.assignment.external');
  const secondClassStudentId = await createUser(f.db, { username: 'student.assignment.second', displayName: 'Second Class Student', role: 'student', password: PASSWORD });
  const secondClassStudentToken = await f.login('student.assignment.second');
  const room = await makeClass(f, teacherToken, { title: 'C++ Assignment Class', addStudent: true });
  const secondRoom = await makeClass(f, teacherToken, { title: 'C++ Assignment Class Two' });
  const secondMember = await f.request(`/api/teacher/classes/${secondRoom.id}/members`, { method: 'POST', token: teacherToken, body: { studentId: secondClassStudentId } });
  assert.equal(secondMember.status, 201);
  const bank = await f.request('/api/teacher/question-bank', { method: 'POST', token: teacherToken, body: {
    title: 'C++ assignment question', statement: 'Read an integer and print it.', points: 100, attemptLimit: 4, timeLimitMs: 1500, comparison: 'tokens',
    languageMode: 'both', defaultLanguage: 'cpp', cppStandard: '20', cppOptimization: 'O1',
    tests: [{ input: '7\n', output: '7\n', hidden: false }, { input: '42\n', output: '42\n', hidden: true }],
  } });
  assert.equal(bank.status, 201, JSON.stringify(bank.data));
  assert.equal(bank.data.question.languageMode, 'both');
  const secondBank = await f.request('/api/teacher/question-bank', { method: 'POST', token: teacherToken, body: {
    title: 'Second C++ assignment question', statement: 'Print twice the given number.', points: 50, attemptLimit: 4, timeLimitMs: 1500, comparison: 'tokens',
    languageMode: 'cpp', defaultLanguage: 'cpp', cppStandard: '17', cppOptimization: 'O2',
    tests: [{ input: '7\n', output: '14\n', hidden: false }],
  } });
  assert.equal(secondBank.status, 201, JSON.stringify(secondBank.data));
  const startAt = new Date(f.clock.now - 60_000).toISOString();
  const dueAt = new Date(f.clock.now + 3_600_000).toISOString();
  const created = await f.request('/api/teacher/assignments', { method: 'POST', token: teacherToken, body: {
    title: 'C++ homework', description: 'Assignment independent of later class changes', startAt, dueAt,
    allowLate: true, latePenaltyPercent: 15, classIds: [room.id, secondRoom.id], studentIds: [externalStudentId], bankQuestionIds: [bank.data.question.id, secondBank.data.question.id],
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const assignmentId = created.data.assignment.id;
  assert.equal(created.data.assignment.participantCount, 3);
  const studentList = await f.request('/api/student/assignments', { token: studentToken });
  assert.equal(studentList.status, 200);
  assert.equal(studentList.data.assignments.length, 1);
  const detail = await f.request(`/api/student/assignments/${assignmentId}`, { token: studentToken });
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.problems.length, 2);
  const problem = detail.data.problems.find((item) => item.title === 'C++ assignment question');
  const secondProblem = detail.data.problems.find((item) => item.title === 'Second C++ assignment question');
  assert.equal(problem.languageMode, 'both');
  assert.equal(problem.defaultLanguage, 'cpp');
  assert.equal(problem.cppStandard, '20');
  assert.equal(problem.samples.length, 1, 'hidden testcase output must remain private');
  assert.equal(JSON.stringify(detail.data).includes('42\\n'), false);

  const source = '#include <iostream>\nint main(){ int value = 7; std::cin >> value; std::cout << value << " __ACCEPTED_TEST_ONLY__"; return 0; }';
  const first = await f.request(`/api/student/problems/${problem.id}/submissions`, { method: 'POST', token: studentToken, body: {
    assignmentId, language: 'cpp', cppStandard: '20', cppOptimization: 'O1', code: source,
  } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.submission.language, 'cpp');
  assert.equal(f.judgeCalls.at(-1).language, 'cpp');
  assert.equal(f.judgeCalls.at(-1).cppStandard, '20');
  assert.equal(f.judgeCalls.at(-1).optimization, 'O1');
  const renamedSource = '#include <iostream>\nint main(){ int number = 7; std::cin >> number; std::cout << number << " __ACCEPTED_TEST_ONLY__"; return 0; }';
  const second = await f.request(`/api/student/problems/${problem.id}/submissions`, { method: 'POST', token: externalToken, body: {
    assignmentId, language: 'cpp', cppStandard: '20', cppOptimization: 'O1', code: renamedSource,
  } });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  const classmate = await f.request(`/api/student/problems/${problem.id}/submissions`, { method: 'POST', token: secondClassStudentToken, body: {
    assignmentId, language: 'cpp', cppStandard: '20', cppOptimization: 'O1', code: source,
  } });
  assert.equal(classmate.status, 201, JSON.stringify(classmate.data));

  const teacherDetail = await f.request(`/api/teacher/assignments/${assignmentId}`, { token: teacherToken });
  assert.equal(teacherDetail.status, 200);
  assert.equal(teacherDetail.data.participants.length, 3);
  assert.ok(teacherDetail.data.participants.every(p => p.attemptCount === 1 && p.attemptedProblemCount === 1 && p.problemCount === 2 && p.status === 'in_progress'));
  const assignmentSummaryBefore = await f.request('/api/teacher/assignments', { token: teacherToken });
  assert.equal(assignmentSummaryBefore.data.assignments[0].submittedCount, 0, 'partial question attempts are not counted as completed assignment deliveries');
  const similarity = await f.request('/api/teacher/similarity/scan', { method: 'POST', token: teacherToken, body: { type: 'assignment', id: assignmentId, threshold: 25 } });
  assert.equal(similarity.status, 200);
  assert.ok(similarity.data.pairs.length >= 1, 'variable-renamed C++ submissions should be flagged as similar');
  assert.equal(similarity.data.pairs[0].language, 'cpp');
  assert.match(similarity.data.notice, /اثبات تقلب نیست/);

  const reports = await f.request('/api/teacher/reports/students', { token: teacherToken });
  assert.ok(reports.data.students.some(student => student.id === externalStudentId));
  const individual = await f.request(`/api/teacher/reports/students/${externalStudentId}`, { token: teacherToken });
  assert.equal(individual.status, 200);
  assert.equal(individual.data.assignments.assigned, 1);
  assert.equal(individual.data.assignments.submitted, 0, 'one of two questions does not complete the assignment');
  assert.equal(individual.data.totals.submissions, 1);
  const lastProblem = await f.request(`/api/student/problems/${secondProblem.id}/submissions`, { method: 'POST', token: externalToken, body: {
    assignmentId, language: 'cpp', cppStandard: '17', cppOptimization: 'O2', code: '#include <iostream>\nint main(){std::cout << 14 << " __ACCEPTED_TEST_ONLY__";}',
  } });
  assert.equal(lastProblem.status, 201, JSON.stringify(lastProblem.data));
  const completedIndividual = await f.request(`/api/teacher/reports/students/${externalStudentId}`, { token: teacherToken });
  assert.equal(completedIndividual.data.assignments.submitted, 1);
  assert.equal(completedIndividual.data.totals.submissions, 2);
  assert.equal(completedIndividual.data.totals.points, 150, 'individual performance totals must include best scores from assigned questions');
  assert.equal(completedIndividual.data.submissions.length, 2, 'all assignment submissions must appear in individual history');
  assert.ok(completedIndividual.data.submissions.every((row) => row.assignmentTitle === 'C++ homework'));
  const teacherSubmissionList = await f.request('/api/teacher/submissions', { token: teacherToken });
  assert.equal(teacherSubmissionList.data.submissions.filter((row) => row.assignmentTitle === 'C++ homework').length, 4, 'teacher submissions page must label assignment attempts');
  const adminSubmissionList = await f.request('/api/admin/submissions', { token: await f.login('admin.test') });
  assert.equal(adminSubmissionList.data.submissions.filter((row) => row.assignmentTitle === 'C++ homework').length, 4, 'admin submissions page must label assignment attempts');
  const completedDetail = await f.request(`/api/teacher/assignments/${assignmentId}`, { token: teacherToken });
  const externalRow = completedDetail.data.participants.find(person => person.studentId === externalStudentId);
  assert.equal(externalRow.status, 'submitted');
  assert.equal(externalRow.attemptedProblemCount, 2);
  assert.equal(externalRow.bestPoints, 150);
  const assignmentSummaryAfter = await f.request('/api/teacher/assignments', { token: teacherToken });
  assert.equal(assignmentSummaryAfter.data.assignments[0].submittedCount, 1);
  const comparison = await f.request(`/api/teacher/reports/compare?ids=${room.id},${secondRoom.id}`, { token: teacherToken });
  assert.equal(comparison.status, 200, JSON.stringify(comparison.data));
  assert.ok(comparison.data.classes.every(row => row.activeStudents === 1 && row.averageStudentPoints === 100), JSON.stringify(comparison.data.classes));
  const unauthorized = await f.request(`/api/teacher/assignments/${assignmentId}`, { token: await f.login('admin.test') });
  assert.equal(unauthorized.status, 403);
});

test('admin can erase all learning history only with password and exact phrase; accounts and security trail remain', async (t) => {
  const f = await fixture(t);
  const adminToken = await f.login('admin.test');
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const { room, problemId } = await makeActiveProblem(f, teacherToken, { title: 'Data purge question' });
  const submitted = await f.request(`/api/student/problems/${problemId}/submissions`, { method: 'POST', token: studentToken, body: { code: '__ACCEPTED_TEST_ONLY__' } });
  assert.equal(submitted.status, 201);
  const event = await f.request(`/api/teacher/classes/${room.id}/events`, { method: 'POST', token: teacherToken, body: {
    title: 'Calendar item', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '13:00', endTime: '14:00',
  } });
  assert.equal(event.status, 201);
  const bankQuestionId = (await f.db.prepare('SELECT id FROM question_bank WHERE origin_problem_id=?').get(problemId))?.id;
  assert.ok(bankQuestionId, 'the session question must also exist in the shared question bank');
  const assignment = await f.request('/api/teacher/assignments', { method: 'POST', token: teacherToken, body: {
    title: 'Purge assignment', description: '', startAt: new Date(f.clock.now - 60_000).toISOString(), dueAt: new Date(f.clock.now + 3_600_000).toISOString(),
    allowLate: true, latePenaltyPercent: 10, classIds: [room.id], studentIds: [], bankQuestionIds: [bankQuestionId],
  } });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.data));
  const contestStart = tehranJalaliDateTime(f.clock.now + 180_000);
  const contestEnd = tehranJalaliDateTime(f.clock.now + 3_600_000);
  const contest = await f.request('/api/teacher/contests', { method: 'POST', token: teacherToken, body: {
    title: 'Purge contest', description: '', startJalaliDate: contestStart.date, startTime: contestStart.time,
    endJalaliDate: contestEnd.date, endTime: contestEnd.time, penaltyMinutes: 10, bankQuestionIds: [bankQuestionId], studentIds: [f.studentId],
  } });
  assert.equal(contest.status, 201, JSON.stringify(contest.data));

  const before = await f.request('/api/admin/data-summary', { token: adminToken });
  assert.equal(before.status, 200);
  assert.ok(before.data.summary.classes > 0);
  assert.ok(before.data.summary.questions > 0);
  assert.ok(before.data.summary.submissions > 0);
  assert.ok(before.data.summary.points > 0);
  assert.ok(before.data.summary.activityEvents > 0);
  assert.ok(before.data.summary.assignments > 0);
  assert.ok(before.data.summary.contests > 0);

  const wrongPassword = await f.request('/api/admin/data/purge', { method: 'POST', token: adminToken, body: {
    password: 'Wrong-Password-123!', confirmation: 'حذف کامل سوابق',
  } });
  assert.equal(wrongPassword.status, 403);
  assert.ok((await f.request('/api/admin/data-summary', { token: adminToken })).data.summary.submissions > 0, 'wrong password must not delete anything');

  const wrongPhrase = await f.request('/api/admin/data/purge', { method: 'POST', token: adminToken, body: {
    password: PASSWORD, confirmation: 'حذف سوابق',
  } });
  assert.equal(wrongPhrase.status, 400);
  assert.ok((await f.request('/api/admin/data-summary', { token: adminToken })).data.summary.classes > 0, 'wrong phrase must not delete anything');

  const purged = await f.request('/api/admin/data/purge', { method: 'POST', token: adminToken, body: {
    password: PASSWORD, confirmation: 'حذف کامل سوابق',
  } });
  assert.equal(purged.status, 200, JSON.stringify(purged.data));
  assert.equal(purged.data.summary.classes, 0);
  assert.equal(purged.data.summary.sessions, 0);
  assert.equal(purged.data.summary.questions, 0);
  assert.equal(purged.data.summary.contests, 0);
  assert.equal(purged.data.summary.assignments, 0);
  assert.equal(purged.data.summary.submissions, 0);
  assert.equal(purged.data.summary.points, 0);
  assert.equal(purged.data.summary.activityEvents, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 3, 'user accounts must remain');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM admin_security_events WHERE event_type='learning_data_purge'").get()).n, 1, 'a separate security trail must survive the purge');
  assert.equal((await f.request('/api/admin/users', { token: adminToken })).status, 200, 'admin account and session must remain usable');
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username: 'teacher.test', password: PASSWORD } })).status, 200, 'teacher account must remain');
});

test('all calendar date entry points use the shared Shamsi picker instead of browser Gregorian date controls', () => {
  const source = fs.readFileSync(new URL('./src/main.jsx', import.meta.url), 'utf8');
  assert.match(source, /function JalaliDateField\(/);
  assert.match(source, /function JalaliDateTimeField\(/);
  assert.doesNotMatch(source, /type=["']datetime-local["']/i);
  assert.doesNotMatch(source, /type=["']date["']/i);
  assert.match(source, /timeZone:\s*'Asia\/Tehran'/);
});

test('database upgrade relaxes the legacy contest class requirement and preserves its participant roster', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-contest-migration-'));
  const dbPath = path.join(dir, 'legacy-contests.sqlite');
  let db = openSqliteTestDatabase({ dbPath });
  t.after(async () => { try { await db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const teacherId = await createUser(db, { username: 'teacher.contest.migration', displayName: 'Contest Teacher', role: 'teacher', password: PASSWORD });
  const studentId = await createUser(db, { username: 'student.contest.migration', displayName: 'Contest Student', role: 'student', password: PASSWORD });
  const stamp = new Date().toISOString();
  await db.prepare('INSERT INTO teacher_classes(id,teacher_id,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('migration-class', teacherId, 'Legacy contest class', '', stamp, stamp);
  await db.prepare('INSERT INTO class_memberships(id,class_id,student_id,joined_at) VALUES(?,?,?,?)').run('migration-membership', 'migration-class', studentId, stamp);
  await db.prepare(`INSERT INTO class_sessions(id,class_id,jalali_date,start_time,end_time,title,description,active,created_by,created_at,updated_at)
    VALUES(?, ?, NULL, NULL, NULL, ?, '', 1, ?, ?, ?)`).run('migration-session', 'migration-class', 'Legacy contest session', teacherId, stamp, stamp);
  await db.prepare(`INSERT INTO problems(id,session_id,title,statement,input_format,output_format,points,attempt_limit,time_limit_ms,comparison,published,position,created_at,updated_at)
    VALUES(?, ?, ?, ?, '', '', 100, 0, 1000, 'tokens', 1, 0, ?, ?)`).run('migration-problem', 'migration-session', 'Legacy contest problem', 'Print a value.', stamp, stamp);
  await db.prepare('INSERT INTO contests(id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('legacy-contest', 'migration-class', 'Legacy contest', '', stamp, new Date(Date.now() + 3600000).toISOString(), 5, teacherId, stamp, stamp);
  await db.prepare('INSERT INTO contest_problems(contest_id,problem_id,position) VALUES(?,?,?)').run('legacy-contest', 'migration-problem', 0);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(`CREATE TABLE contests_legacy (
    id TEXT PRIMARY KEY,
    class_id TEXT NOT NULL REFERENCES teacher_classes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    penalty_minutes INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO contests_legacy(id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at) SELECT id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at FROM contests;
  DROP TABLE contests;
  ALTER TABLE contests_legacy RENAME TO contests;`);
  db.exec('PRAGMA foreign_keys=ON');
  await db.close();
  db = openSqliteTestDatabase({ dbPath });
  assert.equal((await db.prepare('PRAGMA table_info(contests)').all()).find((column) => column.name === 'class_id').notnull, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM contests WHERE id=? AND class_id=?').get('legacy-contest', 'migration-class')).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM contest_participants WHERE contest_id=? AND student_id=?').get('legacy-contest', studentId)).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM contest_problems WHERE contest_id=? AND problem_id=?').get('legacy-contest', 'migration-problem')).n, 1);
  assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('legacy contest table migration rolls back atomically when the replacement table cannot be created', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-contest-atomic-migration-'));
  const db = openSqliteTestDatabase({ dbPath: path.join(dir, 'legacy.sqlite') });
  t.after(async () => { try { await db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const teacherId = await createUser(db, { username: 'teacher.atomic.migration', displayName: 'Atomic Teacher', role: 'teacher', password: PASSWORD });
  const stamp = new Date().toISOString();
  await db.prepare('INSERT INTO teacher_classes(id,teacher_id,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('atomic-class', teacherId, 'Atomic class', '', stamp, stamp);
  await db.prepare('INSERT INTO contests(id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('atomic-contest', 'atomic-class', 'Atomic contest', '', stamp, new Date(Date.now() + 3600000).toISOString(), 0, teacherId, stamp, stamp);

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`CREATE TABLE contests_legacy (
    id TEXT PRIMARY KEY,
    class_id TEXT NOT NULL REFERENCES teacher_classes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    penalty_minutes INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO contests_legacy(id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at)
    SELECT id,class_id,title,description,start_at,end_at,penalty_minutes,created_by,created_at,updated_at FROM contests;
  DROP TABLE contests;
  ALTER TABLE contests_legacy RENAME TO contests;`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE contests_new (collision INTEGER)');

  assert.throws(() => migrateLegacyContestClassRequirement(db), /already exists/i);
  assert.equal((await db.prepare('PRAGMA foreign_keys').get()).foreign_keys, 1);
  assert.equal((await db.prepare('PRAGMA table_info(contests)').all()).find((column) => column.name === 'class_id').notnull, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM contests WHERE id=?').get('atomic-contest')).n, 1);

  db.exec('DROP TABLE contests_new');
  assert.equal(migrateLegacyContestClassRequirement(db), true);
  assert.equal((await db.prepare('PRAGMA table_info(contests)').all()).find((column) => column.name === 'class_id').notnull, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM contests WHERE id=?').get('atomic-contest')).n, 1);
  assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('system capacity metrics are available only to the administrator', { skip: !process.env.ACM_TEST_DATABASE_URL }, async (t) => {
  const f = await fixture(t);
  const adminToken = await f.login('admin.test');
  const studentToken = await f.login('student.test');
  const adminResult = await f.request('/api/admin/system', { token: adminToken });
  assert.equal(adminResult.status, 200);
  assert.equal(adminResult.data.runtime.database, 'PostgreSQL', 'production runtime must report its PostgreSQL engine rather than the retired SQLite WAL mode');
  assert.equal(adminResult.data.runtime.horizontalScaling, false);
  assert.equal(adminResult.data.judge.concurrency >= 1, true);
  assert.equal(adminResult.data.judge.queued, 0);
  assert.equal((await f.request('/api/admin/system', { token: studentToken })).status, 403);
});





test('simultaneous contest creation cannot reserve the same problem in overlapping time windows', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const room = await makeClass(f, teacherToken, { title: 'Contest reservation class', addStudent: true });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Contest bank session', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  assert.equal(session.status, 201, JSON.stringify(session.data));
  const activated = await f.request(`/api/teacher/sessions/${session.data.session.id}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  assert.equal(activated.status, 200, JSON.stringify(activated.data));
  const problem = await f.request(`/api/teacher/sessions/${session.data.session.id}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Reserved question', statement: 'Print a number.', published: true, tests: [{ input: '', output: '1', hidden: false }],
  } });
  assert.equal(problem.status, 201, JSON.stringify(problem.data));
  const payload = {
    title: 'Overlapping contest', description: '', startJalaliDate: '1405/08/20', endJalaliDate: '1405/08/20',
    startTime: '09:00', endTime: '10:00', penaltyMinutes: 10, problemIds: [problem.data.problem.id],
  };
  const results = await Promise.all([
    f.request(`/api/teacher/classes/${room.id}/contests`, { method: 'POST', token: teacherToken, body: payload }),
    f.request(`/api/teacher/classes/${room.id}/contests`, { method: 'POST', token: teacherToken, body: { ...payload, title: 'Second overlapping contest' } }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409], JSON.stringify(results.map((result) => result.data)));
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM contests').get()).n, 1);
});

test('admin can create and download verified database snapshots only after password confirmation', { skip: !process.env.ACM_TEST_DATABASE_URL }, async (t) => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-admin-backups-'));
  t.after(() => fs.rmSync(backupDir, { recursive: true, force: true }));
  const f = await fixture(t, ORIGIN, undefined, { backupDir });
  const adminToken = await f.login('admin.test');
  const studentToken = await f.login('student.test');
  assert.equal((await f.request('/api/admin/backups', { token: studentToken })).status, 403);
  const denied = await f.request('/api/admin/backups', { method: 'POST', token: adminToken, body: { password: 'incorrect password' } });
  assert.equal(denied.status, 403);
  const created = await f.request('/api/admin/backups', { method: 'POST', token: adminToken, body: { password: PASSWORD } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok(created.data.backup.size > 4096);
  const list = await f.request('/api/admin/backups', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.backups.length, 1);
  assert.equal(list.data.backups[0].filename, created.data.backup.filename);
  const download = await f.request(`/api/admin/backups/${encodeURIComponent(created.data.backup.filename)}/download`, { token: adminToken });
  assert.equal(download.status, 200);
  assert.equal((await f.request('/api/admin/backups/../../etc/passwd/download', { token: adminToken })).status, 404);
});

test('submission history endpoints use stable limit/offset pagination for large lists', async (t) => {
  const f = await fixture(t);
  const teacherToken = await f.login('teacher.test');
  const studentToken = await f.login('student.test');
  const adminToken = await f.login('admin.test');
  const room = await makeClass(f, teacherToken, { title: 'Pagination class', addStudent: true });
  const session = await f.request('/api/teacher/sessions', { method: 'POST', token: teacherToken, body: { classId: room.id, title: 'Pagination session', description: '', jalaliDate: currentTehranJalaliDate(), startTime: '00:00', endTime: '23:59' } });
  const sessionId = session.data.session.id;
  await f.request(`/api/teacher/sessions/${sessionId}`, { method: 'PATCH', token: teacherToken, body: { active: true } });
  const problem = await f.request(`/api/teacher/sessions/${sessionId}/problems`, { method: 'POST', token: teacherToken, body: {
    title: 'Pagination problem', statement: 'Submit multiple attempts.', points: 100, attemptLimit: 0, timeLimitMs: 1000, published: true,
    tests: [{ input: '1', output: '1', hidden: false }, { input: '2', output: '2', hidden: true }],
  } });
  for (let index = 0; index < 3; index += 1) {
    const submission = await f.request(`/api/student/problems/${problem.data.problem.id}/submissions`, { method: 'POST', token: studentToken, body: { code: `print(${index})` } });
    assert.equal(submission.status, 201, JSON.stringify(submission.data));
  }
  for (const [path, token] of [['/api/student/submissions', studentToken], ['/api/teacher/submissions', teacherToken], ['/api/admin/submissions', adminToken]]) {
    const first = await f.request(`${path}?limit=1&offset=0`, { token });
    const second = await f.request(`${path}?limit=1&offset=1`, { token });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(first.data.pagination.total, 3);
    assert.equal(first.data.pagination.hasMore, true);
    assert.equal(first.data.submissions.length, 1);
    assert.equal(second.data.submissions.length, 1);
    assert.notEqual(first.data.submissions[0].id, second.data.submissions[0].id);
  }
});
