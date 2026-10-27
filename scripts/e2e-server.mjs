import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Explicitly bypass the operator's .env and data. No external AI or SMTP calls.
const env = {
  ...process.env,
  SQOCH_DATABASE_PATH: join(process.cwd(), '.cache/e2e.sqlite3'),
  DEEPSEEK_API_KEY: 'e2e-transport-only',
  LLM_PROVIDER: 'deepseek',
  DEEPSEEK_MODEL: 'deepseek-flash',
};
const uv = ['run', '--no-env-file', '--project', 'backend', '--locked'];
const reset = spawnSync(
  'uv',
  [...uv, 'python', '-m', 'sqoch_api.notifications.cli', 'demo:reset', '--yes'],
  { env, stdio: 'inherit' },
);
if (reset.error || reset.status !== 0) process.exit(1);

const children = [
  spawn(
    'uv',
    [
      ...uv,
      'uvicorn',
      'e2e_app:app',
      '--app-dir',
      'backend/integration',
      '--host',
      '127.0.0.1',
      '--port',
      '8000',
    ],
    { env, stdio: 'inherit' },
  ),
  spawn('uv', [...uv, 'python', 'backend/integration/e2e_worker.py'], { env, stdio: 'inherit' }),
];
let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', () => shutdown(1));
  child.on('exit', (code) => {
    if (!stopping) shutdown(code || 1);
  });
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
