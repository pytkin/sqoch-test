import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { mutationCases } from './mutation-cases.mjs';

export function applyMutation(source, { search, replacement, count = 1 }) {
  if (!search || search === replacement || source.split(search).length - 1 !== count)
    throw new Error('Mutation must match exactly its declared nonempty source occurrences');
  return source.replaceAll(search, replacement);
}

export function classifyRun(run) {
  if (run.error?.code === 'ETIMEDOUT') return 'timeout';
  const output = stripVTControlCharacters(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  if (
    /SyntaxError|ModuleNotFoundError|ImportError|Failed to resolve import|Cannot find module|Error during collection|ERROR collecting|No test files found|\[PARSE_ERROR\]|Transform failed|Failed to parse/.test(
      output,
    )
  )
    return 'invalid';
  const vitestCases = /^\s*Tests\s+([^\n]+)/m.exec(output)?.[1];
  if (vitestCases || /^\s*Test Files\b/m.test(output)) {
    if (run.status === 0 && /\b[1-9]\d* passed\b/.test(vitestCases ?? '')) return 'survived';
    if (run.status === 1 && /\b[1-9]\d* failed\b/.test(vitestCases ?? '')) return 'killed';
    return 'invalid';
  }
  if (run.status === 0 && /^\s*(?:=+\s*)?[1-9]\d* passed\b/m.test(output)) return 'survived';
  if (run.status === 1 && /^\s*(?:=+\s*)?[1-9]\d* failed\b/m.test(output)) return 'killed';
  return 'invalid';
}

const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export async function createSandbox(sourceRoot, projectRoot, workspaceRoot) {
  await mkdir(workspaceRoot, { recursive: true });
  const sandbox = await mkdtemp(join(workspaceRoot, 'isolated-'));
  try {
    for (const path of [
      'src',
      'backend',
      'fixtures',
      'package.json',
      'vite.config.ts',
      'tsconfig.json',
    ]) {
      const source = join(sourceRoot, path);
      if (!(await exists(source))) continue;
      await cp(source, join(sandbox, path), {
        recursive: true,
        filter: async (entry) => {
          const excluded = relative(sourceRoot, entry)
            .split(sep)
            .some(
              (part) =>
                ['node_modules', '.venv', '__pycache__', '.cache', '.pytest_cache'].includes(
                  part,
                ) ||
                part.startsWith('.env') ||
                /\.(sqlite3?|db)(-wal|-shm)?$/.test(part),
            );
          if (excluded) return false;
          if ((await lstat(entry)).isSymbolicLink())
            throw new Error('Mutation source contains a symbolic link');
          return true;
        },
      });
    }
    const modules = join(projectRoot, 'node_modules');
    if (await exists(modules))
      await symlink(
        modules,
        join(sandbox, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    return sandbox;
  } catch (error) {
    await rm(sandbox, { recursive: true, force: true });
    throw error;
  }
}

export const mutationGroups = {
  'booking-client': {
    runtime: 'frontend',
    tests: [
      'src/features/booking/api.test.ts',
      'src/features/booking/draft.test.ts',
      'src/features/booking/presentation.test.ts',
    ],
  },
  'organizer-client': {
    runtime: 'frontend',
    tests: [
      'src/features/organizer/api.test.ts',
      'src/features/organizer/presentation.test.ts',
      'src/features/organizer/form.test.ts',
    ],
  },
  orders: {
    runtime: 'backend',
    tests: ['backend/tests/test_orders.py', 'backend/tests/test_confirmation.py'],
  },
  delivery: {
    runtime: 'backend',
    tests: [
      'backend/tests/test_claim.py',
      'backend/tests/test_progress.py',
      'backend/tests/test_reconcile.py',
    ],
  },
  campaigns: {
    runtime: 'backend',
    tests: ['backend/tests/test_campaign_flow.py', 'backend/tests/test_draft_contract.py'],
  },
  ai: {
    runtime: 'backend',
    tests: ['backend/tests/test_ai_prepare.py', 'backend/tests/test_ai_rewrite.py'],
  },
  'preparation-policy': {
    runtime: 'backend',
    tests: ['backend/tests/test_ai_intake.py', 'backend/tests/test_date_resolver.py'],
  },
  'organizer-navigation': {
    runtime: 'frontend',
    tests: ['src/App.navigation.test.tsx'],
  },
};

async function runTests(group, sandbox, projectRoot) {
  const tests = group.tests;
  if (!tests.length) return { status: 2, stdout: '', stderr: 'No test files found' };
  const missingTests = [];
  for (const file of tests) if (!(await exists(join(sandbox, file)))) missingTests.push(file);
  if (missingTests.length)
    return {
      status: 2,
      stdout: '',
      stderr: `Missing selected test files: ${missingTests.join(', ')}`,
      missingTests,
    };
  const python = join(
    projectRoot,
    'backend',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const command = group.runtime === 'frontend' ? process.execPath : python;
  const args =
    group.runtime === 'frontend'
      ? [join(projectRoot, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, '--reporter=dot']
      : ['-m', 'pytest', '-c', 'backend/pyproject.toml', ...tests, '-q'];
  const run = spawnSync(command, args, {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONPATH: [join(sandbox, 'backend'), join(sandbox, 'backend/tests')].join(delimiter),
      PYTHONDONTWRITEBYTECODE: '1',
      DEEPSEEK_API_KEY: '',
      LLM_PROVIDER: 'deepseek',
      SQOCH_DATABASE_PATH: join(sandbox, '.cache/mutation.sqlite3'),
    },
  });
  return {
    status: run.status,
    signal: run.signal,
    error: run.error ? { code: run.error.code, message: run.error.message } : undefined,
    stdout: run.stdout,
    stderr: run.stderr,
    command: [command, ...args],
  };
}

function options(args) {
  const result = { label: 'current' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!['--baseline', '--label', '--only'].includes(argument) || !args[index + 1])
      throw new Error('Usage: pnpm test:mutation [--baseline path] [--label name] [--only id,id]');
    result[argument.slice(2)] = args[++index];
  }
  if (!/^[a-z0-9-]+$/.test(result.label))
    throw new Error('Report label must contain lowercase letters, numbers or hyphens');
  return result;
}

async function locateMutation(sourceRoot, mutation) {
  for (const candidate of mutation.sources) {
    const path = join(sourceRoot, candidate.path);
    if (!(await exists(path))) continue;
    const source = await readFile(path, 'utf8');
    try {
      const mutated = applyMutation(source, candidate);
      return { path: candidate.path, source, mutated };
    } catch {
      /* Try the corresponding pre-refactor file location. */
    }
  }
  throw new Error(`Missing or ambiguous source anchor: ${mutation.id}`);
}

async function persistReport(output, report) {
  for (const outcome of ['killed', 'survived', 'invalid', 'timeout'])
    report.counts[outcome] = report.mutations.filter((item) => item.outcome === outcome).length;
  const temporary = join(output, `report-${report.runId}.tmp`);
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, join(output, 'report.json'));
}

export async function runMutationChecks(args = []) {
  const selected = options(args);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sourceRoot = selected.baseline ? resolve(projectRoot, selected.baseline) : projectRoot;
  const ids = selected.only?.split(',');
  if (ids?.some((id) => !mutationCases.some((mutation) => mutation.id === id)))
    throw new Error('Unknown mutation ID');
  const mutations = mutationCases.filter((mutation) => !ids || ids.includes(mutation.id));
  const output = join(projectRoot, '.cache/mutation', selected.label);
  await mkdir(output, { recursive: true });
  const report = {
    schemaVersion: 1,
    runId: randomUUID(),
    status: 'running',
    source: relative(projectRoot, sourceRoot) || '.',
    scope: 'curated semantic mutations; not exhaustive AST coverage',
    controls: [],
    mutations: [],
    counts: {},
  };
  await persistReport(output, report);
  try {
    for (const groupId of new Set(mutations.map((mutation) => mutation.group))) {
      const sandbox = await createSandbox(sourceRoot, projectRoot, join(output, 'sandboxes'));
      let run;
      try {
        run = await runTests(mutationGroups[groupId], sandbox, projectRoot);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
      const classification = classifyRun(run);
      await writeFile(
        join(output, `control-${groupId}.log`),
        `${run.stdout ?? ''}\n${run.stderr ?? ''}`,
      );
      report.controls.push({
        group: groupId,
        outcome: classification === 'survived' ? 'passed' : classification,
        command: run.command,
        ...(run.missingTests ? { missingTests: run.missingTests } : {}),
      });
      await persistReport(output, report);
      if (classification !== 'survived')
        throw new Error(`Unmodified control failed: ${groupId}; see ${output}`);
      process.stdout.write(`control ${groupId}: passed\n`);
    }
    for (const mutation of mutations) {
      const item = { id: mutation.id, group: mutation.group, purpose: mutation.purpose };
      let sandbox;
      try {
        const target = await locateMutation(sourceRoot, mutation);
        sandbox = await createSandbox(sourceRoot, projectRoot, join(output, 'sandboxes'));
        await writeFile(join(sandbox, target.path), target.mutated);
        const run = await runTests(mutationGroups[mutation.group], sandbox, projectRoot);
        Object.assign(item, {
          path: target.path,
          sourceSha256: sha256(target.source),
          mutatedSha256: sha256(target.mutated),
          outcome: classifyRun(run),
          command: run.command,
        });
        await writeFile(
          join(output, `${mutation.id}.log`),
          `${run.stdout ?? ''}\n${run.stderr ?? ''}`,
        );
      } catch (error) {
        Object.assign(item, { outcome: 'invalid', reason: error.message });
      } finally {
        if (sandbox) await rm(sandbox, { recursive: true, force: true });
      }
      report.mutations.push(item);
      await persistReport(output, report);
      process.stdout.write(`${mutation.id}: ${item.outcome}\n`);
    }
    report.status = 'complete';
    await persistReport(output, report);
    process.stdout.write(
      `Report: ${relative(projectRoot, join(output, 'report.json'))}\n${JSON.stringify(report.counts)}\n`,
    );
    return report.counts.invalid || report.counts.timeout ? 2 : report.counts.survived ? 1 : 0;
  } catch (error) {
    report.status = 'blocked';
    report.failure = error.message;
    await persistReport(output, report);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMutationChecks(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    },
  );
}
