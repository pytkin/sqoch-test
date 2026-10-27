import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

test('Mailpit runner pins its compose file and ignores operator compose environment', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sqoch-mailpit-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  const root = resolve(import.meta.dirname, '..');
  for (const command of ['docker', 'uv']) {
    const executable = join(directory, command);
    writeFileSync(
      executable,
      `#!${process.execPath}\n` +
        `import { appendFileSync } from 'node:fs';\n` +
        `appendFileSync(process.env.SQOCH_TEST_LOG, JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2),cwd:process.cwd(),compose:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('COMPOSE_')))})+'\\n');\n`,
    );
    chmodSync(executable, 0o755);
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/test-mailpit.mjs')], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: directory + delimiter + process.env.PATH,
      SQOCH_TEST_LOG: log,
      COMPOSE_FILE: '/tmp/operator-compose.yaml',
      COMPOSE_ENV_FILES: '/tmp/operator.env',
      COMPOSE_PROFILES: 'operator-profile',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.cwd, root);
  const compose = calls.filter((call) => call.command === 'docker');
  assert.equal(compose.length, 2);
  for (const call of compose) {
    assert.deepEqual(call.args.slice(0, 7), [
      'compose',
      '--env-file',
      devNull,
      '-f',
      join(root, 'compose.yaml'),
      '-p',
      'sqoch-mailpit-tests',
    ]);
    assert.deepEqual(call.compose, { COMPOSE_DISABLE_ENV_FILE: '1' });
  }
  assert.deepEqual(compose[0].args.slice(7), ['up', '-d', '--wait']);
  assert.deepEqual(compose[1].args.slice(7), ['down']);
});
