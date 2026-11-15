# Bit layout

CAN Atlas draws the byte and bit grid of a message in two ways:

* **CAN Atlas: Show Bit Layout** (free) opens a Markdown document: a table of the signals and one grid per combination of multiplexor values.
* **CAN Atlas: Show Graphical Bit Layout (Pro)** (included in the free 14-day trial) opens the same grid as a page with colours, borders, marks and a signal table. It needs no network and runs no script.

## How bits are numbered

The bits of a frame are numbered byte by byte: bit `8 * k + j` is bit `j` of byte `k`, where bit 0 of a byte is its least significant bit and bit 7 its most significant bit. Byte 0 holds bits 0 to 7, byte 1 holds bits 8 to 15, and so on up to 64 bytes (512 bits) for CAN FD. In the grids, each row is a byte and the columns run from bit 7 on the left to bit 0 on the right.

A DBC signal line names a start bit, a length and a byte order: `SG_ Name : <start>|<length>@<order><sign>`. The order is `1` for little-endian (Intel) and `0` for big-endian (Motorola).

### Intel (`@1`): the start bit is the least significant bit

The signal begins at the start bit and continues upwards: after bit 7 of a byte comes bit 0 of the next byte. Example, a 3-byte message with

```
SG_ Speed : 4|12@1+ (1,0) [0|0] "" N
```

The signal starts at bit 4 (byte 0, bit 4) and has 12 bits, so it covers frame bits 4 to 15: bits 4 to 7 of byte 0 (the low part of the value) and all eight bits of byte 1 (the high part). The most significant bit is frame bit 15, which is byte 1 bit 7.

| Byte | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
| ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 0 | A | A | A | A ▼ | · | · | · | · |
| 1 | A ▲ | A | A | A | A | A | A | A |
| 2 | · | · | · | · | · | · | · | · |

Check by hand: for the data bytes `30 12 00`, the value is `byte 1 × 16 + (byte 0 >> 4)` = 0x12 × 16 + 3 = 291 (0x123).

### Motorola (`@0`): the start bit is the most significant bit

The signal begins at the start bit and continues downwards: after bit 0 of a byte comes bit 7 of the next byte. Example, a 3-byte message with

```
SG_ Temp : 11|12@0+ (1,0) [0|0] "" N
```

The start bit 11 is byte 1, bit 3, and it is the most significant bit. The signal runs down through bits 3, 2, 1, 0 of byte 1 (4 bits) and continues with bits 7 to 0 of byte 2 (8 bits). The least significant bit is byte 2 bit 0, frame bit 16.

| Byte | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
| ---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 0 | · | · | · | · | · | · | · | · |
| 1 | · | · | · | · | A ▲ | A | A | A |
| 2 | A | A | A | A | A | A | A | A ▼ |

Check by hand: for the data bytes `00 05 A3`, the value is `(byte 1 & 0x0F) × 256 + byte 2` = 5 × 256 + 163 = 1443.

A frequent mistake is to read the start bit of a big-endian signal as its least significant bit. The checks report a big-endian signal that does not fit into the data length (`DBC-SIGNAL-OUTSIDE-FRAME`) with a reminder that the start bit is the most significant bit.

### Signed values, floats and 64 bits

* A signed signal (`-` after the byte order) is a two's complement number of its own length; the bit pattern is sign-extended from the signal's most significant bit.
* A signal with a value type of 32-bit or 64-bit float (`SIG_VALTYPE_`) must be exactly 32 or 64 bits long; its bits are an IEEE 754 number.
* Raw values up to 64 bits are handled with exact integers, so a 64-bit counter keeps every digit.

## Reading the text view

* The first table lists the signals with a letter key (A to Z, then AA, AB and so on), start bit and length, byte order, value type, scaling and unit.
* In the grids a letter names the signal that uses the bit. `▲` marks the most significant bit of a signal and `▼` its least significant bit. `·` is an unused bit. `!` marks a bit used by more than one signal, and the cell lists the keys, for example `A+B !`.
* Rows below the data length of the message are labelled `(beyond the data length)`.

## The graphical view (Pro)

* Same grid, with bit 7 on the left. Every signal has a letter key, its own colour and its own border style (solid, dashed, dotted or double), so colour is never the only way to tell signals apart. The keys are the same in every grid of a message.
* A bit used by more than one signal has a thick red border, a hatched fill and the text `!`. The overlaps are also listed under the grid ("byte 0 bit 4: A (First), B (Second)").
* Every cell has a text label for screen readers, for example `byte 1 bit 7: signal Speed, most significant bit`, `byte 0 bit 3: unused` or `byte 0 bit 7: signals First and Second overlap`.
* The page follows the editor's colours in light and dark themes and has rules for the operating system's high-contrast mode.
* The page holds no script, loads nothing from outside and has no inline style attributes; its content security policy allows only its own style block.
* The signal table below the grids lists up to 1,000 signals, with a note for signals that cannot be drawn or decoded.

## Multiplexed messages

A message with a multiplexor shows its layout in groups:

1. **Signals present in every frame**: the multiplexor itself and every signal that does not depend on a multiplexor.
2. One group per combination of multiplexor values, titled with the condition, for example `PageIndex = 0`. A group holds the signals present in every frame and the signals that are present for that combination. Signals that are present for different values of the same multiplexor never appear in the same group, so their shared bits are not marked as overlaps.

With extended multiplexing (`SG_MUL_VAL_`) a multiplexor can itself depend on another multiplexor and a signal can be present for ranges of values; the group titles list every multiplexor above the signal, for example `Mode = 1, Page = 0-3`. Nesting is limited to 32 levels.

The text view shows at most 64 combinations and the graphical view draws at most 32 grids; the rest is counted ("N further combinations of multiplexor values are not drawn"). Signals whose multiplexor cannot be determined (none, several candidates, a loop, a floating-point multiplexor) are never drawn into a group; the text view lists them under "Not decoded" with the reason, and the Problems view reports the cause with a `DBC-MUX-...` code.
