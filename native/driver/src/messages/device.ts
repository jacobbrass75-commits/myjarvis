/**
 * Device-settings (service 0x80, "dev_config") and G2-setting (service 0x09) messages: the
 * session handshake, heartbeat, time sync, ring binding, battery/firmware query, brightness.
 *
 * Wire shapes from MentraOS G2.kt (Apache-2.0) and men-g2-ble-gateway (MIT); the auth packet is
 * independently confirmed by the captured handshake in i-soxi/even-g2-protocol teleprompter.py.
 * WARNING (g2-kit-unofficial gotchas.md): unknown dev_config fields once soft-bricked a pair until a
 * power cycle. Only the messages below are known-good; do not experiment on service 0x80.
 */
import { DevCmd, SettingCmd } from "../constants.ts";
import { PbMessage, PbWriter } from "../protobuf.ts";

/** AUTHENTICATION: {1: 4, 2: magic, 3: {1: true, 2: 4}}. Sent to EACH lens. */
export const auth = (magic: number) =>
  new PbWriter().int(1, DevCmd.authentication).int(2, magic).message(3, new PbWriter().bool(1, true).int(2, 4)).finish();

/**
 * PIPE_ROLE_CHANGE: makes one lens the command lens. MentraOS sends role 1 to the right lens;
 * the i-soxi capture of the Even App shows role 2. Default here = MentraOS (tested on fw 2.2.20).
 */
export const pipeRoleChange = (magic: number, role = 1) =>
  new PbWriter().int(1, DevCmd.pipeRoleChange).int(2, magic).message(4, new PbWriter().int(1, role)).finish();

/**
 * TIME_SYNC (field 128). The dashboard clock treats the timestamp as wall-clock seconds, so
 * MentraOS sends local time folded into the epoch and offset 0.
 */
export function timeSync(magic: number, now = new Date()) {
  const localSeconds = Math.floor(now.getTime() / 1000) - now.getTimezoneOffset() * 60;
  return new PbWriter()
    .int(1, DevCmd.timeSync)
    .int(2, magic)
    .message(128, new PbWriter().int(1, localSeconds).int(2, 0))
    .finish();
}

export const devHeartbeat = (magic: number) =>
  new PbWriter().int(1, DevCmd.heartbeat).int(2, magic).message(13, new Uint8Array(0)).finish();

/** Tell the glasses to (dis)connect the R1 ring with this MAC (6 bytes, as printed, big-endian). */
export function ringConnectInfo(magic: number, connect: boolean, ringMac: Uint8Array, ringName = "") {
  if (ringMac.length !== 6) throw new RangeError("ring MAC must be 6 bytes");
  const ring = new PbWriter().bool(1, connect).bytes(2, ringMac);
  if (ringName) ring.string(3, ringName);
  return new PbWriter().int(1, DevCmd.ringConnectInfo).int(2, magic).message(5, ring).finish();
}

export type DevEvent =
  | { kind: "auth"; ok: boolean }
  | { kind: "dev_heartbeat" }
  | { kind: "ring_status"; status: number }
  | { kind: "dev_other"; cmd: number | undefined };

export function parseDevPayload(payload: Uint8Array): DevEvent {
  const m = new PbMessage(payload);
  const cmd = m.int(1);
  if (cmd === DevCmd.authentication) return { kind: "auth", ok: (m.message(3)?.int(1) ?? 0) !== 0 };
  if (cmd === DevCmd.heartbeat) return { kind: "dev_heartbeat" };
  if (cmd === DevCmd.ringConnectInfo) {
    const status = m.message(5)?.int(4);
    if (status !== undefined) return { kind: "ring_status", status };
  }
  return { kind: "dev_other", cmd };
}

// ---------------------------------------------------------------- service 0x09

/** Ask for battery / charging / firmware. Reply arrives as DEVICE_RECEIVE_REQUEST or DEVICE_SEND_TO_APP. */
export const requestDeviceInfo = (magic: number) =>
  new PbWriter().int(1, SettingCmd.deviceReceiveRequest).int(2, magic).message(4, new PbWriter().int(1, 1)).finish();

const settingInfo = (magic: number, field: number, sub: PbWriter) =>
  new PbWriter().int(1, SettingCmd.deviceReceiveInfo).int(2, magic).message(3, new PbWriter().message(field, sub)).finish();

/** Brightness. The valid `level` range is not documented by any source (unverified). */
export const setBrightness = (magic: number, level: number, auto = false) =>
  settingInfo(magic, 1, new PbWriter().int(1, auto ? 1 : 0).int(2, level));

export const setHeadUpAngle = (magic: number, angle: number) => settingInfo(magic, 4, new PbWriter().int(2, angle));

export interface DeviceInfo {
  battery?: number;
  charging?: boolean;
  firmwareLeft?: string;
  firmwareRight?: string;
  silentMode?: boolean;
}

export function parseSettingPayload(payload: Uint8Array): DeviceInfo | null {
  const m = new PbMessage(payload);
  const cmd = m.int(1);
  if (cmd !== SettingCmd.deviceReceiveRequest && cmd !== SettingCmd.deviceSendToApp) return null;
  const info: DeviceInfo = {};
  const r = m.message(4);
  if (r) {
    const b = r.int(12);
    if (b !== undefined && b >= 0 && b <= 100) info.battery = b;
    const c = r.int(13);
    if (c !== undefined) info.charging = c !== 0;
    info.firmwareLeft = r.string(5);
    info.firmwareRight = r.string(6);
  }
  const s = m.message(5)?.int(2);
  if (s !== undefined) info.silentMode = s !== 0;
  return info;
}
