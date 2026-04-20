// =====================================================================
//  BTPrinter — entry point
// ---------------------------------------------------------------------
//  This file is the single import surface for the rest of the app:
//
//      import { createDriver, registerDriver } from './drivers.js';
//      const driver = createDriver('p780bt');
//
//  It also exposes a `BTPrinter` namespace on `window` for debugging
//  (e.g. pop the DevTools console and inspect `BTPrinter.driver` or
//  call `BTPrinter.driver.readAll()`). The UI does NOT rely on the
//  window global — it's purely a convenience for humans.
// =====================================================================

import { SerialLink, ResponseParser } from './transport.js';
import { Driver }                     from './driver-base.js';
import { PrinterDriver, PROTOCOL_CONSTANTS } from './base.js';
import {
  // P family (P780BT = reference driver, the one tested on real
  // hardware; others are derived from vendor source)
  P780BTDriver, P780BT_CONSTANTS,
  P24Driver, P580Driver, P1000Driver, AMP310Driver, P15Driver,
  P3100DDriver, P3100DJDriver, P3200Driver, P3200DDriver, LT12Driver,
  // D family
  D480BTDriver, D480BTProDriver, D680BTDriver,
  D1600Driver, D1600DDriver,
  D30Driver, D30SDriver, D50Driver, Q30Driver,
  // Misc
  A30Driver, LM1600Driver, M950Driver, M960Driver,
} from './models.js';

// ---------- Driver registry ----------

const registry = new Map();

/**
 * Register a driver constructor under a short id. Called once per
 * model at module load time; future models add themselves here.
 *   registerDriver('p780bt', P780BTDriver);
 */
export function registerDriver(id, ctor) {
  if (typeof ctor !== 'function') {
    throw new TypeError(`registerDriver: ctor for "${id}" must be a class`);
  }
  registry.set(id, ctor);
}

/**
 * Build an instance of the driver registered under `id`. Throws if
 * the id is unknown — the caller is responsible for catching and
 * surfacing the error to the user (e.g. "unsupported model").
 */
export function createDriver(id) {
  const ctor = registry.get(id);
  if (!ctor) throw new Error(`Unknown printer driver: "${id}". Registered: [${Array.from(registry.keys()).join(', ')}]`);
  return new ctor();
}

/** List registered driver ids. Useful for a manual model selector UI
 *  (e.g. to force a specific driver when auto-detection by SN isn't
 *  possible — Pro variants, for instance). */
export function listDrivers() {
  return Array.from(registry.keys());
}

// ---------- Built-in driver registration ----------
//
// IDs follow lowercase-no-spaces convention. The `MODEL_TO_DRIVER_ID`
// table in `./sn-registry.js` points at these ids when resolving a
// serial number to a specific driver.
//
// P780BT is tested and known-working on actual hardware. Every other
// model listed below is a thin parameter shim — same wire protocol,
// just different DPI / dither threshold / end-of-job bytes / tape
// width. Those drivers haven't been field-tested; see `./models.js`
// for per-model notes.

registerDriver('p780bt',    P780BTDriver);

// P-family
registerDriver('p24',       P24Driver);
registerDriver('p580',      P580Driver);
registerDriver('p1000',     P1000Driver);
registerDriver('amp310',    AMP310Driver);
registerDriver('p15',       P15Driver);
registerDriver('p3100d',    P3100DDriver);
registerDriver('p3100dj',   P3100DJDriver);
registerDriver('p3200',     P3200Driver);
registerDriver('p3200d',    P3200DDriver);
registerDriver('lt12',      LT12Driver);

// D-family
registerDriver('d480bt',    D480BTDriver);
registerDriver('d480btpro', D480BTProDriver);
registerDriver('d680bt',    D680BTDriver);
registerDriver('d1600',     D1600Driver);
registerDriver('d1600d',    D1600DDriver);
registerDriver('d30',       D30Driver);
registerDriver('d30s',      D30SDriver);
registerDriver('d50',       D50Driver);
registerDriver('q30',       Q30Driver);

// Misc
registerDriver('a30',       A30Driver);
registerDriver('lm1600',    LM1600Driver);
registerDriver('m950',      M950Driver);
registerDriver('m960',      M960Driver);

// ---------- window.BTPrinter (debug handle) ----------

if (typeof window !== 'undefined') {
  window.BTPrinter = {
    // Classes — for ad-hoc instantiation in the console.
    SerialLink,
    ResponseParser,
    Driver,
    PrinterDriver,
    P780BTDriver,
    // Constants — useful for hex-dumping responses by hand.
    PROTOCOL_CONSTANTS,
    P780BT_CONSTANTS,
    // Factory / registry.
    createDriver,
    registerDriver,
    listDrivers,
    // Live driver pointer — set by app.js after it creates one.
    driver: null,
  };
}

// Re-export for direct consumers (app.js imports from this file).
export {
  SerialLink, ResponseParser,
  Driver,
  PrinterDriver, PROTOCOL_CONSTANTS,
  P780BTDriver, P780BT_CONSTANTS,
};
