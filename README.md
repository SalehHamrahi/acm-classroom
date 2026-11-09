# ACM Classroom — Official Project Reference

> **Code release:** `2.13.0` · **Language:** English · **Persian counterpart:** [`README.fa.md`](README.fa.md)

This is the single reference for ACM Classroom product scope, architecture, development, and operations. Historical build reports, changelogs, audits, and roadmap fragments have been consolidated and removed. Keep these two language files synchronized whenever product behavior or architecture changes.

---

## 1. Product overview and scope

ACM Classroom is a private, self-hosted platform for **programming classes, a shared problem bank, assignments, contests, code submissions, automated judging, and performance reports**.

It is not an LMS, online teaching system, or course platform. Students use the site to view eligible published activities, submit programming solutions, inspect results, deliver assignments, and participate in contests. Courses, learning paths, lesson content, and guided teaching features must not be reintroduced unless the product owner explicitly changes the scope.

Core principles:

- Public registration is disabled; account creation and management belong to system administrators.
- The question bank is shared by teachers; question ownership and edit/delete permission belong to its author.
- Contests are participant-oriented, not necessarily class-bound. Teachers may invite students from different classes.
- Code judging is self-hosted and Docker-only.
- All user-facing date inputs and displays use the Jalali (Solar Hijri) calendar.
- PostgreSQL is the only operational database.

## 2. Roles and access boundaries

### Administrator (`admin`)

Manages administrator/teacher/student accounts; views global metrics, rankings, submissions, and security events; performs explicitly authorized data operations; creates/downloads database backups; and inspects system, resource, judge, and notification health.

### Teacher (`teacher`)

Manages their own classes and memberships; creates sessions and problems; uses the shared problem bank; creates assignments and contests; selects participants; views related reports and submissions; and manages AI review. Teachers must not receive private data from another teacher's classes through APIs. Contest/assignment exceptions are limited to students explicitly invited to that activity.

### Student (`student`)

Views only eligible published sessions/problems; submits assignments and joins invited contests; edits/runs code; saves drafts; inspects results and their own attempt history; and views their own report and notifications. Students must never access another student's private source code or personal data.

**Security rule:** Publication state, class membership, activity invitation, and time-window access must be enforced in the backend for every relevant endpoint. Hiding a frontend button is not access control.

## 3. Features and business rules

### Classes and sessions

- A class belongs to its owning teacher.
- Moving a student between classes must not erase previously earned points.
- A session may have a Jalali date, start/end time, and active/published state.
- Students see only published sessions/problems allowed by membership and time rules.
- Teachers can export/import session data.

### Shared problem bank

- The problem bank is shared by all teachers.
- Each problem has an author/owner; editing and deletion are restricted to that owner.
- Other teachers may copy a problem into their own session.
- When a problem is used in an assignment or contest, its statement and test cases are snapshotted so later bank edits do not change the already-published activity.
- Problems can support Python, C++, or both, with configurable C++ standard and optimization settings.

### Assignments

- Teachers create assignments from the problem bank and explicitly select participants.
- Assignments have a start time, due date, publication status, and late-delivery policy.
- Assignment problems are snapshots.
- Reports should include delivery status for every invitee, late submissions, points, and results.
- Code similarity fingerprints are review signals for teachers, not proof of misconduct by themselves.

### Contests

- A contest is independent of a single class and may invite students from multiple classes.
- Problems are selected from the shared bank and snapshotted for the contest.
- Start/end times, participants, leaderboard, and optional scoreboard freeze are managed by the contest.
- Penalties are based on the configured penalty per valid wrong submission. Elapsed solve time must not automatically become a penalty.
- AI-flagged submissions must not be charged as valid wrong attempts.
- Invitations and contest time windows are checked on every student request.

### Submissions, scoring, and drafts

- A submission records language, source code, verdict, passed-test count, points, and runtime.
- A student's score for a problem is based on their best valid score, not the sum of all attempts.
- Attempt limits and locking after an accepted solution must be enforced server-side.
- `code_drafts` is separate from `submissions`; drafts are private and cleared after acceptance according to product logic.
- Submission source is retained for at most **7 days**. After that it is deleted or made unavailable, while result metadata and necessary history may remain.
- Students can inspect or compare only their own attempts.

### Reports, rankings, and notifications

- Student reports include points, activity, and progress.
- Teachers view class reports and comparisons for students/classes within their scope.
- Administrators view global metrics and rankings.
- Moving a student must not reset previous points to zero.
- In-app notifications are separate from the Bale outbox; a Bale delivery failure must not discard an in-app notification.
- Bale account linking uses a one-time expiring code. `BALE_BOT_TOKEN` is a secret.

## 4. Calendar and time policy

- All user-facing dates and date inputs use the **Jalali (Solar Hijri)** calendar, including sessions, class calendars, assignment/contest schedules, forms, and reports.
- Reuse the existing shared Jalali date picker; do not implement separate calendars per page.
- Exact internal timestamps may use ISO/UTC; convert to Tehran local time for display.
- Preserve domain Jalali fields such as `jalali_date`.
- Date presentation changes must not alter server-side time-window or access enforcement.

## 5. Architecture and technology

```text
React + Vite + Monaco
          │  /api (same-origin)
          ▼
Node.js HTTP server
  ├─ Auth / roles / API
  ├─ Reports / assignments / contests
  ├─ Bale bot + notification outbox
  ├─ Async PostgreSQL adapter (pg.Pool)
  └─ Docker judge: Python + C++
```

| Area | Technology |
|---|---|
| Runtime | Node.js `>=22.13.0`; Node 24 is a suitable target |
| Frontend | React 18, Vite 6 |
| Editor | Monaco; assets copied locally to `public/monaco/vs` |
| Backend | Node.js HTTP API, ES modules |
| Database | PostgreSQL 16 in the example Compose deployment |
| DB driver | Async `pg` and `pg.Pool` |
| Python judge | `python:3.13-alpine` |
| C++ judge | `acm-cpp-runner:17`; standards 17 and 20 |
| Reverse proxy | Caddy in the sample deployment |
| Notifications | In-app notifications and optional Bale integration |

### Important repository paths

```text
src/
  main.jsx                 Main React UI and pages
  style.css                Base layout and styles
  theme.css                Existing theme rules
  glass.css                Existing Glass UI layer
  MonacoEditor.jsx         Monaco integration
  number-format.js         Persian number/date formatting
  testcase-utils.js        Test-case helpers
  polling.js               Polling scheduler

server/
  index.js                 Startup and shutdown
  app.js                   API routes and access logic
  db.js                    Database boundary and password helpers
  postgres-database.js     pg.Pool, migrations, and transactions
  postgres-schema.sql      Initial PostgreSQL schema
  judge.js                 Docker-based Python/C++ judging
  bale-bot.js              Bale bot and notification processing
  backup.js                Backup and restore helpers
  code-similarity.js       Code similarity fingerprints
  env.js                   `.env` loader
  sqlite-test-database.js  SQLite adapter for isolated tests only

deploy/
  setup-ubuntu-vps.sh      Ubuntu 24.04 sample installer
  *.service, *.timer       systemd services/timer
  Caddyfile                Reverse proxy
  .env.production.example Production environment template

scripts/
  dev.js                   Run API and Vite for development
  setup-admin.js           Bootstrap the first administrator
  check-db.js              Check connection and initialize schema
  run-postgres-api-tests.js Run API tests against real PostgreSQL
  create-backup.js         Create a backup
  restore-backup.js        Restore a backup
  copy-monaco.js           Copy Monaco assets
```

`server/app.js` and `src/main.jsx` are large centralized files. Prefer narrow, testable changes; broad rewrites without a product need increase regression risk.

## 6. Database and migrations

**PostgreSQL is the only operational database.** Do not add a SQLite fallback to Production. `server/sqlite-test-database.js` exists only for a subset of isolated legacy tests.

- Main schema: `server/postgres-schema.sql`.
- During `openDatabase()`, the application connects, checks `acm_schema_migrations`, and transactionally applies the base schema and pending migrations.
- Runtime uses `pg.Pool`; `psql.exe` is not needed for normal application queries.
- Bind query parameters; never interpolate user values into SQL strings.
- The compatibility layer converts legacy `?` placeholders to native PostgreSQL parameters such as `$1`. Write new SQL with PostgreSQL behavior in mind.
- Optional `NULL` parameters need an explicit type; for example, `CAST(? AS TEXT) IS NULL` (choose the appropriate type for the actual column/value).
- Do not use SQLite-only `PRAGMA`, `INSERT OR IGNORE`, or `COLLATE NOCASE` in operational paths.
- An outer transaction acquires one Pool client; `AsyncLocalStorage` pins callback queries to it. Nested transactions use `SAVEPOINT`.
- Bounded retries exist for SQLSTATE `40001` and `40P01`. A transaction callback may run more than once; do not put message delivery or external side effects inside it.

### Main tables

`users`, `login_sessions`, `teacher_classes`, `class_memberships`, `class_sessions`, `class_schedule_events`, `problems`, `test_cases`, `question_bank`, `question_bank_tests`, `assignments`, `assignment_participants`, `assignment_problems`, `assignment_submissions`, `contests`, `contest_participants`, `contest_problems`, `contest_submissions`, `submissions`, `code_drafts`, `notifications`, `bale_links`, `bale_link_codes`, `bale_notification_outbox`, `bale_state`, `bale_processed_updates`, `audit_log`, and `admin_security_events`.

## 7. Environment configuration (`.env`)

Use `.env.example` for development and `deploy/.env.production.example` as the production template. Replace all placeholders. The real `.env` is secret and must never be committed or shipped in a ZIP.

| Variable | Purpose |
|---|---|
| `APP_ORIGIN` | Canonical app origin and request allowlist; must match the public URL |
| `HOST` | Listen address; defaults to `127.0.0.1` |
| `PORT` | HTTP port; development sample 3000, production sample 3002 |
| `DATABASE_DRIVER` | Must be `postgres` |
| `POSTGRES_DB` | Database name; usually `acm_classroom` |
| `POSTGRES_USER` | PostgreSQL role; usually `acm_classroom` |
| `POSTGRES_PASSWORD` | Strong password for the PostgreSQL role |
| `DATABASE_URL` | Main DB connection; database name must match `POSTGRES_DB` |
| `TEST_DATABASE_URL` | Separate test connection; database name must include `test` |
| `PG_POOL_MAX` | Maximum Pool clients; default 10, range 2–50 |
| `PG_IDLE_TIMEOUT_MS` | Idle-client timeout; default 30000 |
| `PG_CONNECTION_TIMEOUT_MS` | Pool connection timeout; default 8000 |
| `PG_DUMP_BIN`, `PG_RESTORE_BIN` | PostgreSQL backup-tool paths |
| `BACKUP_DIR` | Backup directory |
| `BACKUP_RETENTION_DAYS` | Retention period; default 30 days |
| `SESSION_HOURS` | Login-session lifetime; default 12 hours |
| `DOCKER_IMAGE` | Python image; default `python:3.13-alpine` |
| `DOCKER_CPP_IMAGE` | C++ image; default `acm-cpp-runner:17` |
| `MAX_CONCURRENT_JUDGES` | Concurrent judges in this Node instance |
| `BALE_BOT_TOKEN` | Optional secret token for the Bale bot |

Generate a strong password on Linux:

```bash
openssl rand -hex 32
```

Use the same value in `POSTGRES_PASSWORD` and the password part of `DATABASE_URL`. Reserved URI characters must be URL-encoded; a hex password avoids this issue.

**Vite warning:** Do not use `NODE_ENV` in `.env` to control frontend build mode. Vite selects production mode during `npm run build` and may warn when `NODE_ENV=production` is present in `.env`. The sample systemd service sets production `NODE_ENV` at service level.

## 8. Windows 11 development setup

Prerequisites: Node.js `>=22.13.0` (24 recommended), npm, Docker Desktop using Linux containers, and an available PostgreSQL service. Docker Desktop must be running for judging.

```powershell
Copy-Item .env.example .env
# Edit .env; configure the password, APP_ORIGIN, PORT, and DATABASE_URL

docker compose up -d postgres
npm ci
npm run db:check
npm run docker:build-cpp
docker pull python:3.13-alpine
npm run setup:admin
```

`npm run setup:admin` creates the first administrator only if there is no active admin. If one exists, it refuses to create a duplicate and does not reset the existing password.

Run Vite and the API for development:

```powershell
npm run dev
```

`scripts/dev.js` serves Vite at `http://127.0.0.1:5173`; the API listens on the configured `HOST:PORT`.

Build and run the service-style server:

```powershell
npm test
npm run build
npm start
```

`npm start` runs the Node server and serves the built frontend from `dist`. PostgreSQL and an active administrator must exist first.

## 9. Important commands

| Command | Purpose |
|---|---|
| `npm ci` | Reproducibly install dependencies from the lockfile |
| `npm run dev` | Run API and Vite for development |
| `npm run build` | Copy Monaco assets and run the Vite production build |
| `npm start` | Start the application server |
| `npm test` | Run the Node test suite |
| `npm run test:postgres` | API tests against real PostgreSQL and a separate test database |
| `npm run db:check` | Connect to PostgreSQL and initialize/check schema |
| `npm run setup:admin` | Create the first administrator |
| `npm run backup:db` | Create and validate a PostgreSQL backup |
| `npm run restore:db -- --backup <file.dump> --yes` | Restore after stopping the service |
| `npm run docker:build-cpp` | Build the C++ judge image |
| `npm run copy:monaco` | Copy Monaco assets |

## 10. First administrator and account recovery

- Public registration is disabled.
- `npm run setup:admin` creates the first active administrator only on an empty application database.
- “An active administrator already exists” refers to an `admin` row in the application's `users` table, not merely a PostgreSQL login role.
- Password hashing uses `crypto.scryptSync`, a random salt, and timing-safe verification in `server/db.js`.
- Any official admin recovery tool must import and use `hashPassword()` and `verifyPassword()` from `server/db.js`. Never add a separate password algorithm or a plain SHA-256 password hash.
- The bootstrap script is not an admin password-reset tool; normal account management is performed from the admin panel.

## 11. Tests and quality checks

### General suite

```powershell
npm test
```

Tests cover APIs, database behavior, judging, similarity, themes, CSS, layout, PWA, fonts, polling, number formatting, and security cases. Some tests requiring real PostgreSQL may be skipped in the general run.

### API tests against real PostgreSQL

Create a separate database such as `acm_classroom_test` and configure `TEST_DATABASE_URL` in `.env`. Never point it at the production database.

```powershell
docker compose exec -T postgres createdb -U acm_classroom acm_classroom_test
npm run test:postgres
```

The runner verifies that the database name includes `test`, creates temporary schemas for fixtures, and removes them after the run. If interrupted, a schema prefixed `acm_test_` may remain. Inspect/remove only that temporary schema after confirming no test is running; do not delete the whole database or volume.

### Build

```powershell
npm run build
```

The build runs `copy:monaco` first and writes frontend output to `dist`. For UI/CSS changes, also run focused tests such as `ui-layout.test.js`, `css-integrity.test.js`, or `theme.test.js`.

## 12. Judging security

Student code is untrusted and must run only inside Docker. Never execute user code on the host using `eval`, `exec`, or a shell. Do not add an external judge such as Judge0 without an explicit product decision.

Python runs with networking disabled (`--network=none`), a read-only filesystem, memory/CPU/PID limits, a non-root user, dropped capabilities, and `no-new-privileges`. C++ uses a separate runner image with resource limits.

- Docker daemon access is required by the application process.
- Linux `docker` group membership is effectively root-equivalent; use a dedicated VPS.
- Tune `MAX_CONCURRENT_JUDGES` for host capacity.
- Keep input, output, execution time, and judge response size bounded.
- Do not change the seven-day source-retention policy without privacy review.

## 13. Backups, restore, and database reset

### Regular backup

```powershell
npm run backup:db
```

Backups use PostgreSQL custom format and are validated with `pg_restore --list`. The sample Ubuntu deployment schedules a daily backup at 03:15 and retains 30 days by default. Keep an encrypted copy outside the VPS.

### Restore

Stop the application and workers, verify the filename, then run:

```powershell
npm run restore:db -- --backup acm-classroom-YYYYMMDDTHHMMSSZ-xxxxxxxx.dump --yes
```

The script creates a safety snapshot before restore and attempts to roll it back if restore fails. Restore replaces the current database contents.

### Full reset of the primary database

This **permanently deletes all accounts, classes, problems, tests, assignments, contests, submissions, points, notifications, and audit history in the primary database**. Back up first, verify the database name, and stop the application service.

```powershell
pg_dump -h 127.0.0.1 -p 5432 -U acm_classroom -d acm_classroom -Fc -f ".\acm-classroom-before-reset.dump"
psql -h 127.0.0.1 -p 5432 -U acm_classroom -d postgres -W
```

Inside `psql`, only after confirming the current database is the administrative `postgres` database, run:

```sql
DROP DATABASE IF EXISTS acm_classroom WITH (FORCE);
CREATE DATABASE acm_classroom OWNER acm_classroom;
\q
```

Then:

```powershell
npm run db:check
npm run setup:admin
```

`db:check` opens the database and applies the base schema and migrations automatically; `setup:admin` then creates the first administrator. These commands do not delete the separate `acm_classroom_test` database or PostgreSQL volume. Do not use `docker compose down -v` to reset only the primary database; it removes the volume. The PostgreSQL role needs `CREATEDB` and `DROP DATABASE` privileges; otherwise use a PostgreSQL administrator role.

## 14. Ubuntu 24.04 deployment

`deploy/setup-ubuntu-vps.sh` targets Ubuntu 24.04 and prepares Node.js 24, Docker Engine/Compose, Caddy, PostgreSQL client tools, the `acmclassroom` service user, systemd, PostgreSQL 16 in Compose, tests, frontend build, judge images, first-admin setup, and the backup timer.

The sample guide recommends at least 2 CPU cores, 4 GB RAM, and 50 GB SSD; heavier concurrent judging needs more resources. The sample installer hard-codes `acm-classroom.ir`; changing the domain requires coordinated deployment configuration updates.

After extracting the project to `/opt/acm-classroom`:

```bash
sudo bash /opt/acm-classroom/deploy/setup-ubuntu-vps.sh
```

Service checks:

```bash
systemctl status acm-classroom --no-pager
systemctl status acm-classroom-backup.timer --no-pager
systemctl status caddy --no-pager
cd /opt/acm-classroom && docker compose ps
cd /opt/acm-classroom && npm run db:check
curl -fsS http://127.0.0.1:3002/api/health
journalctl -u acm-classroom -n 100 --no-pager
```

**Never expose port 5432 to the public internet.** Docker group access is highly privileged; run this application on a dedicated VPS.

## 15. PWA and caching

The project includes a web manifest and service worker. The service worker caches only the public application shell. Private API responses, student source code, and class data must never be stored in the public cache. The PWA can be installed from supported browsers after HTTPS is enabled.

## 16. Admin system health panel and current UI state

The admin panel reports Node process details, memory, disk, PostgreSQL connections, judge capacity, Bale outbox, account/contest counts, and backup files.

The current reference includes a narrowly scoped admin health-panel correction:

- The “Resources & capacity” and “Judging queue & notifications” cards sit side by side on wide screens and stack at widths of 900 px or less.
- Capacity values use the Persian equivalent of “N of M” to avoid ambiguous RTL number ordering.
- Windows shows “Not available” instead of a misleading zero load average.
- A zero waiting-queue capacity is correctly presented as a disabled queue.

This is not permission to rewrite the global theme or unrelated CSS. The visual baseline remains the original `style.css`, `theme.css`, and `glass.css`; the previously rejected experimental Glass Design System branch is not part of this reference.

## 17. Rules for future changes

1. Locate the relevant endpoint, component, schema, and test before editing. Avoid speculative changes and broad rewrites.
2. Preserve existing behavior and Admin/Teacher/Student permission boundaries.
3. Write SQL for PostgreSQL, bind parameters, and explicitly type nullable values.
4. Enforce permissions in the backend; hiding a button is not security.
5. Keep user-facing dates Jalali and reuse the shared date picker.
6. Docker-only judging; never execute user code on the host.
7. Protect scoring, attempt limits, AI flags, penalties, question snapshots, and source retention with regression tests.
8. UI changes must run relevant layout/CSS/theme tests and must not unintentionally change unrelated pages.
9. Never include a real `.env`, secrets, backups, or production data in a public ZIP/commit.
10. After changes, run `npm test`, focused tests, `npm run test:postgres` with a separate test database, and `npm run build` where possible. Report actual results.
11. Never claim a test/build succeeded if it was not run; state environment limitations.
12. These two README files are the sole documentation reference; update both when decisions or architecture change.

## 18. Release and delivery contract

- Reference code release: `2.13.0`.
- Operational database: PostgreSQL-only.
- Recent UI change: a narrow admin health-panel fix; no new Glass/Dark design-system branch is included.
- Allowed docs: `README.fa.md` and `README.en.md`; do not add another Markdown file unless explicitly requested by the project owner.
- A distributable ZIP must not contain the real `.env`, database data, Docker volumes, `node_modules`, or secret credentials/tokens.
