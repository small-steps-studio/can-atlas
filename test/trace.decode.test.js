'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDbc } = require('../src/dbc/parse');
const codec = require('../src/dbc/codec');
const { createDecoder } = require('../src/trace/decode');
const { decodeTrace } = require('../src/trace/run');
const H = require('./helpers/trace-util');

const T0 = 1762944000000000;

// ---- hand-computed expectation for test/fixtures/traces/sample-valid.candump.log ------------------
// Every value below was worked out by hand from the sample DBC file (src/samples.js), not taken from
// the product. Format of a row: [message, signal, raw, physical, unit, description].
// Bit numbering: Intel (@1) signals start at their least significant bit; Motorola (@0) signals
// start at their most significant bit and continue with the lower bits of the byte, then bit 7 of
// the next byte.
const HAND = [
  // 1. 100#401F72FA8E01103C  bytes 40 1F 72 FA 8E 01 10 3C
  //   EngineSpeed 0|16@1+ (0.25): bytes 40 1F -> 0x1F40 = 8000 -> 8000 * 0.25 = 2000
  //   CoolantTemp 16|8: 0x72 = 114 -> 114 - 40 = 74
  //   ThrottlePosition 24|8 (0.4): 0xFA = 250 -> 100
  //   EngineTorque 32|12@1- (0.5): 0x8E (bits 32-39) + low nibble of 0x01 (bits 40-43) * 256 = 142 + 256 = 398 -> 199
  //   EngineRunning 44|1: bit 4 of 0x01 = 0 -> Stopped
  //   StatusCounter 60|4: high nibble of 0x3C = 3
  [0, [['EngineStatus', 'EngineSpeed', '8000', '2000', 'rpm', ''], ['EngineStatus', 'CoolantTemp', '114', '74', 'degC', ''], ['EngineStatus', 'ThrottlePosition', '250', '100', '%', ''],
    ['EngineStatus', 'EngineTorque', '398', '199', 'Nm', ''], ['EngineStatus', 'EngineRunning', '0', '0', '', 'Stopped'], ['EngineStatus', 'StatusCounter', '3', '3', '', '']]],
  // 2. 120#380BB85F
  //   GearSelected 7|4@0+: Motorola, bits 7..4 of byte 0 = high nibble of 0x38 = 3 (Drive)
  //   ShiftActive 3|1@0+: bit 3 of 0x38 (0011 1000) = 1
  //   VehicleSpeed 15|16@0+ (0.01): bytes 1 and 2 big-endian 0x0BB8 = 3000 -> 30
  //   GearboxTemp 31|8@0+ (1,-40): byte 3 0x5F = 95 -> 55
  [2000, [['GearStatus', 'GearSelected', '3', '3', '', 'Drive'], ['GearStatus', 'ShiftActive', '1', '1', '', ''], ['GearStatus', 'VehicleSpeed', '3000', '30', 'km/h', ''], ['GearStatus', 'GearboxTemp', '95', '55', 'degC', '']]],
  // 3. 130#E8131027F401
  //   BrakePressure 0|12 (0.1): 0xE8 + (0x13 & 0xF) * 256 = 232 + 768 = 1000 -> 100
  //   BrakePedalPressed 12|1: bit 4 of 0x13 (0001 0011) = 1
  //   WheelSpeedLeft 16|16 (0.01): 0x27 * 256 + 0x10 = 10000 -> 100
  //   WheelSpeedRight 32|16: 0x01 * 256 + 0xF4 = 500 -> 5
  [5000, [['BrakeStatus', 'BrakePressure', '1000', '100', 'bar', ''], ['BrakeStatus', 'BrakePedalPressed', '1', '1', '', ''], ['BrakeStatus', 'WheelSpeedLeft', '10000', '100', 'km/h', ''], ['BrakeStatus', 'WheelSpeedRight', '500', '5', 'km/h', '']]],
  // 4. 100#601F72FA001E10D0  EngineSpeed 0x1F60 = 8032 -> 2008; torque: 0x00 + (0xE) * 256 = 3584 -> 3584 - 4096 = -512 -> -256;
  //   running: bit 4 of 0x1E (0001 1110) = 1; counter: high nibble of 0xD0 = 13
  [10000, [['EngineStatus', 'EngineSpeed', '8032', '2008', 'rpm', ''], ['EngineStatus', 'CoolantTemp', '114', '74', 'degC', ''], ['EngineStatus', 'ThrottlePosition', '250', '100', '%', ''],
    ['EngineStatus', 'EngineTorque', '-512', '-256', 'Nm', ''], ['EngineStatus', 'EngineRunning', '1', '1', '', 'Running'], ['EngineStatus', 'StatusCounter', '13', '13', '', '']]],
  // 5. 200#00393000100E0000  PageIndex 0 (Trip); TripDistance 8|24 (0.1): 0x003039 = 12345 -> 1234.5; TripTime 32|32: 0x00000E10 = 3600
  [12000, [['TripComputer', 'PageIndex', '0', '0', '', 'Trip'], ['TripComputer', 'TripDistance', '12345', '1234.5', 'km', ''], ['TripComputer', 'TripTime', '3600', '3600', 's', '']]],
  // 6. 18FF50E5#C2FF480E5A02FFFF (extended)  ChargeCurrent 0|16@1- (0.1): 0xFFC2 = 65474 - 65536 = -62 -> -6.2;
  //   ChargeVoltage 16|16 (0.1): 0x0E48 = 3656 -> 365.6; CellTempMax 32|8 (1,-40): 0x5A = 90 -> 50; ChargeState 40|4: low nibble of 0x02 = 2 (Charging)
  [15000, [['ChargerStatus', 'ChargeCurrent', '-62', '-6.2', 'A', ''], ['ChargerStatus', 'ChargeVoltage', '3656', '365.6', 'V', ''], ['ChargerStatus', 'CellTempMax', '90', '50', 'degC', ''], ['ChargerStatus', 'ChargeState', '2', '2', '', 'Charging']]],
  // 7. 120#380BB8 (3 bytes): GearboxTemp needs byte 3 and is left out
  [20000, [['GearStatus', 'GearSelected', '3', '3', '', 'Drive'], ['GearStatus', 'ShiftActive', '1', '1', '', ''], ['GearStatus', 'VehicleSpeed', '3000', '30', 'km/h', '']]],
  // 8. 200#010B02A302000000  PageIndex 1 (Average); AverageSpeed 8|16 (0.1): 0x020B = 523 -> 52.3; AverageConsumption 24|16 (0.01): 0x02A3 = 675 -> 6.75
  [25000, [['TripComputer', 'PageIndex', '1', '1', '', 'Average'], ['TripComputer', 'AverageSpeed', '523', '52.3', 'km/h', ''], ['TripComputer', 'AverageConsumption', '675', '6.75', 'l/100km', '']]],
  // 9. 300#00507D44FB2E0000  AmbientPressure 0|32@1- with SIG_VALTYPE_ 1 (32-bit float): bytes 00 50 7D 44 little-endian = 0x447D5000;
  //   sign 0, exponent 0x88 = 136 -> 2^9, mantissa 1.11111010101b = 1 + 0.9755859375... = 1013.25 / 512 -> 1013.25
  //   Inclination 39|16@0- (0.01): bytes 4 and 5 big-endian 0xFB2E = 64302 - 65536 = -1234 -> -12.34
  [30000, [['AmbientSensor', 'AmbientPressure', '1013.25', '1013.25', 'hPa', ''], ['AmbientSensor', 'Inclination', '-1234', '-12.34', 'deg', '']]],
  // 10. 310#EFCDAB8967452301  OdometerTotal 0|64 (0.001): 0x0123456789ABCDEF = 81985529216486895 -> 81985529216486.895
  [35000, [['Odometer', 'OdometerTotal', '81985529216486895', '81985529216486.895', 'km', '']]],
  // 11. 100#701F73FA9001107A  EngineSpeed 0x1F70 = 8048 -> 2012; coolant 0x73 = 115 -> 75; torque 0x90 + 1 * 256 = 400 -> 200; running 0; counter 7
  [40000, [['EngineStatus', 'EngineSpeed', '8048', '2012', 'rpm', ''], ['EngineStatus', 'CoolantTemp', '115', '75', 'degC', ''], ['EngineStatus', 'ThrottlePosition', '250', '100', '%', ''],
    ['EngineStatus', 'EngineTorque', '400', '200', 'Nm', ''], ['EngineStatus', 'EngineRunning', '0', '0', '', 'Stopped'], ['EngineStatus', 'StatusCounter', '7', '7', '', '']]],
  // 12. 200#02F4383100000000  PageIndex 2 (Climate); OutsideTemp 8|8@1- (0.5): 0xF4 = 244 - 256 = -12 -> -6; BatteryVoltage 16|16 (0.001): 0x3138 = 12600 -> 12.6
  [45000, [['TripComputer', 'PageIndex', '2', '2', '', 'Climate'], ['TripComputer', 'OutsideTemp', '-12', '-6', 'degC', ''], ['TripComputer', 'BatteryVoltage', '12600', '12.6', 'V', '']]],
  // 13. 200#0300000000000000  PageIndex 3 has no description and selects no other signal
  [50000, [['TripComputer', 'PageIndex', '3', '3', '', '']]],
  // 14. 7F0#21  AliveCounter 0|4: low nibble 1; GatewayState 4|4: high nibble 2 (Degraded)
  [250000, [['GatewayHeartbeat', 'AliveCounter', '1', '1', '', ''], ['GatewayHeartbeat', 'GatewayState', '2', '2', '', 'Degraded']]],
  // 15. 5A5#0102 is not in the DBC file: no rows
  // 16. 310#FFFFFFFFFFFFFFFF  2^64 - 1 = 18446744073709551615 -> 18446744073709551.615
  [300000, [['Odometer', 'OdometerTotal', '18446744073709551615', '18446744073709551.615', 'km', '']]]
];

function flatHand() {
  const out = [];
  for (const [t, rows] of HAND) for (const r of rows) out.push([T0 + t].concat(r).join('|'));
  return out;
}
function flatRows(rows) { return rows.map(function (r) { return [r.timeUs, r.messageName, r.signalName, r.rawText, r.physicalText, r.unit, r.valueText].join('|'); }); }

test('the sample trace decodes to the values worked out by hand', async () => {
  const res = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, H.loadSampleDb(), {});
  assert.equal(res.format, 'candump');
  assert.deepEqual(flatRows(res.rows), flatHand());
  assert.equal(res.rows.length, 49);
  assert.equal(res.totalMatching, 49);
  assert.equal(res.truncated, false);
  assert.equal(res.counters.lines, 16);
  assert.equal(res.counters.frames, 16);
  assert.equal(res.counters.decodedFrames, 15);
  assert.equal(res.counters.unknownFrames, 1);
  assert.equal(res.counters.shortFrames, 1);
  assert.equal(res.counters.shortSignals, 1);
  assert.equal(res.counters.badLines, 0);
  assert.deepEqual(res.unknownIds.items.map((u) => [u.idText, u.frames]), [['0x5A5', 1]]);
  assert.equal(res.firstTimeUs, T0);
  assert.equal(res.lastTimeUs, T0 + 300000);
});

test('rows carry the channel and the identifier text of standard and extended frames', async () => {
  const res = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, H.loadSampleDb(), {});
  assert.equal(res.rows[0].channel, 'can0');
  assert.equal(res.rows[0].idText, '0x100');
  const charger = res.rows.find((r) => r.messageName === 'ChargerStatus');
  assert.equal(charger.idText, '0x18FF50E5');
  assert.equal(res.rows.find((r) => r.messageName === 'GatewayHeartbeat').idText, '0x7F0');
});

// ---- statistics worked out by hand ----------------------------------------------------------------
test('statistics of the sample trace match the values worked out by hand', async () => {
  const res = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, H.loadSampleDb(), {});
  const msg = (name) => res.stats.messages.find((m) => m.messageName === name);
  const sig = (m, s) => res.stats.signals.find((x) => x.messageName === m && x.signalName === s);

  // EngineStatus: frames at 0, 10000 and 40000 us -> periods 10000 and 30000.
  //   mean 20000, deviations -10000 and +10000, population standard deviation 10000, jitter 10000, frequency 50 Hz.
  //   Cycle time attribute 10 ms = 10000 us: deviations 0 and 20000; 50 percent is 5000, so one of the two intervals deviates.
  const e = msg('EngineStatus');
  assert.equal(e.frames, 3);
  assert.equal(e.intervals, 2);
  assert.equal(e.meanPeriodUs, 20000);
  assert.equal(e.minPeriodUs, 10000);
  assert.equal(e.maxPeriodUs, 30000);
  assert.equal(e.stdDevPeriodUs, 10000);
  assert.equal(e.jitterUs, 10000);
  assert.equal(e.frequencyHz, 50);
  assert.equal(e.cycleTimeUs, 10000);
  assert.equal(e.maxCycleDeviationUs, 20000);
  assert.equal(e.deviatingIntervals, 1);
  assert.equal(e.verdict, '1 of 2 intervals deviate by more than 50 percent');
  assert.equal(e.firstTimeUs, T0);
  assert.equal(e.lastTimeUs, T0 + 40000);

  // GearStatus: frames at 2000 and 20000 -> one period of 18000; cycle time 20 ms: deviation 2000, well inside 10000.
  const g = msg('GearStatus');
  assert.equal(g.intervals, 1);
  assert.equal(g.meanPeriodUs, 18000);
  assert.equal(g.stdDevPeriodUs, 0);
  assert.equal(g.jitterUs, 0);
  assert.equal(g.maxCycleDeviationUs, 2000);
  assert.equal(g.verdict, 'within 50 percent of the cycle time for every frame');
  assert.equal(g.shortFrames, 1);

  // TripComputer: frames at 12000, 25000, 45000, 50000 -> periods 13000, 20000, 5000, mean 38000 / 3.
  //   Cycle time 100 ms: |13000 - 100000| = 87000, 80000, 95000, all above 50000 -> 3 of 3.
  const t = msg('TripComputer');
  assert.equal(t.intervals, 3);
  const mean = 38000 / 3;
  assert.equal(t.meanPeriodUs, Math.round(mean * 1000) / 1000);
  assert.equal(t.minPeriodUs, 5000);
  assert.equal(t.maxPeriodUs, 20000);
  const variance = ((13000 - mean) ** 2 + (20000 - mean) ** 2 + (5000 - mean) ** 2) / 3;
  assert.equal(t.stdDevPeriodUs, Math.round(Math.sqrt(variance) * 1000) / 1000);
  assert.equal(t.jitterUs, Math.round(Math.max(20000 - mean, mean - 5000) * 1000) / 1000);
  assert.equal(t.maxCycleDeviationUs, 95000);
  assert.equal(t.verdict, '3 of 3 intervals deviate by more than 50 percent');

  // Odometer: frames at 35000 and 300000 -> 265000 against a cycle time of 1 s: 735000 > 500000.
  const o = msg('Odometer');
  assert.equal(o.verdict, '1 of 1 intervals deviate by more than 50 percent');
  assert.equal(o.maxCycleDeviationUs, 735000);

  // A message that appears once has no interval.
  assert.equal(msg('BrakeStatus').meanPeriodUs, null);
  assert.equal(msg('BrakeStatus').verdict, 'fewer than two frames, so there is no interval to compare');

  // Signals: raw values 8000, 8032, 8048 -> sum 24080; physical sum 6020; mean 6020 / 3 = 2006.666667 (6 decimals).
  const speed = sig('EngineStatus', 'EngineSpeed');
  assert.equal(speed.count, 3);
  assert.equal(speed.min, '2000');
  assert.equal(speed.max, '2012');
  assert.equal(speed.mean, '2006.666667');
  assert.equal(speed.minRaw, '8000');
  assert.equal(speed.maxRaw, '8048');
  // Coolant: raw 114, 114, 115 -> physical 74, 74, 75 -> mean 223 / 3 = 74.333333
  assert.equal(sig('EngineStatus', 'CoolantTemp').mean, '74.333333');
  // Torque: raw 398, -512, 400 -> physical 199, -256, 200 -> min -256, max 200, mean 143 / 3 = 47.666667
  const torque = sig('EngineStatus', 'EngineTorque');
  assert.equal(torque.min, '-256');
  assert.equal(torque.max, '200');
  assert.equal(torque.mean, '47.666667');
  assert.equal(torque.minRaw, '-512');
  // Running: 0, 1, 0 -> mean 1 / 3 = 0.333333; counter 3, 13, 7 -> 23 / 3 = 7.666667
  assert.equal(sig('EngineStatus', 'EngineRunning').mean, '0.333333');
  assert.equal(sig('EngineStatus', 'StatusCounter').mean, '7.666667');
  // The gearbox temperature was seen once (the short frame has no byte 3).
  assert.equal(sig('GearStatus', 'GearboxTemp').count, 1);
  assert.equal(sig('GearStatus', 'VehicleSpeed').count, 2);
  // 64-bit odometer: min and max exact, mean = (81985529216486895 + 18446744073709551615) / 2 = 9264364801463019255 -> 9264364801463019.255
  const odo = sig('Odometer', 'OdometerTotal');
  assert.equal(odo.min, '81985529216486.895');
  assert.equal(odo.max, '18446744073709551.615');
  assert.equal(odo.mean, '9264364801463019.255');
  assert.equal(odo.minRaw, '81985529216486895');
  assert.equal(odo.maxRaw, '18446744073709551615');
  // The float signal.
  const amb = sig('AmbientSensor', 'AmbientPressure');
  assert.equal(amb.min, '1013.25');
  assert.equal(amb.max, '1013.25');
  assert.equal(amb.mean, '1013.25');
  // Messages are listed by identifier, standard identifiers first.
  assert.deepEqual(res.stats.messages.map((m) => m.idText), ['0x100', '0x120', '0x130', '0x200', '0x300', '0x310', '0x7F0', '0x18FF50E5']);
});

// ---- the fast path against the codec ------------------------------------------------------------
const AGREE_DBC = [
  'VERSION ""', '', 'NS_ :', '', 'BS_:', '', 'BU_: A B', '',
  'BO_ 1 M1: 8 A',
  ' SG_ s_i16 : 3|16@0- (0.5,-10) [0|0] "u" B',
  ' SG_ s8 : 56|8@1- (1,0) [0|0] "" B',
  ' SG_ u3 : 22|3@1+ (1,0) [0|0] "" B',
  'BO_ 2 M2: 8 A',
  ' SG_ s_m48 : 7|48@0+ (1,0) [0|0] "" B',
  ' SG_ s_m1 : 55|1@0+ (1,0) [0|0] "" B',
  'BO_ 3 M3: 8 A',
  ' SG_ s_l48 : 0|48@1- (-0.001,5) [0|0] "" B',
  ' SG_ big_f : 0|48@1+ (1000,0) [0|0] "" B',
  'BO_ 4 M4: 8 A',
  ' SG_ s_l64 : 0|64@1- (1,0) [0|0] "" B',
  'BO_ 5 M5: 8 A',
  ' SG_ s_49 : 0|49@1+ (3,7) [0|0] "" B',
  ' SG_ s_m64 : 7|64@0+ (0.5,0) [0|0] "" B',
  'BO_ 6 M6: 8 A',
  ' SG_ d64 : 0|64@1+ (1,0) [0|0] "" B',
  'BO_ 7 M7: 8 A',
  ' SG_ f32 : 32|32@1+ (2,1) [0|0] "" B',
  ' SG_ neg : 0|16@1+ (-0.25,100) [0|0] "" B',
  ' SG_ f32m : 7|32@0+ (1,0) [0|0] "" B',
  'BO_ 8 M8: 8 A',
  ' SG_ sw M : 0|4@1+ (1,0) [0|15] "" B',
  ' SG_ sw2 m1M : 4|4@1+ (1,0) [0|15] "" B',
  ' SG_ x1 m1 : 8|8@1+ (1,0) [0|255] "" B',
  ' SG_ x2 m2 : 8|8@1- (1,0) [0|0] "" B',
  ' SG_ y0 m9 : 16|8@1+ (1,0) [0|255] "" B',
  ' SG_ z : 24|8@1+ (1,0) [0|255] "" B',
  'BO_ 9 M9: 2 A',
  ' SG_ wide : 0|16@1+ (1,0) [0|0] "" B',
  '',
  'SG_MUL_VAL_ 8 sw2 sw 1-1;',
  'SG_MUL_VAL_ 8 x1 sw2 0-7;',
  'SG_MUL_VAL_ 8 y0 sw2 8-15;',
  'SG_MUL_VAL_ 8 x2 sw 2-2;',
  'SIG_VALTYPE_ 6 d64 : 2;',
  'SIG_VALTYPE_ 7 f32 : 1;',
  'SIG_VALTYPE_ 7 f32m : 1;',
  'VAL_ 1 s8 -2 "two below" 254 "pattern 254" 0 "zero" ;',
  'VAL_ 4 s_l64 -1 "minus one" ;',
  'VAL_ 8 sw 0 "zero" 1 "one" 2 "two" ;',
  ''
].join('\n');

function nextRandom(seed) {
  const rnd = H.mulberry32(seed);
  return rnd;
}

function agree(db, message, bytes, len, label) {
  const rows = [];
  const dec = createDecoder(db, { maxRows: 0, sink: (r) => rows.push(r) });
  const data = new Uint8Array(64);
  data.set(bytes.subarray(0, len));
  dec.frame({ timeUs: 0, channel: 'c', id: message.frameId, extended: message.extended, fd: false, len: len, data: data });
  const expected = codec.decodeMessage(message, bytes, len).rows.filter((r) => r.status === 'ok').map((r) => [r.signal.name, r.rawText, r.physical, r.text].join('|'));
  const got = rows.map((r) => [r.signalName, r.rawText, r.physicalText, r.valueText].join('|'));
  assert.deepEqual(got, expected, label + ' bytes ' + Buffer.from(bytes.subarray(0, len)).toString('hex'));
  return expected.length;
}

test('the fast path and the codec agree on thousands of random frames (every sample message and edge cases)', () => {
  const dbs = [H.loadSampleDb(), parseDbc(AGREE_DBC)];
  const rnd = nextRandom(777);
  let frames = 0;
  let compared = 0;
  for (const db of dbs) {
    const messages = db.messages.filter((m) => !m.pseudo);
    for (let round = 0; round < 5000 / messages.length; round++) {
      for (const m of messages) {
        const bytes = new Uint8Array(64);
        const style = rnd();
        for (let i = 0; i < 8; i++) bytes[i] = style < 0.15 ? 0 : style < 0.3 ? 0xFF : Math.floor(rnd() * 256);
        if (m.signals.some((s) => s.isMultiplexor) && rnd() < 0.8) bytes[0] = Math.floor(rnd() * 4) | (rnd() < 0.5 ? 0x10 : 0x90);
        const len = rnd() < 0.15 ? Math.floor(rnd() * 9) : Math.max(0, Math.min(8, m.size));
        compared += agree(db, m, bytes, len, m.name);
        frames++;
      }
    }
  }
  assert.ok(frames >= 10000, 'frames compared: ' + frames);
  assert.ok(compared >= 20000, 'signal values compared: ' + compared);
});

test('edge cases agree with the codec: extreme raw values of 48, 49 and 64 bit signals', () => {
  const db = parseDbc(AGREE_DBC);
  const byName = (n) => db.messageByName.get(n);
  const patterns = [new Uint8Array(8).fill(0), new Uint8Array(8).fill(0xFF), Uint8Array.from([0x80, 0, 0, 0, 0, 0, 0, 0]), Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0x80]),
    Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0]), Uint8Array.from([0, 0, 0, 0, 0, 0x80, 0, 0]), Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), Uint8Array.from([0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F])];
  for (const m of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']) for (const p of patterns) agree(db, byName(m), p, Math.min(8, byName(m).size), m);
});

test('a signal with a large factor that does not fit a double uses exact arithmetic', () => {
  const db = parseDbc(AGREE_DBC);
  const rows = [];
  const dec = createDecoder(db, { sink: (r) => rows.push(r) });
  const data = new Uint8Array(64);
  data.set([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0]);
  dec.frame({ timeUs: 0, channel: '', id: 3, extended: false, fd: false, len: 8, data: data });
  const big = rows.find((r) => r.signalName === 'big_f');
  assert.equal(big.rawText, '281474976710655');
  assert.equal(big.physicalText, '281474976710655000');
});

test('multiplexed signals that are not selected are not output, and a short multiplexor hides what it selects', async () => {
  const db = parseDbc(AGREE_DBC);
  const run = (hex) => decodeTrace({ kind: 'text', text: '(1.0) can0 008#' + hex + '\n' }, db, {});
  // sw = 1 (low nibble), sw2 = 3 -> x1 present (sw2 in 0..7); y0 (sw2 8..15) and x2 (sw = 2) absent; z present.
  let res = await run('3155AA77');
  assert.deepEqual(res.rows.map((r) => r.signalName + '=' + r.rawText), ['sw=1', 'sw2=3', 'x1=85', 'z=119']);
  assert.equal(res.rows[0].valueText, 'one');
  // sw = 1, sw2 = 9 -> y0 present.
  res = await run('9155AA77');
  assert.deepEqual(res.rows.map((r) => r.signalName + '=' + r.rawText), ['sw=1', 'sw2=9', 'y0=170', 'z=119']);
  // sw = 2 -> x2 (signed 8 bit) present, sw2 not selected.
  res = await run('02F0AA77');
  assert.deepEqual(res.rows.map((r) => r.signalName + '=' + r.rawText), ['sw=2', 'x2=-16', 'z=119']);
  // sw = 5 -> nothing selected.
  res = await run('05F0AA77');
  assert.deepEqual(res.rows.map((r) => r.signalName + '=' + r.rawText), ['sw=5', 'z=119']);
  // Only one byte: sw and sw2 fit, x1 and z do not.
  res = await run('31');
  assert.deepEqual(res.rows.map((r) => r.signalName + '=' + r.rawText), ['sw=1', 'sw2=3']);
  assert.equal(res.counters.shortSignals, 2);
});

test('a value description is found for the bit pattern of a signed value', async () => {
  const db = parseDbc(AGREE_DBC);
  // s8 is byte 7, signed: 0xFE = -2 -> "two below"; 0x00 -> "zero"; 0x7F has no description.
  for (const [hex, text] of [['00000000000000FE', 'two below'], ['0000000000000000', 'zero'], ['000000000000007F', '']]) {
    const res = await decodeTrace({ kind: 'text', text: '(1.0) can0 001#' + hex + '\n' }, db, {});
    assert.equal(res.rows.find((r) => r.signalName === 's8').valueText, text, hex);
  }
});

test('frames shorter than the message are decoded as far as they reach and counted', async () => {
  const res = await decodeTrace({ kind: 'file', path: H.fixturePath('one-byte-frames.candump.log') }, H.loadSampleDb(), {});
  assert.equal(res.counters.frames, 6);
  assert.equal(res.counters.shortFrames, 4);
  assert.deepEqual(res.rows.filter((r) => r.messageName === 'EngineStatus'), []);
  assert.deepEqual(res.rows.filter((r) => r.messageName === 'GearStatus').map((r) => r.signalName + '=' + r.rawText), ['GearSelected=3', 'ShiftActive=1']);
  assert.deepEqual(res.rows.filter((r) => r.messageName === 'TripComputer').map((r) => r.signalName + '=' + r.rawText), ['PageIndex=2']);
  assert.deepEqual(res.rows.filter((r) => r.messageName === 'GatewayHeartbeat').map((r) => r.signalName + '=' + r.rawText), ['AliveCounter=0', 'GatewayState=0', 'AliveCounter=1', 'GatewayState=2']);
  assert.equal(res.rows.filter((r) => r.messageName === 'Odometer').length, 0);
});

// ---- filters ------------------------------------------------------------------------------------
async function rowsFor(options, fixture) {
  return decodeTrace({ kind: 'file', path: H.fixturePath(fixture || 'sample-valid.candump.log') }, H.loadSampleDb(), options);
}

test('the text filter keeps rows whose message or signal name contains the text, ignoring case', async () => {
  let res = await rowsFor({ filter: { text: 'speed' } });
  assert.deepEqual(Array.from(new Set(res.rows.map((r) => r.signalName))).sort(), ['AverageSpeed', 'EngineSpeed', 'VehicleSpeed', 'WheelSpeedLeft', 'WheelSpeedRight']);
  res = await rowsFor({ filter: { text: 'GEARS' } });
  assert.ok(res.rows.length > 0 && res.rows.every((r) => r.messageName === 'GearStatus'));
  assert.equal(res.totalMatching, res.rows.length);
  res = await rowsFor({ filter: { text: 'no such name' } });
  assert.equal(res.rows.length, 0);
  assert.equal(res.totalMatching, 0);
});

test('the filters for messages and identifiers narrow the rows but not the statistics', async () => {
  let res = await rowsFor({ filter: { messages: ['enginestatus', 'Odometer'] } });
  assert.deepEqual(Array.from(new Set(res.rows.map((r) => r.messageName))), ['EngineStatus', 'Odometer']);
  assert.equal(res.stats.messages.length, 8);
  res = await rowsFor({ filter: { ids: [{ id: 0x18FF50E5, extended: true }, { id: 0x7F0, extended: false }] } });
  assert.deepEqual(Array.from(new Set(res.rows.map((r) => r.messageName))), ['ChargerStatus', 'GatewayHeartbeat']);
  res = await rowsFor({ filter: { ids: [{ id: 0x18FF50E5, extended: false }] } });
  assert.equal(res.rows.length, 0);
});

test('the time window and the channel filter apply to rows and statistics alike', async () => {
  let res = await rowsFor({ filter: { fromUs: T0 + 10000, toUs: T0 + 20000 } });
  assert.deepEqual(res.rows.map((r) => r.timeUs).filter((t, i, a) => a.indexOf(t) === i), [T0 + 10000, T0 + 12000, T0 + 15000, T0 + 20000]);
  assert.equal(res.counters.framesInWindow, 4);
  assert.equal(res.counters.framesOutsideWindow, 12);
  assert.equal(res.stats.messages.find((m) => m.messageName === 'EngineStatus').frames, 1);
  res = await rowsFor({ channel: 'CAN1' });
  assert.equal(res.rows.length, 0);
  assert.equal(res.counters.framesOutsideWindow, 16);
  res = await rowsFor({ channel: 'can1' }, 'extended-ids.candump.log');
  assert.equal(res.counters.framesInWindow, 5);
  res = await rowsFor({ channel: 'bus-b' }, 'extra-columns.csv');
  assert.deepEqual(Array.from(new Set(res.rows.map((r) => r.messageName))), ['GearStatus', 'GatewayHeartbeat']);
});

test('a row limit keeps the first rows and still counts and streams every matching row', async () => {
  const seen = [];
  const res = await rowsFor({ maxRows: 10, sink: (r) => seen.push(r) });
  assert.equal(res.rows.length, 10);
  assert.equal(res.truncated, true);
  assert.equal(res.totalMatching, 49);
  assert.equal(seen.length, 49);
  assert.deepEqual(flatRows(seen), flatHand());
  const none = await rowsFor({ maxRows: 0 });
  assert.equal(none.rows.length, 0);
  assert.equal(none.totalMatching, 49);
  assert.equal(none.stats.signals.length, 30);
});

test('identifiers that are not in the database are counted per identifier, at most 1000 kinds', async () => {
  const lines = [];
  for (let i = 0; i < 1500; i++) lines.push('(' + (i / 1000).toFixed(6) + ') can0 ' + (0x400 + i % 1200).toString(16).toUpperCase().padStart(3, '0') + '#00');
  lines.push('(9.0) can0 400#00');
  const res = await decodeTrace({ kind: 'text', text: lines.join('\n') + '\n' }, H.loadSampleDb(), {});
  assert.equal(res.counters.lines, 1501);
  assert.equal(res.counters.frames + res.counters.badLines, 1501);
  // Standard identifiers above 0x7FF are refused as bad lines; 0x400..0x7FF are 1024 distinct identifiers.
  assert.equal(res.unknownIds.distinct, 1000);
  assert.ok(res.unknownIds.otherFrames > 0);
  assert.equal(res.unknownIds.frames, res.counters.unknownFrames);
  assert.equal(res.unknownIds.items.reduce((a, u) => a + u.frames, 0) + res.unknownIds.otherFrames, res.counters.unknownFrames);
});

test('a database with no usable messages still reads the trace', async () => {
  const db = parseDbc('VERSION ""\n');
  const res = await decodeTrace({ kind: 'file', path: H.fixturePath('sample-valid.candump.log') }, db, {});
  assert.equal(res.rows.length, 0);
  assert.equal(res.counters.unknownFrames, 16);
});
