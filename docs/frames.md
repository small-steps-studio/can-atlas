# Decode and encode frames

Both commands are free. They work on the DBC file in the active editor, need no network and no key, and use exact arithmetic: raw values are integers of up to 64 bits, factors, offsets and physical values are exact decimals, never binary floats.

## Decode Frame

**CAN Atlas: Decode Frame** asks for a frame and opens a Markdown document with one row per signal of the message.

### Writing the frame

All numbers are hexadecimal. These forms are read:

| Input | Meaning |
| --- | --- |
| `100#401F72FA8E01103C` | ID 0x100, eight data bytes (the form `candump -L` writes) |
| `100 40 1F 72 FA` | the same with spaces, commas, colons or semicolons between the bytes |
| `0x100 401F72FA` | a `0x` in front of the ID or of a byte is accepted |
| `18FF50E5#0102` | an ID above 0x7FF is an extended ID |
| `100x#0102` | an `x` after the ID forces an extended ID |
| `80000100#0102` | a number from 0x80000000 on is read as the DBC form of an extended ID (bit 31 set) |

At most 64 data bytes (a CAN FD frame). The digits of the data must come in pairs. A wrong input is explained and nothing is opened.

If the file has both a standard message and an extended message with the same number, the standard one is used and the document says so; add `x` to choose the extended one. If the file has no message with the ID, the first IDs of the file are listed.

### The result

The document starts with the message name, its ID (standard or extended) and the frame as written. The table has these columns:

| Column | Content |
| --- | --- |
| Signal | the signal name |
| Raw | the raw integer (negative for a signed signal), or for a float signal the shortest decimal that reads back to the same float |
| Physical | raw x factor + offset, as an exact decimal |
| Unit | the unit from the DBC file |
| Description | the value description for the raw value, if the file has one |
| Note | why a row has no value |

A row has no value, and says why, in three cases:

* **not present**: the signal is multiplexed and the multiplexor of this frame does not select it (extended multiplexing, with several multiplexors and ranges, is followed completely);
* **short**: the frame has fewer bytes than the signal needs; nothing is guessed;
* **not decoded**: the signal cannot be decoded at all, for example because its multiplexor cannot be determined. [Check Current File](problems.md) reports the reason with a problem code.

A frame that is shorter or longer than the message is decoded as far as it goes, with a note.

## Encode Signals

**CAN Atlas: Encode Signals** works on the message under the cursor, or asks you to pick one. Enter the values as `Name=value` pairs separated by `;` (a comma or a line break also separates):

```
EngineSpeed=3000; CoolantTemp=90
GearSelected="Drive"
```

* A number is a **physical value**. It is converted with the factor and offset of the signal and rounded to the nearest raw step; when the rounded value differs from the one you entered, the result shows it.
* A text in double quotes, or an unquoted text equal to a value description (any case), is a **value description**; its raw value is encoded.
* A value that needs a raw value outside the bits of the signal is an error and the frame is not complete. A value outside the minimum and maximum of the signal but inside its bits is encoded and flagged with a warning.
* Signals that are **not given** start at the raw value 0 and are marked "not given: raw 0". The start value attribute of a signal is not applied.
* A **multiplexed** signal is encoded only when the multiplexor you gave selects it; give the multiplexor value too.
* Float signals (32 and 64 bit) are stored as the nearest float and the stored value is shown.
* Signals that overlap in the file are reported ("the bits written last win").

The result document shows the frame as `ID#DATA`, the bytes and one row per signal; a notification offers **Copy Frame**.

## Where the numbering rules are explained

How start bits are counted in the two byte orders, and what a 64-bit or signed signal looks like in the grid, is in [bit-layout.md](bit-layout.md).
