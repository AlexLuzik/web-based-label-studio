# Web-based printing app for EazeID P780BT

A single-page, browser-based controller for the **EazeID P780BT**
Bluetooth thermal label printer — design labels, manage a print queue,
save templates, and configure the device without installing anything.

Runs directly in **Chrome** or **Edge** on desktop via the
[Web Serial API](https://wicg.github.io/serial/). No build step, no
backend, no native dependencies — a handful of static files behind a
static HTTP server (the Chromium module loader needs `http(s)://`).

**Author:** [Oleksandr Luzin](https://luzin.cc) &middot;
**License:** [MIT](./LICENSE.md) &middot;
**Protocol reference:** [P780BT_protocol.md](./P780BT_protocol.md) &middot;
**Live demo:** <https://alexluzik.github.io/p780bt-web/>
<sub>(replace with your own GitHub user when forking)</sub>

---

## Why this exists

The P780BT ships with a mobile companion app (**PrintMaster** by
Aimotech) that's the only "official" way to drive the printer. To
print a single label it demands a permission manifest that reads like
a profiling toolkit — full access to your **photos and media**,
**contacts**, **location**, **phone and call log**, **microphone**,
device identifiers, and unrestricted background networking. Almost
none of that has anything to do with putting ink on a plastic tape.

I own the printer; I don't want to hand over my phone's address book
and camera roll to use it. So this project talks to the P780BT
directly — over the open Bluetooth Serial profile the device already
advertises — from an ordinary browser tab. It needs **nothing** beyond
access to the serial port the user explicitly picks. No accounts, no
telemetry, no SDKs, no background services, no uploads. The entire
client is a handful of plain static files; you can read every byte of
it before clicking *Connect*.

It turned out to also be noticeably faster, friendlier on desktop, and
easier to keep on an offline machine than the vendor app, but the
original point was simply: a label printer shouldn't cost you your
contacts.

## How this was made

The reverse-engineering was done in two stages:

1. **Bluetooth traffic capture** on a clean Android phone running
   **PrintMaster**. Developer options → *Enable Bluetooth HCI snoop
   log* produces a full `btsnoop_hci.log` of every HCI / L2CAP / RFCOMM
   frame the companion app exchanges with the printer. A few real print
   jobs, a battery / paper query, and a cartridge read were recorded in
   isolation so each command-response pair could be attributed
   unambiguously.
2. **Protocol analysis, SDK cross-reference and client implementation
   were delegated to [Claude Code](https://www.anthropic.com/claude-code).**
   It parsed the HCI dumps, matched byte patterns against the
   decompiled `com.project.aimotech.*` Java sources, built up the
   request / response tables that now live in
   [`P780BT_protocol.md`](./P780BT_protocol.md), and turned them into
   the running web client now shipped at the repository root.

The rest of the repository — architecture, UI, print pipeline, raster
rotation, templates, responsive layout, everything — was iterated on
conversationally with Claude Code. **The project is fully
vibe-engineered**: no line of code here was hand-typed by the author.
It is published **as-is**, with no guarantees of fitness, correctness,
or continued maintenance. If it works for your setup — great. If it
doesn't — the sources are short enough to read end-to-end, and the
protocol reference should be enough to adapt the client to your needs.

## Features

- **Connect** over Bluetooth Serial Port Profile (SPP) with a single
  click — no pairing dialog roulette, the app verifies the endpoint is
  actually a P780BT by probing for its serial number.
- **Label designer** — free-positioning canvas with text, barcodes
  (Code 128, EAN-13, QR, Data Matrix, PDF417 and more via `bwip-js`),
  Bootstrap Icons, and an auto-incrementing `Text + counter` element
  that expands into a batch of N labels at print time.
- **Per-item print queue** — each queued label keeps its own copies
  counter, and the Print button shows an explicit confirmation with
  the total physical labels about to be produced.
- **Templates** — save designs to `localStorage`, reopen, duplicate,
  rename, delete, and export / import as JSON for backup.
- **Printer tab** — live device state (serial, battery, paper, cover,
  cartridge) and safe configuration (paper type, auto-power-off,
  expert controls for density / speed / margin behind an opt-in
  switch).
- **Keyboard shortcuts** — <kbd>Ctrl</kbd>+<kbd>S</kbd> save template,
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> add to queue,
  <kbd>Ctrl</kbd>+<kbd>P</kbd> print, <kbd>Esc</kbd> deselect,
  <kbd>?</kbd> shows the full list.
- **Responsive** — collapses into a burger menu below 992 px so it
  works on tablets and phones (for phones paired via USB-BT).
- **Dark theme only** — Bootstrap 5.3 with custom overrides.

## Requirements

- **Browser:** Chrome or Edge on desktop, version ≥ 89 (Web Serial).
  Firefox and Safari are not supported — the Web Serial API is
  Chromium-only.
- **OS:** Anything that exposes a paired Bluetooth SPP device as a
  serial port (Windows, macOS, Linux, ChromeOS).
- **Hardware:** EazeID P780BT printer, paired with your OS first.

## Usage

1. **Pair the printer** with your operating system's Bluetooth
   settings, so it appears as a Standard Serial over Bluetooth COM /
   tty port.
2. **Serve the repository root** as static files. The app is now an
   ES module (`import`/`export`), and Chrome blocks module loading
   from `file://` URLs, so a local server is required. The simplest:
   ```sh
   python -m http.server 8000
   ```
   Then open <http://localhost:8000> in Chrome/Edge.
3. **Click "Connect printer"** in the hero screen. In the picker
   dialog, select the entry labelled **P780BT** or **JL_SPP**.
   Skip anything labelled *Peripheral Bluetooth* or *Standard Serial
   over Bluetooth* — those lead to dead endpoints.
4. Design a label → Add to queue → Print. The queue auto-clears after
   a successful job.

## Hosting it yourself / GitHub Pages

The app lives at the repository root, so GitHub Pages publishes it
with zero configuration files — no workflow, no build step.

**One-time setup after you fork / push:**

1. Go to **Settings → Pages** on your repository.
2. Under *Build and deployment → Source*, pick **Deploy from a branch**.
3. Pick branch **`main`** and folder **`/ (root)`**, then *Save*.
4. Within a minute the app is live at
   `https://<your-user>.github.io/p780bt-web/`.

Every subsequent push to `main` re-deploys automatically.

The app is a handful of plain static files — nothing to build, no API
backend — so it also drops into any other static host (Netlify,
Cloudflare Pages, Vercel, plain Nginx, `python -m http.server`).

## Project layout

```
.
├── README.md                 ← this file
├── LICENSE.md                ← MIT + scope clarification
├── .gitignore
├── index.html                ← all markup (nav, views, modals)
├── styles.css                ← custom dark-theme overlay on Bootstrap
├── app.js                    ← UI / designer / queue (see below)
├── printer/                  ← pluggable printer driver layer
│   ├── transport.js          ← generic Web Serial + framing parser
│   ├── driver-base.js        ← abstract Driver (EventTarget + waitForTag)
│   ├── p780bt.js             ← concrete P780BT driver
│   └── index.js              ← createDriver() factory + registry
└── P780BT_protocol.md        ← full reverse-engineered protocol spec
```

### About `printer/`

All protocol-specific code lives behind a **Driver** contract. `app.js`
never references wire bytes, response tags, DPI constants, or raster
layout directly — it talks to the active driver through events
(`connected`, `frame`, `tx`, `rx`, `identity-failed`, …) and high-level
method calls (`driver.connect()`, `driver.readAll()`,
`driver.rasterize(canvas)`, `driver.sendRaster(bytes)`,
`driver.beginJob()`/`endJob()`).

Adding support for another Bluetooth thermal printer is a matter of:

1. Writing a new file like `printer/other-model.js` that exports a
   class extending `Driver` (see `driver-base.js` for the required
   overrides — `_createParser`, `_decodeFrame`, `_verifyIdentity`,
   `rasterize`, `sendRaster`, `beginJob`, `endJob`, and the
   `model` / `dpi` / `commands` / `settings` / `actions` metadata).
2. One line in `printer/index.js`:
   `registerDriver('other-model', OtherModelDriver);`.
3. Creating it instead of `'p780bt'` in `app.js` (or adding a model
   selector UI — the registry already supports it via `listDrivers()`).

Everything above that — designer, inspector, queue, templates, UI —
runs unchanged against any driver that honours the contract.

For debugging, the running driver is exposed as `window.BTPrinter.driver`
in DevTools (along with the driver classes and the `P780BT_CONSTANTS`
table).

### About `app.js`

UI-only now (≈3100 lines). Sections top to bottom:

1. Driver bootstrap — `createDriver('p780bt')`, event listeners that
   translate driver events into DOM updates (status badge, battery
   bar, material swatches, Advanced log, wrong-endpoint modal).
2. Thin command wrappers (`applySetting`, `applyAction`) that add the
   write-mode gate and danger-action confirm dialog around the
   driver's pure methods.
3. Designer constants (DPI / PX_PER_MM read from `driver`, fonts,
   text effects, barcode symbologies, QR kinds).
4. Element model + default elements + `elementText()` (text /
   counter).
5. Rendering (`renderClean`, `drawElement`, bwip-js wrappers, icon
   picker + bitmap cache).
6. Hit test, drag / resize, snapping, centering.
7. Inspector / element list.
8. Print queue + per-item copies + print-confirmation modal +
   `printQueue()` (drives `driver.rasterize` / `beginJob` /
   `sendRaster` / `endJob`).
9. Templates — CRUD in `localStorage`, export / import, gallery.
10. Keyboard shortcuts + help popover.
11. Single `DOMContentLoaded` calling `main()` then
    `initLabelDesigner()`.

## Runtime dependencies

Loaded from public CDNs — no bundler, no `node_modules`:

| Library | Version | Purpose |
|---|---|---|
| [Bootstrap](https://getbootstrap.com/) | 5.3.3 | Layout, forms, modals, offcanvas |
| [Bootstrap Icons](https://icons.getbootstrap.com/) | 1.11.3 | Icon glyphs for UI + the Icon element |
| [bwip-js](https://github.com/metafloor/bwip-js) | 4.5.0 | Barcode / QR / Data Matrix rasterisation |

## Known quirks

- **Battery at 100% shows as `100%`** — the P780BT firmware returns
  `0x00` on the battery query when fully charged. Since a 0% battery
  would have shut the printer off before it could answer, we treat
  `0x00` as full.
- **Label length vs cartridge width** — cartridge width is fixed by the
  `<select>` (12 / 18 / 24 mm) and validated against what the printer
  reports; label length is unbounded.
- **Print head dead zone** — the first ~4 mm of each label are
  auto-fed blank by the firmware; `PRINT_VERTICAL_SHIFT_PX` in
  `app.js` nudges content 0.28 mm down to compensate. Tune if your
  unit prints slightly off-centre.

## Protocol reference

Everything this client knows about the wire format — request bytes,
response tags, payload layouts, firmware quirks — is documented in
[**P780BT_protocol.md**](./P780BT_protocol.md), including the U.S.
legal basis for the reverse-engineering that produced it.

## License & legal

MIT, with explicit scope carve-outs for vendor trademarks and
third-party code we don't ship. See [LICENSE.md](./LICENSE.md) for the
full text plus the reverse-engineering fair-use notice.

No affiliation with, endorsement by, or sponsorship from EazeID or
Aimotech is claimed or implied. Device, app and brand names are used
only to identify the hardware this client is interoperable with.
