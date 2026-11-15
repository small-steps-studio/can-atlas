'use strict';
// The page of the Decode Trace view (an editor webview): a filter form, the decoded rows, the
// statistics and the per-message timing. All values are written as escaped text into plain HTML
// tables, so the page is complete without scripting. The one inline script is fixed text (no
// value from the trace or the DBC is ever put into it); it adds tabs, a quick search over the
// rows shown, and sends two kinds of message to the extension:
//   { type: 'filter', filter: { text, message, from, to, channel } }   (strings from the form)
//   { type: 'export', format: 'csv' | 'json' }
// normaliseViewFilter() turns the strings of a filter message into the options of decodeTrace().

const U = require('../util');
const F = require('./formats');
const X = require('./export');

const NONCE = /^[A-Za-z0-9+/=_-]{8,128}$/;

function seconds(us) { return us === null || us === undefined || !isFinite(us) ? '' : F.formatTimeUs(us); }

/**
 * The strings of the filter form as options: { filter: { text, messages, fromUs?, toUs? }, channel, errors }.
 * "message" is a list of message names separated by commas; "from" and "to" are seconds as in the trace.
 */
function normaliseViewFilter(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const filter = { text: typeof r.text === 'string' ? r.text.trim().slice(0, 200) : '', messages: [] };
  if (typeof r.message === 'string') filter.messages = r.message.split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 200);
  const from = typeof r.from === 'string' ? r.from.trim() : '';
  const to = typeof r.to === 'string' ? r.to.trim() : '';
  if (from) { const t = F.parseTimeUs(from); if (t < 0) errors.push('The "from" time is not a number of seconds.'); else filter.fromUs = t; }
  if (to) { const t = F.parseTimeUs(to); if (t < 0) errors.push('The "to" time is not a number of seconds.'); else filter.toUs = t; }
  if (filter.fromUs !== undefined && filter.toUs !== undefined && filter.fromUs > filter.toUs) errors.push('The "from" time is after the "to" time.');
  const channel = typeof r.channel === 'string' && r.channel.trim() ? r.channel.trim().slice(0, 100) : null;
  return { filter: filter, channel: channel, errors: errors };
}

function table(columns, items, caption, id) {
  const head = columns.map(function (c) { return '<th scope="col"' + (c[2] ? ' class="num"' : '') + '>' + U.escapeHtml(c[0]) + '</th>'; }).join('');
  const body = items.map(function (it) { return '<tr>' + columns.map(function (c) { return '<td' + (c[2] ? ' class="num"' : '') + '>' + U.escapeHtml(c[1](it)) + '</td>'; }).join('') + '</tr>'; }).join('\n');
  // A wide table scrolls sideways inside its own region (a focusable region with a name, so the keyboard can scroll it); the title, the filter and the tabs stay in view.
  return '<div class="scroll" tabindex="0" role="region" aria-label="' + U.escapeHtml(caption) + '"><table' + (id ? ' id="' + id + '"' : '') + '><caption>' + U.escapeHtml(caption) + '</caption><thead><tr>' + head + '</tr></thead><tbody>\n' + body + '\n</tbody></table></div>';
}

const ROW_COLUMNS = [
  ['Time (s)', function (r) { return F.formatTimeUs(r.timeUs); }, true], ['Channel', function (r) { return r.channel; }], ['Message', function (r) { return r.messageName; }],
  ['ID', function (r) { return r.idText; }], ['Signal', function (r) { return r.signalName; }], ['Raw', function (r) { return r.rawText; }, true],
  ['Physical', function (r) { return r.physicalText; }, true], ['Unit', function (r) { return r.unit; }], ['Description', function (r) { return r.valueText; }]
];
const STAT_SIGNAL_COLUMNS = X.SIGNAL_COLUMNS.map(function (c, i) { return [c[0], c[1], i >= 4 && i <= 8]; });
const STAT_MESSAGE_COLUMNS = X.MESSAGE_COLUMNS.map(function (c, i) { return [c[0], c[1], i >= 2 && i <= 13]; });

const STYLE = [
  'body{font-family:var(--vscode-font-family,system-ui,sans-serif);color:var(--vscode-foreground,#1b1b1b);background:var(--vscode-editor-background,#fff);margin:0;padding:1rem 1.25rem}',
  'h1{font-size:1.3rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:1rem 0 .5rem}',
  'form{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:end;margin:.75rem 0}label{display:flex;flex-direction:column;font-size:.85rem;gap:.15rem}',
  'input{font:inherit;color:inherit;background:var(--vscode-input-background,#fff);border:1px solid var(--vscode-input-border,#888);padding:.2rem .4rem}',
  'button{font:inherit;color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#0b5cad);border:1px solid transparent;padding:.25rem .8rem;cursor:pointer}',
  'button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--vscode-focusBorder,#0b5cad);outline-offset:2px}',
  'nav ul{list-style:none;display:flex;gap:.5rem;padding:0;margin:.75rem 0}nav a{display:inline-block;padding:.25rem .75rem;border:1px solid var(--vscode-panel-border,#888);color:inherit;text-decoration:none}',
  'nav a[aria-selected=true]{background:var(--vscode-button-background,#0b5cad);color:var(--vscode-button-foreground,#fff)}',
  'table{border-collapse:collapse;margin:.5rem 0;font-size:.9rem}th,td{border:1px solid var(--vscode-panel-border,#888);padding:.2rem .5rem;text-align:left;vertical-align:top;white-space:nowrap}',
  'td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}caption{text-align:left;font-weight:600;padding:.25rem 0}',
  // The first column (the message or the time) stays in view when a wide table is scrolled sideways.
  '.scroll{overflow-x:auto;max-width:100%}.scroll:focus-visible{outline:2px solid var(--vscode-focusBorder,#0b5cad)}',
  'th:first-child,td:first-child{position:sticky;left:0;background:var(--vscode-editor-background,#fff)}',
  '.note{opacity:.85;margin:.25rem 0}.js section[hidden]{display:none}[hidden]{display:none}.errors{color:var(--vscode-errorForeground,#b00020)}'
].join('');

const SCRIPT = [
  '(function(){',
  'var api=typeof acquireVsCodeApi==="function"?acquireVsCodeApi():null;',
  'document.documentElement.className+=" js";',
  'var ids=["signals","statistics","messages"];',
  'var links=ids.map(function(id){return document.querySelector("nav a[href=\\"#"+id+"\\"]");});',
  'var list=document.querySelector("nav ul");if(list){list.setAttribute("role","tablist");}',
  'function show(id){ids.forEach(function(x,i){var s=document.getElementById(x);var on=x===id;if(s){s.hidden=!on;}if(links[i]){links[i].setAttribute("aria-selected",on?"true":"false");links[i].setAttribute("tabindex",on?"0":"-1");}});}',
  'links.forEach(function(a,i){if(!a){return;}a.setAttribute("role","tab");a.addEventListener("click",function(e){e.preventDefault();show(ids[i]);});',
  'a.addEventListener("keydown",function(e){var k=e.key;var n=k==="ArrowRight"?i+1:k==="ArrowLeft"?i-1:-1;if(n>=0&&n<ids.length&&links[n]){e.preventDefault();show(ids[n]);links[n].focus();}});});',
  'show("signals");',
  'var form=document.getElementById("filter-form");',
  'if(form){form.addEventListener("submit",function(e){e.preventDefault();if(!api){return;}var f=form.elements;api.postMessage({type:"filter",filter:{text:f.text.value,message:f.message.value,from:f.from.value,to:f.to.value,channel:f.channel.value}});});}',
  'Array.prototype.forEach.call(document.querySelectorAll("button[data-export]"),function(b){b.addEventListener("click",function(){if(api){api.postMessage({type:"export",format:b.getAttribute("data-export")});}});});',
  'var quick=document.getElementById("quick");var count=document.getElementById("quick-count");',
  'if(quick){quick.addEventListener("input",function(){var q=quick.value.toLowerCase();var rows=document.querySelectorAll("#rows tbody tr");var shown=0;',
  'Array.prototype.forEach.call(rows,function(tr){var hit=!q||tr.textContent.toLowerCase().indexOf(q)!==-1;tr.hidden=!hit;if(hit){shown++;}});',
  'if(count){count.textContent=q?shown+" of "+rows.length+" rows shown":"";}});}',
  '})();'
].join('\n');

function field(label, name, value, hint) {
  return '<label>' + U.escapeHtml(label) + '<input type="text" name="' + name + '" value="' + U.escapeHtml(value) + '"' + (hint ? ' placeholder="' + U.escapeHtml(hint) + '"' : '') + ' autocomplete="off"></label>';
}

/**
 * The complete HTML document. Input: { title, summary, stats, rows, filter, channel, truncated, totalMatching,
 * nonce, errors }. `summary` is the result of decodeTrace() (rows may be left out of it) or any object with
 * the same counters; `filter` is the decodeTrace filter that produced the rows.
 */
function renderTraceView(input) {
  const v = input || {};
  const nonce = String(v.nonce || '');
  if (!NONCE.test(nonce)) throw new TypeError('renderTraceView needs a nonce of 8 to 128 characters (letters, digits, + / = _ -)');
  let rows = Array.isArray(v.rows) ? v.rows : [];
  const available = rows.length;
  // displayLimit: show at most this many rows in the page (a table of 100,000 rows is slow in a webview).
  if (Number.isFinite(v.displayLimit) && v.displayLimit >= 0 && rows.length > v.displayLimit) rows = rows.slice(0, Math.floor(v.displayLimit));
  const summary = v.summary || {};
  const counters = summary.counters || {};
  const stats = v.stats || summary.stats || { signals: [], messages: [] };
  const filter = v.filter || {};
  const total = Number.isFinite(v.totalMatching) ? v.totalMatching : available;
  const truncated = v.truncated === true || rows.length < total;
  const title = String(v.title || 'Decoded trace');
  const note = truncated
    ? 'Showing the first ' + rows.length + ' of ' + total + ' matching rows. Narrow the filter to see the others; the statistics always cover the whole trace, and the exports contain every matching row.'
    : 'Showing all ' + total + ' matching rows. The exports contain every matching row.';
  const facts = [];
  if (summary.format) facts.push('Layout: ' + summary.format);
  if (counters.frames !== undefined) facts.push(counters.frames + ' frames read, ' + (counters.decodedFrames || 0) + ' of messages in the DBC, ' + (counters.unknownFrames || 0) + ' of other IDs');
  if (counters.badLines) facts.push(counters.badLines + ' lines could not be read');
  if (summary.firstTimeUs >= 0 && summary.lastTimeUs >= 0) facts.push('Time ' + seconds(summary.firstTimeUs) + ' to ' + seconds(summary.lastTimeUs) + ' s');
  if (summary.cancelled) facts.push('Cancelled: the figures cover the part that was read');
  const warnings = (summary.warnings || []).concat(v.errors || []);
  const unknown = summary.unknownIds && summary.unknownIds.items ? summary.unknownIds.items : [];
  const unknownColumns = [['ID', function (u) { return u.idText; }], ['Frames', function (u) { return String(u.frames); }, true]];
  const badColumns = [['Line', function (b) { return String(b.line); }, true], ['Reason', function (b) { return b.reason; }], ['Text', function (b) { return b.text; }]];
  const messageSection = table(STAT_MESSAGE_COLUMNS, stats.messages, 'Messages of the DBC found in the trace') +
    (unknown.length ? table(unknownColumns, unknown, 'IDs that are not in the DBC' + (summary.unknownIds.otherFrames ? ' (' + summary.unknownIds.otherFrames + ' more frames of further IDs not listed)' : '')) : '') +
    (summary.badLines && summary.badLines.length ? table(badColumns, summary.badLines, 'Lines that could not be read (the first ' + summary.badLines.length + ')') : '');
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + nonce + '\'; script-src \'nonce-' + nonce + '\'">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + U.escapeHtml(title) + '</title><style nonce="' + nonce + '">' + STYLE + '</style></head><body>' +
    '<h1>' + U.escapeHtml(title) + '</h1>' +
    '<p class="note">' + U.escapeHtml(facts.join('. ') + (facts.length ? '.' : '')) + '</p>' +
    (warnings.length ? '<ul class="errors">' + warnings.map(function (w) { return '<li>' + U.escapeHtml(w) + '</li>'; }).join('') + '</ul>' : '') +
    '<form id="filter-form" aria-label="Filter the decoded rows">' +
    field('Text in message or signal name', 'text', filter.text || '', 'for example Speed') +
    field('Message names (comma separated)', 'message', (filter.messages || []).join(', '), 'for example EngineStatus') +
    field('From (seconds)', 'from', filter.fromUs !== undefined && filter.fromUs !== null ? seconds(filter.fromUs) : '', '') +
    field('To (seconds)', 'to', filter.toUs !== undefined && filter.toUs !== null ? seconds(filter.toUs) : '', '') +
    field('Channel', 'channel', v.channel || '', 'for example can0') +
    '<button type="submit">Apply filter</button>' +
    '<button type="button" data-export="csv">Export CSV</button><button type="button" data-export="json">Export JSON</button></form>' +
    '<noscript><p class="note">Scripting is off in this view: the filter and export buttons need it. The tables below are complete without it.</p></noscript>' +
    '<nav aria-label="Sections"><ul><li><a href="#signals">Signals</a></li><li><a href="#statistics">Statistics</a></li><li><a href="#messages">Messages</a></li></ul></nav>' +
    '<section id="signals" aria-labelledby="h-signals"><h2 id="h-signals">Signals</h2><p class="note">' + U.escapeHtml(note) + '</p>' +
    '<label>Search the rows shown<input type="search" id="quick" autocomplete="off"></label><p id="quick-count" class="note" aria-live="polite"></p>' +
    table(ROW_COLUMNS, rows, 'Decoded signal values', 'rows') + '</section>' +
    '<section id="statistics" aria-labelledby="h-statistics"><h2 id="h-statistics">Statistics</h2>' + table(STAT_SIGNAL_COLUMNS, stats.signals, 'Physical values per signal') + '</section>' +
    '<section id="messages" aria-labelledby="h-messages"><h2 id="h-messages">Messages</h2>' + messageSection + '</section>' +
    '<script nonce="' + nonce + '">' + SCRIPT + '</script></body></html>\n';
}

module.exports = { renderTraceView: renderTraceView, normaliseViewFilter: normaliseViewFilter, SCRIPT: SCRIPT };
