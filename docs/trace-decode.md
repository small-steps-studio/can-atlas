# Decode a trace with a DBC file (Pro)

**CAN Atlas: Decode Trace With This DBC (Pro)** reads a recorded trace, finds the message of every frame in the DBC file that is open, and shows each signal's raw and physical value in a table, with statistics per signal and per message. **CAN Atlas: Export Decoded Trace Or Statistics (Pro)** writes every decoded value to a CSV or JSON file, or the statistics to a Markdown, HTML or CSV file. Both are Pro commands (included in the free 14-day trial).

Nothing is sent anywhere. The trace is read from your disk in pieces, so a file of several hundred megabytes does not have to fit into memory.

## The three layouts

The layout is detected from the first 100 lines. When no frame can be read with the detected layout, the command asks which of the three layouts to read the file as and tries again.

### candump -L

```
(1762944000.000100) can0 123#DEADBEEF
(1762944000.000200) can0 18FF50E5#C2FF480E5A02FFFF
(1762944000.000300) can0 123##1DEADBEEF
(1762944000.000400) can0 123#R
```

* Time in seconds in parentheses, the interface name, then `ID#DATA`.
* An identifier with 3 hex digits is a standard (11-bit) identifier, one with 8 digits an extended (29-bit) identifier. Anything else is a bad line.
* `##` marks a CAN FD frame: one hex digit of flags follows, then the data bytes. A CAN FD frame carries 0 to 8, 12, 16, 20, 24, 32, 48 or 64 bytes; any other length is a bad line. A classic frame has up to 8 data bytes.
* A line written for an error frame (`candump -e`: an 8-digit identifier with bit 29, `20000000` or more, set) is not data; it is skipped and counted as "error frame".
* `#R` (a remote request, with or without a length) carries no data and is skipped; it is counted as "remote frame".
* Dots between hex pairs in the data are ignored. Text after the frame on the same line is ignored.
* Lines that start with `#` or `;` are comments.

### CSV

A header row names the columns. Three are required, in any order and in any case:

| Column | Accepted names | Content |
| --- | --- | --- |
| time | `time`, `timestamp` | seconds, for example `12.034500` |
| id | `id`, `can_id`, `canid`, `identifier` | the identifier, see below |
| data | `data`, `payload` | hex bytes, with or without spaces, with or without `0x` in front |

Optional columns: `channel` (also `chn`, `bus`, `interface`), `dlc` (also `length`; read but not needed, the data decides), `extended` (also `ide`, `is_extended`) and `id_format` (also `idformat`).

* The delimiter is a comma, a semicolon or a tab; it is taken from the header row. Cells may be in double quotes (a doubled quote is a quote).
* The identifier is hexadecimal, with or without `0x`. If the row has an `id_format` cell with `dec`, `decimal` or `d` and the identifier has no `0x`, it is read as a decimal number.
* Standard or extended: the `extended` cell decides when it holds `1`, `true`, `yes`, `x`, `ext` or `extended` (extended) or `0`, `false`, `no`, `std` or `standard` (standard). When the cell is missing or empty, an identifier above `0x7FF` is extended and a smaller one is standard. A standard row with an identifier above `0x7FF` is a bad line.
* Lines before the header row and lines that start with `#` are skipped. A quoted cell may not contain a line break.

### Simple ASCII log

The message lines of the common text trace format are read:

```
   0.015000 1  123  Rx   d 8 DE AD BE EF 00 11 22 33
   0.020000 2  18FF50E5x Tx d 2 C2 FF
```

* Time in seconds, channel number, identifier (a trailing `x` marks an extended identifier), direction (`Rx`, `Tx` or `TxRq`), `d`, the data length (0 to 8) and that many data bytes. Text after the data bytes is ignored.
* The header line `base dec` makes the identifiers and the data bytes decimal (a data byte is 0 to 255; any other text is a bad line); `base hex` (the default) makes them hexadecimal. The data length is a decimal number in both.
* Everything else is skipped and counted, not treated as an error: the header lines (`date`, `base`, `internal events logged`, `Begin Triggerblock` and similar), comments starting with `//`, event lines (start of measurement, error frames, statistics), remote frames (`r`) and CAN FD lines. **CAN FD lines of this layout are not read**; use the candump layout or CSV for FD traces.

### Encodings and line ends

UTF-8 (with or without a byte order mark) and UTF-16 with a byte order mark are read. Lines may end with LF, CR LF or CR. A line longer than 1 MB is counted as one bad line and dropped. Binary data does not stop the decoding: the lines that cannot be read are counted.

## How times are read

The time of a frame is kept as a whole number of microseconds, read from the decimal text exactly. A seventh decimal digit of 5 or more rounds up; digits after it are ignored. Times are printed as seconds with six decimals. A time must be a plain number of seconds; there are no negative times and no exponents. Frames are used in file order. If the time of a frame is earlier than that of the previous frame of the same message and channel, no period is computed for it and the count `timeBackwards` goes up by one.

## What is decoded

For each frame, the message is looked up by identifier and frame format: a standard frame `0x123` and an extended frame `0x00000123` are different identifiers, as on the bus. The signals are decoded with the rules of **Decode Frame**: Intel and Motorola bit order, signed values, factor and offset with exact decimals, value descriptions, 32-bit and 64-bit float signals, signals of up to 64 bits (exact), multiplexing including extended multiplexing.

* A signal that is not selected by its multiplexor in this frame is not output.
* A signal that does not fit into the data of the frame (the frame is shorter than the message) is not output and is counted (`shortSignals`); frames shorter than the length in the DBC file are counted as `shortFrames`. Nothing is guessed.
* A signal that cannot be decoded at all (for example because its multiplexor cannot be determined) is never output; **Check Current File** reports why.
* A frame whose identifier is not in the DBC file is counted per identifier (up to 1,000 different identifiers, then one count for all the others).

### The table

Each row is one value of one signal in one frame:

| Column | Content |
| --- | --- |
| Time (s) | seconds with six decimals |
| Channel | the interface or channel of the line (empty when the layout has none) |
| Message | message name |
| ID | `0x123` for standard, `0x18FF50E5` (8 digits) for extended identifiers |
| Signal | signal name |
| Raw | the raw integer (signed when the signal is signed), or the shortest decimal that reads back to the same float |
| Physical | raw × factor + offset as an exact decimal; for floats the value is multiplied and shifted as a decimal; `NaN` and `Infinity` are shown as they are |
| Unit | the unit from the DBC file |
| Description | the value description for the raw value, if the DBC file has one |

The table keeps at most `canAtlas.trace.maxTableRows` rows (default 100,000, at most 1,000,000). The view says how many rows match and how many it shows. The statistics and the exports always cover the whole trace.

## Filters

The view has a filter form. The same options can be set when a trace is decoded.

| Filter | Effect |
| --- | --- |
| Text | keeps the rows whose message name or signal name contains the text (any case) |
| Message names | keeps the rows of the named messages (comma separated, any case) |
| From, to (seconds) | keeps the frames whose time lies between the two values, both included; the values are written like the times in the trace |
| Channel | keeps the frames of that channel or interface (any case) |

The channel and the time window apply to everything: rows, statistics and counters. The text and message filters only narrow the table and the exports; the statistics always cover all decoded messages in the window. A quick search field above the table narrows the rows that are shown without decoding again.

## Statistics

### Per signal

Number of values, minimum, maximum and mean of the physical value, the raw minimum and maximum, and the time of the first and the last value.

* Integer signals: the sum of the raw values is kept exactly, so the mean is exact before it is rounded to six decimals (halves away from zero). Minimum and maximum are exact, also for 64-bit signals. If the factor is negative, the largest raw value gives the smallest physical value, and the statistics take that into account.
* Float signals: minimum, maximum and mean are computed with ordinary floating-point numbers (the sum is compensated). `NaN` and infinite values are counted apart and left out.

### Per message

* Frames, first and last time.
* **Period**: the time between two consecutive frames of the same message on the same channel, in microseconds. The statistics give the number of periods, the mean, the smallest and the largest period, the population standard deviation (the square root of the mean squared deviation from the mean) and the frequency in hertz (a million divided by the mean period).
* **Jitter**: the largest distance of any period from the mean period, so the larger of (largest period − mean) and (mean − smallest period).
* **Cycle time**: when the DBC file gives the message a cycle time (the attribute `GenMsgCycleTime`, or `CycleTime`, in milliseconds), the statistics also show it in microseconds, the largest deviation of any period from it, and a verdict. A period deviates when its distance from the cycle time is more than half the cycle time. The verdict is `within 50 percent of the cycle time for every frame`, or `N of M intervals deviate by more than 50 percent`. Without a cycle time the verdict is `no cycle time in the database`; with fewer than two frames it is `fewer than two frames, so there is no interval to compare`.
* Frames shorter than the message, and signals of the message that can never be decoded.

The figures are measured from the times in the trace. They describe the recording, not the behaviour of the control units, and they depend on the resolution and the accuracy of the time stamps of the logger.

## Counters and bad lines

The result counts: lines read; frames; frames of messages in the DBC file; frames of other identifiers; frames inside and outside the filter window; skipped lines by reason (blank lines, comments, headers, remote frames, events); lines that could not be read. Every line is exactly one of: a frame, a skipped line, a bad line. The first 100 bad lines are listed with their line number, the reason and the first 120 characters of the line.

When the layout cannot be recognised, no frame is read and every non-blank line counts as bad; the view says so. The command then offers the three layouts; choose one, or check that the file is one of the three layouts above.

## Export

**Export Decoded Trace Or Statistics (Pro)** (or the Export button of the view) decodes the trace again and writes every matching row (not only the rows shown in the table) piece by piece to the file you choose; memory use does not grow with the file.

Columns, in this order: `time`, `channel`, `message`, `id`, `signal`, `raw`, `physical`, `unit`, `description`.

* Raw and physical values are exact decimal strings in both formats; the JSON file writes them as strings so that no digit is lost to floating-point numbers. The JSON file is one array with one object per row, valid also when it is empty.
* CSV follows RFC 4180 (quotes, doubled quotes, CR LF). Cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get an apostrophe in front, so that a spreadsheet shows them as text and does not run them as formulas. Plain numbers such as `-12.5` are not changed. Switch this off with `canAtlas.export.neutraliseFormulas` only if you need the exact values and open the file in a program that does not run formulas. JSON is not changed.

The statistics can also be written as Markdown, HTML (a page without scripts) or CSV.

## Large files

A trace is read in pieces of 1 MB. Only the counters, the accumulators of the statistics and the table rows (at most `canAtlas.trace.maxTableRows`) are kept. In a virtual workspace the editor cannot stream a file; there the whole file is read, and traces above 64 MB are refused with a message.

## Limits

* Classic CAN and CAN FD frames in the candump layout and CSV; classic frames in the ASCII layout.
* One DBC file at a time; one set of rules for all channels. Use the channel filter when two buses carry the same identifiers.
* No binary logs, no live capture, no transmit.
* Periods are measured per message and channel; a trace that is not sorted by time gives odd periods (the backwards steps are counted).

## Troubleshooting

* **Nothing is decoded, every line is bad.** The layout was not recognised. Check the first lines against the examples above.
* **A message is not decoded.** Look at the identifiers in the list of other identifiers: an extended identifier has 8 digits in the candump layout and needs `x` in the ASCII layout; the DBC file must set bit 31 for extended messages.
* **Fewer values than expected.** The frames may be shorter than the message (see the counters), or a multiplexor does not select the signal.
* **The table is cut off.** Narrow the filter, or raise `canAtlas.trace.maxTableRows`; the export always contains every matching row.
