// =====================================================================
//  BTPrinter / driver-base.js — abstract Driver class
// ---------------------------------------------------------------------
//  Every concrete printer driver (P780BT, future models) extends this
//  class. The base owns the generic machinery so model-specific code
//  stays focused on the wire protocol and raster layout.
//
//  The driver is an `EventTarget`: UIs subscribe to events instead of
//  registering ad-hoc callbacks, which makes it easy to have more than
//  one listener (e.g. the status strip + the Advanced log both react
//  to the same 'frame' event).
//
//  Events (all CustomEvent, with data in `event.detail`):
//    'connected'     { info }             port opened + identity passed
//    'disconnected'  {}                   port closed
//    'error'         { message }          transport-level error
//    'identity-failed' { reason }         identity check rejected device
//    'tx'            { bytes }            raw bytes sent to the printer
//    'rx'            { bytes }            raw bytes received from it
//    'frame'         { tag, payload,      a decoded response frame
//                      fields, swatches,    `fields` / `swatches` /
//                      batteryPct, ... }    `batteryPct` / etc come from
//                                           the driver's _decodeFrame.
//    'log'           { level, text }      driver-internal progress notes
//                                         ('info' | 'error'), surfaced
//                                         in the Advanced log.
//
//  Subclass contract — override these:
//    get model / get dpi / get pxPerMm
//    get commands / get settings / get actions
//    get paperTypeOptions / get autoPowerOptions
//    _createParser()        → ResponseParser
//    _decodeFrame(tag, p)   → { fields, swatches?, batteryPct?, ... }
//    _verifyIdentity()      → Promise<true | { ok:false, reason }>
//    rasterize(canvas, opts)→ Uint8Array
//    sendRaster(raster, opts) → Promise<void>
//    beginJob(opts) / endJob() → Promise<void>   // bracket a print job
//    readAll() / sendCommand(cmd) / applySetting / applyAction / queryPaperState
// =====================================================================

import { SerialLink } from './transport.js';

export class Driver extends EventTarget {
  constructor() {
    super();
    if (new.target === Driver) {
      throw new TypeError('Driver is abstract — subclass it (see base.js + models.js)');
    }
    this.link = null;
    this._parser = null;
    // List of pending waiters for `waitForTag`. Each entry:
    //   { tag: number, resolve: fn, reject: fn, timer: <timeout handle> }
    this._waiters = [];
  }

  // ---------- Lifecycle ----------

  get isConnected() { return !!(this.link && this.link.isOpen); }

  /**
   * Open the serial port, attach the parser, run the identity check.
   * Resolves on success, rejects (and closes the port) on failure.
   * UI should listen for 'connected' / 'identity-failed' events rather
   * than relying on this Promise for UX decisions — the events fire
   * even when a reconnect happens outside of an explicit `connect()`.
   */
  async connect() {
    if (this.isConnected) return;

    this.link = new SerialLink({
      onConnected:    (info)  => this._emit('connected',    { info }),
      onDisconnected: ()      => this._emit('disconnected'),
      onTx:           (bytes) => this._emit('tx', { bytes }),
      onRx:           (bytes) => this._emit('rx', { bytes }),
      onError:        (msg)   => this._emit('error', { message: msg }),
    });

    this._parser = this._createParser();
    this.link.setParser(this._parser);

    await this.link.connect();

    // Identity check. Subclass returns `true` for a match, or an object
    // `{ ok: false, reason }` for a rejection. Anything else is treated
    // as a rejection with a generic reason.
    let verdict;
    try { verdict = await this._verifyIdentity(); }
    catch (e) { verdict = { ok: false, reason: 'Identity check threw: ' + (e.message || e) }; }

    if (verdict !== true) {
      const reason = (verdict && verdict.reason) || 'Device did not pass identity check.';
      // `detected` carries the SN-registry resolution when the driver
      // was able to produce one (right protocol, wrong model). The UI
      // uses it to auto-swap drivers via localStorage + reload, so the
      // user doesn't have to figure out the driver id manually.
      const detected = verdict && verdict.detected;
      this._emit('identity-failed', detected ? { reason, detected } : { reason });
      try { await this.link.disconnect(); } catch {}
      throw new Error(reason);
    }
  }

  async disconnect() {
    if (!this.link) return;
    try { await this.link.disconnect(); } catch {}
  }

  async forget() {
    if (!this.link) return;
    try { await this.link.forget(); } catch {}
  }

  // ---------- Low-level I/O (drivers / tests may use directly) ----------

  /** Write raw bytes to the printer. `silent=true` suppresses the 'tx'
   *  event (used by chunked raster sends to keep the log readable). */
  async send(bytes, silent = false) {
    if (!this.isConnected) throw new Error('not connected');
    await this.link.send(bytes, silent);
  }

  // ---------- Frame handling ----------

  /**
   * Called by the ResponseParser for every decoded frame. Emits a
   * 'frame' event with decoded fields and resolves any pending
   * `waitForTag` promises that match.
   *
   * The previous implementation monkey-patched `parser.onFrame` directly
   * to intercept specific tags (see the old `waitForTag` in app.js) —
   * that's fragile because it silently loses frames on re-entry. The
   * waiter-list approach below is safe under concurrent awaits.
   */
  _onFrame(tag, payload) {
    let decoded;
    try {
      decoded = this._decodeFrame(tag, payload) || { fields: {} };
    } catch (e) {
      decoded = { fields: {}, decodeError: e.message };
      this._log('error', `decode failed for tag 0x${tag.toString(16)}: ${e.message}`);
    }
    this._emit('frame', { tag, payload, ...decoded });

    // Resolve any matching waiters. We walk the list once and keep the
    // non-matching entries.
    if (this._waiters.length > 0) {
      const kept = [];
      for (const w of this._waiters) {
        if (w.tag === tag) {
          clearTimeout(w.timer);
          w.resolve(payload);
        } else {
          kept.push(w);
        }
      }
      this._waiters = kept;
    }
  }

  /**
   * Wait for the next frame with `tag` to arrive. Resolves with the
   * payload bytes, rejects on timeout or disconnect. Safe to call
   * concurrently — multiple waiters for the same tag are all resolved
   * by a single matching frame (first-come-first-served isn't enforced;
   * every waiter for the tag sees the same payload).
   */
  waitForTag(tag, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) { reject(new Error('not connected')); return; }
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w.timer !== timer);
        reject(new Error(`timeout waiting for tag 0x${tag.toString(16)}`));
      }, timeoutMs);
      this._waiters.push({ tag, resolve, reject, timer });
    });
  }

  // ---------- Subclass hooks (MUST override) ----------

  /** @returns {string} e.g. 'P780BT' */
  get model() { throw new Error('override Driver.model'); }
  /** @returns {number} native effective DPI of the print head */
  get dpi() { throw new Error('override Driver.dpi'); }
  get pxPerMm() { return this.dpi / 25.4; }
  /** @returns {Array} supported GET commands for the Advanced panel */
  get commands() { return []; }
  /** @returns {Object} SET commands (name → { header, ... }) */
  get settings() { return {}; }
  /** @returns {Object} named actions (INIT_PRINTER, FEED_PAPER, ...) */
  get actions() { return {}; }
  /** @returns {Array} entries `{ value, label }` for the Paper Type select */
  get paperTypeOptions() { return []; }
  /** @returns {Array} entries `{ value, label }` for the Auto Power select */
  get autoPowerOptions() { return []; }

  _createParser() { throw new Error('override Driver._createParser'); }
  _decodeFrame(_tag, _payload) { throw new Error('override Driver._decodeFrame'); }
  async _verifyIdentity() { throw new Error('override Driver._verifyIdentity'); }

  async readAll() { throw new Error('override Driver.readAll'); }
  async sendCommand(_cmd) { throw new Error('override Driver.sendCommand'); }
  async applySetting(_name, _value) { throw new Error('override Driver.applySetting'); }
  async applyAction(_name) { throw new Error('override Driver.applyAction'); }
  async queryPaperState() { throw new Error('override Driver.queryPaperState'); }

  rasterize(_canvas, _opts) { throw new Error('override Driver.rasterize'); }
  async sendRaster(_raster, _opts) { throw new Error('override Driver.sendRaster'); }
  async beginJob(_opts) { throw new Error('override Driver.beginJob'); }
  async endJob() { throw new Error('override Driver.endJob'); }

  // ---------- Internal helpers ----------

  /** Dispatch a CustomEvent. Subclasses use this instead of the raw
   *  `new CustomEvent` boilerplate. */
  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Emit a 'log' event — used by the driver for progress / diagnostic
   *  messages that the UI's Advanced log prints. `level` is 'info' or
   *  'error'. */
  _log(level, text) {
    this._emit('log', { level, text });
  }
}
