/**
 * G2Driver: talk to Even G2 glasses directly, with an API shaped like the Even Hub SDK bridge
 * (createStartUpPageContainer / rebuildPageContainer / textContainerUpgrade / updateImageRawData /
 * audioControl / imuControl / onEvenHubEvent).
 *
 * Session behaviour (which lens gets what, ordering, heartbeats, image ACK gating) follows
 * MentraOS G2.kt and men-g2-ble-gateway, which run on real hardware (fw 2.2.20). Reimplemented.
 *
 *   both lenses : connect, subscribe notify (5402) + audio (6402), AUTH
 *   right lens  : PIPE_ROLE_CHANGE, TIME_SYNC, every EvenHub/UI message, heartbeats
 *   left lens   : AUTH only (and its mic notifications)
 */
import { audioControl, createPage, heartbeat, imageMessages, imuControl, parseHubPayload, rebuildPage, shutdownPage, updateText } from "./messages/evenhub.ts";
import type { Gesture, HubEvent, InputSource, PageSpec } from "./messages/evenhub.ts";
import { auth, devHeartbeat, parseDevPayload, parseSettingPayload, pipeRoleChange, requestDeviceInfo, ringConnectInfo, setBrightness, timeSync } from "./messages/device.ts";
import type { DeviceInfo } from "./messages/device.ts";
import { G2_UUID, HubResult, Service } from "./constants.ts";
import { Counter8, Reassembler, buildPackets } from "./framing.ts";
import type { Message } from "./framing.ts";
import { AudioDeduper, pcmToBytes, splitAudioPacket } from "./audio.ts";
import type { Lc3Decoder } from "./audio.ts";
import { build4BitBmp } from "./bmp.ts";
import type { GrayImage } from "./bmp.ts";
import { findPair } from "./transport.ts";
import { PbWriter } from "./protobuf.ts";
import type { BleCentral, BlePeripheral, Side } from "./transport.ts";

export interface DriverOptions {
  /** Delay between handshake steps (MentraOS/gateway: 200 ms). */
  stepDelayMs?: number;
  /** Gap between packets of one multi-packet message (gateway: 8 ms, iOS MentraOS: 6 ms). */
  packetGapMs?: number;
  /** EvenHub + dev-settings heartbeat period. The glasses drop the page/mic after ~10 s of silence. 0 disables. */
  heartbeatMs?: number;
  /** Per-fragment image ACK timeout (MentraOS: 2000 ms) and attempts (3). */
  imageAckTimeoutMs?: number;
  imageAttempts?: number;
  /**
   * Also send the dashboard (0x01) "app launch" message the Even App sends at start-up, captured in
   * g2-kit-unofficial (PRELUDE_F5872). Off by default (MentraOS does not send it). Try it if pages
   * never appear.
   */
  dashboardPrelude?: boolean;
  /** PIPE_ROLE_CHANGE value for the right lens: 1 per MentraOS (default), 2 per the i-soxi Even App capture. */
  pipeRole?: number;
  /** Optional LC3 decoder; without it onAudio still gets raw LC3 frames. */
  lc3?: Lc3Decoder;
  log?: (msg: string) => void;
}

export type InputDetail = Extract<HubEvent, { kind: "input" }>;
export type InputHandler = (gesture: Gesture, source: InputSource, detail: InputDetail) => void;
export type AudioHandler = (chunk: { lc3Frames: Uint8Array[]; pcm?: Uint8Array; side: Side; raw: Uint8Array }) => void;

type Waiter = { match: (e: HubEvent) => boolean; resolve: (e: HubEvent | null) => void; timer: ReturnType<typeof setTimeout> };

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

export class G2Driver {
  readonly left: BlePeripheral;
  readonly right: BlePeripheral;
  private readonly opt: Required<Omit<DriverOptions, "lc3" | "log" | "dashboardPrelude">> & Pick<DriverOptions, "lc3" | "log" | "dashboardPrelude">;
  private readonly sync = new Counter8(0);
  private readonly magic = new Counter8(0);
  private imageSession = 0;
  private readonly rx = new Reassembler();
  private readonly dedupe = new AudioDeduper();
  private writeChain: Record<Side, Promise<void>> = { left: Promise.resolve(), right: Promise.resolve() };
  private unsubs: (() => Promise<void>)[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private waiters = new Set<Waiter>();
  private inputHandlers = new Set<InputHandler>();
  private audioHandlers = new Set<AudioHandler>();
  private eventHandlers = new Set<(e: HubEvent | { kind: "device"; info: DeviceInfo } | { kind: "disconnected"; side: Side }) => void>();
  private lastInput: { key: string; side: string; at: number } | null = null;
  private pageCreated = false;
  /** True once the glasses ACKed AUTH on that lens. */
  readonly authenticated: Record<Side, boolean> = { left: false, right: false };
  /** False after the firmware closed our page (system exit, double-tap exit, dashboard...). */
  pageAlive = false;
  micOn = false;
  device: DeviceInfo = {};

  private constructor(left: BlePeripheral, right: BlePeripheral, opts: DriverOptions) {
    this.left = left;
    this.right = right;
    this.opt = {
      stepDelayMs: opts.stepDelayMs ?? 200,
      packetGapMs: opts.packetGapMs ?? 8,
      heartbeatMs: opts.heartbeatMs ?? 5000,
      imageAckTimeoutMs: opts.imageAckTimeoutMs ?? 2000,
      imageAttempts: opts.imageAttempts ?? 3,
      pipeRole: opts.pipeRole ?? 1,
      lc3: opts.lc3,
      log: opts.log,
      dashboardPrelude: opts.dashboardPrelude,
    };
  }

  /** Scan, connect both lenses, run the handshake. */
  static async connect(central: BleCentral, opts: DriverOptions & { serial?: string; scanTimeoutMs?: number } = {}): Promise<G2Driver> {
    const pair = await findPair(central, { serial: opts.serial, timeoutMs: opts.scanTimeoutMs });
    opts.log?.(`found pair ${pair.serial}: L=${pair.left.name} R=${pair.right.name}`);
    const left = await central.connect(pair.left.id);
    const right = await central.connect(pair.right.id);
    return G2Driver.attach(left, right, opts);
  }

  /** Use already-connected peripherals (any transport). */
  static async attach(left: BlePeripheral, right: BlePeripheral, opts: DriverOptions = {}): Promise<G2Driver> {
    const d = new G2Driver(left, right, opts);
    await d.start();
    return d;
  }

  private log(m: string) {
    this.opt.log?.(m);
  }

  private async start() {
    for (const [side, p] of [["left", this.left], ["right", this.right]] as const) {
      this.unsubs.push(await p.subscribe(G2_UUID.notify, (d) => this.onNotify(d, side)));
      await sleep(Math.min(this.opt.stepDelayMs, 50));
      this.unsubs.push(await p.subscribe(G2_UUID.audioNotify, (d) => this.onAudio(d, side)));
      p.onDisconnect(() => this.emit({ kind: "disconnected", side }));
    }
    const step = this.opt.stepDelayMs;
    await this.sendTo("left", Service.deviceSettings, auth(this.magic.next()));
    await sleep(step);
    await this.sendTo("right", Service.deviceSettings, auth(this.magic.next()));
    await sleep(step);
    await this.sendTo("right", Service.deviceSettings, pipeRoleChange(this.magic.next(), this.opt.pipeRole));
    await sleep(step);
    await this.sendTo("right", Service.deviceSettings, timeSync(this.magic.next()));
    await sleep(step);
    if (this.opt.dashboardPrelude) {
      // {1: 2, 2: magic, 4: {3: {2: {2: {1: 0, 2: 0}}}}} - bytes from the Even App capture, fresh magic.
      const body = new PbWriter().message(3, new PbWriter().message(2, new PbWriter().message(2, new PbWriter().int(1, 0).int(2, 0))));
      await this.sendTo("right", Service.dashboard, new PbWriter().int(1, 2).int(2, this.magic.next()).message(4, body).finish());
      await sleep(step);
    }
    if (this.opt.heartbeatMs > 0) this.heartbeatTimer = setInterval(() => void this.beat(), this.opt.heartbeatMs);
    this.log("handshake sent");
  }

  private async beat() {
    try {
      if (this.pageCreated) await this.sendTo("right", Service.evenHub, heartbeat(this.magic.next()));
      await this.sendTo("right", Service.deviceSettings, devHeartbeat(this.magic.next()));
    } catch (e) {
      this.log(`heartbeat failed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ sending

  /** Frame and write one logical message to one lens. Messages never interleave on a lens. */
  sendTo(side: Side, service: number, payload: Uint8Array): Promise<void> {
    const packets = buildPackets(payload, { syncId: this.sync.next(), service });
    const p = side === "left" ? this.left : this.right;
    const run = async () => {
      for (let i = 0; i < packets.length; i++) {
        await p.write(G2_UUID.write, packets[i]!, true);
        if (i < packets.length - 1) await sleep(this.opt.packetGapMs);
      }
    };
    const next = this.writeChain[side].then(run, run);
    this.writeChain[side] = next.catch(() => {});
    return next;
  }

  private hub(payload: Uint8Array) {
    return this.sendTo("right", Service.evenHub, payload);
  }

  // ------------------------------------------------------------ SDK-shaped API

  /** createStartUpPageContainer. The first call creates; later calls rebuild (a second CREATE is not ACKed). */
  async createPage(spec: PageSpec): Promise<void> {
    if (this.pageCreated) return this.rebuildPage(spec);
    await this.hub(createPage(spec, this.magic.next()));
    this.pageCreated = true;
    this.pageAlive = true;
  }

  /** rebuildPageContainer: replace the whole layout. */
  async rebuildPage(spec: PageSpec): Promise<void> {
    if (!this.pageCreated) return this.createPage(spec);
    await this.hub(rebuildPage(spec, this.magic.next()));
    this.pageAlive = true;
  }

  /** textContainerUpgrade: replace the text of one container in place. */
  setText(containerId: number, content: string): Promise<void> {
    return this.hub(updateText(containerId, content.length ? content : " ", { magic: this.magic.next() }));
  }

  /**
   * updateImageRawData. Accepts a ready 4-bit BMP or an 8-bit grey image (converted). Fragments are
   * sent one at a time, each gated on its ACK (ErrorCode 4 = ok, 5 = failed); the whole image is
   * retried with a fresh session id on failure/timeout. Returns false if all attempts failed.
   */
  async setImage(containerId: number, image: Uint8Array | GrayImage, containerName?: string): Promise<boolean> {
    const bmp = image instanceof Uint8Array ? image : build4BitBmp(image);
    for (let attempt = 1; attempt <= this.opt.imageAttempts; attempt++) {
      this.imageSession = (this.imageSession + 1) % 256;
      const session = this.imageSession;
      const msgs = imageMessages(containerId, bmp, session, containerName);
      let ok = true;
      for (let i = 0; i < msgs.length; i++) {
        const ack = this.waitFor(
          (e) => e.kind === "result" && e.sessionId === session && (e.fragmentIndex ?? 0) === i && (e.code === HubResult.imageSuccess || e.code === HubResult.imageFailed),
          this.opt.imageAckTimeoutMs,
        );
        await this.hub(msgs[i]!);
        const r = await ack;
        if (!r || (r.kind === "result" && r.code !== HubResult.imageSuccess)) {
          this.log(`image ${containerId} fragment ${i} ${r ? "failed" : "timed out"} (attempt ${attempt})`);
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  /** audioControl. The mic only runs while one of our pages is up, and dies with the page. */
  async startMic(onAudio?: AudioHandler): Promise<() => void> {
    const off = onAudio ? this.onAudioData(onAudio) : () => {};
    await this.hub(audioControl(true, this.magic.next()));
    this.micOn = true;
    return off;
  }

  async stopMic(): Promise<void> {
    await this.hub(audioControl(false, this.magic.next()));
    this.micOn = false;
  }

  /** imuControl. reportFrq is a pacing code 100..1000. Requires a live page. */
  setImu(enable: boolean, reportFrq = 100): Promise<void> {
    return this.hub(imuControl(enable, reportFrq, this.magic.next()));
  }

  /** shutDownPageContainer. exitMode 0 = exit immediately, 1 = ask the user (SDK semantics). */
  async shutdown(exitMode = 0): Promise<void> {
    await this.hub(shutdownPage(exitMode));
    this.pageAlive = false;
  }

  /** Battery / charging / firmware, via service 0x09. */
  async requestDeviceInfo(timeoutMs = 3000): Promise<DeviceInfo> {
    const got = new Promise<DeviceInfo>((resolve) => {
      const t = setTimeout(() => {
        off();
        resolve(this.device);
      }, timeoutMs);
      const off = this.onEvent((e) => {
        if (e.kind === "device") {
          clearTimeout(t);
          off();
          resolve(e.info);
        }
      });
    });
    await this.sendTo("right", Service.g2Setting, requestDeviceInfo(this.magic.next()));
    return got;
  }

  setBrightness(level: number, auto = false) {
    return this.sendTo("right", Service.g2Setting, setBrightness(this.magic.next(), level, auto));
  }

  /** Ask the glasses to connect (or drop) the R1 ring with this MAC. */
  bindRing(ringMac: Uint8Array, connect = true) {
    return this.sendTo("right", Service.deviceSettings, ringConnectInfo(this.magic.next(), connect, ringMac));
  }

  // ------------------------------------------------------------ events

  /** onEvenHubEvent, reduced to (gesture, source). Ring gestures arrive here via the glasses. */
  onInput(h: InputHandler): () => void {
    this.inputHandlers.add(h);
    return () => this.inputHandlers.delete(h);
  }

  onAudioData(h: AudioHandler): () => void {
    this.audioHandlers.add(h);
    return () => this.audioHandlers.delete(h);
  }

  onEvent(h: (e: HubEvent | { kind: "device"; info: DeviceInfo } | { kind: "disconnected"; side: Side }) => void): () => void {
    this.eventHandlers.add(h);
    return () => this.eventHandlers.delete(h);
  }

  private emit(e: HubEvent | { kind: "device"; info: DeviceInfo } | { kind: "disconnected"; side: Side }) {
    for (const h of this.eventHandlers) h(e);
  }

  private waitFor(match: (e: HubEvent) => boolean, timeoutMs: number): Promise<HubEvent | null> {
    return new Promise((resolve) => {
      const w: Waiter = {
        match,
        resolve: (e) => {
          clearTimeout(w.timer);
          this.waiters.delete(w);
          resolve(e);
        },
        timer: setTimeout(() => w.resolve(null), timeoutMs),
      };
      this.waiters.add(w);
    });
  }

  /** Feed one notification from the command channel (public so other transports can push data in). */
  onNotify(data: Uint8Array, side: Side) {
    const msg = this.rx.push(data, side);
    if (msg) this.dispatch(msg, side);
  }

  private dispatch(msg: Message, side: Side) {
    if (msg.crcOk === false) this.log(`CRC mismatch from ${side} service 0x${msg.service.toString(16)} (kept)`);
    if (msg.service === Service.evenHub) {
      for (const e of parseHubPayload(msg.payload)) this.handleHub(e, side);
    } else if (msg.service === Service.deviceSettings) {
      const e = parseDevPayload(msg.payload);
      if (e.kind === "auth") this.authenticated[side] = e.ok;
    } else if (msg.service === Service.g2Setting) {
      const info = parseSettingPayload(msg.payload);
      if (info) {
        this.device = { ...this.device, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) };
        this.emit({ kind: "device", info: this.device });
      }
    }
  }

  private handleHub(e: HubEvent, side: Side) {
    for (const w of [...this.waiters]) if (w.match(e)) w.resolve(e);
    if (e.kind === "input") {
      if (e.gesture === "system_exit" || e.gesture === "abnormal_exit") {
        this.pageAlive = false;
        this.micOn = false;
      }
      // Both lenses can report the same gesture; drop the echo from the other lens within 250 ms.
      const key = `${e.gesture}|${e.source}|${e.via}|${e.containerId ?? ""}`;
      const now = Date.now();
      if (this.lastInput && this.lastInput.key === key && this.lastInput.side !== side && now - this.lastInput.at < 250) return;
      this.lastInput = { key, side, at: now };
      for (const h of this.inputHandlers) h(e.gesture, e.source, e);
    }
    if (e.kind === "page_closed" || (e.kind === "result" && e.code === HubResult.textFailed)) {
      this.pageAlive = false;
      this.micOn = false;
    }
    this.emit(e);
  }

  private onAudio(data: Uint8Array, side: Side) {
    if (!this.dedupe.accept(data)) return;
    const lc3Frames = splitAudioPacket(data).map((f) => Uint8Array.from(f));
    let pcm: Uint8Array | undefined;
    if (this.opt.lc3) {
      const parts = lc3Frames.map((f) => this.opt.lc3!.decodeFrame(f));
      const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) {
        all.set(p, off);
        off += p.length;
      }
      pcm = pcmToBytes(all);
    }
    for (const h of this.audioHandlers) h({ lc3Frames, pcm, side, raw: data });
  }

  async close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const w of [...this.waiters]) w.resolve(null);
    for (const u of this.unsubs) await u().catch(() => {});
    await Promise.allSettled([this.left.disconnect(), this.right.disconnect()]);
  }
}
