import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  Activity, AlertCircle, ArrowDownLeft, ArrowLeft, ArrowUpRight, BookOpen, Check,
  CheckCircle2, ChevronDown, ChevronLeft, CircleHelp, ClipboardCheck, Clock3, Code2,
  FileCode2, FlaskConical, GraduationCap, LayoutDashboard, LockKeyhole, LogOut,
  Menu, Plus, RefreshCw, Search, ShieldCheck, Terminal, Users, UserRound, X, Download,
  Play, Eye, EyeOff, CalendarDays, ListChecks, Settings2, KeyRound, Power, History,
  School, Trophy, Upload, ExternalLink, CircleDot, Copy, FileText, Gauge, Zap, Trash2, Lock,
  Bell, BellRing, Medal, Swords, GitCompareArrows, Save, Cloud, Timer, BarChart3, Flag, AlertTriangle, Library, Info, Sun, Moon, Share2, MoreVertical, Smartphone, MonitorDown, MessageCircle, Unlink, Database, HardDrive, Layers,
} from 'lucide-react';
import './style.css';
import './theme.css';
import './glass.css';
import { normalizeTestCases } from './testcase-utils.js';
import { toLatinDigits, formatNumber, formatPersianDateTime } from './number-format.js';
import { calculateThemeMenuPosition } from './theme-menu-position.js';
import { scheduleVisibleInterval } from './polling.js';

const MonacoEditor = React.lazy(() => import('./MonacoEditor.jsx'));

const API = '/api';
const inFlightGetRequests = new Map();
async function performApiRequest(path, options = {}) {
  const headers = { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(`${API}${path}`, {
    method: options.method || 'GET',
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    cache: options.cache || 'no-store',
  });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error || `خطای درخواست (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  // Share concurrent, identical read requests (especially when polling and a
  // user-triggered refresh happen together). Never cache responses past flight.
  if (method !== 'GET' || options.signal) return performApiRequest(path, options);
  const key = `${method}:${path}`;
  const existing = inFlightGetRequests.get(key);
  if (existing) return existing;
  const request = performApiRequest(path, options);
  inFlightGetRequests.set(key, request);
  try { return await request; }
  finally { if (inFlightGetRequests.get(key) === request) inFlightGetRequests.delete(key); }
}
function downloadJsonFile(document, filename) {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeFileName(value = 'session') {
  const normalized = String(value).trim().replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  return normalized || 'session';
}
const roleLabels = { admin: 'مدیر سامانه', teacher: 'معلم', student: 'دانش‌آموز' };
const roleIcons = { admin: ShieldCheck, teacher: GraduationCap, student: UserRound };
const verdicts = {
  accepted: { title: 'پذیرفته‌شده', cls: 'success' },
  wrong_answer: { title: 'پاسخ نادرست', cls: 'danger' },
  runtime_error: { title: 'خطای زمان اجرا', cls: 'warning' },
  time_limit: { title: 'محدودیت زمان', cls: 'warning' },
  judge_error: { title: 'خطای داوری', cls: 'danger' },
  compile_error: { title: 'خطای کامپایل C++', cls: 'danger' },
  output_limit: { title: 'خروجی بیش از حد', cls: 'warning' },
};
function formatDate(value) { return formatPersianDateTime(value); }
function trailingNewlineLabel(value) {
  const text = typeof value === 'string' ? value : '';
  const match = text.match(/(?:\r\n|\n|\r)+$/);
  if (!match) return null;
  const suffix = match[0];
  const count = (suffix.match(/\r\n|\n|\r/g) || []).length;
  const kind = suffix.includes('\r\n') ? 'CRLF' : suffix.includes('\r') ? 'CR' : 'LF';
  const literal = kind === 'CRLF' ? '\\r\\n' : kind === 'CR' ? '\\r' : '\\n';
  return { kind, literal, count };
}
function NewlineIndicator({ value }) {
  const info = trailingNewlineLabel(value);
  if (!info) return null;
  return <small className="newline-indicator" dir="ltr" aria-label={`پایان متن دارای ${info.count} خط جدید ${info.kind}`}><span>↵ پایان متن</span><code>{info.literal}</code><span>{info.count} خط جدید</span></small>;
}
function cx(...values) { return values.filter(Boolean).join(' '); }
function contestStatusAt(contest, now = Date.now()) {
  const start = Date.parse(contest.startAt); const end = Date.parse(contest.endAt);
  return now < start ? 'scheduled' : now < end ? 'active' : 'ended';
}
function contestCountdownLabel(contest, now = Date.now()) {
  const status = contestStatusAt(contest, now);
  if (status === 'ended') return 'مسابقه پایان یافته است';
  const target = status === 'scheduled' ? Date.parse(contest.startAt) : Date.parse(contest.endAt);
  const seconds = Math.max(0, Math.floor((target - now) / 1000));
  const pad = (value) => faNumber(String(value).padStart(2, '0'));
  const clock = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds % 3600 / 60))}:${pad(seconds % 60)}`;
  return status === 'scheduled' ? `شروع تا ${clock}` : `پایان مسابقه تا ${clock}`;
}

function floatingLayerStyle(anchor, popup, fallbackHeight, preferredWidth = null) {
  if (!anchor || typeof window === 'undefined') return null;
  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(preferredWidth || rect.width, window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
  const popupHeight = popup?.scrollHeight || fallbackHeight;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const below = Math.max(0, viewportHeight - rect.bottom - margin - 7);
  const above = Math.max(0, rect.top - margin - 7);
  if (Math.max(below, above) < popupHeight) {
    const maxHeight = Math.min(popupHeight, viewportHeight - margin * 2);
    const top = Math.max(margin, (viewportHeight - maxHeight) / 2);
    return { position: 'fixed', top, left, right: 'auto', width, maxHeight, zIndex: 10000 };
  }
  const placeBelow = popupHeight <= below || below >= above;
  const available = placeBelow ? below : above;
  const maxHeight = Math.max(88, Math.min(popupHeight, available || fallbackHeight, viewportHeight - margin * 2));
  let top = placeBelow ? rect.bottom + 7 : rect.top - maxHeight - 7;
  top = Math.max(margin, Math.min(top, viewportHeight - maxHeight - margin));
  return { position: 'fixed', top, left, right: 'auto', width, maxHeight, zIndex: 10000 };
}

function AppSelect({ className = '', value, onChange, children, disabled = false, required = false, ...props }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);
  const options = React.Children.toArray(children).filter((item) => React.isValidElement(item) && item.type === 'option');
  const selected = options.find((item) => String(item.props.value ?? item.props.children) === String(value)) || options[0];
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => { if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false); };
    const closeEscape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) { setMenuStyle(null); return undefined; }
    const update = () => setMenuStyle(floatingLayerStyle(triggerRef.current, menuRef.current, Math.min(300, Math.max(120, options.length * 42 + 12))));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver !== 'undefined' && rootRef.current ? new ResizeObserver(update) : null;
    if (observer && rootRef.current) observer.observe(rootRef.current);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); observer?.disconnect(); };
  }, [open, options.length]);
  const choose = (option) => {
    if (option.props.disabled) return;
    const nextValue = String(option.props.value ?? option.props.children ?? '');
    onChange?.({ target: { value: nextValue } });
    setOpen(false);
  };
  return <div ref={rootRef} className={cx('app-select', className, open && 'is-open', disabled && 'is-disabled')}>
    <button ref={triggerRef} type="button" className="app-select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-required={required || undefined} disabled={disabled} onClick={() => setOpen((current) => !current)} {...(props['aria-label'] ? { 'aria-label': props['aria-label'] } : {})}>
      <span>{selected?.props.children ?? 'انتخاب…'}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && typeof document !== 'undefined' && createPortal(<div ref={menuRef} className="app-select-menu" role="listbox" style={menuStyle || { position: 'fixed', visibility: 'hidden', zIndex: 10000 }}>{options.map((option, index) => {
      const optionValue = String(option.props.value ?? option.props.children ?? '');
      const isSelected = optionValue === String(value);
      return <button type="button" role="option" aria-selected={isSelected} disabled={option.props.disabled} className={cx('app-select-option', isSelected && 'selected')} key={`${optionValue}-${index}`} onClick={() => choose(option)}>{option.props.children}</button>;
    })}</div>, document.body)}
  </div>;
}

const ConfirmContext = React.createContext(null);
function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const resolver = useRef(null);
  const confirm = useCallback((options = {}) => new Promise((resolve) => {
    if (resolver.current) resolver.current(false);
    resolver.current = resolve;
    setRequest({
      title: options.title || 'تأیید عملیات',
      message: options.message || 'آیا از انجام این عملیات مطمئن هستی؟',
      confirmText: options.confirmText || 'بله، ادامه بده',
      cancelText: options.cancelText || 'انصراف',
      tone: options.tone || 'danger',
      details: options.details || '',
    });
  }), []);
  const finish = useCallback((accepted) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(accepted);
  }, []);
  useEffect(() => {
    if (!request) return undefined;
    const handleKey = (event) => { if (event.key === 'Escape') finish(false); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [request, finish]);
  return <ConfirmContext.Provider value={confirm}>
    {children}
    {request && <div className="modal-backdrop confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(false); }}>
      <section className={cx('confirm-dialog', `confirm-${request.tone}`)} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <div className="confirm-dialog-icon"><AlertTriangle size={23} /></div>
        <div className="confirm-dialog-copy"><h2 id="confirm-title">{request.title}</h2><p id="confirm-message">{request.message}</p>{request.details && <small>{request.details}</small>}</div>
        <div className="confirm-dialog-actions"><button type="button" className="btn btn-ghost" onClick={() => finish(false)}>{request.cancelText}</button><button type="button" className={cx('btn', request.tone === 'danger' ? 'btn-danger' : 'btn-primary')} onClick={() => finish(true)}>{request.confirmText}</button></div>
      </section>
    </div>}
  </ConfirmContext.Provider>;
}
function useConfirm() {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within ConfirmProvider');
  return confirm;
}

class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('ACM Classroom page render failed:', error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <section className="page-error-boundary panel" role="alert">
      <div className="page-error-icon"><AlertCircle size={22} /></div>
      <h2>نمایش این صفحه با مشکل مواجه شد</h2>
      <p>اطلاعات این صفحه بارگذاری شد، اما بخشی از رابط نتوانست نمایش داده شود. می‌توانی دوباره تلاش کنی یا به پیشخوان برگردی.</p>
      <div className="page-error-actions">
        <button type="button" className="btn btn-secondary" onClick={() => this.setState({ error: null })}>تلاش دوباره</button>
        <button type="button" className="btn btn-primary" onClick={this.props.onBack}>بازگشت به پیشخوان</button>
      </div>
    </section>;
  }
}

function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('dashboard');
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [selectedProblemId, setSelectedProblemId] = useState(null);
  const [selectedContestId, setSelectedContestId] = useState(null);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedClassId, setSelectedClassId] = useState(null);
  const [theme, setTheme] = useState(() => {
    const supportedThemes = ['light-blue', 'dark-blue', 'light-red', 'dark-red'];
    try {
      const saved = window.localStorage.getItem('acm-classroom-theme');
      if (supportedThemes.includes(saved)) return saved;
      if (saved === 'dark') return 'dark-blue';
      if (saved === 'light') return 'light-blue';
    } catch { /* use the default theme when storage is unavailable */ }
    return 'light-blue';
  });
  const themeMode = theme.startsWith('dark') ? 'dark' : 'light';
  const themePalette = theme.endsWith('red') ? 'red' : 'blue';

  const notify = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random();
    setNotice({ message, type, id });
    window.setTimeout(() => setNotice((current) => current?.id === id ? null : current), 3500);
  }, []);

  useEffect(() => {
    let mounted = true;
    api('/auth/me').then((result) => { if (mounted) setUser(result.user); })
      .catch(() => { if (mounted) setUser(null); })
      .finally(() => { if (mounted) setBooting(false); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return undefined;
    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // The app remains fully usable in browsers/environments without PWA support.
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => { cancelled = true; window.removeEventListener('load', register); };
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add('glass-ui-page');
    document.body.classList.add('glass-ui-page');
    // Apply a real theme palette to the whole document, including portal-mounted UI.
    root.dataset.theme = themeMode;
    document.body.dataset.theme = themeMode;
    root.dataset.themeMode = themeMode;
    document.body.dataset.themeMode = themeMode;
    root.dataset.themePalette = themePalette;
    document.body.dataset.themePalette = themePalette;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = themeMode === 'dark'
      ? (themePalette === 'red' ? '#142033' : '#0e1621')
      : (themePalette === 'red' ? '#fff7f8' : '#eaf3fc');
    try { window.localStorage.setItem('acm-classroom-theme', theme); } catch { /* theme still works for this session */ }
  }, [theme, themeMode, themePalette]);
  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    const heartbeat = () => {
      if (active && document.visibilityState === 'visible') api('/presence/heartbeat', { method: 'POST', body: {} }).catch(() => {});
    };
    heartbeat();
    const stopHeartbeat = scheduleVisibleInterval(heartbeat, 20000);
    return () => { active = false; stopHeartbeat(); };
  }, [user?.id]);

  const signIn = async (credentials) => {
    const result = await api('/auth/login', { method: 'POST', body: credentials });
    setUser(result.user); setView('dashboard'); setSelectedSessionId(null); setSelectedProblemId(null); setSelectedContestId(null); setSelectedAssignmentId(null);
  };
  const signOut = async () => {
    try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* local sign-out always wins */ }
    setUser(null); setView('dashboard'); setSelectedSessionId(null); setSelectedProblemId(null); setSelectedContestId(null); setSelectedAssignmentId(null);
  };
  const navigate = (next) => { setView(next); setSelectedSessionId(null); setSelectedProblemId(null); setSelectedContestId(null); setSelectedAssignmentId(null); setSelectedClassId(null); setSidebarOpen(false); };
  const bumpRefresh = () => setRefreshKey((value) => value + 1);

  if (booting) return null; // Avoid a separate branded startup/splash page; render the app as soon as session restoration completes.
  if (!user) return <LoginScreen onLogin={signIn} theme={theme} onChangeTheme={setTheme} />;
  if (user.mustChangePassword) return <ForcePasswordChange user={user} onDone={(u) => { setUser(u); notify('گذرواژه با موفقیت تغییر کرد.'); }} theme={theme} onChangeTheme={setTheme} />;

  const renderCurrent = () => {
    if (view === 'dashboard') return <Dashboard user={user} refreshKey={refreshKey} onNavigate={navigate} onSelectSession={(id) => { setSelectedSessionId(id); setView(user.role === 'student' ? 'student-session' : 'teacher-session'); }} />;
    if (view === 'contests' && user.role === 'student' && selectedContestId && selectedProblemId) return <StudentProblem problemId={selectedProblemId} contestId={selectedContestId} refreshKey={refreshKey} notify={notify} theme={theme} onBack={() => setSelectedProblemId(null)} />;
    if (view === 'assignments' && user.role === 'student' && selectedAssignmentId && selectedProblemId) return <StudentProblem problemId={selectedProblemId} assignmentId={selectedAssignmentId} refreshKey={refreshKey} notify={notify} theme={theme} onBack={() => setSelectedProblemId(null)} />;
    if (view === 'assignments' && user.role === 'student' && selectedAssignmentId) return <StudentAssignmentDetail assignmentId={selectedAssignmentId} refreshKey={refreshKey} onBack={() => setSelectedAssignmentId(null)} onOpenProblem={(id) => setSelectedProblemId(id)} />;
    if (view === 'assignments' && user.role === 'student') return <StudentAssignments refreshKey={refreshKey} onSelect={setSelectedAssignmentId} />;
    if (view === 'assignments' && user.role === 'teacher') return <TeacherAssignments refreshKey={refreshKey} notify={notify} />;
    if (view === 'reports' && user.role === 'teacher') return <TeacherReports refreshKey={refreshKey} notify={notify} />;
    if (view === 'contests' && user.role === 'student' && selectedContestId) return <StudentContestDetail contestId={selectedContestId} refreshKey={refreshKey} onBack={() => setSelectedContestId(null)} onOpenProblem={(id) => setSelectedProblemId(id)} />;
    if (view === 'contests' && user.role === 'student') return <StudentContests refreshKey={refreshKey} onSelect={(id) => setSelectedContestId(id)} />;
    if (view === 'users' && user.role === 'admin') return <AdminUsers notify={notify} refreshKey={refreshKey} />;
    if (view === 'leaderboard' && user.role === 'admin') return <AdminLeaderboard refreshKey={refreshKey} />;
    if (view === 'sessions' && user.role === 'admin') return <AdminSessions refreshKey={refreshKey} />;
    if (view === 'submissions') return user.role === 'admin' ? <SubmissionsList mode="admin" refreshKey={refreshKey} notify={notify} /> : user.role === 'teacher' ? <SubmissionsList mode="teacher" refreshKey={refreshKey} notify={notify} /> : <SubmissionsList mode="student" refreshKey={refreshKey} notify={notify} />;
    if (view === 'audit' && user.role === 'admin') return <AuditLog refreshKey={refreshKey} />;
    if (view === 'data-management' && user.role === 'admin') return <AdminDataManagement refreshKey={refreshKey} notify={notify} />;
    if (view === 'presence' && user.role === 'admin') return <AdminPresence refreshKey={refreshKey} />;
    if (view === 'system-health' && user.role === 'admin') return <AdminSystemPage refreshKey={refreshKey} notify={notify} />;
    if (view === 'my-classes' && user.role === 'teacher') return <TeacherClasses refreshKey={refreshKey} notify={notify} onSelect={(id) => { setSelectedClassId(id); setView('teacher-class'); }} />;
    if (view === 'question-bank' && user.role === 'teacher') return <TeacherQuestionBank user={user} refreshKey={refreshKey} notify={notify} />;
    if (view === 'contests' && user.role === 'teacher') return <TeacherContests refreshKey={refreshKey} notify={notify} />;
    if (view === 'teacher-class' && user.role === 'teacher' && selectedClassId) return <TeacherClassDetail classId={selectedClassId} refreshKey={refreshKey} notify={notify} onBack={() => navigate('my-classes')} onSelectSession={(id) => { setSelectedSessionId(id); setView('teacher-session'); }} />;
    if (view === 'my-class' && user.role === 'student') return <StudentClassCalendar refreshKey={refreshKey} onSelectSession={(id) => { setSelectedSessionId(id); setView('student-session'); }} />;
    if (view === 'my-sessions' && user.role === 'teacher') return <TeacherClasses refreshKey={refreshKey} notify={notify} onSelect={(id) => { setSelectedClassId(id); setView('teacher-class'); }} />;
    if (view === 'active-sessions' && user.role === 'student') return <StudentClassCalendar refreshKey={refreshKey} onSelectSession={(id) => { setSelectedSessionId(id); setView('student-session'); }} />;
    if (view === 'teacher-session' && user.role === 'teacher' && selectedSessionId) return <TeacherSession sessionId={selectedSessionId} refreshKey={refreshKey} notify={notify} onBack={() => setView('teacher-class')} />;
    if (view === 'student-session' && user.role === 'student' && selectedSessionId && !selectedProblemId) return <StudentSession sessionId={selectedSessionId} refreshKey={refreshKey} onOpenProblem={(id) => setSelectedProblemId(id)} onBack={() => setView('my-class')} />;
    if (view === 'student-session' && user.role === 'student' && selectedProblemId) return <StudentProblem problemId={selectedProblemId} refreshKey={refreshKey} notify={notify} theme={theme} onBack={() => setSelectedProblemId(null)} />;
    if (view === 'profile') return <Profile user={user} onUpdate={setUser} notify={notify} />;
    return <Dashboard user={user} refreshKey={refreshKey} onNavigate={navigate} onSelectSession={(id) => { setSelectedSessionId(id); setView(user.role === 'student' ? 'student-session' : 'teacher-session'); }} />;
  };

  return <div className="app-shell glass-interface" data-theme={themeMode} data-theme-mode={themeMode} data-theme-palette={themePalette} dir="rtl">
    {sidebarOpen && <button className="mobile-scrim" aria-label="بستن منو" onClick={() => setSidebarOpen(false)} />}
    <aside className={cx('sidebar', sidebarOpen && 'sidebar-open')}>
      <div className="brand-row">
        <div className="brand-mark"><img src="/icons/icon-192.png" alt="" /></div>
        <div><strong>ACM Classroom</strong><span>سامانهٔ آموزش برنامه‌نویسی</span></div>
        <button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="بستن منو"><X size={18} /></button>
      </div>
      <div className="side-workspace"><div className="workspace-icon"><School size={18} /></div><div><strong>محیط آموزشی</strong><span>پایگاه تمرین و داوری</span></div><ChevronDown size={15} /></div>
      <div className="nav-caption">منوی اصلی</div>
      <nav className="side-nav">
        <NavButton active={view === 'dashboard'} onClick={() => navigate('dashboard')} icon={LayoutDashboard} label="پیشخوان" />
        {user.role === 'admin' && <>
          <NavButton active={view === 'users'} onClick={() => navigate('users')} icon={Users} label="مدیریت کاربران" />
          <NavButton active={view === 'leaderboard'} onClick={() => navigate('leaderboard')} icon={Medal} label="رتبه‌بندی دانش‌آموزان" />
          <NavButton active={view === 'sessions'} onClick={() => navigate('sessions')} icon={BookOpen} label="همهٔ جلسات" />
          <NavButton active={view === 'submissions'} onClick={() => navigate('submissions')} icon={ClipboardCheck} label="ارسال‌های کد" />
          <NavButton active={view === 'audit'} onClick={() => navigate('audit')} icon={History} label="گزارش فعالیت‌ها" />
          <NavButton active={view === 'data-management'} onClick={() => navigate('data-management')} icon={Trash2} label="مدیریت و حذف سوابق" />
          <NavButton active={view === 'presence'} onClick={() => navigate('presence')} icon={Activity} label="وضعیت حضور" />
          <NavButton active={view === 'system-health'} onClick={() => navigate('system-health')} icon={Gauge} label="سلامت سامانه و پشتیبان‌گیری" />
        </>}
        {user.role === 'teacher' && <>
          <NavButton active={view === 'my-classes' || view === 'teacher-class'} onClick={() => navigate('my-classes')} icon={School} label="کلاس‌های من" />
          <NavButton active={view === 'question-bank'} onClick={() => navigate('question-bank')} icon={Library} label="بانک سؤالات" />
          <NavButton active={view === 'contests'} onClick={() => navigate('contests')} icon={Swords} label="مسابقات" />
          <NavButton active={view === 'assignments'} onClick={() => navigate('assignments')} icon={ClipboardCheck} label="تکالیف و تمرین‌ها" />
          <NavButton active={view === 'reports'} onClick={() => navigate('reports')} icon={BarChart3} label="گزارش‌های تحلیلی" />
          
          <NavButton active={view === 'submissions'} onClick={() => navigate('submissions')} icon={ClipboardCheck} label="پاسخ دانش‌آموزان" />
        </>}
        {user.role === 'student' && <>
          <NavButton active={view === 'my-class'} onClick={() => navigate('my-class')} icon={CalendarDays} label="کلاس من و تقویم" />
          <NavButton active={view === 'contests'} onClick={() => navigate('contests')} icon={Swords} label="مسابقات" />
          <NavButton active={view === 'assignments'} onClick={() => navigate('assignments')} icon={ClipboardCheck} label="تکالیف من" />
          
          <NavButton active={view === 'submissions'} onClick={() => navigate('submissions')} icon={ClipboardCheck} label="ارسال‌های من" />
        </>}
        <PwaInstallButton menu />
      </nav>
      <div className="nav-caption nav-caption-bottom">حساب کاربری</div>
      <NavButton active={view === 'profile'} onClick={() => navigate('profile')} icon={Settings2} label="تنظیمات حساب" />
      <div className="sidebar-spacer" />
      <div className="sidebar-user"><div className="avatar">{initials(user.displayName)}</div><div className="sidebar-user-info"><b>{user.displayName}</b><span>{roleLabels[user.role]}</span></div><button title="خروج امن" aria-label="خروج امن" className="icon-button signout-small" onClick={signOut}><LogOut size={17} /></button></div>
    </aside>
    <div className="main-column">
      <header className="topbar">
        <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="بازکردن منو"><Menu size={20} /></button>
        <div className="breadcrumbs"><span>ACM Classroom</span><ChevronLeft size={15} /><strong>{currentTitle(view, user.role)}</strong></div>
        <div className="topbar-actions"><ThemeToggle theme={theme} onChange={setTheme} /><NotificationBell onNavigate={navigate} /><span className="live-indicator"><i /> سرویس فعال</span><div className="topbar-divider" /><div className="topbar-account"><div className="avatar avatar-sm">{initials(user.displayName)}</div><span>{user.displayName}</span></div><button className="icon-button" title="تازه‌سازی داده‌ها" onClick={bumpRefresh}><RefreshCw size={17} /></button></div>
      </header>
      <main className="page-content" key={`${view}-${selectedSessionId || ''}-${selectedProblemId || ''}-${selectedClassId || ''}-${selectedContestId || ''}`}><PageErrorBoundary key={`${view}-${selectedProblemId || ''}-${selectedAssignmentId || ''}-${selectedContestId || ''}`} onBack={() => navigate('dashboard')}>{renderCurrent()}</PageErrorBoundary></main>
      <footer className="page-footer"><span>ACM Classroom</span><span>سامانهٔ خصوصی آموزش و داوری برنامه‌نویسی</span><span className="footer-credit" title="ساخته‌شده با کمک هوش مصنوعی">با کمک هوش مصنوعی ساخته شده</span><span>نسخهٔ 2.13.0</span></footer>
    </div>
    {notice && <div className={cx('toast', `toast-${notice.type}`)}><span className="toast-icon">{notice.type === 'error' ? <AlertCircle size={19} /> : notice.type === 'warning' ? <AlertTriangle size={19} /> : notice.type === 'info' ? <Info size={19} /> : <CheckCircle2 size={19} />}</span><span>{notice.message}</span><button onClick={() => setNotice(null)} aria-label="بستن"><X size={16} /></button></div>}
  </div>;
}

function currentTitle(view, role) {
  const common = { dashboard: 'پیشخوان', submissions: role === 'student' ? 'ارسال‌های من' : 'ارسال‌های کد', profile: 'تنظیمات حساب' };
  const special = { users: 'مدیریت کاربران', leaderboard: 'رتبه‌بندی دانش‌آموزان', sessions: 'همهٔ جلسات', audit: 'گزارش فعالیت‌ها', presence: 'وضعیت حضور', 'data-management': 'مدیریت و حذف سوابق', 'system-health': 'سلامت سامانه و پشتیبان‌گیری', 'my-classes': 'کلاس‌های من', 'teacher-class': 'مدیریت کلاس', 'question-bank': 'بانک سؤالات', 'my-class': 'کلاس من و تقویم', 'active-sessions': 'کلاس من و تقویم', 'my-sessions': 'کلاس‌های من', 'teacher-session': 'مدیریت جلسه', 'student-session': 'تمرین‌های جلسه', contests: 'مسابقات برنامه‌نویسی', assignments: role==='teacher'?'تکالیف و تمرین‌ها':'تکالیف من', reports: 'گزارش‌های تحلیلی' };
  return common[view] || special[view] || 'پیشخوان';
}
function initials(name = '') { return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('') || 'ک'; }
function NavButton({ icon: Icon, label, active, onClick }) {
  return <button className={cx('nav-button', active && 'active')} aria-current={active ? 'page' : undefined} onClick={onClick}><Icon size={18} strokeWidth={1.9} /><span>{label}</span></button>;
}
const THEME_OPTIONS = [
  { id: 'light-blue', mode: 'light', palette: 'blue', label: 'آبی روشن' },
  { id: 'dark-blue', mode: 'dark', palette: 'blue', label: 'آبی تیره' },
  { id: 'light-red', mode: 'light', palette: 'red', label: 'قرمز روشن' },
  { id: 'dark-red', mode: 'dark', palette: 'red', label: 'قرمز تیره' },
];
function ThemeToggle({ theme, onChange, compact = false }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const pickerRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const selected = THEME_OPTIONS.find((option) => option.id === theme) || THEME_OPTIONS[0];

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!pickerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) { setMenuStyle(null); return undefined; }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: window.visualViewport?.height || window.innerHeight,
      };
      const measuredHeight = menuRef.current?.scrollHeight || 260;
      setMenuStyle(calculateThemeMenuPosition(rect, viewport, measuredHeight));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
    };
  }, [open]);

  return <div className={cx('theme-picker', compact && 'theme-picker-compact')} ref={pickerRef}>
    <button ref={triggerRef} type="button" className={cx('theme-toggle', compact && 'theme-toggle-compact')} onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open} aria-label="انتخاب پوستهٔ برنامه" title={`پوستهٔ فعلی: ${selected.label}`}>
      <span className="theme-toggle-icon">{selected.mode === 'dark' ? <Moon size={19} strokeWidth={2.1} /> : <Sun size={19} strokeWidth={2.1} />}</span>
      <span className="theme-toggle-label">{compact ? 'پوسته' : selected.label}</span>
      <ChevronDown className="theme-toggle-chevron" size={14} />
    </button>
    {open && createPortal(<div ref={menuRef} className="theme-picker-menu" style={menuStyle || { position: 'fixed', visibility: 'hidden', zIndex: 20000 }} role="listbox" aria-label="پوسته‌های برنامه" dir="rtl">
      <div className="theme-picker-title">انتخاب پوسته</div>
      {THEME_OPTIONS.map((option) => <button type="button" role="option" aria-selected={theme === option.id} key={option.id} className={cx('theme-picker-option', theme === option.id && 'selected')} onClick={() => { onChange(option.id); setOpen(false); }}>
        <span className={cx('theme-option-swatch', `swatch-${option.id}`)} aria-hidden="true" />
        <span className="theme-option-copy"><b>{option.label}</b></span>
        {theme === option.id && <Check size={16} className="theme-option-check" />}
      </button>)}
    </div>, document.body)}
  </div>;
}
let deferredPwaInstallPrompt = null;
const pwaPromptSubscribers = new Set();
if (typeof window !== 'undefined' && !window.__acmPwaEventsReady) {
  window.__acmPwaEventsReady = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPwaInstallPrompt = event;
    pwaPromptSubscribers.forEach((subscriber) => subscriber(event));
  });
  window.addEventListener('appinstalled', () => {
    deferredPwaInstallPrompt = null;
    pwaPromptSubscribers.forEach((subscriber) => subscriber(null));
  });
}
function detectPwaPlatform() {
  const ua = navigator.userAgent || '';
  const isAppleMobile = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isAppleMobile) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}
function PwaInstallButton({ menu = false }) {
  const [installPrompt, setInstallPrompt] = useState(() => deferredPwaInstallPrompt);
  const [installed, setInstalled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const platform = typeof navigator !== 'undefined' ? detectPwaPlatform() : 'desktop';

  useEffect(() => {
    const onPromptChange = (event) => {
      setInstallPrompt(event);
      // A null prompt notification is emitted only by the appinstalled event.
      if (!event) { setInstalled(true); setHelpOpen(false); }
    };
    const syncInstalledState = () => {
      const isStandalone = Boolean(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);
      if (isStandalone) { setInstalled(true); setHelpOpen(false); }
    };
    pwaPromptSubscribers.add(onPromptChange);
    const displayMode = window.matchMedia?.('(display-mode: standalone)');
    displayMode?.addEventListener?.('change', syncInstalledState);
    window.addEventListener('focus', syncInstalledState);
    window.addEventListener('pageshow', syncInstalledState);
    document.addEventListener('visibilitychange', syncInstalledState);
    syncInstalledState();
    return () => {
      pwaPromptSubscribers.delete(onPromptChange);
      displayMode?.removeEventListener?.('change', syncInstalledState);
      window.removeEventListener('focus', syncInstalledState);
      window.removeEventListener('pageshow', syncInstalledState);
      document.removeEventListener('visibilitychange', syncInstalledState);
    };
  }, []);

  useEffect(() => {
    if (!helpOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setHelpOpen(false); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [helpOpen]);

  const install = async () => {
    if (installPrompt) {
      try {
        await installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        // Wait for appinstalled or standalone display-mode before hiding the menu item.
      } catch { /* Show manual installation guidance if the native prompt is unavailable. */ }
      setInstallPrompt(null);
      deferredPwaInstallPrompt = null;
      return;
    }
    setHelpOpen(true);
  };

  if (installed) return null;
  const title = platform === 'ios' ? 'نصب روی iPhone یا iPad' : platform === 'android' ? 'نصب روی Android' : 'نصب روی رایانه';
  return <>
    <button type="button" className={menu ? 'nav-button pwa-install-menu-button' : 'pwa-install-button'} onClick={install} title="نصب ACM Classroom روی دستگاه" aria-label="نصب ACM Classroom">
      <Download size={menu ? 18 : 16} /><span>نصب برنامه</span>
    </button>
    {helpOpen && createPortal(<div className="pwa-help-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}>
      <section className="pwa-help-dialog" role="dialog" aria-modal="true" aria-labelledby="pwa-help-title" dir="rtl">
        <header><div className="pwa-help-icon"><Smartphone size={22} /></div><button type="button" className="icon-button" onClick={() => setHelpOpen(false)} aria-label="بستن راهنمای نصب"><X size={18} /></button></header>
        <h2 id="pwa-help-title">{title}</h2>
        {platform === 'ios' ? <ol>
          <li>این صفحه را در مرورگر <b>Safari</b> باز کن؛ نصب از داخل مرورگرهای درون‌برنامه‌ای ممکن است نمایش داده نشود.</li>
          <li>دکمهٔ <b><Share2 size={13} /> Share / اشتراک‌گذاری</b> را در نوار Safari بزن.</li>
          <li>گزینهٔ <b>Add to Home Screen / افزودن به صفحهٔ اصلی</b> را انتخاب کن.</li>
          <li>در صورت نمایش گزینهٔ Open as Web App، آن را فعال کن و روی <b>Add / افزودن</b> بزن.</li>
        </ol> : platform === 'android' ? <ol>
          <li>صفحه را در <b>Chrome</b> باز کن.</li>
          <li><b><MoreVertical size={13} /> منوی سه‌نقطه</b> مرورگر را باز کن.</li>
          <li>گزینهٔ <b>Install app</b> یا <b>Add to Home screen</b> را انتخاب کن.</li>
          <li>نصب را تأیید کن؛ آیکون ACM Classroom به صفحهٔ برنامه‌ها اضافه می‌شود.</li>
        </ol> : <ol>
          <li>صفحه را در مرورگر به‌روز <b>Chrome</b> یا <b>Microsoft Edge</b> باز کن.</li>
          <li>از آیکون <b><MonitorDown size={13} /> نصب برنامه</b> کنار نوار نشانی، یا منوی مرورگر گزینهٔ <b>Install ACM Classroom</b> را انتخاب کن.</li>
          <li>نصب را تأیید کن تا برنامه در پنجرهٔ مستقل و منوی برنامه‌های سیستم اجرا شود.</li>
        </ol>}
        <p className="pwa-help-note">برای نصب، سایت باید با نشانی امن HTTPS باز شده باشد. امکانات کلاس، ورود، ثبت ارسال و داوری برای همگام‌سازی به اینترنت و سرور اصلی نیاز دارند.</p>
        <Button block onClick={() => setHelpOpen(false)}>متوجه شدم</Button>
      </section>
    </div>, document.body)}
  </>;
}

function PageHeading({ eyebrow, title, subtitle, actions }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}
function Button({ children, variant = 'primary', size = 'md', icon: Icon, loading = false, block = false, ...props }) {
  return <button className={cx('btn', `btn-${variant}`, `btn-${size}`, block && 'btn-block')} disabled={loading || props.disabled} {...props}>{loading ? <span className="spinner spinner-button" /> : Icon && <Icon size={size === 'sm' ? 15 : 17} />}{children}</button>;
}
function EmptyState({ icon: Icon = BookOpen, title, text, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={27} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
function StatusBadge({ value, children }) {
  const map = { accepted: 'success', wrong_answer: 'danger', runtime_error: 'warning', time_limit: 'warning', judge_error: 'danger', output_limit: 'warning' };
  const item = verdicts[value];
  return <span className={cx('status-badge', map[value] || value || 'muted')}><i />{children || item?.title || value || 'نامشخص'}</span>;
}
function MetricCard({ icon: Icon, label, value, detail, tone = 'blue' }) {
  return <div className="metric-card"><div className={cx('metric-icon', `tone-${tone}`)}><Icon size={21} /></div><div className="metric-copy"><span>{label}</span><strong>{value ?? '—'}</strong>{detail && <small>{detail}</small>}</div><div className="metric-decoration" /></div>;
}

function LoginScreen({ onLogin, theme, onChangeTheme }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await onLogin({ username, password }); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <div className="auth-page" dir="rtl">
    <div className="auth-backdrop"><span className="orb orb-one" /><span className="orb orb-two" /><span className="grid-pattern" /></div>
    <div className="auth-brand"><div className="auth-brand-identity"><div className="brand-mark"><img src="/icons/icon-192.png" alt="" /></div><div><b>ACM Classroom</b><span>سامانهٔ خصوصی کلاس برنامه‌نویسی</span></div></div><div className="auth-brand-actions"><ThemeToggle theme={theme} onChange={onChangeTheme} compact /></div></div>
    <div className="auth-layout">
      <section className="auth-intro"><div className="auth-pill"><span /> محیط اختصاصی آموزش ACM</div><h1>ایده‌هایت را<br /><span>به کد تبدیل کن.</span></h1><p>محیطی امن برای برگزاری جلسات برنامه‌نویسی، ارسال راه‌حل‌های پایتون و بررسی خودکار پاسخ‌ها.</p><div className="auth-feature-list"><div><span className="feature-symbol"><Clock3 size={17} /></span><div><b>زمان‌بندی و فعال‌سازی سؤال</b><small>نمایش سؤال‌ها دقیقاً در زمان تعیین‌شدهٔ معلم</small></div></div><div><span className="feature-symbol"><FlaskConical size={17} /></span><div><b>داوری خودکار کد</b><small>بررسی پاسخ با تست‌های نمونه و مخفی</small></div></div><div><span className="feature-symbol"><ShieldCheck size={17} /></span><div><b>حساب‌های خصوصی</b><small>ساخت و مدیریت حساب فقط توسط مدیر</small></div></div></div><div className="auth-code-art"><span className="code-window-dots"><i /><i /><i /></span><code><span>def</span> solve():<br /><em>　n = int(input())</em><br />　print(n * <strong>2</strong>)<br /><span className="code-comment"># ready to submit</span></code><div className="code-art-check"><Check size={16} /> AC</div></div></section>
      <section className="login-card"><div className="login-card-top"><div className="login-icon"><LockKeyhole size={22} /></div><div className="login-card-actions"><span className="secure-tag"><ShieldCheck size={14} /> ورود امن</span></div></div><h2>خوش آمدی</h2><p className="login-subtitle">برای ورود به کلاس، اطلاعات حساب خود را وارد کن.</p><form onSubmit={submit} className="login-form"><label htmlFor="username">نام کاربری</label><div className="field-wrap"><UserRound size={18} /><input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" placeholder="نام کاربری خود را وارد کن" required autoFocus /></div><label htmlFor="password">گذرواژه</label><div className="field-wrap"><KeyRound size={18} /><input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="گذرواژه" required /><button type="button" className="password-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'پنهان کردن گذرواژه' : 'نمایش گذرواژه'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>{error && <div className="form-alert"><AlertCircle size={17} />{error}</div>}<Button type="submit" block loading={busy} icon={ArrowDownLeft}>ورود به سامانه</Button></form><div className="login-divider"><span /> <small>دسترسی خصوصی</small> <span /></div><div className="no-signup"><LockKeyhole size={15} /><span>ثبت‌نام عمومی غیرفعال است.</span></div><div className="login-foot">در صورت نداشتن حساب، با مدیر سامانه تماس بگیر.</div></section>
    </div>
    <div className="auth-footer"><span>© ACM Classroom</span><span><ShieldCheck size={14} /> سامانه با دسترسی محدود</span></div>
  </div>;
}

function ForcePasswordChange({ user, onDone, theme, onChangeTheme }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError('');
    if (newPassword !== confirm) return setError('گذرواژه‌های جدید یکسان نیستند.');
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      onDone({ ...user, mustChangePassword: false });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="auth-page password-required" dir="rtl"><div className="password-theme-toggle"><ThemeToggle theme={theme} onChange={onChangeTheme} compact /></div><div className="login-card password-card"><div className="login-icon"><KeyRound /></div><h2>تغییر گذرواژهٔ موقت</h2><p className="login-subtitle">برای امنیت حساب، قبل از ادامه گذرواژهٔ خود را تغییر بده.</p><form className="login-form" onSubmit={submit}><label>گذرواژهٔ فعلی</label><input className="input" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required /><label>گذرواژهٔ جدید (حداقل 12 نویسه)</label><input className="input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} required minLength={12} /><label>تکرار گذرواژهٔ جدید</label><input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={12} />{error && <div className="form-alert"><AlertCircle size={17} />{error}</div>}<Button type="submit" block loading={busy} icon={Check}>ذخیره و ادامه</Button></form></div></div>;
}

function NotificationBell({ onNavigate }) {
  const [open,setOpen]=useState(false); const [items,setItems]=useState([]); const [unread,setUnread]=useState(0); const [busy,setBusy]=useState(false); const [popoverStyle,setPopoverStyle]=useState(null);
  const rootRef=useRef(null); const triggerRef=useRef(null); const popoverRef=useRef(null);
  const load=useCallback((quiet=true)=>{if(!quiet)setBusy(true);api('/notifications').then((r)=>{setItems(r.notifications||[]);setUnread(r.unread||0);}).catch(()=>{}).finally(()=>{if(!quiet)setBusy(false);});},[]);
  useEffect(()=>{load();return scheduleVisibleInterval(load,25000);},[load]);
  useEffect(()=>{
    if(!open)return undefined;
    const outside=(event)=>{if(!rootRef.current?.contains(event.target)&&!popoverRef.current?.contains(event.target))setOpen(false);};
    const escape=(event)=>{if(event.key==='Escape')setOpen(false);};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  useLayoutEffect(()=>{
    if(!open){setPopoverStyle(null);return undefined;}
    const update=()=>{
      const rect=triggerRef.current?.getBoundingClientRect();
      if(!rect)return;
      if(window.innerWidth<=760){
        const maxHeight=Math.max(180,window.innerHeight-92-(window.visualViewport?.offsetTop||0));
        const top=Math.max(8,Math.min(rect.bottom+8,window.innerHeight-maxHeight-8));
        setPopoverStyle({position:'fixed',top,left:8,right:8,width:'auto',maxHeight,zIndex:10020});
      }else{
        setPopoverStyle(floatingLayerStyle(triggerRef.current,popoverRef.current,460,365));
      }
    };
    update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
    const observer=typeof ResizeObserver!=='undefined'&&triggerRef.current?new ResizeObserver(update):null;
    if(observer&&triggerRef.current)observer.observe(triggerRef.current);
    return()=>{window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);observer?.disconnect();};
  },[open,items.length,busy]);
  const openItem=async(item)=>{try{await api(`/notifications/${item.id}/read`,{method:'PATCH',body:{}});setItems((old)=>old.map(n=>n.id===item.id?{...n,readAt:new Date().toISOString()}:n));setUnread((v)=>Math.max(0,v-(!item.readAt?1:0)));}catch{}setOpen(false);const target=item.targetPath||'';if(target==='/contests')onNavigate('contests');else if(target==='/submissions')onNavigate('submissions');else if(target==='/my-class')onNavigate('my-class');else onNavigate('dashboard');};
  const readAll=async()=>{try{await api('/notifications/read-all',{method:'POST',body:{}});setItems(old=>old.map(n=>({...n,readAt:n.readAt||new Date().toISOString()})));setUnread(0);}catch{}};
  return <div className="notification-center" ref={rootRef}>
    <button ref={triggerRef} type="button" className={cx('icon-button notification-trigger',open&&'is-open')} title="اعلان‌ها" aria-label="اعلان‌ها" aria-expanded={open} onClick={()=>{setOpen(v=>!v);if(!open)load(false);}}><Bell size={17}/>{unread>0&&<i className="notification-count">{faNumber(unread>99?99:unread)}</i>}</button>
    {open&&typeof document!=='undefined'&&createPortal(<div ref={popoverRef} className="notification-popover" style={popoverStyle||{position:'fixed',visibility:'hidden',zIndex:10020}} dir="rtl">
      <div className="notification-popover-head"><div><b>اعلان‌ها</b><small>{faNumber(unread)} خوانده‌نشده</small></div><button className="text-link" onClick={readAll} disabled={!unread}>خواندن همه</button></div>
      {busy?<div className="notification-empty">در حال دریافت…</div>:items.length?<div className="notification-list">{items.map(item=><button type="button" key={item.id} className={cx('notification-item',!item.readAt&&'unread')} onClick={()=>openItem(item)}><span className={cx('notification-icon',`notification-${item.type}`)}>{item.type==='contest'?<Swords size={16}/>:item.type==='submission'?<ClipboardCheck size={16}/>:item.type==='problem'?<FileCode2 size={16}/>:<BellRing size={16}/>}</span><span className="notification-copy"><b>{item.title}</b><small>{item.message}</small><time>{formatDate(item.createdAt)}</time></span>{!item.readAt&&<i className="notification-unread-dot"/>}</button>)}</div>:<div className="notification-empty"><Bell size={22}/><b>اعلان تازه‌ای نداری</b><span>فعال‌سازی جلسه‌ها و اتفاقات کلاس اینجا نمایش داده می‌شوند.</span></div>}
    </div>,document.body)}
  </div>;
}

function StudentReportCard({refreshKey}) {
  const [report,setReport]=useState(null);const [loading,setLoading]=useState(true);
  useEffect(()=>{let alive=true;api('/student/report-card').then(r=>{if(alive)setReport(r.report);}).catch(()=>{if(alive)setReport(null);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[refreshKey]);
  if(loading)return <div className="panel report-card-loading"><PageLoading/></div>;
  if(!report)return null;
  const maxActivity=Math.max(1,...(report.activity||[]).map(x=>x.attempts));
  return <section className="panel student-report-card"><div className="report-card-heading"><div><span className="eyebrow">LEARNING ANALYTICS</span><h2><BarChart3 size={18}/> کارنامهٔ تحلیلی من</h2><p>مرور پیشرفت، تلاش‌ها و عملکردت در کلاس.</p></div><span className="report-score"><Trophy size={17}/><b>{faNumber(report.totalPoints)}</b><small>امتیاز کل</small></span></div>
    <div className="report-kpis"><div><b>{faNumber(report.solvedProblems)}</b><span>مسئلهٔ حل‌شده</span></div><div><b>{faNumber(report.attempts)}</b><span>تمام تلاش‌ها</span></div><div><b>{faNumber(report.successRate)}%</b><span>نرخ حل مسائل</span></div><div><b>{faNumber(report.testPassRate)}%</b><span>نرخ تست‌های صحیح</span></div></div>
    {report.class&&<div className="report-rank"><span><Medal size={18}/> رتبه در کلاس <b>{report.class.title}</b></span><strong>{faNumber(report.class.rank)} <small>/ {faNumber(report.class.size)}</small></strong></div>}
    <div className="report-bottom-grid"><div className="report-session-progress"><h3>عملکرد در جلسه‌ها</h3>{report.sessions.length?report.sessions.slice(0,6).map(session=><div className="report-session-row" key={session.id}><div className="report-session-label"><b>{session.title}</b><span>{faNumber(session.solvedCount)} از {faNumber(session.problemCount)} سؤال · {faNumber(session.points)} امتیاز</span></div><div className="report-progress"><i style={{width:`${session.progress}%`}}/></div></div>):<small className="muted-text">هنوز داده‌ای برای نمایش وجود ندارد.</small>}</div><div className="report-activity"><h3>فعالیت 30 روز اخیر</h3>{report.activity.length?<div className="activity-bars">{report.activity.slice(-14).map(day=><div className="activity-bar-column" key={day.day} title={`${day.day}: ${day.attempts} تلاش`}><div className="activity-bar-track"><i style={{height:`${Math.max(5,day.attempts/maxActivity*100)}%`}}/></div><small>{day.day.slice(8)}</small></div>)}</div>:<div className="report-activity-empty">هنوز ارسالی در 30 روز اخیر ثبت نشده است.</div>}</div></div>
  </section>;
}

function Dashboard({ user, refreshKey, onNavigate, onSelectSession }) {
  const displayName = String(user?.displayName || user?.username || 'کاربر').trim() || 'کاربر';
  const firstName = displayName.split(/\s+/)[0] || 'کاربر';
  const [data, setData] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [systemInfo, setSystemInfo] = useState(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let alive = true; setBusy(true);
    const sessionRequest = user.role === 'admin' ? api('/admin/sessions') : Promise.resolve({ sessions: [] });
    const systemRequest = user.role === 'admin' ? api('/admin/system') : Promise.resolve(null);
    Promise.all([api('/dashboard'), sessionRequest, systemRequest])
      .then(([dashboard, list, system]) => { if (alive) { setData(dashboard.stats); setSessions(list.sessions || []); setSystemInfo(system); } })
      .catch(() => { if (alive) { setData(null); setSessions([]); setSystemInfo(null); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [user.role, refreshKey]);

  return <>
    <PageHeading eyebrow="OVERVIEW / پیشخوان" title={`سلام ${firstName}، خوش آمدی`} subtitle="نمای کلی فعالیت‌ها و فضای آموزشی تو در یک نگاه." actions={user.role === 'teacher' ? <Button icon={School} onClick={() => onNavigate('my-classes')}>کلاس‌های من</Button> : user.role === 'student' ? <Button icon={CalendarDays} onClick={() => onNavigate('my-class')}>کلاس من و تقویم</Button> : <Button icon={Users} onClick={() => onNavigate('users')}>مدیریت کاربران</Button>} />
    {busy ? <PageLoading /> : <>
      <div className="welcome-banner"><div className="welcome-copy"><div className="welcome-kicker"><span /> محیط کاری اختصاصی</div><h2>{user.role === 'admin' ? 'نظارت کامل بر سامانه' : user.role === 'teacher' ? 'آمادهٔ شروع یک جلسهٔ تازه‌ای؟' : 'آماده‌ای مسئلهٔ بعدی را حل کنی؟'}</h2><p>{user.role === 'admin' ? 'حساب‌ها، جلسه‌ها و روند ارسال پاسخ‌ها را از یک پنل مدیریت کن.' : user.role === 'teacher' ? 'جلسه‌ها را از داخل کلاس مربوط به خودشان بساز و مدیریت کن.' : 'زمان‌بندی جلسه‌های کلاس را ببین؛ با رسیدن زمان شروع می‌توانی وارد جلسه شوی.'}</p></div><div className="welcome-art"><div className="welcome-art-ring ring-one"/><div className="welcome-art-ring ring-two"/><div className="welcome-code-card"><span>PYTHON / ACM</span><b><span>def</span> <i>main</i>():</b><b>　print(<em>"Hello World!"</em>)</b><div><CheckCircle2 size={15} /> <strong>Ready to judge</strong></div></div><div className="welcome-floating-icon float-top"><Terminal size={17} /></div><div className="welcome-floating-icon float-bottom"><Trophy size={18} /></div></div></div>
      {user.role === 'admin' && <><div className="metrics-grid"><MetricCard icon={Users} label="کاربران فعال" value={data?.users} detail={`${data?.teachers ?? 0} معلم · ${data?.students ?? 0} دانش‌آموز`} tone="blue" /><MetricCard icon={BookOpen} label="کل جلسه‌ها" value={data?.sessions} detail={`${data?.activeSessions ?? 0} جلسه فعال`} tone="purple" /><MetricCard icon={Code2} label="سؤال‌ها" value={data?.problems} detail="در تمام جلسه‌ها" tone="teal" /><MetricCard icon={ClipboardCheck} label="ارسال کد" value={data?.submissions} detail={`${data?.accepted ?? 0} پاسخ کامل پذیرفته‌شده`} tone="orange" /></div><ScaleStatusCard system={systemInfo} /></>}
      {user.role === 'teacher' && <div className="metrics-grid"><MetricCard icon={School} label="کلاس‌های من" value={data?.classes ?? '—'} detail="هر جلسه زیرمجموعهٔ کلاس خودش است" tone="blue" /><MetricCard icon={Zap} label="جلسه‌های فعال" value={data?.activeSessions} detail="در تمام کلاس‌های من" tone="purple" /><MetricCard icon={FileCode2} label="سؤال‌های آماده" value={data?.problems} detail="در جلسه‌های کلاس‌ها" tone="teal" /><MetricCard icon={ClipboardCheck} label="ارسال‌های دانش‌آموزان" value={data?.submissions} detail="برای کلاس‌های من" tone="orange" /></div>}
      {user.role === 'student' && <div className="metrics-grid"><MetricCard icon={CalendarDays} label="جلسه‌های در دسترس" value={data?.activeSessions} detail="در کلاس خودت و پس از زمان شروع" tone="blue" /><MetricCard icon={Trophy} label="امتیاز کل" value={faNumber(data?.totalPoints ?? 0)} detail="بهترین امتیاز هر سؤال محاسبه می‌شود" tone="purple" /><MetricCard icon={CheckCircle2} label="مسئله‌های پذیرفته‌شده" value={data?.problemsSolved} detail="حداقل یک پاسخ کامل" tone="teal" /><MetricCard icon={ClipboardCheck} label="تمام تلاش‌ها" value={data?.submissions} detail="در تاریخچهٔ ارسال‌ها" tone="orange" /></div>}
      {user.role === 'student' && <StudentReportCard refreshKey={refreshKey} />}
      {user.role === 'admin' && <><div className="section-heading"><div><h2>جلسه‌های اخیر</h2><p>نمای کلی تمام جلسه‌های ایجادشده در سامانه.</p></div><button className="text-link" onClick={() => onNavigate('sessions')}>مشاهدهٔ همه <ArrowLeft size={16} /></button></div>{sessions.length ? <div className="session-card-grid">{sessions.slice(0, 4).map((session) => <SessionCard key={session.id} session={session} role="admin" onClick={() => onNavigate('sessions')} />)}</div> : <EmptyState icon={BookOpen} title="هنوز جلسه‌ای ساخته نشده است" text="پس از ساخت جلسه توسط معلم‌ها، اینجا نمایش داده می‌شود." />}</>}
      {user.role === 'teacher' && <div className="notice-bar class-notice dashboard-class-notice"><School size={19} /><div><b>جلسه‌ها داخل کلاس مربوط به خودشان مدیریت می‌شوند.</b><span>برای ساخت، حذف یا ویرایش یک جلسه، ابتدا کلاس آن را از «کلاس‌های من» باز کن. جلسه‌ها در فهرست عمومی جداگانه نمایش داده نمی‌شوند.</span></div><Button icon={ArrowLeft} onClick={() => onNavigate('my-classes')}>رفتن به کلاس‌ها</Button></div>}
      {user.role === 'student' && <div className="notice-bar class-notice dashboard-class-notice"><CalendarDays size={19} /><div><b>جلسه‌های کلاس تو در فهرست برنامه‌ها قرار دارند.</b><span>تا قبل از زمان شروع، برنامه را می‌بینی اما امکان ورود نداری. با رسیدن زمان، دکمهٔ ورود فعال می‌شود.</span></div><Button icon={CalendarDays} onClick={() => onNavigate('my-class')}>دیدن تقویم کلاس</Button></div>}
    </>}
  </>;
}

function ScaleStatusCard({ system }) {
  if (!system) return null;
  const judge = system.judge || {};
  const queuePercent = judge.maxQueue ? Math.min(100, Math.round(judge.queued * 100 / judge.maxQueue)) : 0;
  return <section className="panel scale-status-card"><div className="scale-status-heading"><div><span className="eyebrow">SYSTEM HEALTH / CAPACITY</span><h2><Activity size={18}/> وضعیت ظرفیت سامانه</h2><p>نمای زندهٔ صف داوری و منابع اصلی</p></div><StatusBadge value="success">در حال اجرا</StatusBadge></div>
    <div className="scale-kpis"><div><b>{faNumber(judge.active || 0)} / {faNumber(judge.concurrency || 0)}</b><span>داوری فعال</span></div><div><b>{faNumber(judge.queued || 0)} / {faNumber(judge.maxQueue || 0)}</b><span>در صف داوری</span></div><div><b>{faNumber(system.counts?.users || 0)}</b><span>کاربر فعال</span></div><div><b>{faNumber(system.counts?.submissions || 0)}</b><span>ارسال ثبت‌شده</span></div></div>
    <div className="scale-queue-track"><i style={{width:`${queuePercent}%`}}/></div>
    <div className="scale-status-foot"><span>PostgreSQL · {system.database?.serverVersion || 'متصل'}</span><span>داوری ایزوله با Docker · یک نمونهٔ برنامه</span></div>
    <small className="scale-hint">این پنل ظرفیت صف همین نمونهٔ سرور را نشان می‌دهد؛ برای اجرای چند نمونهٔ موازی، پایگاه داده و صف باید به سرویس‌های مشترک منتقل شوند.</small>
  </section>;
}

function SessionCard({ session, role, onClick }) {
  const active = session.active === true || session.active === 1;
  const teacherName = session.teacherName || session.teacher_name;
  const count = session.problemCount ?? session.problem_count ?? 0;
  return <button className="session-card" onClick={onClick}><div className="session-card-header"><div className="session-symbol"><BookOpen size={20} /></div><StatusBadge value={active ? 'success' : 'muted'}>{active ? 'فعال' : 'پیش‌نویس'}</StatusBadge></div><h3>{session.title}</h3><p>{session.description || 'بدون توضیحات برای جلسه'}</p><div className="session-card-meta">{session.classTitle && <span><School size={15} /> {session.classTitle}</span>}{session.jalaliDate && <span><CalendarDays size={15} /> {jalaliDateLabel(session.jalaliDate)} · {session.startTime || '—'}</span>}<span><ListChecks size={15} /> {count} سؤال</span>{teacherName && <span><UserRound size={15} /> {teacherName}</span>}</div><div className="session-card-footer"><span>{active ? 'ورود به جلسه' : role === 'admin' ? 'مشاهدهٔ جلسه' : 'ویرایش جلسه'}</span><ArrowLeft size={17} /></div></button>;
}

function AdminUsers({ notify, refreshKey }) {
  const confirmAction = useConfirm();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ displayName: '', username: '', role: 'student', password: '' });
  const [busy, setBusy] = useState(false);
  const [resetUser, setResetUser] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const load = useCallback(() => { setLoading(true); api('/admin/users').then((r) => setUsers(r.users)).catch((e) => notify(e.message, 'error')).finally(() => setLoading(false)); }, [notify]);
  useEffect(load, [load, refreshKey]);
  const filtered = users.filter((u) => (roleFilter === 'all' || u.role === roleFilter) && `${u.displayName} ${u.username}`.toLowerCase().includes(query.toLowerCase()));
  const create = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api('/admin/users', { method: 'POST', body: form }); notify('حساب کاربری ساخته شد؛ کاربر باید در نخستین ورود رمز موقت را تغییر دهد.'); setShowCreate(false); setForm({ displayName: '', username: '', role: 'student', password: '' }); load(); }
    catch (err) { notify(err.message, 'error'); } finally { setBusy(false); }
  };
  const toggleActive = async (u) => {
    const confirm = await confirmAction({ title: u.active ? 'غیرفعال‌کردن حساب' : 'فعال‌کردن حساب', message: u.active ? `حساب ${u.username} غیرفعال شود؟` : `حساب ${u.username} دوباره فعال شود؟`, confirmText: u.active ? 'غیرفعال‌کردن' : 'فعال‌کردن' });
    if (!confirm) return;
    try { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); notify(u.active ? 'حساب غیرفعال شد.' : 'حساب فعال شد.'); load(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const doReset = async (e) => {
    e.preventDefault(); if (resetPassword.length < 12) return notify('گذرواژهٔ موقت باید حداقل 12 نویسه باشد.', 'error');
    try { await api(`/admin/users/${resetUser.id}/reset-password`, { method: 'POST', body: { password: resetPassword } }); notify('گذرواژهٔ موقت تعیین شد؛ نشست‌های قبلی کاربر بسته شدند.'); setResetUser(null); setResetPassword(''); }
    catch (err) { notify(err.message, 'error'); }
  };
  return <>
    <PageHeading eyebrow="ADMIN / USERS" title="مدیریت کاربران" subtitle="حساب مدیران، معلم‌ها و دانش‌آموزان را بساز، نقش‌ها را ببین و دسترسی را مدیریت کن." actions={<Button icon={Plus} onClick={() => setShowCreate(true)}>ساخت حساب جدید</Button>} />
    <div className="notice-bar"><ShieldCheck size={19} /><div><b>ثبت‌نام عمومی غیرفعال است.</b><span>فقط مدیر سامانه می‌تواند حساب جدید بسازد. رمز فعلی کاربران قابل مشاهده نیست؛ برای مشکل ورود، رمز موقت تعیین کن.</span></div></div>
    <div className="panel"><div className="panel-toolbar"><div className="search-field"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جست‌وجوی نام یا نام کاربری…" /></div><AppSelect className="select-control" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}><option value="all">همهٔ نقش‌ها</option><option value="teacher">معلم‌ها</option><option value="student">دانش‌آموزان</option><option value="admin">مدیران</option></AppSelect><div className="toolbar-count">{filtered.length} کاربر</div></div>
      {loading ? <PageLoading /> : filtered.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>کاربر</th><th>نام کاربری</th><th>نقش</th><th>وضعیت</th><th>تاریخ ایجاد</th><th>عملیات</th></tr></thead><tbody>{filtered.map((u) => { const Icon = roleIcons[u.role] || UserRound; return <tr key={u.id}><td><div className="table-user"><span className={cx('role-avatar', `role-${u.role}`)}><Icon size={17} /></span><div><b>{u.displayName}</b>{u.mustChangePassword && <small className="text-warning">نیازمند تغییر رمز</small>}</div></div></td><td><code className="username-code">{u.username}</code></td><td><span className={cx('role-chip', `role-chip-${u.role}`)}>{roleLabels[u.role]}</span></td><td><StatusBadge value={u.active ? 'success' : 'muted'}>{u.active ? 'فعال' : 'غیرفعال'}</StatusBadge></td><td>{formatDate(u.createdAt)}</td><td><div className="table-actions"><button title="تعیین گذرواژهٔ موقت" className="table-action" onClick={() => { setResetUser(u); setResetPassword(''); }}><KeyRound size={16} /></button><button title={u.active ? 'غیرفعال‌کردن حساب' : 'فعال‌کردن حساب'} className={cx('table-action', u.active ? 'action-danger' : 'action-success')} onClick={() => toggleActive(u)}>{u.active ? <Power size={16} /> : <CheckCircle2 size={16} />}</button></div></td></tr>; })}</tbody></table></div> : <EmptyState icon={Users} title="کاربری پیدا نشد" text="عبارت جست‌وجو یا فیلتر نقش را تغییر بده." />}
    </div>
    {showCreate && <Modal title="ساخت حساب جدید" subtitle="حساب مدیر، معلم یا دانش‌آموز بساز. حساب‌های مدیریتی محدودیت تعدادی ندارند." onClose={() => setShowCreate(false)}><form className="form-grid admin-user-create-form" onSubmit={create}><Field label="نام کامل" required><input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="مثلاً سارا احمدی" required /></Field><Field label="نام کاربری" hint="انگلیسی، عدد، نقطه یا زیرخط"><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} pattern="[A-Za-z0-9_.-]{3,32}" minLength={3} maxLength={32} autoComplete="off" required placeholder="مثلاً sara.ahmadi" /></Field><Field label="نقش حساب"><AppSelect className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="student">دانش‌آموز</option><option value="teacher">معلم</option><option value="admin">مدیر سامانه</option></AppSelect></Field><Field label="گذرواژهٔ موقت" hint="حداقل 12 نویسه؛ در نخستین ورود تغییر داده شود"><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={12} autoComplete="new-password" required /></Field><div className="admin-user-create-actions"><Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>انصراف</Button><Button type="submit" icon={Plus} loading={busy}>ساخت حساب</Button></div></form></Modal>}
    {resetUser && <Modal title={`تعیین رمز موقت برای ${resetUser.username}`} subtitle="رمز جدید قابل مشاهدهٔ مجدد نخواهد بود. پس از ورود باید تغییر کند." onClose={() => setResetUser(null)}><form className="form-grid" onSubmit={doReset}><Field label="گذرواژهٔ موقت"><input className="input" type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} minLength={12} required autoFocus autoComplete="new-password" /></Field><div className="modal-footer form-full"><Button type="button" variant="ghost" onClick={() => setResetUser(null)}>انصراف</Button><Button type="submit" icon={KeyRound}>ثبت رمز موقت</Button></div></form></Modal>}
  </>;
}

function AdminSessions({ refreshKey }) {
  const [sessions, setSessions] = useState([]); const [loading, setLoading] = useState(true); const [query, setQuery] = useState('');
  useEffect(() => { let a = true; setLoading(true); api('/admin/sessions').then((r) => { if (a) setSessions(r.sessions); }).catch(() => {}).finally(() => { if (a) setLoading(false); }); return () => { a = false; }; }, [refreshKey]);
  const filtered = sessions.filter((s) => `${s.title} ${s.classTitle || ''} ${s.teacherName} ${s.teacherUsername}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeading eyebrow="ADMIN / SESSIONS" title="همهٔ جلسه‌ها" subtitle="فهرست جلسه‌های ساخته‌شده و معلم مسئول هر جلسه." /><div className="panel"><div className="panel-toolbar"><div className="search-field"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جست‌وجوی عنوان، کلاس یا معلم…" /></div><div className="toolbar-count">{filtered.length} جلسه</div></div>{loading ? <PageLoading /> : filtered.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>عنوان جلسه</th><th>کلاس مربوط</th><th>معلم سازنده</th><th>سؤال‌ها</th><th>وضعیت</th><th>آخرین تغییر</th></tr></thead><tbody>{filtered.map((s) => <tr key={s.id}><td><div className="table-user"><span className="role-avatar role-teacher"><BookOpen size={17} /></span><b>{s.title}</b></div><small className="muted-text">{s.description || 'بدون توضیحات'}</small></td><td><b>{s.classTitle || 'کلاس نامشخص'}</b></td><td><div className="stacked-cell"><b>{s.teacherName}</b><code>{s.teacherUsername}</code></div></td><td><span className="number-pill">{s.problemCount}</span></td><td><StatusBadge value={s.active ? 'success' : 'muted'}>{s.active ? 'فعال برای دانش‌آموزان' : 'غیرفعال'}</StatusBadge></td><td>{formatDate(s.updatedAt)}</td></tr>)}</tbody></table></div> : <EmptyState icon={BookOpen} title="هنوز جلسه‌ای وجود ندارد" text="وقتی معلم‌ها جلسه بسازند، اینجا دیده می‌شود." />}</div></>;
}

function TeacherSessions({ refreshKey, notify, onSelect, onManageClasses, initialClassId = null }) {
  const [sessions, setSessions] = useState([]); const [classes, setClasses] = useState([]); const [loading, setLoading] = useState(true); const [showCreate, setShowCreate] = useState(false); const [form, setForm] = useState({ classId: initialClassId || '', title: '', description: '', jalaliDate: '', startTime: '', endTime: '' }); const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setLoading(true); Promise.all([api('/teacher/sessions'), api('/teacher/classes')]).then(([sessionResult, classResult]) => { setSessions(sessionResult.sessions); setClasses(classResult.classes); setForm((old) => ({ ...old, classId: initialClassId || old.classId || classResult.classes[0]?.id || '' })); }).catch((e) => notify(e.message, 'error')).finally(() => setLoading(false)); }, [notify, initialClassId]);
  useEffect(load, [load, refreshKey]);
  const openCreate = () => { setForm((old) => ({ ...old, classId: initialClassId || old.classId || classes[0]?.id || '' })); setShowCreate(true); };
  const create = async (e) => { e.preventDefault(); if (!form.classId) return notify('ابتدا یک کلاس بساز و آن را انتخاب کن.', 'error'); setBusy(true); try { const payload = { ...form, jalaliDate: latinDigits(form.jalaliDate).replace(/-/g, '/') }; const result = await api('/teacher/sessions', { method: 'POST', body: payload }); notify(`جلسه به کلاس «${result.session.classTitle}» اضافه شد.`); setShowCreate(false); setForm({ classId: initialClassId || form.classId, title: '', description: '', jalaliDate: '', startTime: '', endTime: '' }); await load(); onSelect(result.session.id); } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); } };
  return <><PageHeading eyebrow="TEACHER / SESSIONS" title="جلسه‌های من" subtitle="هر جلسه باید به یکی از کلاس‌های خودت وابسته باشد؛ سؤال‌ها و ارسال‌ها در همان کلاس نگهداری می‌شوند." actions={classes.length ? <Button icon={Plus} onClick={openCreate}>ساخت جلسه</Button> : <Button icon={School} onClick={onManageClasses}>ساخت کلاس اول</Button>} />
    <div className="notice-bar notice-purple"><CalendarDays size={19} /><div><b>جلسه‌های اختصاصی کلاس</b><span>هر جلسه به یک کلاس متصل است و فقط دانش‌آموزان همان کلاس می‌توانند سؤال‌های منتشرشده را ببینند و برایشان کد ارسال کنند.</span></div></div>
    {loading ? <PageLoading /> : sessions.length ? <div className="session-card-grid large-grid">{sessions.map((item) => <SessionCard key={item.id} session={item} role="teacher" onClick={() => onSelect(item.id)} />)}</div> : <EmptyState icon={BookOpen} title="هنوز جلسه‌ای نساخته‌ای" text={classes.length ? 'کلاس موردنظر را انتخاب کن و سپس جلسه و سؤال‌های ACM را بساز.' : 'برای شروع، ابتدا یک کلاس بساز؛ بعد جلسه‌های برنامه‌نویسی را به آن متصل کن.'} action={<Button icon={classes.length ? Plus : School} onClick={classes.length ? openCreate : onManageClasses}>{classes.length ? 'ساخت جلسهٔ اول' : 'ساخت کلاس اول'}</Button>} />}
    {showCreate && <Modal title="ساخت جلسهٔ جدید" subtitle="جلسه به کلاس انتخاب‌شده متصل می‌شود و تمام ارسال‌ها با همین کلاس و جلسه ثبت خواهند شد." onClose={() => setShowCreate(false)}><form className="form-grid" onSubmit={create}><Field label="کلاس مربوط به جلسه"><AppSelect className="input" value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })} required><option value="">انتخاب کلاس…</option>{classes.map((classItem) => <option key={classItem.id} value={classItem.id}>{classItem.title}</option>)}</AppSelect></Field><Field label="عنوان جلسه"><input className="input" autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثلاً جلسهٔ 3 — حلقه‌ها و آرایه‌ها" required /></Field><Field label="تاریخ شمسی جلسه" hint="اختیاری؛ در صورت تعیین، در تقویم کلاس و دانش‌آموز نمایش داده می‌شود."><JalaliDateField value={form.jalaliDate} onChange={(value) => setForm({ ...form, jalaliDate: value, ...(value ? {} : { startTime: '', endTime: '' }) })} required={false} /></Field><div className="form-grid"><Field label="ساعت شروع"><input className="input" type="time" lang="en" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required={Boolean(form.jalaliDate)} /></Field><Field label="ساعت پایان"><input className="input" type="time" lang="en" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} required={Boolean(form.jalaliDate)} /></Field></div><Field label="توضیحات" hint="اختیاری" className="form-full"><textarea className="input textarea" rows="3" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="سرفصل جلسه یا توضیح کوتاه…" /></Field><div className="modal-footer form-full"><Button variant="ghost" type="button" onClick={() => setShowCreate(false)}>انصراف</Button><Button type="submit" icon={Plus} loading={busy}>ساخت جلسه</Button></div></form></Modal>}
  </>;
}

function TeacherSession({ sessionId, refreshKey, notify, onBack }) {
  const confirmAction = useConfirm();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [showProblem, setShowProblem] = useState(false); const [editing, setEditing] = useState(null); const [activeBusy, setActiveBusy] = useState(false); const [scheduleForm, setScheduleForm] = useState({ jalaliDate: '', startTime: '', endTime: '' }); const [scheduleBusy, setScheduleBusy] = useState(false); const [exportBusy, setExportBusy] = useState(false); const [showSessionEdit, setShowSessionEdit] = useState(false); const [sessionEditForm, setSessionEditForm] = useState({ title: '', description: '' }); const [sessionEditBusy, setSessionEditBusy] = useState(false);
  const [showBankPicker, setShowBankPicker] = useState(false); const [bankQuestions, setBankQuestions] = useState([]); const [bankLoading, setBankLoading] = useState(false); const [bankQuery, setBankQuery] = useState(''); const [bankCopyingId, setBankCopyingId] = useState(null);
  const load = useCallback(() => { setLoading(true); api(`/teacher/sessions/${sessionId}`).then((result) => { setData(result); setScheduleForm({ jalaliDate: result.session.jalaliDate || '', startTime: result.session.startTime || '', endTime: result.session.endTime || '' }); }).catch((e) => { notify(e.message, 'error'); }).finally(() => setLoading(false)); }, [sessionId, notify]);
  useEffect(load, [load, refreshKey]);
  const exportSession = async () => { setExportBusy(true); try { const document = await api(`/teacher/sessions/${sessionId}/export`); downloadJsonFile(document, `${safeFileName(data.session.title)}.json`); notify('فایل JSON جلسه با تمام سؤال‌ها و تست‌ها آماده شد.'); } catch (err) { notify(err.message, 'error'); } finally { setExportBusy(false); } };
  const toggleSession = async () => { setActiveBusy(true); try { await api(`/teacher/sessions/${sessionId}`, { method: 'PATCH', body: { active: !data.session.active } }); notify(data.session.active ? 'جلسه غیرفعال شد.' : 'جلسه فعال شد؛ دانش‌آموزان از زمان شروع ثبت‌شده به آن دسترسی خواهند داشت.'); load(); } catch (err) { notify(err.message, 'error'); } finally { setActiveBusy(false); } };
  const saveSchedule = async (e) => { e.preventDefault(); setScheduleBusy(true); try { const payload = { ...scheduleForm, jalaliDate: latinDigits(scheduleForm.jalaliDate).replace(/-/g, '/') }; await api(`/teacher/sessions/${sessionId}`, { method: 'PATCH', body: payload }); notify(scheduleForm.jalaliDate ? 'زمان جلسه ذخیره شد و در تقویم کلاس قرار گرفت.' : 'زمان‌بندی جلسه پاک شد.'); await load(); } catch (err) { notify(err.message, 'error'); } finally { setScheduleBusy(false); } };
  const openSessionEdit = () => { setSessionEditForm({ title: data.session.title, description: data.session.description || '' }); setShowSessionEdit(true); };
  const saveSessionInfo = async (e) => { e.preventDefault(); setSessionEditBusy(true); try { await api(`/teacher/sessions/${sessionId}`, { method: 'PATCH', body: sessionEditForm }); notify('عنوان و توضیحات جلسه به‌روزرسانی شد.'); setShowSessionEdit(false); await load(); } catch (err) { notify(err.message, 'error'); } finally { setSessionEditBusy(false); } };
  const removeProblem = async (problem) => { if (!await confirmAction({ title: 'حذف سؤال از جلسه', message: `سؤال «${problem.title}» حذف شود؟`, details: 'تمام تست‌ها، ارسال‌ها و امتیازهای این سؤال برای همیشه حذف می‌شوند. اگر سؤال در مسابقهٔ در حال برگزاری باشد، حذف تا پایان مسابقه ممکن نیست.', confirmText: 'حذف دائمی سؤال' })) return; try { const result = await api(`/teacher/problems/${problem.id}`, { method: 'DELETE', body: {} }); notify(`سؤال حذف شد؛ ${faNumber(result.deletedSubmissions || 0)} ارسال وابسته نیز حذف شد.`); await load(); } catch (err) { notify(err.message, 'error'); } };
  const toggleProblem = async (p) => { try { await api(`/teacher/problems/${p.id}`, { method: 'PATCH', body: { published: !p.published } }); notify(p.published ? 'سؤال از دسترس دانش‌آموزان خارج شد.' : 'سؤال منتشر شد.'); load(); } catch (err) { notify(err.message, 'error'); } };
  const reviewAiSubmission = async (row) => { const flagged = Boolean(row.aiFlagged); const approved = await confirmAction({ title: flagged ? 'بازگردانی تصمیم بررسی کد' : 'تشخیص استفاده از هوش مصنوعی', message: flagged ? 'تصمیم قبلی دربارهٔ این ارسال لغو شود؟' : 'این کد به‌عنوان ارسال تهیه‌شده با هوش مصنوعی علامت‌گذاری شود؟', details: flagged ? 'امتیاز اصلی و وضعیت داوری قبلی بازگردانده می‌شود.' : 'امتیاز ارسال صفر می‌شود، از تلاش‌های مصرف‌شده کنار می‌رود و دانش‌آموز برای حل دوباره فرصت می‌گیرد. سابقهٔ ارسال حذف نخواهد شد و دانش‌آموز اعلان دریافت می‌کند.', confirmText: flagged ? 'بازگرداندن تصمیم' : 'ثبت تشخیص', tone: flagged ? 'primary' : 'danger' }); if (!approved) return; try { const result = await api(`/teacher/submissions/${row.id}/ai-review`, { method: 'PATCH', body: { decision: flagged ? 'restore' : 'flag' } }); notify(result.message || 'وضعیت ارسال به‌روزرسانی شد.'); await load(); } catch (err) { notify(err.message, 'error'); } };
  const openBankPicker = async () => {
    setShowBankPicker(true); setBankQuery(''); setBankLoading(true);
    try { const result = await api('/teacher/question-bank'); setBankQuestions(result.questions || []); }
    catch (err) { notify(err.message, 'error'); setShowBankPicker(false); }
    finally { setBankLoading(false); }
  };
  const copyBankQuestion = async (question) => {
    setBankCopyingId(question.id);
    try {
      await api(`/teacher/question-bank/${question.id}/copy-to-session`, { method: 'POST', body: { sessionId } });
      notify(`سؤال «${question.title}» با تست‌هایش به جلسه اضافه شد.`);
      await load();
    } catch (err) { notify(err.message, 'error'); }
    finally { setBankCopyingId(null); }
  };
  if (loading && !data) return <PageLoading />;
  if (!data) return <EmptyState title="جلسه پیدا نشد" text="ممکن است دسترسی این جلسه حذف شده باشد." action={<Button variant="secondary" onClick={onBack}>بازگشت</Button>} />;
  return <>
    <button className="back-link" onClick={onBack}><ArrowUpRight size={16} /> بازگشت به کلاس مربوط</button>
    <PageHeading eyebrow="TEACHER / SESSION EDITOR" title={data.session.title} subtitle={`کلاس: ${data.session.classTitle || 'نامشخص'} · ${data.session.description || 'مدیریت سؤال‌ها، تست‌ها و زمان انتشار جلسه.'}`} actions={<div className="session-heading-actions"><Button variant="secondary" icon={Settings2} onClick={openSessionEdit}>ویرایش مشخصات</Button><Button variant="secondary" icon={Download} loading={exportBusy} onClick={exportSession}>خروجی JSON</Button><Button variant={data.session.active ? 'danger-ghost' : 'success'} icon={data.session.active ? Power : Play} loading={activeBusy} onClick={toggleSession}>{data.session.active ? 'غیرفعال‌کردن جلسه' : 'فعال‌کردن جلسه'}</Button></div>} />
    <div className={cx('release-banner', data.session.active ? 'release-active' : 'release-draft')}><div className="release-icon">{data.session.active ? <Zap size={20} /> : <Clock3 size={20} />}</div><div><b>{data.session.active ? 'جلسه فعال است و در زمان‌بندی خود در دسترس دانش‌آموزان قرار می‌گیرد' : 'جلسه هنوز برای دانش‌آموزان فعال نشده است'}</b><span>{data.session.active ? 'تا قبل از زمان شروع، جلسه در تقویم دانش‌آموزان قفل می‌ماند؛ از زمان تعیین‌شده ورود فعال می‌شود.' : 'سؤال‌ها را آماده کن و پس از تعیین تاریخ و ساعت، جلسه را فعال کن.'}</span></div><span className="release-status"><i />{data.session.active ? 'ACTIVE' : 'DRAFT'}</span></div>
    <section className="panel settings-panel session-schedule-panel"><div className="panel-heading"><div className="settings-icon"><CalendarDays size={18} /></div><div><h2>زمان‌بندی این جلسه</h2><p>تاریخ شمسی و ساعت این جلسه در تقویم کلاس و حساب دانش‌آموزان نمایش داده می‌شود.</p></div></div><form className="form-grid" onSubmit={saveSchedule}><Field label="تاریخ شمسی"><JalaliDateField value={scheduleForm.jalaliDate} onChange={(value) => setScheduleForm({ ...scheduleForm, jalaliDate: value, ...(value ? {} : { startTime: '', endTime: '' }) })} required={false} /></Field><div className="form-grid"><Field label="ساعت شروع"><input className="input" type="time" lang="en" value={scheduleForm.startTime} onChange={(e) => setScheduleForm({ ...scheduleForm, startTime: e.target.value })} required={Boolean(scheduleForm.jalaliDate)} /></Field><Field label="ساعت پایان"><input className="input" type="time" lang="en" value={scheduleForm.endTime} onChange={(e) => setScheduleForm({ ...scheduleForm, endTime: e.target.value })} required={Boolean(scheduleForm.jalaliDate)} /></Field></div><div className="form-actions form-full"><Button type="submit" icon={CalendarDays} loading={scheduleBusy}>ذخیرهٔ زمان‌بندی</Button></div></form></section>
    <div className="section-heading"><div><h2>سؤال‌های جلسه</h2><p>{data.problems.length} سؤال تعریف‌شده · سؤال جدید بساز یا از بانک مشترک بردار.</p></div><div className="session-question-actions"><Button variant="secondary" icon={Library} onClick={openBankPicker}>افزودن از بانک سؤال</Button><Button icon={Plus} onClick={() => { setEditing(null); setShowProblem(true); }}>ساخت سؤال جدید</Button></div></div>
    {data.problems.length ? <div className="problem-manage-list">{data.problems.map((p, index) => <div className="problem-manage-card" key={p.id}><div className="problem-number">{String(index + 1).padStart(2, '0')}</div><div className="problem-manage-main"><div className="problem-manage-title"><h3>{p.title}</h3>{p.sourceBankId && <span className="small-chip"><Library size={12}/> از بانک مشترک</span>}<StatusBadge value={p.published ? 'success' : 'muted'}>{p.published ? 'منتشرشده' : 'پیش‌نویس'}</StatusBadge></div><p>{p.statement.slice(0, 180)}{p.statement.length > 180 ? '…' : ''}</p><div className="problem-meta"><span><Trophy size={14} /> {p.points} امتیاز</span><span><Gauge size={14} /> {p.attemptLimit > 0 ? `${p.attemptLimit} تلاش` : 'تلاش نامحدود'}</span><span><Clock3 size={14} /> {p.timeLimitMs} ms</span><span><FlaskConical size={14} /> {p.tests.length} تست ({p.tests.filter((t) => t.hidden).length} مخفی)</span></div></div><div className="problem-manage-actions"><button className="table-action" title="ویرایش سؤال" onClick={() => { setEditing(p); setShowProblem(true); }}><Settings2 size={17} /></button><button className={cx('table-action', p.published ? 'action-danger' : 'action-success')} title={p.published ? 'برداشتن انتشار' : 'انتشار سؤال'} onClick={() => toggleProblem(p)}>{p.published ? <EyeOff size={17} /> : <Eye size={17} />}</button><button className="table-action action-danger" title="حذف سؤال" onClick={() => removeProblem(p)}><Trash2 size={17} /></button></div></div>)}</div> : <EmptyState icon={FileCode2} title="هنوز سؤالی اضافه نشده" text="صورت مسئله و تست‌های ورودی/خروجی را وارد کن. تست‌های مخفی در اختیار دانش‌آموز قرار نمی‌گیرند." action={<Button icon={Plus} onClick={() => { setEditing(null); setShowProblem(true); }}>ساخت اولین سؤال</Button>} />}
    <div className="section-heading section-heading-spaced"><div><h2>ارسال‌های دانش‌آموزان</h2><p>نتایج داوری مربوط به همین جلسه.</p></div></div>
    <SubmissionTable rows={data.submissions} showStudent showAiReview onReviewAi={reviewAiSubmission} />
    {showSessionEdit && <Modal title="ویرایش مشخصات جلسه" subtitle="عنوان و توضیحات جلسه را تغییر بده؛ زمان‌بندی و سؤال‌ها حفظ می‌شوند." onClose={() => setShowSessionEdit(false)}><form className="stack-form" onSubmit={saveSessionInfo}><Field label="عنوان جلسه"><input className="input" value={sessionEditForm.title} onChange={(e) => setSessionEditForm({ ...sessionEditForm, title: e.target.value })} required maxLength={120} autoFocus /></Field><Field label="توضیحات"><textarea className="input textarea" rows="4" value={sessionEditForm.description} onChange={(e) => setSessionEditForm({ ...sessionEditForm, description: e.target.value })} maxLength={2000} /></Field><div className="modal-footer"><Button type="button" variant="ghost" onClick={() => setShowSessionEdit(false)}>انصراف</Button><Button type="submit" icon={Check} loading={sessionEditBusy}>ذخیرهٔ تغییرات</Button></div></form></Modal>}
    {showProblem && <ProblemEditorModal problem={editing} onClose={() => setShowProblem(false)} onSave={async (payload) => { const path = editing ? `/teacher/problems/${editing.id}` : `/teacher/sessions/${sessionId}/problems`; const result = await api(path, { method: editing ? 'PATCH' : 'POST', body: payload }); notify(editing ? 'سؤال ذخیره شد.' : 'سؤال ساخته شد.'); setShowProblem(false); load(); return result; }} />}
    {showBankPicker && <Modal wide title="افزودن سؤال از بانک مشترک" subtitle="هر سؤال به همراه تست‌های عمومی و مخفی به‌صورت یک کپی مستقل در این جلسه قرار می‌گیرد." onClose={() => setShowBankPicker(false)}><div className="session-bank-picker"><div className="search-field"><Search size={16}/><input value={bankQuery} onChange={(event)=>setBankQuery(event.target.value)} placeholder="جست‌وجوی عنوان یا متن سؤال…"/></div>{bankLoading?<PageLoading/>:bankQuestions.filter((question)=>`${question.title} ${question.statement}`.toLowerCase().includes(bankQuery.toLowerCase())).length?<div className="session-bank-question-list">{bankQuestions.filter((question)=>`${question.title} ${question.statement}`.toLowerCase().includes(bankQuery.toLowerCase())).map((question)=>{const alreadyAdded=data.problems.some((problem)=>problem.sourceBankId===question.id);return <article className="session-bank-question" key={question.id}><div className="session-bank-question-copy"><b>{question.title}</b><p>{question.statement.slice(0,180)}{question.statement.length>180?'…':''}</p><small>{faNumber(question.points)} امتیاز · {faNumber(question.testCount)} تست · نویسنده: {question.authorName||question.authorUsername}</small></div><Button size="sm" variant={alreadyAdded?'secondary':'primary'} disabled={alreadyAdded||Boolean(bankCopyingId)} loading={bankCopyingId===question.id} icon={alreadyAdded?Check:Copy} onClick={()=>copyBankQuestion(question)}>{alreadyAdded?'اضافه شده':'افزودن به جلسه'}</Button></article>;})}</div>:<EmptyState icon={Library} title="سؤالی پیدا نشد" text={bankQuestions.length?'عبارت جست‌وجو را تغییر بده.':'بانک سؤال هنوز خالی است؛ ابتدا از بخش بانک سؤالات، سؤال ایجاد کن.'}/>}</div></Modal>}
  </>;
}

function TeacherQuestionBank({ user, refreshKey, notify }) {
  const confirmAction = useConfirm();
  const [questions, setQuestions] = useState([]); const [sessions, setSessions] = useState([]); const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(''); const [showEditor, setShowEditor] = useState(false); const [editing, setEditing] = useState(null);
  const [copying, setCopying] = useState(null); const [targetSessionId, setTargetSessionId] = useState(''); const [copyBusy, setCopyBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const [bank, sessionResult] = await Promise.all([api('/teacher/question-bank'), api('/teacher/sessions')]); setQuestions(bank.questions || []); setSessions(sessionResult.sessions || []); }
    catch (err) { notify(err.message, 'error'); }
    finally { setLoading(false); }
  }, [notify]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const openEdit = async (item) => {
    if (!item) { setEditing(null); setShowEditor(true); return; }
    try { const result = await api(`/teacher/question-bank/${item.id}`); setEditing(result.question); setShowEditor(true); }
    catch (err) { notify(err.message, 'error'); }
  };
  const saveQuestion = async (payload) => {
    const path = editing ? `/teacher/question-bank/${editing.id}` : '/teacher/question-bank';
    const result = await api(path, { method: editing ? 'PATCH' : 'POST', body: payload });
    notify(editing ? 'سؤال بانک به‌روزرسانی شد.' : 'سؤال به بانک مشترک اضافه شد.');
    setShowEditor(false); setEditing(null); await load(); return result;
  };
  const deleteQuestion = async (item) => {
    if (!await confirmAction({ title: 'حذف از بانک سؤالات', message: `سؤال «${item.title}» که توسط تو ساخته شده از بانک مشترک حذف شود؟`, details: 'نسخه‌هایی که قبلاً به جلسه‌ها کپی شده‌اند مستقل هستند و حذف نخواهند شد.', confirmText: 'حذف از بانک' })) return;
    try { await api(`/teacher/question-bank/${item.id}`, { method: 'DELETE', body: {} }); notify('سؤال از بانک حذف شد.'); await load(); }
    catch (err) { notify(err.message, 'error'); }
  };
  const copyQuestion = async (event) => {
    event.preventDefault(); if (!copying || !targetSessionId) return;
    setCopyBusy(true);
    try { await api(`/teacher/question-bank/${copying.id}/copy-to-session`, { method: 'POST', body: { sessionId: targetSessionId } }); notify('یک کپی پیش‌نویس از سؤال به جلسه اضافه شد.'); setCopying(null); setTargetSessionId(''); }
    catch (err) { notify(err.message, 'error'); }
    finally { setCopyBusy(false); }
  };
  const filtered = questions.filter((item) => `${item.title} ${item.statement} ${item.authorName || ''} ${item.authorUsername || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <PageHeading eyebrow="TEACHER / QUESTION LIBRARY" title="بانک مشترک سؤالات" subtitle="همهٔ معلم‌ها سؤال‌های بانک را می‌بینند؛ نام نویسندهٔ هر سؤال مشخص است." actions={<Button icon={Plus} onClick={() => openEdit(null)}>ساخت سؤال جدید</Button>} />
    <div className="notice-bar notice-purple"><Library size={18}/><div><b>بانک مشترک تمام معلم‌ها</b><span>سؤال‌های این بانک برای همهٔ معلم‌ها قابل مشاهده و استفاده هستند. نویسندهٔ هر سؤال مشخص است؛ فقط نویسنده می‌تواند نسخهٔ اصلی را ویرایش یا حذف کند. سؤال‌های ساخته‌شده در جلسه نیز خودکار به این بانک افزوده می‌شوند.</span></div></div>
    <div className="panel question-bank-panel"><div className="panel-toolbar"><div className="search-field"><Search size={17}/><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="جست‌وجوی عنوان یا متن سؤال…"/></div><span className="toolbar-count">{faNumber(filtered.length)} از {faNumber(questions.length)} سؤال</span></div>
      {loading ? <PageLoading/> : filtered.length ? <div className="problem-manage-list question-bank-list">{filtered.map((item,index)=><article className="problem-manage-card question-bank-card" key={item.id}><div className="problem-number">{faNumber(index+1).padStart(2,'0')}</div><div className="problem-manage-main"><div className="problem-manage-title"><h3>{item.title}</h3><span className="small-chip"><Library size={12}/> مشترک</span></div><div className="question-bank-author"><UserRound size={13}/><span>نویسنده: <b>{item.authorName || item.authorUsername || 'معلم'}</b></span>{item.authorId===user.id&&<span className="question-bank-own-tag">سؤال من</span>}</div><p>{item.statement.slice(0,180)}{item.statement.length>180?'…':''}</p><div className="problem-meta"><span><Trophy size={14}/> {faNumber(item.points)} امتیاز</span><span><FlaskConical size={14}/> {faNumber(item.testCount)} تست</span><span><Gauge size={14}/> {item.attemptLimit>0?`${faNumber(item.attemptLimit)} تلاش`:'تلاش نامحدود'}</span><span><Clock3 size={14}/> {faNumber(item.timeLimitMs)} ms</span></div></div><div className="problem-manage-actions">{item.authorId===user.id&&<button className="table-action" title="ویرایش سؤال خودت" onClick={()=>openEdit(item)}><Settings2 size={17}/></button>}<button className="table-action action-success" title="کپی سؤال به یک جلسه" onClick={()=>{setCopying(item);setTargetSessionId(sessions[0]?.id||'');}}><Copy size={17}/></button>{item.authorId===user.id&&<button className="table-action action-danger" title="حذف سؤال خودت از بانک" onClick={()=>deleteQuestion(item)}><Trash2 size={17}/></button>}</div></article>)}</div> : <EmptyState icon={Library} title={questions.length?'سؤالی با این عبارت پیدا نشد':'بانک سؤالات خالی است'} text={questions.length?'عبارت جست‌وجو را تغییر بده.':'اولین سؤال را بساز تا بتوانی در چند جلسه از آن استفاده کنی.'} action={<Button icon={Plus} onClick={()=>openEdit(null)}>ساخت اولین سؤال</Button>}/>}
    </div>
    {showEditor && <ProblemEditorModal problem={editing} onClose={()=>{setShowEditor(false);setEditing(null);}} onSave={saveQuestion}/>}
    {copying && <Modal title="افزودن سؤال به جلسه" subtitle={`از سؤال «${copying.title}» یک کپی مستقل در جلسهٔ مقصد ساخته می‌شود.`} onClose={()=>{setCopying(null);setTargetSessionId('');}}><form className="stack-form" onSubmit={copyQuestion}><Field label="جلسهٔ مقصد"><AppSelect className="input" value={targetSessionId} onChange={(e)=>setTargetSessionId(e.target.value)} required><option value="">انتخاب جلسه…</option>{sessions.map((session)=><option key={session.id} value={session.id}>{session.classTitle} — {session.title}</option>)}</AppSelect></Field><div className="notice-bar"><Info size={17}/><div><b>سؤال به‌صورت پیش‌نویس کپی می‌شود.</b><span>برای دانش‌آموزان منتشر نمی‌شود تا معلم آن را بررسی و منتشر کند.</span></div></div><div className="modal-footer"><Button type="button" variant="ghost" onClick={()=>setCopying(null)}>انصراف</Button><Button type="submit" icon={Copy} loading={copyBusy} disabled={!targetSessionId}>کپی به جلسه</Button></div></form></Modal>}
  </>;
}

const DEFAULT_TESTS = JSON.stringify([
  { input: '2 3\n', output: '5\n', hidden: false },
  { input: '10 12\n', output: '22\n', hidden: true },
], null, 2);
function ProblemEditorModal({ problem, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    title: problem?.title || '', statement: problem?.statement || '', inputFormat: problem?.inputFormat || '', outputFormat: problem?.outputFormat || '',
    points: problem?.points ?? 100, attemptLimit: problem?.attemptLimit ?? 3, timeLimitMs: problem?.timeLimitMs ?? 1500, comparison: problem?.comparison || 'tokens', published: problem?.published || false, languageMode: problem?.languageMode || 'python', defaultLanguage: problem?.defaultLanguage || 'python', cppStandard: problem?.cppStandard || '17', cppOptimization: problem?.cppOptimization || 'O2',
  }));
  const [tests, setTests] = useState(() => (problem?.tests || JSON.parse(DEFAULT_TESTS)).map((t) => ({ input: String(t.input ?? ''), output: String(t.output ?? ''), hidden: Boolean(t.hidden) })));
  const [testsText, setTestsText] = useState(() => JSON.stringify((problem?.tests || JSON.parse(DEFAULT_TESTS)).map((t) => ({ input: String(t.input ?? ''), output: String(t.output ?? ''), hidden: Boolean(t.hidden) })), null, 2));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [jsonError, setJsonError] = useState(''); const [importMessage, setImportMessage] = useState('');
  const [previewCode, setPreviewCode] = useState(''); const [previewBusy, setPreviewBusy] = useState(false); const [previewResult, setPreviewResult] = useState(null); const [previewError, setPreviewError] = useState('');
  const fileInputRef = useRef(null);
  const update = (key, value) => setForm((v) => ({ ...v, [key]: value }));
  const syncStructuredTests = (next) => { setTests(next); setTestsText(JSON.stringify(next, null, 2)); setJsonError(''); setImportMessage(''); };
  const updateTest = (index, key, value) => {
    const next = tests.map((test, i) => i === index ? { ...test, [key]: value } : test);
    setTests(next); setTestsText(JSON.stringify(next, null, 2)); setJsonError(''); setImportMessage('');
  };
  const addTest = () => {
    if (tests.length >= 20) { setError('حداکثر 20 تست قابل تعریف است.'); return; }
    setError(''); syncStructuredTests([...tests, { input: '', output: '', hidden: false }]);
  };
  const removeTest = (index) => {
    setError(''); syncStructuredTests(tests.filter((_, i) => i !== index));
  };
  const changeTestsJson = (value) => {
    setTestsText(value); setImportMessage('');
    try {
      const parsed = normalizeTestCases(JSON.parse(value));
      setTests(parsed); setJsonError('');
    } catch (err) {
      setJsonError(err instanceof SyntaxError ? 'JSON هنوز کامل یا معتبر نیست؛ پس از کامل‌شدن ساختار، رابط تست‌ها به‌روز می‌شود.' : err.message);
    }
  };
  const importTestsJson = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') throw new Error('فقط فایل با پسوند .json قابل بارگذاری است.');
      const parsed = normalizeTestCases(JSON.parse(await file.text()));
      syncStructuredTests(parsed); setImportMessage(`فایل ${file.name} با موفقیت بارگذاری شد.`); setError('');
    } catch (err) {
      setJsonError(err instanceof SyntaxError ? 'فایل JSON معتبر نیست.' : err.message); setImportMessage('');
    } finally { event.target.value = ''; }
  };
  const runPreview = async () => {
    setPreviewError(''); setPreviewResult(null);
    if (!previewCode.trim()) { setPreviewError('ابتدا کد آزمایشی را وارد کن.'); return; }
    let normalizedTests;
    try { normalizedTests = normalizeTestCases(JSON.parse(testsText)); }
    catch (err) { setPreviewError(err.message || 'ابتدا JSON تست‌ها را معتبر کن.'); return; }
    setPreviewBusy(true);
    try {
      const result = await api('/teacher/question-bank/preview', { method: 'POST', body: { code: previewCode, tests: normalizedTests, timeLimitMs: Number(form.timeLimitMs), comparison: form.comparison, language: form.defaultLanguage, cppStandard: form.cppStandard, cppOptimization: form.cppOptimization } });
      setPreviewResult(result);
    } catch (err) { setPreviewError(err.message); }
    finally { setPreviewBusy(false); }
  };
  const submit = async (e) => {
    e.preventDefault(); setError('');
    let normalizedTests;
    try { normalizedTests = normalizeTestCases(JSON.parse(testsText)); }
    catch (err) { setJsonError(err.message || 'تست‌ها باید یک آرایهٔ JSON معتبر باشند.'); setError('ابتدا خطای JSON تست‌ها را برطرف کن.'); return; }
    if (normalizedTests.length < 1) { setError('حداقل یک تست تعریف کن.'); return; }
    setBusy(true);
    try { await onSave({ title: form.title, statement: form.statement, inputFormat: form.inputFormat, outputFormat: form.outputFormat, points: Number(form.points), attemptLimit: Number(form.attemptLimit), timeLimitMs: Number(form.timeLimitMs), comparison: form.comparison, published: Boolean(form.published), tests: normalizedTests, languageMode: form.languageMode, defaultLanguage: form.defaultLanguage, cppStandard: form.cppStandard, cppOptimization: form.cppOptimization }); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <Modal title={problem ? 'ویرایش سؤال' : 'افزودن سؤال ACM'} subtitle="تست‌های مخفی فقط در سمت سرور نگه داشته می‌شوند." onClose={onClose} wide>
    <form className="problem-editor-form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="عنوان سؤال" required className="form-full"><input className="input" value={form.title} onChange={(e) => update('title', e.target.value)} required placeholder="مثلاً A. Sum of Two Numbers" /></Field>
        <Field label="صورت مسئله" required className="form-full"><textarea className="input textarea statement-editor" rows="5" value={form.statement} onChange={(e) => update('statement', e.target.value)} required placeholder="متن کامل مسئله را وارد کن…" /></Field>
        <Field label="قالب ورودی" className="form-full"><textarea className="input textarea" rows="2" value={form.inputFormat} onChange={(e) => update('inputFormat', e.target.value)} placeholder="توضیح ورودی مسئله…" /></Field>
        <Field label="قالب خروجی" className="form-full"><textarea className="input textarea" rows="2" value={form.outputFormat} onChange={(e) => update('outputFormat', e.target.value)} placeholder="توضیح خروجی مورد انتظار…" /></Field>
        <Field label="امتیاز سؤال"><input className="input" type="number" min="1" max="1000" value={form.points} onChange={(e) => update('points', e.target.value)} required /></Field>
        <Field label="محدودیت تعداد تلاش" hint="صفر یعنی نامحدود؛ از 1 تا 100 تلاش قابل تعیین است."><input className="input" type="number" min="0" max="100" value={form.attemptLimit} onChange={(e) => update('attemptLimit', e.target.value)} required /></Field>
        <Field label="محدودیت زمان (میلی‌ثانیه)"><AppSelect className="input" value={form.timeLimitMs} onChange={(e) => update('timeLimitMs', e.target.value)}><option value="500">500 ms</option><option value="1000">1000 ms</option><option value="1500">1500 ms</option><option value="2000">2000 ms</option><option value="3000">3000 ms</option><option value="5000">5000 ms</option></AppSelect></Field>
        <Field label="مقایسهٔ خروجی"><AppSelect className="input" value={form.comparison} onChange={(e) => update('comparison', e.target.value)}><option value="tokens">نادیده‌گرفتن فاصله‌های اضافی</option><option value="exact">مقایسهٔ دقیق</option></AppSelect></Field>
        <Field label="زبان‌های مجاز"><AppSelect className="input" value={form.languageMode} onChange={e=>{const languageMode=e.target.value;update('languageMode',languageMode);if(languageMode==='python')update('defaultLanguage','python');if(languageMode==='cpp')update('defaultLanguage','cpp');}}><option value="python">فقط Python</option><option value="cpp">فقط C++</option><option value="both">Python و C++</option></AppSelect></Field>
        <Field label="زبان پیش‌فرض"><AppSelect className="input" value={form.defaultLanguage} onChange={e=>update('defaultLanguage',e.target.value)}><option value="python" disabled={form.languageMode==='cpp'}>Python 3</option><option value="cpp" disabled={form.languageMode==='python'}>C++</option></AppSelect></Field>
        <Field label="استاندارد C++"><AppSelect className="input" value={form.cppStandard} onChange={e=>update('cppStandard',e.target.value)}><option value="17">C++17</option><option value="20">C++20</option></AppSelect></Field>
        <Field label="بهینه‌سازی C++"><AppSelect className="input" value={form.cppOptimization} onChange={e=>update('cppOptimization',e.target.value)}><option value="O0">O0</option><option value="O1">O1</option><option value="O2">O2</option><option value="O3">O3</option></AppSelect></Field>
        <div className="field form-full"><label className="checkbox-line"><input type="checkbox" checked={form.published} onChange={(e) => update('published', e.target.checked)} /> سؤال بلافاصله پس از ذخیره منتشر شود</label></div>
      </div>
      <section className="testcase-editor testcase-workbench" aria-label="ویرایش تست‌های ورودی و خروجی">
        <div className="testcase-head testcase-workbench-head">
          <div><h3><FlaskConical size={18} /> تست‌های ورودی و خروجی</h3><p>تست‌ها را با فرم بساز یا JSON را مستقیماً ویرایش کن؛ تغییرات بین دو بخش هماهنگ می‌شوند.</p></div>
          <div className="testcase-head-actions"><span className="hidden-tests-chip"><EyeOff size={14} /> تست‌های مخفی</span><button type="button" className="btn btn-secondary testcase-add-btn" onClick={addTest}><Plus size={15} /> افزودن تست</button><button type="button" className="btn btn-secondary testcase-import-btn" onClick={() => fileInputRef.current?.click()}><Upload size={15} /> بارگذاری JSON</button><input ref={fileInputRef} type="file" accept=".json,application/json" hidden onChange={importTestsJson} /></div>
        </div>
        <div className="testcase-workbench-grid">
          <div className="testcase-visual-editor" dir="rtl">
            <div className="testcase-list-toolbar"><b>ساخت تست با فرم</b><span>{tests.length} / 20 تست</span></div>
            {tests.length ? <div className="testcase-card-list">{tests.map((test, index) => <article className="testcase-card" key={`test-${index}`}>
              <div className="testcase-card-head"><div className="testcase-card-title"><span className="testcase-index">{index + 1}</span><b>تست {index + 1}</b><span className={cx('testcase-visibility', test.hidden ? 'is-hidden' : 'is-public')}>{test.hidden ? <><EyeOff size={13} /> مخفی</> : <><Eye size={13} /> عمومی</>}</span></div><button type="button" className="testcase-remove-btn" title={`حذف تست ${index + 1}`} aria-label={`حذف تست ${index + 1}`} onClick={() => removeTest(index)}><X size={15} /></button></div>
              <div className="testcase-fields-grid">
                <div className="testcase-value-field"><label htmlFor={`test-input-${index}`}>ورودی تست</label><textarea id={`test-input-${index}`} className="input textarea testcase-value-input" dir="ltr" spellCheck="false" rows="3" value={test.input} onChange={(e) => updateTest(index, 'input', e.target.value)} placeholder={'2 3\\n'} /></div>
                <div className="testcase-value-field"><label htmlFor={`test-output-${index}`}>خروجی مورد انتظار</label><textarea id={`test-output-${index}`} className="input textarea testcase-value-input" dir="ltr" spellCheck="false" rows="3" value={test.output} onChange={(e) => updateTest(index, 'output', e.target.value)} placeholder={'5\\n'} /></div>
              </div>
              <label className="testcase-hidden-toggle"><input type="checkbox" checked={test.hidden} onChange={(e) => updateTest(index, 'hidden', e.target.checked)} /><span className="testcase-toggle-ui" /><span><b>تست مخفی</b><small>ورودی و خروجی این تست به دانش‌آموز نمایش داده نمی‌شود.</small></span></label>
            </article>)}</div> : <div className="testcase-empty"><FlaskConical size={22} /><b>هنوز تستی تعریف نشده</b><span>برای شروع روی «افزودن تست» بزن یا یک فایل JSON بارگذاری کن.</span></div>}
            <div className="testcase-editor-footnote"><ShieldCheck size={14} /> حداقل 1 و حداکثر 20 تست مجاز است.</div>
          </div>
          <div className="testcase-json-editor" dir="ltr">
            <div className="testcase-json-heading"><div><b>ویرایش مستقیم JSON</b><small>UTF-8 · اعداد انگلیسی · همگام‌سازی زنده</small></div><span className={cx('json-sync-status', jsonError ? 'has-error' : 'is-valid')}>{jsonError ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}{jsonError ? 'JSON نامعتبر' : 'همگام'}</span></div>
            <textarea className="input textarea code-input test-json testcase-json-textarea" dir="ltr" spellCheck="false" value={testsText} onChange={(e) => changeTestsJson(e.target.value)} rows="18" aria-label="JSON تست‌های ورودی و خروجی" />
            {jsonError && <div className="testcase-json-error" dir="rtl"><AlertCircle size={14} />{jsonError}</div>}
            {importMessage && <div className="testcase-import-success" dir="rtl"><CheckCircle2 size={14} />{importMessage}</div>}
            <div className="testcase-json-hint" dir="rtl"><b>راهنمای فیلدها</b><span><code dir="ltr">input</code> ورودی برنامه است.</span><span><code dir="ltr">output</code> خروجی مورد انتظار است.</span><span><code dir="ltr">hidden: true</code> تست را از دانش‌آموز پنهان می‌کند.</span><small>در JSON، کاراکتر خط جدید را با <code dir="ltr">\n</code> بنویس. پس از کامل‌شدن JSON معتبر، فرم تست‌ها خودکار به‌روز می‌شود.</small></div>
          </div>
        </div>
      </section>
      <section className="problem-preview-workbench">
        <div className="problem-preview-heading"><div><h3><Play size={17} /> پیش‌نمایش و آزمایش سؤال</h3><p>کد نمونهٔ خودت را اجرا کن؛ تمام تست‌های عمومی و مخفی بررسی می‌شوند، اما هیچ ارسال یا امتیازی ثبت نخواهد شد.</p></div><span className="preview-private-tag"><ShieldCheck size={14} /> فقط معلم</span></div>
        <textarea className="input textarea code-input problem-preview-code" dir="ltr" spellCheck="false" value={previewCode} onChange={(e) => setPreviewCode(e.target.value)} rows="7" placeholder={form.defaultLanguage==='cpp'?'// C++ test code':'# Python test code'} aria-label="کد برای آزمایش سؤال" />
        <div className="problem-preview-actions"><span><FlaskConical size={14} /> {faNumber(tests.length)} تست · {faNumber(tests.filter((test) => test.hidden).length)} تست مخفی</span><Button type="button" icon={Play} loading={previewBusy} onClick={runPreview} disabled={Boolean(jsonError)}>اجرای آزمایشی تمام تست‌ها</Button></div>
        {previewError && <div className="testcase-json-error" dir="rtl"><AlertCircle size={14} />{previewError}</div>}
        {previewResult && <div className={cx('problem-preview-results', previewResult.verdict === 'accepted' ? 'is-accepted' : 'has-failures')}><div className="problem-preview-summary"><div><b>{previewResult.verdict === 'accepted' ? 'تمام تست‌ها موفق بودند' : 'برخی تست‌ها ناموفق بودند'}</b><small>{faNumber(previewResult.passedCases)} از {faNumber(previewResult.totalCases)} تست · {faNumber(previewResult.runtimeMs)} میلی‌ثانیه</small></div><StatusBadge value={previewResult.verdict} /></div><div className="problem-preview-case-grid">{previewResult.cases.map((item) => <div className={cx('problem-preview-case', item.passed ? 'passed' : 'failed')} key={item.index}><span className="preview-case-index">{faNumber(item.index)}</span><span className="preview-case-label">تست {faNumber(item.index)}</span><span className="preview-case-visibility">{item.hidden ? <><EyeOff size={12}/> مخفی</> : <><Eye size={12}/> عمومی</>}</span><strong>{item.passed ? 'موفق' : item.status === 'runtime_error' ? 'خطای اجرا' : item.status === 'time_limit' ? 'اتمام زمان' : item.status === 'output_limit' ? 'خروجی زیاد' : 'ناموفق'}</strong></div>)}</div><small className="problem-preview-footnote">نتیجهٔ آزمایش فقط برای بررسی معلم است و در تاریخچه یا امتیاز دانش‌آموزان ثبت نمی‌شود.</small></div>}
      </section>
      {error && <div className="form-alert"><AlertCircle size={17} />{error}</div>}
      <div className="modal-footer"><Button variant="ghost" type="button" onClick={onClose}>انصراف</Button><Button type="submit" icon={Check} loading={busy}>ذخیرهٔ سؤال</Button></div>
    </form>
  </Modal>;
}

const PERSIAN_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const PERSIAN_WEEKDAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
const faNumber = (value) => formatNumber(value);
const latinDigits = (value = '') => toLatinDigits(value);
function jalaliParts(date) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Tehran' }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}
function jalaliKey(year, month, day) { return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`; }
function parseJalaliKey(value = '') { const parts = latinDigits(value).replace(/-/g, '/').split('/').map(Number); return parts.length === 3 && parts.every(Number.isFinite) ? { year: parts[0], month: parts[1], day: parts[2] } : null; }
function jalaliDateLabel(value = '') {
  const parts = parseJalaliKey(value);
  return parts && parts.year ? `${faNumber(parts.year)}/${faNumber(parts.month).padStart(2, '0')}/${faNumber(parts.day).padStart(2, '0')}` : latinDigits(value);
}
function gregorianForJalali(year, month, day = 1) {
  const start = Date.UTC(year + 621, 0, 1, 12);
  const end = Date.UTC(year + 623, 0, 1, 12);
  for (let time = start; time < end; time += 86400000) {
    const candidate = new Date(time);
    const parts = jalaliParts(candidate);
    if (parts.year === year && parts.month === month && parts.day === day) return candidate;
  }
  return null;
}
function shiftJalaliMonth(value, delta) {
  let year = value.year; let month = value.month + delta;
  while (month < 1) { month += 12; year -= 1; }
  while (month > 12) { month -= 12; year += 1; }
  return { year, month };
}
function OnlinePill({ online }) { return <span className={cx('online-pill', online ? 'is-online' : 'is-offline')}><i />{online ? 'آنلاین' : 'آفلاین'}</span>; }

function PersianCalendar({ events = [], editable = false, onChooseDate }) {
  const [month, setMonth] = useState(() => { const p = jalaliParts(new Date()); return { year: p.year, month: p.month }; });
  const today = jalaliParts(new Date());
  const todayKey = jalaliKey(today.year, today.month, today.day);
  const model = useMemo(() => {
    const first = gregorianForJalali(month.year, month.month, 1);
    if (!first) return { days: [], offset: 0, byDate: new Map() };
    const followingMonth = shiftJalaliMonth(month, 1);
    const next = gregorianForJalali(followingMonth.year, followingMonth.month, 1);
    const length = next ? Math.round((next.getTime() - first.getTime()) / 86400000) : 30;
    const byDate = new Map();
    for (const event of events) {
      const key = latinDigits(event.jalaliDate || event.jalali_date || '').replace(/-/g, '/');
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(event);
    }
    return { days: Array.from({ length }, (_, i) => i + 1), offset: (first.getUTCDay() + 1) % 7, byDate };
  }, [month.year, month.month, events]);
  return <section className="panel persian-calendar-panel">
    <div className="calendar-head"><div><div className="calendar-kicker"><CalendarDays size={16} /> تقویم شمسی کلاس</div><h2>{PERSIAN_MONTHS[month.month - 1]} {faNumber(month.year)}</h2></div><div className="calendar-nav"><button className="icon-button" title="ماه قبل" onClick={() => setMonth((m) => shiftJalaliMonth(m, -1))}><ChevronRightSafe /></button><button className="icon-button" title="ماه بعد" onClick={() => setMonth((m) => shiftJalaliMonth(m, 1))}><ChevronLeft size={17} /></button></div></div>
    <div className="persian-calendar-grid">{PERSIAN_WEEKDAYS.map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}{Array.from({ length: model.offset }, (_, i) => <div className="calendar-empty" key={`empty-${i}`} />)}{model.days.map((day) => { const key = jalaliKey(month.year, month.month, day); const dayEvents = model.byDate.get(key) || []; const isToday = key === todayKey; return <button key={key} type="button" aria-current={isToday ? 'date' : undefined} className={cx('calendar-day', dayEvents.length > 0 && 'has-events', isToday && 'is-today', editable && 'calendar-day-editable')} onClick={() => editable && onChooseDate?.(key)} title={isToday ? `امروز · ${key}` : dayEvents.map((event) => event.title).join('، ') || key}><b>{faNumber(day)}</b>{dayEvents.length > 0 && <span className="calendar-event-count">{faNumber(dayEvents.length)} برنامه</span>}{dayEvents.length > 0 && <span className="calendar-event-dot" />}</button>; })}</div>
    <div className="calendar-legend"><span><i className="legend-dot" /> روز دارای برنامه</span><span><i className="today-legend-dot" /> امروز</span>{editable && <span>برای انتخاب تاریخ، روی روز کلیک کن.</span>}</div>
  </section>;
}
function JalaliDateField({ value, onChange, placeholder = '1405/08/12', ariaLabel = 'انتخاب تاریخ شمسی', required = false }) {
  const [open, setOpen] = useState(false);
  const current = parseJalaliKey(value);
  const today = jalaliParts(new Date());
  const [month, setMonth] = useState(() => current ? { year: current.year, month: current.month } : { year: today.year, month: today.month });
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const [popoverStyle, setPopoverStyle] = useState(null);
  useEffect(() => {
    if (current) setMonth({ year: current.year, month: current.month });
  }, [value]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => { if (!rootRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) { setPopoverStyle(null); return undefined; }
    const update = () => setPopoverStyle(floatingLayerStyle(triggerRef.current, popoverRef.current, 304, 300));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver !== 'undefined' && rootRef.current ? new ResizeObserver(update) : null;
    if (observer && rootRef.current) observer.observe(rootRef.current);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); observer?.disconnect(); };
  }, [open, month.year, month.month]);
  const first = gregorianForJalali(month.year, month.month, 1);
  const nextMonth = shiftJalaliMonth(month, 1);
  const nextFirst = gregorianForJalali(nextMonth.year, nextMonth.month, 1);
  const count = first && nextFirst ? Math.round((nextFirst.getTime() - first.getTime()) / 86400000) : 30;
  const offset = first ? (first.getUTCDay() + 1) % 7 : 0;
  const todayKey = jalaliKey(today.year, today.month, today.day);
  const select = (day) => { onChange?.(jalaliKey(month.year, month.month, day)); setOpen(false); };
  return <div className={cx('jalali-date-field', open && 'is-open')} ref={rootRef} dir="ltr">
    <div className="jalali-date-control">
      <input className="input jalali-date-input" value={value} onChange={(event) => onChange?.(latinDigits(event.target.value).replace(/-/g, '/'))} onFocus={() => setOpen(false)} placeholder={placeholder} dir="ltr" inputMode="numeric" aria-label={ariaLabel} required={required} />
      <button ref={triggerRef} type="button" className="jalali-date-trigger" aria-label={ariaLabel} aria-expanded={open} onClick={() => setOpen((state) => !state)}><CalendarDays size={17} /></button>
    </div>
    {open && typeof document !== 'undefined' && createPortal(<div ref={popoverRef} className="jalali-date-popover" dir="rtl" style={popoverStyle || { position: 'fixed', visibility: 'hidden', zIndex: 10000 }}>
      <div className="jalali-date-popover-head"><button type="button" className="icon-button" title="ماه قبل" onClick={() => setMonth((m) => shiftJalaliMonth(m, -1))}><ChevronRightSafe /></button><b>{PERSIAN_MONTHS[month.month - 1]} {faNumber(month.year)}</b><button type="button" className="icon-button" title="ماه بعد" onClick={() => setMonth((m) => shiftJalaliMonth(m, 1))}><ChevronLeft size={17} /></button></div>
      <div className="jalali-date-grid">{PERSIAN_WEEKDAYS.map((day) => <span className="jalali-date-weekday" key={day}>{day.slice(0, 1)}</span>)}{Array.from({ length: offset }, (_, index) => <span className="jalali-date-empty" key={`empty-${index}`} />)}{Array.from({ length: count }, (_, index) => { const day = index + 1; const key = jalaliKey(month.year, month.month, day); return <button type="button" key={key} className={cx('jalali-date-day', key === todayKey && 'is-today', key === value && 'is-selected')} aria-pressed={key === value} onClick={() => select(day)}>{faNumber(day)}</button>; })}</div>
      <div className="jalali-date-popover-foot"><span>تقویم شمسی · ساعت تهران</span><button type="button" onClick={() => { setMonth({ year: today.year, month: today.month }); onChange?.(todayKey); setOpen(false); }}>امروز</button></div>
    </div>, document.body)}
  </div>;
}
function jalaliWallTimeToIso(value) {
  const match = String(value || '').match(/^(\d{4}\/\d{2}\/\d{2})T([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return '';
  const dateParts = parseJalaliKey(match[1]);
  const gregorian = dateParts && gregorianForJalali(dateParts.year, dateParts.month, dateParts.day);
  if (!gregorian) return '';
  const desiredUtc = Date.UTC(gregorian.getUTCFullYear(), gregorian.getUTCMonth(), gregorian.getUTCDate(), Number(match[2]), Number(match[3]), 0);
  const formatter = new Intl.DateTimeFormat('en-US-u-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let guess = desiredUtc;
  for (let index = 0; index < 5; index += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const delta = desiredUtc - asUtc;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess).toISOString();
}
function isoToJalaliWallTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const p = jalaliParts(date);
  const parts = new Intl.DateTimeFormat('en-US-u-nu-latn', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${jalaliKey(p.year, p.month, p.day)}T${get('hour')}:${get('minute')}`;
}
function JalaliDateTimeField({ value, onChange, required = true, dateLabel = 'تاریخ شمسی', timeLabel = 'ساعت تهران' }) {
  const [dateValue = '', timeValue = ''] = String(value || '').split('T');
  return <div className="jalali-datetime-grid">
    <Field label={dateLabel}><JalaliDateField value={dateValue} onChange={(date) => onChange(`${date}T${timeValue}`)} required={required} /></Field>
    <Field label={timeLabel}><input className="input" type="time" lang="en" dir="ltr" value={timeValue} onChange={(event) => onChange(`${dateValue}T${event.target.value}`)} required={required} /></Field>
  </div>;
}
function ChevronRightSafe() { return <ChevronLeft size={17} style={{ transform: 'rotate(180deg)' }} />; }
function ClassEventList({ events = [], editable = false, onDelete, onOpenSession }) {
  if (!events.length) return <EmptyState icon={CalendarDays} title="هنوز برنامه‌ای ثبت نشده است" text="وقتی معلم برای کلاس تاریخ تعیین کند، برنامه‌ها در این بخش نمایش داده می‌شوند." />;
  return <div className="class-event-list">{events.map((event) => {
    const date = parseJalaliKey(event.jalaliDate);
    const content = <><div className="event-date-tile"><b>{date?.day ? faNumber(date.day) : '—'}</b><span>{PERSIAN_MONTHS[(date?.month || 1) - 1]}</span></div><div className="class-event-main"><h3>{event.title}</h3>{event.description && <p>{event.description}</p>}<div className="class-event-meta"><span><CalendarDays size={14} />{jalaliDateLabel(event.jalaliDate)}</span><span><Clock3 size={14} />{event.startTime} تا {event.endTime}</span></div>{event.isCodingSession && !editable && <span className={cx('event-session-status', event.available && 'is-available')}>{event.available ? <><Play size={13} /> ورود به جلسه</> : event.active ? <><Lock size={13} /> شروع در ساعت {event.startTime}</> : <><Lock size={13} /> در انتظار فعال‌سازی معلم</>}</span>}</div></>;
    if (event.isCodingSession && event.available && !editable && onOpenSession) return <button type="button" className="class-event-row class-event-session-open" key={event.id} onClick={() => onOpenSession(event.sessionId)}>{content}<ArrowLeft size={17} className="class-event-open-arrow" /></button>;
    return <article className={cx('class-event-row', event.isCodingSession && 'class-event-session-locked')} key={event.id}>{content}{editable && !event.isCodingSession && <button className="icon-button event-delete" title="حذف برنامه" onClick={() => onDelete?.(event)}><X size={16} /></button>}</article>;
  })}</div>;
}
function TeacherClasses({ refreshKey, notify, onSelect }) {
  const confirmAction = useConfirm();
  const [classes, setClasses] = useState([]); const [loading, setLoading] = useState(true); const [showCreate, setShowCreate] = useState(false); const [form, setForm] = useState({ title: '', description: '' }); const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setLoading(true); api('/teacher/classes').then((r) => setClasses(r.classes)).catch((e) => notify(e.message, 'error')).finally(() => setLoading(false)); }, [notify]);
  useEffect(load, [load, refreshKey]);
  const create = async (e) => { e.preventDefault(); if (!form.title.trim()) return; setBusy(true); try { const r = await api('/teacher/classes', { method: 'POST', body: form }); setClasses((old) => [r.class, ...old]); setForm({ title: '', description: '' }); setShowCreate(false); notify('کلاس با موفقیت ساخته شد.'); } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); } };
  const deleteClass = async (item) => {
    if (!await confirmAction({ title: 'حذف کلاس', message: `کلاس «${item.title}» حذف شود؟`, details: 'دانش‌آموزان عضو آزاد می‌شوند. اگر کلاس هنوز جلسه داشته باشد، ابتدا باید جلسه‌ها را حذف کنی.', confirmText: 'حذف کلاس' })) return;
    try { await api(`/teacher/classes/${item.id}`, { method: 'DELETE', body: {} }); setClasses((old) => old.filter((entry) => entry.id !== item.id)); notify('کلاس حذف شد.'); }
    catch (err) { notify(err.message, 'error'); }
  };
  return <><PageHeading eyebrow="TEACHER / CLASSROOMS" title="کلاس‌های من" subtitle="هر کلاس، تقویم، دانش‌آموزان و جلسه‌های مستقل خودش را دارد." actions={<Button icon={Plus} onClick={() => setShowCreate(true)}>ساخت کلاس</Button>} />
    <div className="notice-bar class-notice"><School size={18} /><div><b>جلسه‌ها فقط داخل کلاس مربوط به خودشان مدیریت می‌شوند.</b><span>برای مشاهده، ساخت یا حذف جلسه، کلاس موردنظر را باز کن. هر دانش‌آموز فقط در یک کلاس می‌تواند عضو باشد.</span></div></div>
    {loading ? <PageLoading /> : classes.length ? <div className="session-card-grid classroom-card-grid">{classes.map((item) => <div className="classroom-card-wrap" key={item.id}><button className="session-card classroom-card" onClick={() => onSelect(item.id)}><div className="session-card-header"><div className="session-symbol"><School size={20} /></div><StatusBadge value="success">کلاس من</StatusBadge></div><h3>{item.title}</h3><p>{item.description || 'برای این کلاس توضیحی ثبت نشده است.'}</p><div className="session-card-meta"><span><Users size={15} />{faNumber(item.studentCount)} دانش‌آموز</span><span><BookOpen size={15} />{faNumber(item.sessionCount || 0)} جلسه</span><span><CalendarDays size={15} />{faNumber(item.eventCount)} برنامه</span></div><div className="session-card-footer"><span>مدیریت کلاس و تقویم</span><ArrowLeft size={17} /></div></button><button type="button" className="classroom-card-delete" title={`حذف کلاس ${item.title}`} aria-label={`حذف کلاس ${item.title}`} onClick={() => deleteClass(item)}><Trash2 size={15} /><span>حذف کلاس</span></button></div>)}</div> : <EmptyState icon={School} title="هنوز کلاسی نساخته‌ای" text="کلاس اولت را بساز؛ سپس دانش‌آموزان و برنامه‌های زمانی را به آن اضافه کن." action={<Button icon={Plus} onClick={() => setShowCreate(true)}>ساخت اولین کلاس</Button>} />}
    {showCreate && <Modal title="ساخت کلاس جدید" subtitle="نام کلاس و توضیح اختیاری را وارد کن." onClose={() => setShowCreate(false)}><form className="stack-form" onSubmit={create}><Field label="نام کلاس"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required placeholder="مثلاً پایتون مقدماتی — گروه یک" /></Field><Field label="توضیحات"><textarea className="input textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={2000} placeholder="هدف یا توضیح کوتاه کلاس" /></Field><div className="form-actions"><Button type="submit" icon={Check} loading={busy}>ساخت کلاس</Button><Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>انصراف</Button></div></form></Modal>}
  </>;
}
function TeacherClassDetail({ classId, refreshKey, notify, onBack, onSelectSession }) {
  const confirmAction = useConfirm();
  const [data, setData] = useState(null); const [available, setAvailable] = useState([]); const [loading, setLoading] = useState(true); const [studentId, setStudentId] = useState(''); const [busy, setBusy] = useState(false); const [eventForm, setEventForm] = useState({ title: '', description: '', jalaliDate: '', startTime: '09:00', endTime: '10:00' }); const [eventBusy, setEventBusy] = useState(false); const [editForm, setEditForm] = useState({ title: '', description: '' }); const [savingClass, setSavingClass] = useState(false); const [showCreateSession, setShowCreateSession] = useState(false); const [sessionForm, setSessionForm] = useState({ title: '', description: '', jalaliDate: '', startTime: '', endTime: '' }); const [sessionBusy, setSessionBusy] = useState(false); const [importedSession, setImportedSession] = useState(null); const [importFileName, setImportFileName] = useState(''); const [importError, setImportError] = useState(''); const [exportingSessionId, setExportingSessionId] = useState(null); const sessionImportInputRef = useRef(null);
  const load = useCallback(async (quiet = false) => { if (!quiet) setLoading(true); try { const [classResult, studentsResult] = await Promise.all([api(`/teacher/classes/${classId}`), api('/teacher/students/available')]); setData(classResult); setAvailable(studentsResult.students); if (!quiet) setEditForm({ title: classResult.class.title, description: classResult.class.description || '' }); } catch (e) { if (!quiet) notify(e.message, 'error'); } finally { if (!quiet) setLoading(false); } }, [classId, notify]);
  useEffect(() => { load(); return scheduleVisibleInterval(() => load(true), 20000); }, [load, refreshKey]);
  const addStudent = async (e) => { e.preventDefault(); if (!studentId) return; setBusy(true); try { await api(`/teacher/classes/${classId}/members`, { method: 'POST', body: { studentId } }); notify('دانش‌آموز به کلاس اضافه شد.'); setStudentId(''); await load(true); } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); } };
  const removeStudent = async (student) => { if (!await confirmAction({ title: 'خارج‌کردن دانش‌آموز', message: `دانش‌آموز «${student.displayName}» از این کلاس خارج شود؟`, confirmText: 'خارج‌کردن' })) return; try { await api(`/teacher/classes/${classId}/members/${student.id}`, { method: 'DELETE', body: {} }); notify('دانش‌آموز از کلاس خارج شد.'); await load(true); } catch (err) { notify(err.message, 'error'); } };
  const saveClass = async (e) => { e.preventDefault(); setSavingClass(true); try { await api(`/teacher/classes/${classId}`, { method: 'PATCH', body: editForm }); notify('اطلاعات کلاس ذخیره شد.'); await load(true); } catch (err) { notify(err.message, 'error'); } finally { setSavingClass(false); } };
  const deleteClass = async () => { if (!await confirmAction({ title: 'حذف کلاس و تقویم', message: 'این کلاس و تقویم آن حذف شود؟', details: 'دانش‌آموزان عضو آزاد می‌شوند. اگر جلسه‌ای به کلاس متصل باشد، ابتدا باید جلسه‌ها را حذف کنی.', confirmText: 'حذف کلاس' })) return; try { await api(`/teacher/classes/${classId}`, { method: 'DELETE', body: {} }); notify('کلاس حذف شد.'); onBack(); } catch (err) { notify(err.message, 'error'); } };
  const addSession = async (e) => {
    e.preventDefault(); if (!sessionForm.title.trim()) return; setSessionBusy(true);
    try {
      const sessionDetails = { ...sessionForm, jalaliDate: latinDigits(sessionForm.jalaliDate).replace(/-/g, '/') };
      let result;
      if (importedSession) {
        result = await api(`/teacher/classes/${classId}/sessions/import`, { method: 'POST', body: { ...importedSession, session: { ...importedSession.session, ...sessionDetails } } });
        notify(`جلسه و ${result.importedProblems} سؤال به این کلاس وارد شد.`);
      } else {
        result = await api('/teacher/sessions', { method: 'POST', body: { ...sessionDetails, classId } });
        notify('جلسه به همین کلاس اضافه شد.');
      }
      setShowCreateSession(false); setImportedSession(null); setImportFileName(''); setImportError('');
      setSessionForm({ title: '', description: '', jalaliDate: '', startTime: '', endTime: '' }); await load(true);
    } catch (err) { notify(err.message, 'error'); } finally { setSessionBusy(false); }
  };
  const importSessionJson = async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    setImportedSession(null); setImportFileName(''); setImportError('');
    try {
      if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') throw new Error('فقط فایل با پسوند JSON قابل بارگذاری است.');
      if (file.size > 2 * 1024 * 1024) throw new Error('حجم فایل جلسه نباید بیشتر از 2 مگابایت باشد.');
      const document = JSON.parse(await file.text());
      if (document?.format !== 'acm-classroom-session' || document?.formatVersion !== 1 || !document.session || !Array.isArray(document.problems) || document.problems.length > 100) throw new Error('قالب فایل جلسه معتبر نیست یا با این نسخه سازگار نیست.');
      if (!String(document.session.title || '').trim()) throw new Error('عنوان جلسه در فایل JSON خالی است.');
      for (const [index, problem] of document.problems.entries()) {
        if (!String(problem?.title || '').trim() || !String(problem?.statement || '').trim() || !Array.isArray(problem.tests) || problem.tests.length < 1 || problem.tests.length > 20) throw new Error(`ساختار سؤال ${index + 1} معتبر نیست.`);
        if (!problem.tests.some((test) => test && typeof test.input === 'string' && typeof test.output === 'string' && !test.hidden)) throw new Error(`سؤال ${index + 1} باید حداقل یک تست عمومی معتبر داشته باشد.`);
        if (problem.tests.some((test) => !test || typeof test.input !== 'string' || typeof test.output !== 'string')) throw new Error(`ورودی یا خروجی تست‌های سؤال ${index + 1} معتبر نیست.`);
      }
      const safeDocument = { format: document.format, formatVersion: document.formatVersion, session: document.session, problems: document.problems };
      setImportedSession(safeDocument); setImportFileName(file.name);
      setSessionForm((old) => ({ ...old, title: document.session.title || '', description: document.session.description || '', jalaliDate: latinDigits(document.session.jalaliDate || ''), startTime: document.session.startTime || '', endTime: document.session.endTime || '' }));
      notify(`${document.problems.length} سؤال از فایل JSON خوانده شد. مقصد: کلاس «${data.class.title}».`);
    } catch (err) { setImportError(err instanceof SyntaxError ? 'فایل JSON قابل‌خواندن نیست؛ ساختار آن را بررسی کن.' : err.message); }
    finally { event.target.value = ''; }
  };
  const exportSession = async (session) => {
    setExportingSessionId(session.id);
    try { const document = await api(`/teacher/sessions/${session.id}/export`); downloadJsonFile(document, `${safeFileName(session.title)}.json`); notify(`خروجی JSON جلسهٔ «${session.title}» آماده شد.`); }
    catch (err) { notify(err.message, 'error'); } finally { setExportingSessionId(null); }
  };
  const deleteSession = async (session) => { if (!await confirmAction({ title: 'حذف جلسه', message: `جلسهٔ «${session.title}» حذف شود؟`, details: 'تمام سؤال‌ها، تست‌ها، ارسال‌ها و امتیازهای ثبت‌شدهٔ این جلسه نیز برای همیشه حذف می‌شوند.', confirmText: 'حذف دائمی جلسه' })) return; try { await api(`/teacher/sessions/${session.id}`, { method: 'DELETE', body: {} }); notify('جلسه و اطلاعات وابسته به آن حذف شد.'); await load(true); } catch (err) { notify(err.message, 'error'); } };
  const addEvent = async (e) => { e.preventDefault(); setEventBusy(true); const payload = { ...eventForm, jalaliDate: latinDigits(eventForm.jalaliDate).replace(/-/g, '/') }; try { await api(`/teacher/classes/${classId}/events`, { method: 'POST', body: payload }); notify('برنامه به تقویم اضافه شد.'); setEventForm({ title: '', description: '', jalaliDate: '', startTime: '09:00', endTime: '10:00' }); await load(true); } catch (err) { notify(err.message, 'error'); } finally { setEventBusy(false); } };
  const chooseDate = (key) => setEventForm((old) => ({ ...old, jalaliDate: key }));
  const deleteEvent = async (event) => { if (!await confirmAction({ title: 'حذف برنامهٔ تقویم', message: `برنامهٔ «${event.title}» حذف شود؟`, confirmText: 'حذف برنامه' })) return; try { await api(`/teacher/classes/${classId}/events/${event.id}`, { method: 'DELETE', body: {} }); notify('برنامه حذف شد.'); await load(true); } catch (err) { notify(err.message, 'error'); } };
  const calendarItems = [...(data?.events || []), ...(data?.sessions || []).filter((session) => session.jalaliDate && session.calendarVisible !== false).map((session) => ({ ...session, id: `coding-session-${session.id}`, title: `جلسهٔ برنامه‌نویسی: ${session.title}`, description: session.description || 'جلسهٔ تمرین ACM', isCodingSession: true }))].sort((a, b) => `${a.jalaliDate} ${a.startTime || ''}`.localeCompare(`${b.jalaliDate} ${b.startTime || ''}`));
  if (loading) return <PageLoading />;
  if (!data) return <EmptyState icon={School} title="کلاس در دسترس نیست" text="ممکن است کلاس حذف شده باشد یا دسترسی آن تغییر کرده باشد." action={<Button onClick={onBack}>بازگشت</Button>} />;
  return <><button className="back-link" onClick={onBack}><ArrowUpRight size={16} /> بازگشت به کلاس‌های من</button><PageHeading eyebrow="TEACHER / CLASS DETAILS" title={data.class.title} subtitle="مدیریت اطلاعات، فهرست دانش‌آموزان، حضور آنلاین و تقویم شمسی کلاس." actions={<Button variant="danger" icon={X} onClick={deleteClass}>حذف کلاس</Button>} />
    <div className="class-detail-layout"><div className="class-detail-main"><section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon"><School size={18} /></div><div><h2>اطلاعات کلاس</h2><p>نام و توضیحات در داشبورد کلاس نمایش داده می‌شود.</p></div></div><form className="stack-form" onSubmit={saveClass}><Field label="نام کلاس"><input className="input" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required maxLength={120} /></Field><Field label="توضیحات"><textarea className="input textarea" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} maxLength={2000} /></Field><div className="form-actions"><Button type="submit" icon={Check} loading={savingClass}>ذخیره اطلاعات</Button></div></form></section>
      <section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon settings-icon-amber"><Medal size={18} /></div><div><h2>رتبه‌بندی دانش‌آموزان این کلاس</h2><p>رتبه فقط بین اعضای همین کلاس محاسبه می‌شود؛ انتقال کلاس، امتیازهای قبلی دانش‌آموز را حفظ می‌کند.</p></div><span className="toolbar-count">{faNumber(data.members.length)} نفر</span></div><form className="add-member-row" onSubmit={addStudent}><AppSelect className="select-control" value={studentId} onChange={(e) => setStudentId(e.target.value)} required><option value="">انتخاب دانش‌آموز آزاد…</option>{available.map((student) => <option value={student.id} key={student.id}>{student.displayName} — {student.username}</option>)}</AppSelect><Button icon={Plus} type="submit" loading={busy} disabled={!studentId}>افزودن به کلاس</Button></form><p className="field-hint">فهرست فقط دانش‌آموزان فعال و بدون کلاس را نشان می‌دهد.</p>{data.members.length ? <div className="table-scroll class-ranking-table"><table className="data-table"><thead><tr><th>رتبهٔ کلاس</th><th>دانش‌آموز</th><th>امتیاز کل</th><th>وضعیت حضور</th><th>عملیات</th></tr></thead><tbody>{data.members.map((student) => <tr key={student.id}><td><b className="class-rank-number">{faNumber(student.rank)}</b></td><td><div className="stacked-cell"><b>{student.displayName}</b><code>{student.username}</code></div></td><td><b className="student-class-points"><Trophy size={13} /> {faNumber(student.totalPoints || 0)}</b></td><td><OnlinePill online={student.online} /></td><td><button className="icon-button member-remove" title="خارج‌کردن از کلاس" onClick={() => removeStudent(student)}><X size={15} /></button></td></tr>)}</tbody></table></div> : <EmptyState icon={Users} title="هنوز دانش‌آموزی عضو نیست" text="از فهرست بالا اولین دانش‌آموز را اضافه کن." />}</section>
      <section className="panel settings-panel class-sessions-panel"><div className="panel-heading class-sessions-heading"><div className="settings-icon"><BookOpen size={18} /></div><div><h2>جلسه‌های برنامه‌نویسی این کلاس</h2><p>هر سؤال و ارسال دانش‌آموز به یکی از جلسه‌های این کلاس وصل است.</p></div><span className="toolbar-count">{faNumber(data.sessions?.length || 0)} جلسه</span></div>{data.sessions?.length ? <div className="class-member-list">{data.sessions.map((session) => <div className="class-member-row class-session-row" key={session.id}><div className="session-symbol"><BookOpen size={17} /></div><div className="class-member-identity"><b>{session.title}</b><span>{faNumber(session.problemCount)} سؤال · {faNumber(session.submissionCount)} ارسال</span>{session.jalaliDate && <small><CalendarDays size={13} /> {jalaliDateLabel(session.jalaliDate)} · {session.startTime} تا {session.endTime}</small>}</div><StatusBadge value={session.active ? 'success' : 'muted'}>{session.active ? 'فعال' : 'پیش‌نویس'}</StatusBadge><button className="table-action" title="مدیریت جلسه و سؤال‌ها" onClick={() => onSelectSession(session.id)}><ArrowLeft size={16} /></button><button className="table-action session-export" title="خروجی JSON جلسه و همهٔ سؤال‌ها" aria-label={`دریافت JSON جلسه ${session.title}`} disabled={exportingSessionId === session.id} onClick={() => exportSession(session)}>{exportingSessionId === session.id ? <span className="spinner spinner-button" /> : <Download size={15} />}</button><button className="icon-button session-delete" title="حذف جلسه" aria-label={`حذف جلسه ${session.title}`} onClick={() => deleteSession(session)}><Trash2 size={15} /></button></div>)}</div> : <EmptyState icon={BookOpen} title="هنوز جلسه‌ای برای این کلاس ساخته نشده" text="یک جلسه بساز تا سؤال‌های ACM و ارسال‌های دانش‌آموزان زیر همین کلاس ثبت شوند." />}<div className="form-actions"><Button icon={Plus} onClick={() => setShowCreateSession(true)}>ساخت جلسه برای این کلاس</Button></div></section>
      <section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon"><CalendarDays size={18} /></div><div><h2>افزودن برنامه به تقویم</h2><p>تاریخ را به شمسی وارد کن؛ نمونه: 1405/08/12.</p></div></div><form className="stack-form" onSubmit={addEvent}><Field label="عنوان برنامه"><input className="input" value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} required maxLength={140} placeholder="مثلاً جلسهٔ حلقه‌ها" /></Field><Field label="تاریخ شمسی"><JalaliDateField value={eventForm.jalaliDate} onChange={(value) => setEventForm({ ...eventForm, jalaliDate: value })} required /></Field><div className="form-grid"><Field label="ساعت شروع"><input className="input" type="time" lang="en" value={eventForm.startTime} onChange={(e) => setEventForm({ ...eventForm, startTime: e.target.value })} required /></Field><Field label="ساعت پایان"><input className="input" type="time" lang="en" value={eventForm.endTime} onChange={(e) => setEventForm({ ...eventForm, endTime: e.target.value })} required /></Field></div><Field label="توضیحات"><textarea className="input textarea" value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} maxLength={2000} placeholder="مباحث یا تکالیف جلسه" /></Field><div className="form-actions"><Button type="submit" icon={Plus} loading={eventBusy}>ثبت در تقویم</Button></div></form></section></div>
      <aside className="class-detail-calendar"><PersianCalendar events={calendarItems} editable onChooseDate={chooseDate} /><section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon"><CalendarDays size={18} /></div><div><h2>برنامه‌های کلاس</h2><p>تاریخ‌های نزدیک و آینده</p></div></div><ClassEventList events={calendarItems} editable onDelete={deleteEvent} /></section></aside></div>
    {showCreateSession && <Modal title={importedSession ? 'واردکردن جلسه از JSON' : 'ساخت جلسه برای این کلاس'} subtitle={`جلسه فقط در زیرمجموعهٔ کلاس «${data.class.title}» ساخته می‌شود. در حالت ورود JSON، تمام سؤال‌ها و تست‌ها هم منتقل می‌شوند.`} onClose={() => { setShowCreateSession(false); setImportedSession(null); setImportFileName(''); setImportError(''); setSessionForm({ title: '', description: '', jalaliDate: '', startTime: '', endTime: '' }); }} wide><form className="form-grid" onSubmit={addSession}><div className="session-json-import form-full"><input ref={sessionImportInputRef} type="file" accept=".json,application/json" hidden onChange={importSessionJson} /><Button type="button" variant="secondary" icon={Upload} onClick={() => sessionImportInputRef.current?.click()}>بارگذاری فایل JSON جلسه</Button><span>{importFileName ? `${importFileName} · ${importedSession?.problems?.length || 0} سؤال` : 'فایل خروجی یک جلسه از ACM Classroom را انتخاب کن.'}</span>{importError && <small className="form-inline-error">{importError}</small>}</div><Field label="عنوان جلسه"><input className="input" autoFocus value={sessionForm.title} onChange={(e) => setSessionForm({ ...sessionForm, title: e.target.value })} maxLength={120} required placeholder="مثلاً جلسهٔ 3 — حلقه‌ها" /></Field><Field label="تاریخ شمسی جلسه" hint="برای فعال‌سازی جلسه و نمایش در تقویم، تاریخ و ساعت الزامی است."><JalaliDateField value={sessionForm.jalaliDate} onChange={(value) => setSessionForm({ ...sessionForm, jalaliDate: value, ...(value ? {} : { startTime: '', endTime: '' }) })} required /></Field><div className="form-grid"><Field label="ساعت شروع"><input className="input" type="time" lang="en" value={sessionForm.startTime} onChange={(e) => setSessionForm({ ...sessionForm, startTime: e.target.value })} required /></Field><Field label="ساعت پایان"><input className="input" type="time" lang="en" value={sessionForm.endTime} onChange={(e) => setSessionForm({ ...sessionForm, endTime: e.target.value })} required /></Field></div><Field label="توضیحات" className="form-full"><textarea className="input textarea" rows="3" value={sessionForm.description} onChange={(e) => setSessionForm({ ...sessionForm, description: e.target.value })} placeholder="سرفصل یا توضیح جلسه" /></Field><div className="modal-footer form-full"><Button type="button" variant="ghost" onClick={() => { setShowCreateSession(false); setImportedSession(null); setImportFileName(''); setImportError(''); setSessionForm({ title: '', description: '', jalaliDate: '', startTime: '', endTime: '' }); }}>انصراف</Button><Button type="submit" icon={importedSession ? Upload : Plus} loading={sessionBusy}>{importedSession ? `واردکردن جلسه و ${importedSession.problems.length} سؤال` : 'ساخت جلسه'}</Button></div></form></Modal>}
  </>;
}

function TeacherContests({refreshKey,notify}) {
  const confirmAction=useConfirm();
  const [contests,setContests]=useState([]);const [questions,setQuestions]=useState([]);const [students,setStudents]=useState([]);
  const [loading,setLoading]=useState(true);const [showCreate,setShowCreate]=useState(false);const [busy,setBusy]=useState(false);
  const [selected,setSelected]=useState(null);const [questionQuery,setQuestionQuery]=useState('');const [studentQuery,setStudentQuery]=useState('');const [now,setNow]=useState(Date.now());const [contestStudentToAdd,setContestStudentToAdd]=useState('');const [contestEndExtension,setContestEndExtension]=useState('');const [contestStartUpdate,setContestStartUpdate]=useState('');const [contestScheduledEndUpdate,setContestScheduledEndUpdate]=useState('');const [contestFreezeMinutes,setContestFreezeMinutes]=useState(10);const [contestSimilarity,setContestSimilarity]=useState(null);const [contestSimilarityBusy,setContestSimilarityBusy]=useState(false);
  const [form,setForm]=useState({title:'',description:'',startJalaliDate:'',startTime:'',endJalaliDate:'',endTime:'',penaltyMinutes:20,freezeMinutes:10,bankQuestionIds:[],studentIds:[]});
  const load=useCallback(async(quiet=false)=>{
    if(!quiet)setLoading(true);
    try{const [contestResult,bankResult,studentResult]=await Promise.all([api('/teacher/contests'),api('/teacher/contest-bank-questions'),api('/teacher/contest-students')]);setContests(contestResult.contests||[]);setQuestions(bankResult.questions||[]);setStudents(studentResult.students||[]);}
    catch(error){if(!quiet)notify(error.message,'error');}
    finally{if(!quiet)setLoading(false);}
  },[notify]);
  useEffect(()=>{load();return scheduleVisibleInterval(()=>load(true),20000);},[load,refreshKey]);
  useEffect(()=>scheduleVisibleInterval(()=>setNow(Date.now()),1000),[]);
  const selectedContestId=selected?.contest?.id;
  useEffect(()=>{if(!selectedContestId)return undefined;let active=true;const refresh=()=>api(`/teacher/contests/${selectedContestId}`).then(result=>{if(active)setSelected(result);}).catch(()=>{});const stopPolling=scheduleVisibleInterval(refresh,5000);return()=>{active=false;stopPolling();};},[selectedContestId]);
  const filteredQuestions=questions.filter(item=>`${item.title} ${item.statement} ${item.authorName||''}`.toLowerCase().includes(questionQuery.toLowerCase()));
  const filteredStudents=students.filter(item=>`${item.displayName} ${item.username} ${item.classTitle||''} ${item.classTeacherName||''}`.toLowerCase().includes(studentQuery.toLowerCase()));
  const toggleQuestion=id=>setForm(old=>({...old,bankQuestionIds:old.bankQuestionIds.includes(id)?old.bankQuestionIds.filter(x=>x!==id):[...old.bankQuestionIds,id]}));
  const toggleStudent=id=>setForm(old=>({...old,studentIds:old.studentIds.includes(id)?old.studentIds.filter(x=>x!==id):[...old.studentIds,id]}));
  const toggleVisibleStudents=()=>setForm(old=>{const visible=filteredStudents.map(s=>s.id);const allSelected=visible.length>0&&visible.every(id=>old.studentIds.includes(id));return {...old,studentIds:allSelected?old.studentIds.filter(id=>!visible.includes(id)):[...new Set([...old.studentIds,...visible])]};});
  const resetForm=()=>{setForm({title:'',description:'',startJalaliDate:'',startTime:'',endJalaliDate:'',endTime:'',penaltyMinutes:20,freezeMinutes:10,bankQuestionIds:[],studentIds:[]});setQuestionQuery('');setStudentQuery('');};
  const create=async(event)=>{
    event.preventDefault();setBusy(true);
    try{
      const payload={...form,startJalaliDate:latinDigits(form.startJalaliDate).replace(/-/g,'/'),endJalaliDate:latinDigits(form.endJalaliDate).replace(/-/g,'/'),penaltyMinutes:Number(form.penaltyMinutes),freezeMinutes:Number(form.freezeMinutes)};
      await api('/teacher/contests',{method:'POST',body:payload});notify(`مسابقه ساخته شد و برای ${faNumber(form.studentIds.length)} دانش‌آموز اعلان ارسال شد.`);
      setShowCreate(false);resetForm();await load(true);
    }catch(error){notify(error.message,'error');}finally{setBusy(false);}
  };
  const openBoard=async(contest)=>{try{const result=await api(`/teacher/contests/${contest.id}`);setSelected(result);setContestStartUpdate(isoToJalaliWallTime(result.contest.startAt));setContestScheduledEndUpdate(isoToJalaliWallTime(result.contest.endAt));setContestEndExtension(isoToJalaliWallTime(result.contest.endAt));setContestFreezeMinutes(Number(result.contest.freezeMinutes||0));setContestSimilarity(null);setContestStudentToAdd('');}catch(error){notify(error.message,'error');}};
  const manageSelected=async(payload)=>{if(!selected)return;try{await api(`/teacher/contests/${selected.contest.id}`,{method:'PATCH',body:payload});const fresh=await api(`/teacher/contests/${selected.contest.id}`);setSelected(fresh);await load(true);notify('تنظیمات مسابقه به‌روزرسانی شد.');}catch(error){notify(error.message,'error');}};
  const scanContestSimilarity=async()=>{if(!selected)return;setContestSimilarityBusy(true);try{setContestSimilarity(await api('/teacher/similarity/scan',{method:'POST',body:{type:'contest',id:selected.contest.id,threshold:45}}));}catch(error){notify(error.message,'error');}finally{setContestSimilarityBusy(false);}};
  const remove=async(contest)=>{
    if(!await confirmAction({title:'حذف مسابقه',message:`مسابقهٔ «${contest.title}» حذف شود؟`,details:'ارتباط مسابقه و دعوت‌ها حذف می‌شود؛ سابقهٔ اصلی ارسال‌های داوری دانش‌آموزان باقی می‌ماند.',confirmText:'حذف مسابقه'}))return;
    try{await api(`/teacher/contests/${contest.id}`,{method:'DELETE',body:{}});notify('مسابقه حذف شد.');await load(true);}catch(error){notify(error.message,'error');}
  };
  const statusLabel={scheduled:'زمان‌بندی‌شده',active:'در حال برگزاری',ended:'پایان‌یافته'};
  const visibleAllSelected=filteredStudents.length>0&&filteredStudents.every(student=>form.studentIds.includes(student.id));
  return <>
    <PageHeading eyebrow="TEACHER / CONTESTS" title="مسابقات برنامه‌نویسی" subtitle="مسابقه مستقل از کلاس است؛ سؤال‌ها را از بانک مشترک بردار و دانش‌آموزان هر کلاس یا بدون کلاس را دعوت کن." actions={<Button icon={Plus} onClick={()=>setShowCreate(true)} disabled={!questions.length||!students.length}>ساخت مسابقه</Button>}/>
    <div className="notice-bar notice-purple"><Swords size={18}/><div><b>مسابقه برای دانش‌آموز است، نه برای یک کلاس</b><span>هر معلم می‌تواند از میان تمام حساب‌های فعال دانش‌آموزی انتخاب کند. عضویت در کلاس، متعلق‌بودن به کلاس معلم یا حتی داشتن کلاس برای شرکت در مسابقه لازم نیست.</span></div></div>
    {loading?<PageLoading/>:contests.length?<div className="panel settings-panel"><div className="panel-heading"><div className="settings-icon"><Swords size={18}/></div><div><h2>مسابقات ساخته‌شده</h2><p>فهرست مسابقات و آمار دعوت‌شدگان</p></div><span className="toolbar-count">{faNumber(contests.length)} مسابقه</span></div><div className="contest-list">{contests.map(contest=>{const liveStatus=contestStatusAt(contest,now);return <div className="contest-row" key={contest.id}><div className="contest-row-icon"><Swords size={18}/></div><div className="contest-row-main"><b>{contest.title}</b><span>{formatDate(contest.startAt)} تا {formatDate(contest.endAt)}</span><small>{faNumber(contest.problemCount)} سؤال از بانک · {faNumber(contest.participantCount)} دعوت‌شده</small><strong className="contest-live-countdown">{contestCountdownLabel(contest,now)}</strong></div><StatusBadge value={liveStatus==='active'?'success':liveStatus==='scheduled'?'warning':'muted'}>{statusLabel[liveStatus]}</StatusBadge><div className="contest-row-actions"><button className="table-action" title="جزئیات و جدول رتبه‌بندی" onClick={()=>openBoard(contest)}><Medal size={16}/></button>{liveStatus!=='active'&&<button className="table-action action-danger" title="حذف مسابقه" onClick={()=>remove(contest)}><Trash2 size={16}/></button>}</div></div>})}</div></div>:<EmptyState icon={Swords} title="هنوز مسابقه‌ای نساخته‌ای" text="اولین مسابقه را با انتخاب سؤال‌های بانک مشترک و دعوت دانش‌آموزان از سراسر سامانه ایجاد کن." action={<Button icon={Plus} onClick={()=>setShowCreate(true)} disabled={!questions.length||!students.length}>ساخت اولین مسابقه</Button>}/>}
    {showCreate&&<Modal title="ساخت مسابقهٔ جدید" subtitle="سؤال‌های بانک هنگام ساخت مسابقه به‌صورت نسخهٔ مستقل ذخیره می‌شوند؛ تغییرات بعدی بانک روی مسابقه اثر نمی‌گذارد." onClose={()=>{setShowCreate(false);resetForm();}} wide>
      <form className="form-grid" onSubmit={create}>
        <Field label="عنوان مسابقه"><input className="input" value={form.title} onChange={event=>setForm({...form,title:event.target.value})} required maxLength={120} placeholder="مثلاً مسابقهٔ برنامه‌نویسی پاییز"/></Field>
        <Field label="جریمهٔ هر ارسال اشتباه (دقیقه)"><input className="input" type="number" min="0" max="120" value={form.penaltyMinutes} onChange={event=>setForm({...form,penaltyMinutes:event.target.value})}/><small className="field-hint">فقط به‌ازای هر ارسال اشتباه معتبر محاسبه می‌شود؛ زمان حل سؤال و ارسال‌های باطل‌شده با تشخیص AI جریمه ندارند.</small></Field>
        <Field label="فریز خودکار جدول (دقیقهٔ پایانی)"><input className="input" type="number" min="0" max="180" value={form.freezeMinutes} onChange={event=>setForm({...form,freezeMinutes:event.target.value})}/><small className="field-hint">صفر یعنی بدون فریز خودکار.</small></Field>
        <Field label="تاریخ شروع (شمسی)"><JalaliDateField value={form.startJalaliDate} onChange={value=>setForm({...form,startJalaliDate:value})} ariaLabel="تاریخ شروع مسابقه به شمسی" required/></Field>
        <Field label="ساعت شروع (تهران)"><input className="input" type="time" lang="en" value={form.startTime} onChange={event=>setForm({...form,startTime:event.target.value})} required/></Field>
        <Field label="تاریخ پایان (شمسی)"><JalaliDateField value={form.endJalaliDate} onChange={value=>setForm({...form,endJalaliDate:value})} ariaLabel="تاریخ پایان مسابقه به شمسی" required/></Field>
        <Field label="ساعت پایان (تهران)"><input className="input" type="time" lang="en" value={form.endTime} onChange={event=>setForm({...form,endTime:event.target.value})} required/></Field>
        <Field label="توضیحات" className="form-full"><textarea className="input textarea" rows="2" value={form.description} onChange={event=>setForm({...form,description:event.target.value})} maxLength={2000}/></Field>
        <div className="contest-problem-picker form-full"><div className="contest-problem-picker-head"><b>انتخاب سؤال از بانک مشترک</b><span>{faNumber(form.bankQuestionIds.length)} انتخاب‌شده</span></div><div className="search-field"><Search size={15}/><input value={questionQuery} onChange={event=>setQuestionQuery(event.target.value)} placeholder="جست‌وجوی سؤال یا نویسنده…"/></div>{filteredQuestions.length?filteredQuestions.map(question=><label className="contest-problem-option" key={question.id}><input type="checkbox" checked={form.bankQuestionIds.includes(question.id)} onChange={()=>toggleQuestion(question.id)}/><span><b>{question.title}</b><small>{question.authorName} · {faNumber(question.points)} امتیاز · {faNumber(question.testCount)} تست</small></span></label>):<EmptyState title="سؤالی پیدا نشد" text="عبارت جست‌وجو را تغییر بده یا ابتدا سؤال جدیدی به بانک مشترک اضافه کن."/>}</div>
        <div className="contest-problem-picker contest-student-picker form-full"><div className="contest-problem-picker-head"><b>دعوت دانش‌آموزان از کل سامانه</b><span>{faNumber(form.studentIds.length)} از {faNumber(students.length)} انتخاب‌شده</span></div><div className="contest-student-tools"><div className="search-field"><Search size={15}/><input value={studentQuery} onChange={event=>setStudentQuery(event.target.value)} placeholder="جست‌وجوی نام، نام کاربری یا کلاس…"/></div><button type="button" className="text-link" onClick={toggleVisibleStudents}>{visibleAllSelected?'لغو انتخاب نتایج':'انتخاب همهٔ نتایج'}</button></div>{filteredStudents.length?filteredStudents.map(student=><label className="contest-problem-option contest-student-option" key={student.id}><input type="checkbox" checked={form.studentIds.includes(student.id)} onChange={()=>toggleStudent(student.id)}/><span><b>{student.displayName}</b><small dir="ltr">{student.username}</small></span><em>{student.classTitle?`کلاس ${student.classTitle}`:'بدون کلاس'}</em></label>):<EmptyState title="دانش‌آموزی پیدا نشد" text="نام یا نام کاربری را بررسی کن."/>}</div>
        <div className="modal-footer form-full"><Button type="button" variant="ghost" onClick={()=>{setShowCreate(false);resetForm();}}>انصراف</Button><Button type="submit" icon={Swords} loading={busy} disabled={!form.bankQuestionIds.length||!form.studentIds.length}>ساخت مسابقه و ارسال دعوت</Button></div>
      </form>
    </Modal>}
    {selected&&<Modal title={`جزئیات مسابقه: ${selected.contest.title}`} subtitle={`${statusLabel[contestStatusAt(selected.contest,now)]} · ${faNumber(selected.participants?.length||0)} دانش‌آموز دعوت شده‌اند`} onClose={()=>setSelected(null)} wide>
      <div className="contest-detail-summary"><span>{faNumber(selected.problems.length)} سؤال</span><span>{formatDate(selected.contest.startAt)} تا {formatDate(selected.contest.endAt)}</span><span>جریمه: {faNumber(selected.contest.penaltyMinutes)} دقیقه</span></div><div className="contest-teacher-countdown"><Timer size={17}/><b>{contestCountdownLabel(selected.contest,now)}</b><small>زمان باقی‌مانده به‌صورت زنده به‌روزرسانی می‌شود.</small></div>
      <section className="contest-management-panel"><div className="section-heading"><div><h3>مدیریت مسابقه</h3><p>جدول دانش‌آموزان: {selected.contest.studentScoreboardFrozen?'فریز شده':'زنده'} · فریز خودکار: {selected.contest.freezeMinutes?`${faNumber(selected.contest.freezeMinutes)} دقیقهٔ پایانی`:'غیرفعال'}</p></div><div className="inline-actions">{selected.contest.scoreboardFrozen?<Button size="sm" variant="secondary" onClick={()=>manageSelected({frozen:false})} disabled={contestStatusAt(selected.contest,now)!=='active'}>لغو فریز دستی</Button>:selected.contest.studentScoreboardFrozen?<StatusBadge value="warning">فریز خودکار فعال</StatusBadge>:<Button size="sm" icon={Lock} onClick={()=>manageSelected({frozen:true})} disabled={contestStatusAt(selected.contest,now)!=='active'}>فریز دستی جدول</Button>}</div></div>
        {contestStatusAt(selected.contest,now)==='active'&&<div className="contest-extension-row"><JalaliDateTimeField value={contestEndExtension} onChange={setContestEndExtension} dateLabel="تاریخ پایان جدید (شمسی)"/><Button size="sm" variant="secondary" disabled={!contestEndExtension||!jalaliWallTimeToIso(contestEndExtension)||jalaliWallTimeToIso(contestEndExtension)<=selected.contest.endAt} onClick={()=>manageSelected({endAt:jalaliWallTimeToIso(contestEndExtension)})}>تمدید زمان پایان</Button></div>}
        {contestStatusAt(selected.contest,now)!=='ended'&&<div className="contest-extension-row"><Field label="فریز خودکار جدول (دقیقهٔ پایانی)"><input className="input" type="number" min="0" max="180" value={contestFreezeMinutes} onChange={e=>setContestFreezeMinutes(e.target.value)}/></Field><Button size="sm" variant="secondary" disabled={contestFreezeMinutes===''||!Number.isInteger(Number(contestFreezeMinutes))||Number(contestFreezeMinutes)<0||Number(contestFreezeMinutes)>180||Number(contestFreezeMinutes)*60000>=Date.parse(selected.contest.endAt)-Date.parse(selected.contest.startAt)} onClick={()=>manageSelected({freezeMinutes:Number(contestFreezeMinutes)})}>ذخیرهٔ فریز خودکار</Button></div>}
        {contestStatusAt(selected.contest,now)==='scheduled'&&<><div className="contest-extension-row"><Field label="عنوان مسابقه"><input className="input" value={selected.contest.title} onChange={e=>setSelected(old=>({...old,contest:{...old.contest,title:e.target.value}}))}/></Field><Button size="sm" variant="secondary" onClick={()=>manageSelected({title:selected.contest.title})}>ذخیره عنوان</Button></div><div className="contest-extension-row"><JalaliDateTimeField value={contestStartUpdate} onChange={setContestStartUpdate} dateLabel="تاریخ شروع (شمسی)"/><JalaliDateTimeField value={contestScheduledEndUpdate} onChange={setContestScheduledEndUpdate} dateLabel="تاریخ پایان (شمسی)"/><Button size="sm" variant="secondary" disabled={!contestStartUpdate||!contestScheduledEndUpdate||!jalaliWallTimeToIso(contestStartUpdate)||!jalaliWallTimeToIso(contestScheduledEndUpdate)||jalaliWallTimeToIso(contestStartUpdate)>=jalaliWallTimeToIso(contestScheduledEndUpdate)} onClick={()=>manageSelected({startAt:jalaliWallTimeToIso(contestStartUpdate),endAt:jalaliWallTimeToIso(contestScheduledEndUpdate)})}>ذخیره زمان‌بندی</Button></div></>}
        {contestStatusAt(selected.contest,now)==='scheduled'&&<div className="contest-extension-row"><Field label="افزودن دانش‌آموز"><AppSelect className="input" value={contestStudentToAdd} onChange={e=>setContestStudentToAdd(e.target.value)}><option value="">انتخاب دانش‌آموز…</option>{students.filter(st=>!selected.participants.some(p=>p.studentId===st.id)).map(st=><option key={st.id} value={st.id}>{st.displayName} ({st.username})</option>)}</AppSelect></Field><Button size="sm" disabled={!contestStudentToAdd} onClick={()=>manageSelected({addStudentIds:[contestStudentToAdd]})}>دعوت</Button></div>}
        {selected.contest.status==='scheduled'&&<div className="contest-participant-manage">{selected.participants.map(person=><span key={person.studentId}>{person.displayName}<button type="button" title="لغو دعوت" onClick={()=>manageSelected({removeStudentIds:[person.studentId]})}><X size={13}/></button></span>)}</div>}
      </section>
      <div className="section-heading"><div><h3>جدول رتبه‌بندی زنده</h3><p>جدول هر ۵ ثانیه با ارسال‌های جدید به‌روزرسانی می‌شود؛ تمام دعوت‌شدگان حتی بدون ارسال در جدول هستند.</p></div></div>
      {selected.leaderboard.length?<div className="table-scroll"><table className="data-table"><thead><tr><th>رتبه</th><th>دانش‌آموز</th><th>امتیاز</th><th>حل‌شده</th><th>ارسال اشتباه</th><th>جریمه زمانی</th></tr></thead><tbody>{selected.leaderboard.map(row=><tr key={row.studentId}><td><b>{row.rank}</b></td><td>{row.displayName}<small className="muted-text">{row.username}</small></td><td><b>{row.points}</b></td><td>{row.solved}</td><td>{row.wrongAttempts}</td><td>{row.penaltyMinutes} دقیقه</td></tr>)}</tbody></table></div>:<EmptyState icon={Medal} title="هنوز شرکت‌کننده‌ای دعوت نشده" text="فهرست دعوت‌شدگان این مسابقه خالی است."/>}
      <div className="section-heading section-heading-spaced"><div><h3>سؤال‌های مسابقه</h3><p>نسخه‌های ذخیره‌شده از بانک مشترک</p></div></div><div className="contest-detail-problems">{selected.problems.map((problem,index)=><div key={problem.id}><b>{faNumber(index+1)}. {problem.title}</b><small>{faNumber(problem.points)} امتیاز</small></div>)}</div><div className="section-heading section-heading-spaced"><div><h3>بررسی شباهت کدها</h3><p>ارسال‌های مسابقه را برای یافتن کدهای مشابه تحلیل کن.</p></div><Button icon={GitCompareArrows} loading={contestSimilarityBusy} onClick={scanContestSimilarity}>تحلیل شباهت</Button></div>{contestSimilarity&&<div className="similarity-results"><div className="notice-bar"><Info size={17}/><div><b>{faNumber(contestSimilarity.pairs.length)} جفت مشابه پیدا شد</b><span>{contestSimilarity.notice}</span></div></div>{contestSimilarity.pairs.map((pair,index)=><div className="similarity-pair" key={index}><b>{pair.problemTitle}</b><span>{pair.left.studentName} ↔ {pair.right.studentName}</span><strong>{faNumber(pair.similarity)}٪</strong></div>)}</div>}
    </Modal>}
  </>;
}

function StudentClassCalendar({ refreshKey, onSelectSession }) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async (initial = false) => {
      if (initial) setLoading(true);
      try { const result = await api('/student/my-class'); if (active) setData(result); }
      catch { if (active && initial) setData({ class: null, events: [], sessions: [] }); }
      finally { if (active && initial) setLoading(false); }
    };
    load(true);
    const stopPolling = scheduleVisibleInterval(() => load(false), 15000);
    return () => { active = false; stopPolling(); };
  }, [refreshKey]);
  const calendarItems = [...(data?.events || []), ...(data?.sessions || []).filter((session) => session.calendarVisible !== false).map((session) => ({ ...session, id: `coding-session-${session.id}`, sessionId: session.id, title: `جلسهٔ برنامه‌نویسی: ${session.title}`, description: session.description || 'جلسهٔ تمرین ACM', isCodingSession: true }))].sort((a, b) => `${a.jalaliDate} ${a.startTime || ''}`.localeCompare(`${b.jalaliDate} ${b.startTime || ''}`));
  return <><PageHeading eyebrow="STUDENT / MY CLASS" title="کلاس من و تقویم شمسی" subtitle="برنامه‌های کلاس و جلسه‌های ACM مربوط به همین کلاس را ببین. ورود به هر جلسه در زمان شروع آن فعال می‌شود." />{loading ? <PageLoading /> : !data?.class ? <EmptyState icon={School} title="هنوز در کلاسی عضو نشده‌ای" text="از مدیر یا معلمت بخواه تو را به یک کلاس اضافه کند." /> : <><div className="notice-bar class-notice"><School size={18} /><div><b>{data.class.title}</b><span>معلم: {data.class.teacherName} ({data.class.teacherUsername})</span></div></div><div className="student-calendar-layout"><PersianCalendar events={calendarItems} /><section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon"><CalendarDays size={18} /></div><div><h2>فهرست برنامه‌ها</h2><p>جلسه‌های این کلاس؛ دکمهٔ ورود در زمان تعیین‌شده فعال می‌شود.</p></div></div><ClassEventList events={calendarItems} onOpenSession={onSelectSession} /></section></div></>}</>;
}

function StudentContests({refreshKey,onSelect}) {
  const [contests,setContests]=useState([]);const [loading,setLoading]=useState(true);
  const load=useCallback((quiet=false)=>{if(!quiet)setLoading(true);api('/student/contests').then(r=>setContests(r.contests||[])).catch(()=>{}).finally(()=>{if(!quiet)setLoading(false);});},[]);
  useEffect(()=>{load();return scheduleVisibleInterval(()=>load(true),15000);},[load,refreshKey]);
  const labels={scheduled:'در انتظار شروع',active:'در حال برگزاری',ended:'پایان‌یافته'};
  return <><PageHeading eyebrow="STUDENT / CONTESTS" title="مسابقات برنامه‌نویسی" subtitle="مسابقه‌هایی را ببین که معلم‌ها تو را به آن‌ها دعوت کرده‌اند؛ عضویت در کلاس خاصی لازم نیست."/><div className="notice-bar"><Swords size={18}/><div><b>قوانین مسابقه</b><span>زمان باقی‌مانده هر ثانیه به‌روزرسانی می‌شود؛ در زمان مسابقه سؤال‌ها و جدول رتبه‌بندی زنده در دسترس هستند.</span></div></div>{loading?<PageLoading/>:contests.length?<div className="session-card-grid contest-card-grid">{contests.map(contest=><button className="session-card contest-session-card" key={contest.id} onClick={()=>onSelect(contest.id)}><div className="session-card-header"><div className="session-symbol"><Swords size={20}/></div><StatusBadge value={contest.status==='active'?'success':contest.status==='scheduled'?'warning':'muted'}>{labels[contest.status]}</StatusBadge></div><h3>{contest.title}</h3><p>{contest.description||'به این مسابقه دعوت شده‌ای.'}</p><div className="session-card-meta"><span><UserRound size={14}/>{contest.teacherName||'معلم برگزارکننده'}</span><span><ListChecks size={14}/>{faNumber(contest.problemCount)} سؤال</span></div><div className="session-card-footer"><span>{contest.status==='active'?'ورود به مسابقه':contest.status==='ended'?'مشاهدهٔ نتیجه':'مشاهدهٔ زمان مسابقه'}</span><ArrowLeft size={17}/></div></button>)}</div>:<EmptyState icon={Swords} title="هنوز مسابقه‌ای برنامه‌ریزی نشده" text="وقتی معلمی تو را به مسابقه‌ای دعوت کند، آن مسابقه در اینجا نمایش داده می‌شود."/>}</>;
}

function StudentContestDetail({contestId,refreshKey,onBack,onOpenProblem}) {
  const [data,setData]=useState(null);const [loading,setLoading]=useState(true);const [now,setNow]=useState(Date.now());
  const load=useCallback((initial=false)=>{if(initial)setLoading(true);api(`/student/contests/${contestId}`).then(setData).catch(()=>setData(null)).finally(()=>{if(initial)setLoading(false);});},[contestId]);
  useEffect(()=>{load(true);return scheduleVisibleInterval(()=>load(false),5000);},[load,refreshKey]);
  useEffect(()=>scheduleVisibleInterval(()=>setNow(Date.now()),1000),[]);
  if(loading)return <PageLoading/>;if(!data)return <EmptyState icon={Swords} title="مسابقه در دسترس نیست" text="ممکن است دعوت‌نامهٔ مسابقه حذف شده باشد." action={<Button onClick={onBack}>بازگشت</Button>}/>;
  const c=data.contest;const liveStatus=contestStatusAt(c,now);const countdown=contestCountdownLabel(c,now);
  return <><button className="back-link" onClick={onBack}><ArrowUpRight size={16}/> بازگشت به مسابقات</button><PageHeading eyebrow="ACM / CONTEST" title={c.title} subtitle={`${c.teacherName||'معلم برگزارکننده'} · ${c.description||'مسابقهٔ برنامه‌نویسی'}`}/><div className="contest-countdown-panel"><div><span>شمارش معکوس مسابقه</span><strong>{countdown}</strong></div><StatusBadge value={liveStatus==='active'?'success':liveStatus==='scheduled'?'warning':'muted'}>{liveStatus==='active'?'در حال برگزاری':liveStatus==='scheduled'?'در انتظار شروع':'پایان‌یافته'}</StatusBadge></div>{liveStatus==='scheduled'&&<div className="notice-bar"><Timer size={18}/><div><b>مسابقه هنوز شروع نشده است</b><span>به محض رسیدن زمان شروع، صفحه به‌صورت خودکار به‌روزرسانی و سؤال‌ها فعال می‌شوند.</span></div></div>}{liveStatus==='active'&&<><div className="section-heading"><div><h2>سؤال‌های مسابقه</h2><p>{faNumber(data.problems.length)} سؤال برای حل‌کردن</p></div></div><div className="student-problem-list">{data.problems.map((p,index)=><button className="student-problem-card" key={p.id} onClick={()=>onOpenProblem(p.id)}><span className="student-problem-index">{faNumber(index+1).padStart(2,'0')}</span><div className="student-problem-main"><h3>{p.title}</h3><p>{p.statement.slice(0,120)}{p.statement.length>120?'…':''}</p><span className="problem-meta"><span><Trophy size={14}/>{faNumber(p.points)} امتیاز</span><span><Timer size={14}/>{faNumber(p.timeLimitMs)} ms</span></span></div><span className="solve-link">ورود به سؤال <ArrowLeft size={16}/></span></button>)}</div></>}{liveStatus!=='scheduled'&&<section className="panel contest-leaderboard"><div className="panel-heading contest-leaderboard-heading"><div className="settings-icon"><Medal size={18}/></div><div><h2>{liveStatus==='active'?'جدول رتبه‌بندی زنده':'جدول رتبه‌بندی نهایی'}</h2><p>{liveStatus==='active'?'جایگاه شرکت‌کنندگان با ارسال پاسخ‌ها به‌روزرسانی می‌شود.':'امتیاز بیشتر و جریمهٔ زمانی کمتر رتبهٔ بهتر می‌سازد.'}</p></div></div>{data.leaderboard.length?<div className="table-scroll"><table className="data-table"><thead><tr><th>رتبه</th><th>دانش‌آموز</th><th>امتیاز</th><th>مسائل حل‌شده</th><th>جریمه زمانی</th></tr></thead><tbody>{data.leaderboard.map(row=><tr key={row.studentId}><td><b>{row.rank}</b></td><td><b>{row.displayName}</b><small className="muted-text">{row.username}</small></td><td><b>{row.points}</b></td><td>{row.solved}</td><td>{row.penaltyMinutes} دقیقه</td></tr>)}</tbody></table></div>:<EmptyState title="نتیجه‌ای ثبت نشده" text="این مسابقه بدون ارسال پایان یافته است."/>}</section>}</>;
}

function AdminLeaderboard({ refreshKey }) {
  const [rows,setRows]=useState([]);const [loading,setLoading]=useState(true);const [query,setQuery]=useState('');const [classFilter,setClassFilter]=useState('all');
  const load=useCallback((quiet=false)=>{if(!quiet)setLoading(true);api('/admin/leaderboard').then(result=>setRows(result.leaderboard||[])).catch(()=>{}).finally(()=>{if(!quiet)setLoading(false);});},[]);
  useEffect(()=>{load();return scheduleVisibleInterval(()=>load(true),15000);},[load,refreshKey]);
  const classes=[...new Set(rows.map(row=>row.classTitle||'بدون کلاس'))];
  const filtered=rows.filter(row=>(classFilter==='all'||row.classTitle===classFilter)&&`${row.displayName} ${row.username} ${row.classTitle||''} ${row.teacherName||''}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeading eyebrow="ADMIN / STUDENT RANKING" title="رتبه‌بندی سراسری دانش‌آموزان" subtitle="رتبه‌بندی تمام حساب‌های دانش‌آموزی سامانه، مستقل از کلاس فعلی." actions={<Button variant="secondary" icon={RefreshCw} onClick={()=>load()}>تازه‌سازی</Button>}/><div className="notice-bar"><Medal size={18}/><div><b>رتبه‌بندی کل سامانه</b><span>امتیازهای قبلی دانش‌آموز با انتقال به کلاس دیگر حفظ می‌شود و این فهرست تمام دانش‌آموزان را در کنار هم مقایسه می‌کند.</span></div></div><section className="panel settings-panel"><div className="panel-toolbar"><div className="search-field"><Search size={17}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="جست‌وجوی نام، نام کاربری، کلاس یا معلم…"/></div><AppSelect className="select-control" value={classFilter} onChange={event=>setClassFilter(event.target.value)}><option value="all">همهٔ کلاس‌ها</option>{classes.map(item=><option key={item} value={item}>{item}</option>)}</AppSelect><span className="toolbar-count">{faNumber(filtered.length)} دانش‌آموز</span></div>{loading?<PageLoading/>:filtered.length?<div className="table-scroll"><table className="data-table"><thead><tr><th>رتبهٔ سراسری</th><th>دانش‌آموز</th><th>امتیاز کل</th><th>کلاس فعلی</th><th>معلم</th><th>وضعیت حساب</th></tr></thead><tbody>{filtered.map(row=><tr key={row.studentId}><td><b className="class-rank-number">{faNumber(row.rank)}</b></td><td><div className="stacked-cell"><b>{row.displayName}</b><code>{row.username}</code></div></td><td><b className="student-class-points"><Trophy size={13}/>{faNumber(row.points)}</b></td><td>{row.classTitle}</td><td>{row.teacherName||'—'}</td><td><StatusBadge value={row.active?'success':'muted'}>{row.active?'فعال':'غیرفعال'}</StatusBadge></td></tr>)}</tbody></table></div>:<EmptyState icon={Medal} title="دانش‌آموزی پیدا نشد" text="فیلترها را تغییر بده یا حساب دانش‌آموزی ایجاد کن."/>}</section></>;
}

function AdminPresence({ refreshKey }) {
  const [users, setUsers] = useState([]); const [loading, setLoading] = useState(true); const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all');
  const load = useCallback((quiet = false) => { if (!quiet) setLoading(true); api('/admin/presence').then((r) => setUsers(r.users)).catch(() => {}).finally(() => { if (!quiet) setLoading(false); }); }, []);
  useEffect(() => { load(); return scheduleVisibleInterval(() => load(true), 20000); }, [load, refreshKey]);
  const filtered = users.filter((u) => (filter === 'all' || (filter === 'online' ? u.online : !u.online)) && `${u.displayName} ${u.username} ${roleLabels[u.role]}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeading eyebrow="ADMIN / LIVE PRESENCE" title="وضعیت حضور کاربران" subtitle="وضعیت آنلاین بر اساس ضربان حضور مرورگر در 75 ثانیهٔ اخیر محاسبه می‌شود." actions={<Button variant="secondary" icon={RefreshCw} onClick={() => load()}>تازه‌سازی</Button>} /><div className="metrics-grid presence-metrics"><MetricCard icon={Activity} label="آنلاین" value={users.filter((u) => u.online).length} detail="در حال استفاده از سایت" tone="teal" /><MetricCard icon={Users} label="آفلاین" value={users.filter((u) => !u.online).length} detail="در حال حاضر فعال نیستند" tone="blue" /><MetricCard icon={GraduationCap} label="معلم‌ها" value={users.filter((u) => u.role === 'teacher').length} detail="حساب‌های فعال" tone="purple" /><MetricCard icon={UserRound} label="دانش‌آموزان" value={users.filter((u) => u.role === 'student').length} detail="حساب‌های فعال" tone="orange" /></div><div className="panel"><div className="panel-toolbar"><div className="search-field"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جست‌وجوی نام یا نام کاربری…" /></div><AppSelect className="select-control" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">همهٔ وضعیت‌ها</option><option value="online">فقط آنلاین</option><option value="offline">فقط آفلاین</option></AppSelect><div className="toolbar-count">{faNumber(filtered.length)} کاربر</div></div>{loading ? <PageLoading /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>کاربر</th><th>نقش</th><th>وضعیت حضور</th><th>آخرین فعالیت</th></tr></thead><tbody>{filtered.map((u) => <tr key={u.id}><td><div className="table-user"><span className={cx('role-avatar', `role-${u.role}`)}><UserRound size={17} /></span><div className="stacked-cell"><b>{u.displayName}</b><code>{u.username}</code></div></div></td><td>{roleLabels[u.role]}</td><td><OnlinePill online={u.online} /></td><td>{u.lastSeen ? formatDate(u.lastSeen) : 'هنوز فعالیتی ثبت نشده'}</td></tr>)}</tbody></table>{!filtered.length && <EmptyState icon={Users} title="کاربری پیدا نشد" text="فیلتر جست‌وجو را تغییر بده." />}</div>}</div></>;
}

function StudentSessions({ refreshKey, onSelect }) {
  const [sessions, setSessions] = useState([]); const [loading, setLoading] = useState(true);
  useEffect(() => { let a = true; setLoading(true); api('/student/sessions').then((r) => { if (a) setSessions(r.sessions); }).catch(() => {}).finally(() => { if (a) setLoading(false); }); return () => { a = false; }; }, [refreshKey]);
  return <><PageHeading eyebrow="STUDENT / ACTIVE SESSIONS" title="جلسات فعال" subtitle="جلسه‌ها و سؤال‌هایی که معلم فعال کرده است در این قسمت قرار می‌گیرند." /><div className="student-tip"><Clock3 size={19} /><span>فقط جلسه‌های فعال کلاس خودت را می‌بینی؛ جلسه‌های کلاس‌های دیگر برایت قابل دسترسی نیستند.</span></div>{loading ? <PageLoading /> : sessions.length ? <div className="session-card-grid large-grid">{sessions.map((s) => <SessionCard key={s.id} session={{ ...s, active: true }} role="student" onClick={() => onSelect(s.id)} />)}</div> : <EmptyState icon={Clock3} title="هنوز جلسه‌ای فعال نیست" text="وقتی معلم جلسهٔ بعدی را شروع کند، می‌توانی از همین صفحه سؤال‌ها را باز کنی." />}</>;
}
function StudentSession({ sessionId, refreshKey, onOpenProblem, onBack }) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  useEffect(() => { let a = true; setLoading(true); api(`/student/sessions/${sessionId}`).then((r) => { if (a) setData(r); }).catch(() => { if (a) setData(null); }).finally(() => { if (a) setLoading(false); }); return () => { a = false; }; }, [sessionId, refreshKey]);
  if (loading) return <PageLoading />;
  if (!data) return <EmptyState title="جلسه در دسترس نیست" text="ممکن است معلم این جلسه را غیرفعال کرده باشد." action={<Button variant="secondary" onClick={onBack}>بازگشت</Button>} />;
  return <><button className="back-link" onClick={onBack}><ArrowUpRight size={16} /> بازگشت به فهرست برنامه‌های کلاس</button><PageHeading eyebrow="STUDENT / SESSION" title={data.session.title} subtitle={`کلاس: ${data.session.classTitle || 'کلاس من'} · ${data.session.description || 'سؤال‌های منتشرشدهٔ این جلسه را حل کن.'}`} /><div className="section-heading"><div><h2>مسئله‌ها</h2><p>{data.problems.length} سؤال در دسترس است.</p></div><span className="small-chip"><CheckCircle2 size={15} /> آمادهٔ ارسال</span></div>{data.problems.length ? <div className="student-problem-list">{data.problems.map((p, index) => <button key={p.id} className="student-problem-card" onClick={() => onOpenProblem(p.id)}><span className="student-problem-index">{String(index + 1).padStart(2, '0')}</span><div className="student-problem-main"><h3>{p.title}</h3><p>{p.statement.slice(0, 135)}{p.statement.length > 135 ? '…' : ''}</p><span className="problem-meta"><span><Trophy size={14} /> {p.points} امتیاز</span><span><FlaskConical size={14} /> {p.samples?.length || 0} تست نمونه</span></span></div><div className="student-problem-score">{p.accepted ? <><StatusBadge value="accepted">حل شده</StatusBadge><small>{faNumber(p.bestPoints || p.points)} امتیاز کسب‌شده</small></> : p.latestAttempt?.aiFlagged ? <><StatusBadge value="warning">تشخیص هوش مصنوعی</StatusBadge><small>فرصت حل دوباره فعال است</small></> : p.latestAttempt ? <><StatusBadge value={p.latestAttempt.verdict} /><small>{p.latestAttempt.passed_cases}/{p.latestAttempt.total_cases} تست · {faNumber(p.attemptCount || 0)} تلاش</small></> : <span className="solve-link">حل مسئله <ArrowLeft size={16} /></span>}</div></button>)}</div> : <EmptyState icon={FileCode2} title="سؤالی در این جلسه منتشر نشده" text="منتظر فعال‌سازی سؤال‌ها توسط معلم باش." />}</>;
}

function StudentProblem({ problemId, contestId = null, assignmentId = null, refreshKey, notify, onBack, theme = 'light' }) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [code, setCode] = useState(''); const [submitting, setSubmitting] = useState(false); const [result, setResult] = useState(null); const [error, setError] = useState(''); const [uploadName, setUploadName] = useState(''); const [saveStatus,setSaveStatus]=useState('saved'); const hydratedRef=useRef(false); const moderationFlagSignatureRef=useRef(null); const [compareSelection,setCompareSelection]=useState([]); const [compareData,setCompareData]=useState(null); const [compareBusy,setCompareBusy]=useState(false); const [compareError,setCompareError]=useState(''); const [viewingAttemptCode,setViewingAttemptCode]=useState(null); const [attemptCodeBusy,setAttemptCodeBusy]=useState(false); const [viewingTestOutputs,setViewingTestOutputs]=useState(null); const [testOutputsBusy,setTestOutputsBusy]=useState(false); const [contestView,setContestView]=useState(null); const [contestNow,setContestNow]=useState(Date.now()); const [showContestBoard,setShowContestBoard]=useState(false);const [language,setLanguage]=useState('python');const [cppStandard,setCppStandard]=useState('17');const [cppOptimization,setCppOptimization]=useState('O2');
  const load = useCallback(() => { setLoading(true); hydratedRef.current=false; const query=contestId?`?contestId=${encodeURIComponent(contestId)}`:assignmentId?`?assignmentId=${encodeURIComponent(assignmentId)}`:''; api(`/student/problems/${problemId}${query}`).then((r) => { if (!r?.problem || typeof r.problem !== 'object') throw new Error('پاسخ سرور برای این سؤال معتبر نیست. صفحه را دوباره بارگذاری کن.'); setData(r); setCode(r.draft?.sourceCode||''); setLanguage(r.draft?.language||r.problem?.defaultLanguage||'python');setCppStandard(r.draft?.cppStandard||r.problem?.cppStandard||'17');setCppOptimization(r.draft?.cppOptimization||r.problem?.cppOptimization||'O2'); hydratedRef.current=true; setSaveStatus(r.draft?.sourceCode?'saved':'saved'); setError(''); }).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [problemId,contestId,assignmentId]);
  useEffect(load, [load, refreshKey]);
  useEffect(() => {
    if (!data) return;
    const signature = (data.attempts || []).filter((attempt) => attempt.aiFlagged).map((attempt) => attempt.id).join('|');
    if (moderationFlagSignatureRef.current !== null && moderationFlagSignatureRef.current !== signature) setResult(null);
    moderationFlagSignatureRef.current = signature;
  }, [data?.attempts]);
  useEffect(() => {
    let active = true;
    const syncModerationState = async () => {
      if (document.visibilityState !== 'visible') return;
      const query = new URLSearchParams();
      if (contestId) query.set('contestId', contestId);
      if (assignmentId) query.set('assignmentId', assignmentId);
      try {
        const status = await api(`/student/problems/${problemId}/status${query.toString() ? `?${query.toString()}` : ''}`);
        if (!active) return;
        setData((current) => {
          if (!current) return current;
          return { ...current, attempts: status.attempts, latestAttempt: status.latestAttempt, attemptCount: status.attemptCount,
            accepted: status.accepted, bestPoints: status.bestPoints, remainingAttempts: status.remainingAttempts, totalPoints: status.totalPoints };
        });
      } catch { /* status polling is best-effort; the page remains usable offline */ }
    };
    const stopPolling = scheduleVisibleInterval(syncModerationState, 5000);
    return () => { active = false; stopPolling(); };
  }, [problemId, contestId, assignmentId]);
  useEffect(()=>{
    if(!contestId)return undefined;
    let active=true;
    const refreshContest=()=>{if(document.visibilityState==='visible')api(`/student/contests/${contestId}`).then(result=>{if(active)setContestView(result);}).catch(()=>{});};
    refreshContest();
    const stopPolling=scheduleVisibleInterval(refreshContest,5000);
    const stopClock=scheduleVisibleInterval(()=>setContestNow(Date.now()),1000);
    return()=>{active=false;stopPolling();stopClock();};
  },[contestId]);
  useEffect(()=>{
    if(!hydratedRef.current||!data||data.accepted)return undefined;
    if(code===''){
      if(data.draft?.sourceCode)api(`/student/problems/${problemId}/draft`,{method:'DELETE',body:{contestId,assignmentId}}).catch(()=>{});
      setSaveStatus('saved');return undefined;
    }
    setSaveStatus('pending');
    const timer=window.setTimeout(async()=>{setSaveStatus('saving');try{await api(`/student/problems/${problemId}/draft`,{method:'PUT',body:{code,contestId,assignmentId,language,cppStandard,cppOptimization}});setSaveStatus('saved');}catch(err){setSaveStatus('error');}},850);
    return()=>window.clearTimeout(timer);
  },[code,problemId,contestId,assignmentId,language,cppStandard,cppOptimization,data?.accepted,data?.draft?.sourceCode]);
  useEffect(()=>{
    const flushDraft=()=>{
      if(!hydratedRef.current||!code||data?.accepted)return;
      try{fetch(`${API}/student/problems/${problemId}/draft`,{method:'PUT',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({code,contestId,assignmentId,language,cppStandard,cppOptimization})});}catch{}
    };
    window.addEventListener('pagehide',flushDraft);
    return()=>window.removeEventListener('pagehide',flushDraft);
  },[code,problemId,contestId,assignmentId,language,cppStandard,cppOptimization,data?.accepted]);
  const uploadFile = async (e) => { const file = e.target.files?.[0]; if (!file) return; const expectedExtension=language==='cpp'?'.cpp':'.py'; if (!file.name.toLowerCase().endsWith(expectedExtension)) { notify(`فقط فایل با پسوند ${expectedExtension} قابل بارگذاری است.`, 'error'); e.target.value = ''; return; } if (file.size > 50000) { notify('حجم فایل باید کمتر از 50 کیلوبایت باشد.', 'error'); e.target.value = ''; return; } setCode(await file.text()); setUploadName(file.name); e.target.value = ''; };
  const submit = async (e) => { e.preventDefault(); if (data?.accepted) { setError('این سؤال را با پاسخ کامل حل کرده‌ای و ارسال مجدد غیرفعال است.'); return; } if (data?.problem?.attemptLimit > 0 && data.attemptCount >= data.problem.attemptLimit) { setError('تمام تلاش‌های مجاز این سؤال مصرف شده است.'); return; } setSubmitting(true); setError(''); setResult(null); try { const r = await api(`/student/problems/${problemId}/submissions`, { method: 'POST', body: { code, contestId, assignmentId, language, cppStandard, cppOptimization } }); const sub = r.submission; setResult(sub); setData((old) => { if (!old) return old; const attempt = { id: sub.id, verdict: sub.verdict, passedCases: sub.passedCases, totalCases: sub.totalCases, pointsAwarded: sub.pointsAwarded, runtimeMs: sub.runtimeMs, createdAt: sub.createdAt, language, sourceAvailable: true }; return { ...old, attempts: [...(old.attempts || []), attempt], latestAttempt: attempt, attemptCount: sub.attemptCount, accepted: Boolean(sub.accepted), bestPoints: sub.bestPoints, totalPoints: sub.totalPoints, remainingAttempts: sub.remainingAttempts }; }); if(sub.verdict === 'accepted'){setCode('');setSaveStatus('saved');}else if(code){api(`/student/problems/${problemId}/draft`,{method:'PUT',body:{code,contestId,assignmentId,language,cppStandard,cppOptimization}}).then(()=>setSaveStatus('saved')).catch(()=>setSaveStatus('error'));} setUploadName(''); notify(sub.verdict === 'accepted' ? 'پاسخ پذیرفته شد؛ ارسال این سؤال قفل شد.' : 'کد بررسی شد. نتیجهٔ داوری آماده است.'); } catch (err) { setError(err.message); if (err.status === 409 || err.data?.acceptedAlready) load(); } finally { setSubmitting(false); } };
  const toggleCompare=(id)=>setCompareSelection(old=>old.includes(id)?old.filter(x=>x!==id):old.length<2?[...old,id]:[old[1],id]);
  const compareAttempts=async()=>{if(compareSelection.length!==2)return;setCompareBusy(true);setCompareError('');try{const query=new URLSearchParams({left:compareSelection[0],right:compareSelection[1]});if(contestId)query.set('contestId',contestId);if(assignmentId)query.set('assignmentId',assignmentId);setCompareData(await api(`/student/problems/${problemId}/compare?${query.toString()}`));}catch(e){setCompareError(e.message);}finally{setCompareBusy(false);}};
  const openAttemptCode=async(attempt)=>{setAttemptCodeBusy(true);setViewingAttemptCode(null);try{const result=await api(`/student/submissions/${attempt.id}/source`);setViewingAttemptCode({...result,language:attempt.language||'python'});}catch(error){setViewingAttemptCode({error:error.message,language:attempt.language||'python',createdAt:attempt.createdAt});}finally{setAttemptCodeBusy(false);}};
  const openAttemptOutputs=async(attempt)=>{setTestOutputsBusy(true);setViewingTestOutputs(null);try{setViewingTestOutputs(await api(`/student/submissions/${attempt.id}/results`));}catch(error){setViewingTestOutputs({available:false,tests:[],message:error.message});}finally{setTestOutputsBusy(false);}};
  if (loading) return <PageLoading />;
  if (!data) return <EmptyState icon={FileCode2} title="سؤال در دسترس نیست" text={error || 'این سؤال ممکن است توسط معلم غیرفعال شده باشد.'} action={<Button variant="secondary" onClick={onBack}>بازگشت</Button>} />;
  const p = data.problem;
  if (!p || typeof p !== 'object') return <EmptyState icon={FileCode2} title="اطلاعات سؤال کامل نیست" text="اطلاعات دریافتی از سرور ساختار معتبری ندارد. دوباره تلاش کن یا به فهرست سؤال‌ها برگرد." action={<Button variant="secondary" onClick={load}>بارگذاری دوباره</Button>} />;
  const attemptLimitReached = Number(p.attemptLimit) > 0 && data.attemptCount >= Number(p.attemptLimit);
  const liveContestStatus = contestView?.contest ? contestStatusAt(contestView.contest,contestNow) : null;
  const contestEnded = Boolean(contestId && liveContestStatus === 'ended');
  const assignmentEnded = Boolean(data.assignment && Date.now() > Date.parse(data.assignment.dueAt) && !data.assignment.allowLate);
  const submissionClosed = Boolean(data.accepted || attemptLimitReached || contestEnded || assignmentEnded);
  return <><button className="back-link" onClick={onBack}><ArrowUpRight size={16} /> بازگشت به فهرست سؤال‌ها</button><PageHeading eyebrow="ACM / PROBLEM SOLVER" title={p.title} subtitle={`راه‌حل را با ${language==='cpp'?'C++':'Python'} بنویس و برای داوری خودکار بفرست. ${p.attemptLimit > 0 ? `محدودیت تلاش: ${p.attemptLimit} · تلاش باقی‌مانده: ${data.remainingAttempts ?? Math.max(0, p.attemptLimit - data.attemptCount)}` : 'تعداد تلاش نامحدود است.'}`} actions={<span className="points-pill"><Trophy size={16} /> {p.points} امتیاز</span>} />
    {data.attempts?.some((attempt)=>attempt.aiFlagged) && <div className="notice-bar notice-ai-review"><Flag size={19}/><div><b>تشخیص استفاده از هوش مصنوعی در یکی از ارسال‌ها</b><span>معلم تشخیص داده است که کد ارسالی شما با کمک هوش مصنوعی تهیه شده است. امتیاز آن ارسال صفر شده و آن ارسال از تعداد تلاش‌های مصرف‌شده کنار گذاشته شده؛ بنابراین فرصت حل دوبارهٔ سؤال طبق محدودیت تعیین‌شده فعال است.</span></div></div>}
    {contestId&&contestView?.contest&&<><div className="contest-countdown-panel contest-countdown-compact"><div><span>شمارش معکوس مسابقه</span><strong>{contestCountdownLabel(contestView.contest,contestNow)}</strong></div><StatusBadge value={liveContestStatus==='active'?'success':'muted'}>{liveContestStatus==='active'?'در حال برگزاری':'پایان‌یافته'}</StatusBadge></div><section className="panel contest-leaderboard contest-problem-leaderboard"><button type="button" className="contest-scoreboard-toggle" onClick={()=>setShowContestBoard(value=>!value)}><span><Medal size={17}/> رتبه‌بندی زندهٔ مسابقه</span><small>{faNumber(contestView.leaderboard?.length||0)} شرکت‌کننده</small><ChevronDown size={16} className={showContestBoard?'is-expanded':''}/></button>{showContestBoard&&(contestView.leaderboard?.length?<div className="table-scroll"><table className="data-table"><thead><tr><th>رتبه</th><th>دانش‌آموز</th><th>امتیاز</th><th>حل‌شده</th><th>جریمه</th></tr></thead><tbody>{contestView.leaderboard.map(row=><tr key={row.studentId}><td><b>{faNumber(row.rank)}</b></td><td><b>{row.displayName}</b><small className="muted-text">{row.username}</small></td><td><b>{faNumber(row.points)}</b></td><td>{faNumber(row.solved)}</td><td>{faNumber(row.penaltyMinutes)} دقیقه</td></tr>)}</tbody></table></div>:<EmptyState title="هنوز ارسالی ثبت نشده" text="با ارسال پاسخ‌ها، رتبه‌بندی اینجا به‌روزرسانی می‌شود."/>)}</section></>}
    {contestEnded&&<div className="notice-bar notice-warning"><Timer size={18}/><div><b>زمان مسابقه به پایان رسیده است.</b><span>ارسال پاسخ جدید برای این مسابقه غیرفعال شده است.</span></div></div>}
    {data.assignment&&<div className={cx('notice-bar',assignmentEnded?'notice-warning':'notice-purple')}><ClipboardCheck size={18}/><div><b>تکلیف: {data.assignment.title}</b><span>مهلت تحویل: {formatDate(data.assignment.dueAt)} · {assignmentEnded?'مهلت ارسال پایان یافته است.':data.assignment.allowLate?'ارسال با جریمهٔ دیرکرد فعال است.':'ارسال تا پایان مهلت مجاز است.'}</span></div></div>}
    {(data.accepted || attemptLimitReached) && <div className={cx('notice-bar', data.accepted ? 'notice-success' : 'notice-purple')}><ShieldCheck size={18} /><div><b>{data.accepted ? 'این سؤال را با موفقیت حل کرده‌ای.' : 'محدودیت تلاش تمام شده است.'}</b><span>{data.accepted ? `امتیاز نهایی این سؤال: ${faNumber(data.bestPoints || p.points)} از ${faNumber(p.points)}؛ ارسال مجدد غیرفعال است.` : 'دیگر امکان ارسال کد برای این سؤال وجود ندارد.'}</span></div></div>}
    <div className="solver-layout"><div className="solver-left"><section className="panel problem-statement"><div className="problem-section-title"><FileText size={18} /><h2>صورت مسئله</h2></div><div className="statement-text">{p.statement}</div>{p.inputFormat && <div className="statement-block"><h3>ورودی</h3><p>{p.inputFormat}</p></div>}{p.outputFormat && <div className="statement-block"><h3>خروجی</h3><p>{p.outputFormat}</p></div>}{p.samples?.length > 0 && <div className="samples-section"><h3><FlaskConical size={17} /> مثال‌ها</h3>{p.samples.map((sample, i) => <div className="sample-block" key={i}><div><b>ورودی نمونه {i + 1}</b><pre dir="ltr">{sample.input || '(خالی)'}</pre><NewlineIndicator value={sample.input} /></div><div><b>خروجی مورد انتظار</b><pre dir="ltr">{sample.output || '(خالی)'}</pre><NewlineIndicator value={sample.output} /></div></div>)}</div>}<div className="problem-rules"><span><Clock3 size={15} /> محدودیت زمان: {p.timeLimitMs} میلی‌ثانیه برای هر تست</span><span><FlaskConical size={15} /> {p.samples?.length || 0} تست عمومی + تست‌های مخفی</span><span><Gauge size={15} /> {p.attemptLimit > 0 ? `${p.attemptLimit} تلاش مجاز` : 'تلاش نامحدود'}</span></div></section>
    </div><div className="solver-right"><form className="code-editor-panel" onSubmit={submit}><div className="code-editor-header"><div className="code-editor-title"><div className="python-icon">{language==='cpp'?'C++':'Py'}</div><div><b>ویرایشگر حرفه‌ای کد</b><small>{language==='cpp'?`C++ · استاندارد ${cppStandard}`:'Python 3'} · Monaco</small></div></div><div className="editor-header-actions"><Field label="زبان"><AppSelect className="editor-setting-select" value={language} disabled={submissionClosed||!['both','python','cpp'].includes(p.languageMode)} onChange={e=>{setLanguage(e.target.value);setUploadName('');}}><option value="python" disabled={!['python','both'].includes(p.languageMode)}>Python 3</option><option value="cpp" disabled={!['cpp','both'].includes(p.languageMode)}>C++</option></AppSelect></Field><label className={cx('upload-code-btn', submissionClosed && 'disabled') }><Upload size={15} /> بارگذاری {language==='cpp'?'.cpp':'.py'}<input type="file" accept={language==='cpp'?'.cpp,text/x-c++src':'.py,text/x-python'} onChange={uploadFile} disabled={submissionClosed} hidden /></label></div></div>{language==='cpp'&&<div className="compiler-settings"><Field label="استاندارد C++"><AppSelect className="editor-setting-select" value={cppStandard} disabled={submissionClosed} onChange={e=>setCppStandard(e.target.value)}><option value="17">C++17</option><option value="20">C++20</option></AppSelect></Field><Field label="سطح بهینه‌سازی"><AppSelect className="editor-setting-select" value={cppOptimization} disabled={submissionClosed} onChange={e=>setCppOptimization(e.target.value)}><option value="O0">بدون بهینه‌سازی (O0)</option><option value="O1">O1</option><option value="O2">O2</option><option value="O3">O3</option></AppSelect></Field><small>کامپایل و اجرای کد در محیط ایزوله انجام می‌شود.</small></div>}<div className="editor-toolbar"><span className="editor-dot" /><span className="editor-tab">{language==='cpp'?'main.cpp':'solution.py'}</span><span className="editor-lang">{language==='cpp'?'C++':'PYTHON'}</span></div><div className="monaco-student-editor" dir="ltr"><React.Suspense fallback={<div className="monaco-editor-loading" role="status">در حال آماده‌سازی ویرایشگر کد…</div>}><MonacoEditor height="430px" language={language==='cpp'?'cpp':'python'} theme={theme.startsWith('dark') ? 'vs-dark' : 'light'} value={code} onChange={value=>{setCode(value??'');setUploadName('');}} options={{automaticLayout:true,wordWrap:'on',minimap:{enabled:false},fontSize:14,lineNumbers:'on',scrollBeyondLastLine:false,tabSize:4,insertSpaces:true,formatOnPaste:true,quickSuggestions:true,suggestOnTriggerCharacters:true,bracketPairColorization:{enabled:true},padding:{top:12,bottom:12},fontFamily:'Consolas, "Courier New", monospace',readOnly:submissionClosed}} /></React.Suspense></div>{uploadName && <div className="uploaded-file"><FileCode2 size={15} />{uploadName}<button type="button" onClick={() => setUploadName('')}><X size={14} /></button></div>}<div className="editor-footer"><span><CircleDot size={13} /> کد تا 50 کیلوبایت</span><span className={cx('draft-save-status',`draft-${saveStatus}`)}>{saveStatus==='saving'?<><Cloud size={13}/> در حال ذخیره</>:saveStatus==='pending'?<><Save size={13}/> ذخیره خودکار…</>:saveStatus==='error'?<><AlertCircle size={13}/> ذخیره نشد</>:<><CheckCircle2 size={13}/> ذخیره شد</>}</span><span>UTF-8</span></div>{error && <div className="form-alert editor-alert"><AlertCircle size={16} />{error}</div>}<div className="submit-code-row"><div className="submit-note"><ShieldCheck size={15} /><span>{contestEnded ? 'زمان مسابقه به پایان رسیده است؛ ارسال پاسخ بسته است.' : assignmentEnded ? 'مهلت تحویل تکلیف پایان یافته است.' : data.accepted ? 'پاسخ پذیرفته شده است؛ ارسال مجدد بسته است.' : attemptLimitReached ? 'محدودیت تلاش مصرف شده است.' : `تلاش‌های ثبت‌شده: ${faNumber(data.attemptCount)}${p.attemptLimit > 0 ? ` از ${faNumber(p.attemptLimit)}` : ''}. امتیاز هر سؤال فقط تا سقف خودش محاسبه می‌شود.`}</span></div><Button type="submit" icon={Play} loading={submitting} disabled={submissionClosed}>{contestEnded ? 'مسابقه پایان یافته' : assignmentEnded ? 'مهلت پایان یافته' : data.accepted ? 'سؤال حل شده' : attemptLimitReached ? 'تلاش‌ها تمام شده' : 'ارسال برای داوری'}</Button></div></form>
      {result && <div className={cx('judge-result', result.verdict === 'accepted' ? 'judge-accepted' : 'judge-rejected')}><div className="judge-result-head"><div className="judge-verdict-icon">{result.verdict === 'accepted' ? <CheckCircle2 size={23} /> : <AlertCircle size={23} />}</div><div><h3>{verdicts[result.verdict]?.title || result.verdict}</h3><p>{result.verdict === 'accepted' ? 'تمام تست‌های این سؤال با موفقیت گذرانده شدند؛ تلاش بعدی غیرفعال است.' : 'بعضی از تست‌ها پاسخ مورد انتظار را نگرفتند.'}</p></div></div><div className="judge-stats"><div><span>تست‌های قبول‌شده</span><b>{result.passedCases} <small>/ {result.totalCases}</small></b></div><div><span>امتیاز این ارسال</span><b>{result.pointsAwarded} <small>/ {result.maxPoints}</small></b></div><div><span>مجموع امتیاز تو</span><b>{faNumber(result.totalPoints ?? data.totalPoints ?? 0)}</b></div></div>{result.compileError&&<pre className="compile-error-output" dir="ltr">{result.compileError}</pre>}<div className="test-results-grid">{result.cases?.map((item) => <span key={item.index} className={cx('test-result-item', item.passed ? 'passed' : 'failed')}><i>{item.passed ? <Check size={12} /> : <X size={12} />}</i>تست {item.index}</span>)}</div>{result.cases?.some((item)=>item.isPublic&&item.outputAvailable)&&<div className="judge-output-action"><button type="button" className="btn btn-secondary btn-sm" onClick={()=>setViewingTestOutputs({available:true,tests:result.cases.filter((item)=>item.isPublic&&item.outputAvailable)})}>مشاهدهٔ خروجی تست‌های عمومی</button></div>}</div>}
      <section className="panel attempt-history-panel"><div className="attempt-history-heading"><div className="attempt-history-heading-copy"><h2><History size={17} /> تاریخچهٔ تمام تلاش‌ها</h2><p>نتیجهٔ تک‌تک ارسال‌ها ثبت می‌شود؛ امتیاز کل از بهترین نتیجهٔ هر سؤال محاسبه می‌شود.</p></div><div className="attempt-history-actions"><span className="number-pill attempt-count-pill">{faNumber((data.attempts || []).length)} تلاش</span><Button size="sm" variant="secondary" icon={GitCompareArrows} disabled={compareSelection.length!==2||compareBusy} loading={compareBusy} onClick={compareAttempts}>مقایسهٔ دو تلاش</Button></div></div>{compareError&&<div className="form-alert">{compareError}</div>}{data.attempts?.length ? <div className="attempt-history-list">{data.attempts.map((attempt, index) => <div className={cx("attempt-history-row",compareSelection.includes(attempt.id)&&"is-compare-selected")} key={attempt.id}><div className="attempt-history-leading"><button type="button" title="انتخاب برای مقایسه" className="attempt-compare-toggle" onClick={()=>toggleCompare(attempt.id)}>{compareSelection.includes(attempt.id)?<CheckCircle2 size={16}/>:<GitCompareArrows size={15}/>}</button><span className="attempt-index">{faNumber(index + 1)}</span><div className="attempt-history-main"><b>تلاش {faNumber(index + 1)} {attempt.aiFlagged && <span className="attempt-ai-flagged-chip">تشخیص هوش مصنوعی</span>}</b><small>{formatDate(attempt.createdAt || attempt.created_at)} · {attempt.language==='cpp'?'C++':'Python'} · {faNumber(attempt.runtimeMs ?? attempt.runtime_ms ?? 0)} میلی‌ثانیه</small>{attempt.aiFlagged && <small className="attempt-ai-flagged-note">این ارسال با تصمیم معلم از امتیاز و سهمیهٔ تلاش‌ها خارج شده است.</small>}</div></div><div className="attempt-history-result">{attempt.aiFlagged ? <StatusBadge value="warning">باطل‌شده با تصمیم معلم</StatusBadge> : <StatusBadge value={attempt.verdict} />}<span className={cx('attempt-history-tests', attempt.passedCases === attempt.totalCases ? 'all-passed' : '')}>{faNumber(attempt.passedCases ?? attempt.passed_cases ?? 0)}/{faNumber(attempt.totalCases ?? attempt.total_cases ?? 0)} تست</span><strong>{faNumber(attempt.pointsAwarded ?? attempt.points_awarded ?? 0)} / {faNumber(p.points)}</strong><button type="button" className="attempt-source-button attempt-output-button" disabled={testOutputsBusy} onClick={()=>openAttemptOutputs(attempt)} title="مشاهدهٔ خروجی تست‌های عمومی همین ارسال"><Terminal size={14}/> خروجی تست‌ها</button><button type="button" className="attempt-source-button" disabled={attempt.sourceAvailable===false || attemptCodeBusy} onClick={()=>openAttemptCode(attempt)} title={attempt.sourceAvailable===false?'کد خام پس از ۷ روز حذف می‌شود':'مشاهدهٔ کد همین تلاش'}><FileCode2 size={14}/>{attempt.sourceAvailable===false?'کد منقضی شده':'مشاهدهٔ کد'}</button></div></div>)}</div> : <EmptyState icon={History} title="هنوز تلاشی ثبت نشده" text="با اولین ارسال، تاریخچهٔ تلاش‌ها در همین بخش نمایش داده می‌شود." />}</section>
    </div></div>{compareData&&<Modal title="مقایسهٔ کد دو تلاش" subtitle="کدهای خام فقط تا 7 روز پس از ارسال در دسترس هستند." onClose={()=>setCompareData(null)} wide><div className="attempt-compare-grid"><section><div className="compare-code-head"><b>تلاش اول</b><StatusBadge value={compareData.left.verdict}/><span>{formatDate(compareData.left.createdAt)}</span></div><pre className="source-code-view" dir="ltr">{compareData.left.sourceCode}</pre></section><section><div className="compare-code-head"><b>تلاش دوم</b><StatusBadge value={compareData.right.verdict}/><span>{formatDate(compareData.right.createdAt)}</span></div><pre className="source-code-view" dir="ltr">{compareData.right.sourceCode}</pre></section></div></Modal>}{viewingAttemptCode&&<Modal title="کد ارسالی این تلاش" subtitle={viewingAttemptCode.error?'کد خام دیگر در دسترس نیست.':`${viewingAttemptCode.language==='cpp'?'C++':'Python 3'} · ${formatDate(viewingAttemptCode.createdAt)} · قابل مشاهده تا ${formatDate(viewingAttemptCode.expiresAt)}`} onClose={()=>setViewingAttemptCode(null)} wide><div className="source-code-toolbar"><span><FileCode2 size={16}/> {viewingAttemptCode.language==='cpp'?'C++':'Python 3'} · کد ارسالی</span>{!viewingAttemptCode.error&&<button className="text-link" onClick={()=>navigator.clipboard?.writeText(viewingAttemptCode.sourceCode)}>کپی کد <Copy size={14}/></button>}</div>{viewingAttemptCode.error?<div className="notice-bar notice-warning"><AlertCircle size={18}/><span>{viewingAttemptCode.error}</span></div>:<pre className="source-code-view" dir="ltr">{viewingAttemptCode.sourceCode}</pre>}</Modal>}{viewingTestOutputs&&<PublicTestOutputsModal data={viewingTestOutputs} onClose={()=>setViewingTestOutputs(null)}/ >}{(attemptCodeBusy||testOutputsBusy)&&<div className="floating-loading"><span className="spinner"/>{testOutputsBusy?'در حال دریافت خروجی تست‌ها…':'در حال دریافت کد تلاش…'}</div>}</>;
}

function TeacherAssignments({ refreshKey, notify }) {
  const [assignments,setAssignments]=useState([]);const [classes,setClasses]=useState([]);const [students,setStudents]=useState([]);const [questions,setQuestions]=useState([]);
  const [loading,setLoading]=useState(true);const [creating,setCreating]=useState(false);const [busy,setBusy]=useState(false);const [selected,setSelected]=useState(null);const [similarity,setSimilarity]=useState(null);const [similarityBusy,setSimilarityBusy]=useState(false);
  const [questionQuery,setQuestionQuery]=useState('');const [studentQuery,setStudentQuery]=useState('');
  const [form,setForm]=useState({title:'',description:'',startAt:'',dueAt:'',allowLate:false,latePenaltyPercent:10,classIds:[],studentIds:[],bankQuestionIds:[]});
  const load=useCallback(async(quiet=false)=>{if(!quiet)setLoading(true);try{const [a,c,s,q]=await Promise.all([api('/teacher/assignments'),api('/teacher/classes'),api('/teacher/contest-students'),api('/teacher/question-bank')]);setAssignments(a.assignments||[]);setClasses(c.classes||[]);setStudents(s.students||[]);setQuestions(q.questions||[]);}catch(e){if(!quiet)notify(e.message,'error');}finally{if(!quiet)setLoading(false);}},[notify]);
  useEffect(()=>{load();},[load,refreshKey]);
  const selectedQuestions=questions.filter(q=>`${q.title} ${q.statement} ${q.authorName||''}`.toLowerCase().includes(questionQuery.toLowerCase()));
  const selectedStudents=students.filter(s=>`${s.displayName} ${s.username} ${s.classTitle||''}`.toLowerCase().includes(studentQuery.toLowerCase()));
  const toggle=(key,id)=>setForm(old=>({...old,[key]:old[key].includes(id)?old[key].filter(x=>x!==id):[...old[key],id]}));
  const create=async(e)=>{e.preventDefault();setBusy(true);try{const result=await api('/teacher/assignments',{method:'POST',body:{...form,startAt:jalaliWallTimeToIso(form.startAt),dueAt:jalaliWallTimeToIso(form.dueAt),latePenaltyPercent:Number(form.latePenaltyPercent)}});notify(`تکلیف برای ${faNumber(result.assignment.participantCount)} دانش‌آموز منتشر شد.`);setCreating(false);setForm({title:'',description:'',startAt:'',dueAt:'',allowLate:false,latePenaltyPercent:10,classIds:[],studentIds:[],bankQuestionIds:[]});await load(true);}catch(e){notify(e.message,'error');}finally{setBusy(false);}};
  const openDetail=async(item)=>{try{setSelected(await api(`/teacher/assignments/${item.id}`));setSimilarity(null);}catch(e){notify(e.message,'error');}};
  const refreshDetail=async()=>{if(!selected)return;const result=await api(`/teacher/assignments/${selected.assignment.id}`);setSelected(result);await load(true);};
  const scanSimilarity=async()=>{if(!selected)return;setSimilarityBusy(true);try{setSimilarity(await api('/teacher/similarity/scan',{method:'POST',body:{type:'assignment',id:selected.assignment.id,threshold:45}}));}catch(e){notify(e.message,'error');}finally{setSimilarityBusy(false);}};
  const updateAssignment=async(payload)=>{try{await api(`/teacher/assignments/${selected.assignment.id}`,{method:'PATCH',body:payload});notify('تنظیمات تکلیف ذخیره شد.');await refreshDetail();}catch(e){notify(e.message,'error');}};
  const visibleAll=selectedStudents.length>0&&selectedStudents.every(s=>form.studentIds.includes(s.id));
  return <><PageHeading eyebrow="TEACHER / ASSIGNMENTS" title="تکالیف و تمرین‌ها" subtitle="تکلیف مستقل بساز، سؤال‌ها را از بانک مشترک انتخاب کن و وضعیت تحویل هر دانش‌آموز را پیگیری کن." actions={<Button icon={Plus} onClick={()=>setCreating(true)} disabled={!questions.length}>ساخت تکلیف</Button>}/>
    <div className="notice-bar"><ClipboardCheck size={18}/><div><b>تکلیف‌ها مستقل از جلسات و عضویت آیندهٔ کلاس هستند</b><span>فهرست دانش‌آموزان هنگام انتشار ثبت می‌شود و انتقال بعدی دانش‌آموز بین کلاس‌ها سابقهٔ تکلیف را تغییر نمی‌دهد.</span></div></div>
    {loading?<PageLoading/>:assignments.length?<div className="assignment-card-grid">{assignments.map(a=><article className="panel assignment-card" key={a.id}><div className="assignment-card-top"><span className="settings-icon"><ClipboardCheck size={18}/></span><StatusBadge value={a.status==='archived'?'muted':Date.now()>Date.parse(a.dueAt)?'warning':'success'}>{a.status==='archived'?'بایگانی‌شده':Date.now()>Date.parse(a.dueAt)?'مهلت گذشته':'فعال'}</StatusBadge></div><h3>{a.title}</h3><p>{a.description||'بدون توضیحات'}</p><div className="assignment-card-meta"><span><Users size={14}/>{faNumber(a.participantCount)} دانش‌آموز</span><span><FileCode2 size={14}/>{faNumber(a.problemCount)} سؤال</span><span><CheckCircle2 size={14}/>{faNumber(a.submittedCount)} تحویل‌داده</span></div><div className="assignment-card-deadline"><Clock3 size={15}/> مهلت: {formatDate(a.dueAt)}</div><Button block variant="secondary" onClick={()=>openDetail(a)}>مشاهدهٔ گزارش و مدیریت</Button></article>)}</div>:<EmptyState icon={ClipboardCheck} title="هنوز تکلیفی ایجاد نشده" text="با انتخاب کلاس، دانش‌آموزان و سؤال‌های بانک مشترک اولین تکلیف را بساز." action={<Button icon={Plus} onClick={()=>setCreating(true)} disabled={!questions.length}>ساخت تکلیف</Button>}/>}
    {creating&&<Modal title="ساخت تکلیف جدید" subtitle="سؤال‌ها به‌صورت نسخهٔ مستقل کپی می‌شوند؛ تغییر بانک سؤال روی تکلیف منتشرشده اثر ندارد." onClose={()=>setCreating(false)} wide><form className="form-grid" onSubmit={create}>
      <Field label="عنوان تکلیف"><input className="input" required maxLength={160} value={form.title} onChange={e=>setForm({...form,title:e.target.value})} placeholder="مثلاً تمرین حلقه‌ها و آرایه‌ها"/></Field>
      <Field label="جریمهٔ دیرکرد (درصد)"><input className="input" type="number" min="0" max="100" value={form.latePenaltyPercent} onChange={e=>setForm({...form,latePenaltyPercent:e.target.value})} disabled={!form.allowLate}/></Field>
      <JalaliDateTimeField value={form.startAt} onChange={value=>setForm({...form,startAt:value})} dateLabel="تاریخ شروع تکلیف (شمسی)"/>
      <JalaliDateTimeField value={form.dueAt} onChange={value=>setForm({...form,dueAt:value})} dateLabel="مهلت تحویل (شمسی)"/>
      <Field label="توضیحات" className="form-full"><textarea className="input textarea" rows="2" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></Field>
      <div className="field form-full"><label className="checkbox-line"><input type="checkbox" checked={form.allowLate} onChange={e=>setForm({...form,allowLate:e.target.checked})}/> اجازهٔ تحویل با جریمه پس از مهلت</label></div>
      <section className="assignment-picker form-full"><div className="section-heading"><div><h3>کلاس‌ها</h3><p>تمام دانش‌آموزان فعال کلاس‌های انتخابی به تکلیف اختصاص داده می‌شوند.</p></div><span>{faNumber(form.classIds.length)} انتخاب</span></div>{classes.length?classes.map(c=><label className="assignment-option" key={c.id}><input type="checkbox" checked={form.classIds.includes(c.id)} onChange={()=>toggle('classIds',c.id)}/><span>{c.title}</span></label>):<small>هنوز کلاسی نساخته‌ای.</small>}</section>
      <section className="assignment-picker form-full"><div className="section-heading"><div><h3>دانش‌آموزان خاص (اختیاری)</h3><p>می‌توانی افرادی خارج از کلاس‌های انتخابی را نیز اضافه کنی.</p></div><span>{faNumber(form.studentIds.length)} انتخاب</span></div><div className="assignment-picker-tools"><div className="search-field"><Search size={15}/><input value={studentQuery} onChange={e=>setStudentQuery(e.target.value)} placeholder="جست‌وجوی نام یا نام کاربری…"/></div><button type="button" className="text-link" onClick={()=>setForm(old=>({...old,studentIds:visibleAll?old.studentIds.filter(id=>!selectedStudents.some(s=>s.id===id)):[...new Set([...old.studentIds,...selectedStudents.map(s=>s.id)])]}))}>{visibleAll?'لغو انتخاب نتایج':'انتخاب همهٔ نتایج'}</button></div><div className="assignment-option-list">{selectedStudents.slice(0,200).map(student=><label className="assignment-option" key={student.id}><input type="checkbox" checked={form.studentIds.includes(student.id)} onChange={()=>toggle('studentIds',student.id)}/><span>{student.displayName}</span><small>{student.classTitle||'بدون کلاس'}</small></label>)}</div></section>
      <section className="assignment-picker form-full"><div className="section-heading"><div><h3>سؤال‌های بانک مشترک</h3><p>حداقل یک سؤال انتخاب کن؛ هر سؤال با تست‌ها و تنظیمات زبان خودش snapshot می‌شود.</p></div><span>{faNumber(form.bankQuestionIds.length)} انتخاب</span></div><div className="search-field"><Search size={15}/><input value={questionQuery} onChange={e=>setQuestionQuery(e.target.value)} placeholder="جست‌وجوی سؤال…"/></div><div className="assignment-option-list">{selectedQuestions.slice(0,250).map(q=><label className="assignment-option" key={q.id}><input type="checkbox" checked={form.bankQuestionIds.includes(q.id)} onChange={()=>toggle('bankQuestionIds',q.id)}/><span>{q.title}</span><small>{q.languageMode==='both'?'Python + C++':q.languageMode==='cpp'?'C++':'Python'} · {faNumber(q.points)} امتیاز</small></label>)}</div></section>
      <div className="modal-footer form-full"><Button type="button" variant="ghost" onClick={()=>setCreating(false)}>انصراف</Button><Button type="submit" icon={Check} loading={busy} disabled={!form.bankQuestionIds.length||(!form.classIds.length&&!form.studentIds.length)}>انتشار تکلیف</Button></div>
    </form></Modal>}
    {selected&&<Modal title={`گزارش تکلیف: ${selected.assignment.title}`} subtitle={`${faNumber(selected.participants.length)} دانش‌آموز · ${faNumber(selected.problems.length)} سؤال`} onClose={()=>setSelected(null)} wide>
      <div className="assignment-detail-stats"><MetricCard icon={Users} label="اختصاص‌یافته" value={selected.participants.length} tone="blue"/><MetricCard icon={CheckCircle2} label="تحویل‌داده" value={selected.participants.filter(p=>p.status==='submitted'||p.status==='late').length} tone="teal"/><MetricCard icon={Clock3} label="دیرکرد" value={selected.participants.filter(p=>p.hasLateSubmission).length} tone="orange"/><MetricCard icon={FileCode2} label="سؤال‌ها" value={selected.problems.length} tone="purple"/></div>
      <div className="section-heading section-heading-spaced"><div><h3>وضعیت تحویل دانش‌آموزان</h3><p>گزارش براساس شرکت‌کنندگان ثابت همین تکلیف محاسبه می‌شود.</p></div><Button size="sm" variant="secondary" icon={RefreshCw} onClick={refreshDetail}>تازه‌سازی</Button></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>دانش‌آموز</th><th>کلاس هنگام تخصیص</th><th>تلاش‌ها</th><th>پیشرفت سؤال‌ها</th><th>بهترین امتیاز</th><th>آخرین ارسال</th><th>وضعیت</th></tr></thead><tbody>{selected.participants.map(p=><tr key={p.studentId}><td><div className="stacked-cell"><b>{p.displayName}</b><code>{p.username}</code></div></td><td>{p.sourceClassTitle||'اختصاص مستقیم'}</td><td>{faNumber(p.attemptCount)}</td><td>{faNumber(p.attemptedProblemCount)} / {faNumber(p.problemCount)}</td><td>{faNumber(p.bestPoints)}</td><td>{p.lastSubmissionAt?formatDate(p.lastSubmissionAt):'—'}</td><td><StatusBadge value={p.status==='submitted'?'success':p.status==='late'?'warning':p.status==='overdue'?'danger':'muted'}>{({submitted:'تحویل‌شده',late:'تحویل با تأخیر',overdue:'تحویل‌نشده',pending:'در انتظار شروع',in_progress:'در حال انجام'})[p.status]||p.status}</StatusBadge></td></tr>)}</tbody></table></div>
      <div className="section-heading section-heading-spaced"><div><h3>مدیریت مهلت</h3><p>می‌توان مهلت را تمدید و ارسال دیرهنگام را فعال یا غیرفعال کرد.</p></div></div>
      <AssignmentEditPanel assignment={selected.assignment} onSave={updateAssignment}/>
      <div className="section-heading section-heading-spaced"><div><h3>تشخیص شباهت کد</h3><p>اثر انگشت کد ارسال‌ها بررسی می‌شود؛ شباهت بالا فقط برای بررسی انسانی است.</p></div><Button icon={GitCompareArrows} loading={similarityBusy} onClick={scanSimilarity}>تحلیل شباهت‌ها</Button></div>
      {similarity&&<div className="similarity-results"><div className="notice-bar"><Info size={17}/><div><b>{faNumber(similarity.comparedSubmissions)} ارسال بررسی شد · {faNumber(similarity.pairs.length)} جفت مشابه پیدا شد</b><span>{similarity.notice}</span></div></div>{similarity.pairs.length?<div className="table-scroll"><table className="data-table"><thead><tr><th>سؤال</th><th>دانش‌آموز اول</th><th>دانش‌آموز دوم</th><th>شباهت</th><th>زبان</th></tr></thead><tbody>{similarity.pairs.map((pair,index)=><tr key={index}><td>{pair.problemTitle}</td><td>{pair.left.studentName}</td><td>{pair.right.studentName}</td><td><b>{faNumber(pair.similarity)}٪</b></td><td>{pair.language==='cpp'?'C++':'Python'}</td></tr>)}</tbody></table></div>:<EmptyState icon={ShieldCheck} title="جفت مشابهی بالاتر از آستانه پیدا نشد" text="این نتیجه به معنی تضمین نبود کپی‌برداری نیست."/>}</div>}
    </Modal>}
  </>;
}
function AssignmentEditPanel({assignment,onSave}){
  const [dueAt,setDueAt]=useState(isoToJalaliWallTime(assignment.dueAt));const [allowLate,setAllowLate]=useState(assignment.allowLate);const [penalty,setPenalty]=useState(assignment.latePenaltyPercent);const [busy,setBusy]=useState(false);
  return <form className="assignment-edit-panel" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await onSave({dueAt:jalaliWallTimeToIso(dueAt),allowLate,latePenaltyPercent:Number(penalty)});}finally{setBusy(false);}}}><JalaliDateTimeField value={dueAt} onChange={setDueAt} dateLabel="مهلت جدید (شمسی)"/><Field label="جریمهٔ دیرکرد"><input className="input" type="number" min="0" max="100" value={penalty} onChange={e=>setPenalty(e.target.value)} disabled={!allowLate}/></Field><label className="checkbox-line"><input type="checkbox" checked={allowLate} onChange={e=>setAllowLate(e.target.checked)}/> پذیرش ارسال پس از مهلت</label><Button type="submit" size="sm" loading={busy}>ذخیرهٔ مهلت</Button></form>;
}
function StudentAssignments({refreshKey,onSelect}){
  const [assignments,setAssignments]=useState([]);const [loading,setLoading]=useState(true);
  const load=useCallback(()=>{setLoading(true);api('/student/assignments').then(r=>setAssignments(r.assignments||[])).catch(()=>setAssignments([])).finally(()=>setLoading(false));},[]);
  useEffect(()=>{load();return scheduleVisibleInterval(load,30000);},[load,refreshKey]);
  return <><PageHeading eyebrow="STUDENT / HOMEWORK" title="تکالیف من" subtitle="تکالیف اختصاص‌یافته، مهلت تحویل و وضعیت پیشرفت خودت را پیگیری کن." actions={<Button variant="secondary" icon={RefreshCw} onClick={load}>تازه‌سازی</Button>}/>{loading?<PageLoading/>:assignments.length?<div className="assignment-card-grid">{assignments.map(a=><article className="panel assignment-card" key={a.id}><div className="assignment-card-top"><span className="settings-icon"><ClipboardCheck size={18}/></span><StatusBadge value={a.status==='open'?'success':a.status==='late_allowed'?'warning':a.status==='scheduled'?'info':'muted'}>{({open:'در حال انجام',late_allowed:'دیرکرد مجاز',scheduled:'زمان‌بندی‌شده',ended:'پایان‌یافته'})[a.status]}</StatusBadge></div><h3>{a.title}</h3><p>{a.description||'توضیحی ثبت نشده است.'}</p><div className="assignment-card-meta"><span><GraduationCap size={14}/>{a.teacherName}</span><span><FileCode2 size={14}/>{faNumber(a.problemCount)} سؤال</span><span><Code2 size={14}/>{faNumber(a.attemptedProblems||0)} از {faNumber(a.problemCount)} سؤال</span><span>{faNumber(a.attempts)} تلاش</span></div><div className="assignment-card-deadline"><Clock3 size={15}/> مهلت: {formatDate(a.dueAt)}</div><div className="assignment-card-deadline">امتیاز کسب‌شده: <b>{faNumber(a.points)}</b></div><Button block variant="secondary" onClick={()=>onSelect(a.id)}>مشاهدهٔ تکلیف</Button></article>)}</div>:<EmptyState icon={ClipboardCheck} title="تکلیفی برایت ثبت نشده" text="وقتی معلم تکلیفی به تو اختصاص دهد، اینجا نمایش داده می‌شود."/>}</>;
}
function StudentAssignmentDetail({assignmentId,refreshKey,onBack,onOpenProblem}){
  const [data,setData]=useState(null);const [loading,setLoading]=useState(true);const load=useCallback(()=>{setLoading(true);api(`/student/assignments/${assignmentId}`).then(setData).catch(()=>setData(null)).finally(()=>setLoading(false));},[assignmentId]);useEffect(()=>{load();},[load,refreshKey]);
  if(loading)return <PageLoading/>;if(!data)return <EmptyState icon={ClipboardCheck} title="تکلیف در دسترس نیست" text="ممکن است تکلیف هنوز شروع نشده یا دیگر منتشر نباشد." action={<Button variant="secondary" onClick={onBack}>بازگشت</Button>}/>;
  const a=data.assignment;const attempted=data.problems.filter(p=>p.attemptCount>0).length;
  return <><button className="back-link" onClick={onBack}><ArrowUpRight size={16}/> بازگشت به تکالیف</button><PageHeading eyebrow="STUDENT / ASSIGNMENT" title={a.title} subtitle={`معلم: ${a.teacherName} · مهلت: ${formatDate(a.dueAt)}`}/><div className="notice-bar"><ClipboardCheck size={18}/><div><b>{faNumber(attempted)} از {faNumber(data.problems.length)} سؤال دارای تلاش است</b><span>{a.allowLate?`تحویل دیرهنگام با ${faNumber(a.latePenaltyPercent)}٪ جریمه مجاز است.`:'ارسال پس از مهلت مجاز نیست.'}</span></div></div><div className="student-problem-list">{data.problems.map((p,index)=><button className="student-problem-card" key={p.id} onClick={()=>onOpenProblem(p.id)}><span className="student-problem-index">{faNumber(index+1)}</span><div className="student-problem-main"><h3>{p.title}</h3><p>{p.statement.slice(0,150)}{p.statement.length>150?'…':''}</p><span className="problem-meta"><span><Trophy size={14}/>{faNumber(p.points)} امتیاز</span><span><Code2 size={14}/>{p.languageMode==='both'?'Python و C++':p.languageMode==='cpp'?'C++':'Python'}</span></span></div><div className="student-problem-score">{p.accepted?<StatusBadge value="accepted">حل کامل</StatusBadge>:p.attemptCount?<StatusBadge value="warning">{faNumber(p.attemptCount)} تلاش</StatusBadge>:<span className="solve-link">شروع حل <ArrowLeft size={16}/></span>}<small>بهترین امتیاز: {faNumber(p.bestPoints||0)}</small></div></button>)}</div></>;
}
function TeacherReports({refreshKey,notify}){
  const [classes,setClasses]=useState([]);const [students,setStudents]=useState([]);const [selectedClasses,setSelectedClasses]=useState([]);const [studentId,setStudentId]=useState('');const [comparison,setComparison]=useState(null);const [individual,setIndividual]=useState(null);const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{setLoading(true);try{const [c,s]=await Promise.all([api('/teacher/reports/classes'),api('/teacher/reports/students')]);setClasses(c.classes||[]);setStudents(s.students||[]);}catch(e){notify(e.message,'error');}finally{setLoading(false);}},[notify]);useEffect(()=>{load();},[load,refreshKey]);
  const toggleClass=id=>setSelectedClasses(old=>old.includes(id)?old.filter(x=>x!==id):old.length<5?[...old,id]:old);
  const compare=async()=>{if(selectedClasses.length<2)return;setBusy(true);try{setComparison(await api(`/teacher/reports/compare?ids=${selectedClasses.join(',')}`));}catch(e){notify(e.message,'error');}finally{setBusy(false);}};
  const loadStudent=async(id)=>{setStudentId(id);if(!id){setIndividual(null);return;}setBusy(true);try{setIndividual(await api(`/teacher/reports/students/${id}`));}catch(e){notify(e.message,'error');setIndividual(null);}finally{setBusy(false);}};
  return <><PageHeading eyebrow="TEACHER / ANALYTICS" title="گزارش‌های تحلیلی" subtitle="عملکرد دانش‌آموزان را به‌صورت فردی بررسی و بین کلاس‌های خودت مقایسه کن." actions={<Button variant="secondary" icon={RefreshCw} onClick={load}>تازه‌سازی</Button>}/>{loading?<PageLoading/>:<>
    <section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon"><BarChart3 size={18}/></div><div><h2>مقایسهٔ کلاس‌ها</h2><p>بین ۲ تا ۵ کلاس از کلاس‌های خودت انتخاب کن.</p></div></div><div className="report-class-picker">{classes.map(c=><label className="report-class-option" key={c.id}><input type="checkbox" checked={selectedClasses.includes(c.id)} onChange={()=>toggleClass(c.id)} disabled={!selectedClasses.includes(c.id)&&selectedClasses.length>=5}/><span>{c.title}</span><small>{faNumber(c.studentCount)} دانش‌آموز</small></label>)}</div><div className="form-actions"><Button icon={GitCompareArrows} loading={busy&&!individual} disabled={selectedClasses.length<2} onClick={compare}>مقایسهٔ کلاس‌های انتخاب‌شده</Button></div>
      {comparison&&<div className="table-scroll report-comparison-table"><table className="data-table"><thead><tr><th>کلاس</th><th>دانش‌آموز</th><th>دانش‌آموز فعال</th><th>ارسال‌ها</th><th>پذیرفته</th><th>سؤال حل‌شده</th><th>میانگین امتیاز دانش‌آموز</th></tr></thead><tbody>{comparison.classes.map(c=><tr key={c.id}><td><b>{c.title}</b></td><td>{faNumber(c.studentCount)}</td><td>{faNumber(c.activeStudents)}</td><td>{faNumber(c.submissionCount)}</td><td>{faNumber(c.acceptedCount)}</td><td>{faNumber(c.solvedProblemCount)}</td><td><b>{faNumber(c.averageStudentPoints)}</b></td></tr>)}</tbody></table></div>}
    </section>
    <section className="panel settings-panel report-individual-panel"><div className="panel-heading"><div className="settings-icon"><UserRound size={18}/></div><div><h2>گزارش عملکرد فردی</h2><p>دانش‌آموزی را از کلاس‌ها، تکالیف و مسابقه‌هایی که برگزار کرده‌ای انتخاب کن.</p></div></div><Field label="دانش‌آموز"><AppSelect className="input" value={studentId} onChange={e=>loadStudent(e.target.value)}><option value="">انتخاب دانش‌آموز…</option>{students.map(st=><option key={st.id} value={st.id}>{st.displayName} ({st.username})</option>)}</AppSelect></Field>
      {individual&&<div className="individual-report"><div className="report-metric-grid"><MetricCard icon={Trophy} label="امتیاز ارسال‌ها" value={individual.totals.points} tone="teal"/><MetricCard icon={Code2} label="تعداد ارسال" value={individual.totals.submissions} tone="blue"/><MetricCard icon={CheckCircle2} label="پذیرفته‌شده" value={individual.totals.accepted} tone="purple"/><MetricCard icon={ClipboardCheck} label="تکالیف اختصاص‌یافته" value={individual.assignments.assigned} tone="orange"/><MetricCard icon={Check} label="تکالیف دارای تحویل" value={individual.assignments.submitted} tone="teal"/><MetricCard icon={Clock3} label="تحویل دیرهنگام" value={individual.assignments.late} tone="orange"/></div>
        <div className="section-heading section-heading-spaced"><div><h3>عملکرد در کلاس‌های این معلم</h3><p>سابقهٔ دانش‌آموز حتی در صورت تغییر کلاس حفظ می‌شود.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>کلاس</th><th>ارسال‌ها</th><th>پذیرفته</th><th>امتیاز</th></tr></thead><tbody>{individual.classes.map(c=><tr key={c.classId}><td>{c.classTitle}</td><td>{faNumber(c.submissions)}</td><td>{faNumber(c.accepted)}</td><td>{faNumber(c.points)}</td></tr>)}</tbody></table></div>
        <div className="section-heading section-heading-spaced"><div><h3>آخرین ارسال‌ها</h3><p>حداکثر ۲۰۰ ارسال اخیر این دانش‌آموز در داده‌های آموزشی تو.</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>سؤال</th><th>کلاس / جلسه</th><th>زبان</th><th>نتیجه</th><th>امتیاز</th><th>تاریخ</th></tr></thead><tbody>{individual.submissions.map(a=><tr key={a.id}><td>{a.problemTitle}</td><td>{a.contestTitle?`مسابقه: ${a.contestTitle}`:a.assignmentTitle?`تکلیف: ${a.assignmentTitle}`:a.classTitle||a.sessionTitle||'تکلیف'}</td><td>{a.language==='cpp'?'C++':'Python'}</td><td><StatusBadge value={a.verdict}/></td><td>{faNumber(a.points)}</td><td>{formatDate(a.createdAt)}</td></tr>)}</tbody></table></div>
      </div>}
    </section>
  </>}</>;
}


function SubmissionsList({ mode, refreshKey, notify = () => {} }) {
  const [rows,setRows]=useState([]);const [pagination,setPagination]=useState({total:0,limit:50,offset:0,hasMore:false});const [loading,setLoading]=useState(true);const [loadingMore,setLoadingMore]=useState(false);const [query,setQuery]=useState('');const [verdictFilter,setVerdictFilter]=useState('all');const [viewingCode,setViewingCode]=useState(null);const [codeBusy,setCodeBusy]=useState(false);const [viewingTestOutputs,setViewingTestOutputs]=useState(null);const [testOutputsBusy,setTestOutputsBusy]=useState(false);  const confirmAction=useConfirm();const [reviewBusyId,setReviewBusyId]=useState(null);
  const path=mode==='admin'?'/admin/submissions':mode==='teacher'?'/teacher/submissions':'/student/submissions';
  const load=useCallback(async()=>{setLoading(true);try{const r=await api(`${path}?limit=50&offset=0`);setRows(r.submissions||[]);setPagination(r.pagination||{total:(r.submissions||[]).length,limit:50,offset:0,hasMore:false});}catch{}finally{setLoading(false);}},[path]);
  useEffect(()=>{load();},[load,refreshKey]);
  const loadMore=async()=>{if(!pagination.hasMore||loadingMore)return;setLoadingMore(true);try{const nextOffset=rows.length;const r=await api(`${path}?limit=${pagination.limit||50}&offset=${nextOffset}`);setRows(old=>[...old,...(r.submissions||[])]);setPagination(r.pagination||pagination);}catch{}finally{setLoadingMore(false);}};
  const filtered=rows.filter((r)=>(verdictFilter==='all'||r.verdict===verdictFilter)&&`${r.classTitle||''} ${r.problemTitle} ${r.sessionTitle} ${r.contestTitle||''} ${r.assignmentTitle||''} ${r.studentName||''} ${r.studentUsername||''}`.toLowerCase().includes(query.toLowerCase()));
  const title=mode==='student'?'ارسال‌های من':mode==='teacher'?'پاسخ دانش‌آموزان':'تمام ارسال‌های سامانه';
  const openSource=async(row)=>{setCodeBusy(true);try{const sourcePath=mode==='student'?`/student/submissions/${row.id}/source`:mode==='admin'?`/admin/submissions/${row.id}/source`:`/teacher/submissions/${row.id}/source`;const result=await api(sourcePath);setViewingCode(result);}catch(error){setViewingCode({error:error.message,problemTitle:row.problemTitle,studentUsername:row.studentUsername});}finally{setCodeBusy(false);}};
  const openOutputs=async(row)=>{setTestOutputsBusy(true);setViewingTestOutputs(null);try{setViewingTestOutputs(await api(`/student/submissions/${row.id}/results`));}catch(error){setViewingTestOutputs({available:false,tests:[],message:error.message});}finally{setTestOutputsBusy(false);}};
  const reviewAi=async(row)=>{const flagged=Boolean(row.aiFlagged);const approved=await confirmAction({title:flagged?'بازگردانی تصمیم بررسی کد':'تشخیص استفاده از هوش مصنوعی',message:flagged?'تصمیم قبلی دربارهٔ این ارسال لغو شود؟':'این کد به‌عنوان ارسال تهیه‌شده با هوش مصنوعی علامت‌گذاری شود؟',details:flagged?'امتیاز اصلی و وضعیت داوری قبلی بازگردانده می‌شود.':'امتیاز ارسال صفر می‌شود، از تلاش‌های مصرف‌شده کنار می‌رود و دانش‌آموز فرصت حل دوباره می‌گیرد. سابقهٔ ارسال حذف نمی‌شود و اعلان برای دانش‌آموز ارسال خواهد شد.',confirmText:flagged?'بازگرداندن تصمیم':'ثبت تشخیص',tone:flagged?'primary':'danger'});if(!approved)return;setReviewBusyId(row.id);try{const result=await api(`/teacher/submissions/${row.id}/ai-review`,{method:'PATCH',body:{decision:flagged?'restore':'flag'}});notify(result.message||'وضعیت ارسال به‌روزرسانی شد.');await load();}catch(error){notify(error.message,'error');}finally{setReviewBusyId(null);}};
  return <><PageHeading eyebrow="SUBMISSIONS / JUDGE RESULTS" title={title} subtitle={mode==='student'?'کد ارسالی خودت را تا ۷ روز پس از ارسال مشاهده کن؛ بعد از آن کد خام به‌صورت خودکار حذف می‌شود.':mode==='teacher'?'ارسال‌های جلسه‌های تو و مسابقه‌هایی که برگزار کرده‌ای؛ حتی شرکت‌کنندگان خارج از کلاس‌هایت. کد خام فقط ۷ روز نگهداری می‌شود.':'تمام ارسال‌های دانش‌آموزان در جلسه‌ها، تکالیف و مسابقات سامانه.'}/><div className="panel"><div className="panel-toolbar"><div className="search-field"><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="جست‌وجوی سؤال یا دانش‌آموز…"/></div><AppSelect className="select-control" value={verdictFilter} onChange={e=>setVerdictFilter(e.target.value)}><option value="all">تمام نتایج</option><option value="accepted">پذیرفته‌شده</option><option value="wrong_answer">پاسخ نادرست</option><option value="runtime_error">خطای اجرا</option><option value="time_limit">محدودیت زمان</option></AppSelect><div className="toolbar-count">{faNumber(filtered.length)} از {faNumber(pagination.total)} ارسال بارگذاری‌شده</div></div>{loading?<PageLoading/>:<><SubmissionTable rows={filtered} showStudent={mode!=='student'} showCode={true} showTestOutputs={mode==='student'} showAiReview={mode==='teacher'} reviewBusyId={reviewBusyId} onReviewAi={reviewAi} onViewCode={openSource} onViewTestOutputs={openOutputs}/>{pagination.hasMore&&<div className="load-more-row"><Button variant="secondary" icon={ChevronDown} loading={loadingMore} onClick={loadMore}>بارگذاری ارسال‌های بیشتر</Button></div>}</>}</div>{viewingCode&&<Modal title={viewingCode.problemTitle||'کد ارسالی دانش‌آموز'} subtitle={viewingCode.error?'کد دیگر قابل مشاهده نیست.':`${mode==='student'?'کد ارسالی خودت':'دانش‌آموز: '+viewingCode.studentUsername} · کلاس: ${viewingCode.classTitle||'—'} · جلسه: ${viewingCode.sessionTitle||'—'} · مهلت مشاهده تا ${formatDate(viewingCode.expiresAt)}`} onClose={()=>setViewingCode(null)} wide><div className="source-code-toolbar"><span><FileCode2 size={16}/> {viewingCode.language==='cpp'?'C++':'Python 3'} · کد ارسالی</span>{!viewingCode.error&&<button className="text-link" onClick={()=>navigator.clipboard?.writeText(viewingCode.sourceCode)}>کپی کد <Copy size={14}/></button>}</div>{viewingCode.error?<div className="notice-bar"><AlertCircle size={18}/><span>{viewingCode.error}</span></div>:<pre className="source-code-view" dir="ltr">{viewingCode.sourceCode}</pre>}</Modal>}{viewingTestOutputs&&<PublicTestOutputsModal data={viewingTestOutputs} onClose={()=>setViewingTestOutputs(null)}/ >}{(codeBusy||testOutputsBusy)&&<div className="floating-loading"><span className="spinner"/>{testOutputsBusy?'در حال دریافت خروجی تست‌ها…':'در حال دریافت کد…'}</div>}</>;
}

function SubmissionTable({ rows = [], showStudent = false, showCode = false, showTestOutputs = false, showAiReview = false, reviewBusyId = null, onReviewAi, onViewCode, onViewTestOutputs }) {
  if (!rows.length) return <EmptyState icon={ClipboardCheck} title="ارسالی ثبت نشده است" text="وقتی دانش‌آموزان راه‌حل خود را بفرستند، نتیجه‌ها اینجا ظاهر می‌شوند." />;
  return <div className="table-scroll"><table className="data-table submissions-table"><thead><tr>{showStudent && <th>دانش‌آموز</th>}<th>محل ارسال / سؤال</th><th>نتیجهٔ داوری</th><th>تست‌های قبول‌شده</th><th>امتیاز</th>{showCode && <th>کد ارسالی</th>}{showTestOutputs && <th>خروجی تست‌های عمومی</th>}<th>زمان ارسال</th>{showAiReview && <th>بررسی معلم</th>}</tr></thead><tbody>{rows.map((r) => <tr key={r.id}>{showStudent && <td><div className="stacked-cell"><b>{r.studentName || r.student_name}</b><code>{r.studentUsername || r.student_username}</code></div></td>}<td><div className="stacked-cell submission-context"><b>{r.contestTitle ? 'مسابقه' : r.assignmentTitle ? 'تکلیف' : (r.classTitle || r.class_title || 'کلاس نامشخص')}</b><small>{r.contestTitle || r.assignmentTitle || r.sessionTitle || r.session_title}</small><code>{r.problemTitle || r.problem_title}</code></div></td><td><StatusBadge value={r.verdict} />{r.aiFlagged && <small className="submission-ai-flagged">تشخیص هوش مصنوعی</small>}</td><td><span className={cx('passed-count', r.passedCases === r.totalCases ? 'all-passed' : '')}>{faNumber(r.passedCases)}/{faNumber(r.totalCases)}</span></td><td><b>{faNumber(r.pointsAwarded)}</b></td>{showCode && <td><div className="source-code-action"><button className="text-link" disabled={!r.sourceAvailable} onClick={() => onViewCode(r)}>{r.sourceAvailable ? 'مشاهده کد' : 'حذف شده'}</button>{r.sourceAvailable && <small>تا {formatDate(r.sourceExpiresAt)}</small>}</div></td>}{showTestOutputs && <td><button type="button" className="text-link" onClick={()=>onViewTestOutputs(r)}><Terminal size={14}/> مشاهده خروجی</button></td>}<td>{formatDate(r.createdAt || r.created_at)}</td>{showAiReview && <td><div className="ai-review-cell">{r.aiFlagged ? <span className="ai-review-state is-flagged">علامت‌گذاری‌شده</span> : <span className="ai-review-state">عادی</span>}<button type="button" className={cx('ai-review-action',r.aiFlagged&&'is-restore')} disabled={reviewBusyId===r.id} onClick={()=>onReviewAi?.(r)} title={r.aiFlagged?'بازگرداندن تصمیم':'علامت‌گذاری استفاده از هوش مصنوعی'}>{r.aiFlagged?<RefreshCw size={14}/>:<Flag size={14}/>}<span>{r.aiFlagged?'بازگردانی':'تشخیص AI'}</span></button></div></td>}</tr>)}</tbody></table></div>;
}

function AdminDataManagement({ refreshKey, notify }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ password: '', confirmation: '' });
  const confirmAction = useConfirm();
  const load = useCallback(() => {
    setLoading(true);
    api('/admin/data-summary').then((result) => setSummary(result.summary)).catch((error) => notify(error.message, 'error')).finally(() => setLoading(false));
  }, [notify]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const purge = async (event) => {
    event.preventDefault();
    if (form.confirmation !== 'حذف کامل سوابق') return notify('عبارت تأیید دقیقاً مطابق نمونه وارد نشده است.', 'error');
    const accepted = await confirmAction({
      title: 'حذف دائمی تمام سوابق آموزشی',
      message: 'تمام کلاس‌ها، جلسه‌ها، سؤال‌ها، مسابقات، تکالیف، امتیازها، ارسال‌ها و گزارش فعالیت‌ها حذف خواهند شد.',
      details: 'حساب‌های کاربران و گذرواژه‌ها باقی می‌مانند. این عملیات از طریق گذرواژهٔ مدیر نیز تأیید می‌شود و قابل بازگشت نیست.',
      confirmText: 'حذف دائمی سوابق',
      tone: 'danger',
    });
    if (!accepted) return;
    setBusy(true);
    try {
      const result = await api('/admin/data/purge', { method: 'POST', body: form });
      setSummary(result.summary);
      setForm({ password: '', confirmation: '' });
      notify(result.message || 'سوابق آموزشی حذف شد.');
    } catch (error) { notify(error.message, 'error'); }
    finally { setBusy(false); }
  };
  const metrics = summary ? [
    { label: 'کلاس‌ها', value: summary.classes, icon: School, tone: 'blue' },
    { label: 'جلسه‌ها', value: summary.sessions, icon: BookOpen, tone: 'purple' },
    { label: 'سؤال‌ها', value: summary.questions, icon: FileCode2, tone: 'teal' },
    { label: 'مسابقات', value: summary.contests, icon: Swords, tone: 'orange' },
    { label: 'تکالیف', value: summary.assignments, icon: ClipboardCheck, tone: 'blue' },
    { label: 'ارسال‌های کد', value: summary.submissions, icon: Code2, tone: 'purple' },
    { label: 'مجموع امتیازهای ثبت‌شده', value: summary.points, icon: Trophy, tone: 'teal' },
    { label: 'گزارش فعالیت‌ها', value: summary.activityEvents, icon: History, tone: 'orange' },
  ] : [];
  return <><PageHeading eyebrow="ADMIN / DATA MANAGEMENT" title="مدیریت و حذف سوابق" subtitle="آمار سوابق آموزشی را ببین و در صورت ضرورت، تمام داده‌های آموزشی را با تأیید دوبارهٔ گذرواژهٔ مدیر حذف کن." actions={<Button variant="secondary" icon={RefreshCw} onClick={load}>تازه‌سازی</Button>} />
    <div className="notice-bar notice-warning"><AlertTriangle size={19}/><div><b>عملیات برگشت‌ناپذیر</b><span>پیش از حذف، از فایل دیتابیس و پوشهٔ data در سرور نسخهٔ پشتیبان خارج از همین سامانه تهیه کن. این صفحه ابزار بازیابی نیست.</span></div></div>
    {loading ? <PageLoading/> : <div className="metrics-grid admin-data-metrics">{metrics.map((item) => <MetricCard key={item.label} icon={item.icon} label={item.label} value={faNumber(item.value)} tone={item.tone}/>)}</div>}
    <section className="panel settings-panel admin-purge-panel"><div className="panel-heading"><div className="settings-icon settings-icon-amber"><LockKeyhole size={18}/></div><div><h2>حذف کامل سوابق آموزشی</h2><p>داده‌های آموزشی تمام معلم‌ها و دانش‌آموزان پاک می‌شود؛ حساب‌های کاربری دست‌نخورده باقی می‌مانند.</p></div></div>
      <div className="admin-purge-includes"><b>مواردی که حذف می‌شوند:</b><span>کلاس‌ها و عضویت‌ها · جلسات و رویدادهای تقویم · سؤال‌ها و تست‌ها · مسابقات و دعوت‌ها · تکالیف و تحویل‌ها · امتیازها · کدهای ارسالی و پیش‌نویس‌ها · اعلان‌ها و گزارش فعالیت‌های عادی</span><small>حساب‌ها، نقش‌ها، گذرواژه‌ها و نشست‌های ورود حفظ می‌شوند. یک رکورد امنیتی مستقل از این عملیات باقی می‌ماند.</small></div>
      <form className="form-grid" onSubmit={purge}><Field label="گذرواژهٔ فعلی مدیر"><input className="input" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete="current-password" required/></Field><Field label="عبارت تأیید"><input className="input" value={form.confirmation} onChange={(event) => setForm({ ...form, confirmation: event.target.value })} placeholder="حذف کامل سوابق" autoComplete="off" required/><small className="field-hint">عبارت بالا را عیناً وارد کن.</small></Field><div className="form-actions form-full"><Button type="submit" variant="danger" icon={Trash2} loading={busy} disabled={!summary || !form.password || form.confirmation !== 'حذف کامل سوابق'}>حذف دائمی تمام سوابق</Button></div></form>
    </section>
  </>;
}

function AuditLog({ refreshKey }) {
  const [events, setEvents] = useState([]); const [loading, setLoading] = useState(true); const [query, setQuery] = useState('');
  useEffect(() => { let a = true; setLoading(true); api('/admin/audit').then((r) => { if (a) setEvents(r.events); }).catch(() => {}).finally(() => { if (a) setLoading(false); }); return () => { a = false; }; }, [refreshKey]);
  const filtered = events.filter((e) => `${e.action} ${e.targetType} ${e.targetId} ${e.details} ${e.actorUsername} ${e.actorName}`.toLowerCase().includes(query.toLowerCase()));
  const label = { login: 'ورود', logout: 'خروج', create_user: 'ساخت کاربر', update_user: 'ویرایش کاربر', deactivate_user: 'غیرفعال‌کردن کاربر', reset_password: 'بازنشانی گذرواژه', change_password: 'تغییر گذرواژه', update_profile: 'ویرایش حساب', create_session: 'ساخت جلسه', update_session: 'ویرایش جلسه', activate_session: 'فعال‌سازی جلسه', create_problem: 'ساخت سؤال', update_problem: 'ویرایش سؤال', publish_problem: 'انتشار سؤال', submit_solution: 'ارسال راه‌حل', bootstrap_admin: 'ساخت مدیر اولیه' };
  return <><PageHeading eyebrow="ADMIN / AUDIT TRAIL" title="گزارش فعالیت‌ها" subtitle="رویدادهای مدیریتی و آموزشی ثبت‌شده در سامانه." /><div className="panel"><div className="panel-toolbar"><div className="search-field"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جست‌وجوی فعالیت…" /></div><div className="toolbar-count">{filtered.length} رویداد</div></div>{loading ? <PageLoading /> : filtered.length ? <div className="audit-list">{filtered.map((e) => <div className="audit-row" key={e.id}><span className="audit-dot"><History size={15} /></span><div className="audit-main"><b>{label[e.action] || e.action}</b><span>{e.actorName || e.actorUsername || 'سامانه'} · {e.targetType} {e.targetId ? `#${e.targetId.slice(0, 8)}` : ''}</span>{e.details && <small>{e.details}</small>}</div><time>{formatDate(e.createdAt)}</time></div>)}</div> : <EmptyState icon={History} title="رویدادی پیدا نشد" text="فعالیت‌های بعدی در اینجا ثبت خواهند شد." />}</div></>;
}

function Profile({ user, onUpdate, notify }) {
  const confirmAction = useConfirm();
  const [form, setForm] = useState({ username: user.username, displayName: user.displayName }); const [busy, setBusy] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirm: '' }); const [passwordBusy, setPasswordBusy] = useState(false);
  const [baleStatus, setBaleStatus] = useState(null); const [baleCode, setBaleCode] = useState(null); const [baleBusy, setBaleBusy] = useState(false);
  const loadBaleStatus = useCallback(async () => { try { setBaleStatus(await api('/bale/status')); } catch (error) { setBaleStatus({ configured: false, error: error.message }); } }, []);
  useEffect(() => { loadBaleStatus(); }, [loadBaleStatus]);
  const saveProfile = async (e) => { e.preventDefault(); setBusy(true); try { const r = await api('/auth/profile', { method: 'PATCH', body: form }); onUpdate(r.user); notify('مشخصات حساب ذخیره شد.'); } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); } };
  const changePassword = async (e) => { e.preventDefault(); if (passwordForm.newPassword !== passwordForm.confirm) return notify('گذرواژه‌های جدید یکسان نیستند.', 'error'); setPasswordBusy(true); try { await api('/auth/change-password', { method: 'POST', body: { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword } }); setPasswordForm({ currentPassword: '', newPassword: '', confirm: '' }); notify('گذرواژه با موفقیت تغییر کرد.'); } catch (err) { notify(err.message, 'error'); } finally { setPasswordBusy(false); } };
  const createBaleCode = async () => { setBaleBusy(true); try { const result = await api('/bale/link-code', { method: 'POST', body: {} }); setBaleCode(result); notify('کد اتصال بله ساخته شد.'); } catch (error) { notify(error.message, 'error'); } finally { setBaleBusy(false); } };
  const toggleBale = async (enabled) => { setBaleBusy(true); try { await api('/bale/settings', { method: 'PATCH', body: { enabled } }); await loadBaleStatus(); notify(enabled ? 'ارسال اعلان‌ها به بله فعال شد.' : 'ارسال اعلان‌ها به بله غیرفعال شد.'); } catch (error) { notify(error.message, 'error'); } finally { setBaleBusy(false); } };
  const unlinkBale = async () => { const accepted = await confirmAction({ title: 'قطع اتصال بله', message: 'اتصال حساب بله از حساب ACM Classroom قطع شود؟', details: 'پس از قطع اتصال، اعلان‌های جدید سایت دیگر به این گفتگوی بله ارسال نمی‌شوند.', confirmText: 'قطع اتصال', tone: 'danger' }); if (!accepted) return; setBaleBusy(true); try { await api('/bale/link', { method: 'DELETE', body: {} }); setBaleCode(null); await loadBaleStatus(); notify('اتصال بله قطع شد.'); } catch (error) { notify(error.message, 'error'); } finally { setBaleBusy(false); } };
  const copyBaleText = async (value) => { try { await navigator.clipboard.writeText(value); notify('متن اتصال کپی شد.'); } catch { notify('دسترسی به کلیپ‌بورد ممکن نیست؛ متن را دستی کپی کن.', 'error'); } };
  const RoleIcon = roleIcons[user.role] || UserRound;
  return <><PageHeading eyebrow="ACCOUNT / SETTINGS" title="تنظیمات حساب" subtitle="نام کاربری، گذرواژه و راه‌های دریافت اعلان‌های حساب خودت را مدیریت کن." /><div className="profile-layout"><section className="panel profile-summary"><div className="profile-cover"><div className="profile-cover-pattern" /></div><div className="profile-main-avatar"><div className="profile-avatar-big">{initials(user.displayName)}</div></div><div className="profile-identity"><h2>{user.displayName}</h2><span className={cx('role-chip', `role-chip-${user.role}`)}><RoleIcon size={14} />{roleLabels[user.role]}</span><code>{user.username}</code></div><div className="profile-info-list"><div><span>وضعیت حساب</span><StatusBadge value="success">فعال</StatusBadge></div><div><span>نوع دسترسی</span><b>{user.role === 'admin' ? 'مدیریت کامل' : user.role === 'teacher' ? 'مدیریت جلسه و سؤال' : 'حل تمرین و ارسال کد'}</b></div></div></section><div className="profile-forms"><section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon"><UserRound size={18} /></div><div><h2>اطلاعات حساب</h2><p>نام و نام کاربری قابل تغییر هستند.</p></div></div><form className="stack-form" onSubmit={saveProfile}><Field label="نام نمایشی"><input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></Field><Field label="نام کاربری"><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} pattern="[A-Za-z0-9_.-]{3,32}" minLength={3} required /><small className="field-hint">3 تا 32 نویسه؛ فقط حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط.</small></Field><div className="form-actions"><Button type="submit" icon={Check} loading={busy}>ذخیرهٔ تغییرات</Button></div></form></section>
    <section className="panel settings-panel bale-settings-panel"><div className="panel-heading"><div className="settings-icon settings-icon-bale"><MessageCircle size={18} /></div><div><h2>اتصال به پیام‌رسان بله</h2><p>اعلان‌های سایت را در گفتگوی خصوصی بازوی ACM Classroom دریافت کن.</p></div>{baleStatus?.linked && <StatusBadge value="success">متصل</StatusBadge>}</div>
      {!baleStatus ? <div className="bale-settings-loading"><span className="spinner"/> در حال بررسی وضعیت اتصال…</div> : !baleStatus.configured ? <div className="notice-bar notice-warning"><Info size={18}/><div><b>بازوی بله هنوز پیکربندی نشده است</b><span>مدیر سرور باید توکن بازوی ساخته‌شده با @botfather را در متغیر BALE_BOT_TOKEN فایل .env قرار دهد و سرویس را دوباره اجرا کند.</span></div></div> : baleStatus.linked ? <div className="bale-linked-state"><div className="bale-link-identity"><span className="bale-link-avatar"><MessageCircle size={20}/></span><div><b>{baleStatus.chatLabel || 'حساب بله'}</b><small>{baleStatus.chatUsername ? `@${baleStatus.chatUsername}` : 'گفتگوی خصوصی متصل‌شده'} · اتصال در {baleStatus.linkedAt ? formatDate(baleStatus.linkedAt) : '—'}</small></div></div><label className="bale-notification-toggle"><input type="checkbox" checked={Boolean(baleStatus.enabled)} disabled={baleBusy} onChange={(event) => toggleBale(event.target.checked)}/><span><b>ارسال اعلان‌های سایت به بله فعال باشد</b><small>مسابقه‌ها، تکلیف‌ها، سؤال‌های جدید و اعلان‌های مرتبط با ارسال کد</small></span></label><div className="bale-connected-actions"><Button variant="secondary" size="sm" icon={Unlink} loading={baleBusy} onClick={unlinkBale}>قطع اتصال بله</Button></div></div> : <div className="bale-connect-content"><p>برای اتصال امن، کد یک‌بارمصرف بساز؛ سپس در پیام‌رسان بله بازوی ACM Classroom را پیدا کن و دستور نمایش‌داده‌شده را برایش بفرست. کد پس از ۱۰ دقیقه منقضی می‌شود و فقط یک‌بار قابل استفاده است.</p>{baleStatus.botUsername ? <div className="bale-bot-handle">نام بازو در بله: <b dir="ltr">@{baleStatus.botUsername}</b></div> : <small className="field-hint">نام بازو پس از اتصال سرویس به بله در این قسمت نمایش داده می‌شود.</small>}{baleCode ? <div className="bale-code-box"><span>این دستور را در گفتگوی خصوصی بازو ارسال کن</span><div className="bale-code-command"><code dir="ltr">{baleCode.command}</code><button type="button" className="icon-button" title="کپی دستور اتصال" onClick={() => copyBaleText(baleCode.command)}><Copy size={16}/></button></div><small>اعتبار تا {formatDate(baleCode.expiresAt)}</small></div> : null}<div className="form-actions"><Button icon={MessageCircle} loading={baleBusy} onClick={createBaleCode}>{baleCode ? 'ساخت کد تازه' : 'دریافت کد اتصال'}</Button>{baleCode && <Button variant="secondary" icon={Copy} onClick={() => copyBaleText(baleCode.code)}>کپی کد</Button>}</div></div>}
    </section>
    <section className="panel settings-panel"><div className="panel-heading"><div className="settings-icon settings-icon-amber"><KeyRound size={18} /></div><div><h2>تغییر گذرواژه</h2><p>برای امنیت بیشتر از گذرواژهٔ حداقل 12 نویسه‌ای استفاده کن.</p></div></div><form className="stack-form" onSubmit={changePassword}><Field label="گذرواژهٔ فعلی"><input className="input" type="password" value={passwordForm.currentPassword} onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })} autoComplete="current-password" required /></Field><Field label="گذرواژهٔ جدید"><input className="input" type="password" value={passwordForm.newPassword} onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} autoComplete="new-password" minLength={12} required /></Field><Field label="تکرار گذرواژهٔ جدید"><input className="input" type="password" value={passwordForm.confirm} onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })} autoComplete="new-password" minLength={12} required /></Field><div className="form-actions"><Button type="submit" icon={LockKeyhole} loading={passwordBusy}>تغییر گذرواژه</Button></div></form></section></div></div></>;
}

function PublicTestOutputsModal({ data = {}, onClose }) {
  const tests = Array.isArray(data.tests) ? data.tests : [];
  return <Modal title="خروجی تست‌های عمومی" subtitle="فقط ورودی و خروجی تست‌هایی نمایش داده می‌شود که معلم مخفی نکرده است." onClose={onClose} wide>
    {!data.available || !tests.length ? <div className="notice-bar notice-warning"><Info size={18}/><div><b>خروجی قابل نمایش نیست</b><span>{data.message || 'برای این ارسال خروجی تست عمومی ذخیره نشده است.'}</span></div></div> : <div className="public-test-output-list">{tests.map((item, position) => <article className="public-test-output-card" key={`${item.index || position + 1}-${position}`}>
      <div className="public-test-output-head"><b>تست عمومی {faNumber(item.index || position + 1)}</b><StatusBadge value={item.passed ? 'accepted' : (verdicts[item.status] ? item.status : 'wrong_answer')}>{item.passed ? 'پذیرفته‌شده' : (verdicts[item.status]?.title || 'پاسخ نادرست')}</StatusBadge></div>
      <div className="public-test-output-grid">
        <section><h4>ورودی تست</h4><pre>{typeof item.input === 'string' && item.input.length ? item.input : '∅ ورودی خالی'}</pre><NewlineIndicator value={item.input}/></section>
        <section><h4>خروجی واقعی برنامه</h4><pre>{typeof item.actualOutput === 'string' && item.actualOutput.length ? item.actualOutput : '∅ خروجی خالی'}</pre><NewlineIndicator value={item.actualOutput}/>{item.outputTruncated && <div className="public-test-output-truncated">خروجی به سقف ذخیره‌سازی رسیده و ادامهٔ آن ثبت نشده است.</div>}</section>
        <section><h4>خروجی مورد انتظار</h4><pre>{typeof item.expectedOutput === 'string' && item.expectedOutput.length ? item.expectedOutput : '∅ خروجی خالی'}</pre><NewlineIndicator value={item.expectedOutput}/></section>
      </div>
      <div className="public-test-output-meta"><span>{faNumber(item.runtimeMs || 0)} میلی‌ثانیه</span><span>·</span><span>{item.passed ? 'خروجی با پاسخ مورد انتظار مطابقت دارد.' : 'خروجی با پاسخ مورد انتظار مطابقت ندارد.'}</span></div>
    </article>)}</div>}
  </Modal>;
}
function Field({ label, hint, children, className = '' }) { return <div className={cx('field', className)}><label>{label}</label>{children}{hint && <small className="field-hint">{hint}</small>}</div>; }
function Modal({ title, subtitle, onClose, children, wide = false }) {
  useEffect(() => { const onKey = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); const prior = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prior; }; }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className={cx('modal-card', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="بستن پنجره"><X size={20} /></button></header><div className="modal-content">{children}</div></section></div>;
}
function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${faNumber(bytes)} بایت`;
  const units = ['کیلوبایت', 'مگابایت', 'گیگابایت', 'ترابایت'];
  let amount = bytes / 1024; let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${faNumber(amount.toFixed(amount >= 10 ? 0 : 1))} ${units[index]}`;
}
function AdminSystemPage({ refreshKey, notify }) {
  const [system, setSystem] = useState(null);
  const [backups, setBackups] = useState([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [health, backupList] = await Promise.all([api('/admin/system'), api('/admin/backups')]);
      setSystem(health); setBackups(backupList.backups || []); setRetentionDays(backupList.retentionDays || 30); setError('');
    } catch (requestError) { setError(requestError.message); }
    finally { if (!quiet) setLoading(false); }
  }, []);
  useEffect(() => {
    load();
    const stop = scheduleVisibleInterval(() => load(true), 15000);
    return stop;
  }, [load, refreshKey]);
  const createBackup = async (event) => {
    event.preventDefault();
    if (!password) { notify('گذرواژهٔ فعلی مدیر را وارد کن.', 'error'); return; }
    setBusy(true);
    try {
      const result = await api('/admin/backups', { method: 'POST', body: { password } });
      setPassword('');
      notify(`پشتیبان سالم ساخته شد: ${result.backup.filename}`);
      await load(true);
    } catch (requestError) { notify(requestError.message, 'error'); }
    finally { setBusy(false); }
  };
  const downloadBackup = (filename) => {
    const anchor = document.createElement('a');
    anchor.href = `/api/admin/backups/${encodeURIComponent(filename)}/download`;
    anchor.download = filename;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  };
  const memory = system?.memory || {};
  const disk = system?.disk || {};
  const judge = system?.judge || {};
  const memoryPercent = memory.systemTotalBytes ? Math.round((memory.systemTotalBytes - memory.systemFreeBytes) * 100 / memory.systemTotalBytes) : 0;
  const queuePercent = judge.maxQueue ? Math.min(100, Math.round(judge.queued * 100 / judge.maxQueue)) : 0;
  const queueDisabled = Number(judge.maxQueue) === 0;
  const queueFull = Number(judge.maxQueue) > 0 && Number(judge.queued) >= Number(judge.maxQueue);
  const outbox = system?.baleOutbox || {};
  return <>
    <PageHeading eyebrow="ADMIN / OPERATIONS" title="سلامت سامانه و پشتیبان‌گیری" subtitle="وضعیت واقعی فرایند، حافظه، دیسک، دیتابیس، داوری و صف اعلان‌ها را پایش کن." actions={<Button variant="secondary" icon={RefreshCw} onClick={() => load()}>تازه‌سازی</Button>} />
    {error && <div className="notice-bar notice-warning"><AlertCircle size={18}/><div><b>دریافت وضعیت کامل موفق نبود</b><span>{error}</span></div></div>}
    {loading && !system ? <PageLoading/> : <>
      <div className="metrics-grid system-health-metrics">
        <MetricCard icon={Activity} label="وضعیت فرایند" value={system ? 'فعال' : '—'} detail={`${faNumber(system?.runtime?.uptimeSeconds || 0)} ثانیه روشن`} tone="teal"/>
        <MetricCard icon={Gauge} label="حافظهٔ مصرفی سرور" value={`${faNumber(memoryPercent)}٪`} detail={`${formatBytes(memory.systemFreeBytes)} آزاد`} tone={memoryPercent >= 90 ? 'orange' : 'blue'}/>
        <MetricCard icon={HardDrive} label="فضای دیسک" value={disk.totalBytes ? `${faNumber(disk.usedPercent)}٪` : 'نامشخص'} detail={`${formatBytes(disk.freeBytes)} آزاد`} tone={disk.usedPercent >= 90 ? 'orange' : 'purple'}/>
        <MetricCard icon={Database} label="اندازهٔ دیتابیس" value={formatBytes(system?.database?.fileBytes)} detail={system?.runtime?.databaseEngine === 'PostgreSQL' ? `PostgreSQL ${system?.database?.serverVersion || ''}` : `WAL: ${formatBytes(system?.database?.walBytes)}`} tone="teal"/>
      </div>
      <div className="system-health-grid">
        <section className="panel system-health-panel">
          <div className="panel-heading"><div className="settings-icon"><Activity size={18}/></div><div><h2>منابع و ظرفیت</h2><p>اطلاعات هر ۱۵ ثانیه در زمان بازبودن این صفحه تازه می‌شود.</p></div></div>
          <div className="system-detail-list">
            <div><span>حافظهٔ فرایند Node.js (RSS)</span><b>{formatBytes(memory.rssBytes)}</b></div>
            <div><span>Heap مصرف‌شده</span><b>{formatBytes(memory.heapUsedBytes)} از {formatBytes(memory.heapTotalBytes)}</b></div>
            <div><span>میانگین بار سیستم (یک دقیقه)</span><b>{system?.runtime?.platform === 'win32' ? 'در دسترس نیست' : faNumber(Number(system?.runtime?.loadAverage?.[0] || 0).toFixed(2))}</b></div>
            <div><span>هسته‌های پردازنده</span><b>{faNumber(system?.runtime?.cpuCount || 0)}</b></div>
            <div><span>نسخهٔ Node.js</span><b dir="ltr">{system?.runtime?.node || '—'}</b></div>
            <div><span>سیستم‌عامل</span><b dir="ltr">{system?.runtime?.platform || '—'} / {system?.runtime?.arch || '—'}</b></div>
            <div><span>{system?.runtime?.databaseEngine === 'PostgreSQL' ? 'اتصال‌های دیتابیس' : 'تعداد صفحات دیتابیس'}</span><b>{system?.runtime?.databaseEngine === 'PostgreSQL' ? `${faNumber(system?.database?.connections || 0)} از ${faNumber(system?.database?.maxConnections || 0)}` : faNumber(system?.database?.pageCount || 0)}</b></div>
          </div>
          <div className="system-progress-block"><div className="system-progress-label"><span>مصرف حافظهٔ کل VPS</span><b>{faNumber(memoryPercent)}٪</b></div><div className="system-progress-track"><i className={memoryPercent >= 90 ? 'is-warning' : ''} style={{width:`${Math.min(100,memoryPercent)}%`}}/></div></div>
          {disk.totalBytes > 0 && <div className="system-progress-block"><div className="system-progress-label"><span>مصرف فضای دیسک</span><b>{faNumber(disk.usedPercent)}٪</b></div><div className="system-progress-track"><i className={disk.usedPercent >= 90 ? 'is-warning' : ''} style={{width:`${Math.min(100,disk.usedPercent)}%`}}/></div></div>}
        </section>
        <section className="panel system-health-panel">
          <div className="panel-heading"><div className="settings-icon settings-icon-amber"><Gauge size={18}/></div><div><h2>صف داوری و اعلان‌ها</h2><p>ازدحام سرویس‌های پس‌زمینه را بررسی کن.</p></div></div>
          <div className="system-queue-kpis"><div><b>{faNumber(judge.active || 0)} از {faNumber(judge.concurrency || 0)}</b><span>داوری فعال</span></div><div><b>{faNumber(judge.queued || 0)} از {faNumber(judge.maxQueue || 0)}</b><span>منتظر داوری</span></div></div>
          <div className="system-progress-track"><i className={queuePercent >= 85 ? 'is-warning' : ''} style={{width:`${queuePercent}%`}}/></div>
          <div className="system-detail-list system-detail-compact">
            <div><span>اعلان‌های بله در انتظار</span><b>{faNumber(outbox.pending || 0)}</b></div>
            <div><span>اعلان‌های در حال ارسال</span><b>{faNumber(outbox.processing || 0)}</b></div>
            <div><span>اعلان‌های ناموفق</span><b>{faNumber(outbox.failed || 0)}</b></div>
            <div><span>حساب‌های کاربری فعال</span><b>{faNumber(system?.counts?.users || 0)}</b></div>
            <div><span>مسابقه‌های در حال برگزاری</span><b>{faNumber(system?.counts?.contestsActive || 0)}</b></div>
          </div>
          <div className="system-service-note"><StatusBadge value={queueDisabled || queueFull ? 'warning' : 'success'}>{queueDisabled ? 'صف انتظار غیرفعال است' : queueFull ? 'صف داوری پر است' : 'صف داوری در دسترس است'}</StatusBadge><small>این وضعیت مربوط به همین نمونهٔ Node.js است. برای چند نمونهٔ هم‌زمان به صف مشترک نیاز است.</small></div>
        </section>
      </div>
      <section className="panel system-backup-panel">
        <div className="panel-heading"><div className="settings-icon settings-icon-green"><Database size={18}/></div><div><h2>پشتیبان‌گیری دیتابیس</h2><p>پشتیبان آنلاین PostgreSQL در قالب custom ساخته و با pg_restore اعتبارسنجی می‌شود؛ سایت و بات بله برای ساخت آن متوقف نمی‌شوند.</p></div></div>
        <div className="system-backup-summary"><span><b>{faNumber(backups.length)}</b><small>نسخهٔ موجود</small></span><span><b>{faNumber(retentionDays)}</b><small>روز نگهداری خودکار</small></span><span><b>{system?.backups?.latest ? formatDate(system.backups.latest.createdAt) : '—'}</b><small>آخرین نسخه</small></span></div>
        <form className="system-backup-create" onSubmit={createBackup}><Field label="گذرواژهٔ فعلی مدیر" hint="برای جلوگیری از ساخت ناخواستهٔ فایل‌های بزرگ، تأیید مجدد گذرواژه لازم است."><input className="input" type="password" autoComplete="current-password" value={password} onChange={(event)=>setPassword(event.target.value)} required maxLength={200}/></Field><Button type="submit" icon={Database} loading={busy}>ساخت و بررسی پشتیبان</Button></form>
        <div className="notice-bar notice-warning system-backup-warning"><Info size={17}/><div><b>پشتیبان روی همین VPS کافی نیست.</b><span>نسخه‌های مهم را به فضای ذخیره‌سازی جداگانه منتقل کن. این ابزار فقط دیتابیس PostgreSQL را پشتیبان می‌گیرد؛ فایل‌های `.env`، آپلودها و تصویرهای Docker در آن قرار نمی‌گیرند.</span></div></div>
        <div className="system-backup-list-heading"><h3>نسخه‌های پشتیبان</h3><span>{faNumber(backups.length)} فایل</span></div>
        {backups.length ? <div className="system-backup-list">{backups.map((backup)=><div className="system-backup-row" key={backup.filename}><span className="system-backup-icon"><Database size={17}/></span><div className="system-backup-file"><b>{formatDate(backup.createdAt)}</b><small dir="ltr">{backup.filename} · {formatBytes(backup.size)}</small></div><Button size="sm" variant="secondary" icon={Download} onClick={()=>downloadBackup(backup.filename)}>دریافت</Button></div>)}</div> : <EmptyState icon={Database} title="هنوز پشتیبانی ساخته نشده است" text="می‌توانی از دکمهٔ بالا اولین Snapshot امن دیتابیس را بسازی."/>}
      </section>
    </>}
  </>;
}

function PageLoading() { return <div className="page-loading"><span className="spinner" /><span>در حال دریافت اطلاعات…</span></div>; }

createRoot(document.getElementById('root')).render(<React.StrictMode><ConfirmProvider><App /></ConfirmProvider></React.StrictMode>);
