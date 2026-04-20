// =====================================================================
//  BTPrinter / p780bt.js — concrete driver for the EazeID P780BT
// ---------------------------------------------------------------------
//  All P780BT-specific knowledge lives here:
//    - wire-format constants (request / response prefixes, tag tables)
//    - frame decoding (decodeFrame)
//    - identity check for the "is this port actually a P780BT?" probe
//    - raster layout (rotation + shift constants at 180 DPI)
//    - print-job pipeline split into beginJob → rasterize → sendRaster
//      → endJob so the UI can show per-label progress.
//
//  Everything in this file is safe to swap out for a different model
//  by implementing the same Driver interface — nothing above this
//  layer (app.js UI, designer, queue) depends on P780BT bytes.
// =====================================================================

import { Driver } from './driver-base.js';
import { ResponseParser } from './transport.js';
import { detectDriverBySn } from './sn-registry.js';

// ---------- Protocol constants ----------

const REQ_PREFIX  = [0x1F, 0x11];
const RESP_PREFIX = 0x1A;

// Only commands that P780BT actually answers.
const GET_COMMANDS = [
  { name: 'firmware_version',        cmd: 0x07 },
  { name: 'battery',                 cmd: 0x08 },
  { name: 'serial_number',           cmd: 0x09 },
  { name: 'auto_power_time',         cmd: 0x0E },
  { name: 'paper_state',             cmd: 0x11 },
  { name: 'cover_state',             cmd: 0x12 },
  { name: 'hot_state',               cmd: 0x13 },
  { name: 'label_type',              cmd: 0x19 },
  { name: 'bt_mac',                  cmd: 0x20 },
  { name: 'rfid_remain',             cmd: 0x22, needsCartridge: true },
  { name: 'rfid_label_info',         cmd: 0x31, needsCartridge: true },
  { name: 'chip_type',               cmd: 0x38 },
  { name: 'material_encrypt_detail', cmd: 0x3F, needsCartridge: true },
];

// SET commands with argument. header + <value bytes>.
const SET_COMMANDS = {
  AUTO_POWER:    { header: [0x1B, 0x4E, 0x07] },  // +1 byte, P-series byte*5=min
  PRINT_DENSITY: { header: [0x1F, 0x11, 0x02] },  // +1 byte
  PRINT_SPEED:   { header: [0x1F, 0x11, 0x23] },  // +1 byte
  LEFT_MARGIN:   { header: [0x1F, 0x11, 0x24] },  // +1 byte
  PAPER_TYPE:    { header: [0x1F, 0x11, 0x0B] },  // +1 byte (0x0A/0x0B/0x26/0x4E)
};

// Safe actions (commands with no argument).
const ACTIONS = {
  INIT_PRINTER:    { bytes: [0x1B, 0x40],       danger: false, label: 'Init Printer',  hint: 'ESC @ — reset parameters' },
  FEED_PAPER:      { bytes: [0x1F, 0x11, 0x32], danger: false, label: 'Feed Paper',    hint: 'advance paper' },
  BACK_PAPER:      { bytes: [0x1F, 0x11, 0x2B], danger: false, label: 'Back Paper',    hint: 'roll paper back' },
  AUTO_LOCATE:     { bytes: [0x1F, 0x11, 0x25], danger: false, label: 'Auto Locate',   hint: 'find gap between labels' },
  PRINT_TEST_PAGE: { bytes: [0x1F, 0x11, 0x27], danger: true,  label: 'Print Test',    hint: 'print a test page' },
  DISCONNECT_BT:   { bytes: [0x1F, 0x11, 0x29], danger: true,  label: 'Disconnect BT', hint: 'printer will drop the BT connection' },
};

const AUTO_POWER_OPTIONS = [
  { value: 0,  label: 'Never' },
  { value: 1,  label: '5 min' },
  { value: 3,  label: '15 min' },
  { value: 6,  label: '30 min' },
  { value: 12, label: '1 hour' },
  { value: 24, label: '2 hours' },
  { value: 48, label: '4 hours' },
  { value: 96, label: '8 hours' },
];

const PAPER_TYPE_OPTIONS = [
  { value: 0x0B, label: 'Continuous' },
  { value: 0x0A, label: 'Gap (with gaps)' },
  { value: 0x26, label: 'Black mark' },
  { value: 0x4E, label: 'Other / Black mark card' },
];

// Expected payload length per response tag. null = variable length.
const RESP_LEN = {
  0x03: 1,   // HOT_STATE
  0x04: 1,   // BATTERY
  0x05: 1,   // COVER_STATE
  0x06: 1,   // PAPER_STATE
  0x07: 3,   // FIRMWARE_VERSION
  0x08: 15,  // SN
  0x09: 1,   // AUTO_POWER_TIME
  0x0C: 1,   // LABEL_TYPE
  0x0D: 12,  // BT_MAC (12 ASCII hex)
  0x0E: 1,
  0x0F: 1,
  0x15: 3,   // RFID_REMAIN
  0x16: 0,
  0x17: 1,   // BT_CHIP_TYPE
  0x20: 1,
  0x31: 3,   // RFID_LABEL_INFO
  0x35: 1,
  0x3B: 3,
  0x3C: 0,
  0x3E: 1,
  0x3F: 1,
  0x40: 14,  // MATERIAL_ENCRYPT_DETAIL
  0x4B: 2,
  0x5E: 1,
  // 0x99 — variable: payload = [n, ...n bytes]. Driver computes total.
  0x99: (buf) => {
    if (buf.length < 3) return null;
    const n = buf[2];
    return 3 + n;
  },
};

// Battery markers; anything else is a raw 0..100 percentage
const BATTERY_MARKERS = {
  0xA1: { name: 'High',   hint: '~full' },
  0xA2: { name: 'Medium', hint: '~50%' },
  0xA3: { name: 'Low',    hint: '~30%' },
  0xA4: { name: 'Fault',  hint: 'dry/error' },
};

// P-series (P780BT): byte * 5 minutes
const AUTO_POWER_P = {
  0: 'Never', 1: '5 min', 3: '15 min', 6: '30 min',
  12: '1 h', 24: '2 h', 48: '4 h', 96: '8 h',
};

// Hardware byte from LABEL_TYPE response (tag 0x0C). Same bytes are used
// as SET_PAPER_TYPE arguments: setPaperType enum 0→0x0B, 1/2→0x0A,
// 3→0x26, 4→0x4E.
const LABEL_TYPE_MAP = {
  0x0A: 'Gap',
  0x0B: 'Continuous',
  0x26: 'Black mark',
  0x4E: 'Other',
};

// Material detail UI enum (from PerformanceShareTemplate.java et al.).
// The `materialPaperType` byte in tag 0x40 uses this coding, NOT the raw
// hardware byte. 0=连续纸 continuous, 1/2=间隙纸 gap, 3=黑标纸 black mark,
// 4=黑标卡纸 black-mark card.
const PAPER_TYPE_MAP = {
  0: 'Continuous',
  1: 'Gap',
  2: 'Gap',
  3: 'Black mark',
  4: 'Black mark card',
};

// Cover type on P780BT. The app only reacts to `== 1` (transparent film
// → mirrored print). Other values are observed but undocumented.
const COVER_TYPE_MAP = {
  0: 'Normal',
  1: 'Transparent film (mirror print)',
};

// From RibbonColorUtils.java
const FONT_COLOR_MAP = {
  1: '#FEFEFE', 2: '#2D2926', 3: '#E73C3E', 4: '#FDDA25',
  5: '#9EA2A2', 6: '#84764D', 7: '#0077CE', 8: '#00892F', 9: '#696158',
};
const BG_COLOR_MAP = {
  1: '#FEFEFE', 2: '#FFAA4D', 3: '#E6BEDD', 4: '#2D2926',
  5: '#E73C3E', 6: '#FDDA25', 7: '#84764D', 8: '#0077CF', 9: '#00892F',
  10: '#EFF8FA', 11: '#EFF8FA', 12: '#696158', 13: '#C7B2DE', 14: '#674230',
};
const COLOR_NAMES = {
  '#FEFEFE': 'white', '#2D2926': 'black', '#E73C3E': 'red', '#FDDA25': 'yellow',
  '#9EA2A2': 'gray', '#84764D': 'olive', '#0077CE': 'blue', '#0077CF': 'blue',
  '#00892F': 'green', '#696158': 'dark gray', '#FFAA4D': 'orange',
  '#E6BEDD': 'pink', '#EFF8FA': 'off-white', '#C7B2DE': 'lavender',
  '#674230': 'dark brown',
};

// ---------- Raster constants ----------

// Designer renders directly at the printer's native effective DPI (180
// for P780BT, confirmed from PrinterTypeChecker.java in the reference
// app). Rendering WYSIWYG at printer resolution eliminates the scale
// mismatch and lets the raster pipeline stay a pure 1:1 pass-through.
const DPI = 180;

// Vertical shift of the raster along the tape-WIDTH axis, in pixels.
// Positive = shift content DOWN on the tape (toward the bottom edge,
// away from the print head's column-0 edge). At 180 dpi, 1 px ≈ 0.14
// mm; current 2 px ≈ 0.28 mm down.
const PRINT_VERTICAL_SHIFT_PX = 2;

// Optional fixed shift of the whole raster along the feed axis, in
// pixels (positive = toward the CUT edge / designer LEFT). At 180 dpi,
// 4 px ≈ 0.5 mm leftward nudge to center content on the tape.
const PRINT_FEED_SHIFT_PX = 4;

// ---------- Utilities ----------

const hex = b => b.toString(16).padStart(2, '0');
const hexStr = arr => Array.from(arr, hex).join(' ');

function asciiDecode(bytes) {
  return new TextDecoder('ascii').decode(new Uint8Array(bytes));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Frame decoder (pure: in → out, no DOM) ----------

function decodeFrame(tag, payload) {
  const p = payload;

  if (tag === 0x03) {
    const v = p[0] || 0;
    const map = { 0xA8: 'Normal', 0xA9: 'Overheat' };
    return { fields: { hot_state: map[v] || `Unknown 0x${hex(v)}` } };
  }
  if (tag === 0x04) {
    const v = p[0] || 0;
    if (BATTERY_MARKERS[v]) {
      const m = BATTERY_MARKERS[v];
      return { fields: { battery: `${m.name} (${m.hint})` }, batteryMarker: v };
    }
    // P780BT firmware quirk: when fully charged (or on AC), the printer
    // replies with 0x00 instead of a real percentage. A 0% battery
    // would have shut the printer down before it could answer, so it's
    // safe to treat 0x00 as "full" and light the gauge green.
    if (v === 0) return { fields: { battery: '100%' }, batteryPct: 100 };
    return { fields: { battery: `${v}%` }, batteryPct: v };
  }
  if (tag === 0x05) {
    const v = p[0] || 0;
    const map = { 0x98: 'Closed', 0x99: 'Open' };
    return { fields: { cover_state: map[v] || `Unknown 0x${hex(v)}` } };
  }
  if (tag === 0x06) {
    const v = p[0] || 0;
    if (v === 0x88) return { fields: { paper_state: 'No paper' } };
    if (v === 0x89) return { fields: { paper_state: 'OK' } };
    return { fields: { paper_state: `Unknown (0x${hex(v)})` } };
  }
  if (tag === 0x07) {
    if (p.length >= 3) return { fields: { firmware_version: `${p[0]}.${p[1]}.${p[2]}` } };
    return { fields: { firmware_version: hexStr(p) } };
  }
  if (tag === 0x08) {
    const filt = p.map(b =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) ? b : 0x38);
    return { fields: { serial_number: asciiDecode(filt) } };
  }
  if (tag === 0x09) {
    const v = p[0] ?? 0;
    const human = AUTO_POWER_P[v] ?? (v === 0 ? 'Never' : `${v * 5} min (raw ${v})`);
    return { fields: { auto_power_time: `${human}  [byte=${v}]` } };
  }
  if (tag === 0x0C) {
    const v = p[0] || 0;
    return { fields: { label_type: LABEL_TYPE_MAP[v] || `Other (0x${hex(v)})` } };
  }
  if (tag === 0x0D) {
    // BT_MAC: 12 ASCII hex → "XX:XX:XX:XX:XX:XX"
    const s = asciiDecode(p);
    if (s.length === 12) {
      const mac = s.match(/.{2}/g).join(':');
      return { fields: { bt_mac: mac } };
    }
    return { fields: { bt_mac: s } };
  }
  if (tag === 0x15 && p.length >= 3) {
    const rfid = (p[1] << 8) | p[2];
    const kind = ({ 0: 'carbon_belt', 1: 'paper', 2: 'ribbon' })[p[0]] || `type${p[0]}`;
    return { fields: { rfid_remain: `${kind} count=${rfid}` } };
  }
  if (tag === 0x17) {
    const v = p[0] || 0;
    const jerry = [3, 7, 8].includes(v);
    return { fields: { bt_chip_type: `0x${hex(v)} (${jerry ? 'Jerry/JieLi' : 'Other'})` } };
  }
  if (tag === 0x31 && p.length >= 3) {
    const rfid = (p[1] << 8) | p[2];
    return { fields: { rfid_label_info: `type=${p[0]} id=${String(rfid).padStart(5, '0')}` } };
  }
  if (tag === 0x35) {
    const v = p[0] || 0;
    return { fields: { charge_mode: v === 2 ? 'Charging' : `Not charging (0x${hex(v)})` } };
  }
  if (tag === 0x3F) {
    const v = p[0] || 0;
    return { fields: { material_hint: `ERROR 0x${hex(v)}` } };
  }
  if (tag === 0x40 && p.length >= 14) {
    const rfid    = (p[0] << 8) | p[1];
    const cat     = p[2];
    const baseC   = p[4];
    const textC   = p[5];
    const cover   = p[6];
    const paper   = p[7];
    const width   = p[12];
    const length_ = p[13];
    const bgHex = BG_COLOR_MAP[baseC] || null;
    const fgHex = FONT_COLOR_MAP[textC] || null;
    const empty = rfid === 0 && width === 0 && length_ === 0;
    return {
      fields: {
        material_rfid: empty ? '—' : String(rfid).padStart(5, '0'),
        material_cat: cat,
        material_paper: PAPER_TYPE_MAP[paper] ?? `code ${paper}`,
        material_cover: COVER_TYPE_MAP[cover] ?? `Other (code ${cover})`,
        material_size:
          (width === 0 && length_ === 0) ? '—'
            : length_ === 0 ? `${width} mm`
            : width === 0  ? `${length_} mm`
            : `${width} × ${length_} mm`,
        material_bg: bgHex ? `${bgHex} (${COLOR_NAMES[bgHex] || '?'})` : `code ${baseC}`,
        material_fg: fgHex ? `${fgHex} (${COLOR_NAMES[fgHex] || '?'})` : `code ${textC}`,
      },
      swatches: { material_bg: bgHex, material_fg: fgHex },
      materialEmpty: empty,
      cartridgeWidthMm: empty ? null : (width || null),
    };
  }
  if (tag === 0x99) {
    if (p.length < 1) return { fields: { consumables_uid: 'Empty' } };
    const n = p[0];
    const data = p.slice(1, 1 + n);
    if (n === 0) return { fields: { consumables_uid: 'Not available' } };
    return { fields: { consumables_uid: Array.from(data, hex).join('').toUpperCase() } };
  }

  return { fields: { [`tag_0x${hex(tag)}`]: hexStr(p) } };
}

// ---------- Raster helpers (pure functions) ----------

function canvasToMonoBytes(canvas, method = 'threshold', threshold = 128) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;

  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; p < src.length; p += 4, i++) {
    const r = src[p], g = src[p + 1], b = src[p + 2], a = src[p + 3];
    if (a < 128) { lum[i] = 255; continue; }
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const out = new Uint8Array(w * h);
  if (method === 'floyd') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = lum[i];
        const nw = old < threshold ? 0 : 255;
        out[i] = nw === 0 ? 1 : 0;
        const err = old - nw;
        if (x + 1 < w) lum[i + 1] += err * 7 / 16;
        if (y + 1 < h) {
          if (x > 0)     lum[(y + 1) * w + x - 1] += err * 3 / 16;
                         lum[(y + 1) * w + x]     += err * 5 / 16;
          if (x + 1 < w) lum[(y + 1) * w + x + 1] += err * 1 / 16;
        }
      }
    }
  } else if (method === 'atkinson') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = lum[i];
        const nw = old < threshold ? 0 : 255;
        out[i] = nw === 0 ? 1 : 0;
        const err = (old - nw) / 8;
        const add = (xx, yy) => { if (xx >= 0 && xx < w && yy >= 0 && yy < h) lum[yy * w + xx] += err; };
        add(x + 1, y); add(x + 2, y);
        add(x - 1, y + 1); add(x, y + 1); add(x + 1, y + 1);
        add(x, y + 2);
      }
    }
  } else {
    for (let i = 0; i < lum.length; i++) out[i] = lum[i] < threshold ? 1 : 0;
  }
  return { mono: out, w, h };
}

/**
 * Pack a 1bpp raster for P780BT. The printer expects data oriented so
 * that each RASTER ROW is one scan line across the print head, and
 * successive rows advance the tape one pixel along the feed direction.
 * Our designer canvas has width = feed direction and height = tape-width
 * direction, so we rotate 90° before packing.
 *
 * Canvas LEFT becomes the FIRST printed row, so when the user reads
 * the tape with the just-cut end on their LEFT and the first-out
 * (leading) end on their RIGHT, content orientation matches the
 * designer.
 *
 * Header layout (4 bytes, LE each):
 *   [0..1] widthBytes = ceil(new_w / 8) = ceil(h / 8)
 *   [2..3] height     = new_h = w
 */
function monoToRaster(mono, w, h) {
  const newW = h;
  const newH = w;
  const widthBytes = Math.ceil(newW / 8);
  const out = new Uint8Array(4 + widthBytes * newH);
  out[0] = widthBytes & 0xFF;
  out[1] = (widthBytes >> 8) & 0xFF;
  out[2] = newH & 0xFF;
  out[3] = (newH >> 8) & 0xFF;

  let idx = 4;
  // Rotated pixel (nx, ny) ← original (ox, oy)
  //   ox = (w - 1) - ny + PRINT_FEED_SHIFT_PX
  //     Canvas right edge → raster row 0 (printed first). Positive
  //     PRINT_FEED_SHIFT_PX nudges the whole image toward the CUT edge
  //     (designer LEFT).
  //   oy = nx - PRINT_VERTICAL_SHIFT_PX
  //     Positive PRINT_VERTICAL_SHIFT_PX shifts content DOWN on the
  //     tape (first few tape columns at nx=0..SHIFT-1 read oy<0 → blank).
  for (let ny = 0; ny < newH; ny++) {
    const ox = (w - 1) - ny + PRINT_FEED_SHIFT_PX;
    for (let bi = 0; bi < widthBytes; bi++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const nx = bi * 8 + bit;
        if (nx >= newW) continue;
        const oy = nx - PRINT_VERTICAL_SHIFT_PX;
        if (ox >= 0 && ox < w && oy >= 0 && oy < h && mono[oy * w + ox]) {
          byte |= (1 << (7 - bit));
        }
      }
      out[idx++] = byte;
    }
  }
  return out;
}

// ---------- The driver ----------

export class P780BTDriver extends Driver {
  constructor() {
    super();
    // State that lives for the duration of one print job, set up by
    // `beginJob` and torn down by `endJob`. `_rastersInJob` counts how
    // many rasters have been sent during the job so `sendRaster` can
    // decide whether to emit a PRINT_PAUSE before the next one.
    this._jobActive = false;
    this._rastersInJob = 0;
  }

  // ---------- Metadata ----------

  get model() { return 'P780BT'; }
  get dpi() { return DPI; }

  get commands()           { return GET_COMMANDS; }
  get settings()           { return SET_COMMANDS; }
  get actions()            { return ACTIONS; }
  get paperTypeOptions()   { return PAPER_TYPE_OPTIONS; }
  get autoPowerOptions()   { return AUTO_POWER_OPTIONS; }

  // Expose the raw protocol bytes so the UI's Advanced log / decoders
  // can describe them without hard-coding values up there too.
  get requestPrefix() { return REQ_PREFIX.slice(); }

  // ---------- Parser + frame decoding ----------

  _createParser() {
    return new ResponseParser({
      prefix:  RESP_PREFIX,
      respLen: RESP_LEN,
      onFrame: (tag, payload) => this._onFrame(tag, payload),
      onError: (msg) => this._log('error', msg),
    });
  }

  _decodeFrame(tag, payload) {
    return decodeFrame(tag, payload);
  }

  // ---------- Identity check ----------

  /**
   * Probe the newly opened port for a P780BT-family printer by asking
   * for the serial number (cmd 0x09 → tag 0x08) and validating the
   * response looks like the expected 15 ASCII-alphanumeric payload.
   *
   * macOS BT-SPP links need a small settle period after open and may
   * need a wake-up ESC @ before the first query — we mimic the vendor
   * Android app's initConnectInfo preamble, then retry a few times.
   * Each step logs so we can diagnose reconnect failures from the
   * Advanced panel.
   *
   * Returns `true` on success, or `{ ok:false, reason }` on failure.
   */
  async _verifyIdentity() {
    const INITIAL_SETTLE_MS = 400;
    const TIMEOUT_MS        = 3000;
    const INTER_ATTEMPT_MS  = 500;
    const MAX_ATTEMPTS      = 4;

    try {
      this._log('info', `Identity check: settling for ${INITIAL_SETTLE_MS}ms…`);
      await sleep(INITIAL_SETTLE_MS);

      // Wake the printer before the first query. After a previous
      // session ended mid-print or with an uncut label, the firmware
      // can stay in a "waiting for more data" state and silently drop
      // status queries. ESC @ (1B 40, INIT_PRINTER) resets that
      // without side-effects on a healthy printer.
      try {
        this._log('info', 'Identity check: sending INIT_PRINTER (1B 40) to reset state…');
        await this.send([0x1B, 0x40]);
        await sleep(200);
      } catch (wakeErr) {
        this._log('error', `Identity check: INIT_PRINTER send failed: ${wakeErr.message || wakeErr}`);
      }

      let payload = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !payload; attempt++) {
        this._log('info', `Identity check: attempt ${attempt}/${MAX_ATTEMPTS} — sending SN query, waiting up to ${TIMEOUT_MS}ms…`);
        const started = performance.now();
        const pending = this.waitForTag(0x08, TIMEOUT_MS).catch(() => null);
        try {
          await this.send([...REQ_PREFIX, 0x09]);
        } catch (sendErr) {
          this._log('error', `Identity check: send failed on attempt ${attempt}: ${sendErr.message || sendErr}`);
          await pending;
          if (attempt < MAX_ATTEMPTS) await sleep(INTER_ATTEMPT_MS);
          continue;
        }
        payload = await pending;
        const elapsed = Math.round(performance.now() - started);
        if (payload) {
          this._log('info', `Identity check: SN arrived after ${elapsed}ms on attempt ${attempt}.`);
        } else {
          this._log('error', `Identity check: no SN after ${elapsed}ms on attempt ${attempt}.`);
          if (attempt < MAX_ATTEMPTS) {
            if (attempt % 2 === 0) {
              try {
                this._log('info', 'Identity check: re-sending INIT_PRINTER before next attempt…');
                await this.send([0x1B, 0x40]);
                await sleep(200);
              } catch {}
            }
            await sleep(INTER_ATTEMPT_MS);
          }
        }
      }

      if (!payload) {
        return { ok: false, reason: 'This serial port did not answer our identity check — not a P780BT-family printer.' };
      }
      if (payload.length < 8) {
        return { ok: false, reason: 'The device answered with an unexpected frame. Not supported.' };
      }

      // Decode SN + look it up in the vendor PrinterInfo.getName4Sn()
      // table. Three outcomes:
      //
      //   1. SN prefix maps to the model we implement (P780 family) →
      //      accept. This is the hot path.
      //   2. SN prefix maps to a DIFFERENT known Aimotech model (e.g.
      //      D480, Q30, M108) — the port does speak the protocol, but
      //      our driver wasn't built for this model. Reject with the
      //      specific model name so the user knows WHY.
      //   3. SN prefix is not in the vendor table at all → it's either
      //      a mislabelled port, a generic BT-SPP endpoint, or an
      //      unrelated device. Reject with a generic message.
      //
      // The old path was a heuristic "≥60% of the payload is ASCII
      // alphanumerics"; the registry-based check is stricter AND more
      // informative (tells the user they got a D480 instead of saying
      // "not a P780BT").
      const snAscii = asciiDecode(payload.filter(b =>
        (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A)
      ));
      const detected = detectDriverBySn(snAscii);

      if (detected.driverId === 'p780bt') {
        this._log('info', `Device verified: ${detected.vendorModel} (SN ${snAscii}).`);
        return true;
      }
      if (detected.vendorModel) {
        // Known Aimotech model, wrong one.
        return {
          ok: false,
          reason:
            `Connected printer is an Aimotech ${detected.vendorModel} ` +
            `(serial ${snAscii}, prefix ${detected.prefix}). ` +
            `This app currently only supports P780BT — a driver for ` +
            `${detected.vendorModel} hasn't been written yet.`,
        };
      }
      // Unknown prefix — not an Aimotech-family device.
      return {
        ok: false,
        reason:
          `The device returned serial number "${snAscii}", which doesn't ` +
          `match any known Aimotech printer model. ` +
          `Most likely you picked the wrong entry in the Bluetooth picker.`,
      };
    } catch (e) {
      return { ok: false, reason: 'Identity check failed: ' + (e.message || e) };
    }
  }

  // ---------- High-level commands ----------

  async sendCommand(cmd) {
    await this.send([...REQ_PREFIX, cmd]);
  }

  async readAll() {
    for (const c of GET_COMMANDS) {
      try {
        await this.send([...REQ_PREFIX, c.cmd]);
        await sleep(150);
      } catch (e) {
        this._log('error', 'TX fail: ' + e.message);
        return;
      }
    }
  }

  async applySetting(name, valueByte) {
    const entry = SET_COMMANDS[name];
    if (!entry) {
      this._log('error', `unknown SET command: ${name}`);
      return false;
    }
    const packet = [...entry.header, valueByte & 0xFF];
    try {
      await this.send(packet);
      this._log('info', `SET ${name} = ${valueByte} (0x${hex(valueByte)})`);
      return true;
    } catch (e) {
      this._log('error', `SET ${name} fail: ${e.message}`);
      return false;
    }
  }

  async applyAction(name) {
    const act = ACTIONS[name];
    if (!act) {
      this._log('error', `unknown action: ${name}`);
      return false;
    }
    try {
      await this.send(act.bytes);
      this._log('info', `ACTION ${name} → [${hexStr(act.bytes)}]`);
      return true;
    } catch (e) {
      this._log('error', `${name} fail: ${e.message}`);
      return false;
    }
  }

  /** Query paper state (cmd 0x11) and return the raw payload byte, or
   *  null on timeout. Caller typically compares against 0x88 (no paper)
   *  and 0x89 (OK). */
  async queryPaperState() {
    try {
      const payloadPromise = this.waitForTag(0x06, 2500);
      await this.send([0x1F, 0x11, 0x11]);
      const payload = await payloadPromise;
      return payload[0] ?? null;
    } catch {
      return null;
    }
  }

  // ---------- Print pipeline ----------

  /**
   * Convert a designer canvas to a P780BT raster blob (width/height
   * header + packed 1bpp rows). Pure function — no I/O. UI can call
   * this, inspect the byte length, show it in a progress UI, then
   * hand the bytes to `sendRaster`.
   *
   * `opts.dither` selects the dither algorithm:
   *   'threshold' (default) | 'floyd' | 'atkinson'
   */
  rasterize(canvas, opts = {}) {
    const method = opts.dither || 'threshold';
    const { mono, w, h } = canvasToMonoBytes(canvas, method);
    return monoToRaster(mono, w, h);
  }

  /**
   * Open a print job. On P780BT that means:
   *   - (optional) set paper type to Continuous so the firmware
   *     doesn't look for gap/mark sensors between rasters
   *   - send INIT_PRINTER to reset parameters before the run
   *
   * Must be called once before any `sendRaster`, and matched with a
   * later `endJob()` call even if sendRaster errors out.
   */
  async beginJob({ continuous = false } = {}) {
    if (this._jobActive) {
      this._log('error', 'beginJob: job already active — forgot to call endJob?');
    }
    const head = [];
    if (continuous) head.push(0x1F, 0x11, 0x0B, 0x0B);  // PAPER_TYPE = Continuous
    head.push(0x1B, 0x40);                              // INIT_PRINTER
    await this.send(head);
    await sleep(40);
    this._jobActive = true;
    this._rastersInJob = 0;
  }

  /**
   * Stream one raster to the printer. Sends PRINT_IMAGE header + the
   * packed raster in ~1 KB chunks to avoid overrunning the firmware's
   * internal buffer. If this is not the first raster in the current
   * job, a PRINT_PAUSE is sent first so the head finishes the previous
   * label before starting the next.
   *
   * `opts.onProgress(bytesDone, bytesTotal)` is called after each chunk
   * so the UI can animate a per-raster progress bar. The global
   * per-label progress (i of N) is computed by the caller — one label
   * = one `sendRaster` call (repeated for multi-copy prints).
   *
   * `opts.silent` suppresses the 'tx' event for chunk writes (default
   * true) — only the PRINT_PAUSE / PRINT_PAGER bracket gets logged so
   * the Advanced panel stays readable.
   */
  async sendRaster(raster, opts = {}) {
    const { onProgress, silent = true } = opts;
    const RASTER_CHUNK    = 1024;   // bytes per serial write
    const INTER_CHUNK_MS  = 5;      // breathing room between chunks
    const INTER_LABEL_MS  = 180;    // let the head finish a label before the next

    if (!this._jobActive) {
      this._log('error', 'sendRaster called without beginJob — sending anyway, but timing may be off.');
    }

    if (this._rastersInJob > 0) {
      await this.send([0x1F, 0x11, 0x3C]);  // PRINT_PAUSE
      await sleep(INTER_LABEL_MS);
    }

    const prefixed = new Uint8Array(4 + raster.length);
    prefixed[0] = 0x1D; prefixed[1] = 0x76; prefixed[2] = 0x30; prefixed[3] = 0x00;
    prefixed.set(raster, 4);

    for (let off = 0; off < prefixed.length; off += RASTER_CHUNK) {
      const end = Math.min(off + RASTER_CHUNK, prefixed.length);
      await this.send(prefixed.subarray(off, end), silent);
      if (typeof onProgress === 'function') onProgress(end, prefixed.length);
      if (end < prefixed.length) await sleep(INTER_CHUNK_MS);
    }

    this._rastersInJob++;
  }

  /** Close the print job with PRINT_PAGER so the printer finalises the
   *  last label. Safe to call even if beginJob was never called. */
  async endJob() {
    try {
      await this.send([0x1B, 0x64, 0x00]);  // PRINT_PAGER
    } finally {
      this._jobActive = false;
      this._rastersInJob = 0;
    }
  }
}

// Re-export constants that some UI code wants to read directly (e.g.
// to build a "supported commands" table). Everything else stays
// encapsulated behind the driver instance.
export const P780BT_CONSTANTS = {
  DPI,
  PRINT_VERTICAL_SHIFT_PX,
  PRINT_FEED_SHIFT_PX,
  REQ_PREFIX,
  RESP_PREFIX,
  GET_COMMANDS,
  SET_COMMANDS,
  ACTIONS,
  RESP_LEN,
  BATTERY_MARKERS,
  AUTO_POWER_P,
  LABEL_TYPE_MAP,
  PAPER_TYPE_MAP,
  COVER_TYPE_MAP,
  FONT_COLOR_MAP,
  BG_COLOR_MAP,
  COLOR_NAMES,
  AUTO_POWER_OPTIONS,
  PAPER_TYPE_OPTIONS,
};
