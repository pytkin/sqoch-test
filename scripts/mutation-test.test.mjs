import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { mutationCases } from './mutation-cases.mjs';
import * as mutationRunner from './mutation-test.mjs';

const { applyMutation, classifyRun, createSandbox } = mutationRunner;

test('SQOCH-44 retains the exact 33 historical cases and adds nine distinct policy mutations', () => {
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(mutationCases.slice(0, 33)))
      .digest('hex'),
    '51cafd3bdc1129a50ff7b093559390345ae0bc7df1b79ee8f9e4eb1a22cd3a29',
  );
  assert.deepEqual(
    mutationCases.slice(33).map(({ id, group }) => [id, group]),
    [
      ['date-current-year-only', 'preparation-policy'],
      ['date-moscow-year', 'preparation-policy'],
      ['date-event-year-guard', 'preparation-policy'],
      ['date-persisted-default-year', 'preparation-policy'],
      ['date-default-must-be-future', 'preparation-policy'],
      ['date-reject-multiple-dates', 'preparation-policy'],
      ['assistant-no-auto-review', 'preparation-policy'],
      ['event-history-isolation', 'organizer-navigation'],
      ['organizer-no-put-on-read', 'organizer-navigation'],
    ],
  );
  assert.equal(new Set(mutationCases.map(({ id }) => id)).size, mutationCases.length);
  for (const mutation of mutationCases.slice(33)) {
    assert.equal(mutation.sources.length, 1);
    assert.equal(mutation.sources[0].count ?? 1, 1);
    assert.notEqual(mutation.sources[0].search, mutation.sources[0].replacement);
  }
});

test('new mutation groups select focused policy and navigation tests without the deleted App suite', () => {
  assert.deepEqual(mutationRunner.mutationGroups?.['preparation-policy'], {
    runtime: 'backend',
    tests: ['backend/tests/test_ai_intake.py', 'backend/tests/test_date_resolver.py'],
  });
  assert.deepEqual(mutationRunner.mutationGroups?.['organizer-navigation'], {
    runtime: 'frontend',
    tests: ['src/App.navigation.test.tsx'],
  });
  assert.equal(
    Object.values(mutationRunner.mutationGroups ?? {}).some(({ tests }) =>
      tests.includes('src/App.test.tsx'),
    ),
    false,
  );
});

async function runnerFixture() {
  const project = await mkdtemp(join(tmpdir(), 'sqoch-mutation-selection-'));
  try {
    for (const directory of ['scripts', 'src/features/booking', 'node_modules/vitest'])
      await mkdir(join(project, directory), { recursive: true });
    for (const name of ['mutation-test.mjs', 'mutation-cases.mjs'])
      await copyFile(new URL(name, import.meta.url), join(project, 'scripts', name));
    await writeFile(join(project, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(project, 'src/features/booking/draft.ts'),
      'export const validAge = (value) => Number.isSafeInteger(Number(value));\n',
    );
    for (const name of ['api', 'draft', 'presentation'])
      await writeFile(join(project, `src/features/booking/${name}.test.ts`), '// selected fixture');
    await writeFile(
      join(project, 'node_modules/vitest/vitest.mjs'),
      `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile('src/features/booking/draft.ts', 'utf8');
const { validAge } = await import('data:text/javascript,' + encodeURIComponent(source));
try {
  assert.equal(validAge('9007199254740993'), false);
  process.stdout.write('Tests 1 passed\\n');
} catch {
  process.stdout.write('Tests 1 failed\\n');
  process.exitCode = 1;
}
`,
    );
    const runner = await import(pathToFileURL(join(project, 'scripts/mutation-test.mjs')));
    return { project, runner };
  } catch (error) {
    await rm(project, { recursive: true, force: true });
    throw error;
  }
}

test('a complete group runs control and mutation in copies with a separate SQOCH-44 report', async () => {
  const { project, runner } = await runnerFixture();
  try {
    const historical = join(project, '.cache/mutation/current/report.json');
    const historicalText = '{"status":"complete","counts":{"killed":33}}\n';
    await mkdir(join(project, '.cache/mutation/current'), { recursive: true });
    await writeFile(historical, historicalText);
    const source = join(project, 'src/features/booking/draft.ts');
    const original = await readFile(source, 'utf8');
    assert.equal(
      await runner.runMutationChecks([
        '--label',
        'sqoch-44-runner-fixture',
        '--only',
        'booking-safe-integer',
      ]),
      0,
    );
    const report = JSON.parse(
      await readFile(join(project, '.cache/mutation/sqoch-44-runner-fixture/report.json'), 'utf8'),
    );
    assert.equal(report.status, 'complete');
    assert.equal(report.controls[0].outcome, 'passed');
    assert.equal(report.counts.killed, 1);
    assert.equal(report.counts.invalid, 0);
    assert.equal(await readFile(source, 'utf8'), original);
    assert.equal(await readFile(historical, 'utf8'), historicalText);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('a missing selected test blocks the control explicitly instead of running a smaller suite', async () => {
  const { project, runner } = await runnerFixture();
  try {
    const missing = 'src/features/booking/draft.test.ts';
    await rm(join(project, missing));
    await assert.rejects(
      runner.runMutationChecks([
        '--label',
        'sqoch-44-missing-selection',
        '--only',
        'booking-safe-integer',
      ]),
      /Unmodified control failed/,
    );
    const output = join(project, '.cache/mutation/sqoch-44-missing-selection');
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.status, 'blocked');
    assert.equal(report.controls[0].outcome, 'invalid');
    assert.deepEqual(report.controls[0].missingTests, [missing]);
    assert.match(
      await readFile(join(output, 'control-booking-client.log'), 'utf8'),
      /draft.test.ts/,
    );
    assert.equal(report.counts.killed, 0);
    assert.deepEqual(report.mutations, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('mutation changes exactly the declared business predicate', () => {
  const source = 'if (age < 14) child();\nif (age < 18) guardian();\n';
  const result = applyMutation(source, { search: 'age < 14', replacement: 'age <= 14' });
  assert.equal(result, 'if (age <= 14) child();\nif (age < 18) guardian();\n');
});

test('missing or ambiguous mutation anchors fail instead of testing unchanged source', () => {
  assert.throws(() => applyMutation('age < 14', { search: 'age < 18', replacement: 'true' }));
  assert.throws(() =>
    applyMutation('age < 14; age < 14', { search: 'age < 14', replacement: 'true' }),
  );
  assert.throws(() => applyMutation('age < 14', { search: 'age < 14', replacement: 'age < 14' }));
});

test('one explicitly shared policy can mutate its declared two occurrences', () => {
  assert.equal(
    applyMutation('timeout: 60000; timeout: 60000', {
      search: 'timeout: 60000',
      replacement: 'timeout: 1',
      count: 2,
    }),
    'timeout: 1; timeout: 1',
  );
});

test('passing executed tests identify a surviving mutation', () => {
  assert.equal(classifyRun({ status: 0, stdout: 'Tests 9 passed (9)', stderr: '' }), 'survived');
  assert.equal(classifyRun({ status: 0, stdout: '43 passed in 0.30s', stderr: '' }), 'survived');
});

test('actual Vitest and pytest assertion failures identify killed mutations', () => {
  assert.equal(
    classifyRun({ status: 1, stdout: 'FAIL pricing\nTests 1 failed | 8 passed', stderr: '' }),
    'killed',
  );
  assert.equal(
    classifyRun({ status: 1, stdout: 'FAILED test_age\n1 failed, 42 passed', stderr: '' }),
    'killed',
  );
});

test('syntax, imports and collection failures never count as killed business mutations', () => {
  for (const output of [
    'SyntaxError: invalid syntax\n1 failed',
    'ModuleNotFoundError: sqoch_api\n1 failed',
    'Failed to resolve import "missing"\nTests 1 failed',
    'Error during collection',
  ])
    assert.equal(classifyRun({ status: 1, stdout: output, stderr: '' }), 'invalid');
});

test('an empty test selection and an unclassified process error are invalid evidence', () => {
  assert.equal(classifyRun({ status: 0, stdout: 'No test files found', stderr: '' }), 'invalid');
  assert.equal(classifyRun({ status: 0, stdout: '', stderr: '' }), 'invalid');
  assert.equal(classifyRun({ status: 2, stdout: 'unknown option', stderr: '' }), 'invalid');
});

test('a process timeout is reported separately from assertion failures', () => {
  assert.equal(
    classifyRun({ status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' }),
    'timeout',
  );
});

test('failed suites without executed failing cases are invalid, including real Vite parse output', () => {
  for (const output of [
    'Test Files 1 failed (1)\nTests no tests\n[PARSE_ERROR] Unexpected token\nError: Transform failed with 1 error',
    'Test Files 1 failed (1)\nTests 2 skipped',
  ])
    assert.equal(classifyRun({ status: 1, stdout: output, stderr: '' }), 'invalid');
});

test('symbolic links in copied source are rejected before they can write through to the original', async () => {
  const project = await mkdtemp(join(tmpdir(), 'sqoch-mutation-symlink-'));
  try {
    const source = join(project, 'source');
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'src/original.ts'), 'original');
    await symlink(join(source, 'src/original.ts'), join(source, 'src/linked.ts'));
    await assert.rejects(createSandbox(source, source, join(project, 'copies')), /symbolic link/i);
    assert.equal(await readFile(join(source, 'src/original.ts'), 'utf8'), 'original');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('failed control replaces an older successful report with a blocked run and no claimed kills', async () => {
  const project = await mkdtemp(join(tmpdir(), 'sqoch-mutation-report-'));
  try {
    await mkdir(join(project, 'scripts'), { recursive: true });
    for (const name of ['mutation-test.mjs', 'mutation-cases.mjs']) {
      await copyFile(new URL(name, import.meta.url), join(project, 'scripts', name));
    }
    const output = join(project, '.cache/mutation/control-failure');
    await mkdir(output, { recursive: true });
    const reportPath = join(output, 'report.json');
    await writeFile(reportPath, JSON.stringify({ status: 'complete', counts: { killed: 33 } }));
    const runner = await import(pathToFileURL(join(project, 'scripts/mutation-test.mjs')));
    await assert.rejects(
      runner.runMutationChecks([
        '--baseline',
        'missing-source',
        '--label',
        'control-failure',
        '--only',
        'order-child-price-boundary',
      ]),
      /Unmodified control failed/,
    );
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'blocked');
    assert.equal(report.controls[0].outcome, 'invalid');
    assert.equal(report.counts.killed, 0);
    assert.deepEqual(report.mutations, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('sandbox copies code and tests, excludes secrets and state, and never writes back', async () => {
  const project = await mkdtemp(join(tmpdir(), 'sqoch-mutation-fixture-'));
  const root = join(project, 'source');
  const copies = join(project, 'copies');
  try {
    for (const directory of [
      'src',
      'backend/sqoch_api',
      'backend/.venv',
      'backend/tests',
      'node_modules',
      '.cache',
    ]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, 'src/price.ts'), 'export const price = 2000;');
    await writeFile(join(root, 'backend/sqoch_api/price.py'), 'PRICE = 2000');
    await writeFile(join(root, 'backend/tests/test_price.py'), 'assert 2000 > 0');
    await writeFile(join(root, 'backend/.venv/secret'), 'environment');
    await writeFile(join(root, '.env'), 'DO_NOT_COPY=secret');
    await writeFile(join(root, '.cache/state.sqlite3'), 'state');
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const sandbox = await createSandbox(root, root, copies);
    try {
      assert.equal(
        await readFile(join(sandbox, 'src/price.ts'), 'utf8'),
        'export const price = 2000;',
      );
      assert.equal(
        await readFile(join(sandbox, 'backend/tests/test_price.py'), 'utf8'),
        'assert 2000 > 0',
      );
      for (const excluded of ['.env', '.cache/state.sqlite3', 'backend/.venv/secret']) {
        await assert.rejects(readFile(join(sandbox, excluded)));
      }
      await writeFile(join(sandbox, 'src/price.ts'), 'mutated');
      assert.equal(
        await readFile(join(root, 'src/price.ts'), 'utf8'),
        'export const price = 2000;',
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
