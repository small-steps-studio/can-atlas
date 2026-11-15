'use strict';
// Reference documentation of a DBC database, as Markdown or as one self-contained HTML page:
// summary, nodes, an index of all messages, one section per message (properties, signals, value
// descriptions, bit layout), value tables and attribute definitions.
//
// Everything that comes from the file is escaped. The HTML page holds no script and no external
// resource (its content security policy allows inline styles only). Anchors are made from the
// message ID, never from a name. Nothing depends on the time of the run, so the same database
// gives the same text.
//
// Bit layout tables are included for databases of up to 2,000 messages (meta.bitLayout true or
// false overrides this); a multiplexed message shows its first six combinations of multiplexor
// values.

const D = require('../dbc/decimal');
const P = require('../dbc/parse');
const M = require('../dbc/mux');
const O = require('../dbc/outline');
const Lay = require('../dbc/layout');
const Desc = require('../dbc/describe');
const V = require('../dbc/validate');
const U = require('../util');

const AUTO_LAYOUT_LIMIT = 2000;
const MAX_LAYOUT_GROUPS = 6;
const SAFE_NUMBER = /^-?\d+(?:\.\d+)?$/;

function decimalText(text) {
  const d = D.cached(text);
  return d ? D.toString(d) : String(text);
}

function nodeStats(db) {
  const sends = new Map();
  const receives = new Map();
  for (const msg of db.messages) {
    if (msg.pseudo) continue;
    const senders = new Set(msg.transmitters);
    if (msg.sender !== P.NO_NODE) senders.add(msg.sender);
    for (const n of senders) sends.set(n, (sends.get(n) || 0) + 1);
  }
  for (const msg of db.messages) {
    for (const s of msg.signals) {
      if (s.receivers.length === 1) receives.set(s.receivers[0], (receives.get(s.receivers[0]) || 0) + 1);
      else if (s.receivers.length > 1) for (const n of new Set(s.receivers)) receives.set(n, (receives.get(n) || 0) + 1);
    }
  }
  return { sends: sends, receives: receives };
}

function anchorFor(msg, used) {
  let id = isFinite(msg.frameId) ? 'msg-' + (msg.extended ? 'x' : 's') + msg.frameId.toString(16) : 'msg-i' + msg.index;
  while (used.has(id)) id += 'd' + msg.index;
  used.add(id);
  return id;
}

function frameKind(msg) { return msg.extended ? 'extended 29-bit' : 'standard 11-bit'; }
function idHex(msg) { return isFinite(msg.frameId) ? V.hex(msg.frameId) : msg.idText; }
function idDecimal(msg) { return isFinite(msg.frameId) ? String(msg.frameId) : msg.idText; }
function senderText(msg) { return msg.sender === P.NO_NODE ? '(none)' : msg.sender; }

function multiplexingText(mux, s) {
  if (!mux.any) return '';
  const hasValue = s.muxValue !== null || !!s.muxSpec;
  if (s.isMultiplexor && !hasValue) return 'multiplexor';
  if (hasValue) return (s.isMultiplexor ? 'multiplexor; ' : '') + (M.conditionText(mux, s) || 'present in every frame');
  return '';
}

const SIGNAL_HEAD = ['Key', 'Signal', 'Bits', 'Byte order', 'Value', 'Factor', 'Offset', 'Minimum', 'Maximum', 'Unit', 'Receivers', 'Multiplexing'];

function signalRow(mux, s) {
  const receivers = s.receivers.filter(function (r) { return r !== P.NO_NODE; });
  return [Lay.keyOf(s.index), s.name, s.startBit + '|' + s.length, s.little ? 'Intel (little-endian)' : 'Motorola (big-endian)', Desc.valueTypeLine(s),
    decimalText(s.factorText), decimalText(s.offsetText), decimalText(s.minText), decimalText(s.maxText), s.unit, receivers.length ? receivers.join(', ') : '(none)', multiplexingText(mux, s)];
}

function messageFacts(db, msg) {
  const facts = [['ID', idHex(msg) + ' (' + idDecimal(msg) + '), ' + frameKind(msg)], ['Data length', Desc.plural(msg.size, 'byte')], ['Sender', senderText(msg)]];
  if (msg.transmitters.length) facts.push(['Also sent by', msg.transmitters.join(', ')]);
  const cycle = P.cycleTimeOf(db, msg);
  if (cycle !== null) facts.push(['Cycle time', cycle + ' ms']);
  facts.push(['Signals', String(msg.signals.length)]);
  return facts;
}

function valueRows(msg) {
  const rows = [];
  for (const s of msg.signals) if (s.values) for (const e of s.values) rows.push([s.name, e.value.toString(), e.text]);
  return rows;
}

function layoutGroups(msg) {
  const L = Lay.layoutOf(msg);
  const groups = [];
  for (const grp of L.groups) {
    if (L.groups.length > 1 && !grp.signals.length) continue;
    if (groups.length >= MAX_LAYOUT_GROUPS) break;
    const rows = [];
    for (let byte = 0; byte < grp.grid.bytes; byte++) {
      const row = [String(byte) + (byte >= msg.size ? ' (beyond the data length)' : '')];
      for (let bit = 7; bit >= 0; bit--) row.push(Lay.cellText(grp.grid.cells[byte * 8 + bit], L.keys));
      rows.push(row);
    }
    groups.push({ title: L.groups.length === 1 ? 'Layout' : grp.title, rows: rows, overlaps: grp.overlaps });
  }
  const total = L.groups.filter(function (g) { return L.groups.length === 1 || g.signals.length; }).length + L.more;
  return { groups: groups, hidden: Math.max(0, total - groups.length) };
}

function attributeRows(db) {
  const rows = [];
  for (const d of db.attributeDefs) {
    let range = '';
    if (d.type === 'ENUM') range = (d.enumValues || []).slice(0, 20).join(', ') + ((d.enumValues || []).length > 20 ? ', ...' : '');
    else if (d.min !== null && d.max !== null) range = d.min + ' to ' + d.max;
    const def = db.attributeDefaultByName.get(d.name);
    const defText = def ? (def.value.isString ? '"' + def.value.text + '"' : def.value.text) : '';
    rows.push([d.objectType || 'database', d.name, d.type, range, defText]);
  }
  return rows;
}

function networkAttributeRows(db) {
  const rows = [];
  if (db.network && db.network.attributes) for (const [name, a] of db.network.attributes) rows.push([name, a.value.isString ? '"' + a.value.text + '"' : a.value.text]);
  return rows;
}

function summaryRows(db, messages) {
  let signals = 0;
  for (const msg of messages) signals += msg.signals.length;
  const rows = [['Messages', String(messages.length)], ['Signals', String(signals)], ['Nodes', String(db.nodes.length)], ['Value tables', String(db.valueTables.length)], ['Attribute definitions', String(db.attributeDefs.length)]];
  const independent = db.messages.find(function (m) { return m.pseudo; });
  if (independent && independent.signals.length) rows.push(['Signals without a message', String(independent.signals.length)]);
  if (db.version && db.version.text) rows.unshift(['Version', db.version.text]);
  return rows;
}

function prepare(db, meta) {
  const m = meta || {};
  const messages = O.messagesById(db);
  const used = new Set();
  const anchors = messages.map(function (msg) { return anchorFor(msg, used); });
  const layout = m.bitLayout === undefined || m.bitLayout === 'auto' ? messages.length <= AUTO_LAYOUT_LIMIT : m.bitLayout === true;
  return { name: typeof m.name === 'string' && m.name ? m.name : 'DBC file', messages: messages, anchors: anchors, layout: layout, stats: nodeStats(db) };
}

const NODE_HEAD = ['Node', 'Sends (messages)', 'Receives (signals)', 'Comment'];
const INDEX_HEAD = ['ID', 'Decimal', 'Frame', 'Name', 'Data length', 'Sender', 'Cycle time (ms)', 'Signals'];

function nodeRows(db, stats) {
  const seen = new Set();
  const rows = [];
  for (const n of db.nodes) {
    if (seen.has(n.name)) continue;
    seen.add(n.name);
    const node = db.nodeByName.get(n.name);
    rows.push([n.name, String(stats.sends.get(n.name) || 0), String(stats.receives.get(n.name) || 0), node && node.comment ? node.comment : '']);
  }
  return rows;
}

function indexRow(db, msg, anchor) {
  const cycle = P.cycleTimeOf(db, msg);
  return [{ text: idHex(msg), href: anchor }, idDecimal(msg), msg.extended ? 'extended' : 'standard', msg.name, String(msg.size), senderText(msg), cycle === null ? '' : String(cycle), String(msg.signals.length)];
}

// ---- Markdown ---------------------------------------------------------------------------------

function mdCell(c) {
  if (c && typeof c === 'object') return '[' + U.escapeMarkdown(c.text) + '](#' + c.href + ')';
  const s = String(c);
  return SAFE_NUMBER.test(s) ? s : U.escapeMarkdown(s);
}

function mdTable(head, rows) {
  const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'];
  for (const r of rows) lines.push('| ' + r.map(mdCell).join(' | ') + ' |');
  return lines;
}

function documentationMarkdown(db, meta) {
  const ctx = prepare(db, meta);
  const out = [];
  out.push('# DBC documentation: ' + U.escapeMarkdown(ctx.name), '');
  if (db.fileComment) out.push(U.escapeMarkdown(db.fileComment), '');
  out.push('## Contents', '', '- [Summary](#summary)', '- [Nodes](#nodes)', '- [Message index](#message-index)', '- [Messages](#messages)', '- [Value tables](#value-tables)', '- [Attribute definitions](#attribute-definitions)', '');
  out.push('## Summary', '');
  out.push.apply(out, mdTable(['Item', 'Value'], summaryRows(db, ctx.messages)));
  const netRows = networkAttributeRows(db);
  if (netRows.length) { out.push('', '**Database attributes**', ''); out.push.apply(out, mdTable(['Attribute', 'Value'], netRows)); }
  out.push('', '## Nodes', '');
  const nr = nodeRows(db, ctx.stats);
  if (nr.length) out.push.apply(out, mdTable(NODE_HEAD, nr)); else out.push('The file lists no nodes.');
  out.push('', '## Message index', '');
  if (ctx.messages.length) out.push.apply(out, mdTable(INDEX_HEAD, ctx.messages.map(function (msg, i) { return indexRow(db, msg, ctx.anchors[i]); })));
  else out.push('The file defines no messages.');
  out.push('', '## Messages');
  ctx.messages.forEach(function (msg, i) {
    const mux = M.analyseMux(msg);
    out.push('', '<a id="' + ctx.anchors[i] + '"></a>', '', '### ' + U.escapeMarkdown(idHex(msg) + ' ' + msg.name), '');
    if (msg.comment) out.push(U.escapeMarkdown(msg.comment), '');
    for (const f of messageFacts(db, msg)) out.push('- ' + U.escapeMarkdown(f[0]) + ': ' + U.escapeMarkdown(f[1]));
    if (msg.signals.length) {
      out.push('', '**Signals**', '');
      out.push.apply(out, mdTable(SIGNAL_HEAD, msg.signals.map(function (s) { return signalRow(mux, s); })));
      const comments = msg.signals.filter(function (s) { return s.comment; });
      if (comments.length) { out.push('', '**Signal comments**', ''); for (const s of comments) out.push('- ' + U.escapeMarkdown(s.name) + ': ' + U.escapeMarkdown(s.comment)); }
      const vr = valueRows(msg);
      if (vr.length) { out.push('', '**Value descriptions**', ''); out.push.apply(out, mdTable(['Signal', 'Raw', 'Description'], vr)); }
      if (ctx.layout) {
        const lg = layoutGroups(msg);
        out.push('', '**Bit layout**', '', U.escapeMarkdown('Rows are bytes, columns are bits 7 (most significant) to 0; a letter is the key of the signal that uses the bit, ▲ marks its most significant bit, ▼ its least significant bit, · an unused bit, ! a bit used by more than one signal.'));
        for (const g of lg.groups) {
          out.push('', U.escapeMarkdown(g.title) + (g.overlaps ? U.escapeMarkdown(' (' + Desc.plural(g.overlaps, 'bit') + ' used more than once)') : ''), '');
          out.push.apply(out, mdTable(['Byte', '7', '6', '5', '4', '3', '2', '1', '0'], g.rows));
        }
        if (lg.hidden) out.push('', U.escapeMarkdown(lg.hidden + ' further combinations of multiplexor values are not shown.'));
      }
    } else out.push('', 'The message has no signals.');
  });
  out.push('', '## Value tables', '');
  if (db.valueTables.length) {
    for (const t of db.valueTables) {
      out.push('### ' + U.escapeMarkdown(t.name), '');
      out.push.apply(out, mdTable(['Raw', 'Description'], t.entries.map(function (e) { return [e.value.toString(), e.text]; })));
      out.push('');
    }
  } else out.push('The file defines no value tables.', '');
  out.push('## Attribute definitions', '');
  const ar = attributeRows(db);
  if (ar.length) out.push.apply(out, mdTable(['Object', 'Attribute', 'Type', 'Range or values', 'Default'], ar)); else out.push('The file defines no attributes.');
  return out.join('\n') + '\n';
}

// ---- HTML -------------------------------------------------------------------------------------

const CSS = [
  ':root { color-scheme: light dark; }',
  'body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 80rem; padding: 0 1rem; }',
  'h1, h2, h3 { line-height: 1.25; }',
  'h2 { margin-top: 2.5rem; border-bottom: 1px solid currentColor; padding-bottom: .25rem; }',
  'h3 { margin-top: 2rem; }',
  'table { border-collapse: collapse; margin: .5rem 0 1rem; }',
  'caption { text-align: left; font-weight: 600; padding: .25rem 0; }',
  'th, td { border: 1px solid #8888; padding: .2rem .5rem; text-align: left; vertical-align: top; }',
  'th { background: #8882; }',
  'td.grid { text-align: center; font-family: ui-monospace, monospace; min-width: 3.5rem; }',
  'nav ul { padding-left: 1.2rem; }'
].join('\n');

function hEsc(s) { return U.escapeHtml(s); }

function htmlTable(caption, head, rows, cls) {
  const out = ['<table' + (cls ? ' class="' + cls + '"' : '') + '>', caption ? '<caption>' + hEsc(caption) + '</caption>' : ''];
  out.push('<thead><tr>' + head.map(function (h) { return '<th scope="col">' + hEsc(h) + '</th>'; }).join('') + '</tr></thead><tbody>');
  for (const r of rows) {
    out.push('<tr>' + r.map(function (c, i) {
      if (c && typeof c === 'object') return '<td><a href="#' + hEsc(c.href) + '">' + hEsc(c.text) + '</a></td>';
      if (cls === 'layout' && i > 0) return '<td class="grid">' + hEsc(c) + '</td>';
      if (cls === 'layout') return '<th scope="row">' + hEsc(c) + '</th>';
      return '<td>' + hEsc(c) + '</td>';
    }).join('') + '</tr>');
  }
  out.push('</tbody></table>');
  return out.filter(Boolean).join('\n');
}

function documentationHtml(db, meta) {
  const ctx = prepare(db, meta);
  const title = 'DBC documentation: ' + ctx.name;
  const out = [];
  out.push('<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>' + hEsc(title) + '</title>', '<style>', CSS, '</style>', '</head>', '<body>', '<main>');
  out.push('<h1>' + hEsc(title) + '</h1>');
  if (db.fileComment) out.push('<p>' + hEsc(db.fileComment) + '</p>');
  out.push('<nav aria-label="Contents"><ul><li><a href="#summary">Summary</a></li><li><a href="#nodes">Nodes</a></li><li><a href="#message-index">Message index</a></li><li><a href="#messages">Messages</a></li><li><a href="#value-tables">Value tables</a></li><li><a href="#attribute-definitions">Attribute definitions</a></li></ul></nav>');
  out.push('<h2 id="summary">Summary</h2>', htmlTable('', ['Item', 'Value'], summaryRows(db, ctx.messages)));
  const netRows = networkAttributeRows(db);
  if (netRows.length) out.push(htmlTable('Database attributes', ['Attribute', 'Value'], netRows));
  out.push('<h2 id="nodes">Nodes</h2>');
  const nr = nodeRows(db, ctx.stats);
  out.push(nr.length ? htmlTable('', NODE_HEAD, nr) : '<p>The file lists no nodes.</p>');
  out.push('<h2 id="message-index">Message index</h2>');
  out.push(ctx.messages.length ? htmlTable('', INDEX_HEAD, ctx.messages.map(function (msg, i) { return indexRow(db, msg, ctx.anchors[i]); })) : '<p>The file defines no messages.</p>');
  out.push('<h2 id="messages">Messages</h2>');
  ctx.messages.forEach(function (msg, i) {
    const mux = M.analyseMux(msg);
    out.push('<section aria-labelledby="' + ctx.anchors[i] + '">', '<h3 id="' + ctx.anchors[i] + '">' + hEsc(idHex(msg) + ' ' + msg.name) + '</h3>');
    if (msg.comment) out.push('<p>' + hEsc(msg.comment) + '</p>');
    out.push('<ul>' + messageFacts(db, msg).map(function (f) { return '<li>' + hEsc(f[0]) + ': ' + hEsc(f[1]) + '</li>'; }).join('') + '</ul>');
    if (msg.signals.length) {
      out.push(htmlTable('Signals of ' + msg.name, SIGNAL_HEAD, msg.signals.map(function (s) { return signalRow(mux, s); })));
      const comments = msg.signals.filter(function (s) { return s.comment; });
      if (comments.length) out.push('<ul>' + comments.map(function (s) { return '<li>' + hEsc(s.name) + ': ' + hEsc(s.comment) + '</li>'; }).join('') + '</ul>');
      const vr = valueRows(msg);
      if (vr.length) out.push(htmlTable('Value descriptions of ' + msg.name, ['Signal', 'Raw', 'Description'], vr));
      if (ctx.layout) {
        const lg = layoutGroups(msg);
        for (const g of lg.groups) out.push(htmlTable('Bit layout of ' + msg.name + ': ' + g.title + (g.overlaps ? ' (' + Desc.plural(g.overlaps, 'bit') + ' used more than once)' : ''), ['Byte', '7', '6', '5', '4', '3', '2', '1', '0'], g.rows, 'layout'));
        if (lg.hidden) out.push('<p>' + hEsc(lg.hidden + ' further combinations of multiplexor values are not shown.') + '</p>');
      }
    } else out.push('<p>The message has no signals.</p>');
    out.push('</section>');
  });
  out.push('<h2 id="value-tables">Value tables</h2>');
  if (db.valueTables.length) for (const t of db.valueTables) out.push(htmlTable(t.name, ['Raw', 'Description'], t.entries.map(function (e) { return [e.value.toString(), e.text]; })));
  else out.push('<p>The file defines no value tables.</p>');
  out.push('<h2 id="attribute-definitions">Attribute definitions</h2>');
  const ar = attributeRows(db);
  out.push(ar.length ? htmlTable('', ['Object', 'Attribute', 'Type', 'Range or values', 'Default'], ar) : '<p>The file defines no attributes.</p>');
  out.push('</main>', '</body>', '</html>');
  return out.join('\n') + '\n';
}

module.exports = { documentationMarkdown: documentationMarkdown, documentationHtml: documentationHtml, AUTO_LAYOUT_LIMIT: AUTO_LAYOUT_LIMIT };
