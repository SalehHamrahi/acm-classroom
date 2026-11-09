import { loadEnv } from './env.js';
import http from 'node:http';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { runSubmission as runDockerSubmission } from './judge.js';
import { BaleBotService } from './bale-bot.js';

loadEnv();

const db = await openDatabase();
let server;
let baleBot;
try {
  const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").get();
  if (!admin) throw new Error('هیچ مدیر فعالی ثبت نشده است. ابتدا این دستور را اجرا کن: npm run setup:admin');

  // Docker is the sole execution backend. Student code never leaves this host for judging.
  const runJudge = runDockerSubmission;
  baleBot = new BaleBotService({ db, token: process.env.BALE_BOT_TOKEN || '', appUrl: process.env.APP_ORIGIN || 'http://127.0.0.1:3000' });
  const app = await createApp({ db, runJudge, config: { baleEnabled: baleBot.configured } });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server = http.createServer(app);
  server.requestTimeout = 180000;
  server.headersTimeout = 190000;
  server.keepAliveTimeout = 5000;
  server.listen(port, host, () => {
    console.log(`ACM Classroom listening on http://${host}:${port}`);
    console.log(`Origin allowlist: ${process.env.APP_ORIGIN || `http://${host}:${port}`}`);
    console.log('Judging backend: Docker containers (self-hosted)');
    void baleBot.start().catch((error) => console.error('[Bale startup]', error));
  });
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        await baleBot.stop();
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        await db.close();
        process.exit(0);
      })().catch((error) => { console.error('[shutdown]', error); process.exit(1); });
    });
  }
} catch (error) {
  console.error(`\nراه‌اندازی ACM Classroom ناموفق بود: ${error.message}\n`);
  try { await db.close(); } catch { /* no active pool if startup failed */ }
  process.exitCode = 1;
}
