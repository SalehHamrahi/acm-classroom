import { loadEnv } from '../server/env.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { openDatabase, hashPassword, logAudit } from '../server/db.js';

loadEnv();

let rl = null;
let pipedLines = null;
if (input.isTTY) {
  rl = readline.createInterface({ input, output });
} else {
  const chunks = [];
  for await (const chunk of input) chunks.push(String(chunk));
  pipedLines = chunks.join('').split(/\r?\n/);
}

async function askLine(prompt) {
  if (pipedLines) {
    output.write(prompt);
    return (pipedLines.shift() ?? '').trim();
  }
  return (await rl.question(prompt)).trim();
}

async function askSecret(prompt) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return askLine(`${prompt} (در حالت غیرتعاملی متن قابل مشاهده است): `);
  }

  output.write(prompt);
  input.setEncoding('utf8');
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish(new Error('عملیات لغو شد.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          value += char;
          output.write('*');
        }
      }
    };
    input.on('data', onData);
  });
}

let db;
try {
  db = await openDatabase();
  const admins = await db.prepare(
    "SELECT id, username, display_name FROM users WHERE role = 'admin' AND active = 1 ORDER BY username"
  ).all();

  if (!admins.length) {
    throw new Error('هیچ مدیر فعالی پیدا نشد. هیچ تغییری انجام نشد.');
  }

  console.log('\nبازیابی گذرواژه مدیر ACM Classroom');
  console.log('این ابزار فقط گذرواژهٔ یک مدیر فعال را تغییر می‌دهد و اطلاعات دیگر را حذف نمی‌کند.\n');
  console.log('مدیران فعال:');
  for (const admin of admins) {
    console.log(`- ${admin.username} (${admin.display_name})`);
  }

  const username = (await askLine('\nنام کاربری دقیق مدیر موردنظر: ')).toLowerCase();
  const admin = admins.find((item) => item.username.toLowerCase() === username);
  if (!admin) throw new Error('این نام کاربری در فهرست مدیران فعال نیست؛ هیچ تغییری انجام نشد.');

  rl?.close();
  rl = null;
  const password = await askSecret('گذرواژهٔ جدید (حداقل 12 نویسه): ');
  const confirm = await askSecret('تکرار گذرواژهٔ جدید: ');
  if (password.length < 12 || password.length > 200) {
    throw new Error('گذرواژه باید بین 12 تا 200 نویسه باشد.');
  }
  if (password !== confirm) throw new Error('گذرواژه‌ها یکسان نیستند.');

  await db.transaction(async () => {
    const result = await db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND role = 'admin' AND active = 1"
    ).run(hashPassword(password), admin.id);
    if (result.changes !== 1) throw new Error('حساب مدیر تغییر کرده است؛ عملیات متوقف شد.');
    await db.prepare('DELETE FROM login_sessions WHERE user_id = ?').run(admin.id);
    await logAudit(
      db,
      admin.id,
      'local_admin_password_recovery',
      'user',
      admin.id,
      'گذرواژه مدیر از طریق ابزار بازیابی محلی تغییر کرد.'
    );
  });

  console.log(`\nگذرواژهٔ مدیر «${admin.username}» با موفقیت تغییر کرد.`);
  console.log('با همین نام کاربری و گذرواژهٔ جدید وارد سایت شو؛ پس از ورود، گذرواژه را تغییر بده.');
} catch (error) {
  console.error(`\nخطا: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
  try {
    await db?.close();
  } catch {
    // Preserve the original operation error.
  }
}
