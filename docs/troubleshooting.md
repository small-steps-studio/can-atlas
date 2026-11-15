# Troubleshooting

**The file is not recognised as a DBC file.** Files ending in `.dbc` are recognised by their name, and files whose first line starts with `VERSION "` by their content. Otherwise pick **DBC** in the language selector at the bottom right.

**"file over the size limit" in the status bar.** The file is larger than `canAtlas.maxFileSizeMB` (default 20 MB, at most 48). Hover, outline and symbols are off for it. Run **CAN Atlas: Check Current File** to check it on demand, or raise the setting. Decode Frame, Encode Signals, Show Bit Layout and the Pro commands read the file in the editor whatever its size.

**Special characters in units and comments show as a replacement character (`DBC-ENCODING`).** Many DBC files are saved in Windows-1252, where the degree sign is one byte. The editor opens them as UTF-8 and shows U+FFFD for the bytes it cannot read. Reopen the file with the right encoding (the encoding in the status bar, then "Reopen with Encoding") and, if you save, save it in the encoding your other tools expect. Files that CAN Atlas reads itself (the file you choose in Compare, the files of the workspace inventory, a signal CSV) are read as UTF-8 with or without a byte order mark, as UTF-16 with a byte order mark, or as Windows-1252 when the bytes are not valid UTF-8.

**A signal is reported as overlapping, but the two never occur in the same frame.** Signals that are selected by different values of the same multiplexor do not overlap. If the multiplexing is not written as `M` and `m0`, `m1`, ... (or with `SG_MUL_VAL_` for nested multiplexors), CAN Atlas cannot know it. See `DBC-SIGNAL-OVERLAP` and the multiplexing codes in [problems.md](problems.md).

**Start bit and byte order look wrong.** In a DBC file the start bit of a little-endian signal (`@1`) is its least significant bit; the start bit of a big-endian signal (`@0`) is its most significant bit, and the signal continues in the lower bits of the byte and then in bit 7 of the next byte. [bit-layout.md](bit-layout.md) draws both. **Show Bit Layout** shows what CAN Atlas makes of a message.

**A value is "not decoded" or a signal is "not present".** The signal is multiplexed and the frame does not select it, or its multiplexor cannot be determined (an unusual chain or a loop of multiplexors). The note in the Decode Frame table says which. **Check Current File** lists the multiplexing problems.

**Decode Frame says the file has no message with the ID.** Check the ID in hex, and whether the message is extended: write `x` after the ID, or use 8 digits (`18FF50E5#...`). In the DBC file an extended ID has bit 31 set (a number from 2147483648 on).

**Decode Trace reads no frame.** The command offers the three layouts (candump -L log, CSV with the columns time, id and data, Vector-style ASCII log); choose the right one. The layouts are described in [trace-decode.md](trace-decode.md). Binary logs are not read.

**A message in the trace is not decoded.** Its ID is in the list of other identifiers in the view. Identifiers of extended frames need bit 31 in the DBC file; the two kinds are different messages, as on the bus.

**The trace table is cut off.** Narrow the filter or raise `canAtlas.trace.maxTableRows`; the statistics and the exports always cover everything that matches.

**Compare says "No content differences" although a diff tool shows changed lines.** The files hold the same database but are written differently: spacing, blank lines, line ends, a byte order mark, the way numbers are written (`0.25` and `0.250`) or the order of receivers and value descriptions. Those are not changes of the database, so no change code is listed; the files are still not identical, so "No differences" is not said.

**Compare shows a change I cannot see in the file.** Differences in spacing, blank lines and the order of receivers are not changes. Numbers are compared as exact decimals (`0.10` equals `0.1`). A message that moved to another ID with the same name and signals is one change of the ID. See [diff-rules.md](diff-rules.md).

**Compare, Create DBC Documentation or Export Signals As CSV refuses a large file.** These commands build their result in memory: Compare reads at most 40 MB of DBC text in total (both files), Create DBC Documentation 20 MB and Export Signals As CSV 32 MB. Split the database into several files.

**A CSV opens in a spreadsheet with an apostrophe in some cells.** Cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get an apostrophe so that the spreadsheet does not run them as formulas. Turn this off with `canAtlas.export.neutraliseFormulas` only if you need the exact text and the program that opens the file does not run formulas.

**The workspace inventory finds no file.** It reads the files that match `canAtlas.workspace.include` (default `**/*.dbc`) and skips those that match `canAtlas.workspace.exclude`. It reads at most `canAtlas.workspace.maxFiles` files.

**The licence check fails behind a proxy or firewall.** The check needs access to `live.dodopayments.com`. Depending on the editor version, a proxy set in the editor's settings may not be used for it. A key that was checked successfully keeps Pro working for up to 14 days while the server cannot be reached; allow the host in your firewall or proxy to renew the check.

**A Pro command shows the Pro message although you have a key.** Run **CAN Atlas: Show Licence Status**; it names the state and offers **Enter Licence Key** and **Lost your key?**. See [licence.md](licence.md).

**Anything else.** Run **CAN Atlas: Report A Problem**: it copies a diagnostics block (versions, platform, settings, licence state; no file contents, names or values) and opens the issues page. Attach a small example file with invented data only.
