// =====================================================================
//  BTPrinter / quin-models.js — drivers for the QuinPrinter family
// ---------------------------------------------------------------------
//  One thin subclass of `QuinPrinterDriver` per printer model. Each
//  overrides only the parameter getters that actually differ —
//  everything else (the `1F 11 / 1A` wire protocol, frame decode,
//  identity check, print pipeline) is inherited unchanged from
//  `./quin-base.js`.
//
//  Values cross-referenced against the vendor `*Printer.java` files:
//  see the per-model comment headers below. Drivers marked
//  `// UNTESTED` have NOT been field-tested — they're derived from the
//  vendor code but we don't own the physical hardware. If you have
//  one of these printers and it misbehaves, the likely culprits are
//  `printFeedShiftPx` / `printVerticalShiftPx` (raster calibration —
//  P780BT uses +4/+2 from our own tuning, all others default to 0)
//  and occasionally `ditherThreshold` (vendor often uses 200, we
//  default to 128 for compatibility with the neutral sample set).
//
//  Not covered here:
//    - P780BT PRO / D480BT PRO / E50 PRO — 300 DPI variants the
//      vendor distinguishes by BT name, NOT serial number. We can't
//      tell them apart from the base model via Web Serial, so they're
//      not in the registry. Add back if we ever expose a manual
//      "force driver" UI.
//    - E6000 / E8000 / E50 / E50 PRO / E9000 / E93 — these use a
//      compressed raster (img2NvCompress / img2Nv4Native). We haven't
//      ported the compression codec, so the drivers would fail mid-
//      print. Listed as unsupported in `sn-registry.js`.
//    - M110C / M120C / M200C / M220C — compressed-mode siblings of
//      the non-C M-family. Same reason.
//    - B246D — entirely different text-based ASCII protocol. Needs
//      its own Driver subclass.
// =====================================================================

import { QuinPrinterDriver } from './quin-base.js';
import { P780BTDriver }      from './p780bt.js';

// =====================================================================
//  P-FAMILY
// =====================================================================

/** P24 — compact BT printer. Vendor: `P24Printer extends P780BTPrinter`,
 *  zero overrides (NOOP subclass). Inherits every P780BT parameter. */
// UNTESTED
export class P24Driver extends P780BTDriver {
  get model()        { return 'P24'; }
  get vendorModels() { return ['P24']; }
}

/** P580 — same chassis family as P24, also NOOP subclass of P780BT. */
// UNTESTED
export class P580Driver extends P780BTDriver {
  get model()        { return 'P580'; }
  get vendorModels() { return ['P580']; }
}

/** P1000 — 180 DPI, different end-of-job bytes (`[0x1B, 0x64, 0x02]`
 *  instead of `[0x1B, 0x64, 0x00]`). Vendor: `P1000Printer extends
 *  QuinPrinter`. */
// UNTESTED
export class P1000Driver extends QuinPrinterDriver {
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

/** P15 — 203 DPI, narrow 12 mm tape, different pager + dither.
 *  Vendor: `P15Printer extends QuinPrinter` with unique PRINT_PAGER
 *  `[0x1B, 0x64, 0x0C]`. */
// UNTESTED
export class P15Driver extends QuinPrinterDriver {
  get model()           { return 'P15'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 12; }
  get printPagerBytes() { return [0x1B, 0x64, 0x0C]; }
  get vendorModels()    { return ['P15']; }
}

/** P3100D — standard QuinPrinter-style 180 DPI, pager `[0x1B, 0x64, 0x02]`. */
// UNTESTED
export class P3100DDriver extends QuinPrinterDriver {
  get model()           { return 'P3100D'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x02]; }
  get vendorModels()    { return ['P3100D']; }
}

/** P3100DJ — `P3100DJPrinter extends P3100DPrinter`, overrides PRINT_PAGER
 *  to `[0x1B, 0x64, 0x01]`. Note: vendor registry lumps P3100D and
 *  P3100DJ under the same SN-prefix entry (both return "P3100D" from
 *  getName4Sn), so we can't distinguish them from serial alone — this
 *  driver is here as a reference but the registry points P3100D SN
 *  prefixes at `P3100DDriver` by default. */
// UNTESTED
export class P3100DJDriver extends P3100DDriver {
  get model()           { return 'P3100DJ'; }
  get printPagerBytes() { return [0x1B, 0x64, 0x01]; }
  get vendorModels()    { return []; }  // not reachable via SN alone
}

/** P3200 — 203 DPI, pager `[0x1B, 0x64, 0x0C]` (same as P15, differs
 *  by DPI from the P780 branch). Vendor: `P3200Printer extends
 *  QuinPrinter`. */
// UNTESTED
export class P3200Driver extends QuinPrinterDriver {
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

/** LT12 — vendor `LT12Printer extends P12Printer extends P1000Printer`,
 *  no protocol overrides (NOOP). Effectively a P1000 with a different
 *  label. */
// UNTESTED
export class LT12Driver extends P1000Driver {
  get model()        { return 'LT12'; }
  get vendorModels() { return ['LT12']; }
}

// =====================================================================
//  D-FAMILY
// =====================================================================

/** D480BT — 180 DPI (like P780BT), differs only in end-of-job byte.
 *  Vendor pager `[0x1B, 0x64, 0x1F]` (0x1F = 31). */
// UNTESTED
export class D480BTDriver extends QuinPrinterDriver {
  get model()           { return 'D480BT'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x1F]; }
  get vendorModels()    { return ['D480']; }
}

/** D480BT PRO — vendor `D480BTPROPrinter extends D480BTPrinter` (NOOP).
 *  As noted at the top of this file, we can't distinguish Pro from
 *  base via SN alone. */
// UNTESTED
export class D480BTProDriver extends D480BTDriver {
  get model()        { return 'D480BT PRO'; }
  get vendorModels() { return []; }
}

/** D680BT — 180 DPI, pager `[0x1B, 0x64, 0x21]` (0x21 = 33). Vendor:
 *  `D680BTPrinter extends QuinPrinter`. */
// UNTESTED
export class D680BTDriver extends QuinPrinterDriver {
  get model()           { return 'D680BT'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x21]; }
  get vendorModels()    { return ['D680BT']; }
}

/** D1600 — 203 DPI, no pager byte (empty end-of-job in vendor code).
 *  We send an explicit INIT_PRINTER as the "close" to stop the head
 *  cleanly — safer than a zero-length send. */
// UNTESTED
export class D1600Driver extends QuinPrinterDriver {
  get model()           { return 'D1600'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  // Vendor's D1600Printer defines an empty PRINT_PAGER. An empty send
  // is a no-op — we send ESC @ instead so the firmware resets state
  // between jobs rather than lingering.
  get printPagerBytes() { return [0x1B, 0x40]; }
  get vendorModels()    { return ['D1600']; }
}

/** D1600D — NOOP subclass. */
// UNTESTED
export class D1600DDriver extends D1600Driver {
  get model()        { return 'D1600D'; }
  get vendorModels() { return []; }
}

/** D30 — 203 DPI, narrow 12 mm tape, pager `[0x1B, 0x64, 0x17]`
 *  (0x17 = 23). Vendor `D30Printer extends QuinPrinter`. D30 is the
 *  root of a big subfamily: D30S / D30N / D30 PRO / D10 / D20 / D35
 *  inherit with no protocol overrides. */
// UNTESTED
export class D30Driver extends QuinPrinterDriver {
  get model()           { return 'D30'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 12; }
  get printPagerBytes() { return [0x1B, 0x64, 0x17]; }
  // Vendor registry groups all D30-subfamily SN prefixes under the
  // string "D30". D30S is a separate entry ("D30S") and points at
  // D30SDriver below.
  get vendorModels()    { return ['D30']; }
}

/** D30S — NOOP subclass of D30. Declared as a separate driver so the
 *  user sees "D30S" in the identity log rather than "D30". */
// UNTESTED
export class D30SDriver extends D30Driver {
  get model()        { return 'D30S'; }
  get vendorModels() { return ['D30S']; }
}

/** D50 — 180 DPI (!) despite extending D30 (which is 203). Vendor:
 *  `D50Printer extends D30Printer`, overrides DPI / threshold / scale
 *  back to P780BT-like values, pager `[0x1B, 0x64, 0x11]` (0x11 = 17). */
// UNTESTED
export class D50Driver extends D30Driver {
  get model()           { return 'D50'; }
  get dpi()             { return 180; }
  get ditherThreshold() { return 200; }
  get bitmapScaleSize() { return 0.8866995; }
  get printPagerBytes() { return [0x1B, 0x64, 0x11]; }
  get vendorModels()    { return ['D50']; }
}

/** Q30 — vendor `Q30Printer extends D30Printer` (NOOP). Same protocol
 *  as D30, different name. */
// UNTESTED
export class Q30Driver extends D30Driver {
  get model()        { return 'Q30'; }
  get vendorModels() { return ['Q30']; }
}

// =====================================================================
//  Misc
// =====================================================================

/** A30 — 203 DPI, narrow 12 mm, pager `[0x1B, 0x64, 0x0B]` (0x0B = 11).
 *  Vendor: `A30Printer extends QuinPrinter`. */
// UNTESTED
export class A30Driver extends QuinPrinterDriver {
  get model()           { return 'A30'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 12; }
  get printPagerBytes() { return [0x1B, 0x64, 0x0B]; }
  get vendorModels()    { return ['A30']; }
}

/** LM1600 — 203 DPI wide tape, pager `[0x1B, 0x64, 0x02]`. Vendor:
 *  `LM1600Printer extends QuinPrinter`. */
// UNTESTED
export class LM1600Driver extends QuinPrinterDriver {
  get model()           { return 'LM1600'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x02]; }
  get vendorModels()    { return ['LM1600']; }
}

/** M950 — 203 DPI wide tape, pager `[0x1B, 0x64, 0x07]`. Vendor:
 *  `M950Printer extends QuinPrinter`, no compression mode. */
// UNTESTED
export class M950Driver extends QuinPrinterDriver {
  get model()           { return 'M950'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x07]; }
  get vendorModels()    { return ['M950']; }
}

/** M960 — 203 DPI, pager `[0x1B, 0x64, 0x0D]` (0x0D = 13). Vendor:
 *  `M960Printer extends QuinPrinter`, no compression. */
// UNTESTED
export class M960Driver extends QuinPrinterDriver {
  get model()           { return 'M960'; }
  get dpi()             { return 203; }
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 1.0; }
  get maxPrintWidthMm() { return 48; }
  get printPagerBytes() { return [0x1B, 0x64, 0x0D]; }
  // Vendor SN → "M960" registry entry covers both M960 and M960D.
  get vendorModels()    { return ['M960']; }
}
