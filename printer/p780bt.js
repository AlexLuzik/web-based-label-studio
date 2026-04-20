// =====================================================================
//  BTPrinter / p780bt.js — driver for the EazeID P780BT
// ---------------------------------------------------------------------
//  Thin subclass of `QuinPrinterDriver`. All the QuinPrinter-family
//  protocol lives in `./quin-base.js`; this file just declares the
//  P780BT-specific parameter set.
//
//  Values cross-referenced with:
//   - vendor P780BTPrinter.java (DPI 180, dither 200, scale 0.8866995,
//     printPager [27,100,0])
//   - PrinterInfo.java `getName4Sn()` (SN prefix Q217 → Serial.P780)
//   - our own field calibration on the author's printer (feed +4 px,
//     vertical +2 px — verified correct against printed output).
// =====================================================================

import { QuinPrinterDriver, QUIN_CONSTANTS } from './quin-base.js';

export class P780BTDriver extends QuinPrinterDriver {
  get model()           { return 'P780BT'; }
  get dpi()             { return 180; }
  // The only value here we diverge from the vendor on: vendor uses
  // `ditherThreshold: 200` (bias toward black). 128 (mathematical
  // midpoint) has produced clean prints in practice and changing it
  // would be an untested behavioural shift, so we stay on 128.
  get ditherThreshold() { return 128; }
  get bitmapScaleSize() { return 0.8866995; }
  get maxPrintWidthMm() { return 48; }
  // Experimentally-verified calibration on a real P780BT. Other
  // models inherit QuinPrinter's defaults of 0/0 and will need
  // per-model field-testing to dial in.
  get printFeedShiftPx()     { return 4; }
  get printVerticalShiftPx() { return 2; }
  get printPagerBytes()      { return [0x1B, 0x64, 0x00]; }
  // SN-prefix Q217 maps to vendor serial family "P780" — see
  // printer/sn-registry.js.
  get vendorModels() { return ['P780']; }
}

// Backward-compat: legacy app code imported `P780BT_CONSTANTS` for
// debug / hex-dump purposes. The shared constants now live under
// `QUIN_CONSTANTS`; alias it so external callers don't break.
export const P780BT_CONSTANTS = QUIN_CONSTANTS;
