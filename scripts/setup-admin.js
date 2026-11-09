import { loadEnv } from '../server/env.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { openDatabase, createUser, logAudit } from '../server/db.js';

loadEnv();
// readline can consume piped stdin lines before sequential questions are registered.
// Buffer scripted input up front for reliable non-interactive tests/automation.
let pipedLines = null;
if (!input.isTTY) {
  const chunks = [];
  for await (const chunk of input) chunks.push(String(chunk));
  pipedLines = chunks.join('').split(/\r?\n/);
}
const rl = input.isTTY ? readline.createInterface({ input, output }) : null;
const ask = async (prompt) => {
  if (pipedLines) { output.write(prompt); return (pipedLines.shift() ?? '').trim(); }
  return (await rl.question(prompt)).trim();
};
async function askSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return ask(prompt);
  rl.close();
  output.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); output.write('\n');
          reject(new Error('لغو شد.')); process.exitCode = 130; return;
        }
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); output.write('\n'); resolve(value); return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length) { value = value.slice(0, -1); output.write('\b \b'); }
          continue;
        }
        if (char >= ' ') { value += char; output.write('*'); }
      }
    };
    process.stdin.on('data', onData);
  });
}
let db;
try {
  db = await openDatabase();
  const exists = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").get();
  if (exists) {
    console.log('یک مدیر فعال از قبل وجود دارد. برای افزودن کاربران، از پنل مدیر استفاده کن.');
    process.exitCode = 0;
    rl?.close();
    await db.close();
    process.exit(0);
  }
  console.log('\nساخت اولین مدیر ACM Classroom (این دستور محلی است؛ ثبت‌نام عمومی وجود ندارد)\n');
  const username = await ask('نام کاربری مدیر (حروف انگلیسی/عدد/._-): ');
  const displayName = await ask('نام نمایشی مدیر: ');
  const password = await askSecret('گذرواژه (حداقل 12 نویسه): ');
  const confirm = await askSecret('تکرار گذرواژه: ');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new Error('قالب نام کاربری درست نیست.');
  if (!displayName) throw new Error('نام نمایشی الزامی است.');
  if (password.length < 12 || password.length > 200) throw new Error('گذرواژه باید بین 12 تا 200 نویسه باشد.');
  if (password !== confirm) throw new Error('گذرواژه‌ها یکسان نیستند.');
  const id = await createUser(db, { username, displayName, role: 'admin', password, mustChangePassword: false });
  await logAudit(db, id, 'bootstrap_admin', 'user', id, 'اولین مدیر ایجاد شد');
  console.log(`\nمدیر «${username}» با موفقیت ساخته شد. حالا npm start را اجرا کن.\n`);
} catch (error) {
  console.error(`خطا: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
  try { await db?.close(); } catch { /* preserve the original setup error */ }
}
