import crypto from 'node:crypto';

const BALE_API_BASE = 'https://tapi.bale.ai/bot';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_DELIVERY_ATTEMPTS = 8;

function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function hashBaleLinkCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export class BaleBotService {
  constructor({ db, token = process.env.BALE_BOT_TOKEN || '', appUrl = process.env.APP_ORIGIN || 'http://127.0.0.1:3000', fetchImpl = globalThis.fetch, logger = console, pollTimeout = 25 }) {
    if (!db) throw new TypeError('BaleBotService requires a database.');
    this.db = db;
    this.token = String(token || '').trim();
    this.appUrl = String(appUrl || '').split(',')[0].trim().replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.pollTimeout = Math.max(5, Math.min(50, Number(pollTimeout) || 25));
    this.controller = null;
    this.tasks = [];
    this.started = false;
  }

  get configured() { return Boolean(this.token); }

  async call(method, payload = {}, { signal, timeoutMs = 40000 } = {}) {
    if (!this.configured) throw new Error('Bale bot token is not configured.');
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetchImpl(`${BALE_API_BASE}${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`ارتباط با بله برقرار نشد (${method}).`, { cause: error });
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`پاسخ بله برای ${method} قابل خواندن نبود.`); }
    if (!response.ok || data?.ok === false) {
      const description = String(data?.description || `HTTP ${response.status}`).slice(0, 300);
      throw new Error(`Bale API ${method}: ${description}`);
    }
    return data?.result;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (!this.configured) {
      this.logger.info?.('[Bale] Bot disabled. Set BALE_BOT_TOKEN to enable Bale notifications.');
      return;
    }
    this.controller = new AbortController();
    await this.db.prepare("UPDATE bale_notification_outbox SET status='pending', next_attempt_at=? WHERE status='processing'")
      .run(new Date().toISOString());
    try {
      const me = await this.call('getMe', {}, { signal: this.controller.signal, timeoutMs: 12000 });
      const username = String(me?.username || '').replace(/^@/, '').slice(0, 64);
      if (username) {
        await this.db.prepare(`INSERT INTO bale_state(key, value, updated_at) VALUES ('bot_username', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
          .run(username, new Date().toISOString());
      }
      this.logger.info?.(`[Bale] Bot connected${username ? ` as @${username}` : ''}.`);
    } catch (error) {
      if (!this.controller.signal.aborted) this.logger.warn?.(`[Bale] Initial getMe failed; background polling will retry: ${error.message}`);
    }
    const signal = this.controller.signal;
    this.tasks = [this.pollLoop(signal), this.outboxLoop(signal)];
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    this.controller?.abort();
    await Promise.allSettled(this.tasks);
    this.tasks = [];
    this.controller = null;
  }

  async currentOffset() {
    const row = await this.db.prepare("SELECT value FROM bale_state WHERE key='updates_offset'").get();
    const value = Number(row?.value || 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  async pollLoop(signal) {
    while (!signal.aborted) {
      try {
        const offset = await this.currentOffset();
        const updates = await this.call('getUpdates', {
          offset,
          timeout: this.pollTimeout,
          allowed_updates: ['message'],
        }, { signal, timeoutMs: (this.pollTimeout + 12) * 1000 });
        if (!Array.isArray(updates)) {
          this.logger.warn?.('[Bale] getUpdates returned an unexpected response; retrying shortly.');
          await delay(2000, signal);
          continue;
        }
        for (const update of updates) {
          if (signal.aborted) break;
          const reply = await this.processIncomingUpdate(update);
          if (reply?.chatId && reply?.text) {
            try { await this.call('sendMessage', { chat_id: reply.chatId, text: reply.text.slice(0, MAX_MESSAGE_LENGTH) }, { signal, timeoutMs: 15000 }); }
            catch (error) { if (!signal.aborted) this.logger.warn?.(`[Bale] Could not send command response: ${error.message}`); }
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        this.logger.warn?.(`[Bale] Update polling failed: ${error.message}`);
        await delay(4000, signal);
      }
    }
  }

  async processIncomingUpdate(update) {
    const updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId) || updateId < 0) return null;
    const message = update?.message;
    const chatId = message?.chat?.id;
    const chatType = message?.chat?.type;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    const privateChat = chatType === 'private';
    const sender = message?.from || {};
    const now = new Date().toISOString();

    return await this.db.transaction(async () => {
      if (await this.db.prepare('SELECT 1 FROM bale_processed_updates WHERE update_id=?').get(updateId)) return null;
      let reply = '';
      if (chatId !== undefined && chatId !== null && text) {
        if (!privateChat) {
          if (/^\/(start|link|help)(?:@\w+)?/i.test(text)) reply = 'برای اتصال حساب ACM Classroom، لطفاً در گفتگوی خصوصی ربات پیام بده.';
        } else {
          const start = text.match(/^\/(?:start|link)(?:@\w+)?(?:\s+([A-Za-z0-9_-]{8,80}))?\s*$/i);
          const plainCode = text.match(/^([A-Za-z0-9_-]{10,80})$/);
          if (start?.[1] || plainCode) {
            const code = start?.[1] || plainCode[1];
            const codeHash = hashBaleLinkCode(code);
            const linkCode = await this.db.prepare('SELECT user_id FROM bale_link_codes WHERE code_hash=? AND expires_at>?').get(codeHash, now);
            if (!linkCode) {
              reply = 'کد اتصال معتبر نیست یا منقضی شده است. از بخش «تنظیمات حساب» در ACM Classroom کد تازه بگیر.';
            } else {
              const currentUserLink = await this.db.prepare('SELECT chat_id FROM bale_links WHERE user_id=?').get(linkCode.user_id);
              const occupiedChat = await this.db.prepare('SELECT user_id FROM bale_links WHERE chat_id=?').get(String(chatId));
              if (currentUserLink && String(currentUserLink.chat_id) !== String(chatId)) {
                reply = 'برای این حساب یک گفتگوی بلهٔ دیگر متصل است. ابتدا از تنظیمات حساب سایت اتصال قبلی را قطع کن.';
              } else if (occupiedChat && occupiedChat.user_id !== linkCode.user_id) {
                reply = 'این گفتگوی بله قبلاً به یک حساب دیگر متصل شده است. از اتصال آن به حساب دیگری جلوگیری شد.';
              } else {
                const label = String(sender.first_name || sender.username || 'حساب بله').slice(0, 120);
                await this.db.prepare(`INSERT INTO bale_links(user_id, chat_id, chat_label, chat_username, enabled, linked_at)
                  VALUES (?, ?, ?, ?, 1, ?)
                  ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id, chat_label=excluded.chat_label,
                    chat_username=excluded.chat_username, enabled=1, linked_at=excluded.linked_at`)
                  .run(linkCode.user_id, String(chatId), label, String(sender.username || '').slice(0, 64), now);
                await this.db.prepare('DELETE FROM bale_link_codes WHERE user_id=?').run(linkCode.user_id);
                reply = 'حساب بله با موفقیت به ACM Classroom متصل شد. از این پس اعلان‌های جدید سایت برایت در همین گفتگو ارسال می‌شوند. برای قطع اتصال، /unlink را بفرست یا از تنظیمات حساب سایت استفاده کن.';
              }
            }
          } else if (/^\/(start|help)(?:@\w+)?\s*$/i.test(text)) {
            reply = 'سلام! من بازوی اعلان‌های ACM Classroom هستم.\n\nبرای اتصال حساب: در سایت وارد «تنظیمات حساب ← اتصال به بله» شو، کد یک‌بارمصرف بگیر و آن را به شکل /start CODE برای من بفرست.\n\nبا /status وضعیت اتصال را ببین و با /unlink اتصال را قطع کن.';
          } else if (/^\/status(?:@\w+)?\s*$/i.test(text)) {
            const link = await this.db.prepare('SELECT enabled FROM bale_links WHERE chat_id=?').get(String(chatId));
            reply = link ? `این گفتگو به ACM Classroom متصل است. ارسال اعلان‌ها ${link.enabled ? 'فعال' : 'غیرفعال'} است.` : 'این گفتگو به حسابی در ACM Classroom متصل نیست.';
          } else if (/^\/unlink(?:@\w+)?\s*$/i.test(text)) {
            const link = await this.db.prepare('SELECT user_id FROM bale_links WHERE chat_id=?').get(String(chatId));
            if (!link) reply = 'این گفتگو اتصال فعالی به ACM Classroom ندارد.';
            else {
              await this.db.prepare('DELETE FROM bale_links WHERE user_id=?').run(link.user_id);
              await this.db.prepare("UPDATE bale_notification_outbox SET status='cancelled' WHERE user_id=? AND status IN ('pending','processing')").run(link.user_id);
              reply = 'اتصال این گفتگو به ACM Classroom قطع شد. برای اتصال دوباره از تنظیمات حساب سایت کد تازه بگیر.';
            }
          }
        }
      }
      await this.db.prepare('INSERT INTO bale_processed_updates(update_id, processed_at) VALUES (?, ?)').run(updateId, now);
      await this.db.prepare(`INSERT INTO bale_state(key, value, updated_at) VALUES ('updates_offset', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .run(String(updateId + 1), now);
      if (!reply || chatId === undefined || chatId === null) return null;
      return { chatId, text: reply };
    })();
  }

  buildNotificationText(row) {
    const parts = [`🔔 ${row.title}`];
    if (row.message) parts.push(row.message);
    const target = row.target_path && row.target_path.startsWith('/') ? row.target_path : '';
    if (target) {
      try { parts.push(`مشاهده در ACM Classroom:\n${new URL(target, `${this.appUrl}/`).toString()}`); }
      catch { /* omit an invalid application URL */ }
    } else if (this.appUrl) parts.push(`ACM Classroom: ${this.appUrl}`);
    return parts.join('\n\n').slice(0, MAX_MESSAGE_LENGTH);
  }

  async processOutboxBatch(limit = 20) {
    const now = new Date().toISOString();
    const rows = await this.db.prepare(`SELECT o.notification_id, o.user_id, o.attempts, n.title, n.message, n.target_path, l.chat_id, l.enabled
      FROM bale_notification_outbox o
      JOIN notifications n ON n.id=o.notification_id
      LEFT JOIN bale_links l ON l.user_id=o.user_id
      WHERE o.status='pending' AND o.next_attempt_at<=?
      ORDER BY o.created_at, o.notification_id LIMIT ?`).all(now, Math.max(1, Math.min(100, Number(limit) || 20)));
    let processed = 0;
    for (const row of rows) {
      if (!row.chat_id) {
        await this.db.prepare("UPDATE bale_notification_outbox SET status='cancelled', last_error='پیوند بله وجود ندارد' WHERE notification_id=? AND status='pending'").run(row.notification_id);
        continue;
      }
      if (!row.enabled) {
        await this.db.prepare("UPDATE bale_notification_outbox SET next_attempt_at=? WHERE notification_id=? AND status='pending'")
          .run(new Date(Date.now() + 60_000).toISOString(), row.notification_id);
        continue;
      }
      const claim = await this.db.prepare("UPDATE bale_notification_outbox SET status='processing', attempts=attempts+1 WHERE notification_id=? AND status='pending'").run(row.notification_id);
      if (!claim.changes) continue;
      const attempt = Number(row.attempts || 0) + 1;
      try {
        await this.call('sendMessage', { chat_id: row.chat_id, text: this.buildNotificationText(row) }, { timeoutMs: 20000 });
        await this.db.prepare("UPDATE bale_notification_outbox SET status='sent', sent_at=?, last_error='' WHERE notification_id=?")
          .run(new Date().toISOString(), row.notification_id);
      } catch (error) {
        const terminal = attempt >= MAX_DELIVERY_ATTEMPTS;
        const backoffMs = Math.min(6 * 60 * 60 * 1000, 15_000 * (2 ** Math.min(attempt - 1, 10)));
        await this.db.prepare(`UPDATE bale_notification_outbox SET status=?, next_attempt_at=?, last_error=? WHERE notification_id=?`)
          .run(terminal ? 'failed' : 'pending', new Date(Date.now() + backoffMs).toISOString(), String(error?.message || 'خطای ناشناخته').slice(0, 500), row.notification_id);
        this.logger.warn?.(`[Bale] Notification delivery failed (${attempt}/${MAX_DELIVERY_ATTEMPTS}): ${error.message}`);
      }
      processed += 1;
    }
    return processed;
  }

  async outboxLoop(signal) {
    while (!signal.aborted) {
      try {
        const processed = await this.processOutboxBatch(20);
        await delay(processed ? 250 : 2000, signal);
      } catch (error) {
        if (!signal.aborted) this.logger.error?.(`[Bale] Outbox worker failed: ${error.message}`);
        await delay(3000, signal);
      }
    }
  }
}
