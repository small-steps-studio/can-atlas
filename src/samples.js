'use strict';
// The samples behind "Open Sample DBC", "Open Sample DBC With Problems" and "Open Sample Trace".
// Every node, message, signal, value and comment is invented for this extension.

const NS = ['NS_ :', '\tNS_DESC_', '\tCM_', '\tBA_DEF_', '\tBA_', '\tVAL_', '\tBA_DEF_DEF_', '\tVAL_TABLE_', '\tSIG_VALTYPE_', '\tBO_TX_BU_', '\tSG_MUL_VAL_', ''];

const VALID = [
  'VERSION "1.4"',
  '',
  ''
].concat(NS, [
  'BS_:',
  '',
  'BU_: EngineUnit GearUnit BrakeUnit Dashboard Gateway ChargerUnit',
  '',
  'VAL_TABLE_ GearPosition 7 "Invalid" 3 "Drive" 2 "Neutral" 1 "Reverse" 0 "Park" ;',
  'VAL_TABLE_ ChargeStates 4 "Fault" 3 "Complete" 2 "Charging" 1 "Precharge" 0 "Idle" ;',
  '',
  'BO_ 256 EngineStatus: 8 EngineUnit',
  ' SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|8000] "rpm" Dashboard,Gateway',
  ' SG_ CoolantTemp : 16|8@1+ (1,-40) [-40|150] "degC" Dashboard',
  ' SG_ ThrottlePosition : 24|8@1+ (0.4,0) [0|100] "%" GearUnit,Gateway',
  ' SG_ EngineTorque : 32|12@1- (0.5,0) [-1024|1023.5] "Nm" GearUnit',
  ' SG_ EngineRunning : 44|1@1+ (1,0) [0|1] "" Dashboard',
  ' SG_ StatusCounter : 60|4@1+ (1,0) [0|15] "" Gateway',
  '',
  'BO_ 288 GearStatus: 4 GearUnit',
  ' SG_ GearSelected : 7|4@0+ (1,0) [0|7] "" Dashboard,EngineUnit',
  ' SG_ ShiftActive : 3|1@0+ (1,0) [0|1] "" Dashboard',
  ' SG_ VehicleSpeed : 15|16@0+ (0.01,0) [0|300] "km/h" Dashboard,BrakeUnit,Gateway',
  ' SG_ GearboxTemp : 31|8@0+ (1,-40) [-40|215] "degC" Dashboard',
  '',
  'BO_ 304 BrakeStatus: 6 BrakeUnit',
  ' SG_ BrakePressure : 0|12@1+ (0.1,0) [0|250] "bar" Dashboard,Gateway',
  ' SG_ BrakePedalPressed : 12|1@1+ (1,0) [0|1] "" EngineUnit,GearUnit',
  ' SG_ WheelSpeedLeft : 16|16@1+ (0.01,0) [0|300] "km/h" Gateway',
  ' SG_ WheelSpeedRight : 32|16@1+ (0.01,0) [0|300] "km/h" Gateway',
  '',
  'BO_ 512 TripComputer: 8 Dashboard',
  ' SG_ PageIndex M : 0|8@1+ (1,0) [0|3] "" Gateway',
  ' SG_ TripDistance m0 : 8|24@1+ (0.1,0) [0|1677721.5] "km" Gateway',
  ' SG_ TripTime m0 : 32|32@1+ (1,0) [0|4294967295] "s" Gateway',
  ' SG_ AverageSpeed m1 : 8|16@1+ (0.1,0) [0|6553.5] "km/h" Gateway',
  ' SG_ AverageConsumption m1 : 24|16@1+ (0.01,0) [0|655.35] "l/100km" Gateway',
  ' SG_ OutsideTemp m2 : 8|8@1- (0.5,0) [-64|63.5] "degC" Gateway',
  ' SG_ BatteryVoltage m2 : 16|16@1+ (0.001,0) [0|65.535] "V" Gateway',
  '',
  'BO_ 2566869221 ChargerStatus: 8 ChargerUnit',
  ' SG_ ChargeCurrent : 0|16@1- (0.1,0) [-3276.8|3276.7] "A" Dashboard,Gateway',
  ' SG_ ChargeVoltage : 16|16@1+ (0.1,0) [0|6553.5] "V" Dashboard,Gateway',
  ' SG_ CellTempMax : 32|8@1+ (1,-40) [-40|215] "degC" Gateway',
  ' SG_ ChargeState : 40|4@1+ (1,0) [0|4] "" Dashboard,Gateway',
  '',
  'BO_ 768 AmbientSensor: 8 Gateway',
  ' SG_ AmbientPressure : 0|32@1- (1,0) [0|2000] "hPa" Dashboard,EngineUnit',
  ' SG_ Inclination : 39|16@0- (0.01,0) [-327.68|327.67] "deg" Dashboard',
  '',
  'BO_ 784 Odometer: 8 Dashboard',
  ' SG_ OdometerTotal : 0|64@1+ (0.001,0) [0|18446744073709551.615] "km" Gateway',
  '',
  'BO_ 2032 GatewayHeartbeat: 1 Gateway',
  ' SG_ AliveCounter : 0|4@1+ (1,0) [0|15] "" EngineUnit,GearUnit,BrakeUnit,Dashboard,ChargerUnit',
  ' SG_ GatewayState : 4|4@1+ (1,0) [0|3] "" Dashboard',
  '',
  'BO_TX_BU_ 512 : Dashboard,Gateway;',
  '',
  '',
  'CM_ "Invented sample network for trying CAN Atlas. Every name and value is made up.";',
  'CM_ BU_ Gateway "Connects the powertrain bus with the body bus.";',
  'CM_ BO_ 256 "Engine speed, coolant temperature, throttle position and torque.";',
  'CM_ SG_ 256 EngineSpeed "Crankshaft speed.";',
  'CM_ SG_ 256 StatusCounter "Counts up with every frame and wraps from 15 to 0.";',
  'CM_ BO_ 512 "Three pages of trip data; PageIndex says which one the frame carries.";',
  'CM_ SG_ 784 OdometerTotal "Total distance with a resolution of one metre, kept as a 64-bit counter.";',
  'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;',
  'BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN","reserved","J1939PG";',
  'BA_DEF_ "BusType" STRING ;',
  'BA_DEF_DEF_ "GenMsgCycleTime" 0;',
  'BA_DEF_DEF_ "VFrameFormat" "StandardCAN";',
  'BA_DEF_DEF_ "BusType" "";',
  'BA_ "BusType" "CAN";',
  'BA_ "GenMsgCycleTime" BO_ 256 10;',
  'BA_ "GenMsgCycleTime" BO_ 288 20;',
  'BA_ "GenMsgCycleTime" BO_ 304 10;',
  'BA_ "GenMsgCycleTime" BO_ 512 100;',
  'BA_ "GenMsgCycleTime" BO_ 2566869221 100;',
  'BA_ "VFrameFormat" BO_ 2566869221 1;',
  'BA_ "GenMsgCycleTime" BO_ 768 50;',
  'BA_ "GenMsgCycleTime" BO_ 784 1000;',
  'BA_ "GenMsgCycleTime" BO_ 2032 500;',
  'VAL_ 256 EngineRunning 1 "Running" 0 "Stopped" ;',
  'VAL_ 288 GearSelected 7 "Invalid" 3 "Drive" 2 "Neutral" 1 "Reverse" 0 "Park" ;',
  'VAL_ 512 PageIndex 2 "Climate" 1 "Average" 0 "Trip" ;',
  'VAL_ 2566869221 ChargeState 4 "Fault" 3 "Complete" 2 "Charging" 1 "Precharge" 0 "Idle" ;',
  'VAL_ 2032 GatewayState 3 "Error" 2 "Degraded" 1 "Running" 0 "Starting" ;',
  'SIG_VALTYPE_ 768 AmbientPressure : 1;',
  ''
]);

const PROBLEMS = [
  'VERSION ""',
  '',
  ''
].concat(NS, [
  'BS_:',
  '',
  'BU_: EngineUnit Dashboard Gateway',
  '',
  'BO_ 256 EngineStatus: 8 EngineUnit',
  ' SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|8000] "rpm" Dashboard,Gateway',
  ' SG_ CoolantTemp : 8|8@1+ (1,-40) [-40|150] "degC" Dashboard',
  ' SG_ OilPressure : 56|16@1+ (0.1,0) [0|10] "bar" Dashbord',
  '',
  'BO_ 288 GearStatus: 4 EngineUnit',
  ' SG_ GearSelected : 7|4@0+ (1,0) [7|0] "" Dashboard',
  '',
  'BO_ 288 GearStatusCopy: 4 EngineUnit',
  ' SG_ GearCopy : 7|4@0+ (1,0) [0|7] "" Dashboard',
  '',
  'BO_ 28036591 DiagnosticData: 8 Gateway',
  ' SG_ DiagCode : 0|16@1+ (1,0) [0|65535] "" Dashboard',
  '',
  '',
  'CM_ "Invented sample with six planted problems: an overlap, a signal beyond the data length, a misspelt receiver, a minimum above the maximum, a duplicate ID and an ID without the extended-frame flag.";',
  ''
]);

// The trace lines are built from a table so that the times stay regular: [milliseconds, id, data].
const TRACE_FRAMES = [
  [0, '100', '401F72FA8E01103C'],
  [2, '120', '20093D4B'],
  [5, '130', 'C40100F907F207'],
  [10, '100', '601F72FA8E0110D0'],
  [12, '200', '00E12E00F00B0000'],
  [15, '130', 'C80100F907F207'],
  [20, '100', '701F73FA9001107A'],
  [22, '120', '30093D4B'],
  [25, '130', 'D20110F807F107'],
  [30, '100', '881F73FA9001108A'],
  [33, '18FF50E5', 'C2FF480E5A02FFFF'],
  [35, '130', 'DC0110F807F107'],
  [40, '100', 'A01F74FA9201109C'],
  [42, '120', '30093E4B'],
  [45, '130', 'E80110F807F107'],
  [48, '300', 'CDCC7D44FF0C0000'],
  [50, '100', 'C01F74FA920110AC'],
  [55, '130', 'F40110F807F107'],
  [60, '100', 'E81F75FA940110B8'],
  [62, '120', '30093F4B'],
  [65, '130', '000210F707F007'],
  [70, '100', '082075FA940110C2'],
  [75, '130', '0C0210F707F007'],
  [80, '100', '282076FA960110DA'],
  [82, '120', '30094049'],
  [85, '130', '180210F707F007'],
  [90, '100', '482076FA960110E2'],
  [95, '130', '240210F707F007'],
  [100, '100', '702077FA980110F6'],
  [102, '120', '30094049'],
  [105, '130', '300210F707F007'],
  [112, '200', '01A0050B04000000'],
  [133, '18FF50E5', 'BEFF4A0E5A02FFFF'],
  [212, '200', '025F05E032000000'],
  [250, '7F0', '11'],
  [312, '200', '00E62E00F10B0000'],
  [320, '310', '40E2010000000000'],
  [333, '18FF50E5', 'BAFF4C0E5B02FFFF'],
  [348, '300', '9A997D44FF0C0000'],
  [750, '7F0', '12'],
  [760, '5A5', '0102']
];

function traceText() {
  return TRACE_FRAMES.map(function (f) {
    // Exact integer arithmetic: whole seconds, then the milliseconds as three digits and three zeros.
    const t = (1762944000 + Math.floor(f[0] / 1000)) + '.' + String(f[0] % 1000).padStart(3, '0') + '000';
    return '(' + t + ') can0 ' + f[1] + '#' + f[2];
  }).join('\n') + '\n';
}

const SAMPLES = {
  valid: { fileName: 'sample-vehicle.dbc', title: 'sample DBC file', languageId: 'dbc', text: function () { return VALID.join('\n'); } },
  problems: { fileName: 'sample-with-problems.dbc', title: 'sample DBC file with six problems', languageId: 'dbc', text: function () { return PROBLEMS.join('\n'); } },
  trace: { fileName: 'sample-trace.log', title: 'sample trace (candump log) for the sample DBC file', languageId: 'plaintext', text: traceText }
};

/** { fileName, title, languageId, text } of a sample, or null. */
function sampleFor(kind) {
  const s = SAMPLES[kind];
  if (!s) return null;
  return { fileName: s.fileName, title: s.title, languageId: s.languageId, text: s.text() };
}

module.exports = { sampleFor: sampleFor, TRACE_FRAMES: TRACE_FRAMES };
