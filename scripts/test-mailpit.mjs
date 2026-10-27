import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_'))),
  COMPOSE_DISABLE_ENV_FILE: '1',
  MAILPIT_SMTP_PORT: '11025',
  MAILPIT_HTTP_PORT: '18025',
  SQOCH_SMTP_PORT: '11025',
  SQOCH_MAILPIT_URL: 'http://127.0.0.1:18025',
  UV_NO_ENV_FILE: '1',
  DEEPSEEK_API_KEY: '',
  LLM_PROVIDER: 'deepseek',
  DEEPSEEK_MODEL: 'deepseek-flash',
};
const compose = [
  'compose',
  '--env-file',
  devNull,
  '-f',
  join(cwd, 'compose.yaml'),
  '-p',
  'sqoch-mailpit-tests',
];
function run(command, args) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
try {
  run('docker', [...compose, 'up', '-d', '--wait']);
  const command = process.argv.includes('--demo')
    ? ['python', 'backend/integration/demo_failure.py']
    : ['pytest', 'backend/integration', '-q'];
  run('uv', ['run', '--no-env-file', '--project', 'backend', '--locked', ...command]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const result = spawnSync('docker', [...compose, 'down'], { cwd, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exitCode = 1;
}
