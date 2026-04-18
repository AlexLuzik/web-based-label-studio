# P780BT — Protocol & Feature Reference

> Complete technical documentation for the **EazeID P780BT** Bluetooth
> thermal label printer — a hardware device by EazeID that speaks the
> Aimotech-family printer protocol.

**Author:** [Oleksandr Luzin](https://luzin.cc) &middot; **Status:** living document

**License of this document** (original prose, tables and structure):
[MIT](https://opensource.org/license/mit/). The *protocol itself* is a
factual interface and is not copyrightable (see *Google v. Oracle*,
593 U.S. \_\_\_ (2021)) — documenting it here does not grant or claim
any rights over it. The vendor SDK sources, APK, firmware and
trademarks (*EazeID*, *P780BT*, *Aimotech*, *PrintMaster*) belong to
their respective owners; see the
[Legal & fair-use notice](#legal--fair-use-notice) at the bottom for
the U.S. legal basis (DMCA § 1201(f) interoperability exemption, fair
use under 17 U.S.C. § 107, nominative trademark fair use).

### Name disambiguation

| Name | What it refers to |
|---|---|
| **EazeID** | Hardware brand — the label printer you buy in the box |
| **P780BT** | The specific hardware model under that brand |
| **Aimotech** | Firmware / SDK vendor (`com.project.aimotech.*` Java packages) — provides the protocol used by P780BT and many sibling devices |
| **PrintMaster** | The Android companion app that ships with EazeID / other Aimotech-family printers; the name used on Google Play |

Reverse-engineered from the Android app PrintMaster v5.18.0.12 (package
`com.project.aimotech.printmaster`, decompiled with jadx) and
cross-checked against a real **btsnoop** HCI capture plus live traffic
from an independent Web Serial client. Everything in this file is a
description of observable facts (bytes on the wire, values returned) —
no vendor source code has been copied into this document.

Legend used throughout this file:

| Marker | Meaning |
|:------:|---------|
| ✅ | Verified working on P780BT firmware `0.1.9` (tested on hardware) |
| ⚠️ | Present in the vendor SDK but unverified on P780BT — may or may not answer |
| ❌ | Confirmed **silent** on P780BT firmware `0.1.9` — command accepted, no response |

---

## Table of contents

1. [Hardware characteristics](#1-hardware-characteristics)
2. [Bluetooth connection setup](#2-bluetooth-connection-setup)
3. [Application protocol format](#3-application-protocol-format)
4. [GET commands (read)](#4-get-commands-read)
5. [SET commands (write)](#5-set-commands-write)
6. [Response tags](#6-response-tags)
7. [Image printing (raster pipeline)](#7-image-printing-raster-pipeline)
8. [Firmware update (OTA)](#8-firmware-update-ota)
9. [Public SDK API surface](#9-public-sdk-api-surface)
10. [P780BT specifics vs QuinPrinter base](#10-p780bt-specifics-vs-quinprinter-base)
11. [Observed values from test hardware](#11-observed-values-from-test-hardware)
12. [Wireshark filters](#12-wireshark-filters)
13. [Reference files](#13-reference-files)
14. [Aimotech model catalog](#14-aimotech-model-catalog)

---

## 1. Hardware characteristics

| Property | Value |
|---|---|
| Model | P780BT |
| Hardware brand | EazeID |
| Firmware / SDK vendor | Aimotech |
| Companion Android app | PrintMaster |
| BT chip | JieLi AC69xx (AC6951 / AC6961 — "Jerry" family) |
| BT profile | Classic BT + BLE dual-mode |
| Default BT name | `P780BT` |
| BT SDP service | **JL_SPP** (JieLi Serial Port Profile) |
| Data transport | SPP / RFCOMM, Channel 1 (DLCI `0x02`) |
| SPP UUID | standard `00001101-0000-1000-8000-00805F9B34FB` |
| Print type | thermal, 1 bpp raster |
| Max print width | 48 bytes = 384 dots |
| Effective DPI | **180** (per `PrinterTypeChecker.java`) |
| Bitmap scale factor | `0.8866995` (= 180 / 203) |
| Binarization threshold | 200 |
| RFID | supported (consumables tracking) |

---

## 2. Bluetooth connection setup

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

## 3. Application protocol format

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

## 4. GET commands (read)

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

## 5. SET commands (write)

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

## 6. Response tags

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

## 7. Image printing (raster pipeline)

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

## 8. Firmware update (OTA)

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

## 9. Public SDK API surface

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

## 10. P780BT specifics vs QuinPrinter base

| Aspect | Base `QuinPrinter` | `P780BTPrinter` |
|---|---|---|
| `getBitmapScaleSize()` | `1.0` | **`0.8867`** |
| `getThreshold()` | `128` (default) | **`200`** |
| Pad raster to 48-byte width | yes | **no** |
| Raster command | `PRINT_IMAGE` (`1D 76 30 00`) | **`SET_PRINT_IMAGE` (`1B 4E 1F`)** |
| Multi-copy print | single command with count | **loop**: INIT → (SET_IMG + PAUSE) × N → PRINT_PAGER |
| Copy separator | — | **`PRINT_PAUSE` (`1F 11 3C`)** |
| Job finalization | — | **`PRINT_PAGER` (`1B 64 00`)** |
| `LABEL_MIN_LENGTH` | — | **25 mm** |
| Icon resource | — | `R.mipmap.printer_icon_p780bt` |

---

## 11. Observed values from test hardware

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

## 12. Wireshark filters

Handy display filters for `btsnoop_hci.log`:

```wireshark
bluetooth.addr == 98:53:bf:8d:1e:67   # all printer traffic
btspp                                 # application layer only (SPP)
btrfcomm.frame.type == 0xef           # UIH (data frames)
btspp && data.data matches "^1a08"    # responses carrying the SN
btspp && data.data matches "^1f11"    # requests
```

---

## 13. Reference files

Decompiled SDK sources live under `printmaster_src/sources/com/project/aimotech/printer/`:

```
├── Printer.java              # abstract base API class
├── QuinPrinter.java          # common implementation (~1500 lines, parser starts at line 809)
├── P780BTPrinter.java        # P780BT specifics (~65 lines)
├── P780BTPROPrinter.java     # PRO variant
├── InsGet.java               # GET command codes
├── InsSet.java               # SET command codes
├── InsOther.java             # miscellaneous
├── InsProcessor.java         # status bit fields
├── PrinterKit.java           # SDK utility methods
├── PrinterInfo.java          # global flags / state
└── ~80 other *Printer.java   # additional Aimotech models
```

Project artifacts (in the repository root):

- `bugreport.zip` — Android bugreport (contains btsnoop)
- `btsnoop_hci.log` — Wireshark-compatible capture
- `EXPORT.txt`, `EXPORT2.txt` — pre-dissected packet dumps
- `printmaster_apk/base.apk` — decompilable APK (~122 MB)
- `printmaster_src/` — decompiled Java (~30 k files)
- `printer_info.txt` — quick summary
- `btsnoop_path.txt` — useful search paths

---

## 14. Aimotech model catalog

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
