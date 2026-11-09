import test from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from './server/db.js';
import { openSqliteTestDatabase } from './server/sqlite-test-database.js';
import { BaleBotService, hashBaleLinkCode } from './server/bale-bot.js';

async function makeDb() {
  const db = openSqliteTestDatabase({ dbPath: ':memory:' });
  const userId = await createUser(db, { username: 'bale.student', displayName: 'Bale Student', role: 'student', password: 'Strong-Test-Password-123!' });
  return { db, userId };
}

function fakeFetch(calls, responder = () => ({ ok: true, result: { message_id: 77 } })) {
  return async (url, options) => {
    const payload = JSON.parse(options.body || '{}');
    const method = String(url).split('/').pop();
    calls.push({ method, payload });
    const body = responder(method, payload);
    return { ok: true, status: 200, json: async () => body };
  };
}

test('private /start one-time code binds the chat to the right ACM account and stores update offset', async (t) => {
  const { db, userId } = await makeDb();
  t.after(async () => db.close());
  const code = 'Abcdef123456_XYZ';
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO bale_link_codes(code_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(hashBaleLinkCode(code), userId, new Date(Date.now() + 600_000).toISOString(), now);
  const service = new BaleBotService({ db, token: 'test-token', fetchImpl: fakeFetch([]), logger: { info() {}, warn() {}, error() {} } });
  const reply = await service.processIncomingUpdate({
    update_id: 10,
    message: { text: `/start ${code}`, chat: { id: 123456, type: 'private' }, from: { id: 123456, first_name: 'Student', username: 'student' } },
  });
  assert.equal(reply.chatId, 123456);
  assert.match(reply.text, /با موفقیت/);
  const link = await db.prepare('SELECT user_id,chat_id,enabled,chat_label FROM bale_links').get();
  assert.equal(link.user_id, userId);
  assert.equal(link.chat_id, '123456');
  assert.equal(link.enabled, 1);
  assert.equal(link.chat_label, 'Student');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bale_link_codes').get()).n, 0);
  assert.equal((await db.prepare("SELECT value FROM bale_state WHERE key='updates_offset'").get()).value, '11');
  assert.equal(await service.processIncomingUpdate({ update_id: 10, message: { text: `/start ${code}`, chat: { id: 123456, type: 'private' } } }), null);
});

test('group chats cannot claim a one-time account link code', async (t) => {
  const { db, userId } = await makeDb();
  t.after(async () => db.close());
  const code = 'Abcdef123456_XYZ';
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO bale_link_codes(code_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(hashBaleLinkCode(code), userId, new Date(Date.now() + 600_000).toISOString(), now);
  const service = new BaleBotService({ db, token: 'test-token', fetchImpl: fakeFetch([]), logger: { info() {}, warn() {}, error() {} } });
  const reply = await service.processIncomingUpdate({ update_id: 11, message: { text: `/start ${code}`, chat: { id: -77, type: 'group' } } });
  assert.match(reply.text, /گفتگوی خصوصی/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bale_links').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bale_link_codes').get()).n, 1);
});

test('notification outbox sends only for enabled linked users and marks success', async (t) => {
  const { db, userId } = await makeDb();
  t.after(async () => db.close());
  const stamp = new Date().toISOString();
  await db.prepare('INSERT INTO bale_links(user_id,chat_id,chat_label,enabled,linked_at) VALUES(?,?,?,1,?)').run(userId, '987654', 'Student', stamp);
  await db.prepare('INSERT INTO notifications(id,user_id,title,message,type,target_path,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('notification-1', userId, 'مسابقهٔ جدید', 'در مسابقه دعوت شده‌ای.', 'contest', '/contests', stamp);
  await db.prepare("INSERT INTO bale_notification_outbox(notification_id,user_id,status,attempts,next_attempt_at,created_at) VALUES(?,?,'pending',0,?,?)")
    .run('notification-1', userId, stamp, stamp);
  const calls = [];
  const service = new BaleBotService({ db, token: 'test-token', appUrl: 'https://acm-classroom.ir', fetchImpl: fakeFetch(calls), logger: { info() {}, warn() {}, error() {} } });
  assert.equal(await service.processOutboxBatch(), 1);
  assert.deepEqual(calls.map((call) => call.method), ['sendMessage']);
  assert.equal(calls[0].payload.chat_id, '987654');
  assert.match(calls[0].payload.text, /مسابقهٔ جدید/);
  assert.match(calls[0].payload.text, /https:\/\/acm-classroom\.ir\/contests/);
  const row = await db.prepare('SELECT status,attempts,sent_at FROM bale_notification_outbox WHERE notification_id=?').get('notification-1');
  assert.equal(row.status, 'sent');
  assert.equal(row.attempts, 1);
  assert.ok(row.sent_at);
});

test('failed Bale delivery remains in durable retry queue without exposing token in error', async (t) => {
  const { db, userId } = await makeDb();
  t.after(async () => db.close());
  const stamp = new Date().toISOString();
  await db.prepare('INSERT INTO bale_links(user_id,chat_id,chat_label,enabled,linked_at) VALUES(?,?,?,1,?)').run(userId, '987654', 'Student', stamp);
  await db.prepare('INSERT INTO notifications(id,user_id,title,message,type,target_path,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('notification-2', userId, 'تکلیف جدید', 'مهلت را بررسی کن.', 'assignment', '/assignments', stamp);
  await db.prepare("INSERT INTO bale_notification_outbox(notification_id,user_id,status,attempts,next_attempt_at,created_at) VALUES(?,?,'pending',0,?,?)")
    .run('notification-2', userId, stamp, stamp);
  const calls = [];
  const service = new BaleBotService({ db, token: 'secret-token-never-log', fetchImpl: fakeFetch(calls, () => ({ ok: false, description: 'temporary outage', error_code: 503 })), logger: { info() {}, warn() {}, error() {} } });
  assert.equal(await service.processOutboxBatch(), 1);
  const row = await db.prepare('SELECT status,attempts,next_attempt_at,last_error FROM bale_notification_outbox WHERE notification_id=?').get('notification-2');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(Date.parse(row.next_attempt_at) > Date.now());
  assert.match(row.last_error, /temporary outage/);
  assert.doesNotMatch(row.last_error, /secret-token/);
});
