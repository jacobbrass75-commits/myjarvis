/**
 * G2 / R1 BLE constants.
 *
 * Values are protocol facts collected from (see native/PROTOCOL.md for confidence per item):
 *  - MentraOS G2.kt / G2.swift / R1.kt   (Apache-2.0, Mentra Labs)  github.com/Mentra-Community/MentraOS
 *  - men-g2-ble-gateway mentraos/g2/*     (MIT, gpsnmeajp; itself a port of G2.kt) tested on fw v2.2.20
 *  - even-g2-protocol docs                (i-soxi, no license file; facts only)
 *  - g2-kit-unofficial ble/*.ts           (MIT, Shahara)
 * This file is an independent TypeScript reimplementation; no code was copied verbatim.
 */

const base = (suffix: string) => `00002760-08c2-11e1-9073-0e8ac72e${suffix}`;

/** GATT layout of EACH lens (left and right arms are separate BLE peripherals). */
export const G2_UUID = {
  service: base("0000"),
  /** host -> glasses, write-without-response, framed packets. */
  write: base("5401"),
  /** glasses -> host, notify, framed packets (acks, events, battery...). */
  notify: base("5402"),
  /** glasses -> host, notify, raw LC3 mic audio (NOT framed). */
  audioNotify: base("6402"),
  /** Even File Service (notifications / file push); unused by this driver. */
  fileWrite: base("7401"),
  fileNotify: base("7402"),
  cccd: "00002902-0000-1000-8000-00805f9b34fb",
} as const;

export const R1_UUID = {
  service: "bae80001-4f05-4503-8e65-3af1f7329d1f",
  write1: "bae80010-4f05-4503-8e65-3af1f7329d1f",
  notify1: "bae80011-4f05-4503-8e65-3af1f7329d1f",
  write2: "bae80012-4f05-4503-8e65-3af1f7329d1f",
  notify2: "bae80013-4f05-4503-8e65-3af1f7329d1f",
  batteryService: "0000180f-0000-1000-8000-00805f9b34fb",
  batteryLevel: "00002a19-0000-1000-8000-00805f9b34fb",
} as const;

/** Packet framing. */
export const FRAME = {
  magic: 0xaa,
  /** byte 1 = (dest << 4) | src. Phone = 1, glasses = 2. */
  phoneToGlasses: 0x21,
  glassesToPhone: 0x12,
  headerLen: 8,
  crcLen: 2,
  /** Max protobuf bytes per BLE packet used by MentraOS (fits a 247 MTU with header + CRC). */
  maxChunk: 236,
  /** Status/flag byte (byte 7) value MentraOS sets for every service except device-settings (0x80). */
  reserveFlag: 0x20,
} as const;

/** Service IDs (byte 6 of the header). Names follow Even's service_id_def.proto as recovered by MentraOS. */
export const Service = {
  dashboard: 0x01,
  menu: 0x03,
  notification: 0x04,
  evenAi: 0x07,
  navigation: 0x08,
  g2Setting: 0x09,
  gestureCtrl: 0x0d,
  onboarding: 0x10,
  deviceSettings: 0x80,
  evenHubCtrl: 0x81,
  fileCmd: 0xc4,
  fileData: 0xc5,
  evenHub: 0xe0,
} as const;
export type ServiceId = (typeof Service)[keyof typeof Service];

/** evenhub_main_msg_ctx.Cmd (EvenHub_Cmd_List). */
export const HubCmd = {
  createStartupPage: 0,
  createStartupPageResponse: 1,
  osNotifyEvent: 2,
  updateImageRawData: 3,
  imageRawDataResponse: 4,
  updateTextData: 5,
  textDataResponse: 6,
  rebuildPage: 7,
  rebuildPageResponse: 8,
  shutdownPage: 9,
  shutdownPageResponse: 10,
  osPrivateEvent: 11,
  heartbeat: 12,
  heartbeatResponse: 13,
  osPrivateSystemEvent: 14,
  audioControl: 15,
  audioControlResponse: 16,
  osNotifyMenuStartup: 17,
  appResponseMenuStartupFailed: 18,
  imuControl: 19,
  imuControlResponse: 20,
} as const;

/** Field numbers inside evenhub_main_msg_ctx that carry each sub-message. */
export const HubField = {
  cmd: 1,
  magicRandom: 2,
  createMessage: 3,
  startupResponse: 4,
  imageRawData: 5,
  imageResponse: 6,
  rebuildContainer: 7,
  rebuildResponse: 8,
  textUpgrade: 9,
  textResponse: 10,
  shutdown: 11,
  shutdownResponse: 12,
  deviceEvent: 13,
  heartbeat: 14,
  heartbeatResponse: 15,
  audioControl: 18,
  audioResponse: 19,
  menuStartEvent: 20,
  /**
   * IMU control slot. MentraOS reports field 20 "confirmed live by brute force"; the descriptor
   * in g2-kit-unofficial (EvenHub.proto) says 22. We follow MentraOS (on-device evidence).
   */
  imuControl: 20,
} as const;

/** OsEventTypeList. */
export const OsEvent = {
  click: 0,
  scrollTop: 1,
  scrollBottom: 2,
  doubleClick: 3,
  foregroundEnter: 4,
  foregroundExit: 5,
  abnormalExit: 6,
  systemExit: 7,
  imuDataReport: 8,
  longPress: 9,
  longPressRelease: 10,
} as const;

/** EventSourceType. */
export const EventSource = {
  none: 0,
  glassesRight: 1,
  ring: 2,
  glassesLeft: 3,
} as const;

/** EvenHub_ErrorCode_List (ResCmdMsg / ErrorCode values in responses). */
export const HubResult = {
  createSuccess: 0,
  createInvalidContainer: 1,
  createOversize: 2,
  createOutOfMemory: 3,
  imageSuccess: 4,
  imageFailed: 5,
  rebuildSuccess: 6,
  rebuildFailed: 7,
  textSuccess: 8,
  textFailed: 9,
  shutdownSuccess: 10,
  shutdownFailed: 11,
  heartbeatSuccess: 12,
  audioSuccess: 13,
  audioFailed: 14,
} as const;

/** dev_config_protocol.proto commandId (service 0x80). */
export const DevCmd = {
  authentication: 4,
  pipeRoleChange: 5,
  ringConnectInfo: 6,
  heartbeat: 14,
  timeSync: 128,
} as const;

/** g2_setting.proto commandId (service 0x09). */
export const SettingCmd = {
  deviceReceiveInfo: 1,
  deviceReceiveRequest: 2,
  deviceSendToApp: 3,
  deviceRespondToApp: 4,
} as const;

/** Display / page limits (Even Hub SDK docs + MentraOS). */
export const DISPLAY = {
  width: 576,
  height: 288,
  grayLevels: 16,
  maxContainers: 12,
  maxTextOrListContainers: 8,
  maxImageContainers: 4,
  /** 16 per MentraOS; g2-kit reports 15+ silently rejected. Use <= 14 to be safe. */
  containerNameMax: 16,
  imageMinW: 20,
  imageMaxW: 288,
  imageMinH: 20,
  imageMaxH: 144,
  textMaxBytes: 1000,
  imageFragmentBytes: 4096,
} as const;

/** Mic stream: LC3, 16 kHz mono, 10 ms frames of 40 bytes (32 kbps), 5 frames per notification. */
export const AUDIO = {
  sampleRate: 16000,
  frameMs: 10,
  frameBytes: 40,
  framesPerPacket: 5,
  samplesPerFrame: 160,
} as const;
