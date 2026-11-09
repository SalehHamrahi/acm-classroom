import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const BOOTSTRAP = String.raw`import sys, json, io, traceback, signal, time
payload = json.loads(sys.stdin.read())
sys.stdin = io.StringIO(payload.get("input", ""))
_started = time.perf_counter()
def _time_limit(_signum, _frame):
    raise TimeoutError("__ACM_TIME_LIMIT__")
signal.signal(signal.SIGALRM, _time_limit)
signal.setitimer(signal.ITIMER_REAL, max(0.1, int(payload.get("timeLimitMs", 1500)) / 1000))
_exit_code = 0
try:
    exec(compile(payload["code"], "submission.py", "exec"), {"__name__": "__main__"})
except TimeoutError:
    sys.stderr.write("__ACM_TLE__\n")
    _exit_code = 124
except BaseException:
    traceback.print_exc(file=sys.stderr)
    _exit_code = 1
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
    sys.stderr.write("\n__ACM_RUNTIME_MS__%d\n" % int((time.perf_counter() - _started) * 1000))
sys.exit(_exit_code)
`;

// The C++ runner image contains GCC and Python 3. Python is used only as a small
// bootstrap to write the source, compile it and execute isolated test processes.
const CPP_BOOTSTRAP = String.raw`import sys, json, os, subprocess, tempfile, time, signal, resource
payload = json.loads(sys.stdin.read())
source = payload.get("code", "")
standard = payload.get("cppStandard", "17")
optimization = payload.get("optimization", "O2")
if standard not in ("17", "20") or optimization not in ("O0", "O1", "O2", "O3"):
    print(json.dumps({"verdict":"judge_error","message":"تنظیمات کامپایل C++ معتبر نیست.","results":[]})); sys.exit(0)
source_path = "/tmp/main.cpp"
binary_path = "/tmp/acm_solution"
with open(source_path, "w", encoding="utf-8") as file: file.write(source)
compile_started = time.perf_counter()
try:
    compiled = subprocess.run(["g++", "-std=c++" + standard, "-" + optimization, "-pipe", "-Wall", "-Wextra", source_path, "-o", binary_path], capture_output=True, text=True, timeout=15, env={"PATH":os.environ.get("PATH","/usr/bin:/bin"),"LANG":"C.UTF-8"})
except subprocess.TimeoutExpired:
    print(json.dumps({"verdict":"compile_error","message":"زمان کامپایل برنامه بیش از ۱۵ ثانیه شد.","compileTimeMs":15000,"results":[]})); sys.exit(0)
compile_ms = int((time.perf_counter() - compile_started) * 1000)
if compiled.returncode != 0:
    message = (compiled.stderr or compiled.stdout or "خطای کامپایل").strip()[-7000:]
    print(json.dumps({"verdict":"compile_error","message":message,"compileTimeMs":compile_ms,"results":[]})); sys.exit(0)

max_output = max(1024, min(262144, int(payload.get("maxOutputBytes",65536))))
time_limit = max(250, min(10000, int(payload.get("timeLimitMs",1500))))
results = []
total_runtime = 0
for index, test in enumerate(payload.get("tests", [])):
    out_path = "/tmp/out-" + str(index)
    err_path = "/tmp/err-" + str(index)
    started = time.perf_counter()
    def kill_process_group(process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception:
            try: process.kill()
            except Exception: pass
    def set_limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (max_output, max_output))
        resource.setrlimit(resource.RLIMIT_CPU, (max(1, int(time_limit / 1000) + 1), max(2, int(time_limit / 1000) + 2)))
        try: resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except Exception: pass
    status = "ok"
    return_code = None
    try:
        with open(out_path, "wb") as out_file, open(err_path, "wb") as err_file:
            process = subprocess.Popen([binary_path], stdin=subprocess.PIPE, stdout=out_file, stderr=err_file, cwd="/tmp", env={"PATH":"/usr/bin:/bin","LANG":"C.UTF-8"}, preexec_fn=set_limits, start_new_session=True)
            try:
                process.communicate(str(test.get("input_text", test.get("input", ""))).encode("utf-8"), timeout=time_limit / 1000)
            except subprocess.TimeoutExpired:
                kill_process_group(process); process.communicate(); status = "time_limit"
            finally:
                # Kill background descendants even when the submitted main process exits normally.
                # Otherwise a forked child could keep consuming resources between test cases.
                kill_process_group(process)
            return_code = process.returncode
        out_size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
        if out_size > max_output or return_code == -signal.SIGXFSZ: status = "output_limit"
        if status == "ok" and return_code != 0: status = "runtime_error"
        with open(out_path, "rb") as f: output = f.read(max_output + 1).decode("utf-8", errors="replace")
        with open(err_path, "rb") as f: error = f.read(7000).decode("utf-8", errors="replace")
    except Exception as exc:
        output = ""; error = str(exc); status = "runtime_error"
    runtime_ms = int((time.perf_counter() - started) * 1000)
    total_runtime += runtime_ms
    results.append({"status":status,"output":output,"error":error[-1000:],"runtimeMs":runtime_ms})
    try: os.remove(out_path); os.remove(err_path)
    except Exception: pass
print(json.dumps({"verdict":"completed","compileTimeMs":compile_ms,"runtimeMs":total_runtime,"results":results}, ensure_ascii=False))
`;

export class DockerUnavailableError extends Error {
  constructor(message = 'Docker اجرا نیست یا در دسترس نیست. Docker Desktop را اجرا کنید و دوباره امتحان کنید.') {
    super(message);
    this.name = 'DockerUnavailableError';
  }
}

export function compareOutput(actual, expected, mode = 'tokens', language = 'python') {
  const actualText = String(actual).replace(/\r\n/g, '\n');
  const expectedText = String(expected).replace(/\r\n/g, '\n');
  if (mode === 'exact') {
    if (actualText === expectedText) return true;
    // Python print() appends one line-feed by default. In exact mode, allow
    // that single final LF to be omitted from the teacher's expected output.
    // Do not trim spaces, blank lines, or internal newlines. C++ stays strict.
    return language === 'python'
      && actualText.endsWith('\n')
      && actualText.slice(0, -1) === expectedText;
  }
  const normalize = (value) => value.trim().split(/\s+/).filter(Boolean).join(' ');
  return normalize(actualText) === normalize(expectedText);
}

export function runPythonCase({ code, input, timeoutMs = 1500, maxOutputBytes = 65536, imageName = process.env.DOCKER_IMAGE || 'python:3.13-alpine', spawnProcess = spawn }) {
  return new Promise((resolve) => {
    const containerName = `acm-run-${crypto.randomUUID().slice(0, 12)}`;
    const args = [
      'run', '--rm', '-i', '--name', containerName,
      '--network=none', '--read-only',
      '--memory=128m', '--memory-swap=128m', '--cpus=0.5', '--pids-limit=64',
      '--security-opt=no-new-privileges', '--cap-drop=ALL', '--user=65534:65534',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--env', 'PYTHONDONTWRITEBYTECODE=1',
      imageName, 'python', '-I', '-S', '-c', BOOTSTRAP,
    ];
    let child;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnProcess('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      finish({ status: 'runner_error', output: '', error: `اجرای Docker ممکن نشد: ${err.message}`, runtimeMs: 0 });
      return;
    }
    const start = Date.now();
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill();
        const killer = spawnProcess('docker', ['kill', containerName], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => {});
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 12000) stderr += chunk.toString('utf8').slice(0, 12000 - stderr.length);
    });
    child.on('error', (err) => {
      const missing = err.code === 'ENOENT';
      finish({ status: missing ? 'docker_unavailable' : 'runner_error', output: '', error: missing ? 'Docker CLI پیدا نشد. Docker Desktop را نصب و اجرا کنید.' : `خطا در اجرای Docker: ${err.message}`, runtimeMs: Date.now() - start });
    });
    child.on('close', (code) => {
      const wallRuntimeMs = Date.now() - start;
      if (settled) return;
      const runtimeMatch = stderr.match(/__ACM_RUNTIME_MS__(\d+)/);
      const runtimeMs = runtimeMatch ? Number(runtimeMatch[1]) : wallRuntimeMs;
      stderr = stderr.replace(/\n?__ACM_RUNTIME_MS__\d+\n?/g, '').trim();
      if (outputExceeded) return finish({ status: 'output_limit', output: '', error: 'خروجی برنامه بیش از حد مجاز بود.', runtimeMs });
      if (timedOut || code === 124 || stderr.includes('__ACM_TLE__')) return finish({ status: 'time_limit', output: stdout.slice(0, maxOutputBytes), error: 'زمان مجاز اجرای برنامه تمام شد.', runtimeMs });
      stderr = stderr.replace(/__ACM_TLE__\n?/g, '').trim();
      if (stderr.includes('Cannot connect to the Docker daemon') || stderr.includes('docker_engine') || stderr.includes('is the docker daemon running')) {
        return finish({ status: 'docker_unavailable', output: '', error: 'Docker Desktop اجرا نیست. آن را باز کنید و دوباره تلاش کنید.', runtimeMs });
      }
      if (stderr.includes('Unable to find image') || stderr.includes('pull access denied') || stderr.includes('failed to resolve source metadata')) {
        return finish({ status: 'docker_image_missing', output: '', error: `تصویر ${imageName} در دسترس نیست. دستور docker pull ${imageName} را اجرا کنید.`, runtimeMs });
      }
      if (code === 0) return finish({ status: 'ok', output: stdout, error: '', runtimeMs });
      finish({ status: 'runtime_error', output: stdout, error: (stderr || 'برنامه با خطا متوقف شد.').slice(-8000), runtimeMs });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      const killer = spawnProcess('docker', ['kill', containerName], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {});
    }, timeoutMs + 2500);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ code, input, timeLimitMs: timeoutMs }));
  });
}

export function calculateCppRunnerTimeoutMs(testCount, timeLimitMs) {
  const count = Math.max(1, Math.min(20, Math.floor(Number(testCount) || 1)));
  const perTestMs = Math.max(500, Math.min(5000, Number(timeLimitMs) || 1500));
  const compileBudgetMs = 15_000;
  const startupAndCleanupBudgetMs = 8_000;
  const perTestOverheadMs = 1_500;
  // Keep the judge request below the HTTP server's 180-second request timeout.
  return Math.min(170_000, compileBudgetMs + startupAndCleanupBudgetMs + count * (perTestMs + perTestOverheadMs));
}

export function calculateCppRunnerResponseLimitChars(testCount) {
  const count = Math.max(1, Math.min(20, Math.floor(Number(testCount) || 1)));
  // JSON may expand each control byte to a six-character escape sequence.
  // 400 KiB per test covers the 64 KiB output cap plus metadata and encoding overhead.
  return Math.min(12 * 1024 * 1024, 256 * 1024 + count * 400 * 1024);
}

async function runCppSubmission({ code, tests, timeLimitMs = 1500, comparison = 'tokens', cppStandard = '17', optimization = 'O2', imageName = process.env.DOCKER_CPP_IMAGE || 'acm-cpp-runner:17', spawnProcess = spawn }) {
  if (!['17', '20'].includes(String(cppStandard))) return { verdict: 'judge_error', passedCases: 0, totalCases: tests.length, runtimeMs: 0, results: [], message: 'استاندارد C++ انتخاب‌شده معتبر نیست.' };
  if (!['O0', 'O1', 'O2', 'O3'].includes(String(optimization))) return { verdict: 'judge_error', passedCases: 0, totalCases: tests.length, runtimeMs: 0, results: [], message: 'تنظیمات بهینه‌سازی C++ معتبر نیست.' };
  const containerName = `acm-cpp-${crypto.randomUUID().slice(0, 12)}`;
  const args = [
    'run', '--rm', '-i', '--name', containerName,
    '--network=none', '--read-only', '--memory=384m', '--memory-swap=384m', '--cpus=1', '--pids-limit=64',
    '--security-opt=no-new-privileges', '--cap-drop=ALL', '--user=65534:65534',
    '--tmpfs', '/tmp:rw,exec,nosuid,size=64m', '--env', 'PYTHONDONTWRITEBYTECODE=1',
    imageName, 'python3', '-I', '-S', '-c', CPP_BOOTSTRAP,
  ];
  let stdout = '';
  let stderr = '';
  let child;
  try {
    child = spawnProcess('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    return { verdict: 'judge_error', passedCases: 0, totalCases: tests.length, runtimeMs: 0, results: [], message: `اجرای Docker ممکن نشد: ${error.message}` };
  }
  const start = Date.now();
  const timeout = calculateCppRunnerTimeoutMs(tests.length, timeLimitMs);
  const maxRunnerResponseChars = calculateCppRunnerResponseLimitChars(tests.length);
  let stdoutExceeded = false;
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      child.kill();
      const killer = spawnProcess('docker', ['kill', containerName], { stdio: 'ignore', windowsHide: true }); killer.on('error', () => {});
      finish({ error: 'اجرای کامپایلر C++ بیش از زمان مجاز طول کشید.' });
    }, timeout);
    child.stdout.on('data', (chunk) => {
      if (stdoutExceeded) return;
      const text = chunk.toString('utf8');
      if (stdout.length + text.length > maxRunnerResponseChars) {
        stdoutExceeded = true;
        child.kill();
        const killer = spawnProcess('docker', ['kill', containerName], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => {});
        return;
      }
      stdout += text;
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 12000) stderr += chunk.toString('utf8').slice(0, 12000 - stderr.length); });
    child.on('error', (error) => finish({ error: error.code === 'ENOENT' ? 'Docker CLI پیدا نشد. Docker را نصب و اجرا کن.' : `خطا در اجرای Docker: ${error.message}` }));
    child.on('close', (code) => {
      if (stdoutExceeded) { finish({ error: 'پاسخ موتور اجرای C++ بیش از اندازهٔ مجاز بود.' }); return; }
      if (code === 0) {
        try { finish({ payload: JSON.parse(stdout.trim().split('\n').at(-1)) }); }
        catch { finish({ error: 'پاسخ موتور اجرای C++ معتبر نبود.' }); }
        return;
      }
      const combined = `${stderr}\n${stdout}`;
      if (/Cannot connect to the Docker daemon|docker_engine|is the docker daemon running/i.test(combined)) finish({ error: 'Docker اجرا نیست یا در دسترس نیست.' });
      else if (/Unable to find image|pull access denied|No such image/i.test(combined)) finish({ error: `تصویر ${imageName} پیدا نشد. ابتدا docker build -t ${imageName} -f docker/cpp-runner/Dockerfile . را اجرا کن.` });
      else finish({ error: (stderr || stdout || `Docker با کد ${code} متوقف شد.`).slice(-3000) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ code, tests, timeLimitMs, cppStandard: String(cppStandard), optimization, maxOutputBytes: 65536 }));
  });
  if (result.error) return { verdict: 'judge_error', passedCases: 0, totalCases: tests.length, runtimeMs: Date.now() - start, results: [], message: result.error };
  const payload = result.payload;
  if (payload.verdict === 'compile_error') return { verdict: 'compile_error', passedCases: 0, totalCases: tests.length, runtimeMs: Number(payload.compileTimeMs) || 0, compileError: String(payload.message || '').slice(-7000), results: [], message: '' };
  if (payload.verdict === 'judge_error') return { verdict: 'judge_error', passedCases: 0, totalCases: tests.length, runtimeMs: 0, results: [], message: payload.message || 'خطای موتور C++' };
  const results = (payload.results || []).map((item, index) => ({
    passed: item.status === 'ok' && compareOutput(item.output, tests[index]?.expected_output ?? tests[index]?.output ?? '', comparison, 'cpp'),
    status: item.status,
    runtimeMs: Number(item.runtimeMs) || 0,
    output: typeof item.output === 'string' ? item.output : '',
    outputAvailable: typeof item.output === 'string',
    error: String(item.error || '').slice(-1000),
  }));
  const passedCases = results.filter((item) => item.passed).length;
  const verdict = passedCases === tests.length ? 'accepted'
    : results.some((item) => item.status === 'time_limit') ? 'time_limit'
      : results.some((item) => item.status === 'output_limit') ? 'output_limit'
        : results.some((item) => item.status === 'runtime_error') ? 'runtime_error'
          : 'wrong_answer';
  return { verdict, passedCases, totalCases: tests.length, runtimeMs: Number(payload.runtimeMs) || 0, compileTimeMs: Number(payload.compileTimeMs) || 0, results, message: '' };
}

export async function runSubmission({ code, tests, timeLimitMs, comparison, language = 'python', cppStandard = '17', optimization = 'O2' }, { spawnProcess = spawn } = {}) {
  if (!Array.isArray(tests) || tests.length < 1) return { verdict: 'judge_error', passedCases: 0, totalCases: 0, runtimeMs: 0, results: [], message: 'هیچ تستی برای داوری موجود نیست.' };
  if (language === 'cpp') return runCppSubmission({ code, tests, timeLimitMs, comparison, cppStandard, optimization, spawnProcess });
  if (language !== 'python') return { verdict: 'judge_error', passedCases: 0, totalCases: tests.length, runtimeMs: 0, results: [], message: 'زبان برنامه‌نویسی پشتیبانی نمی‌شود.' };
  const results = [];
  let totalRuntimeMs = 0;
  for (const test of tests) {
    const result = await runPythonCase({ code, input: test.input_text, timeoutMs: timeLimitMs, spawnProcess });
    totalRuntimeMs += result.runtimeMs || 0;
    if (['docker_unavailable', 'docker_image_missing', 'runner_error'].includes(result.status)) {
      return { verdict: 'judge_error', passedCases: 0, totalCases: tests.length, runtimeMs: totalRuntimeMs, results: [], message: result.error };
    }
    const passed = result.status === 'ok' && compareOutput(result.output, test.expected_output, comparison, 'python');
    results.push({
      passed, status: result.status, runtimeMs: result.runtimeMs,
      output: typeof result.output === 'string' ? result.output : '',
      outputAvailable: typeof result.output === 'string',
      error: result.status === 'runtime_error' ? result.error.slice(-1000) : '',
    });
  }
  const passedCases = results.filter((item) => item.passed).length;
  const verdict = passedCases === tests.length ? 'accepted' : results.some((item) => item.status === 'time_limit') ? 'time_limit' : results.some((item) => item.status === 'output_limit') ? 'output_limit' : results.some((item) => item.status === 'runtime_error') ? 'runtime_error' : 'wrong_answer';
  return { verdict, passedCases, totalCases: tests.length, runtimeMs: totalRuntimeMs, results, message: '' };
}
