# Even Realities G2 + R1: BLE protocol notes

Everything here is reverse-engineered by the community. Nothing has been checked against our own
glasses yet: they were paired to the iPhone while this was written. Each section names its sources
and gives a confidence level:

- **High**: two or more independent sources agree, at least one of them runs on real hardware, and
  for byte layouts a real captured packet matches.
- **Medium**: one source that runs on hardware, or several sources that only partly agree.
- **Low**: a single unverified source, an inference, or sources that contradict each other.

## Sources

| Tag | Source | License | Notes |
|---|---|---|---|
| **MOS** | [MentraOS](https://github.com/Mentra-Community/MentraOS) `mobile/modules/bluetooth-sdk/{android/.../sgcs/G2.kt, ios/Source/sgcs/G2.swift, .../controllers/R1.kt}` | Apache-2.0 | A production driver that ships to users. The best single source. |
| **GW** | [men-g2-ble-gateway](https://github.com/gpsnmeajp/men-g2-ble-gateway) `mentraos/g2/*.py` | MIT (the port says it follows the G2.kt license) | A Python port of G2.kt, tested on firmware **v2.2.20**. |
| **ISX** | [i-soxi/even-g2-protocol](https://github.com/i-soxi/even-g2-protocol) `docs/`, `examples/teleprompter/teleprompter.py` | none stated | Early reverse-engineering notes plus hard-coded captured handshake bytes. Its `captures/*.log` btsnoop files are **corrupted**: every byte ≥ 0x80 was stripped, so they contain no 0xAA bytes and cannot be parsed. |
| **GK** | [g2-kit-unofficial](https://github.com/Commute773/g2-kit-unofficial) `ble/*.ts`, `ble/gen/*_pb.ts`, `ble/docs/*.md` | MIT | TypeScript and noble. Its **code** agrees with MOS. Several of its **docs** contradict both its own code and MOS (`envelope.md` and `transport.md` describe a different UUID and header). We trust the code and the protobuf descriptors. |
| **WB** | [aaronrau/workbench](https://github.com/aaronrau/workbench) `lib/**/g2_protocol.dart`, `g2_connection.dart`, `r1_*.dart`, `wearable_controller.dart` | not checked | A Flutter G2 + R1 driver whose ring notes are hardware-verified (2026-07). It separates the advertised UUID from the 5450/6450 GATT services. Read, not copied. |
| **SDK** | `@evenrealities/even_hub_sdk` 0.0.16 `dist/index.d.ts` | vendor | Field names and enums that line up with the protobuf. |
| **NOTES** | [nickustinov/even-g2-notes](https://github.com/nickustinov/even-g2-notes) | n/a | Behaviour of the SDK and simulator. No wire format. |
| **OES** | [OpenEvenSdk](https://github.com/Thepizzapie/OpenEvenSdk) | none found | Cloned but not relied on. Its Swift and Kotlin bridges are a useful cross-check for the iOS app. |

The driver in `driver/` is our own TypeScript code. It was written from these sources, and no code was copied verbatim. See the per-file headers.

---

## 1. Topology: two lenses and a ring (high)

- **Each arm is its own BLE peripheral.** G1 worked the same way. They advertise as
  `Even G2_<variant>_L_<id>` and `Even G2_<variant>_R_<id>` (MOS, GW, ISX, GK).
- Manufacturer data, with the company ID stripped, holds a 14-byte ASCII **serial** in bytes 0..13.
  Both lenses share this serial, which is how L and R are paired up. Bytes 14..19 hold that lens's
  **BLE MAC in little-endian order** (GW `scan.py`; MOS reads it the same way). noble on macOS keeps
  the 2-byte company ID, so strip it first. On macOS and iOS this is the only way to learn the MAC,
  because CoreBluetooth hides addresses.
- The **right** lens is the command lens. It receives every UI/EvenHub message, the time sync and
  heartbeats, and it sends the input events. The **left** lens only needs `AUTH`, plus its own mic
  stream. GK says the left lens never sends async events (medium). MOS still listens on both and
  removes duplicates.
- **The R1 ring connects to the glasses**, and separately to the phone. The glasses forward ring
  gestures as ordinary EvenHub input events tagged `EventSource = RING (2)` (MOS: `eventSource == 2`
  marks "controller connected"; SDK `EventSourceType`). The phone link to the ring is used for
  pairing/binding, battery and health data. For UI input you only need the glasses. See §12.
- **The glasses accept one central at a time.** They only advertise while no phone is connected. GW
  README: power off the phone, or turn its Bluetooth fully off and force-quit the Even App. The
  phone-side pairing does **not** need to be removed.

## 2. GATT (high)

Base UUID `00002760-08c2-11e1-9073-0e8ac72e____`. The same layout appears on each lens.

**`…0000` is only the UUID the lenses advertise. On current firmware it is not the GATT parent of
the characteristics below.** They are spread over three services (workbench `g2_protocol.dart`:
"It is not the parent GATT service for the control/audio characteristics on current firmware"; GK
`ble.ts` names 5450 and 6450). A host that discovers only `…0000` finds nothing and fails before
the handshake, which is what blocked both arms in our iOS app.

| Suffix | Kind | Use | Source |
|---|---|---|---|
| `0000` | advertised UUID | scan filter only; not a GATT service for the channels below | MOS, GW, ISX, WB |
| `5450` | service | control: holds `5401` and `5402` | WB, GK |
| `5401` | write without response | framed command packets (§4) | MOS, GW, ISX, GK |
| `5402` | notify (CCCD 0x0100) | framed replies and events | MOS, GW, ISX, GK |
| `6450` | service | audio/render: holds `6401` and `6402` | WB, GK |
| `6402` | notify | **raw LC3 mic audio**, not framed (§9) | MOS, GW, GK code |
| `6401` | write | "render write" (GK); unused by MOS | low |
| `7450` | service | Even File Service: holds `7401` and `7402` | GK (not the mic) |
| `7401` / `7402` | write / notify | Even File Service (notifications, file push; services 0xC4/0xC5) | MOS |

How to find them (what G2Kit does):

- Discover **all** services (`discoverServices(nil)`, as MOS does), then the characteristics of
  each, and merge them by UUID. WB asks for 5450 and 6450 by name instead.
- Only `5401` and `5402` are required. Treat a missing `6402` (or one service failing to list its
  characteristics) as "no mic", not as a failed connection.
- `retrieveConnectedPeripherals(withServices:)` matches GATT services, so query `5450`/`6450`
  (plus `0000` and Nordic UART `6E400001-…` for lenses indexed differently). Retrieved peripherals
  carry no manufacturer data, so remember each lens's serial/MAC by its CoreBluetooth UUID from an
  earlier advertisement.

ISX labels `6402` "display rendering, 204-byte packets". That label is wrong: those packets are mic
audio. MOS asks for **MTU 247** and high connection priority so that one 200-byte audio notification
is not split up. ATT handles seen by ISX: 0x0842 = 5401, 0x0844 = 5402, 0x0864 = 6402.

## 3. Pairing and authentication (medium)

- **No PIN and no app-level cryptography were observed on the glasses.** The session handshake is a
  set of plain protobuf commands (§6).
- GW: "If the PC and glasses show a pairing request dialog, accept the pairing. Otherwise the
  connection may be dropped after some time." The glasses may therefore ask for OS-level
  bonding/encryption. **Accept it on the Mac.**
- The **ring** is different: GK found a `pairAuth` exchange whose key comes from Even's server
  (`get_pkey`). It cannot be reproduced offline (low). This only matters for binding a new ring. An
  already bound ring keeps working through the glasses.

## 4. Packet framing and CRC (high, verified against a captured packet)

```
 0    1     2       3     4      5       6        7       8 .. 8+n-1        last 2 (last packet only)
 AA  route  sync   len   total  serial  service  flag    protobuf chunk     CRC lo, CRC hi
```

| Byte | Meaning |
|---|---|
| 1 | `(dest<<4)\|src`: phone=1, glasses=2, so `0x21` is phone→glasses and `0x12` is glasses→phone |
| 2 | **sync id**. One value per logical message, **identical on every fragment of it**. The firmware reassembles by this key. If you increment it per fragment, the firmware drops the whole message (GK, the bug it hit first). The host picks a rolling 0..255 counter. |
| 3 | bytes after the header in this packet, **including the 2 CRC bytes on the last packet** |
| 4, 5 | total packets and the 1-based serial |
| 6 | service ID (§5) |
| 7 | host→glasses: `0x20` for every service except `0x80` device-settings, which uses `0x00` (MOS `reserveFlag`). ISX read bytes 6-7 as a 16-bit "service" such as `0x06-20` or `0x80-00`; they are really service + flag. glasses→host: `(flag>>1)&0x0F` is a **result code**, and non-zero means failure (MOS drops the message). |

- **CRC-16/CCITT-FALSE** (poly 0x1021, init 0xFFFF, no reflection, no xorout; check("123456789") =
  0x29B1). It covers the **concatenated protobuf payload of all fragments only**, not the header,
  and is appended **little-endian** to the last fragment. MOS's byte-wise formula and the bit-wise
  formula in ISX/GK are the same CRC (tested). **Verified:** the Even App packet captured in GK
  (`aa21921301010120 0802109c01220a1a0812061204080010 00 a142`) has CRC 0x42A1 = crc(payload), and our
  framer reproduces it byte for byte (`test/crc.test.ts`).
- **Fragmentation:** MOS sends at most 236 protobuf bytes per packet. If the last chunk is exactly
  236 bytes, the CRC goes into one extra packet with no data (8+236+2 would exceed the 244-byte write
  limit at MTU 247). GK splits differently: it counts the CRC inside 232-byte chunks. Both rely on
  `len` and `total`, so both should work.
- **Do not interleave** the packets of two multi-packet messages on one lens. The firmware has a
  single reassembly buffer, and interleaving can wedge the plugin task (GK gotchas, medium). The
  driver serialises writes per lens.
- Pacing: GW waits 8 ms between packets; MOS iOS waits 6 ms and deliberately does **not** wait on
  `canSendWriteWithoutResponse`, because iOS never calls it back for a backgrounded central.
  G2Kit keeps the 6 ms gap for everything but image packets, which wait for the write buffer
  (bounded, falling back to the gap) and keep two 4 KB fragments in flight. Neither is from a
  source: it is our own choice, measured with the `img:` log lines, and it steps down to the MOS
  behaviour after a failed image.
- Replies on `5402` use the same framing. MOS reassembles by `(lens, service, sync)` so that L and R
  replies sharing a sync id do not merge.

## 5. Protobuf conventions and service IDs (high)

Every payload is protobuf (proto3). EvenHub, settings and similar services wrap their messages as
`{1: Cmd, 2: MagicRandom, <N>: sub-message}`. `MagicRandom` is a request id the glasses echo back.
**Keep it below 256**: GK says some paths compare only the low byte, and MOS/GW use an 8-bit counter.
proto3 leaves out zero values, so a missing `eventType` means `CLICK (0)`.

Service IDs (MOS `ServiceID`, from Even's `service_id_def.proto`):

| ID | Name | Used for |
|---|---|---|
| 0x01 | dashboard | dashboard widgets; GK's "session prelude" `{1:2, 4:{3:{2:{2:{}}}}}` goes here |
| 0x03 | menu | register the app in the glasses menu; selection arrives as EvenHub cmd 17 |
| 0x04 | notification | notification centre (ISX: "display wake") |
| 0x06 | teleprompter | ISX's teleprompter example (§13) |
| 0x07 | even_ai | e.g. disable "Hey Even": `{1:10, 2:m, 13:{1:0, 2:80}}` |
| 0x08 | navigation | compass/heading (MOS) |
| 0x09 | g2_setting | battery/firmware query, brightness, head-up, display position (§11) |
| 0x0D | gesture_ctrl | dashboard open/close signal (`08011A00`) |
| 0x10 | onboarding | `skip_onboarding {1:1, 2:m, 3:{1:4}}` |
| 0x80 | device settings (dev_config) | auth, pipe role, time sync, heartbeat, ring binding. **Dangerous:** GK soft-bricked a pair (until a power cycle) by writing an unknown field here. |
| 0x81 | EvenHub ctrl | init/registration (MOS, unused) |
| 0xC4 / 0xC5 | file cmd / data | Even File Service |
| **0xE0** | **EvenHub** | the page/container UI, mic, IMU, heartbeat, input events |

## 6. Session start-up (medium-high)

MOS/GW sequence, with about 200 ms between steps, used on fw 2.2.20:

1. Connect L, then R. Subscribe to `5402` and `6402` on both.
2. `0x80 AUTH {1:4, 2:m, 3:{1:1, 2:4}}` to **L**, then to **R**. The reply `{1:4, 3:{1:1}}` means
   authenticated. The ISX capture of the Even App has the identical bytes (`0804100c1a0408011004`).
   On our iPhone (2026-10-18) each lens answered twice: ~60 ms after AUTH with a reply that carried
   no varint `secAuth` (an older parser read it as "rejected"), then with `secAuth = 1`. MOS logs the
   first as `secAuth=?` and reconnects only on an explicit false, so G2Kit waits for the verdict and
   logs the verdict-less reply's bytes. `secAuth` is `bytes` in GK's descriptors; G2Kit reads both.
3. `0x80 PIPE_ROLE_CHANGE {1:5, 2:m, 4:{1:role}}` to R. MOS uses role 1; the ISX capture shows 2
   (low: which one is "right" is unclear).
4. `0x80 TIME_SYNC {1:128, 2:m, 128:{1:secs, 2:tz}}` to R. MOS sends local wall-clock seconds and
   tz=0, because the dashboard clock does not apply a UTC offset.
5. Optional (GW sends them, the driver does not yet): skip onboarding (0x10), disable Hey Even
   (0x07), universe settings (0x09), calendar and dashboard defaults, register a launch-menu item
   (0x03).
6. EvenHub `CreateStartUpPage` (§7). The EvenHub plugin task only exists after this.
7. **Heartbeats every 5 s:** EvenHub `{1:12, 2:m, 14:{}}` (ack `080C7A02100C`) and dev-settings
   `{1:14, 2:m, 13:{}}`. Without them the glasses tear down the page **and the mic** after about
   10 s (GK). GW also requests device info every 10th beat.

ISX's 7-packet handshake (capability query, pipe role, two time syncs with a "transaction id" of
-24) looks like the same commands sent by the Even App with different values.

## 7. Display: EvenHub pages and containers (high for text and images, medium for lists)

- The canvas is 576×288 with 16 grey levels. On the green micro-LED, pixel 0 is "off".
- A **page** holds up to 12 containers: at most 8 text+list and at most 4 image. Ids must be unique,
  and names unique and ≤16 chars (GK: names of 15+ chars rejected; use ≤14). **Exactly one** text or
  list container needs `isEventCapture=1`. Text containers hold ≤1000 UTF-8 bytes, and empty
  strings are rejected (send a space). The firmware drops invalid pages silently.
- Main message `evenhub_main_msg_ctx` (cmd, then the sub-message field):

| Cmd | Name | Sub field | Body |
|---|---|---|---|
| 0 | create startup page | 3 | `{1 total, 2* ListContainerProperty, 3* TextContainerProperty, 4* ImageContainerProperty}` |
| 7 | rebuild page | 7 | same body. The first page must be a CREATE; GK says later CREATEs are not ACKed, so use REBUILD. |
| 5 | text upgrade | 9 | `{1 id, 2 name?, 3 offset, 4 length(bytes), 5 content}` (MOS always uses offset 0 and the full length) |
| 3 | image raw data | 5 | `{1 id, 2 name, 3 sessionId, 4 totalSize, 5 compressMode=0, 6 fragIndex, 7 fragSize, 8 bytes}` |
| 9 | shutdown page | 11 | `{1 exitMode}` (SDK: 1 shows the exit dialog) |
| 12 | heartbeat | 14 | `{}` |
| 15 | audio control | 18 | `{1 enable}` |
| 19 | IMU control | 20 (MOS, live) / 22 (GK descriptor) | `{1 enable, 2 pace 100..1000}` |

- Text container fields: 1 x, 2 y, 3 w, 4 h, 5 borderWidth, 6 borderColor, 7 borderRadius,
  8 padding, 9 id, 10 name, 11 isEventCapture, 12 content. **List container:** 1-10 the same, 11
  `{1 itemCount, 2 itemWidth, 3 selectBorder, 4* itemName}`, 12 isEventCapture. The list layout
  comes only from GK's descriptor; MOS has no list code (medium). Image container fields: 1 x, 2 y,
  3 w, 4 h, 5 id, 6 name, with 20..288 × 20..144 px. Larger images are tiled over several containers.
- **Images:** an uncompressed **4-bit grey BMP** (BITMAPINFOHEADER, 16-entry palette, bottom-up,
  high nibble = left pixel, rows padded to 4 bytes). It is sent in **4096-byte fragments** that share
  **one session id** and use an incrementing index. The glasses ACK each fragment with cmd 4, field 6
  `{3 session, 6 index, 8 errorCode}`, where 4 = success and 5 = failed. MOS sends one fragment, waits
  up to 2 s for its ACK, and on failure retries the whole image (up to 3 times) under a new session
  id. GK gotchas: the **first image after a CREATE may be silently dropped** (send a throwaway frame
  first); some ACKs never arrive even though the fragment landed; after an aborted transfer, bump the
  session id by 2. The SDK 0.0.12+ has a compressed path (`compressMode`); its format is unknown.
  What is known about it (2026-10): SDK 0.0.16's `ImageRawDataUpdate.toJson` sets `compressMode: 2`, its
  README says "Image raw data is compressed with LZ4 internally", and hub.evenrealities.com/docs/build/display
  says "Raw data is LZ4-compressed in transit automatically (SDK 0.0.12+)" with a full-screen refresh of
  ~800 ms. So **CompressMode 2 = LZ4**, done by the Even App before BLE. Not documented: block or frame
  format, whole image or per fragment, and whether MapTotalSize is the compressed size. GK's
  `ble/image.ts` sends uncompressed 4-bit BMPs, found 6144/8192-byte fragments rejected (async error 7)
  and pipelines fragments (window 4). Nobody documents RLE or 1-bit BMPs on the G2 (the G1 took 1-bit
  576x136 BMPs over a different command). G2Kit's opt-in experiments (ImageFormats.swift, Settings →
  Image format, LENS TEST page 4) try LZ4 block (whole image / per fragment), BI_RLE4, BI_RLE8 and 1-bit.
- Result codes (`EvenHub_ErrorCode_List`): 0 create ok, 1 invalid container, 2 oversize, 3 out of
  memory, 4/5 image ok/fail, 6/7 rebuild ok/fail, 8/9 text ok/fail (MOS treats 9 as "our page is
  gone"), 10/11 shutdown ok/fail, 12 heartbeat ok, 13/14 audio ok/fail. The responses arrive in
  fields 4 (startup), 6 (image), 8 (rebuild), 10 (text) and 12 (shutdown). Response cmd 9 or 10
  means the glasses closed our page.

## 8. Input events (high)

The glasses send EvenHub cmd 2 (`OS_NOTIFY_EVENT_TO_APP`). Field 13 is `SendDeviceEvent`:
`{1 List_ItemEvent, 2 Text_ItemEvent, 3 Sys_ItemEvent}`.

- `Sys_ItemEvent {1 eventType, 2 eventSource, 3 IMU_Report_Data, 4 systemExitReasonCode}`
- `Text_ItemEvent {1 containerId, 2 name, 3 eventType}`
- `List_ItemEvent {1 containerId, 2 name, 3 selectedItemName, 4 selectedIndex, 5 eventType}`
- `eventType`: 0 click, 1 scroll-top (swipe up), 2 scroll-bottom (swipe down), 3 double click,
  4/5 foreground enter/exit, 6 abnormal exit, 7 system exit, 8 IMU report, 9 long press, 10 long
  press release. Types 9 and 10 are only in SDK 0.0.16 (medium).
- `eventSource` (SDK `EventSourceType`): 0 none, **1 right temple, 2 ring, 3 left temple**.
- Quirks: proto3 drops `eventType 0`, so an empty event is a click. Which sub-event arrives depends
  on which container captures input (NOTES). MOS removes duplicate clicks within 250 ms, because both
  lenses can report them. System exit and abnormal exit mean the firmware closed our page and our mic.
  The double tap on the root page is expected to exit (SDK store rule). Cmd 17 field 20 `{1 appId}`
  is a selection in the glasses menu.

## 9. Microphone (high)

- Enable it with EvenHub cmd 15 `{1:1}`. **It only works while one of our pages is up, and it dies
  with the page.** MOS rebuilds the page before enabling the mic. The ack is cmd 16, field 19.
- Audio arrives on **`6402` notify, unframed.** Each notification carries **5 × 40-byte LC3 frames**:
  10 ms each, 16 kHz mono, 32 kbps, so 50 ms of speech per notification. The parameters come from
  MOS and the GK decoder, which cites the Even App's `flutter_ezw_lc3` decoder. Some captures show
  5 extra trailer bytes (205 total), the last apparently a packet counter. MOS uses only the first
  200 bytes and drops a notification identical to the previous one (both lenses may stream).
- The SDK hands the WebView **decoded s16le PCM at 16 kHz**, so the Even App decodes LC3 on the
  phone. To get PCM natively you need an LC3 decoder: Google's reference
  [liblc3](https://github.com/google/liblc3) (Apache-2.0) as WASM or native (GW builds a dylib and
  MOS ships a wasm), or Apple's built-in LC3 support on iOS 18+ (unverified).
- GK `docs/audio.md` (a separate "6450" service, 2-byte header + 203-byte frame, 20 ms) contradicts
  GK's own decoder code and MOS. We treat that doc as wrong.

## 10. IMU (medium)

Cmd 19 `{1 enable, 2 pace}` turns on reporting, and it needs a live page. Reports arrive as
`Sys_ItemEvent {1: 8, 3: {1 x, 2 y, 3 z}}`. MOS found the values encoded as **32-bit floats (wire
type 5)**, gravity-normalised (|v| ≈ 1 g), even though the descriptor says `double`. MOS puts the
sub-message in field 20; GK's descriptor says 22. The driver uses 20.

## 11. Battery, firmware and settings (medium-high)

- Request: service 0x09 `{1:2, 2:m, 4:{1:1}}`. The reply is cmd 2 or 3, with field 4 holding
  `{5 leftFw, 6 rightFw, 12 battery%, 13 charging}`; field 5 holds `{2 silentMode}`.
- Brightness: `{1:1, 2:m, 3:{1:{1 auto, 2 level}}}`. Head-up angle: `3:{4:{2 angle}}`. Display
  height and depth: `3:{2:{1 lvl}}` and `3:{3:{1 lvl}}`. The value ranges are unknown.
- G1 had a separate battery-only characteristic; on the G2 everything goes through 0x09.

## 12. R1 ring (low-medium)

- Its own peripheral `EVEN R1_<6 hex>`, with service `bae80001-4f05-4503-8e65-3af1f7329d1f` and
  characteristics `…0010/…0011` (write/notify 1) and `…0012/…0013` (write/notify 2), plus standard
  Battery 0x180F/0x2A19 (MOS). MOS reads the ring MAC from the last 6 bytes of its manufacturer
  data; Android and iOS give them in opposite byte orders. Our ring (`EVEN R1_C7D8E9`, 2026-10-18)
  sent no manufacturer data, then ASCII `080032`, which is not its MAC. G2Kit therefore keeps a
  MAC from an advert only when its bytes end in the name's 3-byte suffix (`RingNameCheck.verified`),
  and a MAC from the glasses' RingInfo only when it does not contradict that suffix.
- Both lenses answer `RING_CONNECT_INFO` (sent to R only) with a cmd-6 reply that sets none of the
  RingInfo fields (seen 2026-10-18). That is an ack, not ring state.
- Gestures when connected directly (MOS): notification `[0xFF, type, param]`: type 3 = hold, 4/1 =
  tap, 4/2 = double tap, 5/param<0x80 = swipe up, otherwise swipe down. A 2-byte notification is
  battery %. A 1-byte notification is a state (1 ready, 0 menu).
- **Binding the ring to the glasses** has two incompatible descriptions:
  - MOS: write `0xFC`, then `0x11` to both write characteristics, then **advStart**
    `[00 00 09 <left-lens MAC>]` on `…0012`. After that, send the glasses
    `0x80 RING_CONNECT_INFO {1:6, 2:m, 5:{1 connect, 2 mac[6], 3 name}}`. MOS's own TODO says the
    ring command may need an outer wrapper.
  - GK: ring frames have a 15-byte header (`00 <4-byte random anti-replay hash> 64 <grp> 64 <seq>
    <flags16> 00 <cmd> <sub> 00`); "link to glasses" is cmd 0x0A, sub 0x12, payload
    `<2-byte nonce><right-lens MAC reversed>`. A new ring also needs `pairAuth` with a server-issued
    key.
  - **Practical answer:** keep the binding the Even App already made. Ring gestures then reach our
  driver through the glasses (`source = "ring"`), and the ring itself never needs to be touched.
- Health data (heart rate, SpO2, HRV, sleep) lives on the ring's phone link (GK `ring.ts`, low).

## 13. Other features (low, not implemented)

- Teleprompter (0x06, ISX): init type 1, content pages type 3 (10 lines, about 25 chars per line),
  a required type-255 marker, and a completion message type 4. It needs about 10+ pages to render.
  Display config (0x0E) is sent first.
- Notifications through the Even File Service (0xC4/0xC5, MOS), Even AI (0x07), navigation and
  compass (0x08), calendar (0x04 in GW and the dashboard). GK has descriptors for menu, quicklist,
  notification, transcribe and settings.

## 14. Open questions to answer on hardware

1. Does macOS prompt for bonding, and does the link stay up without it?
2. Is the pipe role 1 or 2 for the right lens on our firmware? Try 1 (MOS) first.
3. Does the first image after a CREATE really get dropped? Do list containers render with the
   descriptor's field layout?
4. LC3 trailer bytes: is it 200 or 205 bytes per notification on our firmware?
5. With no phone connected, does the ring still relay through the glasses with `source=2`?
6. IMU field number: 20 or 22?
7. Is a dashboard prelude (0x01) needed before EvenHub accepts pages (GK), or is the AUTH sequence
   enough (MOS/GW)?
