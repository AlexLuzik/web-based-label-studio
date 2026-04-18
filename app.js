// =====================================================================
//  P780BT Label Printer — single-file front-end
// ---------------------------------------------------------------------
//  Author:   Oleksandr Luzin <https://luzin.cc>
//  Source:   https://luzin.cc
//  License:  MIT
// ---------------------------------------------------------------------
//  This script is the whole app: Web Serial connect flow, protocol
//  decode, status-strip wiring, canvas label designer, element
//  inspector, print queue, templates, and print pipeline. It used to be
//  split across `app.js` + `label_designer.js` that exchanged a handful
//  of globals through `window.*`; collapsing them into one module
//  removes that indirection and keeps the load order deterministic.
//
//  Protocol wire format:
//      Request   1F 11 <cmd>
//      Response  1A <tag> <payload>
//  The printer must be paired in the OS and exposed as a serial port
//  (SPP) before this page can reach it via the Web Serial API.
// =====================================================================

'use strict';

// Physical tape width (in mm) of the cartridge currently loaded in the
// printer, or null when no cartridge is present / not yet read. Set from
// tag 0x40 on every material-detail response; consumed by the designer's
// cartridge-width validation and the mismatch banner.
let currentCartridgeWidthMm = null;

// ---------- Protocol ----------

const REQ_PREFIX = [0x1F, 0x11];
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
  AUTO_POWER:     { header: [0x1B, 0x4E, 0x07] },  // +1 byte, P-series byte*5=min
  PRINT_DENSITY:  { header: [0x1F, 0x11, 0x02] },  // +1 byte
  PRINT_SPEED:    { header: [0x1F, 0x11, 0x23] },  // +1 byte
  LEFT_MARGIN:    { header: [0x1F, 0x11, 0x24] },  // +1 byte
  PAPER_TYPE:     { header: [0x1F, 0x11, 0x0B] },  // +1 byte (0x0A/0x0B/0x26/0x4E)
};

// Safe actions (commands with no argument).
const ACTIONS = {
  INIT_PRINTER:    { bytes: [0x1B, 0x40],       danger: false, label: 'Init Printer',    hint: 'ESC @ — reset parameters' },
  FEED_PAPER:      { bytes: [0x1F, 0x11, 0x32], danger: false, label: 'Feed Paper',      hint: 'advance paper' },
  BACK_PAPER:      { bytes: [0x1F, 0x11, 0x2B], danger: false, label: 'Back Paper',      hint: 'roll paper back' },
  AUTO_LOCATE:     { bytes: [0x1F, 0x11, 0x25], danger: false, label: 'Auto Locate',     hint: 'find gap between labels' },
  PRINT_TEST_PAGE: { bytes: [0x1F, 0x11, 0x27], danger: true,  label: 'Print Test',      hint: 'print a test page' },
  DISCONNECT_BT:   { bytes: [0x1F, 0x11, 0x29], danger: true,  label: 'Disconnect BT',   hint: 'printer will drop the BT connection' },
};

// Allowed auto-power values for P-series and their human-readable labels
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

// Paper type options (see QuinPrinter.setPaperType)
// Set PAPER_TYPE argument bytes (what we send). Derived from QuinPrinter.setPaperType.
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
  0x99: null,
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

// Hardware byte from LABEL_TYPE response (tag 0x0C). Same bytes are used as
// SET_PAPER_TYPE arguments: setPaperType enum 0→0x0B, 1/2→0x0A, 3→0x26, 4→0x4E.
const LABEL_TYPE_MAP = {
  0x0A: 'Gap',
  0x0B: 'Continuous',
  0x26: 'Black mark',
  0x4E: 'Other',
};
// Material detail UI enum (from PerformanceShareTemplate.java et al.). The
// `materialPaperType` byte in tag 0x40 uses this coding, NOT the raw hardware byte.
// 0=连续纸 continuous, 1/2=间隙纸 gap, 3=黑标纸 black mark, 4=黑标卡纸 black-mark card.
const PAPER_TYPE_MAP = {
  0: 'Continuous',
  1: 'Gap',
  2: 'Gap',
  3: 'Black mark',
  4: 'Black mark card',
};
// Cover type on P780BT. The app only reacts to `== 1` (transparent film → mirrored
// print). Other values are observed but undocumented in the client SDK.
const COVER_TYPE_MAP = {
  0: 'Normal',
  1: 'Transparent film (mirror print)',
};

// from RibbonColorUtils.java
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

// ---------- Utilities ----------

const hex = b => b.toString(16).padStart(2, '0');
const hexStr = arr => Array.from(arr, hex).join(' ');

function asciiDecode(bytes) {
  return new TextDecoder('ascii').decode(new Uint8Array(bytes));
}

// ---------- Frame decoder ----------

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
    // replies with 0x00 instead of a real percentage. A 0% battery would
    // have shut the printer down before it could answer at all, so it's
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

// ---------- Stream parser ----------

class ResponseParser {
  constructor(onFrame) {
    this.buf = [];
    this.onFrame = onFrame;
  }
  feed(bytes) {
    for (const b of bytes) this.buf.push(b);
    while (true) {
      const start = this.buf.indexOf(RESP_PREFIX);
      if (start < 0) {
        // No frame prefix anywhere in the buffer — everything inside is
        // orphan bytes that don't belong to a frame. Log them so we can
        // debug silent truncation (e.g. wrong RESP_LEN for some tag).
        if (this.buf.length > 0) {
          logError(`parser: discarding ${this.buf.length} orphan byte(s): ${Array.from(this.buf, b => b.toString(16).padStart(2, '0')).join(' ')}`);
        }
        this.buf.length = 0;
        return;
      }
      if (start > 0) {
        // Bytes before the prefix are orphaned — probably a RESP_LEN too
        // short for some tag above. Log for diagnostics before skipping.
        const discarded = this.buf.slice(0, start);
        logError(`parser: skipping ${discarded.length} byte(s) before next frame: ${Array.from(discarded, b => b.toString(16).padStart(2, '0')).join(' ')}`);
        this.buf.splice(0, start);
      }
      if (this.buf.length < 2) return;
      const tag = this.buf[1];
      const expected = RESP_LEN[tag];

      if (expected === null || expected === undefined) {
        if (tag === 0x99) {
          if (this.buf.length < 3) return;
          const n = this.buf[2];
          const total = 3 + n;
          if (this.buf.length < total) return;
          const payload = this.buf.slice(2, total);
          this.onFrame(tag, payload);
          this.buf.splice(0, total);
          continue;
        }
        // unknown tag — best-effort: assume 1-byte payload
        if (this.buf.length < 3) return;
        const payload = this.buf.slice(2, 3);
        this.onFrame(tag, payload);
        this.buf.splice(0, 3);
        continue;
      }

      const total = 2 + expected;
      if (this.buf.length < total) return;
      const payload = this.buf.slice(2, total);
      this.onFrame(tag, payload);
      this.buf.splice(0, total);
    }
  }
}

// ---------- Serial ----------

class SerialLink {
  constructor(handlers) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;
    this.parser = new ResponseParser((tag, payload) => handlers.onFrame(tag, payload));
    this.handlers = handlers;
  }

  get isOpen() { return !!this.port; }

  async connect() {
    if (!('serial' in navigator)) throw new Error('Web Serial API is not supported');
    const port = await navigator.serial.requestPort({});
    await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.keepReading = true;
    this._readLoop();
    const info = port.getInfo ? port.getInfo() : {};
    this.handlers.onConnected(info);
  }

  async _readLoop() {
    try {
      while (this.keepReading && this.port && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          while (this.keepReading) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && value.length) {
              this.handlers.onRx(value);
              this.parser.feed(value);
            }
          }
        } catch (e) {
          this.handlers.onError(`read: ${e.message}`);
          break;
        } finally {
          try { this.reader.releaseLock(); } catch {}
          this.reader = null;
        }
      }
    } finally {
      await this._cleanup();
      this.handlers.onDisconnected();
    }
  }

  async send(bytes, silent = false) {
    if (!this.writer) throw new Error('not connected');
    await this.writer.write(new Uint8Array(bytes));
    if (!silent) this.handlers.onTx(bytes);
  }

  async disconnect() {
    this.keepReading = false;
    try { if (this.reader) await this.reader.cancel(); } catch {}
    await this._cleanup();
  }

  async _cleanup() {
    try { if (this.writer) { this.writer.releaseLock(); } } catch {}
    this.writer = null;
    try { if (this.port) await this.port.close(); } catch {}
    this.port = null;
  }
}

// ---------- UI ----------

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const ui = {
  statusBadge: $('#statusBadge'),
  statusText: $('#statusText'),
  // Connect CTA lives in the hero; Disconnect is a separate button that
  // only appears in the navbar after a successful connection.
  btnConnect: $('#btnConnect'),
  btnConnectText: $('#btnConnectText'),
  btnDisconnect: $('#btnDisconnect'),
  btnReadAll: $('#btnReadAll'),
  btnClearLog: $('#btnClearLog'),
  chkAutoscroll: $('#chkAutoscroll'),
  cmdButtons: $('#cmdButtons'),
  cmdCount: $('#cmdCount'),
  log: $('#log'),
  unsupported: $('#unsupportedBanner'),
  materialHint: $('#materialHint'),
  batteryBar: $('#batteryBar'),
};

function setStatus(state, text) {
  const map = {
    disconnected: 'text-bg-secondary',
    connecting:   'text-bg-warning',
    connected:    'text-bg-success',
    error:        'text-bg-danger',
  };
  ui.statusBadge.className = `badge ${map[state] || 'text-bg-secondary'}`;
  ui.statusBadge.innerHTML = `<i class="bi bi-circle-fill me-1"></i><span id="statusText">${text}</span>`;
  updateConnectButton(state);
}

/**
 * Sync the connect button's label, icon and visual style with the current
 * connection state. Called from setStatus so every transition keeps the
 * button in lock-step with the badge.
 */
/**
 * Sync the hero Connect CTA with the current connection state.
 * `#btnDisconnect` in the navbar is purely fixed UI — it's only visible
 * while connected (via `.connected-only`) and always reads "Disconnect",
 * so it does not need per-state updates.
 */
function updateConnectButton(state) {
  const btn = ui.btnConnect;
  const icon = document.getElementById('btnConnectIcon');
  const txt = ui.btnConnectText;
  if (!btn || !txt) return;
  btn.classList.remove('disabled');
  if (state === 'connecting') {
    if (icon) icon.className = 'bi bi-bluetooth me-1';
    txt.textContent = 'Connecting\u2026';
    btn.classList.add('disabled');
  } else {
    // disconnected | error | connected — hero is hidden when connected,
    // but reset the label so the text is correct if the user disconnects
    // and the hero comes back into view.
    if (icon) icon.className = 'bi bi-bluetooth me-1';
    txt.textContent = 'Connect printer';
  }
}

function logLine(kind, text) {
  const ts = new Date().toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.className = `log-line log-${kind}`;
  line.innerHTML = `<span class="log-ts">[${ts}]</span> ${text}`;
  ui.log.appendChild(line);
  if (ui.chkAutoscroll.checked) ui.log.scrollTop = ui.log.scrollHeight;
  // Cap at 500 lines to keep the DOM small
  while (ui.log.childElementCount > 500) ui.log.removeChild(ui.log.firstChild);
}

function setField(name, value, extra) {
  const els = $$(`[data-field="${name}"]`);
  for (const el of els) {
    el.textContent = value;
    el.classList.remove('flash');
    void el.offsetWidth; // restart animation
    el.classList.add('flash');
  }
  // color swatch
  if (extra && extra.swatchColor !== undefined) {
    const sw = document.querySelector(`[data-swatch="${name}"]`);
    if (sw) sw.style.background = extra.swatchColor || 'transparent';
  }
  // P0.6 — the status strip shows shimmer skeletons while READ ALL is in
  // flight. Once we land either the SN or the battery (whichever comes first)
  // with a non-placeholder value, drop the shimmer so live values show.
  if ((name === 'serial_number' || name === 'battery' || name === 'battery_level')
      && value && String(value).trim() && String(value).trim() !== '—') {
    const strip = document.getElementById('statusStrip');
    if (strip) {
      strip.classList.remove('is-loading');
      strip.removeAttribute('aria-busy');
    }
  }
}

// Build the command-button list
function buildCommandButtons() {
  ui.cmdButtons.innerHTML = '';
  for (const c of GET_COMMANDS) {
    const b = document.createElement('button');
    b.className = 'btn btn-outline-secondary';
    b.disabled = true;
    b.dataset.cmd = c.cmd;
    b.innerHTML = `
      <span>
        ${c.needsCartridge ? '<i class="bi bi-upc-scan me-1 text-warning" title="requires cartridge"></i>' : ''}
        ${c.name}
      </span>
      <span class="cmd-hex">0x${hex(c.cmd)}</span>`;
    b.addEventListener('click', () => sendCommand(c.cmd));
    ui.cmdButtons.appendChild(b);
  }
  ui.cmdCount.textContent = String(GET_COMMANDS.length);
}

function setButtonsEnabled(enabled) {
  $$('#cmdButtons .btn').forEach(b => b.disabled = !enabled);
  ui.btnReadAll.disabled = !enabled;
  // Write controls are enabled only when both the connection is open and write mode is on
  const writeOn = enabled && isWriteUnlocked();
  $$('[data-write-control]').forEach(el => el.disabled = !writeOn);
}

function buildSettingsUi() {
  // Auto power — select
  const apSel = document.querySelector('#selAutoPower');
  if (apSel) {
    apSel.innerHTML = AUTO_POWER_OPTIONS.map(o =>
      `<option value="${o.value}">${o.label}</option>`).join('');
  }
  // Paper type — select
  const ptSel = document.querySelector('#selPaperType');
  if (ptSel) {
    ptSel.innerHTML = PAPER_TYPE_OPTIONS.map(o =>
      `<option value="${o.value}">${o.label}</option>`).join('');
  }

  // Wire up the Apply buttons
  document.querySelector('#btnApplyAutoPower')?.addEventListener('click', () => {
    const v = parseInt(document.querySelector('#selAutoPower').value, 10);
    applySetting('AUTO_POWER', v);
  });
  document.querySelector('#btnApplyPaperType')?.addEventListener('click', () => {
    const v = parseInt(document.querySelector('#selPaperType').value, 10);
    applySetting('PAPER_TYPE', v);
  });
  document.querySelector('#btnApplyDensity')?.addEventListener('click', () => {
    const v = parseInt(document.querySelector('#inpDensity').value, 10);
    if (isNaN(v) || v < 1 || v > 10) { alert('Density: 1–10'); return; }
    applySetting('PRINT_DENSITY', v);
  });
  document.querySelector('#btnApplySpeed')?.addEventListener('click', () => {
    const v = parseInt(document.querySelector('#inpSpeed').value, 10);
    if (isNaN(v) || v < 1 || v > 5) { alert('Speed: 1–5'); return; }
    applySetting('PRINT_SPEED', v);
  });
  document.querySelector('#btnApplyMargin')?.addEventListener('click', () => {
    const v = parseInt(document.querySelector('#inpMargin').value, 10);
    if (isNaN(v) || v < 0 || v > 255) { alert('Margin: 0–255'); return; }
    applySetting('LEFT_MARGIN', v);
  });

  // Actions — build the buttons dynamically
  const actBox = document.querySelector('#actionButtons');
  if (actBox) {
    actBox.innerHTML = '';
    for (const [name, a] of Object.entries(ACTIONS)) {
      const btn = document.createElement('button');
      btn.className = `btn ${a.danger ? 'btn-outline-danger' : 'btn-outline-secondary'} btn-sm`;
      btn.disabled = true;
      btn.dataset.writeControl = '';
      btn.title = a.hint;
      btn.innerHTML = `<i class="bi bi-lightning-charge me-1"></i>${a.label}`;
      btn.addEventListener('click', () => applyAction(name));
      actBox.appendChild(btn);
    }
  }

  // Write mode toggle
  const sw = document.querySelector('#writeMode');
  if (sw) {
    const applyTuningVisibility = () => {
      const section = document.getElementById('expertTuningSection');
      if (section) section.hidden = !sw.checked;
    };
    applyTuningVisibility();
    sw.addEventListener('change', () => {
      // Refresh the enabled state of write controls
      const portOpen = link.isOpen;
      $$('[data-write-control]').forEach(el => el.disabled = !(portOpen && sw.checked));
      applyTuningVisibility();
      logLine('info', `Write mode: ${sw.checked ? 'ON' : 'OFF'}`);
    });
  }
}

// ---------- Exchange logic ----------

// Global helpers for label_designer.js
// Shared across the merged script so other modules (designer, queue) can
// funnel diagnostic lines into the same Advanced panel.
const logInfo  = (text) => logLine('info', text);
const logError = (text) => logLine('error', text);

const link = new SerialLink({
  onConnected: (info) => {
    setStatus('connected', info.usbProductId ? `USB ${info.usbProductId}` : 'connected');
    setButtonsEnabled(true);
    // Show shimmer skeletons in the status strip until READ ALL populates it.
    const strip = document.getElementById('statusStrip');
    if (strip) {
      strip.classList.add('is-loading');
      strip.setAttribute('aria-busy', 'true');
    }
    logLine('info', 'Connected. Verifying device…');
    // Verify this is a P780BT-family printer before we start pumping commands at it.
    verifyPrinterIdentity()
      .then(ok => {
        if (!ok) return;
        // Auto-refresh key printer data so the status strip and cards populate
        // immediately instead of showing "—" until the user clicks READ ALL.
        readAll().catch(() => {});
      })
      .catch(() => {});
  },
  onDisconnected: () => {
    setStatus('disconnected', 'disconnected');
    setButtonsEnabled(false);
    // P1.18 — clean the exchange log on disconnect so a fresh session
    // starts with a blank scrollback instead of accumulating forever.
    // `cmdCount` reflects the number of available GET_COMMANDS (a static count
    // set in buildCommandButtons), not a per-session counter — leave it alone.
    if (ui.log) ui.log.innerHTML = '';
    // Remove the shimmer just in case we disconnected before READ ALL.
    const strip = document.getElementById('statusStrip');
    if (strip) {
      strip.classList.remove('is-loading');
      strip.removeAttribute('aria-busy');
    }
    logLine('info', 'Disconnected');
  },
  onTx: (bytes) => logLine('tx', `TX: ${hexStr(bytes)}`),
  onRx: (bytes) => logLine('rx', `RX: ${hexStr(bytes)}`),
  onFrame: (tag, payload) => handleFrame(tag, payload),
  onError: (msg) => {
    logLine('error', 'ERROR: ' + msg);
    setStatus('error', 'error');
  },
});

// `link` is shared directly with the designer / queue sections below —
// no window-namespacing needed now that everything lives in one script.

function handleFrame(tag, payload) {
  const res = decodeFrame(tag, payload);
  const fieldsStr = Object.entries(res.fields).map(([k, v]) => `${k}=${v}`).join('  ');
  logLine('frame', `FRAME tag=0x${hex(tag)} ${fieldsStr}  (payload: ${hexStr(payload) || '—'})`);

  for (const [k, v] of Object.entries(res.fields)) setField(k, v);

  if (res.swatches) {
    for (const [k, color] of Object.entries(res.swatches)) {
      // Some swatches (e.g. material_bg) are rendered in TWO places: the
      // compact strip at the top of the page AND the Paper & cartridge
      // card on the Printer tab. querySelector only grabs the first one,
      // which is why the card's background swatch stayed empty — use
      // querySelectorAll so every occurrence is tinted.
      const els = document.querySelectorAll(`[data-swatch="${k}"]`);
      els.forEach(sw => { sw.style.background = color || 'transparent'; });
    }
  }
  if (res.batteryPct !== undefined) {
    const pct = Math.max(0, Math.min(100, res.batteryPct));
    ui.batteryBar.style.width = `${pct}%`;
    ui.batteryBar.classList.remove('bg-success', 'bg-warning', 'bg-danger');
    ui.batteryBar.classList.add(pct > 50 ? 'bg-success' : pct > 20 ? 'bg-warning' : 'bg-danger');
  }
  if (res.batteryMarker !== undefined) {
    const pct = { 0xA1: 90, 0xA2: 50, 0xA3: 20, 0xA4: 0 }[res.batteryMarker] ?? 0;
    ui.batteryBar.style.width = `${pct}%`;
    ui.batteryBar.classList.remove('bg-success', 'bg-warning', 'bg-danger');
    ui.batteryBar.classList.add(pct > 50 ? 'bg-success' : pct > 20 ? 'bg-warning' : 'bg-danger');
  }
  if (tag === 0x40) {
    ui.materialHint.classList.remove('text-bg-secondary', 'text-bg-success', 'text-bg-warning');
    if (res.materialEmpty) {
      ui.materialHint.textContent = 'cartridge not detected';
      ui.materialHint.classList.add('text-bg-warning');
      currentCartridgeWidthMm = null;
    } else {
      ui.materialHint.textContent = 'read';
      ui.materialHint.classList.add('text-bg-success');
      // Expose the physical tape width so the Label Designer can validate
      // canvas height before queuing a print job.
      currentCartridgeWidthMm = payload[12] || null;
    }
    // P0.2 — re-evaluate the cartridge-mismatch alert after every read.
    if (typeof updateCartridgeMismatch === 'function') updateCartridgeMismatch();
  }

  // Reflect live printer values into the corresponding Settings dropdowns.
  // Helper: set select value without losing focus or blocking a user who is
  // currently typing/picking in it.
  const setSelectIfIdle = (sel, value) => {
    if (!sel) return;
    if (document.activeElement === sel) return;
    // Only set if the value exists as an option
    const opt = Array.from(sel.options).find(o => String(o.value) === String(value));
    if (opt) sel.value = String(value);
  };

  if (tag === 0x09 && payload && payload.length) {
    // AUTO_POWER_TIME response: raw byte maps to the option values in the dropdown
    // (0, 1, 3, 6, 12, 24, 48, 96 for P-series).
    setSelectIfIdle(document.getElementById('selAutoPower'), payload[0]);
  }
  if (tag === 0x0C && payload && payload.length) {
    // LABEL_TYPE response: value IS the byte (0x0B, 0x0A, 0x26, 0x4E).
    setSelectIfIdle(document.getElementById('selPaperType'), payload[0]);
  }
}

async function sendCommand(cmd) {
  try {
    await link.send([...REQ_PREFIX, cmd]);
  } catch (e) {
    logLine('error', 'TX fail: ' + e.message);
  }
}

// ---------- SET / ACTIONS ----------

function isWriteUnlocked() {
  return !!document.querySelector('#writeMode')?.checked;
}

async function applySetting(name, valueByte) {
  if (!isWriteUnlocked()) {
    logLine('error', 'Write mode is off — toggle the switch in the navbar');
    return false;
  }
  const entry = SET_COMMANDS[name];
  if (!entry) {
    logLine('error', `unknown SET command: ${name}`);
    return false;
  }
  const packet = [...entry.header, valueByte & 0xFF];
  try {
    await link.send(packet);
    logLine('info', `SET ${name} = ${valueByte} (0x${hex(valueByte)})`);
    return true;
  } catch (e) {
    logLine('error', `SET ${name} fail: ${e.message}`);
    return false;
  }
}

async function applyAction(name) {
  if (!isWriteUnlocked()) {
    logLine('error', 'Write mode is off — toggle the switch in the navbar');
    return;
  }
  const act = ACTIONS[name];
  if (!act) {
    logLine('error', `unknown action: ${name}`);
    return;
  }
  if (act.danger) {
    const ok = confirm(`Run "${act.label}"?\n\n${act.hint}`);
    if (!ok) { logLine('info', `${name} cancelled`); return; }
  }
  try {
    await link.send(act.bytes);
    logLine('info', `ACTION ${name} → [${hexStr(act.bytes)}]`);
  } catch (e) {
    logLine('error', `${name} fail: ${e.message}`);
  }
}

async function readAll() {
  for (const c of GET_COMMANDS) {
    try {
      await link.send([...REQ_PREFIX, c.cmd]);
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      logLine('error', 'TX fail: ' + e.message);
      return;
    }
  }
}

/**
 * Verify that the newly opened serial port speaks our P780BT protocol.
 *
 * Web Serial cannot filter by anything useful for BT-SPP ports (no USB VID/PID),
 * so we check at the application layer: send the Serial Number request and
 * expect a frame `1A 08 <15 ASCII [0-9A-Z]>` back within a short timeout.
 * If nothing comes, or the frame is malformed, we treat the port as
 * "not a P780BT" and disconnect with a clear toast.
 *
 * Returns true if the device is accepted; false otherwise (and the port is closed).
 */
async function verifyPrinterIdentity() {
  const TIMEOUT_MS = 1500;
  // Wait for a tag 0x08 (SN response) within the timeout.
  const waitForSn = () => new Promise(resolve => {
    const original = link.parser.onFrame;
    const timer = setTimeout(() => {
      link.parser.onFrame = original;
      resolve(null);
    }, TIMEOUT_MS);
    link.parser.onFrame = (tag, payload) => {
      try { original(tag, payload); } catch {}  // let UI log/decode too
      if (tag === 0x08) {
        clearTimeout(timer);
        link.parser.onFrame = original;
        resolve(payload);
      }
    };
  });

  try {
    const pending = waitForSn();
    await link.send([...REQ_PREFIX, 0x09]);  // SN query
    const payload = await pending;
    if (!payload) {
      fail('This serial port did not answer our identity check — not a P780BT-family printer.');
      return false;
    }
    if (payload.length < 8) {
      fail('The device answered with an unexpected frame. Not supported.');
      return false;
    }
    // Payload should be 15 ASCII chars in [0-9A-Z]. Require at least 80% to match.
    let good = 0;
    for (const b of payload) {
      if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A)) good++;
    }
    const ratio = good / payload.length;
    if (ratio < 0.6) {
      fail('The device answered, but the serial number does not look like a P780BT.');
      return false;
    }
    logLine('info', 'Device verified as P780BT-family printer.');
    return true;
  } catch (e) {
    fail('Identity check failed: ' + (e.message || e));
    return false;
  }

  function fail(reason) {
    logLine('error', reason);
    // P1.19 — surface the wrong-endpoint explanation in a dedicated modal
    // instead of a transient toast. The modal's Retry button re-triggers
    // the connect flow so the user can pick the correct port.
    try {
      const modalEl = document.getElementById('wrongEndpointModal');
      if (modalEl && window.bootstrap) {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
        const retryBtn = document.getElementById('wrongEndpointRetry');
        if (retryBtn && !retryBtn._wired) {
          retryBtn._wired = true;
          retryBtn.addEventListener('click', () => {
            modal.hide();
            document.getElementById('btnConnect')?.click();
          });
        }
      } else if (typeof window.showToast === 'function') {
        window.showToast(reason, 'error');
      }
    } catch {}
    // Disconnect — this is not our printer.
    try { link.disconnect(); } catch {}
  }
}

// ---------- Bootstrap ----------

function main() {
  if (!('serial' in navigator)) {
    ui.unsupported.classList.remove('d-none');
    ui.btnConnect.disabled = true;
    return;
  }
  buildCommandButtons();
  buildSettingsUi();

  // Hero Connect CTA: connect only (never toggles off — Disconnect lives
  // in the navbar and has its own handler below).
  ui.btnConnect.addEventListener('click', async () => {
    if (link.isOpen) return;   // defensive; hero is hidden while connected
    try {
      setStatus('connecting', 'connecting…');
      await link.connect();
    } catch (e) {
      setStatus('error', 'error');
      logLine('error', e.message);
    }
  });

  // Navbar Disconnect button: disconnect only. Hidden pre-connect via
  // `.connected-only`, so no connected-state guard needed.
  //
  // We flip the UI to the disconnected state synchronously here rather than
  // waiting for `_readLoop`'s `finally → onDisconnected` to fire. The read
  // loop may take a moment to unwind (the `reader.read()` promise has to
  // settle after `cancel()`), and without this nudge the status badge stays
  // green long enough for the `.connected-only` panels (view pills, gear,
  // Disconnect itself) to look stuck. If onDisconnected fires later it just
  // re-applies the same state — idempotent.
  if (ui.btnDisconnect) {
    ui.btnDisconnect.addEventListener('click', async () => {
      setStatus('disconnected', 'disconnected');
      try { await link.disconnect(); }
      catch (e) { logLine('error', e.message); }
    });
  }

  ui.btnReadAll.addEventListener('click', readAll);
  ui.btnClearLog.addEventListener('click', () => { ui.log.innerHTML = ''; });

  // Close the port when the tab is closed
  window.addEventListener('beforeunload', () => {
    try { link.disconnect(); } catch {}
  });
}

// Single entry point for both halves of the script. `main()` wires the
// Web Serial UI + protocol decoders; `initLabelDesigner()` wires the
// designer canvas, inspector, queue and templates. Order matters only
// in that `main()` builds the `ui` DOM references it depends on.
document.addEventListener('DOMContentLoaded', () => {
  main();
  initLabelDesigner();
});
// =====================================================================
// Label Designer + Print Queue for P780BT (free positioning).
// - Elements have x, y (in px from the label's top-left corner)
// - Barcode/QR/DataMatrix: explicit w, h; drag in the body = move, at the corner = resize
// - Text: x, y; size driven by fontSize; w/h are computed from the text
// - bwip-js errors are shown as Bootstrap toasts instead of being "baked"
//   into the canvas.
// Shares `link`, `logInfo`, `logError`, `currentCartridgeWidthMm` with
// the Web Serial section above — same script, single module scope.
// =====================================================================

// ---------- Constants ----------

// Designer renders directly at the printer's native effective DPI (180 for
// P780BT, confirmed from PrinterTypeChecker.java in the reference app).
// Rendering WYSIWYG at printer resolution eliminates the scale mismatch and
// lets the raster pipeline stay a pure 1:1 pass-through.
const DPI = 180;
const PX_PER_MM = DPI / 25.4;       // ≈7.0866

const HANDLE_SIZE = 10;             // px — resize handle box

// Vertical shift of the raster along the tape-WIDTH axis, in pixels.
// Positive = shift content DOWN on the tape (toward the bottom edge, away
// from the print head's column-0 edge). Negative = shift UP. At 180 dpi,
// 1 px ≈ 0.14 mm. Current: 2 px ≈ 0.28 mm down.
const PRINT_VERTICAL_SHIFT_PX = 2;

// Optional fixed shift of the whole raster along the feed axis, in pixels
// (positive = shift content toward the CUT edge, i.e. to the LEFT in the
// designer; negative = shift toward the LEADING edge / designer RIGHT).
// Leave at 0 unless you consistently observe the printed content offset
// in one direction and want to nudge it back. At 180 dpi, 1 px ≈ 0.14 mm.
// Current: 4 px ≈ 0.5 mm leftward nudge to center content on the tape.
const PRINT_FEED_SHIFT_PX = 4;
const SELECT_OUTLINE = '#0ea5e9';
const ERROR_OUTLINE  = '#ef4444';
const GUIDE_COLOR    = '#e91e63';   // magenta-like color for alignment guides
const GRID_COLOR     = 'rgba(0,0,0,.08)';
const GRID_STEP      = 16;          // px

const SNAP_THRESHOLD = 4;           // px — snap distance to centers/edges

// Text fonts (web-safe + variable)
const FONT_FAMILIES = [
  { value: 'sans',     label: 'Sans-serif',       css: '-apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
  { value: 'helsinki', label: 'Helsinki',         css: '"Helsinki", "Helvetica Neue", Helvetica, Arial, sans-serif' },
  { value: 'serif',    label: 'Serif',            css: 'Georgia, "Times New Roman", serif' },
  { value: 'mono',     label: 'Monospace',        css: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace' },
  { value: 'display',  label: 'Display (Impact)', css: 'Impact, "Arial Black", sans-serif' },
  { value: 'rounded',  label: 'Rounded',          css: '"SF Pro Rounded", "Segoe UI", system-ui, sans-serif' },
];
function fontCss(el) {
  const f = FONT_FAMILIES.find(x => x.value === el.fontFamily) || FONT_FAMILIES[0];
  return f.css;
}

// Text effects (single-choice dropdown).
const TEXT_EFFECTS = [
  { value: 'none',         label: 'No Effects' },
  { value: 'shadow-light', label: 'Shadow Light' },
  { value: 'shadow',       label: 'Shadow' },
  { value: 'outline',      label: 'Outline' },
  { value: 'surround',     label: 'Surround' },
  { value: 'frameout',     label: 'Frame Out' },
  { value: 'invert',       label: 'Invert Colors' },
];

/** Normalize the effect value, including legacy `shadow: true` migration. */
function getEffect(el) {
  if (el.effect) return el.effect;
  if (el.shadow) return 'shadow';     // migrate old saves
  return 'none';
}

/** Extra padding added around the text bbox when effect draws outside the glyphs. */
function effectPadding(el) {
  const eff = getEffect(el);
  if (eff === 'frameout') {
    return { x: Math.max(3, Math.round(el.fontSize / 8)), y: Math.max(2, Math.round(el.fontSize / 10)) };
  }
  if (eff === 'invert') {
    return { x: Math.max(2, Math.round(el.fontSize / 14)), y: Math.max(1, Math.round(el.fontSize / 18)) };
  }
  return { x: 0, y: 0 };
}

function clearShadow(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

// QR content types
const QR_KINDS = [
  { value: 'text',  label: 'Text / URL' },
  { value: 'wifi',  label: 'Wi-Fi credentials' },
  { value: 'vcard', label: 'Contact (vCard)' },
  { value: 'sms',   label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'tel',   label: 'Phone call' },
  { value: 'geo',   label: 'Geo location' },
];
function buildQrPayload(el) {
  const k = el.kind || 'text';
  if (k === 'text')  return el.data || '';
  if (k === 'tel')   return `tel:${(el.phone || '').trim()}`;
  if (k === 'sms')   return `SMSTO:${(el.phone || '').trim()}:${el.smsBody || ''}`;
  if (k === 'email') return `mailto:${(el.email || '').trim()}?subject=${encodeURIComponent(el.subject||'')}&body=${encodeURIComponent(el.emailBody||'')}`;
  if (k === 'geo')   return `geo:${el.lat || 0},${el.lon || 0}`;
  if (k === 'wifi') {
    // WIFI:T:WPA;S:ssid;P:pass;H:false;;
    const esc = s => String(s||'').replace(/([\\;,":])/g, '\\$1');
    const hidden = el.hidden ? 'true' : 'false';
    return `WIFI:T:${el.auth||'WPA'};S:${esc(el.ssid)};P:${esc(el.password)};H:${hidden};;`;
  }
  if (k === 'vcard') {
    return [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${el.name||''}`,
      el.org ? `ORG:${el.org}` : '',
      el.title ? `TITLE:${el.title}` : '',
      el.phone ? `TEL:${el.phone}` : '',
      el.email ? `EMAIL:${el.email}` : '',
      el.url ? `URL:${el.url}` : '',
      'END:VCARD',
    ].filter(Boolean).join('\n');
  }
  return '';
}

// Bootstrap Icons — loaded lazily from the CSS so we don't ship a static list.
const BOOTSTRAP_ICONS_VERSION = '1.11.3';
const BOOTSTRAP_ICONS_CSS_URL =
  `https://cdn.jsdelivr.net/npm/bootstrap-icons@${BOOTSTRAP_ICONS_VERSION}/font/bootstrap-icons.css`;
const BOOTSTRAP_ICONS_SVG_BASE =
  `https://cdn.jsdelivr.net/npm/bootstrap-icons@${BOOTSTRAP_ICONS_VERSION}/icons/`;
const ICON_BMP_SIZE = 512;            // px — source bitmap size for caching (high-res so downscale stays crisp)
let iconNames = null;                 // null until loaded
let iconNamesPromise = null;
const iconBitmapCache = new Map();    // key: "name|color" -> HTMLCanvasElement | 'pending' | 'error'

const BARCODE_TYPES = [
  { bcid: 'code128', label: 'Code 128' },
  { bcid: 'code39',  label: 'Code 39' },
  { bcid: 'ean13',   label: 'EAN-13' },
  { bcid: 'ean8',    label: 'EAN-8' },
  { bcid: 'upca',    label: 'UPC-A' },
  { bcid: 'upce',    label: 'UPC-E' },
  { bcid: 'itf14',   label: 'ITF-14' },
  { bcid: 'interleaved2of5', label: 'Interleaved 2/5' },
  { bcid: 'code93',  label: 'Code 93' },
  { bcid: 'pdf417',  label: 'PDF417' },
  { bcid: 'azteccode', label: 'Aztec' },
];

// ---------- State ----------

const state = {
  widthMm: 40,     // canvas width  = label length along tape (user-editable)
  heightMm: 12,    // canvas height = tape width (must match loaded cartridge)
  dither: 'threshold',
  elements: [],   // { id, type, x, y, w?, h?, ...params }
  selectedId: null,
  errors: {},     // id → error message (reset on every render)
  showGrid: true,
  snap: true,
  showMm: false,  // Inspector X/Y/W/H display unit toggle (P1.11)
  activeGuides: [], // transient guides during drag: {axis:'x'|'y', pos:Number}
};

// P1.11 — px <-> mm conversion helpers for the Inspector. State stays in px
// internally; we only convert at the display boundary.
function pxToMmDisplay(px) { return Math.round((px / PX_PER_MM) * 10) / 10; }
function mmToPxStored(mm)  { return Math.round((+mm || 0) * PX_PER_MM); }

const queue = [];

let _elemIdCounter = 1;
const newId = () => 'el_' + (_elemIdCounter++);

// Drag-state
let dragMode = null;  // null | 'move' | 'resize'
let dragOffset = { x: 0, y: 0 };
let dragStartSize = { w: 0, h: 0 };

// ---------- Element model ----------

function defaultElement(type) {
  const id = newId();
  const n = state.elements.length;
  const base = { id, type, x: 8 + (n * 4), y: 8 + (n * 24) };
  switch (type) {
    case 'text':
      return {
        ...base,
        text: 'Hello',
        fontSize: 18,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        effect: 'none',
        fontFamily: 'sans',
      };
    case 'barcode':
      return { ...base, symbology: 'code128', data: '1234567890', w: 200, h: 40, hri: true };
    case 'qr':
      return {
        ...base, w: 96, h: 96,
        kind: 'text',
        data: 'https://example.com',
        // fields for the different kinds:
        phone: '', smsBody: '',
        email: '', subject: '', emailBody: '',
        lat: 0, lon: 0,
        ssid: '', password: '', auth: 'WPA', hidden: false,
        name: '', org: '', title: '', url: '',
      };
    case 'datamatrix':
      return { ...base, data: 'DM-12345', w: 72, h: 72 };
    case 'icon':
      return { ...base, w: 64, h: 64, name: 'star', color: '#000000' };
    case 'counter':
      return {
        ...base,
        // Counter-specific fields
        prefix: 'ID-',
        suffix: '',
        startNum: 1,
        step: 1,
        count: 10,
        padLen: 0,          // zero-pad the number to this many digits (0 = no padding)
        // Shared text-style fields (same names as type 'text' so rendering can reuse)
        fontSize: 18,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        effect: 'none',
        fontFamily: 'sans',
      };
  }
  throw new Error('unknown element type: ' + type);
}

// ---------- Rendering ----------

function mmToPx(mm) { return Math.round(mm * PX_PER_MM); }

function currentSize() {
  // Canvas w = label length (along tape feed): no upper bound, tape is a roll.
  // Canvas h = tape width (across the print head): driven by the Cartridge
  // width <select> (12 / 18 / 24 mm), which is always within the print head's
  // physical dot range — no software clamp needed. Both axes floor at 20 px
  // so an empty/zeroed input never collapses the canvas.
  const w = Math.max(20, mmToPx(state.widthMm));
  const h = Math.max(20, mmToPx(state.heightMm));
  return { w, h };
}

/** Measure the element's bbox in the given ctx. For text, use actual glyph extents
 *  (actualBoundingBoxAscent/Descent) so the selection rect wraps the visible letters
 *  exactly — no phantom em-box padding above/below. */
function getElementBBox(el, ctx) {
  if (isTextLike(el)) {
    ctx.save();
    ctx.font = textFontString(el);
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(elementText(el) || ' ');
    ctx.restore();
    const asc  = m.actualBoundingBoxAscent  != null ? m.actualBoundingBoxAscent  : el.fontSize * 0.8;
    const desc = m.actualBoundingBoxDescent != null ? m.actualBoundingBoxDescent : el.fontSize * 0.2;
    const coreW = Math.max(10, Math.ceil(m.width));
    const coreH = Math.max(10, Math.ceil(asc + desc));
    const pad = effectPadding(el);
    return {
      x: el.x - pad.x,
      y: el.y - pad.y,
      w: coreW + pad.x * 2,
      h: coreH + pad.y * 2,
      _ascent: asc,
    };
  }
  return { x: el.x, y: el.y, w: el.w | 0, h: el.h | 0 };
}

function textFontString(el) {
  const parts = [];
  if (el.italic) parts.push('italic');
  if (el.bold) parts.push('bold');
  parts.push(`${el.fontSize}px`);
  parts.push(fontCss(el));
  return parts.join(' ');
}

/** Is this element rendered as text (plain text or counter)? */
function isTextLike(el) { return el && (el.type === 'text' || el.type === 'counter'); }

/** Resolve the displayed string for a text-like element.
 *  For a 'counter', pass `overrideIdx` (0-based) to get the N-th value in
 *  the series; otherwise the first value (startNum) is used. */
function elementText(el, overrideIdx) {
  if (el.type === 'text') return el.text || '';
  if (el.type === 'counter') {
    const idx   = overrideIdx != null ? overrideIdx : 0;
    const start = Number.isFinite(+el.startNum) ? +el.startNum : 0;
    const step  = Number.isFinite(+el.step)     ? +el.step     : 1;
    const n = start + idx * step;
    let numStr = String(n);
    const pad = Math.max(0, el.padLen | 0);
    // Pad numeric part (handles negatives too: pad only the digits)
    if (pad > 0) {
      const neg = numStr.startsWith('-');
      const digits = neg ? numStr.slice(1) : numStr;
      if (digits.length < pad) numStr = (neg ? '-' : '') + digits.padStart(pad, '0');
    }
    return (el.prefix || '') + numStr + (el.suffix || '');
  }
  return '';
}

/** Return a canvas rendered by bwip-js; null on error (recorded into state.errors). */
function renderBwip(el) {
  const tmp = document.createElement('canvas');
  try {
    if (el.type === 'barcode') {
      window.bwipjs.toCanvas(tmp, {
        bcid: el.symbology,
        text: el.data,
        scale: 2,
        height: Math.max(4, Math.round(el.h / 4)),  // "units", 1 unit = 2px
        includetext: !!el.hri,
        textxalign: 'center',
        paddingwidth: 0,
        paddingheight: 0,
        backgroundcolor: 'ffffff',
      });
    } else if (el.type === 'qr') {
      const payload = buildQrPayload(el);
      if (!payload) throw new Error('QR: empty payload for the selected kind');
      window.bwipjs.toCanvas(tmp, {
        bcid: 'qrcode',
        text: payload,
        scale: Math.max(2, Math.round(el.w / 32)),
        paddingwidth: 0, paddingheight: 0, backgroundcolor: 'ffffff',
      });
    } else if (el.type === 'datamatrix') {
      window.bwipjs.toCanvas(tmp, {
        bcid: 'datamatrix',
        text: el.data,
        scale: Math.max(2, Math.round(el.w / 24)),
        paddingwidth: 0, paddingheight: 0, backgroundcolor: 'ffffff',
      });
    }
    return tmp;
  } catch (e) {
    state.errors[el.id] = String(e.message || e);
    return null;
  }
}

/** Draw an element into ctx at its (x,y) with explicit w,h. */
function drawElement(ctx, el, widthPx) {
  const box = getElementBBox(el, ctx);

  if (isTextLike(el)) {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.font = textFontString(el);
    ctx.textBaseline = 'alphabetic';
    const text = elementText(el);
    const m = ctx.measureText(text || ' ');
    const asc  = m.actualBoundingBoxAscent  != null ? m.actualBoundingBoxAscent  : el.fontSize * 0.8;
    const desc = m.actualBoundingBoxDescent != null ? m.actualBoundingBoxDescent : el.fontSize * 0.2;
    const baseY = el.y + asc;
    const textW = m.width;
    const effect = getEffect(el);
    const pad = effectPadding(el);

    // Frame / background rectangles first, then glyphs on top.
    if (effect === 'frameout') {
      const lineW = Math.max(1, Math.round(el.fontSize / 22));
      ctx.lineWidth = lineW;
      ctx.strokeRect(el.x - pad.x + lineW / 2, el.y - pad.y + lineW / 2,
                     textW + pad.x * 2 - lineW, asc + desc + pad.y * 2 - lineW);
    } else if (effect === 'invert') {
      ctx.fillStyle = '#000';
      ctx.fillRect(el.x - pad.x, el.y - pad.y, textW + pad.x * 2, asc + desc + pad.y * 2);
      ctx.fillStyle = '#fff';
    }

    // Draw the glyph body with the selected effect.
    if (effect === 'shadow-light') {
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = Math.max(1, Math.round(el.fontSize / 22));
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.fillText(text, el.x, baseY);
      clearShadow(ctx);
    } else if (effect === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = Math.max(1, Math.round(el.fontSize / 12));
      ctx.shadowOffsetX = Math.max(1, Math.round(el.fontSize / 18));
      ctx.shadowOffsetY = Math.max(1, Math.round(el.fontSize / 18));
      ctx.fillText(text, el.x, baseY);
      clearShadow(ctx);
    } else if (effect === 'outline') {
      // Hollow glyphs (stroke only).
      ctx.lineWidth = Math.max(1, Math.round(el.fontSize / 18));
      ctx.strokeStyle = '#000';
      ctx.strokeText(text, el.x, baseY);
    } else if (effect === 'surround') {
      // Thick stroke + fill — embossed / thickened glyph.
      ctx.lineWidth = Math.max(2, Math.round(el.fontSize / 10));
      ctx.strokeStyle = '#000';
      ctx.lineJoin = 'round';
      ctx.strokeText(text, el.x, baseY);
      ctx.fillText(text, el.x, baseY);
    } else {
      // 'none', 'frameout', 'invert' — straight fill. Invert already set fillStyle.
      ctx.fillText(text, el.x, baseY);
    }

    // Restore fill for decorations (underline/strike use fill=stroke=#000 or white for invert).
    if (effect !== 'invert') ctx.fillStyle = '#000';

    // Underline / strike on top of the glyphs.
    if (el.underline || el.strike) {
      const lineW = Math.max(1, Math.round(el.fontSize / 16));
      ctx.lineWidth = lineW;
      ctx.strokeStyle = effect === 'invert' ? '#fff' : '#000';
      if (el.underline) {
        const y = Math.round(baseY + Math.max(desc * 0.6, lineW + 1));
        ctx.beginPath();
        ctx.moveTo(el.x, y);
        ctx.lineTo(el.x + textW, y);
        ctx.stroke();
      }
      if (el.strike) {
        const y = Math.round(baseY - asc * 0.35);
        ctx.beginPath();
        ctx.moveTo(el.x, y);
        ctx.lineTo(el.x + textW, y);
        ctx.stroke();
      }
    }
    ctx.restore();
    return box;
  }

  if (el.type === 'icon') {
    const bmp = getIconBitmap(el.name, el.color || '#000000');
    if (bmp && bmp !== 'pending' && bmp !== 'error') {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, el.x, el.y, el.w, el.h);
    } else {
      // Placeholder while the SVG is loading (or failed).
      ctx.save();
      ctx.strokeStyle = bmp === 'error' ? ERROR_OUTLINE : 'rgba(0,0,0,.35)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(el.x + .5, el.y + .5, el.w - 1, el.h - 1);
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(bmp === 'error' ? 'icon failed' : 'loading…', el.x + 4, el.y + 4);
      ctx.restore();
      if (bmp === 'error') {
        state.errors[el.id] = `Icon "${el.name}" failed to load`;
      }
    }
    return box;
  }

  const tmp = renderBwip(el);
  if (!tmp) return box;

  if (el.type === 'barcode') {
    ctx.imageSmoothingEnabled = false;
    const hriH = el.hri ? 16 : 0;
    // stretch the barcode to the requested width/height; HRI goes below
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height - hriH,
                  el.x, el.y, el.w, el.h);
    if (el.hri) {
      ctx.drawImage(tmp, 0, tmp.height - hriH, tmp.width, hriH,
                    el.x, el.y + el.h, el.w, hriH);
    }
  } else {
    // QR / DataMatrix — fit inside w×h
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height,
                  el.x, el.y, el.w, el.h);
  }
  return box;
}

// ---------- Bootstrap Icons: lazy name list + bitmap cache ----------

/** Return cached bitmap or trigger async load. Return values:
 *    HTMLCanvasElement — ready
 *    'pending'         — load in-flight
 *    'error'           — previous attempt failed
 *    null              — nothing yet */
function getIconBitmap(name, color) {
  if (!name) return null;
  const key = name + '|' + (color || '#000000');
  const cached = iconBitmapCache.get(key);
  if (cached) return cached;
  iconBitmapCache.set(key, 'pending');
  loadIconSvg(name, color || '#000000')
    .then(canvas => {
      iconBitmapCache.set(key, canvas);
      // Clear any stale error state for this element and refresh preview.
      renderPreview();
    })
    .catch(() => {
      iconBitmapCache.set(key, 'error');
      renderPreview();
    });
  return 'pending';
}

async function loadIconSvg(name, color) {
  const url = BOOTSTRAP_ICONS_SVG_BASE + encodeURIComponent(name) + '.svg';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  let svgText = await resp.text();
  // Ensure the icon fills with our chosen color. Bootstrap icons typically
  // use fill="currentColor" on paths or rely on the parent <svg>.
  svgText = svgText
    .replace(/\scurrentColor/gi, ' ' + color)
    .replace(/fill="currentColor"/gi, `fill="${color}"`)
    .replace(/<svg([^>]*)>/i, (m, attrs) => {
      const clean = attrs.replace(/\sfill="[^"]*"/gi, '');
      return `<svg${clean} fill="${color}">`;
    });
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImage(blobUrl);
    const canvas = document.createElement('canvas');
    canvas.width = ICON_BMP_SIZE;
    canvas.height = ICON_BMP_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, ICON_BMP_SIZE, ICON_BMP_SIZE);
    return canvas;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/** Fetch and parse the Bootstrap Icons CSS to extract all icon class names. */
function loadIconNames() {
  if (iconNames) return Promise.resolve(iconNames);
  if (iconNamesPromise) return iconNamesPromise;
  iconNamesPromise = fetch(BOOTSTRAP_ICONS_CSS_URL)
    .then(r => r.text())
    .then(text => {
      const set = new Set();
      // Match rules like: .bi-alarm::before, .bi-arrow-up-right:before, etc.
      const re = /\.bi-([a-z0-9-]+):{1,2}before/g;
      let m;
      while ((m = re.exec(text)) !== null) set.add(m[1]);
      iconNames = Array.from(set).sort();
      return iconNames;
    });
  return iconNamesPromise;
}

function renderClean(canvas, lbl) {
  // No upper clamp on either axis: label length is arbitrarily long (roll),
  // tape width is driven by the cartridge <select> which is bounded by UX.
  const widthPx  = Math.max(20, mmToPx(lbl.widthMm));
  const heightPx = Math.max(20, mmToPx(lbl.heightMm));

  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);

  for (const el of lbl.elements) {
    drawElement(ctx, el, widthPx);
  }
  return { widthPx, heightPx, ctx };
}

/** Draw the grid on top of a white-filled canvas (preview only). */
function drawGrid(ctx, w, h) {
  ctx.save();
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = GRID_STEP; x < w; x += GRID_STEP) {
    ctx.moveTo(x + .5, 0);
    ctx.lineTo(x + .5, h);
  }
  for (let y = GRID_STEP; y < h; y += GRID_STEP) {
    ctx.moveTo(0,   y + .5);
    ctx.lineTo(w,   y + .5);
  }
  ctx.stroke();
  // Center axes
  ctx.strokeStyle = 'rgba(0,0,0,.15)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(w / 2) + .5, 0);
  ctx.lineTo(Math.round(w / 2) + .5, h);
  ctx.moveTo(0, Math.round(h / 2) + .5);
  ctx.lineTo(w, Math.round(h / 2) + .5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawGuides(ctx, w, h, guides) {
  if (!guides || !guides.length) return;
  ctx.save();
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  for (const g of guides) {
    if (g.axis === 'x') { ctx.moveTo(g.pos + .5, 0); ctx.lineTo(g.pos + .5, h); }
    else                { ctx.moveTo(0, g.pos + .5); ctx.lineTo(w,  g.pos + .5); }
  }
  ctx.stroke();
  ctx.restore();
}

/** Render + selection overlay in preview. */
function renderPreview() {
  state.widthMm  = parseInt(dui.widthMm.value, 10) || 40;
  state.heightMm = parseInt(dui.heightMm.value, 10) || 12;
  state.dither   = dui.dither.value;

  // Clear errors before rendering (drawElement will repopulate them)
  const prevErrors = Object.assign({}, state.errors);
  state.errors = {};

  const { widthPx, heightPx, ctx } = renderClean(dui.canvas, state);

  // Grid — preview only (drawn on top of the content at low opacity)
  if (state.showGrid) drawGrid(ctx, widthPx, heightPx);

  // Show a toast for new errors (don't spam if we already reported the same one)
  for (const [id, msg] of Object.entries(state.errors)) {
    if (prevErrors[id] !== msg) {
      const el = state.elements.find(e => e.id === id);
      showToast(`${elementTitle(el?.type || '?')}: ${msg}`, 'error');
    }
  }

  // Overlay selection frame and handles
  if (state.selectedId) {
    const sel = state.elements.find(e => e.id === state.selectedId);
    if (sel) {
      const bbox = getElementBBox(sel, ctx);
      drawSelection(ctx, bbox, !!state.errors[sel.id]);
    }
  }
  // Red frames around every errored element
  for (const id of Object.keys(state.errors)) {
    if (id === state.selectedId) continue;
    const el = state.elements.find(e => e.id === id);
    if (!el) continue;
    const bbox = getElementBBox(el, ctx);
    ctx.save();
    ctx.strokeStyle = ERROR_OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(bbox.x + .5, bbox.y + .5, bbox.w - 1, bbox.h - 1);
    ctx.restore();
  }

  // P1.13 — global center buttons are gated on having a selection so the
  // user doesn't accidentally hit them with no effect.
  const selHas = !!state.selectedId;
  ['btnCenterH', 'btnCenterV', 'btnCenterBoth'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !selHas;
  });

  // Snap guides
  drawGuides(ctx, widthPx, heightPx, state.activeGuides);

  // P0.4 — designerSizeHint now has two placeholder spans (`l` / `w`) so we
  // can show "L mm long x W mm wide" instead of the ambiguous numeric pair.
  if (dui.designerSizeHint) {
    const lEl = dui.designerSizeHint.querySelector('[data-role="l"]');
    const wEl = dui.designerSizeHint.querySelector('[data-role="w"]');
    if (lEl) lEl.textContent = state.widthMm;
    if (wEl) wEl.textContent = state.heightMm;
    // Legacy consumers that expect the old " — × — " format still get
    // a sensible fallback if the span markup ever goes missing.
    if (!lEl && !wEl) {
      dui.designerSizeHint.textContent = `${state.widthMm} × ${state.heightMm} mm`;
    }
  }
  dui.previewPxHint.textContent = `(${widthPx} × ${heightPx} px @ ${DPI} dpi)`;
  // Keep the cartridge-mismatch alert in sync on every redraw.
  updateCartridgeMismatch();
}

/**
 * P0.2 — Refresh the cartridge-width mismatch inline alert. Called on every
 * preview render and by app.js after every 0x40 (MATERIAL_ENCRYPT_DETAIL)
 * frame. Shows the alert when the designer's cartridge width differs from
 * the one physically loaded into the printer.
 *
 * Exported on `window` for app.js to call when it learns of a new cartridge.
 */
function updateCartridgeMismatch() {
  const alert = document.getElementById('cartridgeMismatch');
  if (!alert) return;
  const detected = currentCartridgeWidthMm;
  const designer = state.heightMm;
  const mismatch = detected && designer && detected !== designer;
  if (!mismatch) {
    alert.classList.add('d-none');
    return;
  }
  alert.classList.remove('d-none');
  const dsp = document.getElementById('mismatchDesigner');
  const det = document.getElementById('mismatchDetected');
  const tgt = document.getElementById('mismatchTarget');
  if (dsp) dsp.textContent = designer;
  if (det) det.textContent = detected;
  if (tgt) tgt.textContent = detected;
}

function drawSelection(ctx, bbox, isError) {
  ctx.save();
  ctx.strokeStyle = isError ? ERROR_OUTLINE : SELECT_OUTLINE;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(bbox.x + .5, bbox.y + .5, bbox.w - 1, bbox.h - 1);
  ctx.setLineDash([]);

  // Resize handle for every selectable element (text scales fontSize).
  const sel = state.elements.find(e => e.id === state.selectedId);
  if (sel) {
    const hx = bbox.x + bbox.w - HANDLE_SIZE;
    const hy = bbox.y + bbox.h - HANDLE_SIZE;
    ctx.fillStyle = isError ? ERROR_OUTLINE : SELECT_OUTLINE;
    ctx.fillRect(hx, hy, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(hx + .5, hy + .5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
  }
  ctx.restore();
}

// ---------- Hit testing / mouse handlers ----------

function canvasCoords(evt) {
  const rect = dui.canvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * dui.canvas.width / rect.width;
  const y = (evt.clientY - rect.top)  * dui.canvas.height / rect.height;
  return { x, y };
}

/** Find the element under (x,y). Returns {el, part: 'body'|'handle'} or null.
 *
 *  Iterates top-to-bottom in z-order (last-drawn wins). Selection and
 *  dragging use the element's full bounding box, so icons with transparent
 *  padding around the glyph are still draggable from anywhere inside their
 *  selection rectangle. If an icon overlaps another element, the one later
 *  in the array (= on top visually) wins — use the layer list's Up/Down
 *  buttons to change z-order. */
function hitTest(px, py) {
  const ctx = dui.canvas.getContext('2d');
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    const b = getElementBBox(el, ctx);

    // Handle check on the currently selected element takes priority.
    if (el.id === state.selectedId) {
      const hx = b.x + b.w - HANDLE_SIZE;
      const hy = b.y + b.h - HANDLE_SIZE;
      if (px >= hx && px <= hx + HANDLE_SIZE && py >= hy && py <= hy + HANDLE_SIZE) {
        return { el, part: 'handle' };
      }
    }

    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
      return { el, part: 'body' };
    }
  }
  return null;
}

function onCanvasMouseDown(evt) {
  const p = canvasCoords(evt);
  const hit = hitTest(p.x, p.y);
  if (!hit) {
    state.selectedId = null;
    renderPreview();
    buildElementsList();
    return;
  }
  state.selectedId = hit.el.id;
  if (hit.part === 'handle') {
    dragMode = 'resize';
    // For text, snapshot fontSize and the measured bbox so we can scale
    // fontSize relative to the vertical drag distance.
    const ctx0 = dui.canvas.getContext('2d');
    const bbox0 = getElementBBox(hit.el, ctx0);
    dragStartSize = {
      w: hit.el.w ?? bbox0.w,
      h: hit.el.h ?? bbox0.h,
      fontSize: hit.el.fontSize,
    };
    dragOffset = { x: p.x, y: p.y };
  } else {
    dragMode = 'move';
    dragOffset = { x: p.x - hit.el.x, y: p.y - hit.el.y };
  }
  dui.canvas.style.cursor = dragMode === 'resize' ? 'nwse-resize' : 'grabbing';
  renderPreview();
  buildElementsList();
}

function onCanvasMouseMove(evt) {
  const p = canvasCoords(evt);
  if (!dragMode) {
    const hit = hitTest(p.x, p.y);
    dui.canvas.style.cursor =
      hit ? (hit.part === 'handle' ? 'nwse-resize' : 'move') : 'default';
    return;
  }
  const el = state.elements.find(e => e.id === state.selectedId);
  if (!el) return;

  const canvasSize = currentSize();

  if (dragMode === 'move') {
    let nx = Math.round(p.x - dragOffset.x);
    let ny = Math.round(p.y - dragOffset.y);
    const ctx = dui.canvas.getContext('2d');
    const bbox = getElementBBox({ ...el, x: nx, y: ny }, ctx);
    // snap & guides
    const snap = state.snap ? snapPosition(bbox, canvasSize.w, canvasSize.h) : { dx: 0, dy: 0, guides: [] };
    nx += snap.dx;
    ny += snap.dy;
    el.x = clamp(nx, -bbox.w, canvasSize.w);
    el.y = clamp(ny, -bbox.h, canvasSize.h);
    state.activeGuides = snap.guides;
  } else if (dragMode === 'resize') {
    const dx = p.x - dragOffset.x;
    const dy = p.y - dragOffset.y;
    if (isTextLike(el)) {
      // Scale fontSize proportional to the vertical drag.
      const base = dragStartSize.h || 1;
      const factor = (dragStartSize.h + dy) / base;
      const newSize = Math.round((dragStartSize.fontSize || 18) * factor);
      el.fontSize = Math.max(8, Math.min(120, newSize));
    } else {
      el.w = Math.max(10, Math.round(dragStartSize.w + dx));
      el.h = Math.max(10, Math.round(dragStartSize.h + dy));
    }
    state.activeGuides = [];
  }
  renderPreview();
  updateInspectorFields(el);
}

function onCanvasMouseUp() {
  dragMode = null;
  state.activeGuides = [];
  dui.canvas.style.cursor = 'default';
  renderPreview();
}

/**
 * Compute the snap offset of the bbox toward canvas centers/edges.
 * Returns {dx, dy, guides}.
 */
function snapPosition(bbox, canvasW, canvasH) {
  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  const guides = [];
  let dx = 0, dy = 0;

  // X: bbox center → canvas center, left edge → 0, right edge → canvasW
  const candidatesX = [
    { target: canvasW / 2, from: centerX,         line: canvasW / 2 },
    { target: 0,            from: bbox.x,          line: 0           },
    { target: canvasW,      from: bbox.x + bbox.w, line: canvasW     },
  ];
  for (const c of candidatesX) {
    if (Math.abs(c.from - c.target) <= SNAP_THRESHOLD) {
      dx = c.target - c.from;
      guides.push({ axis: 'x', pos: Math.round(c.line) });
      break;
    }
  }

  const candidatesY = [
    { target: canvasH / 2, from: centerY,         line: canvasH / 2 },
    { target: 0,            from: bbox.y,          line: 0           },
    { target: canvasH,      from: bbox.y + bbox.h, line: canvasH     },
  ];
  for (const c of candidatesY) {
    if (Math.abs(c.from - c.target) <= SNAP_THRESHOLD) {
      dy = c.target - c.from;
      guides.push({ axis: 'y', pos: Math.round(c.line) });
      break;
    }
  }
  return { dx: Math.round(dx), dy: Math.round(dy), guides };
}

/** Center the selected element along the given axis. */
function centerSelected(axis) {
  const el = state.elements.find(e => e.id === state.selectedId);
  if (!el) { showToast('Select an element to center', 'info'); return; }
  const { w, h } = currentSize();
  const ctx = dui.canvas.getContext('2d');
  const bbox = getElementBBox(el, ctx);
  if (axis === 'h' || axis === 'both') el.x = Math.round((w - bbox.w) / 2);
  if (axis === 'v' || axis === 'both') el.y = Math.round((h - bbox.h) / 2);
  renderPreview();
  buildElementsList();
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ---------- Element list / inspector ----------

function buildElementsList() {
  const root = dui.elementsList;
  root.innerHTML = '';
  if (state.elements.length === 0) {
    root.innerHTML = `
      <div class="elements-empty text-body-secondary text-center py-3 small">
        <i class="bi bi-plus-circle d-block mb-1" style="font-size:1.5rem"></i>
        Use the <b>Add</b> button to insert an element
      </div>`;
    return;
  }
  // Display in reverse so the top-most layer appears at the top of the list
  // (matches Photoshop/Figma conventions and the canvas z-order: elements
  // drawn later = visually on top = shown at the top of this list).
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    const row = document.createElement('div');
    row.className = 'element-row';
    if (state.selectedId === el.id) row.classList.add('element-selected');
    if (state.errors[el.id]) row.classList.add('element-error');
    row.dataset.id = el.id;
    row.innerHTML = renderElementEditor(el, i);
    row.addEventListener('click', (e) => {
      // Don't hijack clicks on form controls — `label` matters for btn-check toggles
      // (Bootstrap's <input class="btn-check"> + <label> pattern), otherwise we'd
      // rebuild the DOM before the label forwards the click to its checkbox.
      if (e.target.closest('input,select,button,label,[data-act]')) return;
      if (state.selectedId === el.id) return;
      state.selectedId = el.id;
      renderPreview();
      buildElementsList();
    });
    root.appendChild(row);
  }
  root.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleElementAction(btn);
    });
  });
  root.querySelectorAll('[data-bind]').forEach(inp => {
    const handler = () => {
      const id = inp.closest('.element-row').dataset.id;
      const key = inp.dataset.bind;
      const el = state.elements.find(e => e.id === id);
      if (!el) return;
      let v = inp.value;
      if (inp.type === 'number') v = (inp.step && inp.step.includes('.') ? parseFloat(v) : parseInt(v, 10)) || 0;
      if (inp.type === 'checkbox') v = inp.checked;
      // P1.11 — if the input renders mm, convert back to px before storing.
      if (inp.dataset.unit === 'mm' && ['x', 'y', 'w', 'h'].includes(key)) {
        v = mmToPxStored(v);
      }
      el[key] = v;
      // Changing QR kind requires a full inspector rebuild (field set changes)
      if (key === 'kind') {
        renderPreview();
        buildElementsList();
      } else {
        renderPreview();
      }
    };
    inp.addEventListener('input', handler);
    inp.addEventListener('change', handler);
  });
}

function updateInspectorFields(el) {
  const row = dui.elementsList.querySelector(`.element-row[data-id="${el.id}"]`);
  if (!row) return;
  for (const key of ['x', 'y', 'w', 'h']) {
    const inp = row.querySelector(`[data-bind="${key}"]`);
    if (inp && inp !== document.activeElement && el[key] != null) {
      // Respect the inspector's mm/px unit toggle so live drag updates don't
      // clobber the displayed value with the raw px.
      inp.value = inp.dataset.unit === 'mm' ? pxToMmDisplay(el[key]) : el[key];
    }
  }
}

function renderElementEditor(el, idx) {
  const errorBadge = state.errors[el.id]
    ? `<span class="badge text-bg-danger small ms-1" title="${escHtml(state.errors[el.id])}"><i class="bi bi-exclamation-triangle-fill"></i></span>` : '';
  const common = `
    <div class="element-head">
      <span class="element-index badge text-bg-secondary">${idx + 1}</span>
      <span class="element-type">${elementIcon(el.type)} ${elementTitle(el.type)}${errorBadge}</span>
      <div class="ms-auto btn-group btn-group-sm">
        <button class="btn btn-outline-secondary" data-act="center-h" title="Center horizontally"><i class="bi bi-arrows-collapse-vertical"></i></button>
        <button class="btn btn-outline-secondary" data-act="center-v" title="Center vertically"><i class="bi bi-arrows-collapse"></i></button>
        <button class="btn btn-outline-secondary" data-act="up" ${idx === state.elements.length - 1 ? 'disabled' : ''} title="Bring forward"><i class="bi bi-arrow-up"></i></button>
        <button class="btn btn-outline-secondary" data-act="down" ${idx === 0 ? 'disabled' : ''} title="Send backward"><i class="bi bi-arrow-down"></i></button>
        <button class="btn btn-outline-danger" data-act="del" title="Delete"><i class="bi bi-x-lg"></i></button>
      </div>
    </div>`;

  // P1.11 — X/Y/W/H inputs wrap in an input-group with a unit-suffix badge.
  // Values stay in px internally; when `showMm` is on we render rounded mm
  // and the input handler converts the user's mm entry back to px on change.
  const mm = !!state.showMm;
  const unit = mm ? 'mm' : 'px';
  const disp = v => mm ? pxToMmDisplay(v) : (v | 0);
  const step = mm ? 0.1 : 1;
  const renderPos = (key, label) => `
      <div class="col-3"><label class="form-label small mb-0">${label}</label>
        <div class="input-group input-group-sm">
          <input type="number" class="form-control form-control-sm" step="${step}" data-bind="${key}" data-unit="${unit}" value="${disp(el[key])}">
          <span class="input-group-text unit-suffix">${unit}</span>
        </div>
      </div>`;
  const posBlock = `
    <div class="row g-1 mb-2">
      ${renderPos('x', 'X')}
      ${renderPos('y', 'Y')}
      ${!isTextLike(el) ? renderPos('w', 'W') + renderPos('h', 'H') : ''}
    </div>`;

  let body = '';
  if (el.type === 'text') {
    body = `
      <div class="row g-2">
        <div class="col-12">
          <input type="text" class="form-control form-control-sm" data-bind="text" value="${escHtml(el.text)}" placeholder="Text">
        </div>
        <div class="col-7">
          <label class="form-label small mb-0">Font</label>
          <select class="form-select form-select-sm" data-bind="fontFamily">
            ${FONT_FAMILIES.map(f => `<option value="${f.value}" style="font-family:${f.css}" ${el.fontFamily === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
          </select>
        </div>
        <div class="col-5">
          <label class="form-label small mb-0">Size (px)</label>
          <input type="number" class="form-control form-control-sm" data-bind="fontSize" value="${el.fontSize}" min="8" max="120">
        </div>
        <div class="col-12">
          <label class="form-label small mb-0">Style</label>
          <div class="text-style-toggles btn-group btn-group-sm" role="group" aria-label="Text style">
            <input type="checkbox" class="btn-check" id="tb_${el.id}" data-bind="bold" ${el.bold ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="tb_${el.id}" title="Bold"><b>B</b></label>

            <input type="checkbox" class="btn-check" id="ti_${el.id}" data-bind="italic" ${el.italic ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="ti_${el.id}" title="Italic"><i>I</i></label>

            <input type="checkbox" class="btn-check" id="tu_${el.id}" data-bind="underline" ${el.underline ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="tu_${el.id}" title="Underline"><u>U</u></label>

            <input type="checkbox" class="btn-check" id="ts_${el.id}" data-bind="strike" ${el.strike ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="ts_${el.id}" title="Strikethrough"><s>S</s></label>
          </div>
        </div>
        <div class="col-12">
          <label class="form-label small mb-0" for="teff_${el.id}">Effect</label>
          <select id="teff_${el.id}" class="form-select form-select-sm" data-bind="effect">
            ${TEXT_EFFECTS.map(e => `<option value="${e.value}" ${getEffect(el) === e.value ? 'selected' : ''}>${e.label}</option>`).join('')}
          </select>
        </div>
      </div>`;
  } else if (el.type === 'counter') {
    // P1.12 — preview both ends of the series so the user sees exactly
    // how the counter grows (digit count, padding, prefix/suffix, etc.).
    const lastIdx  = Math.max(0, (el.count | 0) - 1);
    const firstPreview = escHtml(elementText(el, 0));
    const lastPreview  = escHtml(elementText(el, lastIdx));
    body = `
      <div class="row g-2">
        <div class="col-12">
          <div class="small text-body-secondary mb-1">Generates <b>${el.count | 0}</b> labels: <code>${firstPreview}</code> <i class="bi bi-arrow-right mx-1"></i> <code>${lastPreview}</code></div>
        </div>
        <div class="col-6">
          <label class="form-label small mb-0">Prefix</label>
          <input type="text" class="form-control form-control-sm" data-bind="prefix" value="${escHtml(el.prefix || '')}" placeholder="e.g. ID-">
        </div>
        <div class="col-6">
          <label class="form-label small mb-0">Suffix</label>
          <input type="text" class="form-control form-control-sm" data-bind="suffix" value="${escHtml(el.suffix || '')}" placeholder="">
        </div>
        <div class="col-4">
          <label class="form-label small mb-0">Start</label>
          <input type="number" class="form-control form-control-sm" data-bind="startNum" value="${el.startNum | 0}">
        </div>
        <div class="col-4">
          <label class="form-label small mb-0">Step</label>
          <input type="number" class="form-control form-control-sm" data-bind="step" value="${el.step | 0}">
        </div>
        <div class="col-4">
          <label class="form-label small mb-0">Count</label>
          <input type="number" class="form-control form-control-sm" data-bind="count" value="${el.count | 0}" min="1" max="9999">
        </div>
        <div class="col-6">
          <label class="form-label small mb-0" title="Zero-pad the number to this many digits; 0 = no padding">Pad digits</label>
          <input type="number" class="form-control form-control-sm" data-bind="padLen" value="${el.padLen | 0}" min="0" max="10">
        </div>
        <div class="col-6">
          <label class="form-label small mb-0">Size (px)</label>
          <input type="number" class="form-control form-control-sm" data-bind="fontSize" value="${el.fontSize}" min="8" max="120">
        </div>
        <div class="col-12">
          <label class="form-label small mb-0">Font</label>
          <select class="form-select form-select-sm" data-bind="fontFamily">
            ${FONT_FAMILIES.map(f => `<option value="${f.value}" style="font-family:${f.css}" ${el.fontFamily === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
          </select>
        </div>
        <div class="col-12">
          <label class="form-label small mb-0">Style</label>
          <div class="text-style-toggles btn-group btn-group-sm" role="group" aria-label="Text style">
            <input type="checkbox" class="btn-check" id="tb_${el.id}" data-bind="bold" ${el.bold ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="tb_${el.id}" title="Bold"><b>B</b></label>
            <input type="checkbox" class="btn-check" id="ti_${el.id}" data-bind="italic" ${el.italic ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="ti_${el.id}" title="Italic"><i>I</i></label>
            <input type="checkbox" class="btn-check" id="tu_${el.id}" data-bind="underline" ${el.underline ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="tu_${el.id}" title="Underline"><u>U</u></label>
            <input type="checkbox" class="btn-check" id="ts_${el.id}" data-bind="strike" ${el.strike ? 'checked' : ''}>
            <label class="btn btn-outline-secondary" for="ts_${el.id}" title="Strikethrough"><s>S</s></label>
          </div>
        </div>
        <div class="col-12">
          <label class="form-label small mb-0" for="teff_${el.id}">Effect</label>
          <select id="teff_${el.id}" class="form-select form-select-sm" data-bind="effect">
            ${TEXT_EFFECTS.map(e => `<option value="${e.value}" ${getEffect(el) === e.value ? 'selected' : ''}>${e.label}</option>`).join('')}
          </select>
        </div>
      </div>`;
  } else if (el.type === 'barcode') {
    body = `
      <div class="row g-2">
        <div class="col-5">
          <label class="form-label small mb-0">Type</label>
          <select class="form-select form-select-sm" data-bind="symbology">
            ${BARCODE_TYPES.map(b => `<option value="${b.bcid}" ${el.symbology === b.bcid ? 'selected' : ''}>${b.label}</option>`).join('')}
          </select>
        </div>
        <div class="col-7">
          <label class="form-label small mb-0">Data</label>
          <input type="text" class="form-control form-control-sm" data-bind="data" value="${escHtml(el.data)}">
        </div>
        <div class="col-12">
          <div class="form-check form-switch small mb-0">
            <input class="form-check-input" type="checkbox" data-bind="hri" ${el.hri ? 'checked' : ''}>
            <label class="form-check-label">Human readable text (HRI)</label>
          </div>
        </div>
      </div>`;
  } else if (el.type === 'qr') {
    body = `
      <div class="row g-2">
        <div class="col-12">
          <label class="form-label small mb-0">QR type</label>
          <select class="form-select form-select-sm" data-bind="kind">
            ${QR_KINDS.map(k => `<option value="${k.value}" ${el.kind === k.value ? 'selected' : ''}>${k.label}</option>`).join('')}
          </select>
        </div>
        ${renderQrKindFields(el)}
      </div>`;
  } else if (el.type === 'datamatrix') {
    body = `
      <div class="row g-2">
        <div class="col-12">
          <label class="form-label small mb-0">Data</label>
          <input type="text" class="form-control form-control-sm" data-bind="data" value="${escHtml(el.data)}">
        </div>
      </div>`;
  } else if (el.type === 'icon') {
    body = `
      <div class="row g-2 align-items-center">
        <div class="col-auto">
          <span class="icon-preview"><i class="bi bi-${escHtml(el.name || 'question')}"></i></span>
        </div>
        <div class="col">
          <div class="small text-body-secondary">Icon</div>
          <div class="fw-semibold text-truncate">${escHtml(el.name || '?')}</div>
        </div>
        <div class="col-auto">
          <button type="button" class="btn btn-outline-secondary btn-sm" data-act="change-icon" title="Change icon">
            <i class="bi bi-pencil me-1"></i>Change
          </button>
        </div>
      </div>`;
  }
  return common + posBlock + '<div class="element-body">' + body + '</div>';
}

function renderQrKindFields(el) {
  const k = el.kind || 'text';
  if (k === 'text') {
    return `
      <div class="col-12">
        <label class="form-label small mb-0">Text or URL</label>
        <input type="text" class="form-control form-control-sm" data-bind="data" value="${escHtml(el.data)}" placeholder="https://...">
      </div>`;
  }
  if (k === 'tel') {
    return `
      <div class="col-12">
        <label class="form-label small mb-0">Phone</label>
        <input type="tel" class="form-control form-control-sm" data-bind="phone" value="${escHtml(el.phone)}" placeholder="+1234567890">
      </div>`;
  }
  if (k === 'sms') {
    return `
      <div class="col-5">
        <label class="form-label small mb-0">Phone</label>
        <input type="tel" class="form-control form-control-sm" data-bind="phone" value="${escHtml(el.phone)}" placeholder="+1234567890">
      </div>
      <div class="col-7">
        <label class="form-label small mb-0">Message</label>
        <input type="text" class="form-control form-control-sm" data-bind="smsBody" value="${escHtml(el.smsBody)}" placeholder="Hello">
      </div>`;
  }
  if (k === 'email') {
    return `
      <div class="col-12">
        <label class="form-label small mb-0">Email</label>
        <input type="email" class="form-control form-control-sm" data-bind="email" value="${escHtml(el.email)}" placeholder="user@example.com">
      </div>
      <div class="col-12">
        <label class="form-label small mb-0">Subject</label>
        <input type="text" class="form-control form-control-sm" data-bind="subject" value="${escHtml(el.subject)}">
      </div>
      <div class="col-12">
        <label class="form-label small mb-0">Body</label>
        <input type="text" class="form-control form-control-sm" data-bind="emailBody" value="${escHtml(el.emailBody)}">
      </div>`;
  }
  if (k === 'geo') {
    return `
      <div class="col-6">
        <label class="form-label small mb-0">Latitude</label>
        <input type="number" step="0.000001" class="form-control form-control-sm" data-bind="lat" value="${el.lat}">
      </div>
      <div class="col-6">
        <label class="form-label small mb-0">Longitude</label>
        <input type="number" step="0.000001" class="form-control form-control-sm" data-bind="lon" value="${el.lon}">
      </div>`;
  }
  if (k === 'wifi') {
    return `
      <div class="col-8">
        <label class="form-label small mb-0">SSID</label>
        <input type="text" class="form-control form-control-sm" data-bind="ssid" value="${escHtml(el.ssid)}">
      </div>
      <div class="col-4">
        <label class="form-label small mb-0">Security</label>
        <select class="form-select form-select-sm" data-bind="auth">
          <option value="WPA" ${el.auth==='WPA'?'selected':''}>WPA/WPA2</option>
          <option value="WEP" ${el.auth==='WEP'?'selected':''}>WEP</option>
          <option value="nopass" ${el.auth==='nopass'?'selected':''}>None</option>
        </select>
      </div>
      <div class="col-8">
        <label class="form-label small mb-0">Password</label>
        <input type="text" class="form-control form-control-sm" data-bind="password" value="${escHtml(el.password)}">
      </div>
      <div class="col-4 d-flex align-items-end">
        <div class="form-check form-switch small mb-0">
          <input class="form-check-input" type="checkbox" data-bind="hidden" ${el.hidden ? 'checked' : ''}>
          <label class="form-check-label">Hidden</label>
        </div>
      </div>`;
  }
  if (k === 'vcard') {
    return `
      <div class="col-12"><label class="form-label small mb-0">Name</label>
        <input type="text" class="form-control form-control-sm" data-bind="name" value="${escHtml(el.name)}"></div>
      <div class="col-6"><label class="form-label small mb-0">Organization</label>
        <input type="text" class="form-control form-control-sm" data-bind="org" value="${escHtml(el.org)}"></div>
      <div class="col-6"><label class="form-label small mb-0">Title</label>
        <input type="text" class="form-control form-control-sm" data-bind="title" value="${escHtml(el.title)}"></div>
      <div class="col-6"><label class="form-label small mb-0">Phone</label>
        <input type="tel" class="form-control form-control-sm" data-bind="phone" value="${escHtml(el.phone)}"></div>
      <div class="col-6"><label class="form-label small mb-0">Email</label>
        <input type="email" class="form-control form-control-sm" data-bind="email" value="${escHtml(el.email)}"></div>
      <div class="col-12"><label class="form-label small mb-0">URL</label>
        <input type="url" class="form-control form-control-sm" data-bind="url" value="${escHtml(el.url)}"></div>`;
  }
  return '';
}

function elementIcon(t) {
  return ({
    text: '<i class="bi bi-type"></i>',
    counter: '<i class="bi bi-123"></i>',
    barcode: '<i class="bi bi-upc"></i>',
    qr: '<i class="bi bi-qr-code"></i>',
    datamatrix: '<i class="bi bi-grid-3x3"></i>',
    icon: '<i class="bi bi-emoji-smile"></i>',
  })[t] || '';
}
function elementTitle(t) {
  return ({
    text: 'Text',
    counter: 'Counter',
    barcode: 'Barcode',
    qr: 'QR',
    datamatrix: 'Data Matrix',
    icon: 'Icon',
  })[t] || t;
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function handleElementAction(btn) {
  const id = btn.closest('.element-row').dataset.id;
  const idx = state.elements.findIndex(e => e.id === id);
  if (idx < 0) return;
  const act = btn.dataset.act;
  if (act === 'del') {
    state.elements.splice(idx, 1);
    if (state.selectedId === id) state.selectedId = null;
  }
  // The list is displayed reversed (top of list = top z-order = last in array),
  // so the "up" button should bring the element FORWARD (= later in array),
  // and "down" should send it BACKWARD (= earlier in array).
  if (act === 'up' && idx < state.elements.length - 1) {
    [state.elements[idx + 1], state.elements[idx]] = [state.elements[idx], state.elements[idx + 1]];
  }
  if (act === 'down' && idx > 0) {
    [state.elements[idx - 1], state.elements[idx]] = [state.elements[idx], state.elements[idx - 1]];
  }
  if (act === 'center-h' || act === 'center-v') {
    // Select the element and center it
    state.selectedId = id;
    centerSelected(act === 'center-h' ? 'h' : 'v');
    return;  // centerSelected already triggers renderPreview+buildList
  }
  if (act === 'change-icon') {
    const el = state.elements[idx];
    state.selectedId = id;
    openIconPicker((name) => {
      el.name = name;
      renderPreview();
      buildElementsList();
    });
    return;
  }
  renderPreview();
  buildElementsList();
}

// ---------- Queue ----------

function buildQueueList() {
  dui.queueList.innerHTML = '';
  if (queue.length === 0) {
    dui.queueList.innerHTML = `
      <div class="queue-empty text-body-secondary text-center py-4 small">
        <i class="bi bi-inbox d-block mb-1" style="font-size:1.5rem"></i>
        Queue is empty. Design a label on the left and add it here.
      </div>`;
  } else {
    queue.forEach((lbl, i) => {
      if (lbl.copies == null) lbl.copies = 1;   // migrate older items
      const el = document.createElement('div');
      el.className = 'queue-item';
      el.innerHTML = `
        <div class="q-thumb-wrap">${lbl.fromCounter ? `<span class="q-count-badge">×${lbl.counterCount}</span>` : ''}</div>
        <div class="q-meta">
          <div class="small fw-semibold">#${i + 1} · ${lbl.widthMm}×${lbl.heightMm} mm</div>
          <div class="small text-body-secondary">${lbl.elements.length} elements · dither: ${lbl.dither}</div>
        </div>
        <div class="q-copies btn-group btn-group-sm" role="group" aria-label="Copies">
          <button class="btn btn-outline-secondary" data-qcopies-dec="${lbl.id}" title="Decrease copies" aria-label="Decrease copies"><i class="bi bi-dash"></i></button>
          <input type="number" class="form-control form-control-sm text-center" min="1" max="99" value="${lbl.copies}" data-qcopies="${lbl.id}" aria-label="Copies">
          <button class="btn btn-outline-secondary" data-qcopies-inc="${lbl.id}" title="Increase copies" aria-label="Increase copies"><i class="bi bi-plus"></i></button>
        </div>
        <button class="btn btn-sm btn-outline-danger q-del-btn" data-qdel="${lbl.id}" title="Remove"><i class="bi bi-x"></i></button>`;
      const thumb = document.createElement('canvas');
      renderClean(thumb, lbl);
      const displayH = Math.min(60, thumb.height);
      const displayW = Math.round(thumb.width * displayH / thumb.height);
      thumb.style.width = displayW + 'px';
      thumb.style.height = displayH + 'px';
      el.querySelector('.q-thumb-wrap').appendChild(thumb);
      dui.queueList.appendChild(el);
    });
    wireQueueRowHandlers();
  }
  updateQueueUI();
}

/**
 * Attach click/input handlers for the queue rows. Uses event delegation on
 * the queueList container so we wire one listener per event type instead of
 * one per button — cheap even for long queues and means buildQueueList()
 * doesn't re-wire on every rebuild.
 */
function wireQueueRowHandlers() {
  if (dui.queueList._wired) return;
  dui.queueList._wired = true;

  // Per-item copies: + / − buttons and direct input, clamped to [1, 99].
  const setCopies = (id, v) => {
    const item = queue.find(q => q.id === id);
    if (!item) return;
    item.copies = Math.max(1, Math.min(99, v | 0));
    const inp = dui.queueList.querySelector(`[data-qcopies="${id}"]`);
    if (inp && inp !== document.activeElement) inp.value = item.copies;
    updateQueueUI();
  };

  dui.queueList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.qdel) {
      const idx = queue.findIndex(q => q.id === btn.dataset.qdel);
      if (idx >= 0) queue.splice(idx, 1);
      buildQueueList();
      return;
    }
    if (btn.dataset.qcopiesDec || btn.dataset.qcopiesInc) {
      const id = btn.dataset.qcopiesDec || btn.dataset.qcopiesInc;
      const item = queue.find(q => q.id === id);
      if (!item) return;
      const delta = btn.dataset.qcopiesInc ? 1 : -1;
      setCopies(id, (item.copies || 1) + delta);
      const inp = dui.queueList.querySelector(`[data-qcopies="${id}"]`);
      if (inp) inp.value = item.copies;
    }
  });

  dui.queueList.addEventListener('input', (ev) => {
    const inp = ev.target.closest('[data-qcopies]');
    if (!inp) return;
    setCopies(inp.dataset.qcopies, parseInt(inp.value, 10) || 1);
  });

  dui.queueList.addEventListener('blur', (ev) => {
    const inp = ev.target.closest('[data-qcopies]');
    if (!inp) return;
    // Normalize the visible value after editing (e.g. empty → 1).
    const item = queue.find(q => q.id === inp.dataset.qcopies);
    if (item) inp.value = item.copies;
  }, /* capture */ true);
}

function updateQueueUI() {
  // P1.8 — explicit microcopy: "N items · M prints" (always show both sides
  // so the distinction between queue rows and physical sheets is readable
  // even for non-counter jobs).
  const prints = queue.reduce((s, q) => s + Math.max(1, q.copies | 0), 0);
  dui.queueCount.textContent = `${queue.length} item${queue.length === 1 ? '' : 's'} · ${prints} print${prints === 1 ? '' : 's'}`;
  const connected = link?.isOpen;
  dui.btnPrintQueue.disabled = !(queue.length && connected);
  dui.btnClearQueue.disabled = queue.length === 0;
}

function addToQueue() {
  if (state.elements.length === 0) {
    showToast('Label is empty — add at least one element', 'error');
    return;
  }
  if (Object.keys(state.errors).length) {
    showToast('Label has errored elements — fix them before adding', 'error');
    return;
  }
  // P0.2 — cartridge-width mismatch is surfaced as an inline alert at the
  // top of the designer card. If the alert is visible when the user hits
  // "Add to queue", redirect them to it instead of silently toasting.
  const mismatchAlert = document.getElementById('cartridgeMismatch');
  if (mismatchAlert && !mismatchAlert.classList.contains('d-none')) {
    showToast('Fix the cartridge-width mismatch above', 'error');
    return;
  }

  // Counter-driven expansion: each counter element wants to produce `count`
  // labels. Across multiple counters with different counts, the queue length
  // is the MAX — and each counter independently steps for labels 0..count-1,
  // clamping to its own last value for any extra labels beyond its range.
  const counters = state.elements.filter(e => e.type === 'counter');
  const totalLabels = counters.length
    ? Math.max(1, ...counters.map(c => Math.max(1, c.count | 0)))
    : 1;

  const baseId = 'q_' + Date.now();
  for (let i = 0; i < totalLabels; i++) {
    const materialized = state.elements.map(el => {
      const cloned = JSON.parse(JSON.stringify(el));
      if (cloned.type !== 'counter') return cloned;
      const myCount = Math.max(1, cloned.count | 0);
      const idx = Math.min(i, myCount - 1);
      // Freeze the counter into a plain text element so the rest of the
      // pipeline (renderer, raster, templates) treats it uniformly.
      const text = elementText(cloned, idx);
      const frozen = { ...cloned, type: 'text', text };
      // Strip counter-only fields from the frozen object (cosmetic; avoids
      // confusing the inspector if the queue item is ever re-edited).
      delete frozen.prefix; delete frozen.suffix;
      delete frozen.startNum; delete frozen.step; delete frozen.count;
      delete frozen.padLen;
      return frozen;
    });
    // P1.9 — mark counter-expanded items so the queue UI can show a ×N
    // badge on every thumbnail that came from the same counter batch.
    const fromCounter = counters.length > 0 && totalLabels > 1;
    queue.push({
      id: `${baseId}_${i}`,
      widthMm: state.widthMm,
      heightMm: state.heightMm,
      dither: state.dither,
      elements: materialized,
      copies: 1,
      ...(fromCounter ? { fromCounter: true, counterCount: totalLabels } : {}),
    });
  }
  buildQueueList();
  showToast(
    totalLabels === 1
      ? 'Label added to the queue'
      : `${totalLabels} labels added to the queue`,
    'success'
  );
}

// ---------- Raster / dither ----------

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
 * Pack a 1bpp raster for P780BT. The printer expects the data oriented so that
 * each RASTER ROW is one scan line across the print head, and successive rows
 * advance the tape one pixel along the feed direction. Our designer canvas
 * has width = feed direction and height = tape-width direction, so we rotate
 * 90° before packing.
 *
 * Mapping (canvas → raster):
 *   - raster_row (ny)  advances along tape feed (0 = first printed = tape
 *                      leading edge)
 *   - raster_col (nx)  is one pixel across the print head (0 = one tape edge)
 *
 * We send canvas LEFT as the FIRST printed row, so when the user reads the
 * tape with the just-cut end on their LEFT and the first-out (leading) end
 * on their RIGHT, the content orientation matches the designer. Reversing
 * this direction (canvas right first) makes the post-print hardware feed
 * blank appear between the content and the leading edge instead of the
 * cutter edge, which shows up as empty space on the "right" side of the
 * printed label when the user holds the tape that way.
 *
 * Vertical shift compensation: PRINT_VERTICAL_SHIFT_PX shifts the rendered
 * content along the tape-width axis. Positive shifts content DOWN on the
 * tape (away from the nx=0 print-head edge); we achieve that by sampling
 * canvas y that's SMALLER than the current nx, so the first few tape
 * columns end up blank and the content appears nudged down.
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
  //     (designer LEFT) so small systemic offsets can be corrected.
  //   oy = nx - PRINT_VERTICAL_SHIFT_PX
  //     Positive PRINT_VERTICAL_SHIFT_PX shifts content DOWN on the tape
  //     (the first few tape columns at nx=0..SHIFT-1 read from oy < 0,
  //     which is out of bounds → blank).
  for (let ny = 0; ny < newH; ny++) {
    const ox = (w - 1) - ny + PRINT_FEED_SHIFT_PX;
    for (let bi = 0; bi < widthBytes; bi++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const nx = bi * 8 + bit;
        if (nx >= newW) continue;
        const oy = nx - PRINT_VERTICAL_SHIFT_PX;
        if (ox >= 0 && ox < w && oy >= 0 && oy < h && mono[oy * w + ox]) {
          byte |= (1 << (7 - bit));   // MSB = leftmost pixel in rotated space
        }
      }
      out[idx++] = byte;
    }
  }
  return out;
}

function canvasToRaster(canvas, method) {
  const { mono, w, h } = canvasToMonoBytes(canvas, method);
  return monoToRaster(mono, w, h);
}

/** Pass-through — designer already renders at the printer's native DPI
 *  (180), so the rasterizer gets the bitmap unchanged. */
function canvasForPrint(src) {
  return src;
}

// ---------- Print ----------

// Wait for a specific response tag to arrive on the serial stream.
// Resolves with the payload bytes, or rejects after `timeoutMs`.
function waitForTag(expectedTag, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    // `link` comes from the outer module scope via closure. (Earlier
    // code had `const link = link;` left over from a window.serialLink
    // → link rename; that shadowed the outer binding and tripped the
    // Temporal Dead Zone, so waitForTag always rejected instantly and
    // the real frame arrived outside this promise.)
    if (!link || !link.isOpen) { reject(new Error('not connected')); return; }
    const originalOnFrame = link.parser.onFrame;
    const timer = setTimeout(() => {
      link.parser.onFrame = originalOnFrame;
      reject(new Error(`timeout waiting for tag 0x${expectedTag.toString(16)}`));
    }, timeoutMs);
    link.parser.onFrame = (tag, payload) => {
      // Always forward the frame to the UI decoder too
      try { originalOnFrame(tag, payload); } catch {}
      if (tag === expectedTag) {
        clearTimeout(timer);
        link.parser.onFrame = originalOnFrame;
        resolve(payload);
      }
    };
  });
}

// Query paper state (cmd 0x11) and return the raw payload byte, or null on timeout.
async function queryPaperState() {
  try {
    const payloadPromise = waitForTag(0x06, 2500);
    await link.send([0x1F, 0x11, 0x11]);
    const payload = await payloadPromise;
    return payload[0] ?? null;
  } catch {
    return null;
  }
}

/** Click handler for the main Print CTA. Pops a confirmation modal with
 *  the total number of physical labels about to be printed, and only
 *  kicks off `printQueue()` if the user accepts. */
function confirmAndPrintQueue() {
  if (!link?.isOpen) {
    showToast('Printer is not connected', 'error');
    return;
  }
  if (queue.length === 0) {
    showToast('Queue is empty', 'info');
    return;
  }
  const totalPrints = queue.reduce((s, q) => s + Math.max(1, q.copies | 0), 0);
  const unique = queue.length;

  const elTotal        = document.getElementById('printConfirmTotal');
  const elTotalPlural  = document.getElementById('printConfirmTotalPlural');
  const elUnique       = document.getElementById('printConfirmUnique');
  const elUniquePlural = document.getElementById('printConfirmUniquePlural');
  const elStart        = document.getElementById('printConfirmStart');
  if (!elTotal || !elStart) {
    // Modal markup missing — fall back to direct print.
    printQueue();
    return;
  }
  elTotal.textContent        = totalPrints;
  elTotalPlural.textContent  = totalPrints === 1 ? '' : 's';
  elUnique.textContent       = unique;
  elUniquePlural.textContent = unique === 1 ? '' : 's';

  const modal = bsModal('#printConfirmModal');
  // Fresh click handler each open so we don't double-fire on re-opens.
  const onStart = () => {
    elStart.removeEventListener('click', onStart);
    modal.hide();
    printQueue();
  };
  elStart.addEventListener('click', onStart);
  modal.show();
}

async function printQueue() {
  if (!link?.isOpen) {
    showToast('Printer is not connected', 'error');
    return;
  }
  const continuous = dui.qContinuous.checked;
  const totalPrints = queue.reduce((s, q) => s + Math.max(1, q.copies | 0), 0);

  logInfo(`Print queue: ${queue.length} label(s) → ${totalPrints} total prints, continuous=${continuous}`);

  // Pre-flight paper check. Firmware does not send async notifications, so
  // we must actively query PAPER_STATE before sending any raster.
  logInfo('Pre-flight: querying paper state…');
  const paperByte = await queryPaperState();
  if (paperByte === null) {
    logError('No response to PAPER_STATE — printer may be silent or RX not working.');
    showToast('No response from printer on PAPER_STATE. Check the connection.', 'error');
    return;
  }
  if (paperByte === 0x88) {
    logError('Paper state = NO PAPER (0x88). Aborting print.');
    // P1.20 — offer an inline Retry button so the user doesn't have to
    // re-hunt for the Print CTA after loading paper.
    showToast('Printer reports no paper. Load a roll, close the cover, then Retry.', 'error', {
      action: { label: 'Retry', onClick: () => printQueue() },
    });
    return;
  }
  logInfo(`  Paper state OK (0x${paperByte.toString(16).padStart(2, '0')})`);

  dui.btnPrintQueue.disabled = true;
  // P0.5 — progress UI under the Print CTA. We know `rasters.length` after
  // the render loop below; initialise optimistically and fill in the total
  // once it's known.
  const pgWrap = document.getElementById('printProgress');
  const pgBar  = document.getElementById('printProgressBar');
  const pgCur  = document.getElementById('printProgressCurrent');
  const pgTot  = document.getElementById('printProgressTotal');
  const showProgress = (cur, tot) => {
    if (!pgWrap) return;
    pgWrap.classList.remove('d-none');
    if (pgCur) pgCur.textContent = cur;
    if (pgTot) pgTot.textContent = tot;
    if (pgBar) pgBar.style.width = tot > 0 ? `${Math.round((cur / tot) * 100)}%` : '0%';
  };
  const hideProgress = () => {
    if (!pgWrap) return;
    pgWrap.classList.add('d-none');
    if (pgBar) pgBar.style.width = '0%';
  };
  try {
    // Prepare every raster first (label × copies) so we can stream them
    // as a single print job (one INIT, one PAGER, PAUSE between rasters).
    const rasters = [];
    for (let li = 0; li < queue.length; li++) {
      const lbl = queue[li];
      const copies = Math.max(1, Math.min(99, lbl.copies | 0));
      const tmp = document.createElement('canvas');
      renderClean(tmp, lbl);
      // Prepare the canvas for print: shorten along the feed axis to cancel
      // out the printer's automatic post-print feed, and shrink the content
      // uniformly for an inner margin. See canvasForPrint().
      const forPrint = canvasForPrint(tmp);
      const raster = canvasToRaster(forPrint, lbl.dither);
      logInfo(`  Label #${li + 1}: ${tmp.width}×${tmp.height}px → print ${forPrint.width}×${forPrint.height}px × ${copies} copies → ${raster.length} raster bytes`);
      for (let c = 0; c < copies; c++) rasters.push(raster);
    }
    if (rasters.length === 0) {
      showToast('Queue is empty', 'info');
      return;
    }

    // Chunked streaming to avoid overrunning the printer's internal buffer:
    //   1. Send PAPER_TYPE (if requested) + INIT_PRINTER as a small head chunk.
    //   2. For each raster: send PRINT_IMAGE prefix + raster in ~1 KB chunks,
    //      with a short pause after each raster so the print head can process.
    //   3. Between rasters (not after the last) send PRINT_PAUSE.
    //   4. Finish with PRINT_PAGER.
    //
    // `silent=true` on each send suppresses per-chunk TX log spam; we log once
    // per label so the console stays readable.
    const RASTER_CHUNK = 1024;   // bytes per serial write
    const INTER_CHUNK_MS = 5;    // tiny breathing room between chunks
    const INTER_LABEL_MS = 180;  // let the head finish a label before the next

    // `link` is the module-scope SerialLink instance (closure).

    // Head: (optional PAPER_TYPE) + INIT_PRINTER
    const head = [];
    if (continuous) head.push(0x1F, 0x11, 0x0B, 0x0B);  // PAPER_TYPE = Continuous
    head.push(0x1B, 0x40);                              // INIT_PRINTER
    await link.send(head);                              // logged
    await sleep(40);

    // P0.5 — seed progress UI once the total is known.
    showProgress(0, rasters.length);

    for (let i = 0; i < rasters.length; i++) {
      logInfo(`  → raster ${i + 1}/${rasters.length} (${rasters[i].length} bytes)`);

      // PRINT_IMAGE prefix + raster streamed in RASTER_CHUNK-sized pieces.
      const r = rasters[i];
      const prefixed = new Uint8Array(4 + r.length);
      prefixed[0] = 0x1D; prefixed[1] = 0x76; prefixed[2] = 0x30; prefixed[3] = 0x00;
      prefixed.set(r, 4);

      for (let off = 0; off < prefixed.length; off += RASTER_CHUNK) {
        const end = Math.min(off + RASTER_CHUNK, prefixed.length);
        await link.send(prefixed.subarray(off, end), /* silent */ true);
        if (end < prefixed.length) await sleep(INTER_CHUNK_MS);
      }
      showProgress(i + 1, rasters.length);

      if (i < rasters.length - 1) {
        await link.send([0x1F, 0x11, 0x3C]);             // PRINT_PAUSE (logged)
        await sleep(INTER_LABEL_MS);
      }
    }

    await link.send([0x1B, 0x64, 0x00]);                 // PRINT_PAGER (logged)
    // Everything that was in the queue is now on the printer. Clear it so
    // the user starts fresh next time — a print job has no re-queue value,
    // and leaving stale items around invites accidental reprints.
    const printed = queue.length;
    queue.length = 0;
    buildQueueList();
    showToast(`Print job sent · ${printed} item${printed === 1 ? '' : 's'} cleared from queue`, 'success');
  } catch (e) {
    logError('Print failed: ' + e.message);
    showToast('Print failed: ' + e.message, 'error');
  } finally {
    hideProgress();
    updateQueueUI();
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Templates (localStorage) ----------

const TEMPLATE_STORE_KEY = 'p780bt_templates_v1';
const THUMB_MAX_WIDTH = 240;   // px — thumbnail width stored in localStorage
const TEMPLATES_MAX    = 100;  // safety cap to keep localStorage reasonable

let templateModal = null;      // bootstrap.Modal instance (lazy)
let templateDeleteModal = null;
let templateSearchTerm = '';

function loadTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('loadTemplates failed:', e);
    return [];
  }
}

function saveTemplatesList(list) {
  try {
    localStorage.setItem(TEMPLATE_STORE_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    // Likely QuotaExceededError — thumbnails too big or too many templates.
    console.warn('saveTemplatesList failed:', e);
    showToast('Could not save template — browser storage is full.', 'error');
    return false;
  }
}

function templateFromState(name) {
  // Snapshot the current designer state into a portable template object.
  const tmp = document.createElement('canvas');
  renderClean(tmp, state);
  const thumb = makeThumbnail(tmp, THUMB_MAX_WIDTH);
  return {
    id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: (name || 'Untitled').slice(0, 60),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    widthMm: state.widthMm,
    heightMm: state.heightMm,
    dither: state.dither,
    elements: JSON.parse(JSON.stringify(state.elements)),
    thumbnail: thumb,  // data URL
  };
}

function makeThumbnail(sourceCanvas, maxW) {
  const ratio = sourceCanvas.width > maxW ? (maxW / sourceCanvas.width) : 1;
  const w = Math.max(1, Math.round(sourceCanvas.width * ratio));
  const h = Math.max(1, Math.round(sourceCanvas.height * ratio));
  const thumb = document.createElement('canvas');
  thumb.width = w; thumb.height = h;
  const ctx = thumb.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  try {
    return thumb.toDataURL('image/png');
  } catch {
    return '';
  }
}

function saveNewTemplate(name) {
  const list = loadTemplates();
  if (list.length >= TEMPLATES_MAX) {
    showToast(`Template limit reached (${TEMPLATES_MAX}). Delete some first.`, 'error');
    return false;
  }
  const tpl = templateFromState(name);
  list.unshift(tpl);
  const ok = saveTemplatesList(list);
  if (ok) {
    showToast('Template saved', 'success');
    renderTemplatesGallery();
  }
  return ok;
}

function updateTemplate(id, patch) {
  const list = loadTemplates();
  const idx = list.findIndex(t => t.id === id);
  if (idx < 0) return false;
  list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
  const ok = saveTemplatesList(list);
  if (ok) renderTemplatesGallery();
  return ok;
}

function deleteTemplate(id) {
  const list = loadTemplates().filter(t => t.id !== id);
  const ok = saveTemplatesList(list);
  if (ok) {
    showToast('Template deleted', 'info');
    renderTemplatesGallery();
  }
  return ok;
}

function duplicateTemplate(id) {
  const list = loadTemplates();
  const src = list.find(t => t.id === id);
  if (!src) return false;
  const copy = {
    ...JSON.parse(JSON.stringify(src)),
    id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: (src.name || 'Untitled') + ' (copy)',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  list.unshift(copy);
  const ok = saveTemplatesList(list);
  if (ok) {
    showToast('Template duplicated', 'success');
    renderTemplatesGallery();
  }
  return ok;
}

/** Set a <select>'s value, adding a synthetic "Custom" option if needed to
 *  preserve non-standard legacy template values. */
function ensureCartridgeOption(select, value) {
  const has = Array.from(select.options).some(o => parseInt(o.value, 10) === value);
  if (!has) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = `${value} mm (custom)`;
    opt.dataset.custom = '1';
    select.appendChild(opt);
  }
  select.value = String(value);
}

function openTemplateInDesigner(id) {
  const list = loadTemplates();
  const tpl = list.find(t => t.id === id);
  if (!tpl) return;
  // Load into state
  state.widthMm  = tpl.widthMm;
  state.heightMm = tpl.heightMm;
  state.dither   = tpl.dither || 'threshold';
  state.elements = JSON.parse(JSON.stringify(tpl.elements || []));
  state.selectedId = null;
  state.errors = {};
  // Sync size/dither inputs
  if (dui.widthMm) dui.widthMm.value = state.widthMm;
  if (dui.heightMm) ensureCartridgeOption(dui.heightMm, state.heightMm);
  if (dui.dither) dui.dither.value = state.dither;
  renderPreview();
  buildElementsList();
  // Switch to Design tab
  const designBtn = document.getElementById('nav-design-btn');
  if (designBtn) designBtn.click();
  showToast(`Opened "${tpl.name}"`, 'info');
}

/** P1.10 — push a template straight into the print queue without opening
 *  it in the designer. Counter elements are NOT expanded here (the queue
 *  would need to know each counter's range); we preserve the snapshot
 *  as-is with copies=1. */
function addTemplateToQueue(id) {
  const list = loadTemplates();
  const tpl = list.find(t => t.id === id);
  if (!tpl) return;
  queue.push({
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    widthMm: tpl.widthMm,
    heightMm: tpl.heightMm,
    dither: tpl.dither || 'threshold',
    elements: JSON.parse(JSON.stringify(tpl.elements || [])),
    copies: 1,
  });
  buildQueueList();
  showToast(`Added "${tpl.name}" to the queue`, 'success');
  document.getElementById('nav-design-btn')?.click();
}

function renderTemplatesGallery() {
  const gallery = document.getElementById('templatesGallery');
  const empty = document.getElementById('templatesEmpty');
  if (!gallery || !empty) return;

  const list = loadTemplates();
  const filtered = templateSearchTerm
    ? list.filter(t => t.name.toLowerCase().includes(templateSearchTerm.toLowerCase()))
    : list;

  gallery.innerHTML = '';
  if (list.length === 0) {
    empty.classList.remove('d-none');
    gallery.classList.add('d-none');
    return;
  }
  empty.classList.add('d-none');
  gallery.classList.remove('d-none');

  if (filtered.length === 0) {
    gallery.innerHTML = `<div class="col-12 text-center py-4 text-body-secondary small">No templates match "<b>${escHtml(templateSearchTerm)}</b>".</div>`;
    return;
  }

  for (const tpl of filtered) {
    const col = document.createElement('div');
    col.className = 'col-sm-6 col-lg-4 col-xl-3';
    const date = new Date(tpl.updatedAt || tpl.createdAt);
    const dateStr = isNaN(date) ? '' : date.toLocaleDateString();
    const elemCount = (tpl.elements || []).length;
    col.innerHTML = `
      <div class="card shadow-sm h-100 template-card">
        <div class="template-thumb-wrap">
          ${tpl.thumbnail
            ? `<img src="${tpl.thumbnail}" alt="" class="template-thumb">`
            : `<div class="template-thumb-placeholder"><i class="bi bi-image text-body-secondary"></i></div>`}
        </div>
        <div class="card-body py-2 px-3">
          <div class="fw-semibold text-truncate" title="${escHtml(tpl.name)}">${escHtml(tpl.name)}</div>
          <div class="small text-body-secondary">${tpl.widthMm}×${tpl.heightMm} mm · ${elemCount} element${elemCount === 1 ? '' : 's'}${dateStr ? ' · ' + dateStr : ''}</div>
        </div>
        <div class="card-footer bg-transparent border-0 pt-0 pb-2 px-3 d-flex gap-1">
          <button class="btn btn-primary btn-sm flex-grow-1" data-tpl-open="${tpl.id}" title="Open in designer">
            <i class="bi bi-folder2-open me-1"></i>Open
          </button>
          <button class="btn btn-outline-success btn-sm" data-tpl-queue="${tpl.id}" title="Add to queue"><i class="bi bi-plus-circle"></i></button>
          <button class="btn btn-outline-secondary btn-sm" data-tpl-dup="${tpl.id}" title="Duplicate">
            <i class="bi bi-files"></i>
          </button>
          <button class="btn btn-outline-secondary btn-sm" data-tpl-rename="${tpl.id}" title="Rename">
            <i class="bi bi-pencil"></i>
          </button>
          <button class="btn btn-outline-danger btn-sm" data-tpl-del="${tpl.id}" title="Delete">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>`;
    gallery.appendChild(col);
  }

  // Bind actions
  gallery.querySelectorAll('[data-tpl-open]').forEach(btn => {
    btn.addEventListener('click', () => openTemplateInDesigner(btn.dataset.tplOpen));
  });
  gallery.querySelectorAll('[data-tpl-queue]').forEach(btn => {
    btn.addEventListener('click', () => addTemplateToQueue(btn.dataset.tplQueue));
  });
  gallery.querySelectorAll('[data-tpl-dup]').forEach(btn => {
    btn.addEventListener('click', () => duplicateTemplate(btn.dataset.tplDup));
  });
  gallery.querySelectorAll('[data-tpl-rename]').forEach(btn => {
    btn.addEventListener('click', () => openRenameModal(btn.dataset.tplRename));
  });
  gallery.querySelectorAll('[data-tpl-del]').forEach(btn => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.tplDel));
  });
}

function openSaveModal() {
  if (state.elements.length === 0) {
    showToast('Add at least one element before saving', 'error');
    return;
  }
  const input = document.getElementById('templateNameInput');
  const confirm = document.getElementById('templateNameModalConfirm');
  const action = document.getElementById('templateNameModalAction');
  if (!input || !confirm || !action) return;
  action.textContent = 'Save';
  confirm.textContent = 'Save';
  input.value = suggestTemplateName();
  confirm.onclick = () => {
    const name = (input.value || '').trim() || 'Untitled';
    if (saveNewTemplate(name)) {
      bsModal('#templateNameModal').hide();
    }
  };
  const modal = bsModal('#templateNameModal');
  setTimeout(() => input.focus(), 150);
  modal.show();
}

function openRenameModal(id) {
  const tpl = loadTemplates().find(t => t.id === id);
  if (!tpl) return;
  const input = document.getElementById('templateNameInput');
  const confirm = document.getElementById('templateNameModalConfirm');
  const action = document.getElementById('templateNameModalAction');
  if (!input || !confirm || !action) return;
  action.textContent = 'Rename';
  confirm.textContent = 'Rename';
  input.value = tpl.name || '';
  confirm.onclick = () => {
    const name = (input.value || '').trim() || 'Untitled';
    if (updateTemplate(id, { name })) {
      showToast('Template renamed', 'success');
      bsModal('#templateNameModal').hide();
    }
  };
  const modal = bsModal('#templateNameModal');
  setTimeout(() => { input.focus(); input.select(); }, 150);
  modal.show();
}

function openDeleteModal(id) {
  const tpl = loadTemplates().find(t => t.id === id);
  if (!tpl) return;
  const nameEl = document.getElementById('templateDeleteName');
  const confirm = document.getElementById('templateDeleteConfirm');
  if (!nameEl || !confirm) return;
  nameEl.textContent = tpl.name || 'this template';
  confirm.onclick = () => {
    deleteTemplate(id);
    bsModal('#templateDeleteModal').hide();
  };
  bsModal('#templateDeleteModal').show();
}

function suggestTemplateName() {
  // Use first text element's text as the seed, fallback to WxH mm.
  const firstText = state.elements.find(e => e.type === 'text');
  if (firstText && firstText.text) return firstText.text.slice(0, 40);
  return `Label ${state.widthMm}×${state.heightMm} mm`;
}

/** Open the icon picker modal and call onPick(name) when the user chooses one. */
async function openIconPicker(onPick) {
  const grid = document.getElementById('iconGrid');
  const input = document.getElementById('iconSearchInput');
  const status = document.getElementById('iconPickerStatus');
  if (!grid || !input) return;

  status.textContent = 'Loading icon list…';
  grid.innerHTML = '';

  let names;
  try {
    names = await loadIconNames();
  } catch (e) {
    status.textContent = 'Failed to load icon list: ' + (e.message || e);
    return;
  }

  // Render in chunks, appending more as the user scrolls toward the bottom.
  // A trailing "sentinel" element lives at the end of the grid; an
  // IntersectionObserver watches it and triggers the next batch when it
  // enters the viewport.
  const BATCH = 200;   // icons per chunk
  let filtered = names;
  let shown = 0;

  const onBtnClick = (btn) => {
    const name = btn.dataset.name;
    try { onPick(name); } catch {}
    bsModal('#iconPickerModal').hide();
  };

  // Event delegation: one listener on the grid handles all buttons.
  grid.onclick = (e) => {
    const btn = e.target.closest('[data-name]');
    if (btn) onBtnClick(btn);
  };

  // Sentinel observed to trigger the next batch.
  const sentinel = document.createElement('div');
  sentinel.className = 'icon-picker-sentinel';
  sentinel.style.gridColumn = '1 / -1';
  sentinel.style.height = '1px';

  const appendBatch = () => {
    const end = Math.min(shown + BATCH, filtered.length);
    const frag = document.createDocumentFragment();
    const wrap = document.createElement('div');
    wrap.style.display = 'contents';
    wrap.innerHTML = filtered.slice(shown, end).map(n =>
      `<button class="icon-picker-btn" data-name="${escHtml(n)}" title="${escHtml(n)}"><i class="bi bi-${escHtml(n)}"></i></button>`
    ).join('');
    while (wrap.firstChild) frag.appendChild(wrap.firstChild);
    grid.insertBefore(frag, sentinel);
    shown = end;
    status.textContent = shown < filtered.length
      ? `Showing ${shown} of ${filtered.length} — scroll for more`
      : `${filtered.length} icon${filtered.length === 1 ? '' : 's'}`;
  };

  // The grid itself is the scrolling container (overflow-y:auto in CSS).
  const observer = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => {
        for (const ent of entries) {
          if (ent.isIntersecting && shown < filtered.length) appendBatch();
        }
      }, { root: grid, rootMargin: '300px' })
    : null;

  const reset = (filter) => {
    const q = (filter || '').trim().toLowerCase();
    filtered = q ? names.filter(n => n.includes(q)) : names;
    shown = 0;
    grid.innerHTML = '';
    grid.appendChild(sentinel);
    if (observer) { observer.disconnect(); observer.observe(sentinel); }
    appendBatch();
    // If the first batch didn't fill the scroll area, the sentinel stays in
    // view; the observer does not re-fire for an element that never left.
    // Keep appending until the grid is scrollable or everything is shown.
    let guard = 20;
    while (guard-- > 0 && shown < filtered.length && grid.scrollHeight <= grid.clientHeight + 10) {
      appendBatch();
    }
    // Scroll-listener fallback if IntersectionObserver isn't available.
    if (!observer && !grid._iconScrollBound) {
      grid._iconScrollBound = true;
      grid.addEventListener('scroll', () => {
        if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 300 && shown < filtered.length) {
          appendBatch();
        }
      });
    }
  };

  reset('');
  input.value = '';
  input.oninput = () => reset(input.value);
  bsModal('#iconPickerModal').show();
  setTimeout(() => input.focus(), 150);
}

function bsModal(selector) {
  const el = document.querySelector(selector);
  if (!el || !window.bootstrap) return { show(){}, hide(){} };
  return window.bootstrap.Modal.getOrCreateInstance(el);
}

// ---------- Export / Import templates ----------

const EXPORT_FORMAT = 'p780bt-templates/v1';

function exportTemplates() {
  const list = loadTemplates();
  if (list.length === 0) {
    showToast('No templates to export', 'info');
    return;
  }
  const payload = {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    count: list.length,
    templates: list,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `p780bt-templates-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the download actually starts
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${list.length} template${list.length === 1 ? '' : 's'}`, 'success');
}

function triggerImportPicker() {
  const input = document.getElementById('templateImportFile');
  if (!input) return;
  input.value = '';  // reset so selecting the same file re-fires change
  input.click();
}

async function handleImportFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (e) {
    showToast('Could not read the file', 'error');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    showToast('Invalid JSON file', 'error');
    return;
  }
  // Accept two shapes:
  //   1) { format: 'p780bt-templates/v1', templates: [...] }
  //   2) a bare array [...]
  let incoming;
  if (Array.isArray(parsed)) incoming = parsed;
  else if (parsed && Array.isArray(parsed.templates)) incoming = parsed.templates;
  else {
    showToast('Unrecognized file format', 'error');
    return;
  }

  const validated = incoming
    .map(validateTemplateShape)
    .filter(Boolean);

  if (validated.length === 0) {
    showToast('No valid templates found in the file', 'error');
    return;
  }

  // Show summary in the modal and wait for user choice.
  const summaryEl = document.getElementById('templateImportSummary');
  if (summaryEl) {
    const skipped = incoming.length - validated.length;
    summaryEl.innerHTML = `
      Found <b>${validated.length}</b> valid template${validated.length === 1 ? '' : 's'}
      from <code>${escHtml(file.name)}</code>
      ${skipped > 0 ? ` · <span class="text-warning">${skipped} skipped</span>` : ''}.
    `;
  }
  const confirmBtn = document.getElementById('templateImportConfirm');
  const modal = bsModal('#templateImportModal');
  confirmBtn.onclick = () => {
    const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'merge';
    applyImport(validated, mode);
    modal.hide();
  };
  modal.show();
}

function validateTemplateShape(t) {
  if (!t || typeof t !== 'object') return null;
  if (!Array.isArray(t.elements)) return null;
  const widthMm  = toInt(t.widthMm, 40);
  const heightMm = toInt(t.heightMm, 25);
  if (widthMm <= 0 || heightMm <= 0) return null;
  // Re-assign a fresh id so imports never collide with existing ones.
  return {
    id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: String(t.name || 'Imported').slice(0, 60),
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    widthMm,
    heightMm,
    dither: ['threshold', 'floyd', 'atkinson', 'none'].includes(t.dither) ? t.dither : 'threshold',
    elements: t.elements
      .filter(e => e && typeof e === 'object' && typeof e.type === 'string')
      .map((e, i) => ({
        id: 'el_imp_' + i + '_' + Math.random().toString(36).slice(2, 6),
        ...e,
      })),
    thumbnail: typeof t.thumbnail === 'string' && t.thumbnail.startsWith('data:image/') ? t.thumbnail : '',
  };
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function applyImport(incoming, mode) {
  const existing = loadTemplates();
  const merged = mode === 'replace' ? incoming : [...incoming, ...existing];
  if (merged.length > TEMPLATES_MAX) {
    showToast(`Cannot hold more than ${TEMPLATES_MAX} templates. Delete some and try again.`, 'error');
    return;
  }
  const ok = saveTemplatesList(merged);
  if (ok) {
    showToast(`Imported ${incoming.length} template${incoming.length === 1 ? '' : 's'}`, 'success');
    renderTemplatesGallery();
  }
}

// ---------- Toast ----------

function showToast(msg, kind = 'info', opts = {}) {
  const cont = qs('#toastContainer');
  if (!cont) { console.warn('toast:', msg); return; }
  const cls = { info: 'text-bg-secondary', success: 'text-bg-success', error: 'text-bg-danger' }[kind] || 'text-bg-secondary';
  const icon = { info: 'bi-info-circle-fill', success: 'bi-check-circle-fill', error: 'bi-exclamation-triangle-fill' }[kind] || 'bi-info-circle-fill';
  const div = document.createElement('div');
  div.className = `toast align-items-center ${cls} border-0`;
  div.setAttribute('role', 'alert');
  // P1.20 — optional action button appended to the toast body.
  const actionHtml = opts.action && opts.action.label
    ? `<button type="button" class="btn btn-light btn-sm toast-action ms-2" data-toast-action>${escHtml(opts.action.label)}</button>`
    : '';
  div.innerHTML = `
    <div class="d-flex">
      <div class="toast-body d-flex align-items-center"><i class="bi ${icon} me-2"></i><span class="flex-grow-1">${escHtml(msg)}</span>${actionHtml}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  cont.appendChild(div);
  let toastInst;
  try {
    toastInst = new bootstrap.Toast(div, { delay: opts.delay || 4000 });
    toastInst.show();
    div.addEventListener('hidden.bs.toast', () => div.remove());
  } catch {
    setTimeout(() => div.remove(), opts.delay || 4000);
  }
  if (opts.action && typeof opts.action.onClick === 'function') {
    const actionBtn = div.querySelector('[data-toast-action]');
    actionBtn?.addEventListener('click', () => {
      try { opts.action.onClick(); } catch {}
      try { toastInst?.hide(); } catch {}
    });
  }
}
// Expose for other scripts (e.g. app.js verifyPrinterIdentity)
window.showToast = showToast;

// ---------- UI refs / init ----------

const dui = {};
const qs  = sel => document.querySelector(sel);
const qsa = sel => Array.from(document.querySelectorAll(sel));

function initLabelDesigner() {
  dui.widthMm = qs('#lblWidthMm');
  dui.heightMm = qs('#lblHeightMm');
  dui.dither = qs('#lblDither');
  dui.canvas = qs('#labelCanvas');
  dui.elementsList = qs('#elementsList');
  dui.designerSizeHint = qs('#designerSizeHint');
  dui.previewPxHint = qs('#previewPxHint');
  dui.queueList = qs('#queueList');
  dui.queueCount = qs('#queueCount');
  dui.qContinuous = qs('#qContinuous');
  dui.btnPrintQueue = qs('#btnPrintQueue');
  dui.btnClearQueue = qs('#btnClearQueue');

  if (!dui.canvas) return;

  // Add dropdown
  qsa('[data-add]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const t = a.dataset.add;
      if (t === 'gap') return;  // gap is no longer used
      if (t === 'icon') {
        openIconPicker((name) => {
          const el = defaultElement('icon');
          el.name = name;
          state.elements.push(el);
          state.selectedId = el.id;
          renderPreview();
          buildElementsList();
        });
        return;
      }
      const el = defaultElement(t);
      state.elements.push(el);
      state.selectedId = el.id;
      renderPreview();
      buildElementsList();
    });
  });

  // Size/dither — renderPreview() also refreshes the mismatch alert.
  [dui.widthMm, dui.heightMm, dui.dither].forEach(inp => inp.addEventListener('input', renderPreview));
  // P0.2 — button inside the mismatch alert syncs the designer's cartridge
  // width to the one the printer reports, then triggers a re-render.
  const btnCartSwitch = document.getElementById('btnCartridgeSwitch');
  if (btnCartSwitch) {
    btnCartSwitch.addEventListener('click', () => {
      const detected = currentCartridgeWidthMm;
      if (!detected) return;
      ensureCartridgeOption(dui.heightMm, detected);
      // Dispatch both 'input' and 'change' so any listener (whichever it
      // was wired with) picks up the programmatic change.
      dui.heightMm.dispatchEvent(new Event('input', { bubbles: true }));
      dui.heightMm.dispatchEvent(new Event('change', { bubbles: true }));
      renderPreview();
    });
  }

  // Grid / snap / center — toolbar
  const chkGrid = qs('#chkGrid');
  const chkSnap = qs('#chkSnap');
  const chkShowMm = qs('#chkShowMm');
  if (chkGrid) chkGrid.addEventListener('change', () => { state.showGrid = chkGrid.checked; renderPreview(); });
  if (chkSnap) chkSnap.addEventListener('change', () => { state.snap = chkSnap.checked; });
  // P1.11 — unit toggle forces a full inspector rebuild so values get
  // re-rendered in the new unit (px <-> mm).
  if (chkShowMm) chkShowMm.addEventListener('change', () => {
    state.showMm = chkShowMm.checked;
    buildElementsList();
  });
  qs('#btnCenterH')?.addEventListener('click', () => centerSelected('h'));
  qs('#btnCenterV')?.addEventListener('click', () => centerSelected('v'));
  qs('#btnCenterBoth')?.addEventListener('click', () => centerSelected('both'));

  // Canvas interactions
  dui.canvas.addEventListener('mousedown', onCanvasMouseDown);
  window.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup', onCanvasMouseUp);

  // Buttons
  qs('#btnAddToQueue').addEventListener('click', () => addToQueue());
  qs('#btnClearDesigner').addEventListener('click', () => {
    // P0.3 — nothing to clear → just reset without a confirm dialog.
    if (state.elements.length === 0) {
      state.selectedId = null;
      renderPreview();
      buildElementsList();
      return;
    }
    const countEl = document.getElementById('clearDesignerCount');
    if (countEl) countEl.textContent = state.elements.length;
    const modalEl = document.getElementById('clearDesignerModal');
    const confirmBtn = document.getElementById('clearDesignerConfirm');
    if (!modalEl || !confirmBtn || !window.bootstrap) {
      // Fall back to a non-modal clear if the modal markup is missing.
      state.elements = [];
      state.selectedId = null;
      renderPreview();
      buildElementsList();
      return;
    }
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const onConfirm = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      state.elements = [];
      state.selectedId = null;
      renderPreview();
      buildElementsList();
      modal.hide();
    };
    confirmBtn.addEventListener('click', onConfirm);
    modal.show();
  });
  dui.btnPrintQueue.addEventListener('click', confirmAndPrintQueue);
  dui.btnClearQueue.addEventListener('click', () => {
    queue.length = 0;
    buildQueueList();
  });

  // Templates
  qs('#btnSaveTemplate')?.addEventListener('click', openSaveModal);
  qs('#btnNewFromDesigner')?.addEventListener('click', () => {
    // Switch to designer if empty, else open save dialog from Templates tab
    if (state.elements.length === 0) {
      document.getElementById('nav-design-btn')?.click();
      showToast('Design a label first, then press "Save as template"', 'info');
    } else {
      openSaveModal();
    }
  });
  const tplSearch = qs('#templateSearch');
  const tplSearchClear = qs('#templateSearchClear');
  if (tplSearch) {
    tplSearch.addEventListener('input', () => {
      templateSearchTerm = tplSearch.value || '';
      if (tplSearchClear) tplSearchClear.classList.toggle('d-none', !templateSearchTerm);
      renderTemplatesGallery();
    });
  }
  if (tplSearchClear) {
    tplSearchClear.addEventListener('click', () => {
      if (tplSearch) tplSearch.value = '';
      templateSearchTerm = '';
      tplSearchClear.classList.add('d-none');
      renderTemplatesGallery();
    });
  }

  // Export / Import
  qs('#btnExportTemplates')?.addEventListener('click', exportTemplates);
  qs('#btnImportTemplates')?.addEventListener('click', triggerImportPicker);
  const importFile = qs('#templateImportFile');
  importFile?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleImportFile(f);
  });
  // Re-render gallery when switching to Templates tab
  const tplTabBtn = document.getElementById('nav-templates-btn');
  tplTabBtn?.addEventListener('shown.bs.tab', renderTemplatesGallery);

  // Enter key in the name modal submits the dialog
  const nameInput = document.getElementById('templateNameInput');
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('templateNameModalConfirm')?.click();
    }
  });

  // Delete key — remove the selected element
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!state.selectedId) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const idx = state.elements.findIndex(el => el.id === state.selectedId);
    if (idx >= 0) {
      state.elements.splice(idx, 1);
      state.selectedId = null;
      renderPreview();
      buildElementsList();
    }
  });

  // P1.21 — global keyboard shortcuts + help popover.
  const isTypingInto = (t) => t && t.matches && t.matches('input,textarea,select');
  document.addEventListener('keydown', (e) => {
    // Shortcuts that must work even while typing.
    if (e.key === 'Escape') {
      if (state.selectedId) {
        state.selectedId = null;
        renderPreview();
        buildElementsList();
      }
      return;
    }
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      // Only if not typing; otherwise ? is a valid character.
      if (isTypingInto(e.target)) return;
      const btn = document.getElementById('btnShortcutsHelp');
      if (btn && window.bootstrap) {
        const pop = bootstrap.Popover.getOrCreateInstance(btn);
        pop.toggle();
      }
      e.preventDefault();
      return;
    }
    // Everything below is guarded against form-input focus.
    if (isTypingInto(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      openSaveModal();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      addToQueue();
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      confirmAndPrintQueue();
    }
  });

  // Help popover — init once from JS (HTML-attribute auto-init is intentionally
  // avoided so we don't end up with two Popover instances on the same button).
  // `sanitize: false` is required because the content contains <kbd> tags; the
  // content is a hard-coded template literal with no user input flowing in.
  const helpBtn = document.getElementById('btnShortcutsHelp');
  if (helpBtn && window.bootstrap) {
    const content = `
      <dl class="kbd-list mb-0">
        <dt><kbd>Ctrl</kbd>+<kbd>S</kbd></dt><dd>Save as template</dd>
        <dt><kbd>Ctrl</kbd>+<kbd>Enter</kbd></dt><dd>Add to queue</dd>
        <dt><kbd>Ctrl</kbd>+<kbd>P</kbd></dt><dd>Print queue</dd>
        <dt><kbd>Esc</kbd></dt><dd>Deselect</dd>
        <dt><kbd>Del</kbd></dt><dd>Remove selected element</dd>
        <dt><kbd>?</kbd></dt><dd>Show this help</dd>
      </dl>`;
    new bootstrap.Popover(helpBtn, {
      title: 'Keyboard shortcuts',
      content,
      html: true,
      sanitize: false,
      placement: 'bottom',
      trigger: 'click',
    });
  }

  buildElementsList();
  renderPreview();
  buildQueueList();
  renderTemplatesGallery();
  setInterval(updateQueueUI, 500);
}

// (DOMContentLoaded is registered once at the top of the merged script —
// it calls `main()` followed by `initLabelDesigner()`.)
