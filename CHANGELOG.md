# Changelog

## 0.1.0

First release. The free features need no key, no account and no network connection. The Pro features can be tried free for 14 days and are then unlocked with a one-time licence key sold outside the Marketplace.

Free:

* DBC language for `.dbc` files and for files that start with `VERSION "`, with syntax colouring.
* DBC Outline view (messages by ID with their signals, nodes, value tables; long lists in pages), document symbols, breadcrumbs and folding by message.
* Hover on signals, messages, nodes and value tables: bits, byte order, scaling, raw and physical range, unit, receivers, multiplexing condition, value descriptions, cycle time.
* Go to definition and find references for messages, signals and nodes.
* Problems with 61 stable, documented codes: syntax, overlapping signals (multiplexing aware), signals beyond the data length, duplicate IDs and names, unknown nodes, value tables, factors and ranges, multiplexing including extended multiplexing, extended-ID flag mistakes, names, attributes and limits.
* Decode Frame and Encode Signals with exact arithmetic: little-endian and big-endian signals, signed values, 64-bit signals, float signals, factors and offsets as exact decimals, value descriptions, multiplexed signals.
* Show Bit Layout, Go To Message, Check Current File, status bar counts.
* Samples with invented data, a walkthrough, Report A Problem and Show Documentation.

Pro (14-day trial, then a licence key):

* Compare DBC With Another File: 57 documented change codes, each classed breaking, non-breaking or cosmetic; a tree view and Markdown, HTML and CSV reports. "No differences" is said only for two files that are the same byte for byte; files that differ only in spacing, line ends, number spelling or list order are reported as such.
* Show Graphical Bit Layout (a page without scripts).
* Decode Trace With This DBC for candump `-L` logs, CSV files and Vector-style ASCII logs: filters, statistics per signal and per message, timing against the cycle time, CSV and JSON export; the trace is read in pieces.
* Create DBC Documentation (Markdown, HTML), Export Signals As CSV and Create DBC From Signal CSV, Create Workspace DBC Inventory.
* Formula protection of CSV cells; it can be switched off with a setting.

Not included: binary logs, other database formats, bus access and live capture.

Tested on Windows with VS Code 1.146: the packaged extension was installed into a fresh profile and each command group was run in the editor against a local stand-in for the licence service. The unit tests also ran in three time zones and from a folder whose path contains spaces and non-ASCII characters. macOS, Linux and other editors were not tested.
