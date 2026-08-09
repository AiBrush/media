import { readdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDirectory = resolve(root, 'docs');
const requiredFiles = [
  'README.md',
  'docs/README.md',
  'docs/getting-started.md',
  'docs/inputs-and-outputs.md',
  'docs/operations.md',
  'docs/api-reference.md',
  'docs/runtime-and-capabilities.md',
  'docs/errors-and-lifecycle.md',
  'docs/driver-authoring.md',
  'docs/development.md',
  'examples/README.md',
] as const;

const excludedPublicNarrative = [
  { pattern: /\bADR-\d+/i, label: 'internal decision identifier' },
  { pattern: /\bSOTA\b/i, label: 'internal comparison label' },
  { pattern: /\bmarathon\b/i, label: 'internal project label' },
  { pattern: /\bpunch[- ]list\b/i, label: 'internal task list' },
  { pattern: /\btarget spec(?:ification)?\b/i, label: 'internal specification label' },
  { pattern: /\bprogress (?:log|ledger|report)\b/i, label: 'internal progress record' },
] as const;

const failures: string[] = [];
const markdownFiles = [
  resolve(root, 'README.md'),
  ...(await collectMarkdown(docsDirectory)),
  resolve(root, 'examples/README.md'),
];

for (const required of requiredFiles) {
  if (!(await exists(resolve(root, required)))) failures.push(`missing required file: ${required}`);
}

for (const file of markdownFiles) {
  const display = relative(root, file);
  const contents = await Bun.file(file).text();
  for (const excluded of excludedPublicNarrative) {
    if (excluded.pattern.test(contents)) {
      failures.push(`${display}: contains ${excluded.label}`);
    }
  }
  for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1]?.trim();
    if (rawTarget === undefined || shouldSkipLink(rawTarget)) continue;
    const unwrapped =
      rawTarget.startsWith('<') && rawTarget.endsWith('>') ? rawTarget.slice(1, -1) : rawTarget;
    const pathPart = unwrapped.split('#', 1)[0];
    if (pathPart === undefined || pathPart === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      failures.push(`${display}: invalid encoded link '${rawTarget}'`);
      continue;
    }
    if (!(await exists(resolve(dirname(file), decoded)))) {
      failures.push(`${display}: broken local link '${rawTarget}'`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.info(`Documentation check passed (${markdownFiles.length} Markdown files).`);
}

async function collectMarkdown(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdown(path)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

function shouldSkipLink(target: string): boolean {
  return (
    target.startsWith('#') ||
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:')
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
