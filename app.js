// =====================================================================
//  BT Label Printer — UI, designer, queue, templates
// ---------------------------------------------------------------------
//  Author:   Oleksandr Luzin <https://luzin.cc>
//  Source:   https://luzin.cc
//  License:  MIT
// ---------------------------------------------------------------------
//  This module is everything UI-shaped: Web Serial UX (status badge,
//  Connect / Disconnect, Advanced log), the label designer canvas,
//  the element inspector, the print queue, and template CRUD.
//
//  Anything printer-specific — protocol bytes, response decoding,
//  identity check, raster layout, the print-job pipeline — lives in
//  `./printer/*.js` behind the Driver contract. This file talks to
//  the driver instance through events + high-level method calls;
//  swapping to a different model is a matter of registering a
//  different driver id in `./printer/index.js`.
//
//  The app is loaded as an ES module (`<script type="module">` in
//  index.html). That means it must be served over http(s) — Chrome
//  blocks module loading from `file://` URLs by default. The README
//  recommends `python -m http.server 8000` for local dev.
// =====================================================================

'use strict';

import { createDriver } from './printer/index.js';

// ---------------------------------------------------------------------
//  Printer driver
// ---------------------------------------------------------------------
//  All protocol bytes, frame decoding, identity check, raster layout
//  and the print-job pipeline live in `./printer/*.js` behind the
//  Driver contract. Swapping in a new model is a matter of registering
//  a different driver id in `./printer/index.js` — the UI code below
//  never references P780BT-specific bytes.
// ---------------------------------------------------------------------

// ---------- Driver selection (auto-detect + persistence) ----------
//
// The user's printer model determines which driver subclass we
// instantiate (DPI, pager bytes, etc. differ). We can't swap drivers
// in the middle of a session without rebuilding designer state, so
// the UX is: probe on first connect, persist the chosen driver id to
// localStorage, and on subsequent sessions skip the probe by loading
// the saved id at module init.
//
// Source of truth, in priority order:
//   1. `?driver=<id>` URL query — override for power users who want
//      to force a specific driver (also how the auto-reload below
//      redirects the user after a model is detected).
//   2. `localStorage.btprinter.driverId` — remembered from a prior
//      successful connect.
//   3. 'p780bt' — default. Anyone without saved state starts here.
//
// If identity check then fails because the printer is a DIFFERENT
// known model, the identity-failed listener below saves the correct
// driver id and reloads. The user sees one "Switching driver…" toast
// and their next connect click works straight away. Reloads happen
// at most once per printer-swap.

const DRIVER_ID_STORAGE_KEY = 'btprinter.driverId';

function pickDriverId() {
  try {
    const urlId = new URLSearchParams(location.search).get('driver');
    if (urlId) return urlId;
  } catch {}
  try {
    const savedId = localStorage.getItem(DRIVER_ID_STORAGE_KEY);
    if (savedId) return savedId;
  } catch {}
  return 'p780bt';
}

let currentDriverId = pickDriverId();
let driver;
try {
  driver = createDriver(currentDriverId);
} catch (e) {
  // Saved / URL driver id is unknown (e.g. user edited localStorage,
  // or the id was removed). Fall back to the default and drop the
  // stale persisted value so we don't loop.
  console.warn(`[BTPrinter] ${e.message}. Falling back to p780bt.`);
  try { localStorage.removeItem(DRIVER_ID_STORAGE_KEY); } catch {}
  currentDriverId = 'p780bt';
  driver = createDriver(currentDriverId);
}

// Stash the active driver + id on the debug namespace so it's reachable
// from DevTools (`BTPrinter.driver.readAll()` etc).
if (window.BTPrinter) {
  window.BTPrinter.driver = driver;
  window.BTPrinter.driverId = currentDriverId;
}

// ---------- Utilities used by UI logging ----------

const hex    = b   => b.toString(16).padStart(2, '0');
const hexStr = arr => Array.from(arr, hex).join(' ');

// Physical tape width (in mm) of the cartridge currently loaded in the
// printer, or null when no cartridge is present / not yet read. Set from
// tag 0x40 on every material-detail response; consumed by the designer's
// cartridge-width validation and the mismatch banner.
let currentCartridgeWidthMm = null;

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

// Build the command-button list from whatever GET commands the active
// driver supports. The button builder is model-agnostic — as long as
// the driver exposes `{ name, cmd, needsCartridge? }` entries, this
// renders them identically for any printer.
function buildCommandButtons() {
  ui.cmdButtons.innerHTML = '';
  for (const c of driver.commands) {
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
  ui.cmdCount.textContent = String(driver.commands.length);
}

function setButtonsEnabled(enabled) {
  $$('#cmdButtons .btn').forEach(b => b.disabled = !enabled);
  ui.btnReadAll.disabled = !enabled;
  // Write controls are enabled only when both the connection is open and write mode is on
  const writeOn = enabled && isWriteUnlocked();
  $$('[data-write-control]').forEach(el => el.disabled = !writeOn);
}

function buildSettingsUi() {
  // Auto power — select. Options come from the driver so a model with
  // a different ladder of allowed values renders the right dropdown.
  const apSel = document.querySelector('#selAutoPower');
  if (apSel) {
    apSel.innerHTML = driver.autoPowerOptions.map(o =>
      `<option value="${o.value}">${o.label}</option>`).join('');
  }
  // Paper type — select (driver-provided for the same reason).
  const ptSel = document.querySelector('#selPaperType');
  if (ptSel) {
    ptSel.innerHTML = driver.paperTypeOptions.map(o =>
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

  // Actions — build the buttons dynamically from the driver's action
  // list. Each action entry carries its own label / hint / danger flag
  // so this loop stays identical across models.
  const actBox = document.querySelector('#actionButtons');
  if (actBox) {
    actBox.innerHTML = '';
    for (const [name, a] of Object.entries(driver.actions)) {
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
      const portOpen = driver.isConnected;
      $$('[data-write-control]').forEach(el => el.disabled = !(portOpen && sw.checked));
      applyTuningVisibility();
      logLine('info', `Write mode: ${sw.checked ? 'ON' : 'OFF'}`);
    });
  }
}

// ---------- Exchange logic ----------

// Shared across the merged script so designer / queue sections can
// funnel diagnostic lines into the same Advanced panel.
const logInfo  = (text) => logLine('info', text);
const logError = (text) => logLine('error', text);

// ---------- Driver event → UI wiring ----------
//
// All protocol detail lives inside the driver; here we only translate
// high-level events into DOM updates: status badge, the shimmer, the
// battery bar, the material swatches, the Advanced log, and the
// wrong-endpoint modal.

driver.addEventListener('connected', (ev) => {
  const info = (ev.detail && ev.detail.info) || {};
  setStatus('connected', info.usbProductId ? `USB ${info.usbProductId}` : 'connected');
  setButtonsEnabled(true);
  // Show shimmer skeletons in the status strip until READ ALL populates it.
  const strip = document.getElementById('statusStrip');
  if (strip) {
    strip.classList.add('is-loading');
    strip.setAttribute('aria-busy', 'true');
  }
  logLine('info', 'Connected.');
  // Remember the driver id that successfully identified a printer —
  // next session will pick this up from localStorage via
  // pickDriverId() and skip the identity-failed → reload dance even
  // if the original URL query had it set explicitly.
  try { localStorage.setItem(DRIVER_ID_STORAGE_KEY, currentDriverId); } catch {}
  // Auto-refresh key printer data so the status strip and cards
  // populate immediately instead of showing "—" until READ ALL.
  driver.readAll().catch(() => {});
});

driver.addEventListener('disconnected', () => {
  setStatus('disconnected', 'disconnected');
  setButtonsEnabled(false);
  // Clean the exchange log on disconnect so a fresh session starts
  // with a blank scrollback instead of accumulating forever.
  if (ui.log) ui.log.innerHTML = '';
  // Remove the shimmer just in case we disconnected before READ ALL.
  const strip = document.getElementById('statusStrip');
  if (strip) {
    strip.classList.remove('is-loading');
    strip.removeAttribute('aria-busy');
  }
  logLine('info', 'Disconnected');
});

driver.addEventListener('tx',  (ev) => logLine('tx', `TX: ${hexStr(ev.detail.bytes)}`));
driver.addEventListener('rx',  (ev) => logLine('rx', `RX: ${hexStr(ev.detail.bytes)}`));
driver.addEventListener('log', (ev) => {
  const kind = ev.detail.level === 'error' ? 'error' : 'info';
  logLine(kind, ev.detail.text);
});
driver.addEventListener('error', (ev) => {
  logLine('error', 'ERROR: ' + ev.detail.message);
  setStatus('error', 'error');
});

// Identity-failed handler. Three scenarios, in order of preference:
//
//   1. The driver recognised the SN as a KNOWN model, and we have a
//      driver for that model that's NOT the currently-active one.
//      Save the correct driver id to localStorage and auto-reload
//      the page — on the next load, `pickDriverId()` will pick the
//      saved id and the connection will succeed straight away.
//      User sees a single "Detected X, switching driver…" toast
//      and a ~1s reload. One-time cost per printer-swap.
//
//   2. The SN was recognised but we haven't written a driver for it
//      (detected.vendorModel present, detected.driverId null), OR
//      the SN was unrecognised entirely. Surface the reason both in
//      the Advanced log AND inline in the wrong-endpoint modal so
//      the user sees the specific model name / error.
//
//   3. Something threw inside identity check (no `detected` field).
//      Fall through to the modal with the raw reason.
driver.addEventListener('identity-failed', (ev) => {
  const reason   = ev.detail.reason   || 'Identity check failed.';
  const detected = ev.detail.detected || null;
  logLine('error', 'Identity check failed: ' + reason);

  // Path 1 — auto-swap driver via reload.
  if (detected && detected.driverId && detected.driverId !== currentDriverId) {
    try {
      localStorage.setItem(DRIVER_ID_STORAGE_KEY, detected.driverId);
    } catch {}
    const model = detected.vendorModel || detected.driverId;
    logLine('info', `Saving driver choice "${detected.driverId}" for ${model}, reloading…`);
    if (typeof window.showToast === 'function') {
      window.showToast(`Detected ${model} — switching driver…`, 'info');
    }
    setTimeout(() => { try { location.reload(); } catch {} }, 1200);
    return;
  }

  // Paths 2 + 3 — show the modal with the reason.
  try {
    const reasonEl = document.getElementById('wrongEndpointReason');
    if (reasonEl) reasonEl.textContent = reason;
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
});

// Frame → UI updates. The driver hands us the decoded payload
// (`fields`, `swatches`, `batteryPct`, `materialEmpty`,
// `cartridgeWidthMm`); our job is to paint the DOM.
driver.addEventListener('frame', (ev) => {
  const { tag, payload, fields, swatches, batteryPct, batteryMarker, materialEmpty, cartridgeWidthMm } = ev.detail;
  const fieldsStr = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('  ');
  logLine('frame', `FRAME tag=0x${hex(tag)} ${fieldsStr}  (payload: ${hexStr(payload) || '—'})`);

  for (const [k, v] of Object.entries(fields)) setField(k, v);

  if (swatches) {
    for (const [k, color] of Object.entries(swatches)) {
      // Some swatches (e.g. material_bg) are rendered in TWO places:
      // the compact strip at the top of the page AND the Paper &
      // cartridge card on the Printer tab — use querySelectorAll so
      // every occurrence is tinted.
      const els = document.querySelectorAll(`[data-swatch="${k}"]`);
      els.forEach(sw => { sw.style.background = color || 'transparent'; });
    }
  }
  if (batteryPct !== undefined) {
    const pct = Math.max(0, Math.min(100, batteryPct));
    ui.batteryBar.style.width = `${pct}%`;
    ui.batteryBar.classList.remove('bg-success', 'bg-warning', 'bg-danger');
    ui.batteryBar.classList.add(pct > 50 ? 'bg-success' : pct > 20 ? 'bg-warning' : 'bg-danger');
  }
  if (batteryMarker !== undefined) {
    const pct = { 0xA1: 90, 0xA2: 50, 0xA3: 20, 0xA4: 0 }[batteryMarker] ?? 0;
    ui.batteryBar.style.width = `${pct}%`;
    ui.batteryBar.classList.remove('bg-success', 'bg-warning', 'bg-danger');
    ui.batteryBar.classList.add(pct > 50 ? 'bg-success' : pct > 20 ? 'bg-warning' : 'bg-danger');
  }
  if (tag === 0x40) {
    ui.materialHint.classList.remove('text-bg-secondary', 'text-bg-success', 'text-bg-warning');
    if (materialEmpty) {
      ui.materialHint.textContent = 'cartridge not detected';
      ui.materialHint.classList.add('text-bg-warning');
      currentCartridgeWidthMm = null;
    } else {
      ui.materialHint.textContent = 'read';
      ui.materialHint.classList.add('text-bg-success');
      currentCartridgeWidthMm = cartridgeWidthMm ?? null;
    }
    if (typeof updateCartridgeMismatch === 'function') updateCartridgeMismatch();
  }

  // Reflect live printer values into the corresponding Settings
  // dropdowns without stealing focus from the user.
  const setSelectIfIdle = (sel, value) => {
    if (!sel) return;
    if (document.activeElement === sel) return;
    const opt = Array.from(sel.options).find(o => String(o.value) === String(value));
    if (opt) sel.value = String(value);
  };
  if (tag === 0x09 && payload && payload.length) {
    // AUTO_POWER_TIME response: raw byte maps to the option values in the dropdown
    setSelectIfIdle(document.getElementById('selAutoPower'), payload[0]);
  }
  if (tag === 0x0C && payload && payload.length) {
    // LABEL_TYPE response: value IS the byte
    setSelectIfIdle(document.getElementById('selPaperType'), payload[0]);
  }
});

// ---------- UI-level command wrappers ----------
//
// The driver exposes pure `sendCommand / applySetting / applyAction /
// readAll` methods. These wrappers add the write-mode gate and the
// danger-action confirm dialog — both are UI concerns, not protocol
// concerns, so they stay here.

async function sendCommand(cmd) {
  try { await driver.sendCommand(cmd); }
  catch (e) { logLine('error', 'TX fail: ' + e.message); }
}

function isWriteUnlocked() {
  return !!document.querySelector('#writeMode')?.checked;
}

async function applySetting(name, valueByte) {
  if (!isWriteUnlocked()) {
    logLine('error', 'Write mode is off — toggle the switch in the navbar');
    return false;
  }
  return driver.applySetting(name, valueByte);
}

async function applyAction(name) {
  if (!isWriteUnlocked()) {
    logLine('error', 'Write mode is off — toggle the switch in the navbar');
    return;
  }
  const act = driver.actions[name];
  if (act && act.danger) {
    const ok = confirm(`Run "${act.label}"?\n\n${act.hint}`);
    if (!ok) { logLine('info', `${name} cancelled`); return; }
  }
  return driver.applyAction(name);
}

async function readAll() {
  return driver.readAll();
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

  // Hero Connect CTA: connect only (Disconnect lives in the navbar
  // and has its own handler below). On success the driver's 'connected'
  // event listener already flipped the UI and kicked off readAll.
  // On failure the 'identity-failed' listener may have shown the
  // wrong-endpoint modal; if the driver emitted 'disconnected' that
  // listener resets the badge too. But `requestPort()` can reject
  // BEFORE any driver event fires — most commonly when the user
  // dismisses the browser's BT picker without choosing anything
  // (Chrome throws `NotFoundError: No port selected by the user`).
  // If we don't flip the status back to disconnected here, the badge
  // stays on "connecting" and the hero button stays `.disabled`
  // forever — the user ends up stuck on the pre-connect screen with
  // no clickable control.
  ui.btnConnect.addEventListener('click', async () => {
    if (driver.isConnected) return;   // defensive; hero is hidden while connected
    try {
      setStatus('connecting', 'connecting…');
      await driver.connect();
    } catch (e) {
      // Reset the UI to disconnected so the hero Connect button
      // becomes clickable again.
      setStatus('disconnected', 'disconnected');
      // Silent path for the user-cancelled picker — no log spam,
      // no error badge. Everything else (device unreachable,
      // identity check failed, etc.) still gets logged.
      if (e && e.name === 'NotFoundError') {
        logLine('info', 'Connect cancelled (no port selected).');
      } else {
        logLine('error', e.message || String(e));
      }
    }
  });

  // Navbar Disconnect button. We flip the UI synchronously instead of
  // waiting for the 'disconnected' event: the read loop can take a
  // moment to unwind after cancel(), and without this nudge the
  // status badge stays green long enough for the `.connected-only`
  // panels (view pills, gear, Disconnect itself) to look stuck. The
  // later 'disconnected' event just re-applies the same state —
  // idempotent.
  if (ui.btnDisconnect) {
    ui.btnDisconnect.addEventListener('click', async () => {
      setStatus('disconnected', 'disconnected');
      try { await driver.disconnect(); }
      catch (e) { logLine('error', e.message); }
    });
  }

  ui.btnReadAll.addEventListener('click', readAll);
  ui.btnClearLog.addEventListener('click', () => { ui.log.innerHTML = ''; });

  // Close the port when the tab is closed.
  window.addEventListener('beforeunload', () => {
    try { driver.disconnect(); } catch {}
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
// Label Designer + Print Queue (free positioning).
// - Elements have x, y (in px from the label's top-left corner)
// - Barcode/QR/DataMatrix: explicit w, h; drag in the body = move, at the corner = resize
// - Text: x, y; size driven by fontSize; w/h are computed from the text
// - bwip-js errors are shown as Bootstrap toasts instead of being "baked"
//   into the canvas.
// Shares `driver`, `logInfo`, `logError`, `currentCartridgeWidthMm` with
// the Web Serial section above — same script, single module scope.
// =====================================================================

// ---------- Constants ----------

// Designer renders directly at the printer's native effective DPI so the
// raster pipeline stays a pure 1:1 pass-through (no scale mismatch). DPI
// comes from the active driver, so swapping to a 203-dpi printer later
// just requires changing the driver id in `./printer/index.js`.
const DPI = driver.dpi;
const PX_PER_MM = driver.pxPerMm;

const HANDLE_SIZE = 10;             // px — resize handle box

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
  // ID of the template currently loaded into the designer (or null for a
  // blank canvas). Drives the header "Editing template" badge plus the
  // three-way save-button swap (Save as template / Save changes / Save
  // as new). Reset by Clear and by Save-as-new (the freshly-created
  // template becomes the new open one).
  openTemplateId: null,
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

  // Sync every mm placeholder across the designer card — both the
  // header size hint (`L mm long × W mm wide`) and the cartridge
  // diagram labels (`Width N mm`, `Length N mm`) share `[data-role="l"]`
  // / `[data-role="w"]` spans. A card-wide querySelectorAll updates
  // both in one pass.
  document.querySelectorAll('[data-role="l"]').forEach(el => { el.textContent = state.widthMm; });
  document.querySelectorAll('[data-role="w"]').forEach(el => { el.textContent = state.heightMm; });
  // Legacy consumers that expect the old " — × — " format still get a
  // sensible fallback if the span markup ever goes missing.
  if (dui.designerSizeHint && !dui.designerSizeHint.querySelector('[data-role="l"]')) {
    dui.designerSizeHint.textContent = `${state.widthMm} × ${state.heightMm} mm`;
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

  // -----------------------------------------------------------------
  // Viewport-anchored drag math.
  //
  // The old implementation read canvasCoords(evt) — which calls
  // getBoundingClientRect() every mousemove — and compared it against
  // a dragOffset captured at mousedown. If ANYTHING between those two
  // calls changed the canvas's viewport rect (inspector popping in
  // below, scrollbar appearing, a row being added above, etc.) the
  // next move sampled an incorrect canvas-local point and the
  // element jumped.
  //
  // Instead, snapshot the starting cursor position in VIEWPORT
  // coordinates (evt.clientX/Y) and the element's starting
  // position/size. During mousemove, compute a delta against the
  // starting clientX/Y and apply it to the starting position. The
  // canvas rect doesn't appear in the hot path at all, so page
  // reflows can't corrupt the drag.
  //
  // `canvasScale` compensates for CSS-scaled canvases: if the canvas's
  // drawing buffer is wider than its display box (e.g. on narrow
  // viewports where `max-width: 100%` shrinks it), viewport pixels
  // differ from buffer pixels. Captured once at mousedown and reused
  // for the whole drag so mid-drag layout changes can't bend it.
  // -----------------------------------------------------------------
  const rect = dui.canvas.getBoundingClientRect();
  const canvasScaleX = rect.width  ? dui.canvas.width  / rect.width  : 1;
  const canvasScaleY = rect.height ? dui.canvas.height / rect.height : 1;

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
  } else {
    dragMode = 'move';
  }

  // Single source of truth for the whole drag — viewport start coords,
  // element's starting layout, and a cached scale. Re-used read-only
  // in onCanvasMouseMove.
  dragOffset = {
    startClientX: evt.clientX,
    startClientY: evt.clientY,
    startElX: hit.el.x,
    startElY: hit.el.y,
    canvasScaleX,
    canvasScaleY,
  };

  dui.canvas.style.cursor = dragMode === 'resize' ? 'nwse-resize' : 'grabbing';
  // Leave the popover visible (whatever element it currently shows)
  // while the user drags on the canvas. It's anchored to the static
  // list row, not to the moving canvas element, so it doesn't lag
  // or jitter — it just stays put. Content updates happen on
  // mouseup so the user sees a clean "released → popover reflects
  // new selection" transition rather than flickering mid-drag.
  renderPreview();
  // Highlight the row for the newly-picked element so the left list
  // reflects the in-progress selection. Avoids a full list rebuild
  // (which would detach handlers + reposition the popover).
  syncListRowSelection();
}

/** Update just the `.element-selected` class on the left-hand list so
 *  it mirrors state.selectedId, without rebuilding rows (which would
 *  detach event listeners mid-drag). */
function syncListRowSelection() {
  const list = dui.elementsList;
  if (!list) return;
  list.querySelectorAll('.element-row.element-selected').forEach(r => r.classList.remove('element-selected'));
  if (state.selectedId) {
    const row = list.querySelector(`.element-row[data-id="${state.selectedId}"]`);
    if (row) row.classList.add('element-selected');
  }
}

function onCanvasMouseMove(evt) {
  if (!dragMode) {
    // Hover state — use canvas-local coords for hit-testing + cursor.
    const p = canvasCoords(evt);
    const hit = hitTest(p.x, p.y);
    dui.canvas.style.cursor =
      hit ? (hit.part === 'handle' ? 'nwse-resize' : 'move') : 'default';
    return;
  }
  const el = state.elements.find(e => e.id === state.selectedId);
  if (!el) return;

  // Viewport-delta in buffer pixels (scale-compensated).
  const dx = (evt.clientX - dragOffset.startClientX) * dragOffset.canvasScaleX;
  const dy = (evt.clientY - dragOffset.startClientY) * dragOffset.canvasScaleY;

  const canvasSize = currentSize();

  if (dragMode === 'move') {
    let nx = Math.round(dragOffset.startElX + dx);
    let ny = Math.round(dragOffset.startElY + dy);
    const ctx = dui.canvas.getContext('2d');
    const bbox = getElementBBox({ ...el, x: nx, y: ny }, ctx);
    const snap = state.snap ? snapPosition(bbox, canvasSize.w, canvasSize.h) : { dx: 0, dy: 0, guides: [] };
    nx += snap.dx;
    ny += snap.dy;
    el.x = clamp(nx, -bbox.w, canvasSize.w);
    el.y = clamp(ny, -bbox.h, canvasSize.h);
    state.activeGuides = snap.guides;
  } else if (dragMode === 'resize') {
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
  const wasDragging = !!dragMode;
  dragMode = null;
  state.activeGuides = [];
  dui.canvas.style.cursor = 'default';
  renderPreview();
  // After a drag/resize the compact row's badge (W×H / fontSize) is
  // stale and the popover was hidden — rebuild both in one go. The
  // rebuild re-runs `renderInspector`, which repositions the popover
  // to the element's new location and fades it back in.
  if (wasDragging) buildElementsList();
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
//
// The list and the inspector are TWO separate panes (per the design
// handoff): a compact `.elements-list` on the left — one `.element-row`
// per element, just a grip + type icon + name + size badge — and a
// `.inspector` on the right that renders the full editor for whichever
// element is currently selected.
//
// `buildElementsList()` renders the list rows AND re-fills the
// inspector, so callers that previously used it as a "rebuild
// everything" entry point keep working. If you only need to refresh
// the inspector (e.g. the selection changed but the list topology
// didn't), call `renderInspector()` directly — it's cheaper.

function buildElementsList() {
  const root = dui.elementsList;
  root.innerHTML = '';
  if (state.elements.length === 0) {
    root.innerHTML = `
      <div class="elements-empty text-body-secondary text-center py-3 small">
        <i class="bi bi-plus-circle d-block mb-1" style="font-size:1.5rem"></i>
        Use the <b>Add</b> button to insert an element
      </div>`;
    renderInspector();
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
    row.innerHTML = renderElementRowCompact(el);
    row.addEventListener('click', (e) => {
      // Clicks on the grip start a drag, don't also select — pointerdown
      // already called preventDefault there.
      if (e.target.closest('.grip')) return;
      if (state.selectedId === el.id) return;
      state.selectedId = el.id;
      renderPreview();
      // Only the row's `.element-selected` highlight and the inspector's
      // contents change; the list's row topology is unaffected, so skip
      // the full `buildElementsList` and just toggle the classes +
      // refresh the inspector.
      root.querySelectorAll('.element-row.element-selected').forEach(r => r.classList.remove('element-selected'));
      row.classList.add('element-selected');
      renderInspector();
    });
    root.appendChild(row);
  }

  // Wire the `.grip` drag handles on each row for pointer-based
  // reorder. Bound on every rebuild because the old rows are gone.
  wireElementsDragReorder();

  // Keep the inspector in sync with the new list snapshot (selection
  // may have been cleared, elements may have been added / removed,
  // etc.).
  renderInspector();
}

/**
 * One compact row in the left-hand list: grip + type-tinted icon +
 * element name + size badge. No form fields, no per-element actions —
 * those live in the inspector. Returns the row's innerHTML; the
 * wrapping `.element-row[data-id=…]` is applied by the caller.
 */
function renderElementRowCompact(el) {
  const errorBadge = state.errors[el.id]
    ? ` <span class="badge text-bg-danger small ms-1" title="${escHtml(state.errors[el.id])}"><i class="bi bi-exclamation-triangle-fill"></i></span>`
    : '';
  const name = escHtml(elementRowLabel(el));
  // Size badge: W×H in px. Text-like elements don't store w/h meaningfully,
  // so show just the font size for them.
  let sizeBadge = '';
  if (isTextLike(el)) {
    sizeBadge = `${(el.fontSize | 0) || 12}pt`;
  } else {
    sizeBadge = `${(el.w | 0)}×${(el.h | 0)}`;
  }
  return `
    <span class="grip" role="button" tabindex="0" aria-label="Drag to reorder" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></span>
    <span class="etype" title="${escHtml(elementTitle(el.type))}">${elementIcon(el.type)}</span>
    <span class="ename">${name}${errorBadge}</span>
    <span class="ebadge">${sizeBadge}</span>
  `;
}

/**
 * Short human-readable label for an element — used in the compact row.
 * Text-like elements surface their content; other elements fall back
 * to their type title.
 */
function elementRowLabel(el) {
  if (!el) return '';
  if (el.type === 'text' && el.text)    return el.text;
  if (el.type === 'counter')            return elementText(el, 0) || 'Counter';
  if (el.type === 'barcode' && el.data) return `Barcode · ${el.data}`;
  if (el.type === 'qr' && el.kind)      return `QR · ${el.kind}`;
  if (el.type === 'datamatrix' && el.data) return `DM · ${el.data}`;
  if (el.type === 'icon' && el.icon)    return `Icon · ${el.icon}`;
  return elementTitle(el.type);
}

/**
 * Populates the right-hand `#inspector` with the full editor for the
 * currently-selected element. When nothing is selected, shows a short
 * hint. `#inspector.dataset.elementId` carries the active element id
 * so input handlers below can locate it without walking parents.
 */
function renderInspector() {
  const ins = dui.inspector;
  if (!ins) return;
  const el = state.elements.find(e => e.id === state.selectedId);

  if (!el) {
    // Nothing selected — tear the popover down.
    hideInspector();
    return;
  }

  // Locate the element's visual index in the array for "up/down" button
  // enabled/disabled state inside the editor header.
  const idx = state.elements.findIndex(e => e.id === el.id);
  ins.dataset.elementId = el.id;
  // Scrollable `.inspector-body` wrapper holds the form. Scroll stays
  // on the inner wrapper — not on `.inspector` itself — because the
  // outer popover's arrow pseudo-elements extend past its border,
  // and any `overflow: auto|hidden` on the outer frame would clip
  // them.
  //
  // No close button: the popover is dismissed by clicking outside
  // (`mousedown` listener in initLabelDesigner), pressing Escape,
  // clicking a different element, or the in-form Delete action.
  ins.innerHTML = `<div class="inspector-body">${renderElementEditor(el, idx)}</div>`;
  // Reveal + position. The 2-step `.d-none` → `.is-showing` lets the
  // CSS transition run (opacity / transform animate in).
  ins.classList.remove('d-none');
  positionInspector();
  // Kick the transition forward on the next frame so the browser
  // commits the "display: block" first, otherwise the scale-in is
  // skipped.
  requestAnimationFrame(() => ins.classList.add('is-showing'));

  // Action buttons (center, up/down layer, delete) — now live inside
  // the inspector header (same markup `renderElementEditor` produces).
  ins.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleElementAction(btn);
    });
  });

  // Form inputs — the `data-bind` mini-framework from before, adapted
  // to read the active element id from the inspector itself.
  ins.querySelectorAll('[data-bind]').forEach(inp => {
    const handler = () => {
      const id = ins.dataset.elementId;
      const key = inp.dataset.bind;
      const elem = state.elements.find(x => x.id === id);
      if (!elem) return;
      let v = inp.value;
      if (inp.type === 'number')   v = (inp.step && inp.step.includes('.') ? parseFloat(v) : parseInt(v, 10)) || 0;
      if (inp.type === 'checkbox') v = inp.checked;
      if (inp.dataset.unit === 'mm' && ['x','y','w','h'].includes(key)) v = mmToPxStored(v);
      elem[key] = v;

      if (key === 'kind') {
        // QR kind swaps out whole field sets — full inspector rebuild.
        renderPreview();
        renderInspector();
        return;
      }

      renderPreview();

      // Element-name in the LEFT list reflects text content, counter
      // previews and a few other fields. Keep it live without rebuilding
      // the entire list (and losing the inspector's input focus).
      const listRow = dui.elementsList.querySelector(`.element-row[data-id="${id}"]`);
      if (listRow) {
        const nameEl  = listRow.querySelector('.ename');
        const badgeEl = listRow.querySelector('.ebadge');
        if (nameEl)  nameEl.innerHTML  = escHtml(elementRowLabel(elem));
        if (badgeEl) badgeEl.textContent = isTextLike(elem)
          ? `${(elem.fontSize | 0) || 12}pt`
          : `${(elem.w | 0)}×${(elem.h | 0)}`;
      }

      // Counter inspector carries a "Generates N labels: first → last"
      // summary — refresh it in place so the user sees the range update
      // as they type prefix/suffix/start/step/count/padLen.
      if (elem.type === 'counter' &&
          ['prefix','suffix','startNum','step','count','padLen'].includes(key)) {
        const box = ins.querySelector('.counter-preview');
        if (box) {
          const lastIdx   = Math.max(0, (elem.count | 0) - 1);
          const firstPrev = escHtml(elementText(elem, 0));
          const lastPrev  = escHtml(elementText(elem, lastIdx));
          box.innerHTML =
            `Generates <b>${elem.count | 0}</b> labels: <code>${firstPrev}</code>` +
            ` <i class="bi bi-arrow-right mx-1"></i> <code>${lastPrev}</code>`;
        }
      }
    };
    inp.addEventListener('input',  handler);
    inp.addEventListener('change', handler);
  });
}

/**
 * Tear the floating inspector down — clears classes, inline position
 * and the stored element id. Used when nothing is selected, when
 * clicking outside, or when the user presses Esc / the close button.
 */
function hideInspector() {
  const ins = dui.inspector;
  if (!ins) return;
  delete ins.dataset.elementId;
  delete ins.dataset.placement;
  ins.classList.remove('is-showing');
  ins.classList.add('d-none');
  ins.innerHTML = '';
  // Reset inline position + arrow offset so the next show starts
  // clean — fresh measurements, no leftover top/left/arrow from
  // the previous element.
  ins.style.top = '';
  ins.style.left = '';
  ins.style.removeProperty('--arrow-top');
}

/**
 * Place the floating inspector next to the selected ELEMENT's row in
 * the left-hand list (not next to its image on the canvas). The row
 * is a stable, always-visible UI anchor — canvas elements can be
 * tiny (a 12 px barcode), clipped by the designer-card gutter, or
 * offscreen on a scrolled canvas wrap, and anchoring to them made
 * the popover land in unhelpful places.
 *
 * Default placement is RIGHT of the row. Flips LEFT when there's
 * no room on the right (narrow viewport, wide row). Vertically
 * centred on the row and clamped inside the viewport; `--arrow-top`
 * is written so the arrow keeps pointing at the row's centre even
 * when the popover was clamped off its natural vertical slot.
 */
function positionInspector() {
  const ins = dui.inspector;
  if (!ins || ins.classList.contains('d-none')) return;
  if (!state.selectedId) return;

  // Anchor = the `.element-row` in the left list for the selected
  // element. If it's missing (shouldn't happen — buildElementsList
  // renders every element) or the list is hidden (pre-connect, wrong
  // tab), bail; hideInspector would already have been called in that
  // case via the normal flow.
  const list = dui.elementsList;
  if (!list) return;
  const row = list.querySelector(`.element-row[data-id="${state.selectedId}"]`);
  if (!row) return;

  // Make sure the anchor row is within the list's scrollable viewport,
  // otherwise the popover would appear to float beside thin air.
  // `block:'nearest'` only scrolls when actually needed — it's a
  // no-op when the row is already fully visible.
  try { row.scrollIntoView({ block: 'nearest' }); } catch {}

  const rowRect = row.getBoundingClientRect();
  const popRect = ins.getBoundingClientRect();
  const GAP  = 14;   // gap between row edge and popover (arrow sits here)
  const EDGE = 12;   // viewport margin

  // Horizontal: right of the row by default; flip left when the
  // popover wouldn't fit on the right.
  let placement = 'right';
  let left = rowRect.right + GAP;
  if (left + popRect.width > window.innerWidth - EDGE) {
    placement = 'left';
    left = rowRect.left - GAP - popRect.width;
  }
  // Last-resort clamp — if neither side actually fits (very narrow
  // viewport), pin to whichever edge keeps more of the popover on
  // screen. The arrow still points at the row's Y centre.
  left = Math.max(EDGE, Math.min(window.innerWidth - popRect.width - EDGE, left));

  // Vertical: centre the popover on the row's Y-mid, then clamp.
  const rowCentreY = rowRect.top + rowRect.height / 2;
  let top = rowCentreY - popRect.height / 2;
  top = Math.max(EDGE, Math.min(window.innerHeight - popRect.height - EDGE, top));

  // Arrow Y in popover-local coords = row centre − popover top.
  // Clamp so the arrow always hits a point within the popover's
  // rounded border (14 px from each end keeps it clear of the
  // border-radius corner).
  const arrowTop = Math.max(14, Math.min(popRect.height - 14, rowCentreY - top));

  ins.dataset.placement = placement;
  ins.style.top  = `${Math.round(top)}px`;
  ins.style.left = `${Math.round(left)}px`;
  ins.style.setProperty('--arrow-top', `${Math.round(arrowTop)}px`);
}

/* =====================================================================
 *  Pointer-based drag-to-reorder for the elements list
 * ---------------------------------------------------------------------
 *  Picks up a row by its `.grip` handle. While dragging:
 *    - the source row is greyed in place (`.dragging`),
 *    - a compact ghost card (clone of the row's `.element-head`) is
 *      position: fixed-ed to the viewport and translated with the
 *      cursor,
 *    - a thin `.drop-indicator` line shows the target insertion slot.
 *
 *  On pointerup we commit the move: re-splice `state.elements`, rebuild
 *  the list, then apply a FLIP animation on every row whose DOM rect
 *  changed between the pre-drop and post-rebuild snapshots.
 *
 *  The list visually renders TOP-DOWN in reverse array order (top of
 *  the list = topmost layer = last element in state.elements), so the
 *  reorder converts visual indices → state indices at commit time.
 * ===================================================================== */

// Active-drag context (singleton). null when nothing is being dragged.
let _elDrag = null;

function wireElementsDragReorder() {
  const list = dui.elementsList;
  if (!list) return;
  list.querySelectorAll('.grip').forEach(grip => {
    // `pointerdown` beats the row-level `click` selection because
    // `click` fires on release after no pointerdown default was
    // prevented — and we call preventDefault below.
    grip.addEventListener('pointerdown', _elDragOnGripDown);
  });
}

function _elDragOnGripDown(ev) {
  // Left mouse or touch/pen only; right-clicks + middle-clicks pass through.
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();

  const grip = ev.currentTarget;
  const sourceRow = grip.closest('.element-row');
  const list = dui.elementsList;
  if (!sourceRow || !list) return;

  const rows = Array.from(list.querySelectorAll('.element-row'));
  const sourceIdx = rows.indexOf(sourceRow);
  if (sourceIdx < 0) return;

  const srcRect = sourceRow.getBoundingClientRect();

  // The compact row is already small (grip + icon + name + badge), so
  // clone its entire innerHTML into the floating ghost. `.drag-ghost`
  // CSS hides the grip so the ghost reads as a "card being carried",
  // not as the drag-handle itself.
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost element-row';
  ghost.innerHTML = sourceRow.innerHTML;
  ghost.style.width = `${srcRect.width}px`;
  document.body.appendChild(ghost);

  // Offset keeps the grip under the cursor for the whole drag.
  const offsetX = ev.clientX - srcRect.left;
  const offsetY = ev.clientY - srcRect.top;
  _elDragPositionGhost(ghost, ev.clientX, ev.clientY, offsetX, offsetY);

  // Drop indicator — inserted/moved between rows by pointermove.
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  sourceRow.classList.add('dragging');

  _elDrag = {
    list, sourceRow, sourceIdx,
    rows,            // snapshot at drag start; stable reference for FLIP
    ghost, indicator, offsetX, offsetY,
    targetIdx: sourceIdx,   // visual index the ghost would drop AT
    pointerId: ev.pointerId,
    moved: false,    // set true on the first real move — guards against
                     // no-op clicks that the grip occasionally swallows
  };

  // Capturing on the window gives us move/up events even when the
  // cursor leaves the list (e.g. above the navbar).
  window.addEventListener('pointermove',  _elDragOnMove,   true);
  window.addEventListener('pointerup',    _elDragOnUp,     true);
  window.addEventListener('pointercancel',_elDragOnCancel, true);
}

function _elDragPositionGhost(ghost, cx, cy, ox, oy) {
  // Offset upward a hair so the ghost's edge doesn't cover the cursor.
  const x = cx - ox;
  const y = cy - oy - 2;
  ghost.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(1.5deg)`;
}

function _elDragOnMove(ev) {
  if (!_elDrag) return;
  const c = _elDrag;
  c.moved = true;
  _elDragPositionGhost(c.ghost, ev.clientX, ev.clientY, c.offsetX, c.offsetY);

  // Compute target insertion slot by comparing cursor Y against the
  // midpoints of the non-source rows. Result is an integer in
  // [0, rows.length] where `rows.length` means "drop at the end".
  const y = ev.clientY;
  let targetIdx = c.rows.length;
  for (let i = 0; i < c.rows.length; i++) {
    if (c.rows[i] === c.sourceRow) continue;
    const r = c.rows[i].getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (y < mid) { targetIdx = i; break; }
  }

  if (targetIdx !== c.targetIdx) {
    c.targetIdx = targetIdx;
    // Re-insert the indicator at the new slot. Removing first keeps
    // the DOM clean even when the indicator parent changes.
    if (c.indicator.parentElement) c.indicator.parentElement.removeChild(c.indicator);
    if (targetIdx >= c.rows.length) {
      c.list.appendChild(c.indicator);
    } else {
      c.list.insertBefore(c.indicator, c.rows[targetIdx]);
    }
  }
}

function _elDragOnCancel() { _elDragCleanup(false); }

function _elDragOnUp(ev) {
  if (!_elDrag) return;
  const c = _elDrag;
  const shouldCommit = c.moved;

  // Snapshot per-row rects BEFORE we mutate state + re-render, so we
  // can run a FLIP animation (First → Last → Invert → Play) against
  // the fresh DOM for every row that moved.
  const preRects = new Map();
  if (shouldCommit) {
    for (const r of c.rows) preRects.set(r.dataset.id, r.getBoundingClientRect());
  }

  // Commit the reorder into state.elements. Visual order is the
  // REVERSE of state order, so translate indices accordingly.
  if (shouldCommit) {
    let from = c.sourceIdx;
    let to   = c.targetIdx;
    // When moving forward, removing the source shifts the target down by one.
    if (to > from) to -= 1;
    if (to !== from && to >= 0 && to < c.rows.length) {
      const N = state.elements.length;
      const fromState = N - 1 - from;
      const toState   = N - 1 - to;
      const [moved]   = state.elements.splice(fromState, 1);
      state.elements.splice(toState, 0, moved);
    }
  }

  _elDragCleanup(true);

  if (shouldCommit) {
    renderPreview();
    buildElementsList();
    // FLIP: compare pre/post rects per element id and animate the delta.
    const newRows = Array.from(dui.elementsList.querySelectorAll('.element-row'));
    for (const row of newRows) {
      const id = row.dataset.id;
      const prev = preRects.get(id);
      if (!prev) continue;
      const next = row.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top  - next.top;
      if (dx === 0 && dy === 0) continue;
      row.style.transform = `translate(${dx}px, ${dy}px)`;
      row.style.transition = 'none';
      // Force reflow so the "from" transform takes effect before we
      // animate back to zero. Reading a layout property does the trick.
      // eslint-disable-next-line no-unused-expressions
      row.offsetHeight;
      row.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)';
      row.style.transform = '';
      // Clean up inline styles once the animation finishes so future
      // hover states / selection outlines aren't held back by them.
      const cleanup = () => {
        row.style.transition = '';
        row.style.transform  = '';
        row.removeEventListener('transitionend', cleanup);
      };
      row.addEventListener('transitionend', cleanup);
      // Hard fallback timer in case transitionend never fires.
      setTimeout(cleanup, 320);
    }
  }
}

function _elDragCleanup(withRelease) {
  window.removeEventListener('pointermove',  _elDragOnMove,   true);
  window.removeEventListener('pointerup',    _elDragOnUp,     true);
  window.removeEventListener('pointercancel',_elDragOnCancel, true);
  if (!_elDrag) return;
  const c = _elDrag;
  try { c.ghost && c.ghost.remove(); } catch {}
  try { c.indicator && c.indicator.remove(); } catch {}
  if (c.sourceRow) c.sourceRow.classList.remove('dragging');
  _elDrag = null;
}

/**
 * Reflect X/Y/W/H changes from canvas-drag into the Inspector inputs.
 * The inputs live inside `#inspector` (post-split), keyed off the
 * active element id stored on `inspector.dataset.elementId`. Skips
 * the currently-focused input so we don't clobber a value the user
 * is typing.
 */
function updateInspectorFields(el) {
  const ins = dui.inspector;
  if (!ins || ins.dataset.elementId !== el.id) return;
  for (const key of ['x', 'y', 'w', 'h']) {
    const inp = ins.querySelector(`[data-bind="${key}"]`);
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
  // `renderElementEditor` feeds the RIGHT-SIDE inspector only (the left
  // list uses `renderElementRowCompact`). No grip handle here — drag
  // lives on the compact row.
  const common = `
    <div class="element-head">
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
          <div class="small text-body-secondary mb-1 counter-preview">Generates <b>${el.count | 0}</b> labels: <code>${firstPreview}</code> <i class="bi bi-arrow-right mx-1"></i> <code>${lastPreview}</code></div>
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
  // Buttons now live in the inspector (post-split) — find the active
  // element via `#inspector.dataset.elementId`. Fall back to the
  // legacy `.element-row` closure in case some code path still
  // renders the editor inline.
  const ins = dui.inspector;
  const id = (ins && ins.dataset.elementId)
          || btn.closest('.element-row')?.dataset.id;
  if (!id) return;
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
  const connected = driver.isConnected;
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


// ---------- Print ----------

/** Click handler for the main Print CTA. Pops a confirmation modal with
 *  the total number of physical labels about to be printed, and only
 *  kicks off `printQueue()` if the user accepts. */
function confirmAndPrintQueue() {
  if (!driver.isConnected) {
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

/**
 * Drive the print job through the driver API:
 *   1. Pre-flight: ask the driver for paper state, bail early if empty
 *      or if the link went silent.
 *   2. Rasterize every queued label once (driver.rasterize is a pure
 *      function) and expand by copies count so we know the total label
 *      count up-front for the progress bar.
 *   3. Bracket the wire traffic with driver.beginJob / driver.endJob
 *      (INIT_PRINTER + optional PAPER_TYPE / PRINT_PAGER).
 *   4. Stream each raster via driver.sendRaster; it handles chunking,
 *      PRINT_PAUSE between labels, and per-chunk onProgress callbacks.
 *
 * All protocol bytes live inside the driver — this function is pure
 * orchestration + UI (progress UI, toasts, queue cleanup).
 */
async function printQueue() {
  if (!driver.isConnected) {
    showToast('Printer is not connected', 'error');
    return;
  }
  const continuous = dui.qContinuous.checked;
  const totalPrints = queue.reduce((s, q) => s + Math.max(1, q.copies | 0), 0);

  logInfo(`Print queue: ${queue.length} label(s) → ${totalPrints} total prints, continuous=${continuous}`);

  // Pre-flight paper check. Firmware does not send async notifications,
  // so we must actively query PAPER_STATE before sending any raster.
  logInfo('Pre-flight: querying paper state…');
  const paperByte = await driver.queryPaperState();
  if (paperByte === null) {
    logError('No response to PAPER_STATE — printer may be silent or RX not working.');
    showToast('No response from printer on PAPER_STATE. Check the connection.', 'error');
    return;
  }
  if (paperByte === 0x88) {
    logError('Paper state = NO PAPER (0x88). Aborting print.');
    // Inline Retry so the user doesn't have to re-hunt for the Print CTA.
    showToast('Printer reports no paper. Load a roll, close the cover, then Retry.', 'error', {
      action: { label: 'Retry', onClick: () => printQueue() },
    });
    return;
  }
  logInfo(`  Paper state OK (0x${paperByte.toString(16).padStart(2, '0')})`);

  dui.btnPrintQueue.disabled = true;
  // Progress UI under the Print CTA. Seeded after rasterization so we
  // have the final count (labels × copies).
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

  let jobOpened = false;
  try {
    // Rasterize every queued label once, then expand by copies count
    // so the progress bar knows the final total up front.
    const rasters = [];
    for (let li = 0; li < queue.length; li++) {
      const lbl = queue[li];
      const copies = Math.max(1, Math.min(99, lbl.copies | 0));
      const tmp = document.createElement('canvas');
      renderClean(tmp, lbl);
      const raster = driver.rasterize(tmp, { dither: lbl.dither });
      logInfo(`  Label #${li + 1}: ${tmp.width}×${tmp.height}px × ${copies} copies → ${raster.length} raster bytes`);
      for (let c = 0; c < copies; c++) rasters.push(raster);
    }
    if (rasters.length === 0) {
      showToast('Queue is empty', 'info');
      return;
    }
    showProgress(0, rasters.length);

    await driver.beginJob({ continuous });
    jobOpened = true;

    for (let i = 0; i < rasters.length; i++) {
      logInfo(`  → raster ${i + 1}/${rasters.length} (${rasters[i].length} bytes)`);
      await driver.sendRaster(rasters[i]);
      showProgress(i + 1, rasters.length);
    }

    await driver.endJob();
    jobOpened = false;

    // Everything that was in the queue is now on the printer. Clear it
    // so the user starts fresh next time — a print job has no re-queue
    // value, and leaving stale items around invites accidental reprints.
    const printed = queue.length;
    queue.length = 0;
    buildQueueList();
    showToast(`Print job sent · ${printed} item${printed === 1 ? '' : 's'} cleared from queue`, 'success');
  } catch (e) {
    logError('Print failed: ' + e.message);
    showToast('Print failed: ' + e.message, 'error');
    // Best-effort end-of-job so the printer isn't left in mid-session.
    if (jobOpened) {
      try { await driver.endJob(); } catch {}
    }
  } finally {
    hideProgress();
    updateQueueUI();
  }
}

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
    // The freshly-saved template becomes the "open" one — the designer
    // immediately enters editing mode for it, so the footer switches to
    // Save changes / Save as new. This matches the design handoff: the
    // user's mental model after "Save as template" is "I'm now editing
    // THIS saved template", not "I just took a snapshot and the
    // designer is still a blank slate".
    state.openTemplateId = tpl.id;
    updateDesignerEditingUI();
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
    // If the deleted template was the one loaded into the designer,
    // drop the editing context so the footer reverts to "Save as
    // template" (the open-template buttons would otherwise target a
    // 404 and silently noop on Save changes).
    if (state.openTemplateId === id) {
      state.openTemplateId = null;
      updateDesignerEditingUI();
    }
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
  state.openTemplateId = tpl.id;
  // Sync size/dither inputs
  if (dui.widthMm) dui.widthMm.value = state.widthMm;
  if (dui.heightMm) ensureCartridgeOption(dui.heightMm, state.heightMm);
  if (dui.dither) dui.dither.value = state.dither;
  renderPreview();
  buildElementsList();
  updateDesignerEditingUI();
  // Switch to Design tab
  const designBtn = document.getElementById('nav-design-btn');
  if (designBtn) designBtn.click();
  showToast(`Opened "${tpl.name}"`, 'info');
}

/**
 * Keep the designer's header + footer in sync with `state.openTemplateId`.
 *
 *   - Not editing (no open template): header shows "Design your label",
 *     no "Editing template" badge, footer shows just "Save as template".
 *   - Editing an open template: header shows the template's name and
 *     the badge; footer swaps "Save as template" for a pair —
 *     primary "Save changes" (overwrite) + outline "Save as new"
 *     (branch into a new template).
 *
 * Safe to call at any time — re-reads the template name on each call
 * so a rename elsewhere propagates on the next buildElementsList /
 * render round-trip. Called from openTemplateInDesigner, Clear, after
 * Save-as-new, and on designer init.
 */
function updateDesignerEditingUI() {
  const titleEl  = document.getElementById('designerTitle');
  const badgeEl  = document.getElementById('editingBadge');
  const saveNew  = document.getElementById('btnSaveTemplate');
  const saveChg  = document.getElementById('saveChangesBtn');
  const saveCopy = document.getElementById('saveAsCopyBtn');

  const editing = !!state.openTemplateId;
  const tpl = editing
    ? loadTemplates().find(t => t.id === state.openTemplateId)
    : null;

  // If the open template was deleted elsewhere, drop the reference so
  // we don't show a ghost name. Save changes would then 404 anyway.
  if (editing && !tpl) {
    state.openTemplateId = null;
    return updateDesignerEditingUI();
  }

  if (titleEl) titleEl.textContent = tpl ? tpl.name : 'Design your label';
  if (badgeEl) badgeEl.classList.toggle('d-none', !editing);
  if (saveNew)  saveNew.classList.toggle('d-none',  editing);
  if (saveChg)  saveChg.classList.toggle('d-none', !editing);
  if (saveCopy) saveCopy.classList.toggle('d-none', !editing);
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
    // Spans the whole grid row (auto-fill grid wouldn't give this one
    // "no matches" block full width otherwise).
    gallery.innerHTML = `<div class="text-center py-4 text-body-secondary small" style="grid-column: 1 / -1;">No templates match "<b>${escHtml(templateSearchTerm)}</b>".</div>`;
    return;
  }

  for (const tpl of filtered) {
    // The gallery is a CSS-grid (`.template-grid` → auto-fill,
    // minmax(220px, 1fr)), so each `.template-card` is a DIRECT grid
    // item — no Bootstrap `col-*` wrapper. A `col-*` wrapper would
    // cap width at e.g. 25% of the 220px grid cell and collapse the
    // card into a sliver.
    const card = document.createElement('div');
    card.className = 'card template-card';
    const date = new Date(tpl.updatedAt || tpl.createdAt);
    const dateStr = isNaN(date) ? '' : date.toLocaleDateString();
    const elemCount = (tpl.elements || []).length;
    card.innerHTML = `
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
      </div>`;
    gallery.appendChild(card);
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
// Expose on `window` so driver event handlers (e.g. the identity-failed
// listener) can surface a toast when a modal isn't available.
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
  dui.inspector = qs('#inspector');
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

  // --- Floating inspector dismissal + reposition ---
  //
  // Scroll / resize keep the popover glued to its element even as the
  // user scrolls the page or resizes the window. `positionInspector`
  // bails immediately when the popover is hidden, so this is cheap.
  window.addEventListener('scroll', positionInspector, true);  // capture = catches inner scrollers too
  window.addEventListener('resize', positionInspector);

  // Click-outside: if the user clicks anywhere that isn't the popover
  // itself AND isn't the canvas / elements list (those own their own
  // selection handling), deselect. `mousedown` is preferred over
  // `click` because it fires before the browser starts a drag/
  // text-select interaction — the popover vanishes crisply.
  document.addEventListener('mousedown', (e) => {
    const ins = dui.inspector;
    if (!ins || ins.classList.contains('d-none')) return;
    // Clicks inside the popover keep it open (form fields, buttons).
    if (e.target.closest('#inspector')) return;
    // Clicks on the canvas / elements list drive their own selection
    // — let those handlers decide what to do.
    if (e.target.closest('#labelCanvas, #elementsList')) return;
    // Clicks inside Bootstrap dialogs / overlays shouldn't deselect
    // either (the user is probably opening Advanced or a modal).
    if (e.target.closest('.modal, .offcanvas, .dropdown-menu, .popover, .toast')) return;
    state.selectedId = null;
    renderPreview();
    buildElementsList();
  }, true);

  // Escape deselects when the popover is open. Guarded so we don't
  // swallow Escape from a modal / offcanvas that's also listening.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const ins = dui.inspector;
    if (!ins || ins.classList.contains('d-none')) return;
    // Don't interfere if a Bootstrap dialog is on top — it has its
    // own Escape handler and the user's intent is to close THAT,
    // not our popover.
    if (document.querySelector('.modal.show, .offcanvas.show')) return;
    state.selectedId = null;
    renderPreview();
    buildElementsList();
  });

  // Buttons
  qs('#btnAddToQueue').addEventListener('click', () => addToQueue());
  qs('#btnClearDesigner').addEventListener('click', () => {
    // P0.3 — nothing to clear → just reset without a confirm dialog.
    if (state.elements.length === 0) {
      state.selectedId = null;
      state.openTemplateId = null;
      updateDesignerEditingUI();
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
      state.openTemplateId = null;
      updateDesignerEditingUI();
      renderPreview();
      buildElementsList();
      return;
    }
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const onConfirm = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      state.elements = [];
      state.selectedId = null;
      // Clearing the designer also exits the "editing template" mode —
      // otherwise the user would see "Save changes" still offered
      // despite there being nothing left to save.
      state.openTemplateId = null;
      updateDesignerEditingUI();
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
  // "Save changes" — overwrite the open template with the current state.
  // `updateTemplate` re-stamps updatedAt and re-renders the gallery; we
  // keep `state.openTemplateId` so the user stays in editing mode.
  qs('#saveChangesBtn')?.addEventListener('click', () => {
    if (!state.openTemplateId) return;
    const patch = templateFromState();
    // `templateFromState` synthesises a fresh id + default name + new
    // createdAt. Strip all three so `updateTemplate`'s spread keeps
    // the original template's identity metadata — only the design
    // payload (size, dither, elements, thumbnail) overwrites.
    delete patch.id;
    delete patch.name;
    delete patch.createdAt;
    if (updateTemplate(state.openTemplateId, patch)) {
      showToast('Template updated', 'success');
      // Reflect the new thumbnail/updatedAt in the open-template
      // badge (harmless if name didn't change).
      updateDesignerEditingUI();
    } else {
      showToast('Template not found — saving as new', 'error');
      state.openTemplateId = null;
      updateDesignerEditingUI();
    }
  });
  // "Save as new" — opens the save modal which creates a fresh template;
  // saveNewTemplate will set `state.openTemplateId` to the new id, so
  // the user smoothly switches from editing the old one to editing the
  // new one.
  qs('#saveAsCopyBtn')?.addEventListener('click', openSaveModal);
  // Initial sync — covers the case where openTemplateId is restored
  // from somewhere else in the future (currently always starts null).
  updateDesignerEditingUI();
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
