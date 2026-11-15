# Getting started

1. Install **CAN Atlas** from the Extensions view (publisher Small Steps Studio). It needs VS Code 1.82 or newer.
2. Open a DBC file. Files ending in `.dbc` open in the DBC language, and so does any file whose first line starts with `VERSION "`. You can also pick **DBC** in the language selector at the bottom right. To try the extension without a file of your own, run **CAN Atlas: Open Sample DBC**; the sample holds invented data only.
3. Click the CAN Atlas icon in the activity bar for the **DBC Outline**: the messages by ID with their signals, the nodes and the value tables. A click on a line moves the cursor there.
4. Rest the pointer on a signal, a message, a node or a value table: the hover shows the bits, byte order, scaling, unit, receivers and value descriptions (see [bit-layout.md](bit-layout.md) for how the bits are numbered).
5. Open the Problems view (Ctrl+Shift+M). Every problem has a code that is explained in [problems.md](problems.md); **CAN Atlas: Open Sample DBC With Problems** shows six typical ones.
6. Run **CAN Atlas: Decode Frame**, enter `100#401F72FA8E01103C` and read the raw and physical value of every signal of the sample message with the ID 0x100. **CAN Atlas: Encode Signals** goes the other way. See [frames.md](frames.md).
7. **Help > Welcome > Get started with CAN Atlas** walks through these steps and the Pro tools.

## Go to definition and find references

On a message, a signal or a node that a later line refers to (a comment, a value description, an attribute, a transmitter list), **Go to Definition** jumps to where it is defined and **Find All References** lists every place that names it. The same works from the definition.

## Good to know

* Files up to `canAtlas.maxFileSizeMB` (20 MB by default, at most 48) are checked automatically and get hovers, the outline and symbols. Larger files are read only when you run **CAN Atlas: Check Current File**, **Decode Frame**, **Encode Signals** or another command on them. The editor itself hands extensions files up to 50 MB.
* The checks look at the text of the file. They do not tell whether a database works on a bus, and another tool may read a file differently. Keep your own tests.
* Nothing in the free tier needs the network or a key.
* The **Pro** tools (compare two DBC files, graphical bit layout, decode a trace, documentation, CSV round trip, workspace inventory) run in a free 14-day trial that starts with the first one you use; see [licence.md](licence.md).

More: [Decode and encode frames](frames.md), [Bit layout](bit-layout.md), [Problems and codes](problems.md), [Comparing two DBC files](diff-rules.md), [Decoding a trace](trace-decode.md), [Other Pro tools](tools.md), [Licence, trial and Pro](licence.md), [Troubleshooting](troubleshooting.md).
