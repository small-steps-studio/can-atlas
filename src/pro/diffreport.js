'use strict';
// Reports of a database comparison (see diff.js) as Markdown, HTML and CSV. Every value that
// comes from a DBC file is escaped for the format it is written in; the HTML page holds no script,
// loads nothing and carries a content security policy that forbids both.

const U = require('../util');

const CLASS_ORDER = ['BREAKING', 'NON-BREAKING', 'COSMETIC'];
const CLASS_TITLE = { 'BREAKING': 'Breaking changes', 'NON-BREAKING': 'Non-breaking changes', 'COSMETIC': 'Cosmetic changes' };
const CLASS_EXPLAIN = {
  'BREAKING': 'An existing receiver decodes bytes differently or no longer finds something.',
  'NON-BREAKING': 'Something was added or relaxed that existing receivers do not depend on.',
  'COSMETIC': 'Documentation, order or spelling only.'
};
const KIND_LABEL = { database: 'database', node: 'node', message: 'messages', signal: 'signals', valueTable: 'value table', attribute: 'attribute', valueDescription: 'value description', multiplexing: 'multiplexing' };
const CLASS_CSS = { 'BREAKING': 'breaking', 'NON-BREAKING': 'nonbreaking', 'COSMETIC': 'cosmetic' };

/** True for control characters and text direction or zero-width marks. */
function isHidden(code) {
  return code < 32 || code === 127 || code === 0x85 || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

/** Hidden characters are shown as [U+XXXX] so they cannot conceal or reorder anything. */
function visible(value) {
  const s = String(value === undefined || value === null ? '' : value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += isHidden(c) ? '[U+' + c.toString(16).toUpperCase().padStart(4, '0') + ']' : s[i];
  }
  return out;
}

const JOINER = String.fromCharCode(0x2060);

/** Text for Markdown: shown safely, and addresses and e-mail addresses are kept from turning into links. */
function plain(value) {
  const text = visible(value).split('://').join(':' + JOINER + '//').replace(/www\./gi, 'www' + JOINER + '.').split('@').join('@' + JOINER);
  return U.escapeMarkdown(text);
}

function metaOf(meta) {
  const m = meta || {};
  return { oldName: m.oldName === undefined ? 'old file' : String(m.oldName), newName: m.newName === undefined ? 'new file' : String(m.newName) };
}

function where(c) {
  const parts = [];
  if (c.message) parts.push(c.message + (c.id ? ' (' + c.id + ')' : ''));
  if (c.signal) parts.push(c.signal);
  return parts.length ? parts.join(' / ') : KIND_LABEL[c.kind] || c.kind;
}

function groups(result) {
  const out = [];
  for (const cls of CLASS_ORDER) {
    const list = result.changes.filter(function (c) { return c.class === cls; });
    if (list.length) out.push({ cls: cls, list: list });
  }
  return out;
}

/** The comparison as a Markdown document. */
function diffMarkdown(result, meta) {
  const m = metaOf(meta);
  const lines = [];
  lines.push('# DBC comparison');
  lines.push('');
  lines.push('* Old: ' + U.codeSpan(visible(m.oldName)));
  lines.push('* New: ' + U.codeSpan(visible(m.newName)));
  lines.push('');
  lines.push(result.summary.text);
  for (const note of result.notes || []) lines.push('', note);
  for (const g of groups(result)) {
    lines.push('', '## ' + CLASS_TITLE[g.cls] + ' (' + g.list.length + ')', '', CLASS_EXPLAIN[g.cls], '');
    lines.push('| Code | Where | Change |');
    lines.push('| --- | --- | --- |');
    for (const c of g.list) {
      lines.push('| ' + U.codeSpan(c.code) + ' | ' + plain(where(c)) + ' | ' + plain(c.text) + ' |');
    }
  }
  return lines.join('\n') + '\n';
}

/** The comparison as one self-contained HTML page (no script, no external loads). */
function diffHtml(result, meta) {
  const m = metaOf(meta);
  const e = function (v) { return U.escapeHtml(visible(v)); };
  const out = [];
  out.push('<!DOCTYPE html>');
  out.push('<html lang="en">');
  out.push('<head>');
  out.push('<meta charset="utf-8">');
  out.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push('<title>DBC comparison</title>');
  out.push('<style>');
  out.push('body { font-family: system-ui, sans-serif; margin: 1.5rem; line-height: 1.45; color: #1d1d1f; background: #ffffff; }');
  out.push('table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1.5rem; }');
  out.push('caption { text-align: left; font-weight: 600; padding: 0.25rem 0; }');
  out.push('th, td { border: 1px solid #8a8f98; padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }');
  out.push('th { background: #e8ebf0; }');
  out.push('code { font-family: ui-monospace, Consolas, monospace; }');
  out.push('.badge { font-weight: 700; white-space: nowrap; padding: 0.1rem 0.4rem; border: 1px solid; }');
  out.push('.breaking { background: #fde8e8; color: #7a1010; border-color: #7a1010; }');
  out.push('.nonbreaking { background: #e6f4ea; color: #12521f; border-color: #12521f; }');
  out.push('.cosmetic { background: #eceef2; color: #383c44; border-color: #383c44; }');
  out.push('</style>');
  out.push('</head>');
  out.push('<body>');
  out.push('<main>');
  out.push('<h1>DBC comparison</h1>');
  out.push('<p>Old: <code>' + e(m.oldName) + '</code><br>New: <code>' + e(m.newName) + '</code></p>');
  out.push('<p>' + e(result.summary.text) + '</p>');
  for (const note of result.notes || []) out.push('<p>' + e(note) + '</p>');
  for (const g of groups(result)) {
    out.push('<section>');
    out.push('<h2>' + e(CLASS_TITLE[g.cls]) + ' (' + g.list.length + ')</h2>');
    out.push('<p>' + e(CLASS_EXPLAIN[g.cls]) + '</p>');
    out.push('<table>');
    out.push('<caption>' + e(CLASS_TITLE[g.cls]) + '</caption>');
    out.push('<thead><tr><th scope="col">Class</th><th scope="col">Code</th><th scope="col">Where</th><th scope="col">Change</th></tr></thead>');
    out.push('<tbody>');
    for (const c of g.list) {
      out.push('<tr><td><span class="badge ' + CLASS_CSS[c.class] + '">' + e(c.class) + '</span></td><td><code>' + e(c.code) + '</code></td><td>' + e(where(c)) + '</td><td>' + e(c.text) + '</td></tr>');
    }
    out.push('</tbody>');
    out.push('</table>');
    out.push('</section>');
  }
  out.push('</main>');
  out.push('</body>');
  out.push('</html>');
  return out.join('\n') + '\n';
}

const CSV_HEADER = ['Class', 'Code', 'Kind', 'Message', 'Identifier', 'Signal', 'Field', 'Old value', 'New value', 'Change'];

/** The comparison as CSV (RFC 4180, CRLF). `options.neutralise` (default true) protects spreadsheet formulas. */
function diffCsv(result, meta, options) {
  const neutralise = !options || options.neutralise !== false;
  void meta;
  let out = U.csvRow(CSV_HEADER, neutralise);
  // A table without a change row would say nothing about the files; when they still differ, one row says so.
  if (!result.changes.length && result.summary && result.summary.identical === false) out += U.csvRow(['', '', 'summary', '', '', '', '', '', '', result.summary.text], neutralise);
  for (const c of result.changes) {
    out += U.csvRow([c.class, c.code, c.kind, c.message, c.id, c.signal, c.field, c.oldValue, c.newValue, c.text], neutralise);
  }
  return out;
}

module.exports = { diffMarkdown: diffMarkdown, diffHtml: diffHtml, diffCsv: diffCsv, visible: visible, CSV_HEADER: CSV_HEADER };
