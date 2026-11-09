import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runSubmission, compareOutput, calculateCppRunnerTimeoutMs, calculateCppRunnerResponseLimitChars } from './server/judge.js';

test('C++ Docker runner invokes one Python interpreter and forwards per-test input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acm-cpp-docker-mock-'));
  const capture = join(dir, 'capture.json');
  const mockDocker = join(dir, 'docker-mock.js');
  const script = `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input:JSON.parse(data)}));process.stdout.write(JSON.stringify({verdict:'completed',compileTimeMs:12,runtimeMs:4,results:[{status:'ok',output:'42\\n',runtimeMs:4,error:''}]}));});\n`;
  await writeFile(mockDocker, script, 'utf8');
  // Do not place a shell script named "docker" on PATH: Windows cannot execute
  // extensionless POSIX scripts. Inject a Node-based Docker mock instead.
  const spawnMock = (command, args, options) => {
    assert.equal(command, 'docker');
    return spawn(process.execPath, [mockDocker, ...args], options);
  };
  const oldImage = process.env.DOCKER_CPP_IMAGE;
  process.env.DOCKER_CPP_IMAGE = 'acm-cpp-runner:test';
  try {
    const result = await runSubmission({
      code: '#include <iostream>\nint main(){int n;std::cin>>n;std::cout<<n*2;}',
      language: 'cpp', cppStandard: '20', optimization: 'O1',
      tests: [{ input_text: '21', expected_output: '42' }],
      timeLimitMs: 1200, comparison: 'tokens',
    }, { spawnProcess: spawnMock });
    const captured = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(captured.args.filter((arg) => arg === 'python3').length, 1);
    assert.ok(captured.args.includes('acm-cpp-runner:test'));
    const tmpfsIndex = captured.args.indexOf('--tmpfs');
    assert.notEqual(tmpfsIndex, -1);
    assert.equal(captured.args[tmpfsIndex + 1], '/tmp:rw,exec,nosuid,size=64m');
    assert.ok(captured.args.includes('-I'));
    assert.equal(captured.input.tests[0].input_text, '21');
    assert.equal(captured.input.cppStandard, '20');
    assert.equal(captured.input.optimization, 'O1');
    assert.equal(result.verdict, 'accepted');
    assert.equal(result.passedCases, 1);
  } finally {
    if (oldImage === undefined) delete process.env.DOCKER_CPP_IMAGE; else process.env.DOCKER_CPP_IMAGE = oldImage;
    await rm(dir, { recursive: true, force: true });
  }
});

test('C++ runner Dockerfile does not prepend a duplicate interpreter command', async () => {
  const dockerfile = await readFile(new URL('./docker/cpp-runner/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /ENTRYPOINT\s+\[\s*['"]\/usr\/bin\/env['"]\s*\]/);
});


test('C++ runner timeout accounts for all allowed tests instead of truncating at 45 seconds', () => {
  assert.equal(calculateCppRunnerTimeoutMs(1, 500), 25000);
  assert.equal(calculateCppRunnerTimeoutMs(20, 5000), 153000);
  assert.ok(calculateCppRunnerTimeoutMs(20, 5000) < 180000);
});

test('C++ runner response buffer can hold the maximum output from twenty test cases', () => {
  const limit = calculateCppRunnerResponseLimitChars(20);
  assert.ok(limit >= 20 * 65536 * 6);
  assert.ok(limit <= 12 * 1024 * 1024);
});

test('C++ runner kills background descendants and allows exact output limit', async () => {
  const source = await readFile(new URL('./server/judge.js', import.meta.url), 'utf8');
  assert.match(source, /start_new_session=True/);
  assert.match(source, /os\.killpg\(process\.pid, signal\.SIGKILL\)/);
  assert.match(source, /out_size > max_output/);
  assert.doesNotMatch(source, /out_size >= max_output/);
});


test('Python exact comparison accepts print() final newline when teacher expected no newline', () => {
  assert.equal(compareOutput('Hello\n', 'Hello', 'exact', 'python'), true);
  assert.equal(compareOutput('Hello\r\n', 'Hello', 'exact', 'python'), true);
  assert.equal(compareOutput('Hello\n', 'Hello\n', 'exact', 'python'), true);
});

test('Python exact comparison preserves spaces and internal blank lines', () => {
  assert.equal(compareOutput('Hello \n', 'Hello', 'exact', 'python'), false);
  assert.equal(compareOutput(' Hello\n', 'Hello', 'exact', 'python'), false);
  assert.equal(compareOutput('A\n\nB\n', 'A\nB', 'exact', 'python'), false);
  assert.equal(compareOutput('A\n\n', 'A', 'exact', 'python'), false);
});

test('C++ exact comparison still requires the teacher-specified final newline', () => {
  assert.equal(compareOutput('Hello', 'Hello', 'exact', 'cpp'), true);
  assert.equal(compareOutput('Hello\n', 'Hello', 'exact', 'cpp'), false);
  assert.equal(compareOutput('Hello', 'Hello\n', 'exact', 'cpp'), false);
});
