'use strict';
// Regression tests for the independent audit of 0.1.0 (the public repository and the package texts):
//   defect 1   .gitignore dropped every *.log trace fixture, so 30 tests failed in a fresh clone,
//   defect 4   the CI workflow did not follow the repository rule (action versions, Node matrix, setup-python),
//   defect 13  PRIVACY.md left out the end of the trial in the trial record,
//   defect 14  the keyword "dbc validator" (the product checks, it does not validate against a standard).
// Also: the product ids are real and the release gate passes without any allowance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const gitcheck = require('../scripts/gitignore-check');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function gitAvailable() {
  const r = cp.spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  return !r.error && r.status === 0;
}

// ---- defect 1 --------------------------------------------------------------------------------------

test('the trace fixtures are part of the public file list', () => {
  const files = gitcheck.publicFiles();
  const logs = files.filter((f) => /^test\/fixtures\/traces\/.*\.log$/.test(f));
  assert.ok(logs.length >= 11, 'the .log fixtures: ' + logs.length);
  assert.ok(files.includes('test/fixtures/traces/sample-valid.candump.log'));
  assert.ok(files.includes('docs/problems.md') && files.includes('src/extension.js') && files.includes('media/screenshots/problems.png'));
  assert.ok(!files.some((f) => f.startsWith('test/smoke/')), 'the editor harness stays local');
});

test('.gitignore leaves out no file the public repository needs (asked of git itself)', (t) => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const result = gitcheck.ignoredByGit(gitcheck.publicFiles());
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.ignored, []);
});

test('the check does find a pattern that is too wide (the rule of the first release: *.log)', (t) => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const files = gitcheck.publicFiles();
  const wide = gitcheck.ignoredByGit(files, '*.log\n');
  assert.equal(wide.ok, true, wide.error);
  assert.ok(wide.ignored.length >= 11, 'ignored: ' + wide.ignored.length);
  assert.ok(wide.ignored.every((f) => /\.log$/.test(f)));
  assert.ok(wide.ignored.includes('test/fixtures/traces/bom.candump.log'));
  // The patterns of the project keep the log files of the top folder out, and nothing else.
  const mine = gitcheck.ignoredByGit(['debug.log', 'npm-debug.log', 'test/fixtures/traces/empty.log', 'can-atlas-0.1.0.vsix', 'STATUS.md', 'docs/getting-started.md', 'README.md', 'test/smoke/run.js'], read('.gitignore'));
  assert.deepEqual(mine.ignored.sort(), ['STATUS.md', 'can-atlas-0.1.0.vsix', 'debug.log', 'npm-debug.log', 'test/smoke/run.js'].sort());
});

test('.gitignore has no bare *.log line', () => {
  assert.ok(!/^\*\.log\s*$/m.test(read('.gitignore')));
});

test('every trace fixture the tests name exists in the tree', () => {
  const dir = path.join(ROOT, 'test', 'fixtures', 'traces');
  const have = new Set(fs.readdirSync(dir));
  const used = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((n) => /\.test\.js$/.test(n))) {
    for (const m of read('test/' + f).matchAll(/['"]([A-Za-z0-9._-]+\.(?:log|asc|csv|bin))['"]/g)) used.add(m[1]);
  }
  const named = Array.from(used).filter((n) => /^(sample-valid|bom|crlf|empty|extended-ids|lone-cr|mixed-garbage|no-final-newline|one-byte-frames|remote-and-fd|utf16le|ascii-hex|ascii-base-dec|binary-junk|extra-columns|hostile-channel|semicolon-hex|tab-delimited)\b/.test(n));
  assert.ok(named.length >= 10, 'fixture names found in the tests: ' + named.length);
  for (const n of named) assert.ok(have.has(n), n + ' is missing from test/fixtures/traces');
});

// ---- defect 4 --------------------------------------------------------------------------------------

test('the CI workflow follows the repository rule: v7 actions, Node 22 and 24, three systems, Python set up', () => {
  const ci = read('.github/workflows/ci.yml');
  const uses = Array.from(ci.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)).map((m) => m[1]);
  assert.ok(uses.length >= 5, 'uses: ' + uses.join(', '));
  for (const u of uses) assert.match(u, /^actions\/(checkout|setup-node|setup-python|upload-artifact)@v7$/, u);
  for (const name of ['checkout', 'setup-node', 'setup-python', 'upload-artifact']) assert.ok(uses.includes('actions/' + name + '@v7'), name);
  assert.match(ci, /node: \[22, 24\]/);
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.ok(!/@v[1-6]\b/.test(ci));
  assert.ok(!/node: \[[^\]]*\b20\b/.test(ci));
  // setup-python belongs to the unit job, after setup-node.
  const unit = ci.slice(ci.indexOf('  unit:'), ci.indexOf('  package:'));
  assert.ok(unit.indexOf('actions/setup-node@v7') > 0 && unit.indexOf('actions/setup-python@v7') > unit.indexOf('actions/setup-node@v7'));
  assert.match(unit, /python-version: '3\.12'/);
  // Unit tests only; no step reaches the network except the packaging tool of the package job.
  assert.ok(!/\b(curl|wget|Invoke-WebRequest)\b/.test(ci));
  assert.ok(!/secrets\./.test(ci));
  assert.match(ci, /permissions:\s*\n\s+contents: read/);
});

// ---- defects 13 and 14 -----------------------------------------------------------------------------

test('PRIVACY.md lists the end of the trial in both places that describe the trial record', () => {
  const privacy = read('PRIVACY.md');
  assert.match(privacy, /the time of the last reminder and its end are kept/);
  assert.match(privacy, /The trial record \(start, last use, last reminder and its end\)/);
  const docs = read('docs/licence.md');
  assert.match(docs, /start time, last use, end, last reminder/);
});

test('the keywords say "dbc checker", not "dbc validator", and no text promises validation against a standard', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.keywords.includes('dbc checker'));
  assert.ok(!pkg.keywords.some((k) => /validator/i.test(k)));
  assert.ok(pkg.keywords.length <= 30);
  for (const f of ['README.md', 'PRIVACY.md', 'CHANGELOG.md', 'package.json']) assert.ok(!/validator/i.test(read(f)), f);
});

// ---- the product ids and the gate ------------------------------------------------------------------

test('the release gate passes with no placeholder and no allowance (a fresh process, without the unit suite)', () => {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-gate.js'), '--skip-tests'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { CAN_ATLAS_LOCAL_PACKAGE: '' }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RELEASE GATE PASSED/);
  assert.ok(!/NOT FOR PUBLISHING|placeholder/i.test(r.stdout));
});

test('the gate refuses a placeholder product id again (control)', () => {
  const script = "const c=require('./src/licence/config');c.products.test.business='PDT_BUSINESS_TEST';let r='ok';try{c.assertShippable(require('./package.json'),{});}catch(e){r=e.message;}process.stdout.write(r);";
  const out = cp.execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.match(out, /product ids are still placeholders: test business \(PDT_BUSINESS_TEST\)/);
});
