## Decode and encode a frame

**Decode Frame** takes the ID and the data bytes of a frame in hex, for example `100#401F72FA8E01103C`, and shows every signal of the message with its raw and physical value, its unit and its value description. Little-endian and big-endian signals, signed values, factors and offsets, float signals, signals of up to 64 bits and multiplexed signals are handled; values are exact decimals, never rounded floats.

**Encode Signals** goes the other way: enter `Name=value` pairs, separated by `;`, and get the data bytes of the frame. Signals you leave out start at the raw value 0, and a value between two raw steps is rounded to the nearest step, which the result says.

**Show Bit Layout** draws the byte and bit grid of a message as a table, one grid for every combination of multiplexor values.
