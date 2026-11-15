'use strict';
// Asks git which of the given paths the project's .gitignore would leave out of a commit, so that
// a file the public repository needs (a test fixture, a document, a script) can never be dropped
// by a pattern that is too wide. Used by scripts/release-gate.js and by the unit tests.
//
// The check runs in a throw-away repository that holds only a copy of .gitignore; the paths
// need not exist there. `git check-ignore --no-index` applies the same rules as `git add`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Folders whose every file belongs in the public repository, except the paths listed in LOCAL_ONLY.
const PUBLIC_FOLDERS = ['.github', 'docs', 'media', 'scripts', 'src', 'syntaxes', 'test'];
const PUBLIC_ROOT_FILES = ['package.json', 'language-configuration.json', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'TERMS.md', 'PRIVACY.md', '.gitignore', '.gitattributes', '.vscodeignore'];
// Local-only by design (see .gitignore): the editor smoke harness and scratch folders.
const LOCAL_ONLY = [/^test\/smoke\//, /^test\/\.tmp\//];

function walk(rel, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = rel + '/' + entry.name;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) walk(r, out); else out.push(r);
  }
  return out;
}

/** The files that must be in the public repository: { files: [relative paths with /] }. */
function publicFiles() {
  const files = [];
  for (const f of PUBLIC_ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  for (const d of PUBLIC_FOLDERS) if (fs.existsSync(path.join(ROOT, d))) walk(d, files);
  return files.filter(function (f) { return !LOCAL_ONLY.some(function (re) { return re.test(f); }); }).sort();
}

/**
 * Which of `files` does .gitignore exclude? `gitignoreText` (default: the project's .gitignore) lets a
 * test try other rules. Returns { ok: true, ignored: [paths] } or { ok: false, error } when git cannot be run.
 */
function ignoredByGit(files, gitignoreText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canatlas-gitcheck-'));
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), typeof gitignoreText === 'string' ? gitignoreText : fs.readFileSync(path.join(ROOT, '.gitignore')));
    const init = cp.spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (init.error || init.status !== 0) return { ok: false, error: 'git could not be run (' + ((init.error && init.error.message) || init.stderr || 'exit ' + init.status).toString().trim() + ')' };
    const r = cp.spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: dir, input: files.join('\0') + '\0', encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    // Exit code 0: some paths are ignored; 1: none is; anything else is an error.
    if (r.error || (r.status !== 0 && r.status !== 1)) return { ok: false, error: 'git check-ignore failed (' + ((r.error && r.error.message) || r.stderr || 'exit ' + r.status).toString().trim() + ')' };
    return { ok: true, ignored: (r.stdout || '').split('\0').filter(Boolean) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { publicFiles: publicFiles, ignoredByGit: ignoredByGit };
