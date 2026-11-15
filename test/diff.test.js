'use strict';
// Tests of the DBC comparison. The expected results of the hand-classified cases were written down
// from the rules in docs/diff-rules.md before the product was run on them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../src/dbc/parse');
const X = require('../src/pro/diff');
const S = require('../src/samples');

const B = 'BREAKING';
const N = 'NON-BREAKING';
const C = 'COSMETIC';

// ---- the base file and its parts -------------------------------------------------------------

const L_SPEED = ' SG_ Speed : 0|16@1+ (0.25,0) [0|8000] "rpm" Ecu2,Ecu3\n';
const L_TEMP = ' SG_ Temp : 16|8@1+ (1,-40) [-40|150] "degC" Ecu2\n';
const L_RUN = ' SG_ Run : 24|1@1+ (1,0) [0|1] "" Ecu2\n';
const L_PAGE = ' SG_ Page M : 0|8@1+ (1,0) [0|2] "" Ecu1\n';
const L_DIST = ' SG_ Dist m0 : 8|16@1+ (0.1,0) [0|6553.5] "km" Ecu1\n';
const L_AVG = ' SG_ Avg m1 : 8|16@1+ (0.1,0) [0|6553.5] "km/h" Ecu1\n';
const L_SEL = ' SG_ Sel : 7|4@0+ (1,0) [0|7] "" Ecu1\n';

const HEAD = [
  'VERSION "1.0"', '', '', 'NS_ :', '\tCM_', '\tBA_DEF_', '\tBA_', '\tVAL_', '\tVAL_TABLE_', '\tBA_DEF_DEF_', '\tSG_MUL_VAL_', '\tBO_TX_BU_', '', 'BS_:', '',
  'BU_: Ecu1 Ecu2 Ecu3', '', 'VAL_TABLE_ Gear 2 "Drive" 1 "Reverse" 0 "Park" ;', '', ''
].join('\n');
const ENGINE = 'BO_ 256 Engine: 8 Ecu1\n' + L_SPEED + L_TEMP + L_RUN + '\n';
const PAGES = 'BO_ 512 Pages: 8 Ecu2\n' + L_PAGE + L_DIST + L_AVG + '\n';
const SHIFT = 'BO_ 768 Shift: 2 Ecu3\n' + L_SEL + '\n';
const TAIL = [
  'CM_ SG_ 256 Speed "Crankshaft speed.";',
  'BA_DEF_ "BusType" STRING ;',
  'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;',
  'BA_DEF_ BO_ "Label" STRING ;',
  'BA_DEF_ BO_ "Owner" STRING ;',
  'BA_DEF_ SG_ "GenSigSendType" ENUM "Cyclic","OnChange";',
  'BA_DEF_DEF_ "BusType" "CAN";',
  'BA_DEF_DEF_ "GenMsgCycleTime" 0;',
  'BA_DEF_DEF_ "Label" "";',
  'BA_DEF_DEF_ "GenSigSendType" "Cyclic";',
  'BA_ "BusType" "CAN";',
  'BA_ "GenMsgCycleTime" BO_ 256 10;',
  'BA_ "Label" BO_ 256 "front";',
  'BA_ "GenSigSendType" SG_ 256 Speed 0;',
  'VAL_ 256 Run 1 "On" 0 "Off" ;',
  ''
].join('\n');
const BASE = HEAD + ENGINE + PAGES + SHIFT + TAIL;

function rep(text, from, to) {
  if (text.indexOf(from) === -1) throw new Error('the case text has no: ' + from);
  return text.replace(from, function () { return to; });
}
function edit(text, pairs) {
  let t = text;
  for (const p of pairs) t = rep(t, p[0], p[1]);
  return t;
}
function after(text, anchor, extra) { return rep(text, anchor, anchor + extra); }

// ---- the cases: [name, old text, new text, expected [code, class] pairs] ----------------------

const cases = [];
function kase(name, oldText, newText, expected, flags) { cases.push({ name: name, oldText: oldText, newText: newText, expected: expected, flags: flags || {} }); }
function same(name, newText, expected, flags) { kase(name, BASE, newText, expected, flags); }

// no difference
same('identical files', BASE, []);
same('only spaces, tabs and layout differ', edit(BASE, [[' SG_ Speed : 0|16@1+ (0.25,0)', ' SG_  Speed  :  0 | 16 @1+   (0.25 , 0)  '], ['BU_: Ecu1 Ecu2 Ecu3', 'BU_:   Ecu1\tEcu2   Ecu3']]), []);
same('factor, offset and range written with more digits', rep(BASE, L_DIST, ' SG_ Dist m0 : 8|16@1+ (0.10,0.0) [0|6553.50] "km" Ecu1\n'), []);
same('factor and range written with an exponent', rep(BASE, L_DIST, ' SG_ Dist m0 : 8|16@1+ (1e-1,0) [0|6.5535e3] "km" Ecu1\n'), []);
same('receivers listed in another order', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [0|8000] "rpm" Ecu3,Ecu2\n'), []);
same('offset -40 written as -40.00', rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1+ (1,-40.00) [-40|150] "degC" Ecu2\n'), []);
same('enumerated attribute written as a number and as its name', rep(BASE, 'BA_ "GenSigSendType" SG_ 256 Speed 0;', 'BA_ "GenSigSendType" SG_ 256 Speed "Cyclic";'), []);
kase('two empty files', 'VERSION ""\n', 'VERSION ""\n', []);
same('range written with other digits', rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1+ (1,-40) [-40.0|1.5e2] "degC" Ecu2\n'), []);
same('value table entries listed in another order', rep(BASE, '2 "Drive" 1 "Reverse" 0 "Park"', '0 "Park" 1 "Reverse" 2 "Drive"'), []);
same('a line that is not DBC is added', BASE + '@@@ nonsense\n', []);
kase('extended multiplexing ranges 0-1 and 0-0, 1-1 are the same', rep(BASE, 'VAL_ 256 Run', 'SG_MUL_VAL_ 512 Dist Page 0-1;\nVAL_ 256 Run'), rep(BASE, 'VAL_ 256 Run', 'SG_MUL_VAL_ 512 Dist Page 0-0, 1-1;\nVAL_ 256 Run'), []);

// cosmetic
same('version text changed', rep(BASE, 'VERSION "1.0"', 'VERSION "1.1"'), [['DIFF-VERSION-CHANGED', C]]);
same('a comment on the whole database is added', BASE + 'CM_ "A note.";\n', [['DIFF-FILE-COMMENT-CHANGED', C]]);
same('a comment on a message is added', BASE + 'CM_ BO_ 256 "Engine data.";\n', [['DIFF-MESSAGE-COMMENT-CHANGED', C]]);
same('a comment on a signal changes', rep(BASE, 'Crankshaft speed.', 'Engine speed.'), [['DIFF-SIGNAL-COMMENT-CHANGED', C]]);
same('a comment on a signal is removed', rep(BASE, 'CM_ SG_ 256 Speed "Crankshaft speed.";\n', ''), [['DIFF-SIGNAL-COMMENT-CHANGED', C]]);
same('a comment on a node is added', BASE + 'CM_ BU_ Ecu1 "Main unit.";\n', [['DIFF-NODE-COMMENT-CHANGED', C]]);
same('nodes in another order', rep(BASE, 'BU_: Ecu1 Ecu2 Ecu3', 'BU_: Ecu3 Ecu1 Ecu2'), [['DIFF-NODE-ORDER-CHANGED', C]]);
same('messages in another order', HEAD + SHIFT + ENGINE + PAGES + TAIL, [['DIFF-MESSAGE-ORDER-CHANGED', C]]);
same('signals of a message in another order', HEAD + 'BO_ 256 Engine: 8 Ecu1\n' + L_TEMP + L_SPEED + L_RUN + '\n' + PAGES + SHIFT + TAIL, [['DIFF-SIGNAL-ORDER-CHANGED', C]]);
same('a value table is renamed and keeps its entries', rep(BASE, 'VAL_TABLE_ Gear ', 'VAL_TABLE_ GearPosition '), [['DIFF-VALUE-TABLE-RENAMED', C]]);
kase('value tables in another order', after(BASE, 'VAL_TABLE_ Gear 2 "Drive" 1 "Reverse" 0 "Park" ;\n', 'VAL_TABLE_ Mode 1 "On" 0 "Off" ;\n'),
  rep(BASE, 'VAL_TABLE_ Gear 2 "Drive" 1 "Reverse" 0 "Park" ;\n', 'VAL_TABLE_ Mode 1 "On" 0 "Off" ;\nVAL_TABLE_ Gear 2 "Drive" 1 "Reverse" 0 "Park" ;\n'), [['DIFF-VALUE-TABLE-ORDER-CHANGED', C]]);
same('an 8-bit signal is written as big-endian over the same byte', rep(BASE, L_TEMP, ' SG_ Temp : 23|8@0+ (1,-40) [-40|150] "degC" Ecu2\n'), [['DIFF-SIGNAL-LAYOUT-REWRITTEN', C]]);
same('a 1-bit signal is written as big-endian', rep(BASE, L_RUN, ' SG_ Run : 24|1@0+ (1,0) [0|1] "" Ecu2\n'), [['DIFF-SIGNAL-LAYOUT-REWRITTEN', C]]);
same('a value description differs only in a trailing space', rep(BASE, '1 "On" 0 "Off"', '1 "On " 0 "Off"'), [['DIFF-VALUE-DESCRIPTION-WHITESPACE', C]]);
same('an attribute definition changes its type', rep(BASE, 'BA_DEF_ BO_ "Owner" STRING ;', 'BA_DEF_ BO_ "Owner" HEX 0 255;'), [['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C]]);
same('the default of an attribute that is set explicitly changes', rep(BASE, 'BA_DEF_DEF_ "BusType" "CAN";', 'BA_DEF_DEF_ "BusType" "CAN FD";'), [['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C]]);
same('an attribute definition is added', rep(BASE, 'BA_DEF_ BO_ "Owner" STRING ;', 'BA_DEF_ BO_ "Owner" STRING ;\nBA_DEF_ SG_ "Note" STRING ;'), [['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C]]);

// non-breaking
same('a node is added', rep(BASE, 'BU_: Ecu1 Ecu2 Ecu3', 'BU_: Ecu1 Ecu2 Ecu3 Ecu4'), [['DIFF-NODE-ADDED', N]]);
same('a message is added', rep(BASE, 'CM_ SG_ 256', 'BO_ 1024 Extra: 4 Ecu1\n SG_ Val : 0|8@1+ (1,0) [0|0] "" Ecu2\n\nCM_ SG_ 256'), [['DIFF-MESSAGE-ADDED', N]]);
same('an extended message is added', rep(BASE, 'CM_ SG_ 256', 'BO_ 2147484672 ExtMsg: 8 Ecu1\n SG_ Val : 0|8@1+ (1,0) [0|0] "" Ecu2\n\nCM_ SG_ 256'), [['DIFF-MESSAGE-ADDED', N]]);
same('a signal is added in free bits', after(BASE, L_RUN, ' SG_ Extra : 32|8@1+ (1,0) [0|0] "" Ecu2\n'), [['DIFF-SIGNAL-ADDED', N]]);
same('the data length grows', rep(BASE, 'BO_ 768 Shift: 2 Ecu3', 'BO_ 768 Shift: 4 Ecu3'), [['DIFF-MESSAGE-DLC-INCREASED', N]]);
same('a range is widened', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [0|9000] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-RANGE-WIDENED', N]]);
same('a range becomes unspecified', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [0|0] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-RANGE-WIDENED', N]]);
same('a range is widened on both sides', rep(BASE, L_RUN, ' SG_ Run : 24|1@1+ (1,0) [-1|2] "" Ecu2\n'), [['DIFF-SIGNAL-RANGE-WIDENED', N]]);
same('a value description is added', rep(BASE, '1 "On" 0 "Off"', '2 "Error" 1 "On" 0 "Off"'), [['DIFF-VALUE-DESCRIPTION-ADDED', N]]);
same('a receiver is added', rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1+ (1,-40) [-40|150] "degC" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-RECEIVER-ADDED', N]]);
kase('a signal gets its first receiver', rep(BASE, L_RUN, ' SG_ Run : 24|1@1+ (1,0) [0|1] "" Vector__XXX\n'), BASE, [['DIFF-SIGNAL-RECEIVER-ADDED', N]]);
same('a further transmitter is added', BASE + 'BO_TX_BU_ 256 : Ecu2;\n', [['DIFF-MESSAGE-TRANSMITTER-ADDED', N]]);
same('an attribute is set on a message', BASE + 'BA_ "Owner" BO_ 512 "team";\n', [['DIFF-ATTRIBUTE-ADDED', N]]);
same('an attribute value changes', rep(BASE, 'BA_ "Label" BO_ 256 "front";', 'BA_ "Label" BO_ 256 "rear";'), [['DIFF-ATTRIBUTE-CHANGED', N]]);
kase('an attribute value is removed', BASE + 'BA_ "Owner" BO_ 512 "team";\n', BASE, [['DIFF-ATTRIBUTE-REMOVED', N]]);
same('a value table is added', after(BASE, 'VAL_TABLE_ Gear 2 "Drive" 1 "Reverse" 0 "Park" ;\n', 'VAL_TABLE_ Mode 1 "On" 0 "Off" ;\n'), [['DIFF-VALUE-TABLE-ADDED', N]]);
same('an entry is added to a value table', rep(BASE, '2 "Drive" 1 "Reverse" 0 "Park"', '3 "Sport" 2 "Drive" 1 "Reverse" 0 "Park"'), [['DIFF-VALUE-TABLE-ENTRY-ADDED', N]]);
same('a signal is added at another multiplexor value on the same bits', after(BASE, L_AVG, ' SG_ Alt m2 : 8|16@1+ (1,0) [0|0] "" Ecu1\n'), [['DIFF-SIGNAL-ADDED', N]]);
same('a signal is added to a multiplexed message in free bits', after(BASE, L_AVG, ' SG_ Tail : 24|8@1+ (1,0) [0|0] "" Ecu1\n'), [['DIFF-SIGNAL-ADDED', N]]);
same('an attribute of the database is added with its definition', rep(BASE, 'BA_DEF_ BO_ "Owner" STRING ;', 'BA_DEF_ BO_ "Owner" STRING ;\nBA_DEF_ "Project" STRING ;') + 'BA_ "Project" "X";\n', [['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-ADDED', N]]);
same('the data length grows and a signal is added in the new bytes', edit(BASE, [['BO_ 768 Shift: 2 Ecu3', 'BO_ 768 Shift: 4 Ecu3'], [L_SEL, L_SEL + ' SG_ Extra : 16|8@1+ (1,0) [0|0] "" Ecu1\n']]), [['DIFF-MESSAGE-DLC-INCREASED', N], ['DIFF-SIGNAL-ADDED', N]]);
same('a signal is added in an extended message next to a standard message of the same number', rep(BASE, 'CM_ SG_ 256', 'BO_ 2147483904 Twin: 8 Ecu1\n SG_ Val : 0|8@1+ (1,0) [0|0] "" Ecu2\n\nCM_ SG_ 256'), [['DIFF-MESSAGE-ADDED', N]]);
same('an attribute is set on a signal with its definition', rep(BASE, 'BA_DEF_ BO_ "Owner" STRING ;', 'BA_DEF_ BO_ "Owner" STRING ;\nBA_DEF_ SG_ "Note" STRING ;') + 'BA_ "Note" SG_ 256 Speed "x";\n', [['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-ADDED', N]]);

// breaking
same('a message is removed', HEAD + ENGINE + PAGES + TAIL, [['DIFF-MESSAGE-REMOVED', B]]);
same('a message gets another identifier', rep(BASE, 'BO_ 768 Shift', 'BO_ 769 Shift'), [['DIFF-MESSAGE-ID-CHANGED', B]]);
same('a message gets another identifier and another signal', edit(BASE, [['BO_ 768 Shift', 'BO_ 769 Shift'], [L_SEL, ' SG_ Sel2 : 7|4@0+ (1,0) [0|7] "" Ecu1\n']]), [['DIFF-MESSAGE-REMOVED', B], ['DIFF-MESSAGE-ADDED', N]]);
same('a standard message becomes the extended message of the same number', rep(BASE, 'BO_ 768 Shift', 'BO_ 2147484416 Shift'), [['DIFF-MESSAGE-FRAME-FORMAT-CHANGED', B]]);
same('a standard message becomes an extended message of another number', rep(BASE, 'BO_ 768 Shift', 'BO_ 2147484417 Shift'), [['DIFF-MESSAGE-ID-CHANGED', B]]);
same('a message is renamed', rep(BASE, 'BO_ 768 Shift', 'BO_ 768 GearShift'), [['DIFF-MESSAGE-RENAMED', B]]);
same('the data length shrinks', rep(BASE, 'BO_ 256 Engine: 8 Ecu1', 'BO_ 256 Engine: 6 Ecu1'), [['DIFF-MESSAGE-DLC-DECREASED', B]]);
same('the sender changes', rep(BASE, 'BO_ 768 Shift: 2 Ecu3', 'BO_ 768 Shift: 2 Ecu2'), [['DIFF-MESSAGE-SENDER-CHANGED', B]]);
same('the sender is removed', rep(BASE, 'BO_ 768 Shift: 2 Ecu3', 'BO_ 768 Shift: 2 Vector__XXX'), [['DIFF-MESSAGE-SENDER-CHANGED', B]]);
kase('a further transmitter is removed', BASE + 'BO_TX_BU_ 256 : Ecu2;\n', BASE, [['DIFF-MESSAGE-TRANSMITTER-REMOVED', B]]);
same('the cycle time changes', rep(BASE, 'BA_ "GenMsgCycleTime" BO_ 256 10;', 'BA_ "GenMsgCycleTime" BO_ 256 20;'), [['DIFF-CYCLE-TIME-CHANGED', B]]);
same('a cycle time is added', BASE + 'BA_ "GenMsgCycleTime" BO_ 512 100;\n', [['DIFF-CYCLE-TIME-CHANGED', B]]);
same('a cycle time is removed', rep(BASE, 'BA_ "GenMsgCycleTime" BO_ 256 10;\n', ''), [['DIFF-CYCLE-TIME-CHANGED', B]]);
same('the default cycle time changes for messages without their own', rep(BASE, 'BA_DEF_DEF_ "GenMsgCycleTime" 0;', 'BA_DEF_DEF_ "GenMsgCycleTime" 50;'), [['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-CYCLE-TIME-CHANGED', B], ['DIFF-CYCLE-TIME-CHANGED', B]]);
same('a signal is removed', rep(BASE, L_RUN, ''), [['DIFF-SIGNAL-REMOVED', B]]);
same('a signal is renamed', rep(BASE, L_TEMP, ' SG_ CoolantTemp : 16|8@1+ (1,-40) [-40|150] "degC" Ecu2\n'), [['DIFF-SIGNAL-RENAMED', B]]);
same('a signal is renamed and its unit changes', rep(BASE, L_TEMP, ' SG_ CoolantTemp : 16|8@1+ (1,-40) [-40|150] "degF" Ecu2\n'), [['DIFF-SIGNAL-RENAMED', B], ['DIFF-SIGNAL-UNIT-CHANGED', B]]);
same('the start bit changes', rep(BASE, L_TEMP, ' SG_ Temp : 32|8@1+ (1,-40) [-40|150] "degC" Ecu2\n'), [['DIFF-SIGNAL-START-BIT-CHANGED', B]]);
same('the length changes', rep(BASE, L_SPEED, ' SG_ Speed : 0|12@1+ (0.25,0) [0|8000] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-LENGTH-CHANGED', B]]);
same('the byte order changes with the same start bit and length', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@0+ (0.25,0) [0|8000] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-BYTE-ORDER-CHANGED', B]]);
same('the byte order and the start bit change to other bits', rep(BASE, L_SPEED, ' SG_ Speed : 7|16@0+ (0.25,0) [0|8000] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-START-BIT-CHANGED', B], ['DIFF-SIGNAL-BYTE-ORDER-CHANGED', B]]);
same('a signal becomes signed', rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1- (1,-40) [-40|150] "degC" Ecu2\n'), [['DIFF-SIGNAL-SIGN-CHANGED', B]]);
same('a 1-bit signal becomes signed', rep(BASE, L_RUN, ' SG_ Run : 24|1@1- (1,0) [0|1] "" Ecu2\n'), [['DIFF-SIGNAL-SIGN-CHANGED', B]]);
same('a signal becomes a float', BASE + 'SIG_VALTYPE_ 256 Speed : 1;\n', [['DIFF-SIGNAL-VALUE-TYPE-CHANGED', B]]);
same('the factor changes', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.5,0) [0|8000] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-FACTOR-CHANGED', B]]);
same('the factor 0.1 becomes 0.01', rep(BASE, L_DIST, ' SG_ Dist m0 : 8|16@1+ (0.01,0) [0|6553.5] "km" Ecu1\n'), [['DIFF-SIGNAL-FACTOR-CHANGED', B]]);
same('the offset changes its sign', rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1+ (1,40) [-40|150] "degC" Ecu2\n'), [['DIFF-SIGNAL-OFFSET-CHANGED', B]]);
same('the offset changes slightly', rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1+ (1,-39.5) [-40|150] "degC" Ecu2\n'), [['DIFF-SIGNAL-OFFSET-CHANGED', B]]);
same('a unit appears where there was none', rep(BASE, L_RUN, ' SG_ Run : 24|1@1+ (1,0) [0|1] "km/h" Ecu2\n'), [['DIFF-SIGNAL-UNIT-CHANGED', B]]);
same('a unit changes', rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1+ (1,-40) [-40|150] "degF" Ecu2\n'), [['DIFF-SIGNAL-UNIT-CHANGED', B]]);
same('a range is narrowed', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [0|7000] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-RANGE-NARROWED', B]]);
same('a range is shifted', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [100|9000] "rpm" Ecu2,Ecu3\n'), [['DIFF-SIGNAL-RANGE-NARROWED', B]], { asym: true });
kase('an unspecified range gets limits', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [0|0] "rpm" Ecu2,Ecu3\n'), BASE, [['DIFF-SIGNAL-RANGE-NARROWED', B]]);
same('a receiver is removed', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [0|8000] "rpm" Ecu2\n'), [['DIFF-SIGNAL-RECEIVER-REMOVED', B]]);
same('one receiver replaces another', rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.25,0) [0|8000] "rpm" Ecu1,Ecu2\n'), [['DIFF-SIGNAL-RECEIVER-ADDED', N], ['DIFF-SIGNAL-RECEIVER-REMOVED', B]]);
same('a value description is removed', rep(BASE, '1 "On" 0 "Off"', '1 "On"'), [['DIFF-VALUE-DESCRIPTION-REMOVED', B]]);
same('a value description changes', rep(BASE, '0 "Off"', '0 "Standby"'), [['DIFF-VALUE-DESCRIPTION-CHANGED', B]]);
same('an entry is removed from a value table', rep(BASE, '2 "Drive" 1 "Reverse" 0 "Park"', '2 "Drive" 1 "Reverse"'), [['DIFF-VALUE-TABLE-ENTRY-REMOVED', B]]);
same('an entry of a value table changes', rep(BASE, '1 "Reverse"', '1 "Back"'), [['DIFF-VALUE-TABLE-ENTRY-CHANGED', B]]);
same('a value table is removed', rep(BASE, 'VAL_TABLE_ Gear 2 "Drive" 1 "Reverse" 0 "Park" ;\n', ''), [['DIFF-VALUE-TABLE-REMOVED', B]]);
same('a node is removed', rep(BASE, 'BU_: Ecu1 Ecu2 Ecu3', 'BU_: Ecu1 Ecu2'), [['DIFF-NODE-REMOVED', B]]);
same('a multiplexed signal moves to another multiplexor value', rep(BASE, L_DIST, ' SG_ Dist m2 : 8|16@1+ (0.1,0) [0|6553.5] "km" Ecu1\n'), [['DIFF-MUX-ROLE-CHANGED', B]]);
same('a multiplexor loses its role', rep(BASE, L_PAGE, ' SG_ Page : 0|8@1+ (1,0) [0|2] "" Ecu1\n'), [['DIFF-MUX-ROLE-CHANGED', B]]);
same('extended multiplexing is added to a multiplexed signal', rep(BASE, 'VAL_ 256 Run', 'SG_MUL_VAL_ 512 Dist Page 0-1;\nVAL_ 256 Run'), [['DIFF-MUX-RANGES-CHANGED', B]]);
kase('extended multiplexing ranges change',rep(BASE, 'VAL_ 256 Run', 'SG_MUL_VAL_ 512 Dist Page 0-0;\nVAL_ 256 Run'), rep(BASE, 'VAL_ 256 Run', 'SG_MUL_VAL_ 512 Dist Page 0-1;\nVAL_ 256 Run'), [['DIFF-MUX-RANGES-CHANGED', B]]);
same('a signal is added on the bits of two existing signals', after(BASE, L_RUN, ' SG_ Extra : 20|8@1+ (1,0) [0|0] "" Ecu2\n'), [['DIFF-SIGNAL-ADDED-OVERLAP', B]]);
same('a big-endian signal is added over one bit of an existing signal', after(BASE, L_RUN, ' SG_ Extra : 31|8@0+ (1,0) [0|0] "" Ecu2\n'), [['DIFF-SIGNAL-ADDED-OVERLAP', B]]);
same('a big-endian signal is added in free bits', after(BASE, L_RUN, ' SG_ Extra : 39|8@0+ (1,0) [0|0] "" Ecu2\n'), [['DIFF-SIGNAL-ADDED', N]]);
same('a big-endian signal with the start bit of an Intel byte runs into another byte', after(BASE, L_RUN, ' SG_ Extra : 16|8@0+ (1,0) [0|0] "" Ecu2\n'), [['DIFF-SIGNAL-ADDED-OVERLAP', B]]);
same('a signal without a multiplexor value is added over multiplexed signals', after(BASE, L_AVG, ' SG_ Over : 8|8@1+ (1,0) [0|0] "" Ecu1\n'), [['DIFF-SIGNAL-ADDED-OVERLAP', B]]);
same('the send type of a signal changes', rep(BASE, 'BA_ "GenSigSendType" SG_ 256 Speed 0;', 'BA_ "GenSigSendType" SG_ 256 Speed 1;'), [['DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', B]]);
same('the default send type changes for the signals without their own', rep(BASE, 'BA_DEF_DEF_ "GenSigSendType" "Cyclic";', 'BA_DEF_DEF_ "GenSigSendType" "OnChange";'),
  [['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', B], ['DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', B], ['DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', B], ['DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', B], ['DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', B], ['DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED', B]]);
same('a signal moves to another message', edit(BASE, [[L_RUN, ''], [L_SEL, L_SEL + ' SG_ Run : 8|1@1+ (1,0) [0|1] "" Ecu2\n']]), [['DIFF-SIGNAL-REMOVED', B], ['DIFF-SIGNAL-ADDED', N]]);
same('a standard message and an extended message of the same number exist side by side', rep(BASE, 'CM_ SG_ 256', 'BO_ 2147484160 Twin: 8 Ecu1\n SG_ Val : 0|8@1+ (1,0) [0|0] "" Ecu2\n\nCM_ SG_ 256'), [['DIFF-MESSAGE-ADDED', N]]);
same('several differences at once', edit(BASE, [['BO_ 768 Shift: 2 Ecu3', 'BO_ 768 Shift: 2 Ecu2'], [L_SPEED, ' SG_ Speed : 0|16@1+ (0.5,0) [0|8000] "rpm" Ecu2,Ecu3\n']]) + 'CM_ BO_ 768 "Gear shift.";\n',
  [['DIFF-MESSAGE-SENDER-CHANGED', B], ['DIFF-SIGNAL-FACTOR-CHANGED', B], ['DIFF-MESSAGE-COMMENT-CHANGED', C]]);
kase('two removed and two added signals with the same layout are not paired as renames',
  'VERSION ""\n\nBU_: A\n\nBO_ 1 M: 8 A\n SG_ P : 0|8@1+ (1,0) [0|0] "" A\n SG_ Q : 0|8@1+ (1,0) [0|0] "" A\n',
  'VERSION ""\n\nBU_: A\n\nBO_ 1 M: 8 A\n SG_ R : 0|8@1+ (1,0) [0|0] "" A\n SG_ T : 0|8@1+ (1,0) [0|0] "" A\n',
  [['DIFF-SIGNAL-REMOVED', B], ['DIFF-SIGNAL-REMOVED', B], ['DIFF-SIGNAL-ADDED', N], ['DIFF-SIGNAL-ADDED', N]]);
kase('everything is removed', BASE, 'VERSION ""\n',
  [['DIFF-VERSION-CHANGED', C], ['DIFF-NODE-REMOVED', B], ['DIFF-NODE-REMOVED', B], ['DIFF-NODE-REMOVED', B], ['DIFF-VALUE-TABLE-REMOVED', B],
    ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C],
    ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C],
    ['DIFF-ATTRIBUTE-REMOVED', N], ['DIFF-MESSAGE-REMOVED', B], ['DIFF-MESSAGE-REMOVED', B], ['DIFF-MESSAGE-REMOVED', B]]);
kase('everything is added', 'VERSION ""\n', BASE,
  [['DIFF-VERSION-CHANGED', C], ['DIFF-NODE-ADDED', N], ['DIFF-NODE-ADDED', N], ['DIFF-NODE-ADDED', N], ['DIFF-VALUE-TABLE-ADDED', N],
    ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C], ['DIFF-ATTRIBUTE-DEFINITION-CHANGED', C],
    ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C], ['DIFF-ATTRIBUTE-DEFAULT-CHANGED', C],
    ['DIFF-ATTRIBUTE-ADDED', N], ['DIFF-MESSAGE-ADDED', N], ['DIFF-MESSAGE-ADDED', N], ['DIFF-MESSAGE-ADDED', N]]);

// ---- helpers -----------------------------------------------------------------------------------

const KINDS = ['database', 'node', 'message', 'signal', 'valueTable', 'attribute', 'valueDescription', 'multiplexing'];

function run(oldText, newText) { return X.diffDatabases(P.parseDbc(oldText), P.parseDbc(newText)); }
function listOf(result) { return result.changes.map(function (c) { return c.code + ' ' + c.class; }).sort(); }
function expectedList(pairs) { return pairs.map(function (p) { return p[0] + ' ' + p[1]; }).sort(); }

function checkShape(result) {
  const counts = { 'BREAKING': 0, 'NON-BREAKING': 0, 'COSMETIC': 0 };
  for (const c of result.changes) {
    assert.ok(X.RULES[c.code], 'unknown code ' + c.code);
    assert.equal(c.class, X.RULES[c.code].class, 'class of ' + c.code);
    assert.ok(KINDS.indexOf(c.kind) !== -1, 'kind ' + c.kind);
    for (const f of ['message', 'id', 'signal', 'field', 'oldValue', 'newValue', 'text']) assert.equal(typeof c[f], 'string', f + ' of ' + c.code);
    assert.ok(c.text.length > 10 && /\.$/.test(c.text), 'text of ' + c.code + ': ' + c.text);
    assert.equal(typeof c.oldOffset, 'number');
    assert.equal(typeof c.newOffset, 'number');
    counts[c.class]++;
  }
  assert.deepEqual(result.counts, counts);
  assert.equal(result.summary.total, result.changes.length);
}

// ---- the rules ---------------------------------------------------------------------------------

test('the rule table is complete and consistent', function () {
  const codes = Object.keys(X.RULES);
  assert.ok(codes.length >= 50);
  assert.deepEqual(X.CLASSES, ['BREAKING', 'NON-BREAKING', 'COSMETIC']);
  const word = { 'BREAKING': 'Breaking.', 'NON-BREAKING': 'Non-breaking.', 'COSMETIC': 'Cosmetic.' };
  for (const code of codes) {
    assert.match(code, /^DIFF-[A-Z0-9]+(-[A-Z0-9]+)*$/);
    const r = X.RULES[code];
    assert.ok(X.CLASSES.indexOf(r.class) !== -1, code);
    assert.ok(r.text.startsWith(word[r.class] + ' '), code + ' text starts with its class');
    assert.ok(Object.isFrozen(r));
  }
  assert.ok(Object.isFrozen(X.RULES));
});

test('every rule is described in docs/diff-rules.md with the same class and first sentence', function () {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'diff-rules.md'), 'utf8');
  const documented = new Set();
  for (const m of doc.matchAll(/^### (DIFF-[A-Z0-9-]+)$/gm)) documented.add(m[1]);
  for (const code of Object.keys(X.RULES)) {
    assert.ok(documented.has(code), 'docs/diff-rules.md has no section for ' + code);
    const body = doc.split('### ' + code + '\n')[1].replace(/^\s+/, '');
    assert.ok(body.startsWith(X.RULES[code].text), code + ' is documented with another first sentence: ' + body.split('\n')[0]);
  }
  for (const code of documented) assert.ok(X.RULES[code], 'docs/diff-rules.md documents a code that does not exist: ' + code);
});

// ---- hand-classified cases ---------------------------------------------------------------------

test('there are at least 80 hand-classified cases', function () {
  assert.ok(cases.length >= 80, 'only ' + cases.length);
});

for (const k of cases) {
  test('case: ' + k.name, function () {
    const result = run(k.oldText, k.newText);
    checkShape(result);
    assert.deepEqual(listOf(result), expectedList(k.expected), result.changes.map(function (c) { return c.text; }).join('\n'));
  });
}

test('every rule is produced by at least one case', function () {
  const seen = new Set();
  for (const k of cases) for (const c of run(k.oldText, k.newText).changes) seen.add(c.code);
  const missing = Object.keys(X.RULES).filter(function (c) { return !seen.has(c); });
  assert.deepEqual(missing, []);
});

test('the classes of the cases cover breaking, non-breaking and cosmetic changes', function () {
  const have = new Set();
  for (const k of cases) for (const p of k.expected) have.add(p[1]);
  assert.deepEqual(Array.from(have).sort(), ['BREAKING', 'COSMETIC', 'NON-BREAKING']);
});

// ---- symmetry and determinism ------------------------------------------------------------------

const SWAP = {
  'DIFF-NODE-ADDED': 'DIFF-NODE-REMOVED', 'DIFF-NODE-REMOVED': 'DIFF-NODE-ADDED',
  'DIFF-VALUE-TABLE-ADDED': 'DIFF-VALUE-TABLE-REMOVED', 'DIFF-VALUE-TABLE-REMOVED': 'DIFF-VALUE-TABLE-ADDED',
  'DIFF-VALUE-TABLE-ENTRY-ADDED': 'DIFF-VALUE-TABLE-ENTRY-REMOVED', 'DIFF-VALUE-TABLE-ENTRY-REMOVED': 'DIFF-VALUE-TABLE-ENTRY-ADDED',
  'DIFF-ATTRIBUTE-ADDED': 'DIFF-ATTRIBUTE-REMOVED', 'DIFF-ATTRIBUTE-REMOVED': 'DIFF-ATTRIBUTE-ADDED',
  'DIFF-MESSAGE-ADDED': 'DIFF-MESSAGE-REMOVED', 'DIFF-MESSAGE-REMOVED': 'DIFF-MESSAGE-ADDED',
  'DIFF-MESSAGE-DLC-INCREASED': 'DIFF-MESSAGE-DLC-DECREASED', 'DIFF-MESSAGE-DLC-DECREASED': 'DIFF-MESSAGE-DLC-INCREASED',
  'DIFF-MESSAGE-TRANSMITTER-ADDED': 'DIFF-MESSAGE-TRANSMITTER-REMOVED', 'DIFF-MESSAGE-TRANSMITTER-REMOVED': 'DIFF-MESSAGE-TRANSMITTER-ADDED',
  'DIFF-SIGNAL-ADDED': 'DIFF-SIGNAL-REMOVED', 'DIFF-SIGNAL-REMOVED': 'DIFF-SIGNAL-ADDED', 'DIFF-SIGNAL-ADDED-OVERLAP': 'DIFF-SIGNAL-REMOVED',
  'DIFF-SIGNAL-RANGE-WIDENED': 'DIFF-SIGNAL-RANGE-NARROWED', 'DIFF-SIGNAL-RANGE-NARROWED': 'DIFF-SIGNAL-RANGE-WIDENED',
  'DIFF-SIGNAL-RECEIVER-ADDED': 'DIFF-SIGNAL-RECEIVER-REMOVED', 'DIFF-SIGNAL-RECEIVER-REMOVED': 'DIFF-SIGNAL-RECEIVER-ADDED',
  'DIFF-VALUE-DESCRIPTION-ADDED': 'DIFF-VALUE-DESCRIPTION-REMOVED', 'DIFF-VALUE-DESCRIPTION-REMOVED': 'DIFF-VALUE-DESCRIPTION-ADDED'
};

test('swapping old and new turns added into removed and keeps the other codes', function () {
  let checked = 0;
  for (const k of cases) {
    if (k.flags.asym) continue;
    const forward = run(k.oldText, k.newText).changes.map(function (c) { return SWAP[c.code] || c.code; }).sort();
    const backward = run(k.newText, k.oldText).changes.map(function (c) { return c.code; }).sort();
    assert.deepEqual(backward, forward, 'case: ' + k.name);
    checked++;
  }
  assert.ok(checked >= 80);
});

test('a change of layout, scaling, unit or sign stays breaking when old and new are swapped', function () {
  const layoutCodes = ['DIFF-SIGNAL-START-BIT-CHANGED', 'DIFF-SIGNAL-LENGTH-CHANGED', 'DIFF-SIGNAL-BYTE-ORDER-CHANGED', 'DIFF-SIGNAL-SIGN-CHANGED', 'DIFF-SIGNAL-VALUE-TYPE-CHANGED',
    'DIFF-SIGNAL-FACTOR-CHANGED', 'DIFF-SIGNAL-OFFSET-CHANGED', 'DIFF-SIGNAL-UNIT-CHANGED', 'DIFF-MESSAGE-ID-CHANGED', 'DIFF-MUX-ROLE-CHANGED'];
  let seen = 0;
  for (const k of cases) {
    for (const direction of [[k.oldText, k.newText], [k.newText, k.oldText]]) {
      for (const c of run(direction[0], direction[1]).changes) if (layoutCodes.indexOf(c.code) !== -1) { assert.equal(c.class, B); seen++; }
    }
  }
  assert.ok(seen >= 20);
});

test('the same input gives the same result twice', function () {
  for (const k of cases) {
    const a = JSON.stringify(run(k.oldText, k.newText));
    const b = JSON.stringify(run(k.oldText, k.newText));
    assert.equal(a, b, k.name);
  }
});

test('a changed result is in a stable order: database level first, then messages by identifier', function () {
  const r = run(BASE, edit(BASE, [['BU_: Ecu1 Ecu2 Ecu3', 'BU_: Ecu1 Ecu2 Ecu3 Ecu4'], ['BO_ 768 Shift: 2 Ecu3', 'BO_ 768 Shift: 4 Ecu3'], [L_SPEED, ' SG_ Speed : 0|16@1+ (0.5,0) [0|8000] "rpm" Ecu2,Ecu3\n'], [L_AVG, ' SG_ Avg m1 : 8|16@1+ (0.1,0) [0|6553.5] "mph" Ecu1\n']]));
  assert.deepEqual(r.changes.map(function (c) { return c.code; }), ['DIFF-NODE-ADDED', 'DIFF-SIGNAL-FACTOR-CHANGED', 'DIFF-SIGNAL-UNIT-CHANGED', 'DIFF-MESSAGE-DLC-INCREASED']);
  assert.deepEqual(r.changes.map(function (c) { return c.message; }), ['', 'Engine', 'Pages', 'Shift']);
});

test('offsets point at the changed names in both files', function () {
  const oldText = BASE;
  const newText = rep(BASE, L_TEMP, ' SG_ Temp : 16|8@1+ (1,-40) [-40|150] "degF" Ecu2\n');
  const c = run(oldText, newText).changes[0];
  assert.equal(oldText.slice(c.oldOffset, c.oldOffset + 4), 'Temp');
  assert.equal(newText.slice(c.newOffset, c.newOffset + 4), 'Temp');
});

test('the summary text counts the classes', function () {
  assert.equal(run(BASE, BASE).summary.text, 'No differences.');
  const r = run(BASE, rep(BASE, L_SPEED, ' SG_ Speed : 0|16@1+ (0.5,0) [0|8000] "rpm" Ecu2,Ecu3\n') + 'CM_ "x";\n');
  assert.equal(r.summary.text, '2 differences: 1 breaking, 0 non-breaking, 1 cosmetic.');
  assert.equal(r.summary.breaking, 1);
  assert.equal(r.summary.cosmetic, 1);
  assert.equal(r.matched.messages, 3);
  assert.equal(r.matched.signals, 7);
});

test('the matched counts include identifier changes and renamed signals', function () {
  const r = run(BASE, edit(BASE, [['BO_ 768 Shift', 'BO_ 769 Shift'], [L_TEMP, ' SG_ CoolantTemp : 16|8@1+ (1,-40) [-40|150] "degC" Ecu2\n']]));
  assert.equal(r.matched.idChanged, 1);
  assert.equal(r.matched.renamedSignals, 1);
  assert.equal(r.matched.messages, 3);
});

test('the comparison refuses something that is not a database', function () {
  assert.throws(function () { X.diffDatabases(null, P.parseDbc(BASE)); }, TypeError);
  assert.throws(function () { X.diffDatabases(P.parseDbc(BASE), {}); }, TypeError);
});

// ---- the samples -------------------------------------------------------------------------------

test('each sample compared with itself shows no difference', function () {
  for (const kind of ['valid', 'problems']) {
    const text = S.sampleFor(kind).text;
    const r = run(text, text);
    assert.equal(r.changes.length, 0, kind);
    assert.equal(r.summary.text, 'No differences.');
  }
});

test('the valid sample compared with a modified copy lists exactly the modifications', function () {
  const text = S.sampleFor('valid').text;
  const modified = edit(text, [
    ['(0.25,0) [0|8000] "rpm"', '(0.5,0) [0|8000] "rpm"'],
    ['BO_ 288 GearStatus: 4 GearUnit', 'BO_ 288 GearStatus: 6 GearUnit'],
    ['CM_ BU_ Gateway "Connects the powertrain bus with the body bus.";', 'CM_ BU_ Gateway "Connects two buses.";'],
    ['BU_: EngineUnit GearUnit BrakeUnit Dashboard Gateway ChargerUnit', 'BU_: EngineUnit GearUnit BrakeUnit Dashboard Gateway ChargerUnit BodyUnit']
  ]);
  const r = run(text, modified);
  checkShape(r);
  assert.deepEqual(listOf(r), expectedList([['DIFF-SIGNAL-FACTOR-CHANGED', B], ['DIFF-MESSAGE-DLC-INCREASED', N], ['DIFF-NODE-COMMENT-CHANGED', C], ['DIFF-NODE-ADDED', N]]));
});

test('the sample with problems compared with the valid sample gives only known codes', function () {
  const r = run(S.sampleFor('valid').text, S.sampleFor('problems').text);
  checkShape(r);
  assert.ok(r.counts.BREAKING > 10);
  const back = run(S.sampleFor('problems').text, S.sampleFor('valid').text);
  checkShape(back);
});

// ---- seeded random changes ---------------------------------------------------------------------

function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(text, rnd) {
  const lines = text.split('\n');
  const n = 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < n; k++) {
    const i = Math.floor(rnd() * lines.length);
    const op = Math.floor(rnd() * 8);
    if (op === 0) lines.splice(i, 1);
    else if (op === 1) lines.splice(i, 0, lines[i]);
    else if (op === 2) lines[i] = lines[i].replace(/\d+/, String(Math.floor(rnd() * 3000)));
    else if (op === 3 && i + 1 < lines.length) { const t = lines[i]; lines[i] = lines[i + 1]; lines[i + 1] = t; }
    else if (op === 4) lines[i] = lines[i].replace(/[A-Za-z]/, String.fromCharCode(97 + Math.floor(rnd() * 26)));
    else if (op === 5) lines[i] = lines[i].slice(0, Math.floor(rnd() * lines[i].length));
    else if (op === 6) lines[i] = lines[i].replace(/\((\d+(\.\d+)?),/, '(' + (Math.floor(rnd() * 100) / 10) + ',');
    else lines[i] = lines[i].replace('@1', '@0');
  }
  return lines.join('\n');
}

test('200 random changes of the sample never throw and give only known codes', function () {
  const rnd = prng(20261112);
  const base = S.sampleFor('valid').text;
  let total = 0;
  for (let round = 0; round < 200; round++) {
    const a = mutate(base, rnd);
    const b = mutate(base, rnd);
    const r = run(a, b);
    checkShape(r);
    const back = run(b, a);
    checkShape(back);
    assert.equal(run(a, a).changes.length, 0, 'a text compared with itself, round ' + round);
    assert.equal(r.changes.length === 0, back.changes.length === 0, 'both directions agree whether there is a difference, round ' + round);
    total += r.changes.length;
  }
  assert.ok(total > 200);
});

// ---- size --------------------------------------------------------------------------------------

function bigText(messages, tweak) {
  const out = ['VERSION ""', '', 'BU_: A B C', ''];
  for (let i = 0; i < messages; i++) {
    out.push('BO_ ' + (1000 + i) + ' Msg' + i + ': 8 A');
    const factor = tweak && i % 100 === 0 ? '0.5' : '0.25';
    out.push(' SG_ Speed' + i + ' : 0|16@1+ (' + factor + ',0) [0|8000] "rpm" B,C');
    out.push(' SG_ Temp' + i + ' : 16|8@1+ (1,-40) [-40|150] "degC" B');
    out.push(' SG_ Flag' + i + ' : 24|1@1+ (1,0) [0|1] "" B');
    out.push(' SG_ Count' + i + ' : 60|4@1+ (1,0) [0|15] "" C');
    out.push('');
  }
  if (tweak) {
    out.push('BO_ 99999 NewOne: 8 A', ' SG_ X : 0|8@1+ (1,0) [0|0] "" B', '');
  }
  return out.join('\n');
}

test('two databases with 10,000 messages are compared in under 5 seconds', function () {
  const oldDb = P.parseDbc(bigText(10000, false));
  const newDb = P.parseDbc(bigText(10000, true));
  const t0 = Date.now();
  const r = X.diffDatabases(oldDb, newDb);
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, 'took ' + ms + ' ms');
  assert.equal(r.counts.BREAKING, 100);
  assert.equal(r.counts['NON-BREAKING'], 1);
  assert.equal(r.matched.messages, 10000);
  const same2 = X.diffDatabases(oldDb, oldDb);
  assert.equal(same2.changes.length, 0);
});

test('a message with thousands of multiplexed signals stops the overlap check at its limit and says so', function () {
  const lines = ['VERSION ""', '', 'BU_: A', '', 'BO_ 1 Big: 64 A', ' SG_ Sel M : 0|16@1+ (1,0) [0|0] "" A'];
  const oldLines = lines.slice();
  const newLines = lines.slice();
  for (let i = 0; i < 3000; i++) { const l = ' SG_ S' + i + ' m' + i + ' : 16|16@1+ (1,0) [0|0] "" A'; oldLines.push(l); newLines.push(l); }
  for (let i = 0; i < 3000; i++) newLines.push(' SG_ T' + i + ' m' + (10000 + i) + ' : 16|16@1+ (1,0) [0|0] "" A');
  const oldDb = P.parseDbc(oldLines.join('\n') + '\n');
  const newDb = P.parseDbc(newLines.join('\n') + '\n');
  const t0 = Date.now();
  const r = X.diffDatabases(oldDb, newDb);
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, 'took ' + ms + ' ms');
  assert.equal(r.changes.length, 3000);
  assert.ok(r.changes.every(function (c) { return c.code === 'DIFF-SIGNAL-ADDED'; }));
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /stopped after/);
});

test('a message with 50,000 signals is compared without recursion problems', function () {
  const lines = ['VERSION ""', '', 'BU_: A', '', 'BO_ 1 Wide: 8 A'];
  for (let i = 0; i < 50000; i++) lines.push(' SG_ S' + i + ' : ' + (i % 64) + '|1@1+ (1,0) [0|1] "" A');
  const text = lines.join('\n') + '\n';
  const t0 = Date.now();
  const r = run(text, text);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.changes.length, 0);
  assert.equal(r.matched.signals, 50000);
});

test('hostile names, comments and units are carried through as plain text', function () {
  const hostile = '<script>alert(1)</script>';
  const a = 'VERSION ""\n\nBU_: A\n\nBO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0|0] "u" A\n';
  const b = 'VERSION ""\n\nBU_: A\n\nBO_ 1 M: 8 A\n SG_ S : 0|8@1+ (1,0) [0|0] "' + hostile + '" A\n';
  const r = run(a, b);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].newValue, hostile);
});
