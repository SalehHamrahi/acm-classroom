import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const jsx = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('./src/theme.css', import.meta.url), 'utf8');
const baseCss = await readFile(new URL('./src/style.css', import.meta.url), 'utf8');

test('attempt count badge stays on one line and does not shrink', () => {
  assert.match(jsx, /className="number-pill attempt-count-pill"/);
  assert.match(css, /\.attempt-history-actions \.attempt-count-pill\s*\{[^}]*display:\s*inline-flex;[^}]*white-space:\s*nowrap;/s);
  assert.match(css, /\.attempt-history-actions\s*\{[^}]*flex:\s*0 0 auto;/s);
});

test('contest leaderboard heading has internal spacing and a fixed icon box', () => {
  assert.match(jsx, /className="panel-heading contest-leaderboard-heading"/);
  assert.match(css, /\.contest-leaderboard > \.contest-leaderboard-heading\s*\{[^}]*padding:\s*15px 20px;/s);
  assert.match(css, /\.contest-leaderboard-heading > \.settings-icon\s*\{[^}]*flex:\s*0 0 42px;[^}]*width:\s*42px;[^}]*height:\s*42px;/s);
});

test('narrow layouts stack attempt history actions without clipping', () => {
  assert.match(css, /@media \(max-width:\s*760px\)\s*\{[^}]*\.attempt-history-heading\s*\{[^}]*flex-direction:\s*column;/s);
});

test('select menus and Shamsi calendars render in a body portal with viewport-aware fixed positioning', () => {
  assert.match(jsx, /import \{ createPortal \} from 'react-dom'/);
  assert.match(jsx, /function floatingLayerStyle\(/);
  assert.match(jsx, /createPortal\(<div ref=\{menuRef\} className="app-select-menu"/);
  assert.match(jsx, /createPortal\(<div ref=\{popoverRef\} className="jalali-date-popover"/);
  assert.match(css, /\.app-select-menu\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*10000;/s);
  assert.match(baseCss, /\.jalali-date-popover\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*10000;/s);
});

test('session editor can import shared-bank questions and preserve their source identity', () => {
  assert.match(jsx, /افزودن از بانک سؤال/);
  assert.match(jsx, /\/teacher\/question-bank\/\$\{question\.id\}\/copy-to-session/);
  assert.match(jsx, /alreadyAdded=data\.problems\.some\(\(problem\)=>problem\.sourceBankId===question\.id\)/);
  assert.match(jsx, /p\.sourceBankId && <span className="small-chip"/);
});

test('requested sidebar privacy card is removed and home sample code and footer credit are updated', () => {
  assert.doesNotMatch(jsx, /className="sidebar-security"/);
  assert.match(jsx, /<i>main<\/i>\(\):/);
  assert.match(jsx, /print\(<em>"Hello World!"<\/em>\)/);
  assert.match(jsx, /با کمک هوش مصنوعی ساخته شده/);
  assert.doesNotMatch(jsx, /با کمک ChatGPT ساخته شده/);
});


test('release 2.7.2 retains blue glass and adds two red themes', async () => {
  const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');
  assert.match(main, /function ThemeToggle/);
  assert.match(main, /acm-classroom-theme/);
  assert.match(main, /theme=\{theme.startsWith\('dark'\) \? 'vs-dark' : 'light'\}/);
  assert.doesNotMatch(main, /theme-gotham/);
  assert.doesNotMatch(css, /theme-gotham-page|theme-gotham-auth/);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(main, /light-blue.*dark-blue.*light-red.*dark-red/s);
  assert.match(css, /data-theme-palette=\"red\"/);
});

test('attempt history exposes owned source inline with an explicit expiry state', async () => {
  const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
  const server = await readFile(new URL('./server/app.js', import.meta.url), 'utf8');
  assert.match(main, /attempt-source-button/);
  assert.match(main, /\/student\/submissions\/\$\{attempt\.id\}\/source/);
  assert.match(server, /sourceAvailable: Boolean\(attempt\.sourceCode && !attempt\.sourceDeletedAt/);
  assert.match(server, /app\.get\('\/api\/student\/submissions\/:id\/source'/);
});

test('glass refinement styles code viewer, colored toasts, notifications and mobile layout', async () => {
  const css = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');
  assert.match(css, /\.glass-interface \.source-code-view[\s\S]*backdrop-filter/);
  assert.match(css, /\.toast-success[\s\S]*background:linear-gradient/);
  assert.match(css, /\.toast-warning[\s\S]*rgba\(255,231,234/);
  assert.match(css, /\.glass-ui-page \.notification-popover[\s\S]*backdrop-filter/);
  assert.match(css, /overflow-x:clip/);
  assert.match(css, /max-height:calc\(100dvh - 82px/);
});

test('Jalali date picker is compact and attempt comparison remains visible', async () => {
  const css = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');
  assert.match(css, /\.jalali-date-day \{ height:28px/);
  assert.match(css, /\.attempt-history-actions \.btn\.btn-secondary/);
  assert.match(css, /\.attempt-source-button/);
});

test('mobile notifications are rendered in a body portal and positioned from the trigger', async () => {
  const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
  const start = main.indexOf('function NotificationBell(');
  const end = main.indexOf('\n\nfunction StudentReportCard', start);
  const notification = main.slice(start, end);
  assert.match(notification, /createPortal\([\s\S]*document\.body/);
  assert.match(notification, /floatingLayerStyle\(triggerRef\.current,popoverRef\.current/);
  assert.match(notification, /window\.innerWidth<=760/);
  assert.match(notification, /position:'fixed'/);
});

test('global Vazirmatn rule does not override Monaco editor font metrics', async () => {
  const css = await readFile(new URL('./src/theme.css', import.meta.url), 'utf8');
  assert.match(css, /body \*:not\(\.monaco-editor\):not\(\.monaco-editor \*\)/);
  assert.match(css, /body \.source-code-view[\s\S]*font-family: Consolas/);
});

test('floating date/select layers center when neither side of the trigger has enough room', async () => {
  const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /Math\.max\(below, above\) < popupHeight/);
  assert.match(main, /\(viewportHeight - maxHeight\) \/ 2/);
});

test('release 2.7.2 uses a fixed body-portal theme menu positioned from the trigger', async () => {
  const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
  const glass = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');
  assert.match(main, /createPortal\(<div ref=\{menuRef\} className="theme-picker-menu"/);
  assert.match(main, /getBoundingClientRect\(\)/);
  assert.match(main, /calculateThemeMenuPosition\(rect, viewport, measuredHeight\)/);
  assert.match(glass, /\.theme-picker-menu\s*\{[^}]*position:\s*fixed !important/s);
  assert.match(glass, /@media \(max-width: 760px\)[\s\S]*?\.theme-toggle-label, \.theme-toggle-chevron \{ display: none !important; \}/);
});

test('problem samples visibly identify trailing LF and CRLF terminators', () => {
  assert.match(jsx, /function trailingNewlineLabel/);
  assert.match(jsx, /const literal = kind === 'CRLF'/);
  assert.ok(jsx.includes('<NewlineIndicator value={sample.input}'));
  assert.ok(jsx.includes('<NewlineIndicator value={sample.output}'));
  assert.match(jsx, /خط جدید/);
});

test('students can open a public-test output detail view from submission history', () => {
  assert.match(jsx, /function PublicTestOutputsModal/);
  assert.match(jsx, /خروجی واقعی برنامه/);
  assert.match(jsx, /خروجی مورد انتظار/);
  assert.ok(jsx.includes('/student/submissions/${row.id}/results'));
  assert.ok(jsx.includes("showTestOutputs={mode==='student'}"));
});


test('contest penalty form explains that only genuine wrong attempts are charged', () => {
  assert.match(jsx, /جریمهٔ هر ارسال اشتباه \(دقیقه\)/);
  assert.match(jsx, /فقط به‌ازای هر ارسال اشتباه معتبر محاسبه می‌شود؛ زمان حل سؤال و ارسال‌های باطل‌شده با تشخیص AI جریمه ندارند/);
});
test('admin system health panels are responsive and render RTL capacity values unambiguously', async () => {
  const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('./src/style.css', import.meta.url), 'utf8');
  assert.ok(main.includes('{faNumber(judge.active || 0)} از {faNumber(judge.concurrency || 0)}'));
  assert.ok(main.includes('{faNumber(judge.queued || 0)} از {faNumber(judge.maxQueue || 0)}'));
  assert.ok(main.includes('${faNumber(system?.database?.connections || 0)} از ${faNumber(system?.database?.maxConnections || 0)}'));
  assert.ok(main.includes("platform === 'win32' ? 'در دسترس نیست'"));
  assert.ok(css.includes('.system-health-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr));'));
  assert.ok(css.includes('@media(max-width:900px){.system-health-grid{grid-template-columns:minmax(0,1fr)}}'));
});
