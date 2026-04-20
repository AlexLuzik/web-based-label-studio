// =====================================================================
//  BTPrinter / transport.js — Web Serial transport + generic framing
// ---------------------------------------------------------------------
//  Two classes:
//
//    ResponseParser  — accumulates raw bytes and splits them into
//                      framed responses. Generic: a concrete driver
//                      configures it with the start-of-frame byte and
//                      a per-tag payload-length table, so the same
//                      class can front any prefix-delimited protocol.
//
//    SerialLink      — thin wrapper around the Web Serial API. Owns
//                      the port, reader and writer, pumps incoming
//                      bytes into the parser, and surfaces lifecycle
//                      events (connect / disconnect / tx / rx / error)
//                      through plain callbacks. Drivers wrap the
//                      callbacks into their own event system — the
//                      UI never talks to SerialLink directly.
// =====================================================================

const hexStr = arr => Array.from(arr, b => b.toString(16).padStart(2, '0')).join(' ');

/**
 * Stream parser for prefix-delimited binary protocols.
 *
 * The parser is model-agnostic: the driver passes in
 *   - `prefix`  : single byte that marks the start of every frame
 *                 (e.g. 0x1A for P780BT).
 *   - `respLen` : map of `tag -> payloadLength`. Values can be:
 *                   number          → fixed payload length
 *                   null | undefined → unknown tag (best-effort: 1 byte)
 *                   function(buf)    → variable-length tag; receives the
 *                                      current buffer and returns the
 *                                      total frame size (header + payload)
 *                                      in bytes, or `null` if more data
 *                                      is still needed.
 *   - `onFrame` : callback invoked with `(tag, payloadArray)` for each
 *                 decoded frame.
 *   - `onError` : optional callback for orphan-byte diagnostics.
 */
export class ResponseParser {
  constructor({ prefix, respLen, onFrame, onError }) {
    if (typeof prefix !== 'number') throw new TypeError('ResponseParser: prefix byte required');
    if (!respLen) throw new TypeError('ResponseParser: respLen table required');
    if (typeof onFrame !== 'function') throw new TypeError('ResponseParser: onFrame callback required');
    this.prefix  = prefix;
    this.respLen = respLen;
    this.onFrame = onFrame;
    this.onError = onError || (() => {});
    this.buf = [];
  }

  /**
   * Replace the frame handler. Used by drivers for short-lived
   * interception (e.g. waitForTag) — consumers should prefer the
   * driver-level `waitForTag` helper instead of touching this directly.
   */
  setOnFrame(handler) { this.onFrame = handler; }

  feed(bytes) {
    for (const b of bytes) this.buf.push(b);

    while (true) {
      const start = this.buf.indexOf(this.prefix);
      if (start < 0) {
        // No frame prefix anywhere in the buffer — everything inside is
        // orphan bytes that don't belong to a frame. Log them so we can
        // debug silent truncation (e.g. wrong RESP_LEN for some tag).
        if (this.buf.length > 0) {
          this.onError(`parser: discarding ${this.buf.length} orphan byte(s): ${hexStr(this.buf)}`);
        }
        this.buf.length = 0;
        return;
      }
      if (start > 0) {
        // Bytes before the prefix are orphaned — probably a RESP_LEN too
        // short for some tag above. Log for diagnostics before skipping.
        const discarded = this.buf.slice(0, start);
        this.onError(`parser: skipping ${discarded.length} byte(s) before next frame: ${hexStr(discarded)}`);
        this.buf.splice(0, start);
      }
      if (this.buf.length < 2) return;  // need at least prefix + tag

      const tag = this.buf[1];
      const rule = this.respLen[tag];

      // Variable-length: driver computes total size from the buffer.
      if (typeof rule === 'function') {
        const total = rule(this.buf);
        if (total === null || total === undefined) return;   // need more bytes
        if (this.buf.length < total) return;
        const payload = this.buf.slice(2, total);
        this.onFrame(tag, payload);
        this.buf.splice(0, total);
        continue;
      }

      // Unknown / null tag — assume 1-byte payload so we don't stall.
      if (rule === null || rule === undefined) {
        if (this.buf.length < 3) return;
        const payload = this.buf.slice(2, 3);
        this.onFrame(tag, payload);
        this.buf.splice(0, 3);
        continue;
      }

      // Fixed-length payload.
      const total = 2 + rule;
      if (this.buf.length < total) return;
      const payload = this.buf.slice(2, total);
      this.onFrame(tag, payload);
      this.buf.splice(0, total);
    }
  }
}

/**
 * Thin Web Serial wrapper. Surfaces lifecycle callbacks; drivers can
 * register a `ResponseParser` via `setParser()` — every chunk arriving
 * over RX is forwarded both to `handlers.onRx` (for raw logging) and
 * to the parser (for framed decoding).
 *
 * The class is intentionally model-agnostic: it knows nothing about
 * specific commands or tags, only about serial bytes in and out.
 */
export class SerialLink {
  constructor(handlers) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;
    this.handlers = handlers || {};
    this.parser = null;
  }

  get isOpen() { return !!this.port; }

  /** Attach the driver's ResponseParser. Must be set before `connect()`
   *  if the caller expects framed events; otherwise RX bytes still fire
   *  `handlers.onRx` but no frames are produced. */
  setParser(parser) { this.parser = parser; }

  async connect(options = {}) {
    if (!('serial' in navigator)) throw new Error('Web Serial API is not supported');
    const {
      filters = [],
      portOptions = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    } = options;
    const port = await navigator.serial.requestPort({ filters });
    await port.open(portOptions);
    this.port = port;
    this.writer = port.writable.getWriter();
    this.keepReading = true;
    this._readLoop();  // fire-and-forget; its finally block cleans up
    const info = port.getInfo ? port.getInfo() : {};
    this._safe('onConnected', info);
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
              this._safe('onRx', value);
              if (this.parser) {
                try { this.parser.feed(value); }
                catch (e) { this._safe('onError', `parser: ${e.message}`); }
              }
            }
          }
        } catch (e) {
          this._safe('onError', `read: ${e.message}`);
          break;
        } finally {
          try { this.reader.releaseLock(); } catch {}
          this.reader = null;
        }
      }
    } finally {
      await this._cleanup();
      this._safe('onDisconnected');
    }
  }

  async send(bytes, silent = false) {
    if (!this.writer) throw new Error('not connected');
    await this.writer.write(new Uint8Array(bytes));
    if (!silent) this._safe('onTx', bytes);
  }

  async disconnect() {
    this.keepReading = false;
    try { if (this.reader) await this.reader.cancel(); } catch {}
    await this._cleanup();
  }

  /**
   * Release Chrome's grant on the underlying port in addition to closing
   * it. On macOS the `/dev/tty.*` node backing a BT-SPP link can land in
   * a zombie state after a disconnect where the OS still accepts writes
   * but routes nothing through (tracked as Chromium issue #345369596 —
   * the Web Serial wrapper doesn't release IOBluetoothRFCOMMChannel
   * cleanly on `port.close()`). `port.forget()` drops Chrome's reference
   * so the next `requestPort()` triggers a fresh pick; however that
   * alone does not rebuild the tty node, so on macOS the user usually
   * still has to un-pair / re-pair in System Settings.
   *
   * Kept as a separate method so drivers can call it selectively — a
   * routine disconnect should just call `disconnect()`.
   */
  async forget() {
    const p = this.port;
    await this.disconnect();
    try { if (p && typeof p.forget === 'function') await p.forget(); } catch {}
  }

  /**
   * Release port/writer/reader handles. Called from `disconnect()` and
   * from `_readLoop`'s finally block. Idempotent — safe to call twice.
   *
   * Previously this method was declared only by its call sites (see
   * commit history) and calling it raised a TypeError that was
   * swallowed by the surrounding try/catch, leaving stale port refs
   * behind on disconnect. Restoring it here fixes that.
   */
  async _cleanup() {
    // Reader is released inside the read loop's own finally block, but
    // if we got here without the loop running we still need to clear it.
    if (this.reader) {
      try { await this.reader.cancel(); } catch {}
      try { this.reader.releaseLock(); } catch {}
      this.reader = null;
    }
    if (this.writer) {
      try { await this.writer.close(); } catch {}
      try { this.writer.releaseLock(); } catch {}
      this.writer = null;
    }
    if (this.port) {
      try { await this.port.close(); } catch {}
      this.port = null;
    }
  }

  /** Invoke a handler callback without letting its exceptions kill the
   *  read loop. Missing callbacks are silently ignored. */
  _safe(name, ...args) {
    const fn = this.handlers[name];
    if (typeof fn === 'function') {
      try { fn(...args); } catch (e) {
        // Last-ditch: if even the error handler throws, log to console.
        try {
          if (name !== 'onError' && typeof this.handlers.onError === 'function') {
            this.handlers.onError(`${name} handler: ${e.message}`);
          } else {
            console.error(`[SerialLink] ${name} handler threw:`, e);
          }
        } catch { /* give up */ }
      }
    }
  }
}
