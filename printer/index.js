// =====================================================================
//  BTPrinter — entry point
// ---------------------------------------------------------------------
//  This file is the single import surface for the rest of the app:
//
//      import { createDriver, registerDriver } from './printer/index.js';
//      const driver = createDriver('p780bt');
//
//  It also exposes a `BTPrinter` namespace on `window` for debugging
//  (e.g. pop the DevTools console and inspect `BTPrinter.driver` or
//  call `BTPrinter.driver.readAll()`). The UI does NOT rely on the
//  window global — it's purely a convenience for humans.
// =====================================================================

import { SerialLink, ResponseParser } from './transport.js';
import { Driver }                     from './driver-base.js';
import { P780BTDriver, P780BT_CONSTANTS } from './p780bt.js';

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

/** List registered driver ids. Useful for building a model-selector UI
 *  once we have more than one driver. */
export function listDrivers() {
  return Array.from(registry.keys());
}

// Register the built-in driver(s). New models add a line here.
registerDriver('p780bt', P780BTDriver);

// ---------- window.BTPrinter (debug handle) ----------

// Stash references on `window` for debugging. The app stores the
// currently-active driver here via `BTPrinter.driver = …` after it
// calls `createDriver`, so a developer can poke at it from DevTools.
if (typeof window !== 'undefined') {
  window.BTPrinter = {
    // Classes — for ad-hoc instantiation in the console.
    SerialLink,
    ResponseParser,
    Driver,
    P780BTDriver,
    // Constants — useful for hex-dumping responses by hand.
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
export { SerialLink, ResponseParser, Driver, P780BTDriver, P780BT_CONSTANTS };
