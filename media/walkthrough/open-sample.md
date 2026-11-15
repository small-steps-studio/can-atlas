## Open a sample DBC file

The sample is a small CAN database with invented data: eight messages from six nodes, with little-endian and big-endian signals, a multiplexed message, a 64-bit counter, a float signal, value tables, comments and cycle times. Every name and value is made up.

A DBC file is plain text. The lines you will see most:

| Line | Meaning |
| --- | --- |
| `BU_:` | the nodes (control units) of the network |
| `BO_ 256 EngineStatus: 8 EngineUnit` | a message: ID, name, data length in bytes, sending node |
| ` SG_ EngineSpeed : 0\|16@1+ (0.25,0) [0\|8000] "rpm" Dashboard` | a signal: start bit, length, byte order (`1` little-endian, `0` big-endian), sign, factor and offset, range, unit, receivers |
| `VAL_` | value descriptions of a signal |
| `CM_` | comments |
| `BA_` | attributes, for example the cycle time of a message |

Files with the extension `.dbc` open in the DBC language, and so does a file whose first line starts with `VERSION "`.
