'use strict';
// Shared helpers of the trace tests: fixture access, the sample database, a seeded random source.

const fs = require('node:fs');
const path = require('node:path');
const { parseDbc } = require('../../src/dbc/parse');
const { sampleFor } = require('../../src/samples');
const { mulberry32, DIR } = require('./trace-fixtures-build');

let sampleDb = null;

/** The parsed sample DBC file (shared, never changed by the tests). */
function loadSampleDb() {
  if (!sampleDb) sampleDb = parseDbc(sampleFor('valid').text);
  return sampleDb;
}

function fixturePath(name) { return path.join(DIR, name); }
function readFixture(name) { return fs.readFileSync(fixturePath(name)); }
function readFixtureText(name) { return fs.readFileSync(fixturePath(name), 'utf8'); }

/** Row summary used in comparisons: message, signal, raw, physical, description. */
function brief(row) { return [row.messageName, row.signalName, row.rawText, row.physicalText, row.valueText].join('|'); }

module.exports = { loadSampleDb: loadSampleDb, fixturePath: fixturePath, readFixture: readFixture, readFixtureText: readFixtureText, brief: brief, mulberry32: mulberry32, FIXTURE_DIR: DIR };
