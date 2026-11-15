# Pro tools: documentation, signal lists and workspace inventory

These four commands belong to Pro; the free 14-day trial includes them. None of them needs the network. They are listed in the Command Palette.

* **CAN Atlas: Create DBC Documentation (Pro)**
* **CAN Atlas: Export Signals As CSV (Pro)**
* **CAN Atlas: Create DBC From Signal CSV (Pro)**
* **CAN Atlas: Create Workspace DBC Inventory (Pro)**

## Create DBC Documentation

Writes a reference document of the DBC file in the editor, as Markdown or as one HTML page.

The document holds:

* the title (the file name), the file comment, a table of contents;
* a summary: version, number of messages, signals, nodes, value tables and attribute definitions, and the attributes of the database itself (for example the bus type);
* a node table: for each node, how many messages it sends and how many signals it receives, and its comment;
* an index of all messages sorted by ID (standard IDs first, then extended): ID in hex and decimal, frame format, name, data length, sender, cycle time, signal count;
* one section per message: comment, ID, data length, sender (and further transmitters), cycle time; a signal table with key letter, name, start bit and length, byte order, value type, factor, offset, minimum, maximum, unit, receivers and the multiplexing condition; signal comments; the value descriptions; and the bit layout grid (see [bit-layout.md](bit-layout.md));
* the value tables and the attribute definitions with ranges, allowed names and defaults.

Details:

* Factors, offsets, minimums and maximums are written as exact decimals ("0.25", "-40"), never as rounded floats.
* Every text of the file (names, comments, units, value descriptions) is escaped. The HTML page has a content security policy that allows inline styles only, no script and no outside address. Anchors are made from the message ID (`msg-s100` for the standard ID 0x100, `msg-x18ff50e5` for an extended ID), never from a name, so they stay valid when a name changes.
* The bit layout grids are included for files of up to 2,000 messages; larger files get the tables without them, to keep the document usable. For a multiplexed message the first six combinations of multiplexor values are shown and the rest is counted.
* The same file always gives the same text; the document contains no date or time of the run.
* A file with 10,000 messages takes under five seconds.

## Export Signals As CSV

Writes one row per signal of the DBC file (messages without signals get one row of their own) as CSV with a header row, comma separated, RFC 4180 quoting, CRLF line ends. Signals that belong to no message (`VECTOR__INDEPENDENT_SIG_MSG`) are not listed.

| Column | Content |
| --- | --- |
| `message_id` | Frame ID as hex text without the extended-frame flag bit, for example `0x123` or `0x18FF50E5` |
| `extended` | `TRUE` for a 29-bit ID, `FALSE` for an 11-bit ID |
| `message` | Message name |
| `dlc` | Data length in bytes |
| `sender` | Sending node (`Vector__XXX` when the file names none) |
| `cycle_time_ms` | Cycle time from the attribute `GenMsgCycleTime` (or `CycleTime`), empty when there is none |
| `signal` | Signal name (empty in a row that only defines a message) |
| `mux` | Multiplexer marker: empty, `M`, `m3` or `m3M` |
| `start_bit`, `length` | As written in the DBC file |
| `byte_order` | `intel` (little-endian, `@1`) or `motorola` (big-endian, `@0`) |
| `sign` | `unsigned` or `signed` |
| `value_type` | `integer`, `float32` or `float64` |
| `factor`, `offset`, `minimum`, `maximum` | Exact decimals in plain notation (no exponent) |
| `unit` | Unit text |
| `receivers` | Receiving nodes separated by `;` |
| `values` | Value descriptions as `raw=text` pairs separated by `;`; a backslash and a semicolon inside a text are written with a backslash in front (`\\`, `\;`) |
| `comment` | Signal comment |
| `message_comment` | Comment of the message (repeated in every row of the message) |

The last column, `message_comment`, is an addition to the usual signal list so that a message comment survives the round trip.

Formula cells: a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets an apostrophe in front, so that a spreadsheet shows it as text instead of running it. A cell that is only a plain number, such as `-40` or `-12.5`, is left alone. The setting `canAtlas.export.neutraliseFormulas` turns this off.

## Create DBC From Signal CSV

Reads a signal table with the same columns and writes a new DBC file from it.

* **Header.** The first row names the columns. Names are case-insensitive and punctuation is ignored, so `Message ID`, `message_id` and `MESSAGE-ID` are the same column. Other columns are ignored. `message_id` and `message` are required; everything else is optional.
* **Delimiter.** Comma, semicolon or tab, detected from the header row. A byte order mark is accepted. In a semicolon-separated file, a cell that contains a `;` (receivers, values) must be in double quotes, as a spreadsheet writes it.
* **Defaults for empty or missing cells.** `extended`: FALSE, or TRUE when the ID is above 0x7FF; `dlc`: 8; `sender`: `Vector__XXX`; `byte_order`: intel; `sign`: unsigned; `value_type`: integer; `factor`: 1; `offset`: 0; `minimum` and `maximum`: 0 (meaning "not given"); `unit`: empty; `receivers`: `Vector__XXX`. A signal row needs `start_bit` and `length`.
* **Several rows of one message.** Rows with the same ID belong to one message and must agree on name, data length, sender and cycle time. An empty cell takes over the value of the earlier rows.
* **Numbers** are read as exact decimals (`0.1`, `1E-3`, `+.5`, `18446744073709551.615`); a decimal comma is refused with a hint.
* **Accepted words.** Byte order: intel, little, little-endian, motorola, big, big-endian, 1, 0. Sign: signed, unsigned, `+`, `-`. Value type: integer, float32, float64, float (decided by the length 32 or 64). Extended: TRUE, FALSE, yes, no, 1, 0.

### Refused rows and warnings

A row that cannot be understood or cannot be part of a valid file is refused with its line number (the line where the row starts, counting lines inside quoted cells); the other rows are still converted. The result lists, for each refused row, what is wrong, for example:

* an ID that is not a number, an 11-bit ID above 0x7FF with `extended` FALSE, an ID above 29 bits;
* a message or signal name that is not a DBC name (letters, digits and `_`, not starting with a digit, not a DBC keyword), a node name that is not;
* a data length that is not 0 to 8, 12, 16, 20, 24, 32, 48 or 64;
* a signal that does not fit into the data length (also for big-endian signals, where the start bit is the most significant bit), a length outside 1 to 64;
* a number that cannot be read, a byte order, sign or value type that is not known, a 32-bit float that is not 32 bits long;
* a multiplexer marker that is not empty, `M`, `m<number>` or `m<number>M`;
* a values cell with an entry without `raw=text`, a raw value that is not a whole number or appears twice;
* a second message with an ID or a name that is already used, a second signal with the same name in a message, rows of one message that disagree;
* a row with more cells than the header, and a quoted cell that is never closed (the rest of the file is not read).

Two things are kept but reported as warnings: a factor of 0 and a minimum above the maximum. **Check Current File** reports them again on the new file.

### What the new file contains

`VERSION` (empty unless given), the usual `NS_` block, `BS_:`, the nodes found in the table, the messages with their signals (multiplexer markers kept), `CM_` comments for messages and signals, `GenMsgCycleTime` (declared as an integer attribute, or as a float attribute when a cycle time is fractional) for messages with a cycle time, `VAL_` value descriptions and `SIG_VALTYPE_` for float signals. Quotes and backslashes inside texts are written the way DBC files write them (`\"` and `\\`); line breaks in units and value descriptions become spaces; a line of a multi-line comment that looks like the start of a statement is joined to the line before it, so that a comment can never end itself early.

Not written: extended multiplexing (`SG_MUL_VAL_`; a signal keeps only its simple `m<value>` marker), value tables that no signal uses, environment variables, signal groups, relation attributes and other attributes than the cycle time. A file that is exported and imported again keeps messages, signals, layouts, scaling, ranges, units, receivers, value descriptions, comments and cycle times, and shows no problem code that the original did not show.

If the table contains an apostrophe that the export put in front of a cell starting with `=`, `+`, `-` or `@`, the import removes it again (and only that apostrophe).

## Create Workspace DBC Inventory

Reads all DBC files of the workspace that match `canAtlas.workspace.include` (default `**/*.dbc`) and not `canAtlas.workspace.exclude` (default `**/{node_modules,.git}/**`), at most `canAtlas.workspace.maxFiles` files, and writes a report as Markdown, HTML or CSV.

For each file: version, number of messages, signals and nodes, number of errors and warnings found by the checks, and the size in bytes.

Collisions between files (the point of the report when several files are used on the same bus):

| Kind | Meaning | Severity |
| --- | --- | --- |
| `id` | The same frame ID (with the same frame format, standard or extended) carries different message names in different files | error |
| `name` | The same message name has different IDs in different files | warning |
| `signal-layout` | The same ID and name appear in several files, but the data length, the set of signals or a signal's start bit, length, byte order, sign, value type, factor, offset or multiplexer marker differs. The first file in the list is the reference; at most 50 differences are listed per message | warning |

A standard ID and an extended ID with the same number are different identifiers and are not a collision. A duplicate inside one file is not a collision between files (the checks of that file report it). Node names that several files define are only counted and listed.

The HTML report has no script and a content security policy that allows inline styles only. The CSV report has two tables: the files (`file, version, messages, signals, nodes, errors, warnings, bytes`) and the collisions (`kind, severity, key, file, message, id, signal, change, detail`); formula cells are neutralised in both as described above. Very long reports are shortened in Markdown and HTML (2,000 rows by default) and say so; the totals always count everything, and at most 5,000 collisions are kept.

One thousand files of twenty messages take under five seconds.
