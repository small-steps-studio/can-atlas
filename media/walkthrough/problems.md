## Problems with codes

CAN Atlas checks the database while you type and lists every problem in the Problems view with a stable code, for example:

* `DBC-SIGNAL-OVERLAP`: two signals use the same bits of a frame at the same time,
* `DBC-SIGNAL-OUTSIDE-FRAME`: a signal reaches beyond the data length of its message,
* `DBC-RECEIVER-UNKNOWN`: a receiver that is not listed under `BU_`,
* `DBC-RANGE-INVERTED`: a minimum above the maximum,
* `DBC-MESSAGE-ID-DUPLICATE`: two messages with the same ID,
* `DBC-MESSAGE-EXTENDED-FLAG`: an ID that needs 29 bits but has no extended-frame flag.

Click the code in the Problems view to open its explanation in the documentation. The checks look at the text of the file; they do not replace a test on the bus. A code you do not want to see can be hidden with the setting `canAtlas.problems.disabledCodes`.
