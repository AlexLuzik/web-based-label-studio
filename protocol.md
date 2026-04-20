# Bluetooth Thermal Label Printer — Protocol Reference

> Technical documentation for the wire protocol spoken by a family of
> Bluetooth thermal label printers built around the same SDK. The
> protocol is identical across the family; models differ only in a
> handful of parameters (DPI, end-of-job bytes, tape width, dither
> threshold). The reference implementation was verified on a
> **P780BT** and extended to ~24 sibling models via parameter shims —
> see [§2 Supported models](#2-supported-models) for the full list.

**Author:** [Oleksandr Luzin](https://luzin.cc) &middot; **Status:** living document

**License of this document** (original prose, tables and structure):
[MIT](https://opensource.org/license/mit/). The *protocol itself* is a
factual interface and is not copyrightable (see *Google v. Oracle*,
593 U.S. \_\_\_ (2021)) — documenting it here does not grant or claim
any rights over it. The vendor SDK sources, APK, firmware and all
brand names / trademarks belong to their respective owners; see the
[Legal & fair-use notice](#legal--fair-use-notice) at the bottom for
the U.S. legal basis (DMCA § 1201(f) interoperability exemption, fair
use under 17 U.S.C. § 107, nominative trademark fair use).

Reverse-engineered from the vendor Android companion app
(decompiled with jadx) cross-checked against a real **btsnoop** HCI
capture plus live traffic from an independent Web Serial client.
Everything in this file is a description of observable facts (bytes
on the wire, values returned) — no vendor source code has been
copied into this document.

Legend used throughout this file:

| Marker | Meaning |
|:------:|---------|
| ✅ | Verified working on P780BT firmware `0.1.9` (tested on hardware) |
| ⚠️ | Present in the vendor SDK but unverified on the author's hardware — may or may not answer on a given model |
| ❌ | Confirmed **silent** on P780BT firmware `0.1.9` — command accepted, no response. Behaviour on other models unknown. |

---

## Table of contents

1. [Hardware characteristics (family)](#1-hardware-characteristics-family)
2. [Supported models](#2-supported-models)
3. [Bluetooth connection setup](#3-bluetooth-connection-setup)
4. [Application protocol format](#4-application-protocol-format)
5. [GET commands (read)](#5-get-commands-read)
6. [SET commands (write)](#6-set-commands-write)
7. [Response tags](#7-response-tags)
8. [Image printing (raster pipeline)](#8-image-printing-raster-pipeline)
9. [Firmware update (OTA)](#9-firmware-update-ota)
10. [Public SDK API surface](#10-public-sdk-api-surface)
11. [Per-model parameters](#11-per-model-parameters)
12. [Observed values from test hardware (P780BT)](#12-observed-values-from-test-hardware-p780bt)
13. [Wireshark filters](#13-wireshark-filters)
14. [How this document was produced](#14-how-this-document-was-produced)
15. [Broader model catalog](#15-broader-model-catalog)

---

## 1. Hardware characteristics (family)

The properties below are shared across every model in the family.
Per-model numbers (DPI, max print width, dither threshold, bitmap
scale factor, end-of-job bytes) live in
[§11 Per-model parameters](#11-per-model-parameters).

| Property | Value |
|---|---|
| BT chip | JieLi AC69xx (AC6951 / AC6961 — "Jerry" family) |
| BT profile | Classic BT + BLE dual-mode |
| Default BT name | model-specific (e.g. `P780BT`, `D480BT`) |
| BT SDP service | **JL_SPP** (JieLi Serial Port Profile) |
| Data transport | SPP / RFCOMM, Channel 1 (DLCI `0x02`) |
| SPP UUID | standard `00001101-0000-1000-8000-00805F9B34FB` |
| Print type | thermal, 1 bpp raster |
| Effective DPI | 180 / 203 / 300 (model-specific) |
| RFID | supported on cartridge-based models (consumables tracking) |

---

## 2. Supported models

This project ships drivers for **24 models**, all speaking the same
wire protocol documented in §§4–10 below. Differences are captured
entirely by a handful of parameters (DPI, dither threshold, bitmap
scale factor, end-of-job bytes, max tape width) — see [§11 Per-model
parameters](#11-per-model-parameters) for the full table.

| Family | Models |
|---|---|
| **P-series** | P780BT, P24, P580, P1000, AMP310, P15, P3100D, P3100DJ, P3200, P3200D, LT12 |
| **D-series (BT)** | D480BT, D480BT PRO, D680BT, D1600, D1600D |
| **D-series (portable)** | D30, D30S, D50 |
| **Q-series** | Q30 |
| **Misc** | A30, LM1600, M950, M960 |

**P780BT** is the reference model — the author owns one, this is the
hardware every behavioural observation in this document was verified
against. Other drivers are derived by transplanting the parameter
set from the vendor SDK; they are structurally correct but have not
been field-tested.

Selection is automatic on connect: the app reads the serial number
(`1F 11 09` → `1A 08 <15 ASCII>`), looks up the first 4 characters in
its SN-prefix registry, and loads the matching driver. See
[§11 Per-model parameters](#11-per-model-parameters) for the
prefix → model table.

### Known models NOT covered here

Some models in the vendor catalog use protocol extensions that this
project has not ported yet:

- **Compressed-raster variants** — `E6000`, `E8000`, `E50`, `E50 PRO`,
  `E9000`, `E93` and the `*C` M-family siblings (`M110C`, `M120C`,
  `M200C`, `M220C`). They send the image with an extra `img2NvCompress`
  / `img2Nv4Native` encoding layer not documented here.
- **Text-command protocol** — `B246D` uses an entirely different
  ASCII-based `SSS<CMD>\r\n` wire format. Requires a separate driver
  base class.
- **PRO / 300-DPI variants** — `P780BT PRO`, `D480BT PRO`, `E50 PRO`
  share an SN prefix with their non-Pro siblings, so this project's
  SN-based auto-detect currently resolves them to the base driver
  (wrong DPI). Support would require a manual driver-selector UI.

---

## 3. Bluetooth connection setup

Handshake sequence observed in the btsnoop capture:

```
1. Classic BT ACL connect
2. SDP Service Search Attribute — query PnP Information
3. L2CAP Information Request (Extended Features Mask)
4. L2CAP Connect PSM=0x03 (RFCOMM), SCID 0x0043
5. RFCOMM:  SABM Ch0 → UA → PN (Parameter Negotiation)
         → SABM Ch1 → UA (Serial Port open)
6. RFCOMM MSC (Modem Status) exchange
7. First application command
```

On connect the reference SDK auto-fires a status sweep:

- `CHIP_TYPE` — `1F 11 38`
- `PAPER_STATE` — `1F 11 11`
- `COVER_STATE` — `1F 11 12`
- `HOT_STATE` — `1F 11 13`
- `SN` — `1F 11 09` (used for identification)
- `FIRMWARE_VERSION` — `1F 11 07`

---

## 4. Application protocol format

Everything runs on top of plain SPP — no framing layer of its own. Two
message shapes:

### Request — host → printer

```
┌──────┬──────┬──────────────┐
│ 0x1F │ 0x11 │ <cmd> [args] │
└──────┴──────┴──────────────┘
```

Alternate prefixes for specific command families:

- `1B 4E` (ESC N) — raster & bitmap setters
- `1B 40` (ESC @) — init
- `1D 76` / `1D 78` / `1D BC` — ESC/POS raster variants

Multiple commands may be coalesced into one SPP packet:

```
1F 11 38 | 1F 11 11 | 1F 11 12 | 1F 11 13 | 1F 11 09
```

### Response — printer → host

```
┌──────┬──────┬──────────────┐
│ 0x1A │ <tag>│ <payload...> │
└──────┴──────┴──────────────┘
```

Prefix `0x1A` (ASCII SUB). Some vendor-firmware ACKs use `0x1B` (ESC)
instead. Responses arrive as individual UIH packets and usually follow
the request order, but asynchronous status notifications are allowed
(e.g. cover-open mid-print).

---

## 5. GET commands (read)

Source of truth: `InsGet.java`. All requests have the form `1F 11 <cmd>`.

| ✓ | cmd | Name | Response payload | Parsed as |
|:-:|-----|------|------------------|-----------|
| ✅ | 0x07 | FIRMWARE_VERSION | 3 bytes | `"{b0}.{b1}.{b2}"` string |
| ✅ | 0x08 | BATTERY | 1 byte | `0xA1..0xA4` markers (high/med/low/fault); `0x00` = fully charged on FW 0.1.9; anything else = raw 0..100% |
| ✅ | 0x09 | SN | 15 ASCII bytes | serial number (chars outside `[0-9A-Z]` → `'8'`) |
| ✅ | 0x0E | AUTO_POWER_TIME | 1 byte | P-series: byte × 5 minutes (0 = never) |
| ✅ | 0x11 | PAPER_STATE | 1 byte | `0x88` = no paper, `0x89` = OK |
| ✅ | 0x12 | COVER_STATE | 1 byte | `0x98` = closed, `0x99` = open |
| ✅ | 0x13 | HOT_STATE | 1 byte | `0xA8` = normal, `0xA9` = overheated |
| ⚠️ | 0x18 | LABEL_WIDTH | — | label width |
| ✅ | 0x19 | LABEL_TYPE | 1 byte | `0x0A` Gap · `0x0B` Continuous · `0x26` Black mark · `0x4E` Other |
| ⚠️ | 0x1B | CUT_STATE | — | cutter state |
| ⚠️ | 0x1C | DPI_CONCENTRATION | — | DPI density |
| ⚠️ | 0x1D | SENSOR_INFO | — | sensor data |
| ⚠️ | 0x1E | PAPER_LEARN | — | paper calibration |
| ❌ | 0x1F | VOLTAGE | — | **no reply on P780BT FW 0.1.9** |
| ✅ | 0x20 | BT_MAC | 12 ASCII hex | Bluetooth MAC address |
| ⚠️ | 0x22 | RFID_REMAIN | `type(1) hi(1) lo(1)` | consumable remaining count (needs cartridge) |
| ❌ | 0x28 | ALL_ERROR | — | **no reply on P780BT FW 0.1.9** |
| ⚠️ | 0x31 | RFID_LABEL_INFO | `type(1) hi(1) lo(1)` | label ID `%05d`, 0 = none |
| ✅ | 0x38 | CHIP_TYPE | 3 flag bytes | support flags (multiConn, multiConcentration, newRedBlack, supportUid) |
| ✅ | 0x3F | GET_MATERIAL_ENCRYPT_DETAIL | 14-byte struct | consumable type / color / size |
| ⚠️ | 0x41 | EXIT_AT_MODE | — | |
| ⚠️ | 0x42 | SHUTDOWN | — | power off the printer (dangerous) |
| ⚠️ | 0x43 | CHARGE_MODE | 1 byte | `2` = charging |
| ⚠️ | 0x45 | IOS_DATA_TYPE | — | |
| ⚠️ | 0x46 | TOUCH_ENCRYPT | — | |
| ⚠️ | 0x47 | DOMAIN | — | |
| ⚠️ | 0x48 | SET_TASK_ID | — | |
| ⚠️ | 0x49 | CUSTOMER_ID | — | |
| ⚠️ | 0x4A | BT_LOSS_TEST | — | BT loss test |
| ⚠️ | 0x4B | BT_LOSS_TEST_RESULT / DATE_FORMAT | 2 bytes | date format / loss test result |
| ⚠️ | 0x4C | BT_VER | 1 byte | `3 / 7 / 8` → Jerry chip (`bluetoothType=true`) |
| ⚠️ | 0x4D | ENCRYPT_LABEL_TOTAL | — | |
| ⚠️ | 0x4E | BT_CHIP_TYPE | 1 byte | BT chip type |
| ⚠️ | 0x4F | UI_INDEX | — | |
| ⚠️ | 0x50 | BT_ENCRYPT | — | |
| ⚠️ | 0x51 | COMPRESS_TYPE | — | |
| ⚠️ | 0x53 | GRAPH_INDEX | — | |
| ⚠️ | 0x54 | PRINT_BUSY | 1 byte | `0` = idle |
| ⚠️ | 0x65 | POWER_KEY_TYPE | 1 byte | power-key type |
| ⚠️ | 0x68 | PRINT_BUSY_MUTABLE | 1 byte | multi-connection variant |
| ⚠️ | 0x99 | QUERY_CONSUMABLES_UID | `len(1) data(N)` | consumable UID as hex |

> **Note on `0x08` BATTERY** — on firmware `0.1.9` we have only ever
> observed `0x00` replies, even when the battery is physically full and
> the printer is powered. Since a genuinely 0% battery could not answer,
> the `0x00` byte is treated as **100%** by our client. Markers
> `0xA1..0xA4` are documented in the SDK but we have not yet witnessed
> them on this firmware.

---

## 6. SET commands (write)

Source of truth: `InsSet.java`. These trigger side-effects (change
settings, send data, start a print); most do not answer.

| Bytes (hex) | Name | Arguments |
|---|---|---|
| `1B 40` | INIT_PRINTER | none (ESC @ reset) |
| `1B 64 XX` | PRINT_AND_FEED | 1 byte: feed line count (P780BT uses `00`) |
| `1B 4E 04` | DEFAULT_PRINT_DENSITY | |
| `1B 4E 07 XX` | AUTO_SHUTDOWN_TIME | 1 byte: minutes |
| `1B 4E 08 SN...` | DEVICE_ID (modifySn) | SN bytes |
| `1B 4E 1C 01 ...` | DEFAULT_DATE_FORMAT | format bytes |
| `1B 4E 1C 02 YY MM DD HH MM SS` | DEFAULT_TIME | 6 bytes |
| `1B 4E 1E` | SET_PRINT_IMAGE_F12 | F12 only: header `{idx, xL, xH, yL, yH}` + raster |
| **`1B 4E 1F`** | **SET_PRINT_IMAGE** | primary raster print command for P780BT |
| `1B 4E 20` | SET_PRINT_IMAGE_INDEX | |
| `1B 4E 20 00` | SET_PRINT_IMAGE_INDEX_DEFAULT | |
| `1B 4E 21 XX` | SET_DATE_TITLE | 1 byte: flag |
| `1B 4E 24 IDX ON` | SET_DATE_REGION | 2 bytes |
| `1B 4E 25 XX` | POWER_KEY_TYPE | 1 byte |
| `1B 4E 27 T HI LO` | PRINT_CONSUMABLES_REMAIN_AMOUNT | 3 bytes |
| `1B 4E 62 14 [22 bytes]` | PRINT_TEN_CONCENTRATION_PARAMS | 22 density param bytes |
| `1D 76 30 00 ...` | PRINT_IMAGE | base ESC/POS raster |
| `1D 78 30 00 ...` | PRINT_IMAGE_DUAL_COLOR | red / black (legacy) |
| `1D BC 30 00 ...` | PRINT_IMAGE_DUAL_COLOR_2 | new RGB scheme (`supportNewRedBlack`) |
| `1F 11 02 XX` | PRINT_DENSITY | 1 byte: density |
| `1F 11 0B` | PAPER_TYPE | 1 byte: `0A`=Gap, `0B`=Continuous, `26`=Black mark, `4E`=Other/Card |
| `1F 11 0C` | CANCEL_IMAGE_TEXT_MODE | |
| `1F 11 0D` | IMAGE_TEXT_MODE | |
| `1F 11 0F` | OTA_MODE | enter firmware-upgrade mode |
| `1F 11 14 [CRC(4)] [LEN(4)] [data]` | FIRMWARE_UPGRADE_START | |
| `1F 11 15` | FIRMWARE_UPGRADE_CONFIRM | |
| `1F 11 16` | FIRMWARE_UPGRADE_CANCEL | |
| `1F 11 17 W` | LABEL_WIDTH | label width |
| `1F 11 1A` | PRINT_DENSITY_COMPENSATION | |
| `1F 11 21 N` | PRINT_MULTI | 1 byte: copy count |
| `1F 11 23 S` | PRINT_SPEED | 1 byte: speed |
| `1F 11 24 M` | LEFT_MARGIN | 1 byte: margin |
| `1F 11 25` | AUTO_LOCATE | auto positioning |
| `1F 11 27` | PRINT_TEST_PAGE | print the built-in test page |
| `1F 11 29` | DISCONNECT_BT | |
| `1F 11 2A` | CUTTER_STATUS | |
| `1F 11 2B` | BACK_PAPER | roll paper back |
| `1F 11 2C` | GET_MAC | |
| `1F 11 2E` | GET_HOTSPOT_NAME | |
| `1F 11 2F` | GET_PRINT_STATUS | |
| `1F 11 30` | AUTO_CUT | |
| `1F 11 32` | FEED_PAPER | feed paper |
| `1F 11 35 00` | EXIT_COMPRESS_MODE | |
| `1F 11 35 01` | ENTER_COMPRESS_MODE | |
| `1F 11 37` | PRINT_DENSITY_COEFFICIENT | |
| `1F 11 39 11` | MATERIAL_CONFIG | |
| **`1F 11 3C`** | **PRINT_MODE / PRINT_PAUSE** | pause between copies on P780BT |
| `1F 11 3D` | GET_BIND_STATUS | |
| `1F 11 3E` | GET_IP | |
| `1F 11 3F` | GET_MATERIAL_ENCRYPT_DETAIL | |
| `1F 11 40` | SET_CARD_PAPER | |
| `1F 11 54 88` | WRITE_START | entry-write begin |
| `1F 11 54 89` | WRITE_END | entry-write end |
| `1F 11 69 [...]` | PRINT_MULTI_DENSITY | multi-concentration |
| `1F 11 88` | SET_CRIMP_MODE | |
| `1A 18 01` | HEART_BEAT | keepalive (prefix `1A`, not `1F 11`) |

---

## 7. Response tags

Response format: `1A <tag> <payload>`. The tag defines payload
semantics. Parser lives in `QuinPrinter.InstructionProcessor`.

### Main cases (inside the switch block)

| tag | Response to | Payload | Action |
|-----|-------------|---------|--------|
| 3 | HOT_STATE | 1 byte | `0xA8` normal · `0xA9` overheated → `onOverheaStatetChange` |
| 4 | BATTERY | 1 byte | markers `0xA1`=high · `0xA2`=med · `0xA3`=low · `0xA4`=fault (SDK maps to 10/5/3/-1); otherwise raw 0..100 % |
| 5 | COVER_STATE | 1 byte | `0x98`=closed · `0x99`=open → `onCoverStateChange`; opening mid-print = error |
| 6 | PAPER_STATE | 1 byte | `0x88` no paper → `onPaperStateChange`; when present → queries LABEL_TYPE |
| 7 | FIRMWARE_VERSION | 3 bytes | `"{b0}.{b1}.{b2}"` → `onGetVersion` |
| 8 | SN | 15 ASCII bytes | `[0-9A-Z]` filter → `mSerialCallBack` |
| 9 | AUTO_POWER_TIME | 1 byte | P-series (P780BT): byte × 5 = minutes (0=Never, 1=5m, 3=15m, 6=30m, 12=1h, 24=2h, 48=4h, 96=8h); other series use different tables |
| 10 | CRC32 firmware | 2 or 4 bytes (reversed) | CRC verification → FIRMWARE_UPGRADE_CONFIRM / CANCEL |
| 11 | Cancel ACK | 1 byte | `0xB8` → `onCancel()` |
| 12 | LABEL_TYPE | 1 byte | `0x0B`→enum 0 (Continuous) · `0x26`→enum 3 (Black mark) · else→enum 2 (Gap) → `getPaperType` |
| 21 | RFID_REMAIN | `type(1) hi(1) lo(1)` | type: 0=CarbonBelt, 1=Paper, 2=Ribbon → `onCarbon/Paper/Ribbon RemainCount`; count=0 → `onError` |
| 22 | VERIFY_PAPER | none | `resetPaperListener.resetSuccess()` |
| 23 | BT_CHIP_TYPE / BT_VER | 1 byte | 3/7/8 → `bluetoothType=true` (Jerry chip, CRC16-XMODEM for firmware) |
| 62 | PRINT_BUSY / PRINT_BUSY_MUTABLE | 1 byte | 0=idle → `mPrintBusyStateCallBack` |
| 63 | Material encrypt ERROR | 1 err byte | `onConsumableError` + `onMaterialError` |
| 64 | Material encrypt OK | 14-byte struct | `rfidHi lo cat … width length` → `onMaterialTypeAndMaterialNumberResult` |

### Out-of-switch (handled before the main switch)

| tag | Response to | Payload | Action |
|-----|-------------|---------|--------|
| 0x99 (-103) | QUERY_CONSUMABLES_UID | `len(1) data(N)` | hex string → `consumablesUidListener` |
| 0x20 (32) | ? | 1 byte | no-op |
| 0x31 (49) | RFID_LABEL_INFO | `type(1) hi(1) lo(1)` | `%05d` RFID → `onConsumableNumberResult`; >0 → requests RFID_REMAIN |
| 0x35 (53) | CHARGE_MODE | 1 byte | `==2` → `isCharging=true` → `onCharging` |
| 0x4B (75) | DATE_FORMAT | 2 bytes | `onDateFormatResult` |
| 0x4E (78) | Write-entry ACK | sub-tag (b==27) | `onWriteSuccess / onWriteFailed` |
| 0x5E (94) | POWER_KEY_TYPE | 1 byte | `powerKeyTypeListener.onResult` |
| 0x0E (14) | CUTTER (P1000) | 1 byte | `0xB8`=true · `0xB9`=false |
| 0x0F (15) | Print complete ACK | `0x0C` | `onComplete()` |
| 0x3B (59) | CHIP_TYPE flags | 3 bytes | see bit fields below |
| 0x3C (60) | Print mode ACK | none | — |

### Bit fields in CHIP_TYPE response (tag `0x3B`, 3 bytes d0 / d1 / d2)

**`d0`** — support flags:

| bit | meaning |
|---|---|
| `0x01` | CONCENTRATION — density adjustment |
| `0x02` | VELOCITY — speed adjustment |
| `0x04` | GRAYSCALE |
| `0x08` | COMPRESS — raster compression |
| `0x10` | COMPRESS_MINILZO |
| `0x20` | COMPRESS_HUFFMAN |
| `0x40` | DOUBLE_DPI |
| `0x80` | BLUETOOTH_ENCRYPT |

**`d1`** — feature flags:

| bit | meaning |
|---|---|
| `0x01` | BLUE_MORE (multi-connection) |
| `0x02` | CHARGE_NOT_PRINT — disallow printing while charging |
| `0x04` | RED_BLACK_NEW — new two-color scheme |

**`d2`** — extra:

| bit | meaning |
|---|---|
| `0x10` | SUPPORT_UID — consumable UID support |

---

## 8. Image printing (raster pipeline)

The P780BT does **not** use ESC/POS text/barcode commands — all content
is rasterized by the client and sent as a 1 bpp bitmap.

### `printBitmapx` sequence

```
1. Rotate bitmap by mDegree (0 / 90 / 180 / 270°)
2. byte[] nv = XNvUtil.img2Nv(bitmap, threshold=200, invert=true)
   → [0x30, 0, widthLo, widthHi, <row0…rowN>]
     each row = width/8 bytes, 1 bpp, MSB first
3. INIT_PRINTER        (1B 40)
4. Loop N times:
     a. SET_PRINT_IMAGE (1B 4E 1F) + raster
     b. if not last copy → PRINT_PAUSE (1F 11 3C)
5. PRINT_PAGER         (1B 64 00)   — final feed
```

### Raster command variants

| Command | When used |
|---------|-----------|
| `1B 4E 1F` SET_PRINT_IMAGE | **primary for P780BT** |
| `1D 76 30 00` PRINT_IMAGE | standard ESC/POS (other models) |
| `1D 78 30 00` PRINT_IMAGE_DUAL_COLOR | legacy red / black |
| `1D BC 30 00` PRINT_IMAGE_DUAL_COLOR_2 | new R / B (`supportNewRedBlack=true`) |
| `1B 4E 1E` SET_PRINT_IMAGE_F12 | F12 only |

### Write-entry API (composite templates)

```
WRITE_START (1F 11 54 88)
writeEntry(idx, x, y, bitmap)  → header + {idx, xL, xH, yL, yH} + raster
…several entries…
WRITE_END   (1F 11 54 89)
```

Command choice inside `writeEntry` depends on `idx % 8`:

- `== 2` → SET_PRINT_IMAGE_F12 with `EntryUtil.showBmp2model`
- `== 4` → SET_PRINT_IMAGE with `EntryUtil.printBmp2model`

### Multi-copy print (single-bitmap shortcut)

```
PRINT_MULTI (1F 11 21) + count + PRINT_IMAGE + raster
```

---

## 9. Firmware update (OTA)

Two CRC variants depending on the BT chip family:

- **Jerry / JieLi** (P780BT): **CRC16-XMODEM** — `bluetoothType=true`, detected via BT_VER reply `3 / 7 / 8`
- Others: **CRC32**

Sequence:

```
1. OTA_MODE                (1F 11 0F)   — enter firmware mode
2. FIRMWARE_UPGRADE_START  (1F 11 14) + CRC(4) + LEN(4) + firmware binary
3. Printer replies with tag 10 carrying a CRC for verification
4. FIRMWARE_UPGRADE_CONFIRM (1F 11 15)   or
   FIRMWARE_UPGRADE_CANCEL  (1F 11 16)
```

---

## 10. Public SDK API surface

Inheritance chain: `Printer` → `QuinPrinter` → `P780BTPrinter`.

<details>
<summary><b>Connection</b></summary>

- `connect(String mac, BluetoothConnectStateListener)`
- `disconnect()`
- `sendEmptyOrder()` — keep-alive (sends a 1-pixel raster)

</details>

<details>
<summary><b>Identification</b></summary>

- `getSerial(StringCallBack)` — serial number
- `getModel()`, `getModelName()` (deprecated), `getSerialName()` (deprecated)
- `getCurrentRfid()` — current consumable RFID

</details>

<details>
<summary><b>Printer status</b></summary>

- `getBattery(IntegerCallBack)` — battery level (10 / 5 / 3 / -1 marker codes)
- `getAutoPower(IntegerCallBack)` · `setAutoPower(int minutes)`
- `getCoverStatus()` · `getHighState()` (temperature)
- `hasPaper(BooleanCallBack)` (deprecated) / `addPaperStateListener`
- `getPrintBusyState(BooleanCallBack)`

</details>

<details>
<summary><b>Print parameters</b></summary>

- `setConcentration(int)` — density (1 byte)
- `setMultiConcentration(byte[])` — requires `isSupportMultiConcentration`
- `setTenConcentration(byte[])` — 22 density param bytes
- `setSpeed(int)` — speed (1 byte)
- `setMargin(int)` — left margin
- `setPaperType(int)` — gap / black-mark / continuous
- `setPrintDirection(int)` — 0 / 90 / 180 / 270
- `getBitmapScaleSize()` — `0.8867` for P780BT
- `getMaxPrintWidth()` — `48` (384 px)
- `enabledRBPrint(boolean)` — two-color print

</details>

<details>
<summary><b>Print</b></summary>

- `printBitmap(Bitmap, int amount)` — primary method
- `printBitmap(Bitmap, int, List<Rect>)` — with regions
- `setPrinterImage(Bitmap, int x, int y)` — positioned image
- `resetImageIndex()`

</details>

<details>
<summary><b>Write-entry (templates)</b></summary>

- `writeEntryStart()` · `writeEntry(int idx, int x, int y, Bitmap)` · `writeEntryEnd()`
- `addOnWriterEntriesListener`

</details>

<details>
<summary><b>Consumables / RFID</b></summary>

- `setConsumableRemain(int type, int count)`
- `getConsumableNumberListener` · `getConsumableRemainAmountStatus` · `getConsumableUid`
- `getRibbonConsumableNumberListener` + release variants
- `resetPaper(ResetPaperListener)`

</details>

<details>
<summary><b>Dates and labels</b></summary>

- `sendOpenDateTitle(boolean)` · `inquireIsOpenDateTitle()`
- `setDateFormat(byte[])` · `addDateFormat(...)` · `controlDateSwitch(int, boolean)`

</details>

<details>
<summary><b>Power key / SN</b></summary>

- `getPowerKeyType()` · `setPowerKeyType(int)`
- `modifySn(String)` — change the serial number

</details>

<details>
<summary><b>Firmware</b></summary>

- `update(File firmware, UpdateListener)`
- `cancelUpdate()`

</details>

<details>
<summary><b>Listeners and callbacks</b></summary>

- `setPrintResultListener(PrintResultListener)` (deprecated)
- `addPrintResultListener` / `removePrintResultListener` / `clearPrintResultListener`
- `addPrinterStateListener` / `removePrinterStateListener` / `clearPrinterStateListener`
- `setAnswerSyncListener` — synchronous replies

Callback interfaces:

| Interface | Methods |
|---|---|
| `BooleanCallBack` | `onResult(boolean)` |
| `IntegerCallBack` | `onResult(int)` |
| `StringCallBack` | `onResult(String)` |
| `PrintResultListener` | `onCancel` · `onComplete` · `onError` · `onOverHeat` |
| `PrinterStateChangeListener` | `onCharging` · `onCoverStateChange` · `onGetVersion` · `onLowBattery` · `onOverheaStatetChange` · `onPaperStateChange` · `onConsumableStateChange` · `onConsumableCountChange` |
| `PaperTypeListener` | `getPaperType(int)` |
| `ResetPaperListener` | `resetSuccess` · `resetFaile` |
| `ConsumableNumberListener` | `onConsumableError` · `onConsumableNumberResult(int, String)` |
| `ConsumableRemainAmountStatusListener` | `onCarbonBeltRemainCount` · `onPaperRemainCount` · `onRibbonRemainCount` |
| `ConsumablesUidListener` | `onResult(String)` |
| `RibbonMaterialTypeAndMaterialNumberListener` | `onMaterialError` · `onMaterialTypeAndMaterialNumberResult(type, rfid, baseColor, textColor, coverType, paperType, width, length)` |
| `P1000StateChangeListener` | `coverState` · `cutterState` · `pagerState` (P1000 only) |

</details>

---

## 11. Per-model parameters

The table below is the complete parameter set for every driver
registered in this project. All other columns of the wire protocol
(request prefix, response framing, response tag layouts, multi-copy
loop with `PRINT_PAUSE` / `PRINT_PAGER`, etc.) are identical across
models — see §§4–10.

**Columns:**
- **DPI** — native print-head resolution. Drives the canvas renderer.
- **Tape mm** — maximum printable width along the tape-width axis.
- **End-of-job** — bytes sent after the last raster in a print job
  (closes the page in firmware). Model-specific; the most common
  difference between otherwise-identical models.
- **Scale** — `bitmap_scale_size` applied before rasterization
  (`0.8867` ≈ 180/203 — used when a design authored at 203 DPI is
  printed on a 180-DPI head).
- **Dither** — binarization threshold for the 1-bpp conversion
  (0..255; midpoint 128). `200` biases darker.
- **SN prefix(es)** — the first 4 ASCII characters of the serial
  number that resolve (via `printer/sn-registry.js`) to this
  driver. `— (force)` = this project has the driver but the SN
  registry doesn't auto-select it (either no prefix is uniquely
  known, or the prefix overlaps a sibling); use the
  `?driver=<id>` URL override or set `localStorage.btprinter.driverId`
  to force it.

### P-series

| Driver id | Model | DPI | Tape mm | End-of-job | Scale | Dither | SN prefix(es) |
|---|---|---:|---:|---|---:|---:|---|
| `p780bt`  | P780BT   | 180 | 48 | `1B 64 00` | 0.8867 | 128 ✅ | `Q217` |
| `p24`     | P24      | 180 | 48 | `1B 64 00` | 0.8867 | 128 | `Q373` |
| `p580`    | P580     | 180 | 48 | `1B 64 00` | 0.8867 | 128 | `Q393` |
| `p1000`   | P1000    | 180 | 48 | `1B 64 02` | 0.8867 | 200 | `Q004` `Q030` `Q031` `Q035` `Q079` |
| `amp310`  | AMP310   | 180 | 48 | `1B 64 02` | 0.8867 | 200 | — (force) |
| `p15`     | P15      | 203 | 12 | `1B 64 0C` | 1.0    | 128 | `Q295` |
| `p3100d`  | P3100D   | 180 | 48 | `1B 64 02` | 0.8867 | 200 | `Q051` `Q133` |
| `p3100dj` | P3100DJ  | 180 | 48 | `1B 64 01` | 0.8867 | 200 | — (force) |
| `p3200`   | P3200    | 203 | 48 | `1B 64 0C` | 1.0    | 128 | `Q173` `Q174` |
| `p3200d`  | P3200D   | 203 | 48 | `1B 64 0C` | 1.0    | 128 | — (via P3200) |
| `lt12`    | LT12     | 180 | 48 | `1B 64 02` | 0.8867 | 200 | `Q309` |

### D-series (BT cartridge-based)

| Driver id | Model | DPI | Tape mm | End-of-job | Scale | Dither | SN prefix(es) |
|---|---|---:|---:|---|---:|---:|---|
| `d480bt`    | D480BT     | 180 | 48 | `1B 64 1F` | 0.8867 | 200 | `Q215` |
| `d480btpro` | D480BT PRO | 180 | 48 | `1B 64 1F` | 0.8867 | 200 | — (force) |
| `d680bt`    | D680BT     | 180 | 48 | `1B 64 21` | 0.8867 | 200 | `Q216` |
| `d1600`     | D1600      | 203 | 48 | `1B 40`    | 1.0    | 128 | `Q175` `Q176` |
| `d1600d`    | D1600D     | 203 | 48 | `1B 40`    | 1.0    | 128 | — (via D1600) |

### D-series (portable, narrow tape)

| Driver id | Model | DPI | Tape mm | End-of-job | Scale | Dither | SN prefix(es) |
|---|---|---:|---:|---|---:|---:|---|
| `d30`  | D30  | 203 | 12 | `1B 64 17` | 1.0    | 128 | `Q018` `Q040` `Q046` `Q049` `Q050` `Q069` `Q092` `Q093` `Q107` `Q109` `Q110` `Q138` `Q159` `Q172` `Q189` `Q223` |
| `d30s` | D30S | 203 | 12 | `1B 64 17` | 1.0    | 128 | `Q036` `Q048` `Q097` `Q111` `Q125` `Q149` `Q150` `Q183` |
| `d50`  | D50  | 180 | 12 | `1B 64 11` | 0.8867 | 200 | `Q083` |

### Q-series

| Driver id | Model | DPI | Tape mm | End-of-job | Scale | Dither | SN prefix(es) |
|---|---|---:|---:|---|---:|---:|---|
| `q30` | Q30 | 203 | 12 | `1B 64 17` | 1.0 | 128 | `Q082` `Q130` `Q169` |

### Misc

| Driver id | Model | DPI | Tape mm | End-of-job | Scale | Dither | SN prefix(es) |
|---|---|---:|---:|---|---:|---:|---|
| `a30`    | A30    | 203 | 12 | `1B 64 0B` | 1.0 | 128 | `Q294` |
| `lm1600` | LM1600 | 203 | 48 | `1B 64 02` | 1.0 | 128 | `Q310` |
| `m950`   | M950   | 203 | 48 | `1B 64 07` | 1.0 | 128 | `Q311` |
| `m960`   | M960   | 203 | 48 | `1B 64 0D` | 1.0 | 128 | `Q186` `Q187` |

### Additional P780BT tuning notes

The P780BT driver has two extra per-hardware calibration values —
`printFeedShiftPx = 4` and `printVerticalShiftPx = 2` — field-tuned
by the author against real printed output. They nudge the packed
raster by a few pixels along the feed and tape-width axes to
compensate for small mechanical offsets. All other drivers default
to 0/0; if your model prints slightly off-centre, these are the
first knobs to dial in.

The P780BT implementation also uses `ditherThreshold: 128` (the
mathematical midpoint) rather than the reference `200` — 128 produces
visibly cleaner output on the author's sample set. Other drivers
inherit the reference value.

---

## 12. Observed values from test hardware (P780BT)

Captured on a specific P780BT running firmware `0.1.9`:

| Parameter | Value | Raw response |
|---|---|---|
| Serial Number | `Q217E4810480004` | `1A 08 51 32 31 37 45 34 38 31 30 34 38 30 30 30 34` |
| Firmware version | **0.1.9** | `1A 07 00 01 09` |
| Auto power-off | **30 min** | `1A 09 06` (byte=6 → 6 × 5 = 30 min) |
| Battery | (full — returns 0) | `1A 04 00` |
| Paper | — | `1A 06 89` (`88` = no paper) |
| Cover | closed | `1A 05 98` |
| Temperature | normal | `1A 03 A8` |
| Chip type | `23 / 3` | `1A 17 03` |
| BT MAC | `98:53:BF:8D:1E:67` | — |

---

## 13. Wireshark filters

Handy display filters for `btsnoop_hci.log`:

```wireshark
bluetooth.addr == 98:53:bf:8d:1e:67   # all printer traffic
btspp                                 # application layer only (SPP)
btrfcomm.frame.type == 0xef           # UIH (data frames)
btspp && data.data matches "^1a08"    # responses carrying the SN
btspp && data.data matches "^1f11"    # requests
```

---

## 14. How this document was produced

This spec was reconstructed from two data sources, consulted privately
during reverse-engineering and **not redistributed** as part of this
repository. If you want to reproduce the work, capture your own
material the same way.

### Bluetooth HCI capture

- **Tool:** Android Developer Options → *Enable Bluetooth HCI snoop
  log*, plus `adb bugreport` afterwards to extract it.
- **What it gives you:** a Wireshark-compatible `btsnoop_hci.log`
  containing every HCI / L2CAP / RFCOMM frame exchanged between the
  phone and the printer during a session.
- **Recording methodology:** run one action at a time in the vendor
  PrintMaster app (connect → battery query → paper-state query →
  cartridge read → single-label print), stopping the capture between
  operations, so each request/response pair can be attributed
  unambiguously. A couple of multi-label jobs recorded separately
  reveal the `PRINT_PAUSE` / `PRINT_PAGER` framing.
- **Wireshark display filters** used to slice the capture are listed in
  [§12](#12-wireshark-filters).

### Decompiled vendor SDK (reference only)

The EazeID PrintMaster Android app (package
`com.project.aimotech.printmaster`, v5.18.0.12) was pulled with `adb`,
split APKs merged, and the base APK decompiled with **jadx**. The
resulting Java tree was read to cross-reference observed byte patterns
against symbolic command / response names. Files that mattered the
most:

```
com/project/aimotech/printer/
├── Printer.java              # abstract base API class
├── QuinPrinter.java          # common implementation (parser at ~line 809)
├── P780BTPrinter.java        # P780BT specifics (~65 lines)
├── P780BTPROPrinter.java     # PRO variant
├── InsGet.java               # GET command codes
├── InsSet.java               # SET command codes
├── InsOther.java             # miscellaneous
├── InsProcessor.java         # status bit fields
├── PrinterKit.java           # SDK utility methods
└── PrinterInfo.java          # global flags / state
```

Plus ~80 other `*Printer.java` siblings for other Aimotech models (D30,
P12, P780BT PRO, etc.) that confirmed which parts of the protocol are
model-specific and which are shared.

> **None of the decompiled sources, APK binaries or HCI captures are
> included in this repository.** They belong to their respective rights
> holders; only the factual observations derived from them (byte
> tables, payload layouts, firmware quirks) are documented here. See
> the [Legal & fair-use notice](#legal--fair-use-notice) for the U.S.
> legal basis for the reverse-engineering.

---

## 15. Broader model catalog

Printer classes found in the same SDK. Useful as a
protocol-compatibility reference when porting — models in the same
series generally share command codes.

- **A / AMP / B:** A30, AMP310, B246D
- **D (label):** D10, D20, D30, D30N, D30Pro, D30S, D30SNew, D30SPRO, D31, D32, D35, D50, D480BT, D480BT PRO, D680BT, D1600, D1600D, DM170
- **E (office):** E50, E50PRO, E6000, E8000, E9000, E93
- **F / LM / LT:** F12, LM1600, LM2800, LT12
- **M (mobile):** M100, M102, M105, M108, M108TA, M108z, M109, M110, M110C, M110SA, M110s, M120, M120C, M126, M150, M200, M200C, M208, M209, M219, M220, M220C, M220S, M221, M330, M420, M421, M950, M960, M960D
- **P:** P12, P12Pro, P15, P24, P580, **P780BT**, **P780BT PRO**, P1000, P3100D, P3100DJ, P3200, P3200D
- **Q:** Q30, Q30s, Q31, Q32

---

## Legal & fair-use notice

This document and the accompanying Web Serial client are an **independent
reverse-engineering effort for the purpose of interoperability** with the
EazeID P780BT printer that the author legitimately owns. The work is
performed and published in the United States. No affiliation with,
endorsement by, or sponsorship from EazeID, Aimotech or the PrintMaster
app is claimed or implied.

### What is covered by the MIT license

Original material authored in this repository by
[Oleksandr Luzin](https://luzin.cc) — i.e. the `app.js`, `index.html`,
`styles.css` Web Serial client and the text, tables and structure of
this document.

### What is *not* covered and must not be redistributed from here

- The vendor Android APK (`base.apk`) and its decompiled Java sources.
- Any vendor firmware image.
- Third-party Bluetooth / HCI captures.
- The *EazeID*, *P780BT*, *Aimotech* and *PrintMaster* names and marks —
  used here only **nominatively** (to identify the device this work is
  interoperable with), which is permitted under U.S. trademark law
  (*New Kids on the Block v. News America*, 9th Cir. 1992).

### U.S. legal basis for the reverse-engineering

- **Copyright — interfaces.** Application protocols and function
  interfaces are not themselves copyrightable; reimplementing them for
  compatibility is not infringement (*Google LLC v. Oracle America,
  Inc.*, 593 U.S. \_\_\_ (2021)).
- **Copyright — intermediate copying for interoperability** is fair use
  under 17 U.S.C. § 107 (*Sega Enterprises v. Accolade*, 977 F.2d 1510
  (9th Cir. 1992); *Sony Computer Entertainment v. Connectix*, 203
  F.3d 596 (9th Cir. 2000)).
- **DMCA anti-circumvention exemption.** 17 U.S.C. § 1201(f)
  specifically permits circumvention and reverse-engineering of a
  lawfully obtained computer program for the sole purpose of
  identifying and analysing elements necessary to achieve
  interoperability with an independently created program.
- **No warranty / no implied endorsement.** This project does not
  distribute the vendor software, does not modify the vendor firmware,
  and does not present itself as an official Aimotech product.

### Scope of use

Intended for debugging, integration, hobbyist work and education. *Not*
intended for cloning the vendor client app, repackaging the vendor
firmware, or for any activity that would misrepresent this work as an
official Aimotech product.

### Disclaimers

Firmware revisions can change behaviour at any time; the values
documented here were observed on firmware `0.1.9`. This notice is
general information, **not legal advice** — if you are integrating this
work commercially, consult your own counsel.

&copy; [Oleksandr Luzin](https://luzin.cc) &middot; contributions welcome via
the project repository.
