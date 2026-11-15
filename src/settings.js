'use strict';
// The default value of every setting (the manifest declares the same values; a test compares them).

const DEFAULTS = Object.freeze({
  maxFileSizeMB: 20,
  maxProblems: 1000,
  validateOnType: true,
  'hover.enabled': true,
  'problems.disabledCodes': Object.freeze([]),
  'workspace.include': '**/*.dbc',
  'workspace.exclude': '**/{node_modules,.git}/**',
  'workspace.maxFiles': 2000,
  'trace.maxTableRows': 100000,
  'export.neutraliseFormulas': true
});

module.exports = { DEFAULTS: DEFAULTS };
