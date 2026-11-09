import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../server/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(root, '.env'));
const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || '').trim();
if (!testDatabaseUrl) {
  console.error('TEST_DATABASE_URL تنظیم نشده است. یک دیتابیس آزمایشی جدا از دیتابیس اصلی بساز و آن را در .env قرار بده.');
  process.exit(2);
}
if (!String(process.env.DATABASE_URL || '').trim()) {
  console.error('برای محافظت از دیتابیس عملیاتی، DATABASE_URL نیز باید در .env تنظیم شده باشد.');
  process.exit(2);
}
let testUrl;
let productionUrl;
try {
  testUrl = new URL(testDatabaseUrl);
  productionUrl = new URL(process.env.DATABASE_URL);
} catch {
  console.error('TEST_DATABASE_URL یا DATABASE_URL معتبر نیست.');
  process.exit(2);
}
const canonicalHost = (host) => ({ localhost: '127.0.0.1', '::1': '127.0.0.1' }[String(host || '').toLowerCase()] || String(host || '').toLowerCase());
const sameTarget = productionUrl
  && canonicalHost(testUrl.hostname) === canonicalHost(productionUrl.hostname)
  && (testUrl.port || '5432') === (productionUrl.port || '5432')
  && decodeURIComponent(testUrl.pathname) === decodeURIComponent(productionUrl.pathname);
if (sameTarget) {
  console.error('برای تست PostgreSQL از دیتابیس جداگانه استفاده کن؛ اجرای آزمون روی دیتابیس تولیدی مسدود شد.');
  process.exit(2);
}
if (!['postgres:', 'postgresql:'].includes(testUrl.protocol) || !testUrl.hostname || !testUrl.pathname.slice(1)) {
  console.error('TEST_DATABASE_URL باید یک نشانی معتبر postgresql:// به دیتابیس آزمایشی باشد.');
  process.exit(2);
}
if (!/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(testUrl.pathname.slice(1)))) {
  console.error('برای ایمنی، نام دیتابیس آزمایشی باید شامل test باشد؛ مانند acm_classroom_test.');
  process.exit(2);
}
const result = spawnSync(process.execPath, ['--test', 'app.test.js'], {
  cwd: root,
  env: { ...process.env, ACM_TEST_DATABASE_URL: testDatabaseUrl },
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(`اجرای تست‌های PostgreSQL ناموفق بود: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
