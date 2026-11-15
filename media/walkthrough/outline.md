## Outline and hover

The **CAN Atlas** view in the activity bar lists the messages of the file by ID, each with its signals, then the nodes and the value tables. Click a line to jump to it. Long lists are shown in pages of 500.

Rest the pointer on a name or a number:

* on a **signal**: the bit range and the bytes it touches, the byte order and which end the start bit is, the sign, the scaling formula (`physical = raw x factor + offset`), the raw and the physical range, the unit, the receivers, the multiplexing condition and the value descriptions;
* on a **message**: the ID in hex and decimal, standard or extended, the data length, the sender, the cycle time and the signals;
* on a **node**: the messages it sends and the signals it receives; on a **value table**: its entries.

**Go to Definition** and **Find All References** work for messages, signals and nodes that later lines (comments, value descriptions, attributes) refer to. The status bar counts the messages, the signals and the problems of the file.
