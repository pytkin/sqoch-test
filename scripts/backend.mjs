import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const envFile = existsSync(new URL('../.env', import.meta.url)) ? ['--env-file', '.env'] : [];
const child = spawn(
  'uv',
  ['run', ...envFile, '--project', 'backend', '--locked', ...process.argv.slice(2)],
  {
    cwd,
    stdio: 'inherit',
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  console.error('Не удалось запустить uv для backend');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
