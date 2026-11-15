'use strict';
// Inventory of several DBC files: size and problem counts per file, and the collisions between
// files that matter when the files are used on the same bus:
//   id            the same frame ID (and frame format) carries different message names in different files (error)
//   name          the same message name has different IDs in different files (warning)
//   signal-layout the same ID and name, but a different data length or different signals or layouts (warning;
//                 also reported when the same ID is used by other names in other files)
// Node names that several files define are only counted. The reports are Markdown, HTML (no
// script, strict content security policy) and CSV (formula cells neutralised); every text from
// the files is escaped.

const D = require('../dbc/decimal');
const P = require('../dbc/parse');
const V = require('../dbc/validate');
const U = require('../util');

const MAX_COLLISIONS = 5000;
const MAX_DIFFERENCES = 50;
const KIND_ORDER = { id: 0, name: 1, 'signal-layout': 2 };
const FIELD_NAMES = ['start bit', 'length', 'byte order', 'sign', 'value type', 'factor', 'offset', 'multiplexing'];

function decimalText(text) {
  const d = D.cached(text);
  return d ? D.toString(d) : String(text);
}

function signalSignature(s) {
  return [s.startBit, s.length, s.little ? 'intel' : 'motorola', s.signed ? 'signed' : 'unsigned', s.valueType === 1 ? 'float32' : s.valueType === 2 ? 'float64' : 'integer',
    decimalText(s.factorText), decimalText(s.offsetText), s.muxText || 'none'].join('|');
}

function changedFields(a, b) {
  const x = a.split('|');
  const y = b.split('|');
  const out = [];
  for (let i = 0; i < FIELD_NAMES.length; i++) if (x[i] !== y[i]) out.push(FIELD_NAMES[i] + ' ' + x[i] + ' -> ' + y[i]);
  return out.join('; ');
}

function idLabel(m) { return V.hex(m.frameId) + (m.extended ? ' (extended)' : ' (standard)'); }

function listFiles(names) {
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? shown + ' and ' + (names.length - 4) + ' more' : shown;
}

function differences(first, other) {
  const out = [];
  if (first.size !== other.size) out.push({ signal: '(data length)', file: other.file, kind: 'changed', detail: first.size + ' -> ' + other.size + ' bytes' });
  for (const [name, sig] of first.sigs) {
    const o = other.sigs.get(name);
    if (o === undefined) out.push({ signal: name, file: other.file, kind: 'missing', detail: 'only in ' + first.file });
    else if (o !== sig) out.push({ signal: name, file: other.file, kind: 'changed', detail: changedFields(sig, o) });
  }
  for (const name of other.sigs.keys()) if (!first.sigs.has(name)) out.push({ signal: name, file: other.file, kind: 'added', detail: 'only in ' + other.file });
  return out;
}

/**
 * Reads the files ({ name, text } with a workspace-relative name) and returns { files, collisions,
 * nodes, totals, cut }. Options: maxCollisions (default 5000), disabledCodes (problem codes that
 * are not counted).
 */
function inventoryFiles(files, options) {
  const opts = options || {};
  const maxCollisions = Math.max(1, opts.maxCollisions || MAX_COLLISIONS);
  const infos = [];
  const byKey = new Map();
  const byName = new Map();
  const nodeFiles = new Map();
  const totals = { files: 0, messages: 0, signals: 0, errors: 0, warnings: 0, bytes: 0, sharedNodes: 0, collisions: { id: 0, name: 0, 'signal-layout': 0 } };
  for (const f of files) {
    const text = typeof f.text === 'string' ? f.text : '';
    const db = P.parseDbc(text);
    const result = V.validate(db, { maxProblems: 1, text: text, disabledCodes: opts.disabledCodes });
    let messages = 0;
    let signals = 0;
    const seen = new Set();
    for (const m of db.messages) {
      signals += m.signals.length;
      if (m.pseudo) continue;
      messages++;
      if (!isFinite(m.frameId)) continue;
      const key = (m.extended ? 'x' : 's') + m.frameId;
      if (seen.has(key)) continue;
      seen.add(key);
      const sigs = new Map();
      for (const s of m.signals) sigs.set(s.name, signalSignature(s));
      const rec = { file: f.name, key: key, name: m.name, id: idLabel(m), size: m.size, sigs: sigs };
      let list = byKey.get(key);
      if (!list) { list = []; byKey.set(key, list); }
      list.push(rec);
      let named = byName.get(m.name);
      if (!named) { named = []; byName.set(m.name, named); }
      named.push(rec);
    }
    const nodeNames = new Set(db.nodes.map(function (n) { return n.name; }));
    for (const n of nodeNames) nodeFiles.set(n, (nodeFiles.get(n) || 0) + 1);
    const bytes = Buffer.byteLength(text, 'utf8');
    infos.push({ name: f.name, version: db.version ? db.version.text : '', messages: messages, signals: signals, nodes: nodeNames.size, errors: result.counts.error, warnings: result.counts.warning, bytes: bytes });
    totals.files++;
    totals.messages += messages;
    totals.signals += signals;
    totals.errors += result.counts.error;
    totals.warnings += result.counts.warning;
    totals.bytes += bytes;
  }

  const collisions = [];
  function add(c) {
    totals.collisions[c.kind]++;
    if (collisions.length < maxCollisions) collisions.push(c);
  }
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const groups = new Map();
    for (const e of list) {
      let g = groups.get(e.name);
      if (!g) { g = []; groups.set(e.name, g); }
      g.push(e);
    }
    if (groups.size > 1) {
      add({
        kind: 'id', severity: 'error', key: list[0].id,
        text: 'The ID ' + list[0].id + ' is used by different messages: ' + listFiles(list.map(function (e) { return e.name + ' in ' + e.file; })) + '.',
        entries: list.map(function (e) { return { file: e.file, message: e.name, id: e.id }; })
      });
    }
    // Entries with the same name are compared with each other (the first one is the reference).
    for (const same of groups.values()) {
      if (same.length < 2) continue;
      const first = same[0];
      const diffs = [];
      for (let i = 1; i < same.length; i++) for (const d of differences(first, same[i])) diffs.push(d);
      if (diffs.length) {
        add({
          kind: 'signal-layout', severity: 'warning', key: first.id + ' ' + first.name,
          text: 'The message ' + first.name + ' (' + first.id + ') is defined differently in ' + listFiles(same.map(function (e) { return e.file; })) + ': ' + diffs.length + ' difference' + (diffs.length === 1 ? '' : 's') + ' compared with ' + first.file + '.',
          entries: same.map(function (e) { return { file: e.file, message: e.name, id: e.id }; }),
          differences: diffs.slice(0, MAX_DIFFERENCES), moreDifferences: Math.max(0, diffs.length - MAX_DIFFERENCES)
        });
      }
    }
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const keys = new Set(list.map(function (e) { return e.key; }));
    const fileNames = new Set(list.map(function (e) { return e.file; }));
    if (keys.size < 2 || fileNames.size < 2) continue;
    add({
      kind: 'name', severity: 'warning', key: name,
      text: 'The message name ' + name + ' has different IDs: ' + listFiles(list.map(function (e) { return e.id + ' in ' + e.file; })) + '.',
      entries: list.map(function (e) { return { file: e.file, message: e.name, id: e.id }; })
    });
  }
  collisions.sort(function (a, b) { return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
  const nodes = [];
  for (const [name, count] of nodeFiles) if (count > 1) nodes.push({ name: name, files: count });
  nodes.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  totals.sharedNodes = nodes.length;
  const all = totals.collisions.id + totals.collisions.name + totals.collisions['signal-layout'];
  return { files: infos, collisions: collisions, nodes: nodes, totals: totals, cut: all > collisions.length };
}

// ---- reports ----------------------------------------------------------------------------------

function title(meta) { return 'DBC inventory: ' + (meta && typeof meta.name === 'string' && meta.name ? meta.name : 'workspace'); }

function summaryLine(r) {
  const t = r.totals;
  const c = t.collisions.id + t.collisions.name + t.collisions['signal-layout'];
  return t.files + ' file' + (t.files === 1 ? '' : 's') + ', ' + t.messages + ' message' + (t.messages === 1 ? '' : 's') + ', ' + t.signals + ' signal' + (t.signals === 1 ? '' : 's') + '. In the files: ' + t.errors + ' error' + (t.errors === 1 ? '' : 's') + ' and ' +
    t.warnings + ' warning' + (t.warnings === 1 ? '' : 's') + '. Between the files: ' + c + ' collision' + (c === 1 ? '' : 's') + ' (' + t.collisions.id + ' ID, ' + t.collisions.name + ' name, ' + t.collisions['signal-layout'] + ' layout).';
}

const FILE_HEAD = ['File', 'Version', 'Messages', 'Signals', 'Nodes', 'Errors', 'Warnings', 'Size (bytes)'];
function fileRow(f) { return [f.name, f.version, String(f.messages), String(f.signals), String(f.nodes), String(f.errors), String(f.warnings), String(f.bytes)]; }

const KIND_TITLE = { id: 'ID collisions (error)', name: 'Name collisions (warning)', 'signal-layout': 'Layout differences (warning)' };

function maxRows(options) { return Math.max(1, (options && options.maxRows) || 2000); }

const SAFE_NUMBER = /^-?\d+(?:\.\d+)?$/;
function md(c) { const s = String(c); return SAFE_NUMBER.test(s) ? s : U.escapeMarkdown(s); }
function mdTable(head, rows) {
  const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'];
  for (const r of rows) lines.push('| ' + r.map(md).join(' | ') + ' |');
  return lines;
}

function inventoryMarkdown(result, meta, options) {
  const limit = maxRows(options);
  const out = ['# ' + U.escapeMarkdown(title(meta)), '', U.escapeMarkdown(summaryLine(result)), '', '## Files', ''];
  out.push.apply(out, mdTable(FILE_HEAD, result.files.slice(0, limit).map(fileRow)));
  if (result.files.length > limit) out.push('', U.escapeMarkdown('and ' + (result.files.length - limit) + ' more files.'));
  out.push('', '## Collisions between files', '');
  if (!result.collisions.length) out.push('No ID, name or layout collision between the files.');
  let shown = 0;
  for (const kind of ['id', 'name', 'signal-layout']) {
    const list = result.collisions.filter(function (c) { return c.kind === kind; });
    if (!list.length) continue;
    out.push('', '### ' + KIND_TITLE[kind], '');
    for (const c of list) {
      if (shown++ >= limit) break;
      out.push('- ' + U.escapeMarkdown(c.text));
      for (const d of c.differences || []) out.push('  - ' + U.escapeMarkdown(d.signal + ' (' + d.file + '): ' + d.kind + (d.detail ? ', ' + d.detail : '')));
      if (c.moreDifferences) out.push('  - ' + U.escapeMarkdown('and ' + c.moreDifferences + ' more differences'));
    }
  }
  if (result.cut || shown > limit) out.push('', U.escapeMarkdown('The list is shortened; the totals above count every collision.'));
  out.push('', '## Node names defined in several files', '');
  if (result.nodes.length) out.push.apply(out, mdTable(['Node', 'Files'], result.nodes.slice(0, limit).map(function (n) { return [n.name, String(n.files)]; })));
  else out.push('No node name is defined in more than one file.');
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

const hEsc = U.escapeHtml;
function htmlTable(caption, head, rows) {
  return ['<table>', '<caption>' + hEsc(caption) + '</caption>', '<thead><tr>' + head.map(function (h) { return '<th scope="col">' + hEsc(h) + '</th>'; }).join('') + '</tr></thead>', '<tbody>',
    rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return i === 0 ? '<th scope="row">' + hEsc(c) + '</th>' : '<td>' + hEsc(c) + '</td>'; }).join('') + '</tr>'; }).join('\n'), '</tbody>', '</table>'].join('\n');
}

function inventoryHtml(result, meta, options) {
  const limit = maxRows(options);
  const t = title(meta);
  const out = ['<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>' + hEsc(t) + '</title>', '<style>',
    ':root { color-scheme: light dark; }', 'body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 80rem; padding: 0 1rem; }',
    'table { border-collapse: collapse; margin: .5rem 0 1rem; }', 'caption { text-align: left; font-weight: 600; padding: .25rem 0; }',
    'th, td { border: 1px solid #8888; padding: .2rem .5rem; text-align: left; vertical-align: top; }', 'th { background: #8882; }', '</style>', '</head>', '<body>', '<main>',
    '<h1>' + hEsc(t) + '</h1>', '<p>' + hEsc(summaryLine(result)) + '</p>', '<h2>Files</h2>', htmlTable('Files', FILE_HEAD, result.files.slice(0, limit).map(fileRow))];
  if (result.files.length > limit) out.push('<p>' + hEsc('and ' + (result.files.length - limit) + ' more files.') + '</p>');
  out.push('<h2>Collisions between files</h2>');
  if (!result.collisions.length) out.push('<p>No ID, name or layout collision between the files.</p>');
  let shown = 0;
  for (const kind of ['id', 'name', 'signal-layout']) {
    const list = result.collisions.filter(function (c) { return c.kind === kind; });
    if (!list.length) continue;
    out.push('<h3>' + hEsc(KIND_TITLE[kind]) + '</h3>', '<ul>');
    for (const c of list) {
      if (shown++ >= limit) break;
      let item = '<li>' + hEsc(c.text);
      if (c.differences && c.differences.length) {
        item += '<ul>' + c.differences.map(function (d) { return '<li>' + hEsc(d.signal + ' (' + d.file + '): ' + d.kind + (d.detail ? ', ' + d.detail : '')) + '</li>'; }).join('');
        if (c.moreDifferences) item += '<li>' + hEsc('and ' + c.moreDifferences + ' more differences') + '</li>';
        item += '</ul>';
      }
      out.push(item + '</li>');
    }
    out.push('</ul>');
  }
  if (result.cut || shown > limit) out.push('<p>The list is shortened; the totals above count every collision.</p>');
  out.push('<h2>Node names defined in several files</h2>');
  out.push(result.nodes.length ? htmlTable('Nodes', ['Node', 'Files'], result.nodes.slice(0, limit).map(function (n) { return [n.name, String(n.files)]; })) : '<p>No node name is defined in more than one file.</p>');
  out.push('</main>', '</body>', '</html>');
  return out.join('\n') + '\n';
}

const FILE_COLUMNS = ['file', 'version', 'messages', 'signals', 'nodes', 'errors', 'warnings', 'bytes'];
const COLLISION_COLUMNS = ['kind', 'severity', 'key', 'file', 'message', 'id', 'signal', 'change', 'detail'];

/** CSV of the files (options.table "files", the default) or of the collisions (options.table "collisions"). */
function inventoryCsv(result, meta, options) {
  const neutralise = !(options && options.neutralise === false);
  const collisions = options && options.table === 'collisions';
  const out = [U.csvRow(collisions ? COLLISION_COLUMNS : FILE_COLUMNS, false)];
  if (!collisions) {
    for (const f of result.files) out.push(U.csvRow([f.name, f.version, f.messages, f.signals, f.nodes, f.errors, f.warnings, f.bytes], neutralise));
  } else {
    for (const c of result.collisions) {
      for (const e of c.entries) out.push(U.csvRow([c.kind, c.severity, c.key, e.file, e.message, e.id, '', '', ''], neutralise));
      for (const d of c.differences || []) out.push(U.csvRow([c.kind, c.severity, c.key, d.file, '', '', d.signal, d.kind, d.detail], neutralise));
    }
  }
  return out.join('');
}

module.exports = { inventoryFiles: inventoryFiles, inventoryMarkdown: inventoryMarkdown, inventoryHtml: inventoryHtml, inventoryCsv: inventoryCsv, FILE_COLUMNS: FILE_COLUMNS, COLLISION_COLUMNS: COLLISION_COLUMNS };
