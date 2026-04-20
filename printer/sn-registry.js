// =====================================================================
//  BTPrinter / sn-registry.js — model lookup by serial-number prefix
// ---------------------------------------------------------------------
//  The vendor PrintMaster Android app identifies printer models by
//  looking at the first 4 ASCII characters of the serial number
//  returned by `1F 11 09 → 1A 08 <15 bytes>`. The mapping lives in
//  `com/project/aimotech/basiclib/printer/PrinterInfo.java::getName4Sn()`
//  — a ~150-line if/else chain. This file mirrors that chain verbatim,
//  plus a small resolver that our drivers consult during their
//  identity check.
//
//  The "model" string returned for each prefix is whatever the vendor
//  `getName4Sn()` returns — a mix of Serial codes (e.g. "P780"), Type
//  names (e.g. "D680BT") and raw literals ("D1600"). We preserve that
//  as-is so the user sees the same label the vendor shows, and so
//  cross-referencing the decompiled source stays trivial.
//
//  `MODEL_TO_DRIVER_ID` is our own shim — it maps those vendor model
//  strings to the driver IDs registered in `./index.js`. Only models
//  we've actually implemented a driver for appear here. The rest are
//  "recognised but unsupported" — we show the user a helpful message
//  instead of pretending to connect.
// =====================================================================

/**
 * Vendor PrinterInfo.getName4Sn() mapping — 42 models, 75+ SN
 * prefixes. Keys are the first 4 ASCII chars of the SN, upper-case.
 *
 * One quirk: `Q162` appears in BOTH the M108 and D30 branches of the
 * vendor source. In the original code, the outer M108 branch fires
 * first and the D30 branch for Q162 is dead code. We preserve that
 * resolution here (Q162 → M108).
 */
export const SN_PREFIX_TO_MODEL = Object.freeze({
  // M-series
  'Q002': 'M110',  'Q011': 'M110',  'Q026': 'M110',  'Q034': 'M110',
  'Q119': 'M110',  'Q192': 'M110',  'Q199': 'M110',
  'Q042': 'M108',  'Q045': 'M108',  'Q061': 'M108',  'Q062': 'M108',
  'Q120': 'M108',  'Q162': 'M108',  'Q194': 'M108',  'Q524': 'M108',
  'Q043': 'M109',
  'Q317': 'M105',
  'Q009': 'M120',  'Q158': 'M120',  'Q193': 'M120',  'Q244': 'M120',
  'Q038': 'M126',
  'Q306': 'M102',
  'Q377': 'M150',
  'Q378': 'M100',
  'Q006': 'M200',  'Q086': 'M200',  'Q104': 'M200',  'Q121': 'M200',
  'Q156': 'M200',  'Q197': 'M200',
  'Q017': 'M206',
  'Q053': 'M208',
  'Q305': 'M209',
  'Q054': 'M220',  'Q058': 'M220',  'Q155': 'M220',  'Q198': 'M220',
  'Q057': 'M219',  'Q157': 'M219',
  'Q218': 'M221',
  'Q420': 'M250',
  'Q421': 'M260',
  'Q379': 'M420',  'Q380': 'M420',

  // E-series
  'Q019': 'E6000', 'Q023': 'E6000',
  'Q296': 'E8000', 'Q314': 'E8000',
  'Q402': 'E9000',

  // D-series
  'Q216': 'D680BT',
  'Q083': 'D50',
  // D30 family — note Q162 is NOT here (taken by M108 in the outer
  // branch of getName4Sn; the vendor's Q162 inclusion in the D30 list
  // is dead code).
  'Q018': 'D30',   'Q040': 'D30',   'Q046': 'D30',   'Q049': 'D30',
  'Q050': 'D30',   'Q069': 'D30',   'Q092': 'D30',   'Q093': 'D30',
  'Q107': 'D30',   'Q109': 'D30',   'Q110': 'D30',   'Q138': 'D30',
  'Q159': 'D30',   'Q172': 'D30',   'Q189': 'D30',   'Q223': 'D30',
  'Q036': 'D30S',  'Q048': 'D30S',  'Q097': 'D30S',  'Q111': 'D30S',
  'Q125': 'D30S',  'Q149': 'D30S',  'Q150': 'D30S',  'Q183': 'D30S',
  'Q175': 'D1600', 'Q176': 'D1600',
  'Q215': 'D480',

  // P-series
  'Q004': 'P1000', 'Q030': 'P1000', 'Q031': 'P1000',
  'Q035': 'P1000', 'Q079': 'P1000',
  'Q217': 'P780',
  'Q173': 'P3200', 'Q174': 'P3200',
  'Q051': 'P3100D','Q133': 'P3100D',
  'Q295': 'P15',
  'Q373': 'P24',
  'Q393': 'P580',

  // Misc
  'Q311': 'M950',
  'Q309': 'LT12',
  'Q082': 'Q30',   'Q130': 'Q30',   'Q169': 'Q30',
  'Q027': 'B246D', 'Q081': 'B246D', 'Q100': 'B246D', 'Q101': 'B246D',
  'Q102': 'B246D', 'Q103': 'B246D',
  'Q294': 'A30',
  'Q310': 'LM1600',
});

/**
 * Map from vendor model string → our driver id (as registered in
 * `./index.js`). Only contains entries for models we've actually
 * implemented. Missing = "recognised but not supported" path in
 * detectDriverBySn() below.
 *
 * Add new entries here when you drop in a new driver.
 */
export const MODEL_TO_DRIVER_ID = Object.freeze({
  'P780': 'p780bt',
});

/**
 * Resolve a raw serial-number string to driver info.
 *
 *   detectDriverBySn('Q217E4810480004')
 *     → { sn: 'Q217E4810480004', prefix: 'Q217',
 *         vendorModel: 'P780', driverId: 'p780bt' }
 *
 *   detectDriverBySn('Q082123456')
 *     → { sn: 'Q082123456', prefix: 'Q082',
 *         vendorModel: 'Q30', driverId: null }   // known, unsupported
 *
 *   detectDriverBySn('XYZ999')
 *     → { sn: 'XYZ999', prefix: 'XYZ9',
 *         vendorModel: null, driverId: null }    // unknown
 *
 * The empty/null cases are what a driver's `_verifyIdentity` should
 * use to produce an informative rejection message for the user.
 */
export function detectDriverBySn(sn) {
  const normalized = (sn || '').toString().toUpperCase();
  const prefix = normalized.slice(0, 4);
  const vendorModel = SN_PREFIX_TO_MODEL[prefix] || null;
  const driverId = vendorModel ? (MODEL_TO_DRIVER_ID[vendorModel] || null) : null;
  return { sn: normalized, prefix, vendorModel, driverId };
}

/** List of vendor model strings we have drivers for. Useful for UI
 *  that wants to say e.g. "supported: P780BT". */
export function supportedModels() {
  return Object.keys(MODEL_TO_DRIVER_ID);
}
