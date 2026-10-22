/**
 * EvenHub (service 0xE0) messages: the page/container UI, text and image updates, mic and IMU
 * control, heartbeat, and the events the glasses send back.
 *
 * Field numbers: EvenHub.proto as recovered by MentraOS (G2.kt, Apache-2.0) and the
 * protoc-es descriptor in g2-kit-unofficial (MIT). Field ORDER follows G2.kt so the bytes match
 * what MentraOS sends on real hardware. Independent reimplementation.
 */
import { DISPLAY, EventSource, HubCmd, HubField, OsEvent } from "../constants.ts";
import { PbMessage, PbWriter, utf8 } from "../protobuf.ts";

// ---------------------------------------------------------------- containers

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  borderWidth?: number;
  /** 0..15 grey level (green on the lens). */
  borderColor?: number;
  borderRadius?: number;
  paddingLength?: number;
}

export interface TextContainer extends Box {
  id: number;
  name?: string;
  /** Exactly one container per page must capture input (text or list). */
  captureEvents?: boolean;
  content?: string;
}

export interface ListContainer extends Box {
  id: number;
  name?: string;
  captureEvents?: boolean;
  items: string[];
  itemWidth?: number;
  /** Draw a border around the selected item (default true). */
  selectBorder?: boolean;
}

export interface ImageContainer {
  id: number;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSpec {
  text?: TextContainer[];
  list?: ListContainer[];
  image?: ImageContainer[];
}

const boxFields = (w: PbWriter, b: Box) =>
  w
    .int(1, b.x)
    .int(2, b.y)
    .int(3, b.width)
    .int(4, b.height)
    .int(5, b.borderWidth ?? 0)
    .int(6, b.borderColor ?? 0)
    .int(7, b.borderRadius ?? 0)
    .int(8, b.paddingLength ?? 0);

export function textContainerProperty(c: TextContainer): Uint8Array {
  const w = boxFields(new PbWriter(), c).int(9, c.id);
  if (c.name !== undefined) w.string(10, c.name);
  w.int(11, c.captureEvents ? 1 : 0);
  if (c.content !== undefined) w.string(12, c.content);
  return w.finish();
}

/** ListContainerProperty. Wire layout from the EvenHub.proto descriptor; NOT yet exercised by MentraOS. */
export function listContainerProperty(c: ListContainer): Uint8Array {
  const item = new PbWriter().int(1, c.items.length).int(2, c.itemWidth ?? 0).int(3, c.selectBorder === false ? 0 : 1);
  for (const name of c.items) item.string(4, name);
  const w = boxFields(new PbWriter(), c).int(9, c.id);
  if (c.name !== undefined) w.string(10, c.name);
  w.message(11, item);
  w.int(12, c.captureEvents ? 1 : 0);
  return w.finish();
}

export function imageContainerProperty(c: ImageContainer): Uint8Array {
  const w = new PbWriter().int(1, c.x).int(2, c.y).int(3, c.width).int(4, c.height).int(5, c.id);
  if (c.name !== undefined) w.string(6, c.name);
  return w.finish();
}

export class PageError extends Error {}

/** Same rules the Even Hub SDK and MentraOS enforce; the firmware silently drops invalid pages. */
export function validatePage(p: PageSpec): void {
  const text = p.text ?? [];
  const list = p.list ?? [];
  const image = p.image ?? [];
  const total = text.length + list.length + image.length;
  if (total === 0) throw new PageError("page needs at least one container");
  if (total > DISPLAY.maxContainers) throw new PageError(`max ${DISPLAY.maxContainers} containers per page`);
  if (text.length + list.length > DISPLAY.maxTextOrListContainers)
    throw new PageError(`max ${DISPLAY.maxTextOrListContainers} text+list containers`);
  if (image.length > DISPLAY.maxImageContainers) throw new PageError(`max ${DISPLAY.maxImageContainers} image containers`);
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const c of [...text, ...list, ...image]) {
    if (ids.has(c.id)) throw new PageError(`duplicate container id ${c.id}`);
    ids.add(c.id);
    if (c.name !== undefined) {
      if (c.name.length > DISPLAY.containerNameMax) throw new PageError(`container name too long: ${c.name}`);
      if (names.has(c.name)) throw new PageError(`duplicate container name ${c.name}`);
      names.add(c.name);
    }
    if (c.x < 0 || c.y < 0 || c.x + c.width > DISPLAY.width || c.y + c.height > DISPLAY.height)
      throw new PageError(`container ${c.id} is outside the 576x288 canvas`);
  }
  for (const c of text) {
    if (c.content === "") throw new PageError("empty text is rejected by the firmware; use a single space");
    if (c.content !== undefined && utf8.byteLength(c.content) > DISPLAY.textMaxBytes)
      throw new PageError(`text container ${c.id} content exceeds ${DISPLAY.textMaxBytes} UTF-8 bytes`);
  }
  for (const c of image) {
    if (c.width < DISPLAY.imageMinW || c.width > DISPLAY.imageMaxW || c.height < DISPLAY.imageMinH || c.height > DISPLAY.imageMaxH)
      throw new PageError(`image container ${c.id} must be 20..288 x 20..144`);
  }
  const captures = text.filter((c) => c.captureEvents).length + list.filter((c) => c.captureEvents).length;
  if (captures !== 1) throw new PageError("exactly one text or list container must have captureEvents");
}

/** CreateStartUpPageContainer / RebuildPageContainer body (same layout). */
export function pageContainer(p: PageSpec): Uint8Array {
  validatePage(p);
  const text = p.text ?? [];
  const list = p.list ?? [];
  const image = p.image ?? [];
  const w = new PbWriter().int(1, text.length + list.length + image.length);
  for (const c of list) w.message(2, listContainerProperty(c));
  // MentraOS (G2.kt) declares text before images; the gateway port declares images first so text
  // draws on top. We follow G2.kt ordering of fields 3 then 4.
  for (const c of text) w.message(3, textContainerProperty(c));
  for (const c of image) w.message(4, imageContainerProperty(c));
  return w.finish();
}

// ---------------------------------------------------------------- top-level wrapper

export function hubMessage(cmd: number, subField: number, sub: Uint8Array, magic = 0, appId?: number): Uint8Array {
  const w = new PbWriter().int(HubField.cmd, cmd).int(HubField.magicRandom, magic).message(subField, sub);
  if (appId !== undefined) w.int(5, appId);
  return w.finish();
}

export const createPage = (p: PageSpec, magic = 0) =>
  hubMessage(HubCmd.createStartupPage, HubField.createMessage, pageContainer(p), magic);

export const rebuildPage = (p: PageSpec, magic = 0) =>
  hubMessage(HubCmd.rebuildPage, HubField.rebuildContainer, pageContainer(p), magic);

/** TextContainerUpgrade: replace `contentLength` bytes at `contentOffset` (MentraOS always sends offset 0, full length). */
export function updateText(containerId: number, content: string, opts: { offset?: number; length?: number; magic?: number } = {}) {
  if (content === "") throw new PageError("empty text is rejected by the firmware; use a single space");
  const bytes = utf8.byteLength(content);
  if (bytes > DISPLAY.textMaxBytes) throw new PageError(`text exceeds ${DISPLAY.textMaxBytes} UTF-8 bytes`);
  const sub = new PbWriter()
    .int(1, containerId)
    .int(3, opts.offset ?? 0)
    .int(4, opts.length ?? bytes)
    .string(5, content)
    .finish();
  return hubMessage(HubCmd.updateTextData, HubField.textUpgrade, sub, opts.magic ?? 0);
}

export interface ImageFragment {
  containerId: number;
  containerName?: string;
  sessionId: number;
  totalSize: number;
  index: number;
  data: Uint8Array;
}

export function imageFragment(f: ImageFragment): Uint8Array {
  const w = new PbWriter().int(1, f.containerId);
  if (f.containerName !== undefined) w.string(2, f.containerName);
  w.int(3, f.sessionId).int(4, f.totalSize).int(5, 0).int(6, f.index).int(7, f.data.length).bytes(8, f.data);
  return hubMessage(HubCmd.updateImageRawData, HubField.imageRawData, w.finish());
}

/** Split a BMP into ImageRawDataUpdate messages (4096-byte fragments, one session id for the whole image). */
export function imageMessages(containerId: number, bmp: Uint8Array, sessionId: number, containerName?: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0, i = 0; off < bmp.length; off += DISPLAY.imageFragmentBytes, i++) {
    out.push(
      imageFragment({
        containerId,
        containerName,
        sessionId,
        totalSize: bmp.length,
        index: i,
        data: bmp.subarray(off, Math.min(off + DISPLAY.imageFragmentBytes, bmp.length)),
      }),
    );
  }
  return out;
}

export const shutdownPage = (exitMode = 0) =>
  hubMessage(HubCmd.shutdownPage, HubField.shutdown, new PbWriter().int(1, exitMode).finish());

export const heartbeat = (magic = 0) => hubMessage(HubCmd.heartbeat, HubField.heartbeat, new Uint8Array(0), magic);

export const audioControl = (enable: boolean, magic = 0) =>
  hubMessage(HubCmd.audioControl, HubField.audioControl, new PbWriter().int(1, enable ? 1 : 0).finish(), magic);

/** reportFrq is a pacing code 100..1000 (step 100), not Hz. */
export const imuControl = (enable: boolean, reportFrq = 100, magic = 0) =>
  hubMessage(HubCmd.imuControl, HubField.imuControl, new PbWriter().int(1, enable ? 1 : 0).int(2, reportFrq).finish(), magic);

// ---------------------------------------------------------------- glasses -> host

export type Gesture =
  | "tap"
  | "double_tap"
  | "scroll_up"
  | "scroll_down"
  | "long_press"
  | "long_press_release"
  | "foreground_enter"
  | "foreground_exit"
  | "abnormal_exit"
  | "system_exit";

export type InputSource = "glasses_right" | "glasses_left" | "ring" | "unknown";

const GESTURE: Record<number, Gesture> = {
  [OsEvent.click]: "tap",
  [OsEvent.scrollTop]: "scroll_up",
  [OsEvent.scrollBottom]: "scroll_down",
  [OsEvent.doubleClick]: "double_tap",
  [OsEvent.foregroundEnter]: "foreground_enter",
  [OsEvent.foregroundExit]: "foreground_exit",
  [OsEvent.abnormalExit]: "abnormal_exit",
  [OsEvent.systemExit]: "system_exit",
  [OsEvent.longPress]: "long_press",
  [OsEvent.longPressRelease]: "long_press_release",
};

const SOURCE: Record<number, InputSource> = {
  [EventSource.glassesRight]: "glasses_right",
  [EventSource.glassesLeft]: "glasses_left",
  [EventSource.ring]: "ring",
};

export type HubEvent =
  | { kind: "input"; gesture: Gesture; source: InputSource; via: "sys" | "text" | "list"; containerId?: number; containerName?: string; itemIndex?: number; itemName?: string }
  | { kind: "imu"; x: number; y: number; z: number }
  | { kind: "result"; cmd: number; code: number; sessionId?: number; fragmentIndex?: number }
  | { kind: "heartbeat_ack"; count?: number }
  | { kind: "audio_ack"; state?: number }
  | { kind: "menu_select"; appId: number }
  | { kind: "page_closed"; cmd: number }
  | { kind: "unknown"; cmd: number | undefined; payload: Uint8Array };

/** Decode one reassembled EvenHub payload from the glasses. */
export function parseHubPayload(payload: Uint8Array): HubEvent[] {
  const m = new PbMessage(payload);
  const cmd = m.int(HubField.cmd);
  if (cmd === HubCmd.osNotifyEvent) return parseDeviceEvent(m.message(HubField.deviceEvent));
  if (cmd === HubCmd.heartbeatResponse || m.has(HubField.heartbeatResponse)) {
    return [{ kind: "heartbeat_ack", count: m.message(HubField.heartbeatResponse)?.int(1) }];
  }
  if (cmd === HubCmd.osNotifyMenuStartup) {
    const appId = m.message(HubField.menuStartEvent)?.int(1);
    return appId === undefined ? [] : [{ kind: "menu_select", appId }];
  }
  if (cmd === HubCmd.audioControlResponse) return [{ kind: "audio_ack", state: m.message(HubField.audioResponse)?.int(1) }];

  const out: HubEvent[] = [];
  for (const f of [HubField.startupResponse, HubField.imageResponse, HubField.rebuildResponse, HubField.textResponse, HubField.shutdownResponse]) {
    const r = m.message(f);
    if (!r) continue;
    if (f === HubField.imageResponse) {
      // ResponseImageRawDataCmd: 3 = MapSessionId, 6 = MapFragmentIndex, 8 = ErrorCode.
      out.push({ kind: "result", cmd: cmd ?? -1, code: r.int(8) ?? 0, sessionId: r.int(3), fragmentIndex: r.int(6) });
    } else out.push({ kind: "result", cmd: cmd ?? -1, code: r.int(1) ?? 0 });
  }
  if (cmd === HubCmd.shutdownPage || cmd === HubCmd.shutdownPageResponse) out.push({ kind: "page_closed", cmd });
  if (out.length === 0) out.push({ kind: "unknown", cmd, payload });
  return out;
}

function parseDeviceEvent(ev: PbMessage | undefined): HubEvent[] {
  if (!ev) return [];
  // SendDeviceEvent: 1 = List_ItemEvent, 2 = Text_ItemEvent, 3 = Sys_ItemEvent
  const sys = ev.message(3);
  if (sys) {
    const type = sys.int(1) ?? OsEvent.click; // proto3 omits 0, so a missing type is a CLICK
    const imu = sys.message(3);
    if (type === OsEvent.imuDataReport && imu) {
      const x = imu.float(1), y = imu.float(2), z = imu.float(3);
      return x === undefined || y === undefined || z === undefined ? [] : [{ kind: "imu", x, y, z }];
    }
    const gesture = GESTURE[type];
    if (!gesture) return [];
    return [{ kind: "input", gesture, source: SOURCE[sys.int(2) ?? 0] ?? "unknown", via: "sys" }];
  }
  const text = ev.message(2);
  if (text) {
    const gesture = GESTURE[text.int(3) ?? OsEvent.click];
    return gesture ? [{ kind: "input", gesture, source: "unknown", via: "text", containerId: text.int(1), containerName: text.string(2) }] : [];
  }
  const list = ev.message(1);
  if (list) {
    const gesture = GESTURE[list.int(5) ?? OsEvent.click];
    return gesture
      ? [{ kind: "input", gesture, source: "unknown", via: "list", containerId: list.int(1), containerName: list.string(2), itemName: list.string(3), itemIndex: list.int(4) ?? 0 }]
      : [];
  }
  return [];
}
