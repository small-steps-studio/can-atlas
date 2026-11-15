# Comparing two DBC files (Pro)

**CAN Atlas: Compare DBC With Another File (Pro)** compares the DBC file in the editor with a second file and lists every difference in the **DBC Comparison** view. **Export Comparison Report (Pro)** writes the list as Markdown, HTML or CSV, and **Clear Comparison** empties the view. The first Pro command starts the free 14-day trial; see [licence](licence.md).

Every difference has a stable code that starts with `DIFF-` and one of three classes. This page describes each code and the reasoning behind its class.

## The three classes

| Class | Meaning |
| --- | --- |
| BREAKING | An existing receiver decodes bytes differently, or no longer finds a message, a signal or a name it used. Review every one of them before a release. |
| NON-BREAKING | Something was added or relaxed that existing receivers do not depend on. |
| COSMETIC | Documentation, order or spelling only. The decoded values of every frame stay the same. |

The classes describe the DBC file, not the software around it. A receiver that checks the exact data length of a frame, or a test setup that relies on an attribute this page calls non-breaking, can still notice a change. The comparison therefore errs towards BREAKING wherever a change could go either way, and says so in the sections below.

## What is compared

* **Messages** are matched by identifier: the extended-frame flag (bit 31 of the number in `BO_`) and the frame number. A standard message `0x123` and an extended message `0x80000123` are two different messages.
* A message that is gone and a message that is new at the same time, with the same name and the same signal names, count as one message that received another identifier (`DIFF-MESSAGE-ID-CHANGED`, or `DIFF-MESSAGE-FRAME-FORMAT-CHANGED` when only the standard or extended form changed). If the name is the same but the signals differ, the old message is reported as removed and the new one as added.
* Two messages with the same identifier in one file are paired in the order they appear.
* **Signals** are matched by name inside matched messages. A signal that is gone and a signal that is new in the same message, with the same start bit, length, byte order, sign, value type, factor and offset, count as one renamed signal when the pairing is unique (exactly one such signal on each side). The renamed signal is then compared field by field with its old self, so a rename together with a unit change gives two codes.
* **Nodes**, **named value tables** (`VAL_TABLE_`), **attribute definitions**, **attribute defaults** and **attribute values** are matched by name. A value table that only has another name but all the same entries is a rename when it is unique on both sides.
* The pseudo message `VECTOR__INDEPENDENT_SIG_MSG` (signals without a message) is compared like any other message.
* Numbers are compared as exact decimals. A factor of `0.10` is the same as `0.1`, `1e-1` and `0.100`; an offset of `-40` is the same as `-40.00`. A number that cannot be read is compared as text.
* Spaces, tabs, blank lines, line ends, a byte order mark, the way a number is written (`0.25`, `0.250`, `1E0`) and the order of receivers and of value descriptions are not part of the data and never cause a change code. They do prevent the summary "No differences": when the two files hold the same data but are not the same byte for byte, the summary reads "No differences in the database content. The files differ only in how the same content is written: spacing, blank lines, line ends, the byte order mark, the way numbers are written or the order of list entries." and the view says "No content differences".
* Environment variables, signal groups, signal types, relation attributes, the `NS_` and `BS_` blocks and every other statement that CAN Atlas reads over without interpreting it are not classified. They are still compared as text (white space collapsed), as are statements that have no effect on the database: a comment, value description, attribute, multiplexing range or transmitter list that refers to something that does not exist, a statement that repeats an earlier definition or is replaced by a later one, an attribute written out with its default value, entries of a value list that are ignored (a raw value that is not whole, or one that is given twice), statements with a syntax error and text outside any statement. When such statements differ, the result lists no change code for them; it adds a note ("The files also differ in N statements that CAN Atlas does not compare or that have no effect on the database (...)") and the summary then reads "No differences in the compared statements." instead of "No differences." **No differences** is said only when none of these differs either and the two files are the same byte for byte (a file that is open with unsaved changes is compared as it is in the editor).

The list is ordered: changes of the database as a whole first (version, nodes, value tables, attributes), then the messages by identifier (standard frames before extended frames); inside a message the message itself, then its signals in the order of the new file, removed signals last. The same two files always give the same list in the same order.

## Database

### DIFF-VERSION-CHANGED

Cosmetic. The version text of the file changed.

The text after `VERSION` is a label for people. No receiver reads it when it decodes frames.

### DIFF-FILE-COMMENT-CHANGED

Cosmetic. The comment on the whole database was added, removed or changed.

This is the `CM_ "..."` statement without an object. It is documentation.

## Nodes

### DIFF-NODE-ADDED

Non-breaking. A node (control unit) was added to the node list.

An added node changes no message and no signal. If the node is also used as a sender or receiver, the sender and receiver codes say so.

### DIFF-NODE-REMOVED

Breaking. A node was removed from the node list.

Conservative choice. A removed node does not change how a frame is decoded, but simulations and test setups choose the nodes to simulate by name, and a node that vanishes from the list usually means a control unit left the network. If messages still name the node, the sender and receiver codes are listed as well.

### DIFF-NODE-COMMENT-CHANGED

Cosmetic. The comment on a node was added, removed or changed.

### DIFF-NODE-ORDER-CHANGED

Cosmetic. The nodes that exist in both files are listed in another order.

Reported once. Only the nodes found in both files are looked at; added and removed nodes have their own codes.

## Named value tables

A named value table is a `VAL_TABLE_` statement. The value descriptions that belong to one signal (`VAL_`) are described under [value descriptions](#value-descriptions).

### DIFF-VALUE-TABLE-ADDED

Non-breaking. A named value table (VAL_TABLE_) was added.

### DIFF-VALUE-TABLE-REMOVED

Breaking. A named value table was removed.

Conservative choice. Signals carry their own `VAL_` lists, so removing a table changes no decoded value, but other tools may look the table up by name.

### DIFF-VALUE-TABLE-RENAMED

Cosmetic. A named value table kept all its entries and received another name.

Only reported when exactly one removed table and one added table have identical entries. In all other cases the tables are reported as removed and added.

### DIFF-VALUE-TABLE-ENTRY-ADDED

Non-breaking. An entry was added to a named value table.

### DIFF-VALUE-TABLE-ENTRY-REMOVED

Breaking. An entry was removed from a named value table.

### DIFF-VALUE-TABLE-ENTRY-CHANGED

Breaking. The description of a raw value in a named value table changed.

When the descriptions differ only in spaces the change is reported as `DIFF-VALUE-DESCRIPTION-WHITESPACE` (cosmetic) instead.

### DIFF-VALUE-TABLE-ORDER-CHANGED

Cosmetic. The named value tables that exist in both files are listed in another order.

## Attributes

An attribute has a definition (`BA_DEF_`), an optional default (`BA_DEF_DEF_`) and values on the database, nodes, messages and signals (`BA_`). Values are compared as the effective value: the explicit value of the object, or the default of the definition when the object has none. A number written as a name of an enumerated attribute (`1` and `"OnChange"`) is the same value.

Attributes fall into three groups:

1. **Cycle time** (`GenMsgCycleTime` and `CycleTime`): any change is BREAKING (`DIFF-CYCLE-TIME-CHANGED`).
2. **Send behaviour**: `GenMsgCycleTimeFast`, `GenMsgDelayTime`, `GenMsgStartDelayTime`, `GenMsgNrOfRepetition`, `GenMsgSendType`, `GenSigStartValue`, `GenSigInactiveValue`, `GenSigSendType` and `VFrameFormat`. Any change of the effective value is BREAKING (`DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED`). A changed default of one of these attributes is reported for every object that uses the default.
3. **All other attributes**: added, removed or changed values are NON-BREAKING. A changed default of such an attribute is reported once as `DIFF-ATTRIBUTE-DEFAULT-CHANGED` (cosmetic), not for every object.

Conservative choice for group 3: an attribute that is not on the list above is assumed not to change how bytes are decoded. If your process gives an attribute a meaning, such as a network management flag, read the `DIFF-ATTRIBUTE-*` lines of the report as carefully as the breaking ones.

### DIFF-ATTRIBUTE-DEFINITION-CHANGED

Cosmetic. The definition of an attribute (BA_DEF_) was added, removed or changed.

A change of the type, the object type, the range or the list of names of an enumerated attribute is listed here. The values that matter are compared on their own.

### DIFF-ATTRIBUTE-DEFAULT-CHANGED

Cosmetic. The default value of an attribute (BA_DEF_DEF_) was added, removed or changed.

For the cycle time and the send-behaviour attributes the change also shows up on every message or signal that uses the default.

### DIFF-ATTRIBUTE-ADDED

Non-breaking. An attribute that is not about timing or send behaviour got a value on an object that had none.

### DIFF-ATTRIBUTE-REMOVED

Non-breaking. An attribute that is not about timing or send behaviour lost its value on an object.

### DIFF-ATTRIBUTE-CHANGED

Non-breaking. The value of an attribute that is not about timing or send behaviour changed.

### DIFF-BEHAVIOUR-ATTRIBUTE-CHANGED

Breaking. A send-behaviour attribute (send type, delays, repetitions, start or inactive value, frame format) was added, removed or changed.

CAN Atlas does not interpret these attributes; it only reports that the effective value differs.

### DIFF-CYCLE-TIME-CHANGED

Breaking. The cycle time of a message (GenMsgCycleTime or CycleTime) was added, removed or changed.

Any change counts, however small: timeout monitoring and rest-bus simulations are built on the period. A cycle time of 0 means none.

## Messages

### DIFF-MESSAGE-ADDED

Non-breaking. A message was added.

An added message cannot affect receivers of existing messages. A receiver that rejects unknown identifiers is outside what a DBC file can show.

### DIFF-MESSAGE-REMOVED

Breaking. A message of the old file is not in the new file.

### DIFF-MESSAGE-ID-CHANGED

Breaking. A message kept its name and its signals but received another identifier.

### DIFF-MESSAGE-FRAME-FORMAT-CHANGED

Breaking. A message kept its name, its frame number and its signals but changed between a standard 11-bit and an extended 29-bit identifier.

In the file the extended form is the number plus 2147483648 (bit 31). The frame on the bus is a different one.

### DIFF-MESSAGE-RENAMED

Breaking. A message kept its identifier but received another name.

Conservative choice. The bytes decode the same, but code and test scripts look messages up by name.

### DIFF-MESSAGE-DLC-INCREASED

Non-breaking. The data length of a message grew.

The existing signals keep their bit positions. Limit: a receiver that rejects frames of an unexpected length is not modelled.

### DIFF-MESSAGE-DLC-DECREASED

Breaking. The data length of a message shrank.

### DIFF-MESSAGE-SENDER-CHANGED

Breaking. The sending node of a message changed.

A message with no sender (`Vector__XXX`) is shown as `(none)`.

### DIFF-MESSAGE-TRANSMITTER-ADDED

Non-breaking. A further transmitter (BO_TX_BU_) was added to a message.

### DIFF-MESSAGE-TRANSMITTER-REMOVED

Breaking. A further transmitter (BO_TX_BU_) was removed from a message.

### DIFF-MESSAGE-COMMENT-CHANGED

Cosmetic. The comment on a message was added, removed or changed.

### DIFF-MESSAGE-ORDER-CHANGED

Cosmetic. The messages that exist in both files are listed in another order.

Reported once for the whole file.

### DIFF-SIGNAL-ORDER-CHANGED

Cosmetic. The signals that exist in both versions of a message are listed in another order.

Reported once per message. The position of a signal in the file has no meaning for the bits it uses.

## Signals

### DIFF-SIGNAL-ADDED

Non-breaking. A signal was added to a message on bits that no existing signal uses.

Multiplexing is taken into account: a signal added at another multiplexor value on bits that are used by signals of other multiplexor values does not overlap them.

### DIFF-SIGNAL-ADDED-OVERLAP

Breaking. A signal was added on bits that an existing signal of the same message also uses.

The bits are worked out from the start bit, the length and the byte order of both signals, so a big-endian signal that starts in one byte and runs into the next is checked on the bits it really uses. "Existing" means a signal that is in both files. The check stops after 2,000,000 comparisons in one run of the comparison; the report then says so, and signals added after that point are listed as `DIFF-SIGNAL-ADDED` without the check.

### DIFF-SIGNAL-REMOVED

Breaking. A signal of the old file is not in the new file.

### DIFF-SIGNAL-RENAMED

Breaking. A signal kept its bits and its scaling but received another name.

Receivers and scripts look signals up by name. See [what is compared](#what-is-compared) for how a rename is recognised.

### DIFF-SIGNAL-START-BIT-CHANGED

Breaking. The start bit of a signal changed and the signal now uses other bits.

### DIFF-SIGNAL-LENGTH-CHANGED

Breaking. The length of a signal in bits changed.

### DIFF-SIGNAL-BYTE-ORDER-CHANGED

Breaking. A signal changed between little-endian (Intel) and big-endian (Motorola) and now uses other bits or a different bit significance.

The same start bit and length mean different bits in the two byte orders. A little-endian signal starts at its least significant bit, a big-endian signal at its most significant bit and continues with the lower bits of the byte and then bit 7 of the next byte.

### DIFF-SIGNAL-LAYOUT-REWRITTEN

Cosmetic. The start bit or byte order of a signal is written differently, but the signal occupies the same bits with the same bit significance.

This happens for signals inside one byte: for example `16|8@1+` and `23|8@0+` both use bits 23 down to 16 of byte 2, and a 1-bit signal reads the same in both byte orders. If two writings give the same list of bits from the most to the least significant one, they decode alike.

### DIFF-SIGNAL-SIGN-CHANGED

Breaking. A signal changed between unsigned and signed.

### DIFF-SIGNAL-VALUE-TYPE-CHANGED

Breaking. A signal changed between an integer and a 32-bit or 64-bit float.

The value type comes from the `SIG_VALTYPE_` statement.

### DIFF-SIGNAL-FACTOR-CHANGED

Breaking. The factor of a signal changed (compared as exact decimals).

### DIFF-SIGNAL-OFFSET-CHANGED

Breaking. The offset of a signal changed (compared as exact decimals).

### DIFF-SIGNAL-UNIT-CHANGED

Breaking. The unit of a signal changed.

Conservative choice. A new unit text may only be a correction of the spelling, but the same number can also mean another quantity or scale, and a text comparison cannot tell the two apart. A unit that appears where there was none is also listed here.

### DIFF-SIGNAL-RANGE-NARROWED

Breaking. The minimum and maximum of a signal no longer contain the old range.

A range of `[0|0]` means that no range is given. Going from no range to a range is narrowing. A range that moves (`[0|8000]` to `[100|9000]`) is narrowed, because values of the old range are outside the new one. If a number of the range cannot be read exactly, a different text is also reported here.

### DIFF-SIGNAL-RANGE-WIDENED

Non-breaking. The minimum and maximum of a signal now contain the old range and more.

Going from a range to no range (`[0|0]`) is widening.

### DIFF-SIGNAL-RECEIVER-ADDED

Non-breaking. A node was added to the receivers of a signal.

`Vector__XXX` stands for no receiver and is not counted. The order of the receivers does not matter.

### DIFF-SIGNAL-RECEIVER-REMOVED

Breaking. A node was removed from the receivers of a signal.

Conservative choice. The decoding does not change, but the documented consumers of the signal do.

### DIFF-SIGNAL-COMMENT-CHANGED

Cosmetic. The comment on a signal was added, removed or changed.

## Value descriptions

Value descriptions are the `VAL_` statements that give a raw value of a signal a name. They are compared by raw value.

### DIFF-VALUE-DESCRIPTION-ADDED

Non-breaking. A value description (VAL_) was added for a raw value of a signal.

### DIFF-VALUE-DESCRIPTION-REMOVED

Breaking. A value description was removed from a signal.

### DIFF-VALUE-DESCRIPTION-CHANGED

Breaking. The description of a raw value of a signal changed.

### DIFF-VALUE-DESCRIPTION-WHITESPACE

Cosmetic. A value description differs only in spaces.

Leading and trailing spaces and runs of spaces are ignored for this comparison. The code is used for the descriptions of signals and for the entries of named value tables.

## Multiplexing

### DIFF-MUX-ROLE-CHANGED

Breaking. The multiplexing role of a signal changed (multiplexor, multiplexed value, both or neither).

The role is written `M`, `m<value>` or `m<value>M` after the signal name. A signal that moves from `m0` to `m2` is present in other frames than before.

### DIFF-MUX-RANGES-CHANGED

Breaking. The extended multiplexing (SG_MUL_VAL_) of a signal changed: another multiplexor or other value ranges.

Ranges are compared as sets of values: `0-1` and `0-0, 1-1` are the same.

## Limits

* The comparison reads two files that CAN Atlas could parse. A statement that could not be read is left out of both sides; use **Check Current File** on each file first.
* A message is recognised as changed in identifier only when its name and its set of signal names stay the same. Anything else is a removed and an added message.
* A signal is recognised as renamed only when its bits and scaling stay the same and the match is unique.
* Whether a changed attribute matters to your process cannot be known from the file; see the three groups under [attributes](#attributes).
* Data length checks of receivers, timing behaviour beyond the cycle time and anything outside the DBC file are not part of the comparison.

## Reports

**Export Comparison Report (Pro)** writes the same list in three forms:

* **Markdown**: one table per class (breaking first). Names and comments from the files are escaped, and addresses are kept from turning into links.
* **HTML**: one page with a table per class, a class column in words as well as colour, no script and no external resources, with a content security policy that forbids both.
* **CSV**: one row per change with the columns class, code, kind, message, identifier, signal, field, old value, new value and change. Cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get an apostrophe in front so that a spreadsheet shows them as text; plain numbers such as `-12.5` stay numbers. The setting `canAtlas.export.neutraliseFormulas` turns this off.
