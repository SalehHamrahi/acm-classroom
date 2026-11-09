# مرجع رسمی ACM Classroom

> **نسخهٔ کد:** `2.13.0` · **زبان:** فارسی · **همتای انگلیسی:** [`README.en.md`](README.en.md)

این سند مرجع واحد محصول، معماری، توسعه و عملیات ACM Classroom است. گزارش‌های ساخت، changelogها، ممیزی‌ها و roadmapهای پراکندهٔ قدیمی از بسته حذف شده‌اند. از این پس هر تغییر معماری یا رفتاری باید هم‌زمان در این دو فایل مرجع فارسی و انگلیسی ثبت شود.

---

## ۱. معرفی و محدودهٔ محصول

ACM Classroom سامانه‌ای خصوصی و خودمیزبان برای **مدیریت کلاس‌های برنامه‌نویسی، بانک سؤال، تکالیف، مسابقات، ارسال کد، داوری خودکار و گزارش عملکرد** است.

این محصول LMS، سایت آموزش آنلاین یا پلتفرم دوره نیست. دانش‌آموز از سایت برای مشاهدهٔ فعالیت‌های مجاز و منتشرشده، ارسال پاسخ برنامه‌نویسی، پیگیری نتیجه، تحویل تکلیف و شرکت در مسابقه استفاده می‌کند. دورهٔ آموزشی، مسیر یادگیری، محتوای درس و آموزش مرحله‌ای نباید دوباره اضافه شوند، مگر با تصمیم صریح مالک محصول.

اصول پایه:

- ثبت‌نام عمومی وجود ندارد؛ ایجاد و مدیریت حساب‌ها در اختیار مدیر سامانه است.
- بانک سؤال بین معلمان مشترک است و مالکیت/ویرایش سؤال به نویسندهٔ آن وابسته است.
- مسابقه برای شرکت‌کنندگان تعریف می‌شود، نه الزاماً برای یک کلاس؛ معلم می‌تواند دانش‌آموزان کلاس‌های مختلف را دعوت کند.
- داوری کد فقط با Docker و به‌صورت self-hosted انجام می‌شود.
- تاریخ‌های ورودی و نمایشی کاربر باید شمسی باشند.
- PostgreSQL تنها دیتابیس عملیاتی است.

## ۲. نقش‌ها و مرز دسترسی

### مدیر (`admin`)

مدیریت حساب‌های مدیر، معلم و دانش‌آموز؛ مشاهدهٔ آمار و رتبه‌بندی سراسری؛ مشاهدهٔ ارسال‌ها و رخدادهای امنیتی؛ مدیریت و پاک‌سازی داده با مجوز و تأیید لازم؛ ساخت و دانلود Backup؛ مشاهدهٔ سلامت سرویس، منابع، داوری و اعلان‌ها.

### معلم (`teacher`)

مدیریت کلاس‌های خودش و اعضا؛ ایجاد جلسه و سؤال؛ استفاده از بانک سؤال مشترک؛ ساخت تکلیف و مسابقه؛ انتخاب شرکت‌کنندگان؛ مشاهدهٔ گزارش و ارسال‌های مرتبط؛ مدیریت بررسی AI. معلم نباید دادهٔ خصوصی کلاس معلم دیگر را از API دریافت کند. استثنای مسابقه/تکلیف فقط برای دانش‌آموزانی است که صریحاً به آن فعالیت دعوت شده‌اند.

### دانش‌آموز (`student`)

مشاهدهٔ جلسه و سؤال منتشرشده و مجاز؛ تحویل تکلیف و شرکت در مسابقهٔ دعوت‌شده؛ ویرایش و اجرای کد؛ ذخیرهٔ Draft؛ مشاهدهٔ نتیجه و تاریخچهٔ تلاش‌های خودش؛ مشاهدهٔ گزارش و اعلان‌های شخصی. دانش‌آموز نباید منبع کد یا دادهٔ خصوصی دانش‌آموز دیگری را ببیند.

**قاعدهٔ امنیت:** انتشار سؤال، عضویت کلاس، دعوت به فعالیت و پنجرهٔ زمانی دسترسی باید در Backend و در هر endpoint کنترل شوند؛ مخفی‌کردن دکمه در Frontend کنترل دسترسی محسوب نمی‌شود.

## ۳. قابلیت‌ها و قواعد کسب‌وکار

### کلاس و جلسه

- کلاس به معلم مالک آن متصل است.
- انتقال دانش‌آموز بین کلاس‌ها نباید امتیازهای قبلی او را از بین ببرد.
- جلسه می‌تواند تاریخ شمسی، ساعت شروع/پایان و وضعیت فعال/منتشرشده داشته باشد.
- دانش‌آموز فقط جلسه و سؤال منتشرشده‌ای را می‌بیند که عضویت و زمان دسترسی آن را مجاز کند.
- معلم امکان خروجی/ورودی جلسه را دارد.

### بانک سؤال مشترک

- بانک بین تمام معلمان مشترک است.
- هر سؤال نویسنده/مالک دارد؛ ویرایش و حذف به مجوز مالک محدود است.
- سایر معلمان می‌توانند سؤال را در جلسهٔ خود کپی کنند.
- هنگام استفاده از سؤال در تکلیف یا مسابقه، متن و تست‌ها Snapshot می‌شوند تا ویرایش بعدی بانک، فعالیت منتشرشدهٔ قبلی را تغییر ندهد.
- سؤال می‌تواند Python، C++ یا هر دو را بپذیرد و تنظیمات استاندارد/بهینه‌سازی C++ داشته باشد.

### تکلیف

- تکلیف از بانک سؤال ساخته می‌شود و شرکت‌کنندگان آن صریحاً انتخاب می‌شوند.
- تکلیف زمان شروع، مهلت تحویل، وضعیت انتشار و سیاست تحویل دیرهنگام دارد.
- سؤال‌های تکلیف Snapshot هستند.
- گزارش باید وضعیت تحویل تمام دعوت‌شدگان، ارسال دیرهنگام، امتیاز و نتیجه را منعکس کند.
- تشخیص شباهت کد بر پایهٔ fingerprint ابزار بررسی معلم است و به‌تنهایی اثبات تخلف نیست.

### مسابقه

- مسابقه مستقل از کلاس است و می‌تواند دانش‌آموزان چند کلاس را دعوت کند.
- سؤال‌ها از بانک مشترک انتخاب و برای مسابقه Snapshot می‌شوند.
- شروع، پایان، شرکت‌کنندگان، جدول رتبه‌بندی و Freeze جدول امتیاز قابل مدیریت‌اند.
- جریمه بر پایهٔ تعداد ارسال اشتباه معتبر و جریمهٔ تعریف‌شده است؛ زمان سپری‌شده تا حل سؤال نباید خودکار به جریمه اضافه شود.
- ارسال‌های علامت‌گذاری‌شده با بررسی AI نباید به‌عنوان تلاش اشتباه معتبر جریمه شوند.
- دعوت و زمان مجاز مسابقه در هر درخواست دانش‌آموز بررسی می‌شود.

### ارسال، امتیاز و Draft

- هر Submission شامل زبان، کد، verdict، تعداد تست موفق، امتیاز و زمان اجراست.
- امتیاز هر سؤال بر پایهٔ بهترین امتیاز معتبر دانش‌آموز محاسبه می‌شود، نه جمع تمام تلاش‌ها.
- محدودیت تعداد تلاش و قفل‌شدن سؤال پس از پاسخ پذیرفته‌شده باید سمت سرور enforce شوند.
- `code_drafts` از `submissions` جداست؛ Draft خصوصی است و پس از پذیرش طبق منطق محصول پاک می‌شود.
- کد منبع Submission حداکثر **۷ روز** نگهداری می‌شود؛ پس از آن حذف یا غیرقابل‌دسترسی است، اما متادیتای نتیجه و تاریخچهٔ ضروری می‌تواند بماند.
- دانش‌آموز فقط کد و جزئیات تلاش‌های خودش را مشاهده یا مقایسه می‌کند.

### گزارش، رتبه‌بندی و اعلان

- گزارش دانش‌آموز شامل امتیاز، فعالیت و پیشرفت است.
- معلم گزارش کلاس و مقایسهٔ عملکرد دانش‌آموزان/کلاس‌های تحت اختیارش را می‌بیند.
- مدیر آمار و رتبه‌بندی سراسری را می‌بیند.
- انتقال دانش‌آموز نباید امتیازهای قبلی را صفر کند.
- اعلان داخلی سایت از Outbox ارسال بله مستقل است؛ شکست بله نباید اعلان داخلی را حذف کند.
- اتصال بله با کد یک‌بارمصرف و تاریخ انقضا انجام می‌شود؛ `BALE_BOT_TOKEN` محرمانه است.

## ۴. تقویم و زمان

- همهٔ تاریخ‌های ورودی و نمایشی باید **هجری شمسی** باشند؛ شامل جلسه، تقویم کلاس، تکلیف، مسابقه، فرم‌ها و گزارش‌ها.
- از Date Picker شمسی مشترک و موجود استفاده کن؛ برای هر صفحه تقویم جدا نساز.
- ذخیرهٔ فنی timestamp می‌تواند ISO/UTC باشد؛ نمایش با منطقهٔ زمانی تهران انجام شود.
- فیلدهای شمسی دامنه مانند `jalali_date` باید حفظ شوند.
- تغییر قالب نمایش نباید کنترل زمان شروع/پایان و مجوز دسترسی سمت سرور را تغییر دهد.

## ۵. معماری و فناوری

```text
React + Vite + Monaco
          │  /api (same-origin)
          ▼
Node.js HTTP server
  ├─ Auth / roles / API
  ├─ Reports / assignments / contests
  ├─ Bale bot + notification outbox
  ├─ PostgreSQL async adapter (pg.Pool)
  └─ Docker judge: Python + C++
```

| بخش | فناوری |
|---|---|
| Runtime | Node.js `>=22.13.0`؛ Node 24 هدف مناسب است |
| Frontend | React 18، Vite 6 |
| Editor | Monaco؛ assetها به‌صورت محلی در `public/monaco/vs` |
| Backend | Node.js HTTP API، ES Modules |
| Database | PostgreSQL 16 در Compose نمونه |
| DB driver | `pg` و `pg.Pool` ناهمگام |
| Python judge | `python:3.13-alpine` |
| C++ judge | `acm-cpp-runner:17`؛ استانداردهای 17 و 20 |
| Reverse proxy | Caddy در استقرار نمونه |
| Notification | اعلان داخلی و Bale اختیاری |

### ساختار فایل‌های مهم

```text
src/
  main.jsx                 صفحات و رابط اصلی React
  style.css                چیدمان و استایل پایه
  theme.css                قوانین تم موجود
  glass.css                لایهٔ Glass UI موجود
  MonacoEditor.jsx         اتصال Monaco
  number-format.js         فرمت عدد و تاریخ فارسی
  testcase-utils.js        توابع تست‌کیس
  polling.js               زمان‌بندی polling

server/
  index.js                 راه‌اندازی و shutdown
  app.js                   API، routeها و منطق دسترسی
  db.js                    مرز دیتابیس و توابع رمز
  postgres-database.js     pg.Pool، migration و transaction
  postgres-schema.sql      schema پایهٔ PostgreSQL
  judge.js                 داوری Docker برای Python/C++
  bale-bot.js              بات بله و اعلان‌ها
  backup.js                Backup و Restore
  code-similarity.js       fingerprint شباهت کد
  env.js                   بارگذاری `.env`
  sqlite-test-database.js  آداپتور SQLite فقط برای تست مستقل

deploy/
  setup-ubuntu-vps.sh      نصب نمونه روی Ubuntu 24.04
  *.service, *.timer       سرویس‌های systemd
  Caddyfile                reverse proxy
  .env.production.example الگوی تنظیمات تولید

scripts/
  dev.js                   اجرای API و Vite در توسعه
  setup-admin.js           ساخت اولین مدیر
  check-db.js              بررسی اتصال و آماده‌سازی schema
  run-postgres-api-tests.js تست API با PostgreSQL واقعی
  create-backup.js         ساخت پشتیبان
  restore-backup.js        بازیابی پشتیبان
  copy-monaco.js           کپی فایل‌های Monaco
```

`server/app.js` و `src/main.jsx` فایل‌های بزرگ و متمرکز هستند؛ تغییرات را تا جای ممکن موضعی و تست‌پذیر نگه دار. بازنویسی گسترده بدون نیاز محصولی ریسک regression دارد.

## ۶. پایگاه داده و Migration

**PostgreSQL تنها دیتابیس عملیاتی است.** در Production به SQLite fallback نکن. `server/sqlite-test-database.js` فقط برای تعدادی تست مستقل قدیمی است.

- Schema اصلی در `server/postgres-schema.sql` است.
- `openDatabase()` به PostgreSQL وصل می‌شود، جدول `acm_schema_migrations` را بررسی می‌کند و schema پایه و migrationهای اعمال‌نشده را به‌صورت تراکنشی اجرا می‌کند.
- Runtime از `pg.Pool` استفاده می‌کند؛ برای Queryهای عادی برنامه به `psql.exe` نیاز نیست.
- پارامترها را bind کن؛ مقدار کاربر را داخل رشتهٔ SQL interpolate نکن.
- لایهٔ سازگاری placeholder قدیمی `?` را به `$1`, `$2`, ... تبدیل می‌کند؛ SQL جدید را با رفتار PostgreSQL بنویس.
- پارامتر `NULL` در شرط اختیاری باید نوع صریح داشته باشد؛ نمونه: `CAST(? AS TEXT) IS NULL` (نوع درست را متناسب با ستون انتخاب کن).
- از `PRAGMA`، `INSERT OR IGNORE` و `COLLATE NOCASE` در مسیر عملیاتی استفاده نکن.
- تراکنش بیرونی یک Client از Pool می‌گیرد؛ `AsyncLocalStorage` همان Client را در callback نگه می‌دارد؛ تراکنش تو‌در‌تو از `SAVEPOINT` استفاده می‌کند.
- retry محدود برای SQLSTATEهای `40001` و `40P01` وجود دارد. callback تراکنش ممکن است دوباره اجرا شود؛ ارسال پیام یا side effect خارجی را داخل آن نگذار.

### جدول‌های اصلی

`users`, `login_sessions`, `teacher_classes`, `class_memberships`, `class_sessions`, `class_schedule_events`, `problems`, `test_cases`, `question_bank`, `question_bank_tests`, `assignments`, `assignment_participants`, `assignment_problems`, `assignment_submissions`, `contests`, `contest_participants`, `contest_problems`, `contest_submissions`, `submissions`, `code_drafts`, `notifications`, `bale_links`, `bale_link_codes`, `bale_notification_outbox`, `bale_state`, `bale_processed_updates`, `audit_log`, `admin_security_events`.

## ۷. تنظیمات محیطی `.env`

از `.env.example` برای توسعه و `deploy/.env.production.example` برای تولید الگو بگیر. مقدارهای نمونه باید عوض شوند. فایل واقعی `.env` محرمانه است و نباید در Git یا ZIP توزیع قرار گیرد.

| متغیر | کاربرد |
|---|---|
| `APP_ORIGIN` | Origin رسمی برنامه و allowlist؛ باید با URL سایت هماهنگ باشد |
| `HOST` | آدرس listen؛ پیش‌فرض `127.0.0.1` |
| `PORT` | پورت HTTP؛ نمونهٔ توسعه 3000 و نمونهٔ تولید 3002 |
| `DATABASE_DRIVER` | باید `postgres` باشد |
| `POSTGRES_DB` | نام دیتابیس؛ معمولاً `acm_classroom` |
| `POSTGRES_USER` | نقش PostgreSQL؛ معمولاً `acm_classroom` |
| `POSTGRES_PASSWORD` | رمز قوی نقش PostgreSQL |
| `DATABASE_URL` | اتصال دیتابیس اصلی؛ نام دیتابیس باید با `POSTGRES_DB` یکی باشد |
| `TEST_DATABASE_URL` | اتصال دیتابیس تست جدا؛ نام دیتابیس باید شامل `test` باشد |
| `PG_POOL_MAX` | بیشینه اتصال Pool؛ پیش‌فرض 10، دامنه 2 تا 50 |
| `PG_IDLE_TIMEOUT_MS` | مهلت اتصال idle؛ پیش‌فرض 30000 |
| `PG_CONNECTION_TIMEOUT_MS` | مهلت گرفتن اتصال؛ پیش‌فرض 8000 |
| `PG_DUMP_BIN`, `PG_RESTORE_BIN` | مسیر ابزارهای Backup PostgreSQL |
| `BACKUP_DIR` | مسیر فایل‌های پشتیبان |
| `BACKUP_RETENTION_DAYS` | مدت نگهداری؛ پیش‌فرض 30 روز |
| `SESSION_HOURS` | عمر نشست ورود؛ پیش‌فرض 12 ساعت |
| `DOCKER_IMAGE` | تصویر Python؛ پیش‌فرض `python:3.13-alpine` |
| `DOCKER_CPP_IMAGE` | تصویر C++؛ پیش‌فرض `acm-cpp-runner:17` |
| `MAX_CONCURRENT_JUDGES` | سقف داوری هم‌زمان در همین نمونه Node |
| `BALE_BOT_TOKEN` | توکن اختیاری و محرمانهٔ بات بله |

برای رمز قوی روی Linux:

```bash
openssl rand -hex 32
```

یک رمز یکسان در `POSTGRES_PASSWORD` و بخش رمز `DATABASE_URL` بگذار. نویسه‌های رزروشده در URI باید URL-encode شوند؛ رمز hex این مشکل را ندارد.

**هشدار Vite:** برای کنترل Build فرانت‌اند، `NODE_ENV` را داخل `.env` تنظیم نکن؛ Vite حالت Production را در `npm run build` مدیریت می‌کند و ممکن است با `NODE_ENV=production` داخل `.env` هشدار بدهد. نمونهٔ systemd، NODE_ENV تولید را در سطح سرویس تنظیم می‌کند.

## ۸. راه‌اندازی توسعه روی Windows 11

پیش‌نیاز: Node.js `>=22.13.0` (ترجیحاً 24)، npm، Docker Desktop با Linux containers و PostgreSQL. Docker Desktop برای داوری باید روشن باشد.

```powershell
Copy-Item .env.example .env
# .env را باز کن؛ رمز و APP_ORIGIN/PORT/DATABASE_URL را تنظیم کن

docker compose up -d postgres
npm ci
npm run db:check
npm run docker:build-cpp
docker pull python:3.13-alpine
npm run setup:admin
```

`npm run setup:admin` فقط در صورت نبود مدیر فعال، اولین مدیر را ایجاد می‌کند. اگر مدیر فعال وجود داشته باشد، از ایجاد حساب تکراری خودداری می‌کند و رمز او را reset نمی‌کند.

توسعه با Vite و API:

```powershell
npm run dev
```

Vite طبق `scripts/dev.js` روی `http://127.0.0.1:5173` است و API روی `HOST:PORT` تعریف‌شده در `.env` گوش می‌دهد.

Build و اجرای سرویس:

```powershell
npm test
npm run build
npm start
```

`npm start` سرور Node را اجرا می‌کند و فرانت‌اند Buildشده از `dist` سرو می‌شود. PostgreSQL و یک مدیر فعال باید موجود باشند.

## ۹. فرمان‌های مهم

| فرمان | کاربرد |
|---|---|
| `npm ci` | نصب تکرارپذیر وابستگی‌ها از lockfile |
| `npm run dev` | اجرای API و Vite برای توسعه |
| `npm run build` | کپی Monaco و Build تولیدی Vite |
| `npm start` | اجرای سرور برنامه |
| `npm test` | مجموعه تست Node |
| `npm run test:postgres` | تست API روی PostgreSQL واقعی و دیتابیس تست جدا |
| `npm run db:check` | اتصال به PostgreSQL و آماده‌سازی/بررسی schema |
| `npm run setup:admin` | ساخت اولین مدیر |
| `npm run backup:db` | ساخت و اعتبارسنجی Backup |
| `npm run restore:db -- --backup <file.dump> --yes` | Restore پس از توقف سرویس |
| `npm run docker:build-cpp` | ساخت تصویر داوری C++ |
| `npm run copy:monaco` | کپی assetهای Monaco |

## ۱۰. مدیر اولیه و بازیابی حساب

- ثبت‌نام عمومی غیرفعال است.
- `npm run setup:admin` فقط اولین مدیر فعال را در دیتابیس خالی ایجاد می‌کند.
- پیام «یک مدیر فعال از قبل وجود دارد» مربوط به رکورد `admin` در جدول `users` برنامه است، نه صرفاً وجود نقش/کاربر PostgreSQL.
- هش رمز با `crypto.scryptSync` و salt تصادفی و بررسی زمان‌ثابت در `server/db.js` پیاده‌سازی شده است.
- هر ابزار رسمی بازیابی مدیر باید `hashPassword()` و `verifyPassword()` همان فایل را import کند؛ الگوریتم جدا یا SHA-256 ساده برای رمز نساز.
- ابزار bootstrap برای reset رمز طراحی نشده است؛ مدیریت عادی حساب از پنل مدیر انجام می‌شود.

## ۱۱. تست و کنترل کیفیت

### تست عمومی

```powershell
npm test
```

تست‌ها API، دیتابیس، Judge، تشخیص شباهت، تم، CSS، Layout، PWA، فونت، polling، فرمت عدد و موارد امنیتی را پوشش می‌دهند. برخی تست‌های نیازمند PostgreSQL واقعی در اجرای عمومی ممکن است skip شوند.

### تست API با PostgreSQL واقعی

یک دیتابیس مجزا مانند `acm_classroom_test` بساز و `TEST_DATABASE_URL` را در `.env` تنظیم کن. هرگز دیتابیس عملیاتی را به runner تست نده.

```powershell
docker compose exec -T postgres createdb -U acm_classroom acm_classroom_test
npm run test:postgres
```

Runner نام دیتابیس شامل `test` را بررسی می‌کند، برای fixtureها schema موقت می‌سازد و پس از پایان حذف می‌کند. اگر فرایند قطع شود ممکن است schema با پیشوند `acm_test_` باقی بماند؛ فقط پس از اطمینان از توقف تست‌ها همان schema را بررسی و پاک کن، نه کل DB یا Volume را.

### Build

```powershell
npm run build
```

Build ابتدا `copy:monaco` را اجرا می‌کند و خروجی در `dist` قرار می‌گیرد. پس از تغییر UI/CSS، تست هدفمند مانند `ui-layout.test.js`، `css-integrity.test.js` یا `theme.test.js` را نیز اجرا کن.

## ۱۲. امنیت داوری

کد دانش‌آموز غیرقابل‌اعتماد است و فقط داخل Docker اجرا می‌شود. اجرای کد کاربر با `eval`، `exec` یا shell روی میزبان ممنوع است. Judge0 یا سرویس داوری خارجی را بدون تصمیم صریح مالک محصول اضافه نکن.

Python با شبکهٔ غیرفعال (`--network=none`)، فایل‌سیستم فقط‌خواندنی، محدودیت حافظه/CPU/PID، کاربر غیرریشه، حذف capabilityها و `no-new-privileges` اجرا می‌شود. C++ نیز تصویر مستقل و محدودیت منابع دارد.

- دسترسی Docker برای فرایند برنامه لازم است.
- عضویت در گروه `docker` در Linux عملاً root-equivalent است؛ VPS اختصاصی استفاده کن.
- `MAX_CONCURRENT_JUDGES` را با منابع میزبان هماهنگ کن.
- اندازهٔ ورودی، خروجی، زمان اجرا و پاسخ Judge محدود بماند.
- سیاست نگهداری Source هفت‌روزه را بدون بررسی حریم خصوصی تغییر نده.

## ۱۳. Backup، Restore و Reset دیتابیس

### Backup عادی

```powershell
npm run backup:db
```

Backup با فرمت custom PostgreSQL ساخته و با `pg_restore --list` اعتبارسنجی می‌شود. استقرار نمونهٔ Ubuntu، Backup روزانه ساعت 03:15 و نگهداری پیش‌فرض 30 روز دارد. یک نسخهٔ رمزگذاری‌شده خارج از VPS نگه دار.

### Restore

سرویس برنامه و workerها را متوقف و نام فایل را بررسی کن:

```powershell
npm run restore:db -- --backup acm-classroom-YYYYMMDDTHHMMSSZ-xxxxxxxx.dump --yes
```

اسکریپت قبل از Restore یک Snapshot ایمنی می‌سازد و در صورت شکست، تلاش می‌کند آن را بازگرداند. Restore محتوای دیتابیس فعلی را جایگزین می‌کند.

### بازنشانی کامل دیتابیس اصلی

این عملیات **تمام حساب‌ها، کلاس‌ها، سؤال‌ها، تست‌ها، تکالیف، مسابقات، ارسال‌ها، امتیازها، اعلان‌ها و رخدادهای دیتابیس اصلی را حذف می‌کند**. قبل از اجرا Backup بگیر، نام دیتابیس را دوباره بررسی و سرویس برنامه را متوقف کن.

```powershell
pg_dump -h 127.0.0.1 -p 5432 -U acm_classroom -d acm_classroom -Fc -f ".\acm-classroom-before-reset.dump"
psql -h 127.0.0.1 -p 5432 -U acm_classroom -d postgres -W
```

در `psql`، فقط پس از تأیید اتصال به دیتابیس مدیریتی `postgres` اجرا کن:

```sql
DROP DATABASE IF EXISTS acm_classroom WITH (FORCE);
CREATE DATABASE acm_classroom OWNER acm_classroom;
\q
```

سپس:

```powershell
npm run db:check
npm run setup:admin
```

`db:check` با بازکردن دیتابیس، schema پایه و migrationها را خودکار اعمال می‌کند؛ سپس `setup:admin` اولین مدیر را می‌سازد. این دستورات دیتابیس جداگانهٔ `acm_classroom_test` و Volume PostgreSQL را حذف نمی‌کنند. از `docker compose down -v` برای reset فقط دیتابیس اصلی استفاده نکن؛ این فرمان Volume را حذف می‌کند. کاربر PostgreSQL باید مجوز `CREATEDB` و `DROP DATABASE` داشته باشد؛ در غیر این صورت از نقش مدیر PostgreSQL استفاده کن.

## ۱۴. استقرار Ubuntu 24.04

`deploy/setup-ubuntu-vps.sh` برای Ubuntu 24.04 طراحی شده و Node.js 24، Docker Engine/Compose، Caddy، ابزارهای client PostgreSQL، کاربر سرویس `acmclassroom`، systemd، PostgreSQL 16 در Compose، تست‌ها، Build، تصاویر داوری، مدیر اولیه و Backup timer را آماده می‌کند.

راهنمای نمونه حداقل ۲ هسته CPU، ۴GB RAM و ۵۰GB SSD را پیشنهاد می‌کند؛ برای داوری هم‌زمان بیشتر منابع بالاتری لازم است. دامنهٔ hard-coded در اسکریپت نمونه `acm-classroom.ir` است؛ تغییر دامنه مستلزم هماهنگ‌سازی فایل‌های استقرار است.

پس از استخراج پروژه به `/opt/acm-classroom`:

```bash
sudo bash /opt/acm-classroom/deploy/setup-ubuntu-vps.sh
```

بررسی سرویس‌ها:

```bash
systemctl status acm-classroom --no-pager
systemctl status acm-classroom-backup.timer --no-pager
systemctl status caddy --no-pager
cd /opt/acm-classroom && docker compose ps
cd /opt/acm-classroom && npm run db:check
curl -fsS http://127.0.0.1:3002/api/health
journalctl -u acm-classroom -n 100 --no-pager
```

**پورت 5432 را به اینترنت باز نکن.** دسترسی گروه Docker بسیار قدرتمند است؛ برنامه را روی VPS اختصاصی اجرا کن.

## ۱۵. PWA و Cache

پروژه Manifest و Service Worker دارد. Service Worker فقط پوستهٔ عمومی را cache می‌کند؛ پاسخ خصوصی API، کد دانش‌آموز و اطلاعات کلاس نباید در Cache عمومی ذخیره شوند. نصب PWA پس از فعال‌شدن HTTPS از مرورگرهای سازگار ممکن است.

## ۱۶. پنل سلامت سامانه و وضعیت UI مرجع

پنل مدیر اطلاعات فرایند Node، حافظه، دیسک، اتصال‌های PostgreSQL، ظرفیت داوری، Outbox بله، شمار حساب‌ها/مسابقات و Backupها را نشان می‌دهد.

نسخهٔ مرجع فعلی شامل اصلاح محدود پنل سلامت مدیر است:

- کارت‌های «منابع و ظرفیت» و «صف داوری و اعلان‌ها» در صفحهٔ عریض کنار هم و در عرض ۹۰۰ پیکسل و کمتر زیر هم‌اند.
- نسبت ظرفیت‌ها با عبارت «N از M» نمایش داده می‌شود تا RTL ترتیب عدد را مبهم نکند.
- Load average در Windows به‌جای صفر گمراه‌کننده «در دسترس نیست» است.
- ظرفیت صفر صف انتظار به‌درستی «صف انتظار غیرفعال» نمایش داده می‌شود.

این اصلاحیه مجوز بازنویسی تم یا CSS سایر صفحات نیست. مبنای ظاهر همان `style.css`، `theme.css` و `glass.css` نسخهٔ اصلی است؛ شاخهٔ آزمایشی Glass Design System که کنار گذاشته شد در این مرجع وجود ندارد.

## ۱۷. اصول تغییرات آینده

1. پیش از ویرایش، endpoint، component، schema و تست مرتبط را پیدا کن؛ تغییر حدسی و بازنویسی گسترده انجام نده.
2. رفتار موجود و مرز مجوزهای Admin/Teacher/Student را حفظ کن.
3. SQL را برای PostgreSQL بنویس، پارامترها را bind و نوع `NULL` را صریح کن.
4. مجوز را در Backend enforce کن؛ پنهان‌کردن دکمه امنیت نیست.
5. تاریخ ورودی/نمایشی شمسی و Date Picker مشترک باشد.
6. داوری فقط Docker است؛ کد کاربر روی host اجرا نشود.
7. امتیاز، سقف تلاش، AI flag، penalty، Snapshot سؤال و retention کد را با regression test محافظت کن.
8. تغییر UI تست Layout/CSS/Theme مرتبط داشته باشد و سایر صفحات ناخواسته تغییر نکنند.
9. `.env` واقعی، رمز، توکن، Backup و دادهٔ واقعی را در ZIP/commit عمومی قرار نده.
10. پس از تغییر `npm test`، تست هدفمند، `npm run test:postgres` با DB تست مستقل و `npm run build` را تا حد امکان اجرا کن؛ نتیجهٔ واقعی را گزارش بده.
11. تست اجرا‌نشده را موفق اعلام نکن؛ محدودیت محیط را شفاف بگو.
12. این دو فایل README تنها مرجع مستندات‌اند؛ هر تصمیم جدید باید در هر دو به‌روزرسانی شود.

## ۱۸. قرارداد نسخه و تحویل

- نسخهٔ مرجع کد: `2.13.0`.
- دیتابیس عملیاتی: PostgreSQL-only.
- تغییر UI اخیر: اصلاح محدود پنل سلامت مدیر؛ هیچ شاخهٔ جدید Glass/Dark وارد نشده است.
- اسناد مجاز: `README.fa.md` و `README.en.md`؛ Markdown دیگری اضافه نشود، مگر با درخواست صریح مالک پروژه.
- ZIP توزیع نباید `.env` واقعی، دیتابیس، Docker Volume، `node_modules` یا credential/token محرمانه داشته باشد.
