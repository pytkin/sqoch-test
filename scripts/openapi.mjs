import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
mkdirSync(join(root, '.cache'), { recursive: true });
const schema = execFileSync(
  'uv',
  ['run', '--project', 'backend', '--locked', 'python', '-m', 'sqoch_api.export_openapi'],
  { cwd: root, encoding: 'utf8' },
);
writeFileSync(join(root, '.cache/openapi.json'), schema);
const check = process.argv.includes('--check');
const target = join(root, 'src/features/booking/generated');
const output = check ? mkdtempSync(join(root, '.cache/types-')) : target;
try {
  execFileSync('pnpm', ['--pm-on-fail=ignore', '--dir', 'tools/openapi', 'generate'], {
    cwd: root,
    env: { ...process.env, SQOCH_TYPES_OUTPUT: output },
    stdio: 'inherit',
  });
  if (check) {
    const expected = readdirSync(target).sort();
    const actual = readdirSync(output).sort();
    if (
      JSON.stringify(expected) !== JSON.stringify(actual) ||
      expected.some(
        (name) =>
          readFileSync(join(target, name), 'utf8') !== readFileSync(join(output, name), 'utf8'),
      )
    ) {
      throw new Error(
        'Контракт и типы расходятся. Выполните pnpm contracts:generate и проверьте diff.',
      );
    }
    console.log('OpenAPI и сгенерированные типы синхронны; tracked файлы не изменялись.');
  }
} finally {
  if (check) rmSync(output, { recursive: true, force: true });
}
