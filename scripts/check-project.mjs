import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = realpathSync(process.cwd());
const operations = ['setup', 'dev', 'lint', 'test', 'build', 'verify'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const outside = (path) => {
  const name = relative(root, path);
  return name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name);
};
const fail = (source, message) => {
  throw new Error(`${source}: ${message}`);
};

function localPath(path, source, file = true) {
  if (outside(path)) fail(source, `path is outside the project: ${path}`);
  let actual;
  try {
    actual = realpathSync(path);
  } catch {
    fail(source, `local path does not exist: ${relative(root, path)}`);
  }
  if (outside(actual)) fail(source, `symlink escapes the project: ${relative(root, path)}`);
  if (file && !statSync(actual).isFile()) fail(source, `not a file: ${relative(root, path)}`);
  return path;
}

function bindingPath(value, field) {
  if (!nonempty(value) || isAbsolute(value)) {
    fail('agent-platform.json', `${field} must be a nonempty relative file path`);
  }
  return localPath(resolve(root, value), `agent-platform.json: ${field}`);
}

function checkBinding() {
  let binding;
  const text = readFileSync(
    localPath(join(root, 'agent-platform.json'), 'agent-platform.json'),
    'utf8',
  );
  try {
    binding = JSON.parse(text);
  } catch {
    fail('agent-platform.json', 'invalid JSON');
  }
  if (!object(binding)) fail('agent-platform.json', 'root must be a JSON object');
  const entrypoint = readFileSync(bindingPath(binding.entrypoint, 'entrypoint'), 'utf8');
  if (!Array.isArray(binding.instructions) || !binding.instructions.length) {
    fail('agent-platform.json', 'instructions must be a nonempty array of file paths');
  }
  for (const instruction of binding.instructions) {
    bindingPath(instruction, 'instructions');
    if (!entrypoint.includes(instruction))
      fail('agent-platform.json', `entrypoint lacks pointer: ${instruction}`);
  }
  if (
    !object(binding.operations) ||
    Object.keys(binding.operations).length !== operations.length ||
    operations.some((name) => !Object.hasOwn(binding.operations, name))
  ) {
    fail(
      'agent-platform.json',
      'operations must contain exactly setup, dev, lint, test, build, verify',
    );
  }
  for (const [name, declaration] of Object.entries(binding.operations)) {
    if (
      !object(declaration) ||
      Object.keys(declaration).length !== 1 ||
      !['command', 'notApplicable'].some((key) => nonempty(declaration[key]))
    ) {
      fail(
        'agent-platform.json',
        `operations.${name} requires one nonempty command or notApplicable reason`,
      );
    }
  }
  console.log('Project binding passed.');
}

function withoutCode(text) {
  let fence;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined;
        return '';
      }
      if (marker) {
        fence = marker[1];
        return '';
      }
      return line;
    })
    .join('\n')
    .replace(/(`+)(?!`)[\s\S]*?\1(?!`)/g, '');
}

function documentsBelow(directory, seen = new Set()) {
  localPath(directory, relative(root, directory), false);
  const actual = realpathSync(directory);
  if (seen.has(actual)) return [];
  seen.add(actual);
  return readdirSync(directory).flatMap((name) => {
    if (['.agent-platform', '.cache', '.git', 'node_modules'].includes(name)) return [];
    const path = localPath(join(directory, name), relative(root, join(directory, name)), false);
    return statSync(path).isDirectory()
      ? documentsBelow(path, seen)
      : name.endsWith('.md')
        ? [path]
        : [];
  });
}

function checkDocs() {
  const sources = ['AGENTS.md', 'README.md', 'backend/TDD.md'].map((name) => join(root, name));
  sources.push(
    ...readdirSync(root)
      .filter((name) => name.endsWith('.md') && !['AGENTS.md', 'README.md'].includes(name))
      .map((name) => join(root, name)),
  );
  sources.push(...documentsBelow(join(root, 'docs')));
  // Project inline links/images only; reference links and anchor names are not validated.
  const links = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]*))(?:\s+"[^"\n]*")?\s*\)/g;
  for (const source of sources) {
    const label = relative(root, source);
    const text = withoutCode(readFileSync(localPath(source, label), 'utf8'));
    for (const match of text.matchAll(links)) {
      const destination = match[1] ?? match[2];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue;
      let name;
      try {
        name = decodeURIComponent(destination.split(/[?#]/)[0]);
      } catch {
        fail(label, `invalid escaped link path: ${destination}`);
      }
      if (!name) continue;
      const target = resolve(dirname(source), name);
      if (outside(target)) fail(label, `link is outside the project: ${destination}`);
      localPath(target, label);
    }
  }
  console.log(
    `Local inline links passed in ${sources.length} Markdown files; anchors are not checked.`,
  );
}

const flags = process.argv.slice(2);
if (flags.length !== 1 || !['--binding', '--docs'].includes(flags[0])) {
  console.error('Usage: node scripts/check-project.mjs --binding | --docs');
  process.exitCode = 2;
} else {
  try {
    if (flags[0] === '--binding') checkBinding();
    else checkDocs();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
