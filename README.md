# Web-based printing app for EazeID P780BT

A single-page, browser-based controller for the **EazeID P780BT**
Bluetooth thermal label printer — design labels, manage a print queue,
save templates, and configure the device without installing anything.

Runs directly in **Chrome** or **Edge** on desktop via the
[Web Serial API](https://wicg.github.io/serial/). No build step, no
server, no native dependencies — just three static files.

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
client is three static files; you can read every byte of it before
clicking *Connect*.

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
   the running web client in `printer_web/`.

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
2. **Serve the `printer_web/` directory** as static files. Any static
   server works; the simplest:
   ```sh
   cd printer_web
   python -m http.server 8000
   ```
   Then open <http://localhost:8000> in Chrome/Edge.
   You can also just open `index.html` directly (`file://`) — Web
   Serial works over file URLs in most browsers.
3. **Click "Connect printer"** in the hero screen. In the picker
   dialog, select the entry labelled **P780BT** or **JL_SPP**.
   Skip anything labelled *Peripheral Bluetooth* or *Standard Serial
   over Bluetooth* — those lead to dead endpoints.
4. Design a label → Add to queue → Print. The queue auto-clears after
   a successful job.

## Hosting it yourself / GitHub Pages

The repo ships with a ready-to-use Pages workflow at
[`.github/workflows/pages.yml`](./.github/workflows/pages.yml). It
uploads only the `printer_web/` directory as the Pages artefact, so
the published site serves `index.html` from its root URL (README,
LICENSE and the protocol spec stay off the site).

**One-time setup after you fork / push:**

1. Go to **Settings → Pages** on your repository.
2. Under *Build and deployment → Source*, pick **GitHub Actions**.
3. Push to the `main` branch — or hit *Run workflow* on the *Deploy to
   GitHub Pages* action — and the app will be live at
   `https://<your-user>.github.io/p780bt-web/` within a minute or two.

Every subsequent push to `main` re-deploys automatically.

You can of course also just serve `printer_web/` from any other static
host (Netlify, Cloudflare Pages, Vercel, plain Nginx, `python -m
http.server`). The app is three static files — nothing to build, no
API backend.

## Project layout

```
.
├── README.md                 ← this file
├── LICENSE.md                ← MIT + scope clarification
├── P780BT_protocol.md        ← full reverse-engineered protocol spec
├── .gitignore
├── .github/
│   └── workflows/
│       └── pages.yml         ← auto-deploy printer_web/ to GitHub Pages
└── printer_web/              ← the actual application (published as the site)
    ├── index.html            ← all markup (nav, views, modals)
    ├── styles.css            ← custom dark-theme overlay on Bootstrap
    ├── app.js                ← everything else (see below)
    └── P780BT_protocol.md    ← same spec, copied for self-contained hosting
```

### About `app.js`

Everything JavaScript lives in a single file (≈3800 lines). It used to
be split as `app.js` (Web Serial + protocol) plus `label_designer.js`
(canvas + queue + templates), exchanging state through `window.*`.
The two halves were merged into one module-scope script — same load
order, no indirection, single `DOMContentLoaded` entry point.

File sections, top to bottom:

1. Protocol constants (request / response tables, color maps).
2. Stream parser + `SerialLink` class (Web Serial wrapper).
3. UI wiring — status badge, hero, connect/disconnect, Advanced
   offcanvas, `setField` / `setStatus` helpers, toast system.
4. Designer constants (DPI, fonts, text effects, barcode symbologies,
   QR kinds).
5. Element model + default elements + `elementText()` (text /
   counter).
6. Rendering (`renderClean`, `drawElement`, bwip-js wrappers, icon
   picker + bitmap cache).
7. Hit test, drag / resize, snapping, centering.
8. Inspector / element list.
9. Print queue + per-item copies + print-confirmation modal + the
   actual print pipeline (`canvasToMonoBytes`, `monoToRaster`,
   `printQueue`).
10. Templates — CRUD in `localStorage`, export / import, gallery.
11. Keyboard shortcuts + help popover.
12. Single `DOMContentLoaded` calling `main()` then
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
