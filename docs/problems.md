# Problems and codes

CAN Atlas checks DBC files, the text format of CAN databases, and reports every problem with a stable code, a severity and a message that names what it found. This page explains each code: when it is raised, why it matters when you integrate nodes on a network, a short invented example and how to fix it.

These are structural checks of the text of the file: syntax, names, identifiers, bit layout, ranges, value descriptions, multiplexing and attributes. They do not show that a database is correct, that it conforms to any standard, or that another tool will accept it. A text check cannot know whether a signal has the right meaning, whether a cycle time is right or whether a node really sends or receives what the file says. You stay responsible for the database you release.

## How problems are shown

* Problems appear as underlines in the editor and in the Problems view, with the source name "CAN Atlas". In the Problems view the code is a link to its section on this page.
* A file is checked when it is opened and saved, and while you type if `canAtlas.validateOnType` is on (after a short pause; files above 2 MB are only checked when opened and saved). Files above `canAtlas.maxFileSizeMB` (20 MB by default) are checked only with **CAN Atlas: Check Current File**.
* One mistake often causes several problems. Work from the top of the file down and check again: a `BO_` line that cannot be read, for example, makes every signal below it report `DBC-SIGNAL-WITHOUT-MESSAGE`.
* The examples below use invented names. A snippet can raise other problems besides the one it is shown for (for example a note for a message without signals); the text names those that matter.
* **CAN Atlas: Open Sample DBC With Problems** opens an invented file that raises several of these codes.

### Severities

| Severity | Meaning |
| --- | --- |
| Error | The file breaks a rule of the DBC text format or contradicts itself, so that a statement, name, message or signal cannot be used as written. Fix these first. |
| Warning | The file can be read, but something is probably not what you meant, or it is unusual enough to check. |
| Note | Information. Often intended. Hide the code if it does not help you. |

### Hiding a code

The setting `canAtlas.problems.disabledCodes` lists codes that are not reported. Put it into the settings of the user or the workspace:

```json
"canAtlas.problems.disabledCodes": ["DBC-SIGNAL-NO-RECEIVER", "DBC-NAME-LONG"]
```

* Only entries of the form `DBC-...` are read, and at most 200 of them.
* A hidden problem is not listed and not counted in the totals. Hiding a code only hides the report; the file is read and decoded in exactly the same way.
* `DBC-LIST-CUT` cannot be hidden; see its section.
* `canAtlas.maxProblems` (1000 by default) is the longest list per file.

### Stable codes

The codes do not change between versions; a new check gets a new code. Search for the code, filter by it or quote it in a ticket. The wording of a message can be improved over time.

## Index of codes

| Code | Severity | Meaning |
| --- | --- | --- |
| [`DBC-SYNTAX`](#dbc-syntax) | Error | A statement cannot be read. |
| [`DBC-SEMICOLON`](#dbc-semicolon) | Warning | A statement is missing its closing ";". |
| [`DBC-STRING-UNTERMINATED`](#dbc-string-unterminated) | Error | A text in double quotes has no closing quote. |
| [`DBC-UNKNOWN-STATEMENT`](#dbc-unknown-statement) | Warning | A line starts with a word that is not a DBC keyword. |
| [`DBC-ENCODING`](#dbc-encoding) | Warning | The file contains the replacement character U+FFFD. |
| [`DBC-SIGNAL-WITHOUT-MESSAGE`](#dbc-signal-without-message) | Error | A signal line is not inside a message. |
| [`DBC-NAME-INVALID`](#dbc-name-invalid) | Error | A name has characters DBC names do not allow, or is a keyword. |
| [`DBC-NAME-LONG`](#dbc-name-long) | Note | A name is longer than 32 characters. |
| [`DBC-NAME-CASE`](#dbc-name-case) | Warning | Two names differ only in upper and lower case. |
| [`DBC-NODE-DUPLICATE`](#dbc-node-duplicate) | Warning | A node is listed twice. |
| [`DBC-SENDER-UNKNOWN`](#dbc-sender-unknown) | Warning | A sending node is not in the node list. |
| [`DBC-RECEIVER-UNKNOWN`](#dbc-receiver-unknown) | Warning | A receiving node is not in the node list. |
| [`DBC-SIGNAL-NO-RECEIVER`](#dbc-signal-no-receiver) | Note | A signal has no receiving node. |
| [`DBC-MESSAGE-ID-DUPLICATE`](#dbc-message-id-duplicate) | Error | Two messages have the same ID. |
| [`DBC-MESSAGE-NAME-DUPLICATE`](#dbc-message-name-duplicate) | Error | Two messages have the same name. |
| [`DBC-MESSAGE-ID-RANGE`](#dbc-message-id-range) | Error | An ID does not fit into 32 bits, or into 29 bits with the extended flag. |
| [`DBC-MESSAGE-EXTENDED-FLAG`](#dbc-message-extended-flag) | Warning | An ID needs more than 11 bits but the extended-frame flag is not set. |
| [`DBC-MESSAGE-FRAME-FORMAT`](#dbc-message-frame-format) | Warning | The frame-format attribute and the written ID disagree. |
| [`DBC-MESSAGE-DLC`](#dbc-message-dlc) | Error | The data length is above 64 bytes. |
| [`DBC-MESSAGE-DLC-FD`](#dbc-message-dlc-fd) | Warning | The data length is not a length a frame can have. |
| [`DBC-MESSAGE-NO-SIGNALS`](#dbc-message-no-signals) | Note | A message has no signals. |
| [`DBC-TRANSMITTER-UNKNOWN-MESSAGE`](#dbc-transmitter-unknown-message) | Warning | An extra-transmitter statement names an ID that no message has. |
| [`DBC-SIGNAL-NAME-DUPLICATE`](#dbc-signal-name-duplicate) | Error | Two signals of one message have the same name. |
| [`DBC-SIGNAL-LENGTH`](#dbc-signal-length) | Error | A signal length is not 1 to 64 bits. |
| [`DBC-SIGNAL-OUTSIDE-FRAME`](#dbc-signal-outside-frame) | Error | A signal does not fit into the data length of its message. |
| [`DBC-SIGNAL-OVERLAP`](#dbc-signal-overlap) | Error | Two signals that can be present together use the same bits. |
| [`DBC-VALTYPE-INVALID`](#dbc-valtype-invalid) | Error | A float value type does not match the length, or the type is unknown. |
| [`DBC-VALTYPE-UNKNOWN`](#dbc-valtype-unknown) | Warning | A value-type statement names a signal that does not exist. |
| [`DBC-NUMBER`](#dbc-number) | Error | A factor, offset, minimum or maximum cannot be read as an exact number. |
| [`DBC-FACTOR-ZERO`](#dbc-factor-zero) | Error | The factor of a signal is 0. |
| [`DBC-RANGE-INVERTED`](#dbc-range-inverted) | Error | The minimum is greater than the maximum. |
| [`DBC-RANGE-OUTSIDE-RAW`](#dbc-range-outside-raw) | Warning | The range goes beyond what the raw bits can express. |
| [`DBC-VALUE-NOT-WHOLE`](#dbc-value-not-whole) | Warning | A value description is given for a number that is not whole. |
| [`DBC-VAL-UNKNOWN-MESSAGE`](#dbc-val-unknown-message) | Warning | A value-description statement names an ID that no message has. |
| [`DBC-VAL-UNKNOWN-SIGNAL`](#dbc-val-unknown-signal) | Warning | A value-description statement names a signal the message does not have. |
| [`DBC-VAL-DUPLICATE`](#dbc-val-duplicate) | Warning | A raw value is described twice, or a signal has two description lists. |
| [`DBC-VALUE-OUTSIDE-RAW`](#dbc-value-outside-raw) | Warning | A described raw value cannot occur in the signal. |
| [`DBC-VALUE-TABLE-MISSING`](#dbc-value-table-missing) | Warning | A signal type names a value table that is not defined. |
| [`DBC-VALUE-TABLE-UNUSED`](#dbc-value-table-unused) | Note | No signal uses a named value table. |
| [`DBC-VALUE-TABLE-DUPLICATE`](#dbc-value-table-duplicate) | Warning | A named value table is defined twice. |
| [`DBC-MUX-NO-MULTIPLEXOR`](#dbc-mux-no-multiplexor) | Error | A multiplexed signal in a message without a multiplexor. |
| [`DBC-MUX-AMBIGUOUS`](#dbc-mux-ambiguous) | Error | Several multiplexors could select a signal. |
| [`DBC-MUX-VALUE-RANGE`](#dbc-mux-value-range) | Warning | The multiplexor can never hold the value that selects a signal. |
| [`DBC-MUX-SWITCH-FLOAT`](#dbc-mux-switch-float) | Error | A multiplexor is a floating-point signal. |
| [`DBC-MUX-UNUSED`](#dbc-mux-unused) | Note | A multiplexor selects no signal. |
| [`DBC-MUX-NOT-MULTIPLEXED`](#dbc-mux-not-multiplexed) | Warning | An extended-multiplexing statement names a signal that is not multiplexed. |
| [`DBC-MUX-EXTENDED-UNKNOWN`](#dbc-mux-extended-unknown) | Warning | An extended-multiplexing statement names something that does not exist. |
| [`DBC-MUX-EXTENDED-RANGE`](#dbc-mux-extended-range) | Error | A range of multiplexor values ends below its start. |
| [`DBC-MUX-EXTENDED-MISMATCH`](#dbc-mux-extended-mismatch) | Warning | The written value is not in the extended ranges. |
| [`DBC-MUX-EXTENDED-DUPLICATE`](#dbc-mux-extended-duplicate) | Warning | A signal has two extended-multiplexing statements. |
| [`DBC-MUX-CYCLE`](#dbc-mux-cycle) | Error | Multiplexors select each other in a loop. |
| [`DBC-MUX-TOO-DEEP`](#dbc-mux-too-deep) | Error | Multiplexors are nested more than 32 levels deep. |
| [`DBC-COMMENT-UNKNOWN`](#dbc-comment-unknown) | Warning | A comment belongs to a node, message, signal or variable that does not exist. |
| [`DBC-ATTRIBUTE-UNDEFINED`](#dbc-attribute-undefined) | Warning | An attribute is used or given a default without a definition. |
| [`DBC-ATTRIBUTE-UNKNOWN-OBJECT`](#dbc-attribute-unknown-object) | Warning | An attribute is set for an object that does not exist. |
| [`DBC-ATTRIBUTE-VALUE`](#dbc-attribute-value) | Warning | An attribute value does not fit its definition. |
| [`DBC-ATTRIBUTE-OBJECT-TYPE`](#dbc-attribute-object-type) | Warning | An attribute is set for another kind of object than it is defined for. |
| [`DBC-ATTRIBUTE-DUPLICATE-DEF`](#dbc-attribute-duplicate-def) | Warning | An attribute is defined twice. |
| [`DBC-CHECK-LIMIT`](#dbc-check-limit) | Note | The overlap check of a message stopped early. |
| [`DBC-FILE-LIMIT`](#dbc-file-limit) | Warning | The file is too large to be read completely. |
| [`DBC-LIST-CUT`](#dbc-list-cut) | Note | The list of problems was cut at `canAtlas.maxProblems`. |

## Syntax and reading

### DBC-SYNTAX
Error. A statement cannot be read because a part of it is missing, misplaced or has the wrong form.

**When.** The reader expects a certain part and finds something else. The message says what was expected and quotes what was found. This covers the node list after `BU_`; a `BO_` line (ID, name, ":", data length, sending node); an `SG_` line (name, optional multiplexer indicator, ":", `start|length@order sign`, `(factor,offset)`, `[minimum|maximum]`, the unit in double quotes, receivers); the parts of `CM_`, `BA_DEF_`, `BA_DEF_DEF_`, `BA_`, `VAL_`, `VAL_TABLE_`, `SIG_VALTYPE_`, `SG_MUL_VAL_` and `BO_TX_BU_`; other text where a statement should end with ";"; and a character where a statement should start. After a failure the reader goes on at the next statement: behind the next ";" or at the next line that starts with a statement keyword. A `BO_` line that cannot be read up to its data length, and an `SG_` line that cannot be read up to its unit, are left out of the database.

**Why it matters.** A statement that is left out is missing from every table, hover and decode, and it causes follow-up problems elsewhere: signals without a message, descriptions for signals that "do not exist". The first `DBC-SYNTAX` of a file is the one to fix first.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0 [0|250] "km/h" Dash
 SG_ Rpm : 16|16@1+ (1,0) [0|8000] "rpm" Dash
```

The first signal has no ")" after the offset. The message reads `Expected ")" after the offset, found "[0|250] "km/".` and the signal `Speed` is left out.

**Fix.** Correct the statement as the message says, then check again.

### DBC-SEMICOLON
Warning. A statement that must end with ";" does not.

**When.** `CM_`, `BA_DEF_`, `BA_DEF_DEF_`, `BA_`, `SIG_VALTYPE_`, `SG_MUL_VAL_`, `BO_TX_BU_` and the value lists of `VAL_` and `VAL_TABLE_` end with ";" in the DBC format. The code is raised when the statement is followed by the end of the file or by a line that starts with a statement keyword. The statement is still read and used. If other text follows instead, the problem is `DBC-SYNTAX`. `BO_`, `SG_`, `BU_` and `VERSION` lines need no ";".

**Why it matters.** Without the ";" the end of the statement is a guess; here it is taken from the next keyword at the start of a line. A reader that works differently can run two statements together.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
CM_ SG_ 256 Speed "Vehicle speed"
```

**Fix.** Add the ";" at the end of the statement.

### DBC-STRING-UNTERMINATED
Error. A text in double quotes has no closing quote.

**When.** It is raised for the version text, a unit, a value description, a comment and the text value of an attribute or attribute default. The text of a unit, a version and a value description ends at the end of its line. A comment or text value may span lines; it counts as unterminated when a line that looks like the start of a statement (for example `BO_ 256 ...`) comes before the closing quote. An attribute name without a closing quote is reported as `DBC-SYNTAX`.

**Why it matters.** Everything up to the point where the reader gave up is taken as the text. An unclosed unit swallows the receiver list behind it (the signal then also reports `DBC-SIGNAL-NO-RECEIVER`); an unclosed comment is cut short.

```dbc
BU_: Gateway Dash
CM_ BU_ Gateway "Main gateway;
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
```

The ";" is inside the unclosed text, so the comment also reports `DBC-SEMICOLON`.

**Fix.** Add the closing double quote. A double quote inside a text is written `\"`, a backslash `\\`.

### DBC-UNKNOWN-STATEMENT
Warning. A line starts with a word that is not a DBC statement keyword, so the statement is skipped.

**When.** The first word of a statement is not one of the keywords CAN Atlas knows. Keywords are case-sensitive (`bo_` is not `BO_`). The reader skips ahead to the next line that starts with a known keyword. Statements of kinds that CAN Atlas knows but does not evaluate (environment variable data, signal groups, categories, relation attributes and similar) are passed over without any problem.

**Why it matters.** The usual cause is a misspelt keyword, and then everything the statement should have defined is missing. A misspelt `BO_` also makes the signals below it report `DBC-SIGNAL-WITHOUT-MESSAGE`.

```dbc
BU_: Gateway Dash
B0_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
```

`B0_` is written with a zero. The signal below it reports `DBC-SIGNAL-WITHOUT-MESSAGE` as well.

**Fix.** Correct the keyword. If the statement belongs to a part of the format that is not needed, remove it or hide the code.

### DBC-ENCODING
Warning. The file contains the replacement character U+FFFD, which an editor inserts for bytes it could not decode.

**When.** The text contains U+FFFD anywhere. It is reported once, at the first one. The editor puts this character in place of bytes it cannot decode with the encoding it chose. DBC files are often saved as Windows-1252.

**Why it matters.** Saving the file now writes the replacement character into it for good and the original letters are lost. Units such as the degree sign and letters with accents in comments are the usual victims.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Temp : 0|8@1+ (1,-40) [-40|215] "�C" Dash
```

The unit was meant to be the degree sign followed by C.

**Fix.** Do not save yet. Reopen the file with the right encoding (**Reopen with Encoding**, then Western, which is Windows 1252) and check that the characters look right. Only then save. If the character was typed on purpose, hide the code.

### DBC-SIGNAL-WITHOUT-MESSAGE
Error. A signal line (`SG_`) is not inside a message.

**When.** An `SG_` line has no message to belong to. A signal belongs to the `BO_` line above it, or to the signal above it. Any other statement between them, an unknown keyword included, ends the message. The same happens below a `BO_` line that could not be read (`DBC-SYNTAX`) or was misspelt (`DBC-UNKNOWN-STATEMENT`).

**Why it matters.** The signal belongs to no message, so it is not checked further and cannot be found by an ID.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BA_DEF_ "Project" STRING;
 SG_ Rpm : 16|16@1+ (1,0) [0|8000] "rpm" Dash
```

The `BA_DEF_` line ends the message, so `Rpm` has none.

**Fix.** Put the `SG_` lines directly under the `BO_` line of their message. If the `BO_` line has its own problem, fix that first; the follow-up problems of its signals go away with it.

## Names and nodes

### DBC-NAME-INVALID
Error. A node, message, signal or value table name is not a valid DBC name.

**When.** The name contains a character other than the ASCII letters, digits and "_", starts with a digit, or is a DBC keyword (case-sensitive, for example `BO_`, `SG_`, `VAL_` or `FILTER`). Letters with accents do not count as letters here. The reader takes everything up to a space, comma, colon, semicolon, "|", "@", bracket or quote as one name, so `Gate-way` is read as one name and reported. Names of attributes, comments and environment variables are not checked.

**Why it matters.** Names in a DBC file are identifiers. A name outside the allowed characters can be misread, changed or refused by the tools that read the file.

```dbc
BU_: Gate-way Dash
BO_ 256 Engine: 8 Gate-way
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
```

**Fix.** Use letters, digits and "_", not starting with a digit. Change every use of the name (sender and receiver lists as well).

### DBC-NAME-LONG
Note. A node, message, signal or value table name has more than 32 characters.

**When.** The name is valid but longer than 32 characters. The message gives the limit as the longest name several CAN tools accept. CAN Atlas itself reads longer names without trouble. A name that is invalid for another reason reports `DBC-NAME-INVALID` instead.

**Why it matters.** When you hand the file to another team or tool, a longer name may be cut or refused there.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Engine_coolant_temperature_request : 0|8@1+ (1,-40) [-40|215] "degC" Dash
```

**Fix.** Shorten the name everywhere it is used, or hide the code if every tool you use accepts long names.

### DBC-NAME-CASE
Warning. Two names of the same kind differ only in upper and lower case.

**When.** Two node names in the file, two message names in the file, or two signal names in one message are equal after conversion to lower case but not written the same. It is reported at the later name. Names that are exactly equal have their own codes (`DBC-NODE-DUPLICATE`, `DBC-MESSAGE-NAME-DUPLICATE`, `DBC-SIGNAL-NAME-DUPLICATE`). Value table names and names of different kinds are not compared.

**Why it matters.** The message says it: tools that ignore case treat the two names as the same name. In such a tool one of them hides the other.

```dbc
BU_: Gateway gateway
```

**Fix.** Rename one of them so that they differ by more than case.

### DBC-NODE-DUPLICATE
Warning. A node is listed twice in `BU_`.

**When.** The same node name appears twice in the node list, in one line or in several `BU_` lines.

**Why it matters.** A node is one device on the network. The second entry adds nothing and can hide a mistake in the list, such as a misspelt name.

```dbc
BU_: Gateway Dash Gateway
```

**Fix.** Delete the second entry.

### DBC-SENDER-UNKNOWN
Warning. A sending node is not listed in `BU_`.

**When.** There are two sources: the sending node at the end of a `BO_` line, and the node names in a `BO_TX_BU_` statement (extra transmitters). `Vector__XXX`, the placeholder DBC files use for "no node", is always accepted. Without a `BU_` line every sender is reported.

**Why it matters.** The node list defines the devices of the network. A sender that is not in it is usually a spelling mistake or a node that was removed from the list but not from the messages.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Motor
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BO_TX_BU_ 256 : Spare;
```

Both `Motor` and `Spare` are reported, with different texts (`The sending node ...` and `The transmitting node ...`).

**Fix.** Correct the spelling, or add the node to `BU_`.

### DBC-RECEIVER-UNKNOWN
Warning. A receiving node of a signal is not listed in `BU_`.

**When.** A name in the receiver list at the end of an `SG_` line is not in the node list and is not `Vector__XXX`. Each unknown name is reported at its place in the list.

**Why it matters.** A misspelt receiver means that the real node is missing from the signal's receivers, and a node that does not exist appears instead.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dahs
```

**Fix.** Correct the spelling, or add the node to `BU_`.

### DBC-SIGNAL-NO-RECEIVER
Note. A signal has no receiving node.

**When.** The receiver list of an `SG_` line holds no node other than `Vector__XXX`, the placeholder for "no node". The message says whether `Vector__XXX` is written or no receiver is listed at all.

**Why it matters.** A signal that nobody receives is sent for nothing, or its receivers were forgotten. Both are worth a look when you integrate a new node.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Vector__XXX
 SG_ Rpm : 16|16@1+ (1,0) [0|8000] "rpm"
```

**Fix.** List the receiving nodes. Diagnostic or logging signals may be intended this way; then hide the code.

## Messages and IDs

The number after `BO_` is the CAN identifier. A standard frame has an 11-bit identifier (0 to 0x7FF). An extended frame has a 29-bit identifier (0 to 0x1FFFFFFF); in a DBC file it is written with bit 31 set, that is with 2147483648 (0x80000000) added. CAN Atlas shows IDs in hexadecimal, for example `0x100` or `0x18FEF100 (extended)`.

### DBC-MESSAGE-ID-DUPLICATE
Error. Two messages have the same ID.

**When.** Two `BO_` lines carry the same number. The number is compared as written, including bit 31, so a standard `0x123` (291) and an extended `0x80000123` (2147483939) are different messages. It is reported at the ID of the later message, and the message text names the first one.

**Why it matters.** A receiver finds a message by its ID, so only one of the two can be what it receives. The statements that refer to a message by ID (`CM_`, `BA_`, `VAL_`, `SIG_VALTYPE_`, `SG_MUL_VAL_`, `BO_TX_BU_`) are applied to the first message with that ID.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BO_ 256 Brake: 8 Gateway
 SG_ Pressure : 0|8@1+ (1,0) [0|200] "bar" Dash
```

**Fix.** Give each message its own ID. If both messages were meant to be one, merge their signals.

### DBC-MESSAGE-NAME-DUPLICATE
Error. Two messages have the same name.

**When.** Two `BO_` lines carry the same name, with different IDs. It is reported at the later name, and the message text names the ID of the first one.

**Why it matters.** Logs, scripts and test setups often refer to messages by name. Two messages with one name cannot be told apart there.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BO_ 257 Engine: 8 Gateway
 SG_ Pressure : 0|8@1+ (1,0) [0|200] "bar" Dash
```

**Fix.** Rename one of the messages.

### DBC-MESSAGE-ID-RANGE
Error. A message ID is too large.

**When.** There are two cases. The ID is larger than 4294967295, the largest number of 32 bits (an ID with more than 15 digits counts as larger). Or the extended-frame flag (bit 31) is set but the rest is larger than 0x1FFFFFFF, which does not fit into the 29 bits of an extended identifier.

**Why it matters.** No frame can carry such an identifier, so the message can never be received.

```dbc
BU_: Gateway Dash
BO_ 4294967296 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BO_ 3221225472 Brake: 8 Gateway
 SG_ Pressure : 0|8@1+ (1,0) [0|200] "bar" Dash
```

The first ID needs 33 bits. The second has the flag set and the remaining value `0x40000000` needs 31 bits.

**Fix.** Check the ID. A standard ID is at most 2047; an extended ID is the 29-bit identifier plus 2147483648.

### DBC-MESSAGE-EXTENDED-FLAG
Warning. An ID needs more than 11 bits, but the extended-frame flag (bit 31) is not set.

**When.** The ID is above 2047 (0x7FF) and below 2147483648. The message suggests the number with the flag added, but only up to 536870911 (0x1FFFFFFF), the largest 29-bit identifier. For a larger number the message says that the ID does not fit into 29 bits either; writing the flag would give `DBC-MESSAGE-ID-RANGE`.

**Why it matters.** Without the flag the number is read as a standard identifier, and no standard identifier is that large. The number cannot be the ID of a standard frame.

```dbc
BU_: Gateway Dash
BO_ 65280 Status: 8 Gateway
 SG_ State : 0|8@1+ (1,0) [0|255] "" Dash
```

**Fix.** For an extended frame, add 2147483648 to the number (here `2147548928`). If the frame is a standard frame, the ID is wrong.

### DBC-MESSAGE-FRAME-FORMAT
Warning. The frame-format attribute of a message and the way its ID is written disagree.

**When.** The message has its own value of the attribute `VFrameFormat` (a default from `BA_DEF_DEF_` does not count), the attribute is defined as an ENUM, and the text of the value contains "extended" or "j1939" (any case) while the ID has no bit 31, or contains "standard" while the ID has bit 31.

**Why it matters.** The attribute and the number say different things about the same frame. One of them is wrong, and a tool may follow either.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN";
BA_ "VFrameFormat" BO_ 256 1;
```

Value 1 is `ExtendedCAN`, but 256 is written as a standard ID.

**Fix.** Change the attribute, or the ID (add 2147483648 for an extended frame).

### DBC-MESSAGE-DLC
Error. The data length of a message is larger than 64 bytes.

**When.** The number after the colon in the `BO_` line is above 64. The number is a count of bytes, not a CAN FD data length code. 64 bytes is the most a CAN FD frame carries.

**Why it matters.** No frame is that long. Signals can only be placed in the first 64 bytes; this message is checked against 64 bytes.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 65 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
```

**Fix.** Use the real data length in bytes.

### DBC-MESSAGE-DLC-FD
Warning. The data length of a message is not a length a frame can have.

**When.** The length is not 0 to 8 and not one of 12, 16, 20, 24, 32, 48 or 64. The length is a count of bytes.

**Why it matters.** Classic CAN carries 0 to 8 bytes and CAN FD the larger steps above. A frame of 10 bytes does not exist, so the length written here does not describe a frame.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 10 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
```

**Fix.** Write the length the frame really has (here 12). Signals can only use bytes inside that length.

### DBC-MESSAGE-NO-SIGNALS
Note. A message has no signals.

**When.** A `BO_` line has no `SG_` line under it.

**Why it matters.** Often intended: a reserved ID, or a message whose content is not described yet. If signals were expected, they may have been lost or misplaced (see `DBC-SIGNAL-WITHOUT-MESSAGE`).

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
```

**Fix.** Add the signals, or hide the code.

### DBC-TRANSMITTER-UNKNOWN-MESSAGE
Warning. A `BO_TX_BU_` statement names an ID that no message has.

**When.** The ID in a `BO_TX_BU_` statement (extra transmitters of a message) is not the ID of any `BO_` line. The ID is compared as written, including bit 31. Unknown node names in the same statement are reported as `DBC-SENDER-UNKNOWN`.

**Why it matters.** The statement is not used. The extra transmitters you meant are not attached to any message.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BO_TX_BU_ 300 : Dash;
```

**Fix.** Correct the ID, or delete the statement.

## Signals and layout

How start bit, length and byte order place a signal in the frame is described in [bit-layout.md](bit-layout.md). In short: `@1` is little-endian (Intel) and the start bit is the least significant bit; `@0` is big-endian (Motorola) and the start bit is the most significant bit.

### DBC-SIGNAL-NAME-DUPLICATE
Error. Two signals of one message have the same name.

**When.** An `SG_` line repeats the name of an earlier signal of the same message. The same name in two different messages is not reported. It is reported at the later name.

**Why it matters.** Statements such as `VAL_`, `CM_` and `BA_` find a signal by message ID and name, so they can reach only the first one. The second cannot be told apart.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
 SG_ Speed : 16|8@1+ (1,0) [0|255] "" Dash
```

**Fix.** Rename one of the signals.

### DBC-SIGNAL-LENGTH
Error. The length of a signal is not 1 to 64 bits.

**When.** The number after "|" in the signal specification is 0 or above 64. (A negative number cannot be read and is reported as `DBC-SYNTAX`.) The signal is left out of the layout, overlap and decode work.

**Why it matters.** The reader and the tools that decode frames handle raw values of up to 64 bits.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|0@1+ (0.1,0) [0|250] "km/h" Dash
 SG_ Counter : 0|65@1+ (1,0) [0|0] "" Dash
```

**Fix.** Write the real length in bits. A signal longer than 64 bits has to be split.

### DBC-SIGNAL-OUTSIDE-FRAME
Error. A signal does not fit into the data length of its message.

**When.** The bits of the signal reach beyond the last byte of the message. For a little-endian signal these are the bits from the start bit up to start bit plus length minus 1. For a big-endian signal the start bit is the most significant bit and the signal runs downwards, then continues with bit 7 of the next byte; the message names the most significant and least significant bit and the byte it ends in, and reminds you that the start bit of a big-endian signal is its most significant bit. A start bit above 4095 is also reported. A message longer than 64 bytes is checked against 64. The signal is left out of the overlap check.

**Why it matters.** Part of the signal would be read from bytes the frame does not have. The most frequent cause is a big-endian signal whose start bit was written as its least significant bit.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 2 Gateway
 SG_ Speed : 0|16@0+ (0.1,0) [0|250] "km/h" Dash
 SG_ Rpm : 8|16@1+ (1,0) [0|8000] "rpm" Dash
```

`Speed` is big-endian and starts at bit 0, the most significant bit, so it needs three bytes. `Rpm` ends in byte 2.

**Fix.** For a big-endian signal that fills bytes 0 and 1 write start bit 7 (`7|16@0+`). Otherwise enlarge the message or move the signal.

### DBC-SIGNAL-OVERLAP
Error. Two signals that can be present in the same frame use the same bit.

**When.** The bits of two signals of one message intersect. Bits are compared one by one, so a big-endian and a little-endian signal can overlap although their start bits are far apart. Signals with a 64-bit length are handled like any other. Two signals do not count as overlapping if they can never be present together:

* In simple multiplexing, signals multiplexed on different values of the same multiplexor.
* In extended multiplexing (`SG_MUL_VAL_`), signals for which some multiplexor above both of them has value ranges that do not intersect. Ranges that share a single value (0-3 and 3-7) do intersect.
* Signals selected by different multiplexors that have nothing in common can be present together and are compared.

A signal that is present in every frame is compared with all multiplexed signals, and a multiplexed signal that uses bits of its own multiplexor overlaps it. Signals that already have a problem that stops their layout (`DBC-SIGNAL-LENGTH`, `DBC-SIGNAL-OUTSIDE-FRAME`, `DBC-VALTYPE-INVALID`) or whose multiplexor cannot be determined are left out of this check.

One problem is reported per signal, at the specification of the later signal. The text names the first earlier signal that shares bits, the lowest and highest shared bit, and up to three more names.

**Why it matters.** Both signals write into the same bits, so the value of one corrupts the other.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
 SG_ Rpm : 8|16@1+ (1,0) [0|8000] "rpm" Dash
```

`Rpm` starts at bit 8, which is the second byte of `Speed`. These two signals are not an overlap, because they are present for different multiplexor values:

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|8@1+ (1,0) [0|1] "" Dash
 SG_ PageA m0 : 8|16@1+ (1,0) [0|0] "" Dash
 SG_ PageB m1 : 8|16@1+ (1,0) [0|0] "" Dash
```

**Fix.** Move one signal, shorten it, or, if they are meant to alternate, multiplex them on different values. For a very large message see `DBC-CHECK-LIMIT`.

### DBC-VALTYPE-INVALID
Error. A floating-point value type does not match the signal length, or the value type is not known.

**When.** There are two cases. A `SIG_VALTYPE_` statement declares a signal as 32-bit float (1) and its length is not 32, or as 64-bit float (2) and its length is not 64. Or the number in a `SIG_VALTYPE_` statement is not 0 (integer), 1 or 2. A signal with the wrong float length is left out of the overlap check and is not decoded.

**Why it matters.** An IEEE 754 number has exactly 32 or 64 bits. The signal cannot be decoded as a float of another length.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (1,0) [0|0] "km/h" Dash
 SG_ Rpm : 16|16@1+ (1,0) [0|0] "rpm" Dash
SIG_VALTYPE_ 256 Speed : 1;
SIG_VALTYPE_ 256 Rpm : 3;
```

**Fix.** Make the length 32 or 64 to match the type, or remove the statement for an integer signal. Use only 0, 1 or 2.

### DBC-VALTYPE-UNKNOWN
Warning. A `SIG_VALTYPE_` statement names a signal that does not exist.

**When.** No signal of that name is found under that message ID, or no message has the ID. It is reported at the signal name.

**Why it matters.** The statement is not used. A signal meant to be a float is decoded as an integer.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|32@1+ (1,0) [0|0] "km/h" Dash
SIG_VALTYPE_ 256 Spede : 1;
```

**Fix.** Correct the message ID or the signal name.

## Values and ranges

### DBC-NUMBER
Error. A factor, offset, minimum or maximum cannot be read as an exact number.

**When.** The number is written correctly but the decimal reader refuses it: its exponent is above 400 or below -400 in absolute value, or the text is longer than 420 characters. The message names the field and says that its exponent is too large or the text is too long. Numbers that merely are not numbers are reported as `DBC-SYNTAX`. For an unreadable factor or offset the signal is not decoded and its range is not checked. For an unreadable minimum or maximum only the range checks are skipped.

**Why it matters.** CAN Atlas computes with exact decimals, so a number it cannot hold would otherwise be rounded or lost silently.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (1e999,0) [0|250] "km/h" Dash
```

**Fix.** Write the value in plain decimal form. A value of this size is almost always an error in the file.

### DBC-FACTOR-ZERO
Error. The factor of a signal is 0.

**When.** The factor in `(factor,offset)` is zero, in any spelling (`0`, `0.0`, `0e5`).

**Why it matters.** Physical value = raw value times factor plus offset. With factor 0 every raw value gives the same physical value, so nothing can be decoded or encoded.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0,0) [0|250] "km/h" Dash
```

**Fix.** Use the step size of the signal (for example 1 or 0.1).

### DBC-RANGE-INVERTED
Error. The minimum of a signal is greater than its maximum.

**When.** In `[minimum|maximum]` the first number is larger than the second. Numbers are compared exactly.

**Why it matters.** The range is empty. It is often a sign that the two numbers were swapped.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [250|0] "km/h" Dash
```

**Fix.** Swap the numbers.

### DBC-RANGE-OUTSIDE-RAW
Warning. The range of a signal goes beyond what its raw bits can express.

**When.** The signal has 1 to 64 bits, is an integer (not a float), and has a readable factor that is not zero and a readable offset. The smallest and largest raw value of its length and sign (unsigned or two's complement), times the factor plus the offset, give the physical range the signal can express. A minimum below it or a maximum above it is reported, together with the real range. `[0|0]` means "no range given" and is not checked. An inverted range is reported by `DBC-RANGE-INVERTED` only. Numbers are exact, also for 64-bit signals.

**Why it matters.** The range promises values the signal can never carry, so the length, the factor or the range is wrong.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Level : 0|8@1+ (1,0) [0|300] "%" Dash
```

The message reads `... goes beyond what its 8 unsigned raw bits can express with factor 1 and offset 0: 0 to 255.`

**Fix.** Correct the range, enlarge the signal or change the factor.

## Value tables and value descriptions

Two statements give names to raw values. `VAL_TABLE_` defines a named table. `VAL_` attaches descriptions to one signal.

### DBC-VALUE-NOT-WHOLE
Warning. A value description is given for a number that is not whole.

**When.** In a `VAL_` or `VAL_TABLE_` statement the number in front of a description has a fraction, for example `1.5`. A number written as `2.0` or `1e2` is a whole number and is accepted. The entry is ignored.

**Why it matters.** Descriptions belong to raw values, which are whole numbers.

```dbc
VAL_TABLE_ GearNames 0 "Park" 1.5 "Half" 2 "Drive";
```

The table is also reported as unused (`DBC-VALUE-TABLE-UNUSED`).

**Fix.** Use whole numbers.

### DBC-VAL-UNKNOWN-MESSAGE
Warning. A `VAL_` statement names a message ID that no message has.

**When.** The ID after `VAL_` is not the ID of any `BO_` line (compared as written, including bit 31). `VAL_` statements for an environment variable are not checked.

**Why it matters.** The descriptions are not used.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Gear : 0|3@1+ (1,0) [0|7] "" Dash
VAL_ 999 Gear 0 "Park";
```

**Fix.** Correct the ID. For an extended message do not forget bit 31.

### DBC-VAL-UNKNOWN-SIGNAL
Warning. A `VAL_` statement names a signal the message does not have.

**When.** The message ID exists but has no signal of that name.

**Why it matters.** The descriptions are not used.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Gear : 0|3@1+ (1,0) [0|7] "" Dash
VAL_ 256 Gears 0 "Park";
```

**Fix.** Correct the signal name.

### DBC-VAL-DUPLICATE
Warning. A raw value is described twice, or a signal has two lists of value descriptions.

**When.** There are three cases, all with the same code:

* The same raw value appears twice inside one `VAL_` list. The first description is used.
* The same raw value appears twice inside one `VAL_TABLE_`. The first is used.
* A signal already has a `VAL_` statement and a second one follows. The second list is not used.

**Why it matters.** Only one description can be shown for a value, and the one that is dropped may be the one you wanted.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Gear : 0|3@1+ (1,0) [0|7] "" Dash
VAL_ 256 Gear 0 "Park" 1 "Drive" 0 "Neutral";
VAL_ 256 Gear 0 "P" 1 "D";
```

The first statement describes 0 twice. The second statement is a second list for `Gear`.

**Fix.** Keep one description per value and one `VAL_` statement per signal.

### DBC-VALUE-OUTSIDE-RAW
Warning. A described raw value cannot occur in the signal.

**When.** A `VAL_` description names a raw value outside what the signal's length and sign can hold. The range is shown in the message, for example 0 to 7 for 3 unsigned bits. For a signed signal, a value that fits as a bit pattern of that length gets a hint with the signed value (a 4-bit signed signal holds -8 to 7, so 15 is the pattern for -1). Float signals are not checked. Values of `VAL_TABLE_` tables are not checked, because they belong to no signal.

**Why it matters.** The description will never be shown. A wrong length or a wrong value is likely.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Gear : 0|3@1+ (1,0) [0|7] "" Dash
 SG_ Temp : 8|4@1- (1,0) [-8|7] "" Dash
VAL_ 256 Gear 0 "Park" 9 "Fault";
VAL_ 256 Temp 15 "Invalid";
```

**Fix.** Correct the value, or the length of the signal.

### DBC-VALUE-TABLE-MISSING
Warning. A signal type names a value table that is not defined.

**When.** A signal type statement (`SGTYPE_`) ends with the name of a value table (after the last comma), and no `VAL_TABLE_` of that name exists. Apart from this name, signal types are not checked.

**Why it matters.** The type refers to descriptions that are not in the file.

```dbc
BU_: Gateway Dash
SGTYPE_ GearType : 3@1+ (1,0) [0|7] "" 0, GearNames;
```

**Fix.** Define the table with `VAL_TABLE_`, or correct the name.

### DBC-VALUE-TABLE-UNUSED
Note. No signal uses a named value table.

**When.** A `VAL_TABLE_` is not named by any signal type and no signal has value descriptions with the same entries (same raw values with the same texts, in any order). Only the first definition of a name is looked at.

**Why it matters.** The table may be left over from a signal that was removed, or the `VAL_` statements that should repeat its entries are missing.

```dbc
BU_: Gateway Dash
VAL_TABLE_ GearNames 0 "Park" 1 "Drive";
BO_ 256 Engine: 8 Gateway
 SG_ Gear : 0|3@1+ (1,0) [0|7] "" Dash
```

**Fix.** Add `VAL_ 256 Gear 0 "Park" 1 "Drive";` so that the signal carries the entries, or delete the table.

### DBC-VALUE-TABLE-DUPLICATE
Warning. A named value table is defined twice.

**When.** Two `VAL_TABLE_` statements have the same name. The first is used.

**Why it matters.** The second definition is ignored, even if it was the newer one.

```dbc
VAL_TABLE_ GearNames 0 "Park" 1 "Drive";
VAL_TABLE_ GearNames 0 "P" 1 "D";
```

The first table is also reported as unused (`DBC-VALUE-TABLE-UNUSED`).

**Fix.** Delete one of the two, or give them different names.

## Multiplexing

A multiplexed message uses some of its bytes for different signals depending on the value of a multiplexor signal.

* In **simple multiplexing** one signal is the multiplexor (`M` after its name) and a signal written `m<value>` is present only when the multiplexor holds that value.
* In **extended multiplexing** a `SG_MUL_VAL_` statement names the multiplexor of a signal and the ranges of multiplexor values for which it is present. A multiplexor can itself be multiplexed (`m<value>M`), so multiplexors can be nested. Nesting is limited to 32 levels.

A signal whose multiplexor cannot be determined is not decoded and not drawn into any group of the bit layout. The problem names the cause. **CAN Atlas: Show Bit Layout** lists such signals under "Not decoded" with the reason.

### DBC-MUX-NO-MULTIPLEXOR
Error. A multiplexed signal is in a message that has no multiplexor.

**When.** A signal is written `m<value>` (or `m<value>M`), no `SG_MUL_VAL_` statement names its multiplexor, and the message has no multiplexor signal other than the signal itself. The signal is not decoded.

**Why it matters.** Without a multiplexor nothing says when the signal is present.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Count : 0|8@1+ (1,0) [0|255] "" Dash
 SG_ PageData m0 : 8|16@1+ (1,0) [0|0] "" Dash
```

**Fix.** Mark the signal that holds the page number with `M` (here that would be `Count`).

### DBC-MUX-AMBIGUOUS
Error. Several multiplexors could select a signal, and no `SG_MUL_VAL_` statement says which one does.

**When.** A signal is written `m<value>` without a `SG_MUL_VAL_` statement and the message has two or more multiplexors other than the signal itself. The message lists up to five of them. The signal is not decoded.

**Why it matters.** The reader will not guess. Decoding by guess would give wrong values without any hint.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Mode M : 0|2@1+ (1,0) [0|3] "" Dash
 SG_ Page m0M : 2|6@1+ (1,0) [0|63] "" Dash
 SG_ PageData m1 : 8|16@1+ (1,0) [0|0] "" Dash
```

`Page` has one possible multiplexor (`Mode`), but `PageData` has two. `Page` also reports `DBC-MUX-UNUSED`, because nothing is selected by it yet.

**Fix.** Add a statement that names the multiplexor, for example `SG_MUL_VAL_ 256 PageData Page 1-1;`.

### DBC-MUX-VALUE-RANGE
Warning. The multiplexor can never hold the value that selects a signal.

**When.** Every value or range that selects the signal lies outside what the multiplexor's length and sign can hold. A 2-bit unsigned multiplexor holds 0 to 3; a signed one 2-bit holds -2 to 1. If only some of several ranges are outside, nothing is reported.

**Why it matters.** The signal is never present.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|2@1+ (1,0) [0|3] "" Dash
 SG_ PageData m7 : 8|16@1+ (1,0) [0|0] "" Dash
```

**Fix.** Use a value the multiplexor can hold, or make the multiplexor longer.

### DBC-MUX-SWITCH-FLOAT
Error. A multiplexor is a floating-point signal.

**When.** A signal written `M` or `m<value>M` is declared as a 32-bit or 64-bit float by `SIG_VALTYPE_`. The signals it selects are not decoded.

**Why it matters.** A multiplexor selects by whole values. A float cannot do that.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|32@1+ (1,0) [0|0] "" Dash
 SG_ PageData m1 : 32|16@1+ (1,0) [0|0] "" Dash
SIG_VALTYPE_ 256 Page : 1;
```

**Fix.** Remove the float type from the multiplexor.

### DBC-MUX-UNUSED
Note. A signal is written as a multiplexor, but no signal is selected by it.

**When.** No signal of the message has this signal as its multiplexor. The note is placed at the multiplexor indicator. A signal whose multiplexor could not be determined (`DBC-MUX-AMBIGUOUS`, `DBC-MUX-EXTENDED-UNKNOWN`, `DBC-MUX-EXTENDED-RANGE`, `DBC-MUX-NOT-MULTIPLEXED`) selects nothing, so the multiplexor it was meant for can be reported as unused as well.

**Why it matters.** The `M` may be left over, or the multiplexed signals have lost the connection to it.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|8@1+ (1,0) [0|255] "" Dash
 SG_ Count : 8|8@1+ (1,0) [0|255] "" Dash
```

**Fix.** Mark the signals it selects `m<value>`, or remove the `M`.

### DBC-MUX-NOT-MULTIPLEXED
Warning. A `SG_MUL_VAL_` statement names a multiplexor for a signal that is not written as multiplexed.

**When.** The signal has no `m<value>` indicator, but a `SG_MUL_VAL_` statement is given for it. The signal is decoded in every frame.

**Why it matters.** The statement is not used, and the signal is present in every frame, not only for the values you listed.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|8@1+ (1,0) [0|255] "" Dash
 SG_ PageData : 8|16@1+ (1,0) [0|0] "" Dash
SG_MUL_VAL_ 256 PageData Page 0-1;
```

`PageData` has no `m0` or similar. The multiplexor `Page` also reports `DBC-MUX-UNUSED`.

**Fix.** Write the indicator `m<value>` at the signal.

### DBC-MUX-EXTENDED-UNKNOWN
Warning. A `SG_MUL_VAL_` statement names something that does not exist.

**When.** There are four cases, all with this code: the message ID is not the ID of any message; the multiplexed signal is not a signal of the message; the named multiplexor is not another signal of the message (a signal naming itself counts); or the named signal exists but is not written as a multiplexor (`M` or `m<value>M`). The last two apply to signals written `m<value>`; the signal is not decoded.

**Why it matters.** The statement is not used and the signal is not decoded.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|8@1+ (1,0) [0|255] "" Dash
 SG_ PageData m0 : 8|16@1+ (1,0) [0|0] "" Dash
SG_MUL_VAL_ 256 PageData Pge 0-0;
SG_MUL_VAL_ 999 PageData Page 0-0;
```

`Pge` is not a signal, and no message has ID 999. The multiplexor `Page` also reports `DBC-MUX-UNUSED`, because `PageData` is not selected by it.

**Fix.** Correct the ID and the names.

### DBC-MUX-EXTENDED-RANGE
Error. A range of multiplexor values ends below its start.

**When.** A range in a `SG_MUL_VAL_` statement such as `5-3` has a start larger than its end. The signal is not decoded.

**Why it matters.** The range selects no value.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|8@1+ (1,0) [0|255] "" Dash
 SG_ PageData m3 : 16|8@1+ (1,0) [0|0] "" Dash
SG_MUL_VAL_ 256 PageData Page 5-3;
```

The multiplexor `Page` also reports `DBC-MUX-UNUSED`, because the signal that was meant for it is not decoded.

**Fix.** Write the smaller value first (`3-5`).

### DBC-MUX-EXTENDED-MISMATCH
Warning. The value written at a signal is not in its `SG_MUL_VAL_` ranges.

**When.** A signal is written `m<value>` and a `SG_MUL_VAL_` statement gives ranges that do not contain that value. Decoding follows the `SG_MUL_VAL_` ranges.

**Why it matters.** The two places contradict each other. The statement wins, and the `m<value>` means nothing.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|8@1+ (1,0) [0|255] "" Dash
 SG_ PageData m3 : 16|8@1+ (1,0) [0|0] "" Dash
SG_MUL_VAL_ 256 PageData Page 0-1;
```

**Fix.** Make the two agree.

### DBC-MUX-EXTENDED-DUPLICATE
Warning. A signal has more than one `SG_MUL_VAL_` statement.

**When.** A second `SG_MUL_VAL_` statement names the same signal. The second is not used.

**Why it matters.** The ranges of the second statement are lost.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ Page M : 0|8@1+ (1,0) [0|255] "" Dash
 SG_ PageData m3 : 16|8@1+ (1,0) [0|0] "" Dash
SG_MUL_VAL_ 256 PageData Page 3-3;
SG_MUL_VAL_ 256 PageData Page 4-4;
```

**Fix.** Put all ranges into one statement, separated by commas (`3-3,4-4`).

### DBC-MUX-CYCLE
Error. Multiplexors select each other in a loop.

**When.** Following the multiplexors of a signal leads back to the signal. Every signal in the loop is reported and not decoded. Signals that depend on a multiplexor in the loop are not decoded either, without a problem of their own; the reason shows in **Show Bit Layout**.

**Why it matters.** A signal cannot depend on a value that depends on itself.

```dbc
BU_: Gateway Dash
BO_ 256 Pages: 8 Gateway
 SG_ A m0M : 0|8@1+ (1,0) [0|0] "" Dash
 SG_ B m0M : 8|8@1+ (1,0) [0|0] "" Dash
SG_MUL_VAL_ 256 A B 0-0;
SG_MUL_VAL_ 256 B A 0-0;
```

**Fix.** Make the chain end at a multiplexor that is not itself multiplexed.

### DBC-MUX-TOO-DEEP
Error. A signal has more than 32 multiplexors above it.

**When.** The chain of multiplexors above a signal (through nested `m<value>M` signals and `SG_MUL_VAL_` statements) is longer than 32 levels. The signal is not decoded.

**Why it matters.** CAN Atlas does not follow such a chain. A chain this long is almost always a mistake.

```text
SG_ L0 M : 0|1@1+ ...
SG_ L1 m0M : 1|1@1+ ...
SG_ L2 m0M : 2|1@1+ ...
...
SG_ L32 m0M : 32|1@1+ ...
SG_ L33 m0 : 33|1@1+ ...
SG_MUL_VAL_ 256 L1 L0 0-0;
SG_MUL_VAL_ 256 L2 L1 0-0;
...
SG_MUL_VAL_ 256 L33 L32 0-0;
```

This shortened pattern (dots stand for the repeated lines, 34 signals in total) puts 33 multiplexors above `L33`. `L33` is reported, `L32` and the signals above it are not.

**Fix.** Flatten the structure. Fewer levels of multiplexors are easier to maintain.

## Attributes and comments

### DBC-COMMENT-UNKNOWN
Warning. A comment belongs to a node, message, signal or environment variable that does not exist.

**When.** A `CM_` statement for a node (`CM_ BU_`), a message ID (`CM_ BO_`), a signal (`CM_ SG_`, message ID and name) or an environment variable (`CM_ EV_`) names something not found. The comment on the whole database is never unknown.

**Why it matters.** The comment is not shown anywhere. A comment is usually written for a name that was misspelt or a signal that was renamed.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
CM_ SG_ 256 Spede "Vehicle speed";
CM_ BU_ Gatway "Main unit";
CM_ BO_ 300 "Reserved";
```

**Fix.** Correct the name or ID.

### DBC-ATTRIBUTE-UNDEFINED
Warning. An attribute is used, or given a default, without a definition.

**When.** There are two cases: a `BA_DEF_DEF_` statement gives a default for an attribute that no `BA_DEF_` defines, or a `BA_` statement sets an attribute that no `BA_DEF_` defines. Its value is not checked.

**Why it matters.** Without a definition nothing says what type the value has or which objects it belongs to, so its value cannot be checked or used.

```dbc
BU_: Gateway Dash
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BA_DEF_DEF_ "CycleTime" 100;
BA_ "CycleTime" BO_ 256 20;
```

**Fix.** Add the `BA_DEF_` statement, or correct the attribute name.

### DBC-ATTRIBUTE-UNKNOWN-OBJECT
Warning. An attribute is set for a node, message, signal or environment variable that does not exist.

**When.** A `BA_` statement names a node, a message ID, a signal (message ID and name) or an environment variable that is not found. The attribute must have a definition; otherwise `DBC-ATTRIBUTE-UNDEFINED` is reported.

**Why it matters.** The value belongs to nothing and is not used.

```dbc
BU_: Gateway Dash
BA_DEF_ BO_ "CycleTime" INT 0 1000;
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BA_ "CycleTime" BO_ 300 20;
```

**Fix.** Correct the ID or name.

### DBC-ATTRIBUTE-VALUE
Warning. The value of an attribute does not fit its definition.

**When.** A `BA_` value or a `BA_DEF_DEF_` default (the message says "default") breaks the definition. A STRING attribute needs a text in double quotes. An ENUM attribute needs one of the listed names in double quotes, or a whole number from 0 to the number of names minus 1. INT and HEX need a whole number; INT, HEX and FLOAT need a number in the defined range (a definition with minimum and maximum both 0 has no range). The value of an attribute is only checked if the attribute is defined, the object exists and the definition is for that kind of object.

**Why it matters.** A value outside its definition may be refused or changed by the tools that read the file.

```dbc
BU_: Gateway Dash
BA_DEF_ BO_ "CycleTime" INT 10 1000;
BA_DEF_ BO_ "Kind" ENUM "Cyclic","Event";
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BA_ "CycleTime" BO_ 256 5;
BA_ "Kind" BO_ 256 "Burst";
```

**Fix.** Correct the value, or the definition.

### DBC-ATTRIBUTE-OBJECT-TYPE
Warning. An attribute is set for another kind of object than it is defined for.

**When.** The definition says nodes (`BA_DEF_ BU_`), messages (`BO_`), signals (`SG_`) or environment variables (`EV_`), or the whole database (no object type), and the `BA_` statement names another kind. The value is not checked.

**Why it matters.** A tool that reads the attribute for the defined kind of object never finds the value.

```dbc
BU_: Gateway Dash
BA_DEF_ BO_ "CycleTime" INT 0 1000;
BO_ 256 Engine: 8 Gateway
 SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" Dash
BA_ "CycleTime" SG_ 256 Speed 20;
```

**Fix.** Set the attribute for the right kind of object, or change the definition.

### DBC-ATTRIBUTE-DUPLICATE-DEF
Warning. An attribute is defined twice.

**When.** Two `BA_DEF_` statements have the same attribute name, whatever their object types. The first definition is used.

**Why it matters.** The second definition, with its range or type, is ignored.

```dbc
BU_: Gateway Dash
BA_DEF_ BO_ "CycleTime" INT 0 1000;
BA_DEF_ BO_ "CycleTime" INT 0 5000;
```

**Fix.** Delete one definition.

## Limits

### DBC-CHECK-LIMIT
Note. The overlap check of a message stopped early because checking all pairs of signals would take too long.

**When.** The overlap check counts comparisons: each time a bit of a signal meets an earlier signal that uses the same bit, it counts one, also for signals that are multiplexed on different values and so do not overlap. One message may use 2,000,000 comparisons and all messages of the file together 20,000,000. When the budget is used up, the check of that message stops, the signals after that point are not compared, and overlaps among the signals compared so far are still reported. Measured with test files: a multiplexed message with 708 signals of 8 bits on the same bits stops the check, and one with 707 does not; 2,001 one-bit signals on the same bit stop it, 2,000 do not. Eleven messages of the 707-signal kind use up the budget of the file in the eleventh. Every pair of signals that overlap is also a problem of its own, so with many overlaps the list may be cut at `canAtlas.maxProblems` before this note (see `DBC-LIST-CUT`).

**Why it matters.** Overlaps among the signals that were not compared are not reported. The note makes that visible.

```text
BO_ 256 Pile: 8 Gateway
 SG_ Sel M : 0|16@1+ (1,0) [0|0] "" Dash
 SG_ V0 m0 : 16|8@1+ (1,0) [0|0] "" Dash
 SG_ V1 m1 : 16|8@1+ (1,0) [0|0] "" Dash
 ...
 SG_ V707 m707 : 16|8@1+ (1,0) [0|0] "" Dash
```

This pattern (dots stand for the repeated lines) has 708 signals on the same 8 bits, each for a different multiplexor value.

**Fix.** Split the message, or check the bits of the unchecked signals by hand. Hide the code if you know the signals are correct.

### DBC-FILE-LIMIT
Warning. The file holds more than can be kept in memory, so reading stopped.

**When.** The reader counts what it keeps: a `BO_` line counts 6 units, an `SG_` line 4 (plus 1 for each group of up to four receivers), most other statements 2, and each node name, value entry, reference or problem 1 more. At 6,500,000 units reading stops, and everything after that point is neither checked nor shown. The message gives about how many messages and signals were read. For scale: a file made of repeated short lines was read up to about 1,083,000 messages without signals, or up to about 141,000 messages with 8 signals each (1,130,000 signals). Real files have longer statements and other content, so the point differs.

**Why it matters.** Checks and the outline cover only the part before the point; the rest of the file is silently outside every check.

```text
BO_ 1 A: 8 Node
BO_ 1 A: 8 Node
...
```

This pattern (more than a million lines of the same kind) is only for scale.

**Fix.** Split the database into several files. The size limit `canAtlas.maxFileSizeMB` (20 MB by default, at most 48) is a separate setting; files above it are not checked automatically.

### DBC-LIST-CUT
Note. Only the first `canAtlas.maxProblems` problems are listed.

**When.** The file has more problems than the setting allows (1000 by default; 1 to 20000). The note is added at the end and says how many more were found. The totals count all problems, also those that are not listed. Unlike other codes, `DBC-LIST-CUT` cannot be hidden with `canAtlas.problems.disabledCodes`. Problems of hidden codes are not counted in the first place.

**Why it matters.** A long list usually has few causes. The problems you do not see may include errors.

```dbc
BU_: Gateway Gateway
BO_ 256 Engine: 8 Gateway
```

With `canAtlas.maxProblems` set to 1, the duplicate node is listed, the note for the message without signals is counted but not listed, and `DBC-LIST-CUT` is added.

**Fix.** Fix the first problems, since many of the others usually follow from them, or raise `canAtlas.maxProblems`.

## What the checks do not cover

* Environment variables, signal groups, categories, relation attributes and similar statements are read past without checks.
* The pseudo message that DBC files use to hold signals without a frame is skipped by all checks of messages and signals.
* Cycle times, timeouts, checksums, counters and the behaviour of any node on the network.
* Whether a name, unit or range is physically right.
* Whether another tool reads the file the same way.

Two versions of a DBC file can be compared with **CAN Atlas: Compare DBC With Another File (Pro)**; the codes of that comparison are in [diff-rules.md](diff-rules.md).
