import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('./src/main.jsx', import.meta.url), 'utf8');
const glass = await readFile(new URL('./src/glass.css', import.meta.url), 'utf8');
const theme = await readFile(new URL('./src/theme.css', import.meta.url), 'utf8');
const style = await readFile(new URL('./src/style.css', import.meta.url), 'utf8');

test('sidebar active item no longer renders a decorative dot', () => {
  assert.match(main, /function NavButton[\s\S]*aria-current=\{active \? 'page' : undefined\}/);
  assert.doesNotMatch(main, /nav-active-dot/);
});

test('four selectable themes are persisted and applied by mode and palette to the full document', () => {
  assert.match(main, /acm-classroom-theme/);
  assert.match(main, /supportedThemes = \['light-blue', 'dark-blue', 'light-red', 'dark-red'\]/);
  assert.match(main, /saved === 'dark'.*dark-blue/s);
  assert.match(main, /saved === 'light'.*light-blue/s);
  assert.match(main, /root\.dataset\.theme = themeMode/);
  assert.match(main, /root\.dataset\.themeMode = themeMode/);
  assert.match(main, /root\.dataset\.themePalette = themePalette/);
  assert.match(main, /document\.body\.dataset\.themePalette = themePalette/);
  assert.match(main, /data-theme-palette=\{themePalette\}/);
  assert.match(main, /THEME_OPTIONS = \[([\s\S]*?)light-red([\s\S]*?)dark-red/);
  assert.match(main, /function ThemeToggle[\s\S]*?role=\"listbox\"/);
  assert.match(glass, /:root\[data-theme=\"light\"\]/);
  assert.match(glass, /:root\[data-theme=\"dark\"\]/);
});

test('dark theme uses a native Telegram-like glass palette, not a difference-blend negative', () => {
  assert.doesNotMatch(main, /createElement\('div'\)[\s\S]{0,180}theme-negative-overlay/);
  assert.doesNotMatch(glass, /body\[data-theme-mode="dark"\] #theme-negative-overlay/);
  assert.doesNotMatch(glass, /mix-blend-mode:\s*difference/);
  assert.match(glass, /--glass-bg:\s*#0e1621/);
  assert.match(glass, /--glass-panel:\s*rgba\(31,45,59,\.78\)/);
  assert.match(glass, /--blue:\s*#65a9e0/);
  assert.match(glass, /linear-gradient\(135deg, #0e1621 0%, #101b28/);
});

test('light glass palette is cool blue and removes the previous warm ivory cast', () => {
  assert.match(glass, /--glass-bg:\s*#eaf3fc/);
  assert.match(glass, /--glass-panel:\s*rgba\(249,252,255,\.74\)/);
  assert.match(glass, /--blue:\s*#4b8ed8/);
  assert.match(glass, /linear-gradient\(135deg, #edf6ff 0%, #e8f1fb/);
  assert.doesNotMatch(glass.slice(glass.indexOf('ACM Classroom 2.6.6')), /#f3f0e8|#fffdf7|rgba\(206,198,169/);
});

test('dark glass styling covers app shell, portals, calendars, notifications and auth', () => {
  for (const selector of [
    '.glass-interface[data-theme="dark"] .sidebar',
    '.glass-interface[data-theme="dark"] .topbar',
    '.glass-interface[data-theme="dark"] :is(.panel,.metric-card',
    'html[data-theme="dark"] :is(.app-select-menu,.jalali-date-popover,.notification-popover',
    '.glass-ui-page[data-theme="dark"] .auth-page',
    '.glass-ui-page[data-theme="dark"] .auth-page .login-card',
  ]) assert.ok(glass.includes(selector), `Missing dark theme selector: ${selector}`);
});

test('formerly white data, editor and report surfaces receive Telegram dark glass colors', () => {
  for (const selector of [
    '.data-table thead th', '.data-table td', '.metric-copy strong', '.notice-bar:not(.notice-warning)',
    '.empty-state', '.sample-block pre', '.student-code', '.judge-result', '.report-kpis>div',
    '.scale-kpis>div', '.monaco-student-editor', '.problem-preview-code', '.calendar-day',
    '.search-field', '.editor-toolbar', '.testcase-head', '.testcase-json-heading',
    '.similarity-pair>strong', '.contest-participant-manage button', '.report-score',
  ]) assert.ok(glass.includes(selector), `Missing themed surface: ${selector}`);
  assert.match(style, /\.student-code/);
  assert.match(theme, /\.calendar-day/);
});

test('Monaco editor switches to its native dark theme together with application theme', () => {
  assert.match(main, /theme=\{theme.startsWith\('dark'\) \? 'vs-dark' : 'light'\}/);
});

test('semantic success, warning and danger colors remain meaningful in dark mode', () => {
  assert.match(glass, /\.status-badge\.danger[\s\S]*?color: #ffb7bf/);
  assert.match(glass, /\.status-badge\.warning[\s\S]*?color: #f1d29a/);
  assert.match(glass, /\.status-badge\.success[\s\S]*?color: #a9ebc9/);
});

test('login theme toggle remains inside the viewport on compact layouts', () => {
  assert.match(glass, /\.glass-ui-page \.auth-brand \{[^}]*width:\s*100%/);
  assert.match(glass, /\.glass-ui-page \.auth-brand-identity \{[^}]*min-width:\s*0/);
  assert.match(glass, /@media \(max-width:900px\)[\s\S]*?\.auth-brand \.theme-toggle-label \{ display:none; \}/);
  assert.match(glass, /\.glass-ui-page \.auth-brand \.theme-toggle \{ flex:0 0 auto/);
});

test('remaining legacy panels, avatars and informational notices use the cool glass palette', () => {
  for (const selector of [
    '.problem-preview-workbench', '.assignment-picker', '.assignment-option-list',
    '.contest-management-panel', '.contest-problem-picker', '.report-class-option',
    '.assignment-detail-problem', '.similarity-pair', '.session-bank-question',
    '.table-scroll', '.attempt-history-row', '.notice-purple', '.calendar-day.is-today',
  ]) assert.ok(glass.includes(selector), `Missing final theme coverage for ${selector}`);
  assert.match(glass, /\.glass-interface\[data-theme="light"\][\s\S]*?\.avatar/);
  assert.match(glass, /\.glass-interface\[data-theme="dark"\][\s\S]*?\.avatar/);
});

test('legacy crimson decorative accents are replaced by Telegram blue-grey in dark mode', () => {
  assert.match(glass, /:root\[data-theme="dark"\][\s\S]*?--accent:\s*#65a9e0/);
  assert.match(glass, /\.attempt-history-actions \.btn\.btn-secondary,[\s\S]*?background:\s*linear-gradient\(135deg,rgba\(54,88,115/);
  assert.match(glass, /\.attempt-source-button \{[\s\S]*?background:\s*linear-gradient\(135deg,rgba\(54,88,115/);
  assert.match(glass, /\.testcase-index \{[\s\S]*?background:\s*rgba\(55,96,128/);
  assert.match(glass, /\.calendar-day\.has-events \{[\s\S]*?background:\s*rgba\(55,96,128/);
  assert.match(glass, /\.event-date-tile \{[\s\S]*?background:\s*rgba\(51,88,116/);
  assert.match(glass, /\.toast-warning \{[\s\S]*?background:\s*linear-gradient\(135deg,rgba\(111,81,39/);
  assert.match(glass, /\.upload-code-btn:hover \{[\s\S]*?background:\s*rgba\(61,103,136/);
  assert.match(glass, /\.jalali-date-popover-foot button \{[\s\S]*?background:\s*rgba\(53,91,120/);
  assert.match(glass, /\.btn-danger-ghost/);
  assert.match(glass, /\.status-badge\.danger/);
});


test('2.6.8 dark theme fixes screenshot-reported JSON editor, hidden toggle and calendar surfaces', () => {
  for (const selector of [
    '.testcase-json-editor', '.testcase-json-heading', '.testcase-json-textarea', '.testcase-json-hint',
    '.testcase-hidden-toggle input:checked + .testcase-toggle-ui',
    '.persian-calendar-panel .calendar-day', '.persian-calendar-panel .calendar-day.has-events',
    '.persian-calendar-panel .calendar-day.is-today', '.persian-calendar-panel .today-legend-dot',
  ]) assert.ok(glass.includes(selector), `Missing 2.6.8 theme selector: ${selector}`);
  assert.match(glass, /testcase-hidden-toggle input:checked \+ \.testcase-toggle-ui\s*\{[^}]*background:\s*#438fc5/);
  assert.match(glass, /persian-calendar-panel \.calendar-day\.is-today\s*\{[^}]*background:\s*rgba\(68, 126, 166, \.78\)/);
});

test('2.6.8 dark theme restores legibility in class sessions, empty states and nested report table cells', () => {
  for (const selector of [
    '.empty-state p', '.panel-heading p', '.class-member-identity span', '.class-event-main p',
    '.class-session-row .session-export', '.class-session-row .session-delete',
    '.data-table tbody td :is(b, strong)', '.data-table tbody td :is(small, code, .muted-text)',
    '.data-table tbody td .submission-context b',
  ]) assert.ok(glass.includes(selector), `Missing 2.6.8 contrast selector: ${selector}`);
  assert.match(glass, /class-session-row \.session-export\s*\{[^}]*background:\s*rgba\(48, 94, 127, \.42\)/);
  assert.match(glass, /data-table tbody td \.submission-context b\s*\{[^}]*color:\s*#dce9f2/);
});

test('2.6.9 class-session section uses an integrated Telegram-glass heading and separate session rows', () => {
  assert.match(main, /className="panel settings-panel class-sessions-panel"/);
  assert.match(main, /className="panel-heading class-sessions-heading"/);
  assert.match(glass, /\.class-sessions-panel > \.class-sessions-heading\s*\{[^}]*background:\s*transparent !important/s);
  assert.match(glass, /\.class-sessions-panel \.class-session-row\s*\{[^}]*border-radius:\s*14px/s);
});

test('2.6.9 ordinary question-bank tools are blue-grey and destructive red is hover-only', () => {
  assert.match(glass, /\.problem-manage-actions \.table-action\s*\{[^}]*background:\s*rgba\(57, 83, 103, \.42\) !important/s);
  assert.match(glass, /\.problem-manage-actions \.table-action\.action-danger:hover\s*\{[^}]*background:\s*rgba\(132, 53, 66, \.42\) !important/s);
  assert.match(glass, /\.problem-manage-main > p\s*\{[^}]*color:\s*#adbfcd !important/s);
});

test('2.6.9 dark text selection uses Telegram blue instead of legacy crimson', () => {
  const css = glass.slice(glass.indexOf('ACM Classroom 2.6.9'));
  assert.match(css, /::selection[\s\S]*?background:\s*rgba\(82, 153, 205, \.48\) !important/);
  assert.doesNotMatch(css, /::selection[\s\S]*?background:\s*rgba\(210, 48, 79/);
});


test('2.7.0 includes balanced red themes: porcelain white in light mode and navy-white in dark mode', () => {
  for (const themeId of ['light-blue', 'dark-blue', 'light-red', 'dark-red']) assert.ok(main.includes(`'${themeId}'`) || main.includes(`id: '${themeId}'`), `Missing theme ${themeId}`);
  assert.match(glass, /data-theme-palette="red"/);
  assert.match(glass, /--glass-bg:\s*#f8f3f5/);
  assert.match(glass, /--glass-panel:\s*rgba\(34,48,68,\.84\)/);
  assert.match(glass, /linear-gradient\(135deg,#101a2a 0%,#17243a 54%,#202b40 100%\)/);
  assert.doesNotMatch(glass.slice(glass.indexOf('ACM Classroom 2.7.2')), /background:\s*#(?:c00|f00|ff0000)\b/i);
});

test('2.7.0 class settings and calendar forms use integrated glass headers and themed fields', () => {
  for (const selector of [
    '.settings-panel > .panel-heading', '.settings-panel .stack-form',
    '.settings-panel .settings-icon', '.settings-panel textarea.input',
    'settings-panel .field > label',
  ]) assert.ok(glass.includes(selector), `Missing form surface selector: ${selector}`);
  assert.match(main, /اطلاعات کلاس/);
  assert.match(main, /افزودن برنامه به تقویم/);
});

test('2.7.2 blood-red accent is deep red while the dark-red canvas remains navy', () => {
  assert.match(glass, /--accent:\s*#c52a45/);
  assert.match(glass, /linear-gradient\(135deg,#a91532,#760b22\)/);
  assert.match(glass, /linear-gradient\(135deg,#101a2a 0%,#17243a 58%,#202d43 100%\)/);
  assert.match(glass, /swatch-dark-red \{ background: linear-gradient\(145deg,#172338 0 48%,#8f1028 49% 100%\)/);
});

test('2.7.3 theme menu is portaled, viewport-positioned, and exactly 200px wide', () => {
  assert.match(main, /createPortal\(<div ref=\{menuRef\} className="theme-picker-menu" style=\{menuStyle/);
  assert.match(main, /getBoundingClientRect\(\)/);
  assert.match(main, /calculateThemeMenuPosition\(rect, viewport, measuredHeight\)/);
  assert.match(main, /import \{ calculateThemeMenuPosition \} from '\.\/theme-menu-position\.js'/);
  assert.match(main, /calculateThemeMenuPosition\(rect, viewport, measuredHeight\)/);
  assert.match(main, /menuRef\.current\?\.contains\(event\.target\)/);
  assert.match(glass, /\.theme-picker-menu\s*\{[^}]*position:\s*fixed !important/s);
  assert.match(glass, /overflow-y:\s*auto/);
  assert.match(glass, /width:\s*200px/);
  assert.match(glass, /min\(200px, calc\(100vw - 24px\)\)/);
});

test('2.7.2 mobile theme control shows a centered sun or moon without the cramped chevron', () => {
  assert.match(glass, /\.theme-picker-compact \.theme-toggle-chevron \{ display: none !important; \}/);
  assert.match(glass, /@media \(max-width: 760px\)[\s\S]*?\.theme-toggle-label, \.theme-toggle-chevron \{ display: none !important; \}/);
  assert.match(glass, /grid-template|display: grid; place-items: center/);
  assert.match(main, /selected\.mode === 'dark' \? <Moon size=\{19\}/);
});

test('2.7.2 class ranking scores and row hover use cool blue-grey surfaces', () => {
  assert.match(glass, /\.class-ranking-table \.student-class-points\s*\{[^}]*background:\s*rgba\(67,103,128,\.24\) !important/s);
  assert.match(glass, /\.class-ranking-table \.data-table tbody tr:hover td\s*\{[^}]*background:\s*rgba\(89,139,171,\.12\) !important/s);
  assert.match(glass, /\.class-ranking-table \.online-pill\.is-offline\s*\{[^}]*background:\s*rgba\(76,98,116,\.25\) !important/s);
});


test('2.7.5 portal-mounted confirmation dialog uses navy glass in every dark theme', () => {
  const marker = 'ACM Classroom 2.7.5 — portal-mounted danger confirmations';
  const rules = glass.slice(glass.lastIndexOf(marker));
  assert.ok(rules.length > 0, 'final portal confirmation theme rules exist');
  assert.match(rules, /html\[data-theme="dark"\] \.confirm-dialog/);
  assert.match(rules, /body\[data-theme="dark"\] \.confirm-dialog/);
  assert.match(rules, /background:\s*linear-gradient\(145deg, rgba\(35, 53, 72, \.97\), rgba\(24, 40, 58, \.97\)\) !important/);
  assert.match(main, /request\.tone === 'danger' \? 'btn-danger'/);
  assert.doesNotMatch(rules, /\.confirm-dialog \.btn-danger/);
  assert.match(rules, /confirm-dialog-icon[\s\S]*?color:\s*#f0cf91/);
  assert.doesNotMatch(rules, /background:\s*rgba\(34, 12, 20/);
});

test('2.7.4 theme picker uses the requested four short labels and no descriptions', () => {
  const options = main.match(/const THEME_OPTIONS = \[([\s\S]*?)\n\];/);
  assert.ok(options, 'THEME_OPTIONS declaration exists');
  const block = options[1];
  const labels = [...block.matchAll(/label: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['آبی روشن', 'آبی تیره', 'قرمز روشن', 'قرمز تیره']);
  assert.doesNotMatch(block, /description:/);
  assert.doesNotMatch(main, /option\.description/);
  assert.match(main, /<span className="theme-option-copy"><b>\{option\.label\}<\/b><\/span>/);
});

test('2.7.4 red themes render the dashboard welcome banner with blood-red accents', () => {
  assert.match(glass, /\.glass-interface\[data-theme="light"\]\[data-theme-palette="red"\] \.welcome-banner/);
  assert.match(glass, /\.glass-interface\[data-theme="dark"\]\[data-theme-palette="red"\] \.welcome-banner/);
  assert.match(glass, /#8f1028/);
});

test('2.7.4 Telegram dark-blue brand mark stays blue instead of inheriting legacy pink', () => {
  assert.match(glass, /\.glass-interface\[data-theme="dark"\]\[data-theme-palette="blue"\] \.brand-mark/);
  assert.match(glass, /\.glass-ui-page\[data-theme="dark"\]\[data-theme-palette="blue"\] \.auth-page \.brand-mark/);
});


test('2.7.6 dark problem statement and sample I/O blocks use navy glass instead of white surfaces', () => {
  const rules = glass.slice(glass.lastIndexOf('ACM Classroom 2.7.6'));
  for (const selector of ['.statement-block', '.statement-block h3', '.statement-block p', '.sample-block', '.sample-block b', '.sample-block pre']) {
    assert.ok(rules.includes(selector), `Missing dark solver statement selector: ${selector}`);
  }
  assert.match(rules, /\.statement-block\s*\{[^}]*background:[^}]*rgba\(41,63,82/);
  assert.match(rules, /\.sample-block pre\s*\{[^}]*background:\s*rgba\(13,25,37,\.96\)/);
});

test('2.7.6 dark Monaco chrome and editor metadata are readable while Monaco keeps its native dark canvas', () => {
  const rules = glass.slice(glass.lastIndexOf('ACM Classroom 2.7.6'));
  for (const selector of ['.code-editor-header', '.code-editor-title b', '.editor-toolbar', '.editor-tab', '.editor-lang', '.editor-footer', '.submit-note']) {
    assert.ok(rules.includes(selector), `Missing dark editor selector: ${selector}`);
  }
  assert.match(rules, /\.monaco-student-editor\s*\{[^}]*background:\s*#1e1e1e/);
  assert.match(rules, /\.code-editor-title b\s*\{[^}]*color:\s*#edf4f9/);
  assert.match(rules, /\.editor-footer\s*\{[^}]*background:\s*rgba\(12,24,36,\.92\)/);
});

test('2.7.6 dark attempt history uses neutral blue-grey surfaces and preserves semantic verdict colors', () => {
  const rules = glass.slice(glass.lastIndexOf('ACM Classroom 2.7.6'));
  for (const selector of ['.attempt-history-panel', '.attempt-history-heading', '.attempt-history-row', '.attempt-history-main small', '.attempt-index', '.attempt-history-tests.all-passed', '.attempt-history-tests:not(.all-passed)']) {
    assert.ok(rules.includes(selector), `Missing dark attempt-history selector: ${selector}`);
  }
  assert.match(rules, /\.attempt-history-main small\s*\{[^}]*color:\s*#a9bdcc/);
  assert.match(rules, /\.attempt-history-tests\.all-passed\s*\{[^}]*color:\s*#a9ebc9/);
});

test('2.7.7 final dark problem statement and sample panels explicitly override white legacy surfaces', () => {
  const rules = glass.slice(glass.lastIndexOf('ACM Classroom 2.7.7'));
  for (const selector of [
    '.app-shell.glass-interface[data-theme="dark"] .statement-block',
    '.app-shell.glass-interface[data-theme="dark"] .statement-block h3',
    '.app-shell.glass-interface[data-theme="dark"] .sample-block',
    '.app-shell.glass-interface[data-theme="dark"] .sample-block b',
    '.app-shell.glass-interface[data-theme="dark"] .sample-block pre',
  ]) assert.ok(rules.includes(selector), `Missing final dark problem/sample selector: ${selector}`);
  assert.match(rules, /\.statement-block\s*\{[^}]*background:\s*linear-gradient\(145deg, rgba\(43, 65, 84, \.92\)/s);
  assert.match(rules, /\.sample-block pre\s*\{[^}]*background:\s*rgba\(10, 22, 33, \.98\) !important/s);
  assert.match(rules, /\.sample-block b\s*\{[^}]*background:\s*rgba\(48, 74, 96, \.76\) !important/s);
});

test('2.7.7 final dark Monaco toolbar, selector, status and submission footer have readable contrast', () => {
  const rules = glass.slice(glass.lastIndexOf('ACM Classroom 2.7.7'));
  for (const selector of [
    '.code-editor-header', '.code-editor-title b', '.code-editor-header .field > label',
    '.editor-setting-select .app-select-trigger', '.upload-code-btn', '.editor-toolbar',
    '.editor-tab', '.editor-lang', '.editor-footer', '.submit-code-row', '.submit-note',
  ]) assert.ok(rules.includes(selector), `Missing final editor selector: ${selector}`);
  assert.match(rules, /\.editor-setting-select \.app-select-trigger\s*\{[^}]*background:\s*rgba\(15, 29, 42, \.9\) !important/s);
  assert.match(rules, /\.editor-toolbar\s*\{[^}]*background:\s*rgba\(41, 64, 83, \.92\) !important/s);
  assert.match(rules, /\.editor-footer\s*\{[^}]*background:\s*rgba\(12, 24, 36, \.98\) !important/s);
  assert.match(rules, /\.monaco-student-editor\s*\{[^}]*background:\s*#1e1e1e !important/s);
});

test('2.7.7 final dark attempt history uses slate metadata and neutral counters without recoloring verdicts', () => {
  const rules = glass.slice(glass.lastIndexOf('ACM Classroom 2.7.7'));
  for (const selector of [
    '.attempt-history-panel', '.attempt-history-heading', '.attempt-history-list',
    '.attempt-history-row', '.attempt-history-main small', '.attempt-index',
    '.attempt-history-tests:not(.all-passed)', '.attempt-history-tests.all-passed',
  ]) assert.ok(rules.includes(selector), `Missing final attempt history selector: ${selector}`);
  assert.match(rules, /\.attempt-history-main small\s*\{[^}]*color:\s*#b7c9d6 !important/s);
  assert.match(rules, /\.attempt-history-tests:not\(\.all-passed\)\s*\{[^}]*background:\s*rgba\(54, 83, 104, \.46\) !important/s);
  assert.match(rules, /\.attempt-history-tests\.all-passed\s*\{[^}]*color:\s*#a9ebc9 !important/s);
  assert.doesNotMatch(rules, /\.attempt-history-row\s*\{[^}]*\.status-badge/);
});


test('2.7.8 attempt history groups identity and results for compact responsive cards', () => {
  const start = main.indexOf('className="panel attempt-history-panel"');
  const end = main.indexOf('</section>', start);
  const markup = main.slice(start, end);
  assert.ok(markup.includes('className="attempt-history-heading-copy"'));
  assert.ok(markup.includes('className="attempt-history-leading"'));
  assert.ok(markup.includes('className="attempt-history-result"'));
  assert.match(markup, /attempt-history-leading[\s\S]*?attempt-compare-toggle[\s\S]*?attempt-index[\s\S]*?attempt-history-main/);
  assert.match(markup, /attempt-history-result[\s\S]*?StatusBadge[\s\S]*?attempt-history-tests[\s\S]*?<strong>[\s\S]*?attempt-source-button/);
  const rules = glass.slice(glass.lastIndexOf('ACM Classroom 2.7.8'));
  for (const selector of [
    '.attempt-history-heading-copy', '.attempt-history-leading', '.attempt-history-result',
    '.attempt-history-row.is-compare-selected', '.attempt-history-result > strong',
  ]) assert.ok(rules.includes(selector), `Missing structured attempt history selector: ${selector}`);
  assert.match(rules, /@media \(max-width: 760px\)[\s\S]*?\.attempt-history-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(rules, /@media \(max-width: 420px\)[\s\S]*?\.attempt-history-result \.attempt-source-button\s*\{[^}]*flex:\s*1 1 100%/);
});


test('2.7.9 attempt-history structure is shared by light and dark themes, preventing narrow vertical wrapping', () => {
  const marker = 'ACM Classroom 2.7.9 — shared attempt-history layout';
  const rules = glass.slice(glass.lastIndexOf(marker));
  assert.ok(rules.length > 0, 'shared attempt-history layout rules exist');
  for (const selector of [
    '.app-shell.glass-interface .attempt-history-heading',
    '.app-shell.glass-interface .attempt-history-row',
    '.app-shell.glass-interface .attempt-history-leading',
    '.app-shell.glass-interface .attempt-history-main small',
    '.app-shell.glass-interface .attempt-history-result',
  ]) assert.ok(rules.includes(selector), `Missing shared selector: ${selector}`);
  assert.match(rules, /\.app-shell\.glass-interface \.attempt-history-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(rules, /@media \(max-width: 760px\)[\s\S]*?\.app-shell\.glass-interface \.attempt-history-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(rules, /@media \(max-width: 420px\)[\s\S]*?\.app-shell\.glass-interface \.attempt-history-result\s*\{[^}]*padding-inline-start:\s*0/);
  assert.doesNotMatch(rules, /\.app-shell\.glass-interface\[data-theme=/);
  assert.doesNotMatch(rules, /\.status-badge\s*\{[^}]*background:/);
});


test('2.8.6 dark theme fixes judge statistics and all public testcase output surfaces', () => {
  for (const selector of [
    '.judge-result', '.judge-accepted', '.judge-rejected', '.judge-result-head', '.judge-stats',
    '.judge-stats span', '.judge-stats b', '.test-result-item.passed', '.test-result-item.failed',
    '.public-test-output-card', '.public-test-output-grid h4', '.public-test-output-grid pre', '.public-test-output-meta',
  ]) assert.ok(glass.includes(selector), `Missing 2.8.6 dark theme selector: ${selector}`);
  assert.match(glass, /judge-stats b\s*\{[^}]*color:\s*#edf5fa !important/s);
  assert.match(glass, /public-test-output-grid pre\s*\{[^}]*background:\s*rgba\(8, 19, 29, \.94\) !important/s);
});

test('2.8.6 attempt-history geometry overrides legacy dark grid sizing in desktop and mobile breakpoints', () => {
  assert.match(glass, /\.app-shell\.glass-interface\[data-theme\] \.attempt-history-row\s*\{[^}]*grid-template-columns:\s*minmax\(220px, 1fr\) minmax\(0, 1\.5fr\) !important/s);
  assert.match(glass, /@media \(max-width: 760px\)[\s\S]*?\.app-shell\.glass-interface\[data-theme\] \.attempt-history-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) !important/s);
  assert.match(main, /attempt\.aiFlagged \? <StatusBadge value=\"warning\">باطل‌شده با تصمیم معلم<\/StatusBadge>/);
});

test('2.8.6 AI moderation provides teacher controls, student explanation, and auditable visual state', () => {
  assert.match(main, /\/teacher\/submissions\/\$\{row\.id\}\/ai-review/);
  assert.match(main, /تشخیص استفاده از هوش مصنوعی در یکی از ارسال‌ها/);
  assert.match(main, /فرصت حل دوبارهٔ سؤال طبق محدودیت تعیین‌شده فعال است/);
  assert.match(main, /attempt\.aiFlagged && <span className="attempt-ai-flagged-chip">/);
  for (const selector of ['.ai-review-action', '.ai-review-state.is-flagged', '.notice-ai-review', '.attempt-ai-flagged-chip']) assert.ok(glass.includes(selector));
});
