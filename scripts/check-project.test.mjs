import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const checker = resolve(import.meta.dirname, 'check-project.mjs');
const operations = ['setup', 'dev', 'lint', 'test', 'build', 'verify'];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sqoch-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, text = '') => {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  write('AGENTS.md', '[Specification](docs/spec.md)\n[Design](docs/design.md)');
  write('README.md', '[Specification](docs/spec.md#unchecked-anchor)');
  write('backend/TDD.md');
  write('docs/spec.md', '[Design](design.md)');
  write('docs/design.md');
  const binding = {
    entrypoint: 'AGENTS.md',
    instructions: ['docs/spec.md', 'docs/design.md'],
    operations: Object.fromEntries(
      operations.map((name) => [name, { command: `pnpm run ${name}` }]),
    ),
  };
  const save = () => write('agent-platform.json', JSON.stringify(binding));
  save();
  return { root, write, binding, save };
}

function run(root, flag) {
  return spawnSync(process.execPath, [checker, flag], { cwd: root, encoding: 'utf8' });
}

function passes(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fails(result, source) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.ok(result.stderr.includes(source), result.stderr);
}

test('binding accepts six commands and a documented not-applicable operation', (t) => {
  const { root, binding, save } = fixture(t);
  binding.operations.build = { notApplicable: 'This fixture has no build output.' };
  save();
  passes(run(root, '--binding'));
});

for (const [name, mutate] of [
  [
    'missing entrypoint',
    (binding) => {
      binding.entrypoint = 'missing.md';
    },
  ],
  [
    'absolute entrypoint',
    (binding) => {
      binding.entrypoint = '/etc/passwd';
    },
  ],
  [
    'escaping instruction',
    (binding) => {
      binding.instructions = ['../outside.md'];
    },
  ],
  [
    'empty instructions',
    (binding) => {
      binding.instructions = [];
    },
  ],
  [
    'missing instruction',
    (binding) => {
      binding.instructions = ['docs/missing.md'];
    },
  ],
  [
    'undeclared instruction pointer',
    (binding) => {
      binding.instructions = ['README.md'];
    },
  ],
  [
    'missing operation',
    (binding) => {
      delete binding.operations.verify;
    },
  ],
  [
    'extra operation',
    (binding) => {
      binding.operations.publish = { command: 'publish' };
    },
  ],
  [
    'array operation',
    (binding) => {
      binding.operations.dev = [];
    },
  ],
  [
    'empty command',
    (binding) => {
      binding.operations.dev = { command: ' ' };
    },
  ],
  [
    'empty reason',
    (binding) => {
      binding.operations.dev = { notApplicable: '' };
    },
  ],
  [
    'ambiguous operation',
    (binding) => {
      binding.operations.dev = { command: 'dev', notApplicable: 'none' };
    },
  ],
]) {
  test(`binding rejects ${name}`, (t) => {
    const { root, binding, save } = fixture(t);
    mutate(binding);
    save();
    fails(run(root, '--binding'), 'agent-platform.json');
  });
}

for (const value of ['[]', 'null', 'not JSON']) {
  test(`binding rejects non-object or invalid JSON: ${value}`, (t) => {
    const { root, write } = fixture(t);
    write('agent-platform.json', value);
    fails(run(root, '--binding'), 'agent-platform.json');
  });
}

test('binding rejects instruction symlinks outside the checkout', (t) => {
  const { root, write, binding, save } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'sqoch-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'external.md'), 'external');
  symlinkSync(join(outside, 'external.md'), join(root, 'external.md'));
  write('AGENTS.md', 'external.md');
  binding.instructions = ['external.md'];
  save();
  fails(run(root, '--binding'), 'agent-platform.json');
});

test('docs checks nested local links, images, angle paths and percent-encoded spaces', (t) => {
  const { root, write } = fixture(t);
  write('docs/preview image.png', 'fixture image');
  write('docs/nested/guide.md', '[Spec](../spec.md)\n![Image](<../preview image.png>)');
  write('README.md', '[Guide](docs/nested/guide.md)\n![Image](docs/preview%20image.png)');
  passes(run(root, '--docs'));
});

test('docs ignores external URLs, fragments and code and stays in the declared source scope', (t) => {
  const { root, write } = fixture(t);
  write(
    'README.md',
    [
      '[Web](https://example.com/missing) [Mail](mailto:guest@example.com)',
      '[Telephone](tel:+123) [CDN](//example.com/image.png) [Here](#missing-anchor)',
      '`[Inline](missing-inline.md)` and ``[Backtick `](missing-inline-2.md)``',
      '```md',
      '[Fenced](missing-fenced.md)',
      '```',
      '~~~md',
      '[Tilde](missing-tilde.md)',
      '~~~',
    ].join('\n'),
  );
  for (const name of [
    '.cache/bad.md',
    'node_modules/bad.md',
    '.agent-platform/bad.md',
    'docs/node_modules/bad.md',
  ]) {
    write(name, '[Ignored](missing.md)');
  }
  passes(run(root, '--docs'));
});

for (const destination of ['docs/missing.md', '../outside.md', '/etc/passwd', 'docs']) {
  test(`docs rejects missing, outside or non-file target: ${destination}`, (t) => {
    const { root, write } = fixture(t);
    write('README.md', `[Bad](${destination})`);
    fails(run(root, '--docs'), 'README.md');
  });
}

test('docs rejects file and directory symlinks outside the checkout', (t) => {
  const { root, write } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'sqoch-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'external.md'), 'external');
  symlinkSync(join(outside, 'external.md'), join(root, 'external.md'));
  write('README.md', '[External](external.md)');
  fails(run(root, '--docs'), 'README.md');
  write('README.md');
  rmSync(join(root, 'external.md'));
  symlinkSync(outside, join(root, 'docs', 'external-directory'));
  fails(run(root, '--docs'), 'docs/external-directory');
});

test('docs rejects missing private-tool targets regardless of local initialization', (t) => {
  const { root, write } = fixture(t);
  write('design-qa.md');
  write(
    'README.md',
    '[Kit](.agent-platform/docs/missing.md)\n[Review](.agents/skills/review-change/SKILL.md)',
  );
  fails(run(root, '--docs'), 'README.md');
  write('.agent-platform/shared/AGENTS.md', '# Initialized Kit');
  fails(run(root, '--docs'), 'README.md');
});

test('docs does not exempt arbitrary missing local tools when Kit is absent', (t) => {
  const { root, write } = fixture(t);
  write('README.md', '[Other](.agents/skills/other/SKILL.md)');
  fails(run(root, '--docs'), 'README.md');
});

test('docs checks standalone root QA reports even when no other document links to them', (t) => {
  const { root, write } = fixture(t);
  write('design-qa.md', '[Evidence](docs/missing-capture.png)');
  fails(run(root, '--docs'), 'design-qa.md');
  write('docs/missing-capture.png', 'fixture');
  passes(run(root, '--docs'));
});

test('unknown CLI flags have usage exit status 2', (t) => {
  const { root } = fixture(t);
  const result = run(root, '--unknown');
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /Usage:/);
});
