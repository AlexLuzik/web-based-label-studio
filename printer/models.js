// =====================================================================
//  BTPrinter / models.js — one driver per supported printer model
// ---------------------------------------------------------------------
//  Each class is a thin subclass of `PrinterDriver` (see `./base.js`)
//  that overrides only the parameter getters that actually differ —
//  everything else (the `1F 11 / 1A` wire protocol, frame decode,
//  identity check, print pipeline) is inherited unchanged.
//
//  Drivers marked `// UNTESTED` have NOT been verified against real
//  hardware. If you have one of these printers and it misbehaves,
//  the likely culprits are:
//    * `printFeedShiftPx` / `printVerticalShiftPx` — raster
//      calibration nudges. P780BT uses +4/+2 from the author's own
//      field tuning; all other drivers default to 0/0.
//    * `ditherThreshold` — how dark-biased the 1-bit conversion is.
//      We default to 128 (mathematical midpoint) across the board;
//      some models may need 200 (darker bias) for visually comparable
//      output.
//
//  Not covered in this file (known-but-unsupported models):
//    * P780BT PRO / D480BT PRO / E50 PRO — 300 DPI variants that
//      share an SN prefix with their non-Pro siblings. We can't tell
//      them apart from the serial alone, so they're not auto-
//      selected. Would need a manual "force driver" UI.
//    * E6000 / E8000 / E50 / E50 PRO / E9000 / E93 — use a
//      compressed raster format (`img2NvCompress` /
//      `img2Nv4Native`). We haven't ported the compression codec, so
//      the drivers would fail mid-print. Listed as unsupported in
//      `sn-registry.js`.
//    * M110C / M120C / M200C / M220C — compressed-mode siblings of
//      the non-C M-family. Same reason.
//    * B246D — entirely different text-based ASCII protocol. Needs
//      its own non-PrinterDriver subclass.
// =====================================================================

import { PrinterDriver, PROTOCOL_CONSTANTS } from './base.js';

// =====================================================================
//  P-FAMILY
// =====================================================================

/**
 * P780BT — the author's actual printer. Tested on real hardware.
 *
 * Parameters: 180 DPI, 48 mm max tape, scale factor 0.8866995, end-of-
 * job bytes `[0x1B, 0x64, 0x00]`. SN prefix Q217. `ditherThreshold:
 * 128` is the mathematical midpoint — produces clean output on our
 * neutral sample set; some alternatives in the literature bias
 * darker (threshold 200). The +4/+2 px raster shifts are our own
 * field-tuned calibration; every other driver starts at 0/0 and
 * needs per-hardware dial-in.
 */
export class P780BTDriver extends PrinterDriver {
  get model()                { return 'P780BT'; }
  get dpi()                  { return 180; }
  get ditherThreshold()      { return 128; }
  get bitmapScaleSize()      { return 0.8866995; }
  get maxPrintWidthMm()      { return 48; }
  get printFeedShiftPx()     { return 4; }
  get printVerticalShiftPx() { return 2; }
  get printPagerBytes()      { return [0x1B, 0x64, 0x00]; }
  get vendorModels()         { return ['P780']; }
}

// Backward-compat alias — legacy code imported `P780BT_CONSTANTS` from
// the old per-model file; now the shared constants live in base.js
// but we re-export under the old name so nothing breaks.
export const P780BT_CONSTANTS = PROTOCOL_CONSTANTS;

/** P24 — compact BT printer; inherits every P780BT parameter. */
// UNTESTED
export class P24Driver extends P780BTDriver {
  get model()        { return 'P24'; }
  get vendorModels() { return ['P24']; }
}

/** P580 — same parameter set as P24 / P780BT. */
// UNTESTED
export class P580Driver extends P780BTDriver {
  get model()        { return 'P580'; }
  get vendorModels() { return ['P580']; }
}

/** P1000 — 180 DPI, end-of-job bytes `[0x1B, 0x64, 0x02]` (differ from
 *  P780BT's `[0x1B, 0x64, 0x00]`). */
// UNTESTED
export class P1000Driver extends PrinterDriver {
  get model()           { return 'P1000'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x02]; }
  get vendorModels()    { return ['P1000']; }
}

/** AMP310 — NOOP subclass of P1000. */
// UNTESTED
export class AMP310Driver extends P1000Driver {
  get model()        { return 'AMP310'; }
  // Shares SN-prefix set with P1000 in the vendor registry, so no
  // separate vendorModels entry — the user would need to force
  // this driver manually if they have an AMP310 unit.
  get vendorModels() { return []; }
}

/** P15 — 203 DPI, narrow 12 mm tape, unique end-of-job bytes
 *  `[0x1B, 0x64, 0x0C]`. */
// UNTESTED
export class P15Driver extends PrinterDriver {
  get model()           { return 'P15'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 12; }
  get printPagerBytes() { return [0x1B, 0x64, 0x0C]; }
  get vendorModels()    { return ['P15']; }
}

/** P3100D — 180 DPI, end-of-job bytes `[0x1B, 0x64, 0x02]`. */
// UNTESTED
export class P3100DDriver extends PrinterDriver {
  get model()           { return 'P3100D'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x02]; }
  get vendorModels()    { return ['P3100D']; }
}

/** P3100DJ — same as P3100D but end-of-job bytes are `[0x1B, 0x64, 0x01]`.
 *  Note: the SN registry lumps P3100D and P3100DJ under a single
 *  prefix entry — we can't distinguish them from the serial alone,
 *  so this driver is here as a reference and the registry points
 *  P3100D SN prefixes at `P3100DDriver` by default. */
// UNTESTED
export class P3100DJDriver extends P3100DDriver {
  get model()           { return 'P3100DJ'; }
  get printPagerBytes() { return [0x1B, 0x64, 0x01]; }
  get vendorModels()    { return []; }  // not reachable via SN alone
}

/** P3200 — 203 DPI, end-of-job bytes `[0x1B, 0x64, 0x0C]` (matches P15,
 *  but uses the wide-tape parameter set). */
// UNTESTED
export class P3200Driver extends PrinterDriver {
  get model()           { return 'P3200'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x0C]; }
  get vendorModels()    { return ['P3200']; }
}

/** P3200D — NOOP subclass of P3200. */
// UNTESTED
export class P3200DDriver extends P3200Driver {
  get model()        { return 'P3200D'; }
  get vendorModels() { return []; }  // rolls up into P3200 via registry
}

/** LT12 — same parameters as P1000, different model label. */
// UNTESTED
export class LT12Driver extends P1000Driver {
  get model()        { return 'LT12'; }
  get vendorModels() { return ['LT12']; }
}

// =====================================================================
//  D-FAMILY
// =====================================================================

/** D480BT — 180 DPI (like P780BT), differs only in end-of-job byte:
 *  `[0x1B, 0x64, 0x1F]` (0x1F = 31). */
// UNTESTED
export class D480BTDriver extends PrinterDriver {
  get model()           { return 'D480BT'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x1F]; }
  get vendorModels()    { return ['D480']; }
}

/** D480BT PRO — same parameters as D480BT at the protocol level. As
 *  noted at the top of this file, we can't distinguish Pro from base
 *  via SN alone. */
// UNTESTED
export class D480BTProDriver extends D480BTDriver {
  get model()        { return 'D480BT PRO'; }
  get vendorModels() { return []; }
}

/** D680BT — 180 DPI, end-of-job bytes `[0x1B, 0x64, 0x21]` (0x21 = 33). */
// UNTESTED
export class D680BTDriver extends PrinterDriver {
  get model()           { return 'D680BT'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x21]; }
  get vendorModels()    { return ['D680BT']; }
}

/** D1600 — 203 DPI. The reference parameter set for this model uses
 *  an EMPTY end-of-job command; an empty send would be a no-op, so
 *  we substitute ESC @ (INIT_PRINTER) as the "close" — it stops the
 *  print head cleanly and resets firmware state between jobs. */
// UNTESTED
export class D1600Driver extends PrinterDriver {
  get model()           { return 'D1600'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x40]; }
  get vendorModels()    { return ['D1600']; }
}

/** D1600D — NOOP subclass. */
// UNTESTED
export class D1600DDriver extends D1600Driver {
  get model()        { return 'D1600D'; }
  get vendorModels() { return []; }
}

/** D30 — 203 DPI, narrow 12 mm tape, end-of-job bytes
 *  `[0x1B, 0x64, 0x17]` (0x17 = 23). Root of a big subfamily — D30S,
 *  D30N, D30 PRO, D10, D20, D35 all share the same parameters at the
 *  protocol level. */
// UNTESTED
export class D30Driver extends PrinterDriver {
  get model()           { return 'D30'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 12; }
  get printPagerBytes() { return [0x1B, 0x64, 0x17]; }
  // The SN registry groups all D30-subfamily prefixes under "D30".
  // D30S is a separate registry entry ("D30S") that points at
  // D30SDriver below.
  get vendorModels()    { return ['D30']; }
}

/** D30S — same parameters as D30 at the protocol level. Declared as
 *  a separate driver so the user sees "D30S" in the identity log
 *  rather than "D30". */
// UNTESTED
export class D30SDriver extends D30Driver {
  get model()        { return 'D30S'; }
  get vendorModels() { return ['D30S']; }
}

/** D50 — 180 DPI (!) despite sharing most of the D30 parameter set
 *  (12 mm tape, 203-DPI siblings). Overrides DPI / threshold / scale
 *  back to P780BT-like values plus end-of-job bytes `[0x1B, 0x64,
 *  0x11]` (0x11 = 17). */
// UNTESTED
export class D50Driver extends D30Driver {
  get model()           { return 'D50'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get printPagerBytes() { return [0x1B, 0x64, 0x11]; }
  get vendorModels()    { return ['D50']; }
}

/** Q30 — same protocol parameters as D30, different model label. */
// UNTESTED
export class Q30Driver extends D30Driver {
  get model()        { return 'Q30'; }
  get vendorModels() { return ['Q30']; }
}

// =====================================================================
//  Misc
// =====================================================================

/** A30 — 203 DPI, narrow 12 mm tape, end-of-job bytes
 *  `[0x1B, 0x64, 0x0B]` (0x0B = 11). */
// UNTESTED
export class A30Driver extends PrinterDriver {
  get model()           { return 'A30'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 12; }
  get printPagerBytes() { return [0x1B, 0x64, 0x0B]; }
  get vendorModels()    { return ['A30']; }
}

/** LM1600 — 203 DPI wide tape, end-of-job bytes `[0x1B, 0x64, 0x02]`. */
// UNTESTED
export class LM1600Driver extends PrinterDriver {
  get model()           { return 'LM1600'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x02]; }
  get vendorModels()    { return ['LM1600']; }
}

/** M950 — 203 DPI wide tape, end-of-job bytes `[0x1B, 0x64, 0x07]`,
 *  no compression mode. */
// UNTESTED
export class M950Driver extends PrinterDriver {
  get model()           { return 'M950'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x07]; }
  get vendorModels()    { return ['M950']; }
}

/** M960 — 203 DPI, end-of-job bytes `[0x1B, 0x64, 0x0D]` (0x0D = 13),
 *  no compression. */
// UNTESTED
export class M960Driver extends PrinterDriver {
  get model()           { return 'M960'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x0D]; }
  // The SN-registry "M960" entry covers both M960 and M960D.
  get vendorModels()    { return ['M960']; }
}
