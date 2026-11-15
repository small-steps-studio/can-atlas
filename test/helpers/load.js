'use strict';
// Shared helpers of the shell tests: the invented sample files as text and as databases, the
// problem codes of a text, and the root folder of the project.

const path = require('node:path');
const P = require('../../src/dbc/parse');
const { validate } = require('../../src/dbc/validate');
const samples = require('../../src/samples');

const ROOT = path.join(__dirname, '..', '..');

/** The text of a sample: valid, problems or trace. */
function sampleText(kind) { return samples.sampleFor(kind).text; }

/** { db, text } of a sample DBC. */
function sampleDb(kind) {
  const text = sampleText(kind || 'valid');
  return { db: P.parseDbc(text), text: text };
}

/** The distinct problem codes of a text as a sorted list, per severity. */
function codesOf(text, options) {
  const db = P.parseDbc(text);
  const v = validate(db, Object.assign({ text: text }, options || {}));
  const out = { errors: [], warnings: [], notes: [] };
  for (const p of v.problems) {
    const k = p.severity === 'error' ? 'errors' : p.severity === 'warning' ? 'warnings' : 'notes';
    if (out[k].indexOf(p.code) === -1) out[k].push(p.code);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

module.exports = { ROOT: ROOT, sampleText: sampleText, sampleDb: sampleDb, codesOf: codesOf };
