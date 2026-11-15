'use strict';
// Run by test/regress.limits.test.js in a child process with --max-old-space-size=1024: builds databases
// at the size limits of Compare, Create DBC Documentation and Export Signals As CSV (read from
// src/procommands.js), runs each command's work, and prints the figures as one JSON line. An
// out-of-memory failure ends the process with a non-zero code, which the test reports.

const path = require('node:path');
const v8 = require('node:v8');
const H = require('./hostile');
const P = require('../../src/dbc/parse');
const D = require('../../src/pro/diff');
const docgen = require('../../src/pro/docgen');
const csvdbc = require('../../src/pro/csvdbc');
const { LIMITS } = require('../../src/procommands');

const out = { heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), scenarios: {} };
let peak = 0;
const sampler = setInterval(function () { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 25);

// A database whose text is just under `bytes` (8 signals per message, the size per message measured on a small one).
function databaseUnder(bytes, version) {
  const per = H.bigDbc(500, 8).length / 500;
  const text = H.bigDbc(Math.floor(bytes * 0.99 / per), 8);
  return version ? text.replace('VERSION "', 'VERSION "' + version) : text;
}
function scenario(name, fn) {
  peak = 0;
  const t0 = Date.now();
  const info = fn();
  out.scenarios[name] = Object.assign({ ms: Date.now() - t0, peakHeapMB: Math.round(Math.max(peak, process.memoryUsage().heapUsed) / 1048576) }, info);
}

// Compare: two files of half the limit each (together just under the limit).
scenario('compare', function () {
  const a = databaseUnder(LIMITS.compare / 2);
  const b = databaseUnder(LIMITS.compare / 2, 'x');
  const textMB = Math.round((a.length + b.length) / 1048576);
  const r = D.diffDatabases(P.parseDbc(a), P.parseDbc(b));
  return { textMB: textMB, total: r.summary.total, kind: r.summary.kind };
});
// Documentation: one file just under its limit, both formats.
scenario('documentation', function () {
  const db = P.parseDbc(databaseUnder(LIMITS.documentation));
  const md = docgen.documentationMarkdown(db, { name: 'x.dbc' });
  const html = docgen.documentationHtml(db, { name: 'x.dbc' });
  return { messages: db.messages.length, markdownMB: Math.round(md.length / 1048576), htmlMB: Math.round(html.length / 1048576) };
});
// Signal table: one file just under its limit.
scenario('signalTable', function () {
  const db = P.parseDbc(databaseUnder(LIMITS.signalTable));
  const csv = csvdbc.signalsToCsv(db, { neutralise: true });
  return { messages: db.messages.length, csvMB: Math.round(csv.length / 1048576) };
});

clearInterval(sampler);
process.stdout.write(JSON.stringify(out) + '\n');
void path;
