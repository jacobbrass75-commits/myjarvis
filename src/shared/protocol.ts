// Wire protocol shared by the hub, device daemons, the phone UI and the glasses app.
// Every WebSocket text frame is one JSON object with a `t` discriminator.
// The glasses app sends microphone audio as binary frames between audio_start / audio_end.

export type Role = "glasses" | "phone" | "node";

export type AgentStatus = "starting" | "running" | "waiting" | "idle" | "done" | "error";

export interface Agent {
  id: string;
  nodeId: string;
  name: string;
  /**
   * "sdk" = launched by a device daemon through the Agent SDK; "claude-code" = an existing session reporting through hooks;
   * "computer" = a computer-use agent driving that device's screen (src/node/computer.ts).
   */
  kind: "sdk" | "claude-code" | "codex" | "computer";
  cwd: string;
  status: AgentStatus;
  lastText: string;
  updatedAt: number;
}

/** Which coding agent runs a task: Claude Code (Agent SDK) or OpenAI Codex. */
export type AgentEngine = "claude" | "codex";

/** What an agent_start runs: a coding agent, or "computer" (a computer-use agent on a device with that capability). */
export type TaskEngine = AgentEngine | "computer";

/** Optional things a device can do besides coding agents. "computer" = drive its screen (G2_COMPUTER_USE=1). */
export type NodeCapability = "computer";

export interface Approval {
  id: string;
  agentId: string;
  agentName: string;
  nodeId: string;
  tool: string;
  summary: string;
  createdAt: number;
}

export interface NodeInfo {
  id: string;
  name: string;
  online: boolean;
  defaultCwd: string;
  /** Coding agents this device can run. */
  engines?: AgentEngine[];
  /** Existing project folders on this computer; paths are always local to that node. */
  projects?: ProjectInfo[];
  /** Human-readable login/install guidance for an engine that is not ready. */
  engineIssues?: Partial<Record<AgentEngine, string>>;
  permissionMode?: "approvals" | "unrestricted";
  /** "macOS 15.3 (arm64)". */
  os?: string;
  capabilities?: NodeCapability[];
  /** Why a capability that was switched on isn't usable (permissions, the kill switch, no helper). */
  capabilityIssues?: Partial<Record<NodeCapability, string>>;
  /** Computer use: ask once per task, or before every action batch. */
  computerApproval?: "task" | "step";
  /** Set when the device signed in with a per-worker token (scripts/join-worker.sh), not the hub's own. */
  workerId?: string;
}

/** A computer paired with the hub (src/hub/workers.ts). Its token stays on that computer; the hub keeps a hash. */
export interface WorkerInfo {
  id: string;
  name: string;
  nodeId: string;
  os?: string;
  createdAt: number;
  lastSeen?: number;
  online: boolean;
}

export interface ProjectInfo {
  name: string;
  path: string;
}

export type NodeCapabilities = Pick<NodeInfo, "engines" | "projects" | "engineIssues" | "permissionMode" | "os" | "capabilities" | "capabilityIssues" | "computerApproval">;

export interface AppAction {
  name: string;
  description: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** JSON Schema for the action's parameters. GET sends them as the query string, others as a JSON body. */
  params?: Record<string, unknown>;
}

export interface AppDef {
  name: string;
  description: string;
  baseUrl: string;
  headers?: Record<string, string>;
  actions: AppAction[];
}

export interface HubState {
  agents: Agent[];
  approvals: Approval[];
  nodes: NodeInfo[];
  /** Paired computers, online or not. */
  workers?: WorkerInfo[];
  apps: { name: string; description: string }[];
  voice: { listening: boolean; lastHeard: string; lastReply: string };
}

export type Decision = "allow" | "deny";

// ---- Jarvis features ----

/** What continuous listening is for. */
export type ListenPurpose = "copilot" | "translate" | "teleprompter";

export type CardKind = "fact" | "ask" | "say" | "term" | "check" | "next" | "answer";

/** One short thing the copilot puts on the glasses. */
export interface CopilotCard {
  kind: CardKind;
  text: string;
  /** Optional longer version shown when the card is opened. */
  more?: string;
}

export interface CopilotUpdate {
  topic: string;
  summary: string;
  direction: string;
  cards: CopilotCard[];
  at: number;
}

export interface TranscriptLine {
  text: string;
  /** "me" = the wearer, "them" = someone else, when the glasses could tell. */
  who?: "me" | "them";
  at: number;
  final: boolean;
}

/** How Translate shows Chinese. Per session, from the phone page; defaults from the hub's env. */
export interface TranslateOptions {
  /** Pinyin tone style: "marks" (nǐ hǎo) or "numbers" (ni3 hao3, plain ASCII for a lens font without ǎ/ǖ). */
  pinyin: "marks" | "numbers";
  /** Show hanzi on the glasses. Off = pinyin + meaning only (lens font without CJK); the phone always shows them. */
  glassesHanzi: boolean;
}

export interface Note {
  id: string;
  text: string;
  at: number;
}

export interface Script {
  title: string;
  text: string;
}

export type { MiniAppInfo } from "./miniapp.js";
import type { MiniAppInfo } from "./miniapp.js";

/** Progress of a Studio build ("make me a snake game"). */
export interface StudioJob {
  id: string;
  title: string;
  status: "working" | "checking" | "fixing" | "ready" | "failed";
  /** Latest progress line (what Claude is doing). */
  log: string;
  version?: number;
  /** What was asked for (not set for automatic crash fixes), so a failed build can be retried. */
  prompt?: string;
  /** Who is writing it. */
  model?: StudioModel;
  /** status "ready": how long the build took (all tries and test runs). */
  ms?: number;
  at: number;
}

/**
 * Who writes a Studio app: Claude Haiku / Sonnet / Opus, DeepSeek (Anthropic-compatible API), the Codex
 * CLI, or a model on OpenRouter ("openrouter:z-ai/glm-5.3", only with OPENROUTER_API_KEY).
 */
export type StudioModel = "fast" | "balanced" | "best" | "deepseek" | "codex" | `openrouter:${string}`;

export interface StudioModelOption {
  id: StudioModel;
  /** "Fast". */
  label: string;
  /** "Claude Haiku 5.5". */
  detail: string;
  /** false: DeepSeek without DEEPSEEK_API_KEY, Codex not installed (why says so). */
  available: boolean;
  why?: string;
  /** "OpenRouter": shown under its own heading in the picker. */
  group?: string;
}

/** One published version of a Studio app: who built it and how long that took. */
export interface StudioBuild {
  version: number;
  model: StudioModel;
  /** The provider's model id ("claude-haiku-5-5", "deepseek-flash", "z-ai/glm-5.3"), when known. */
  modelId?: string;
  ms: number;
  /** Runs of the model it took (1 = passed the check first time). */
  tries: number;
  /** An automatic crash fix rather than a requested change. */
  fix?: boolean;
  at: number;
}

/** A mini-app as Studio lists it: the glasses' info plus its build history. */
export interface StudioAppInfo extends MiniAppInfo {
  builds?: StudioBuild[];
}

export type Maneuver = "depart" | "straight" | "slight left" | "left" | "sharp left" | "slight right" | "right" | "sharp right" | "uturn" | "roundabout" | "arrive";

export interface NavState {
  dest: string;
  profile: string;
  arrow: string;
  instruction: string;
  /** Metres to the next maneuver. */
  distance: number;
  then?: string;
  remaining: number;
  etaMin: number;
  arrived: boolean;
  /** The next maneuver as a shape for the lens (arrow/instruction stay for the phone). */
  maneuver?: Maneuver;
  /** The street that maneuver turns onto. */
  street?: string;
  thenManeuver?: Maneuver;
  thenStreet?: string;
  /** false while the position is the hub's IP (city-level) guess, not a phone GPS fix. */
  gps?: boolean;
  /** Transit: the ride ahead (board at `stop`, `time` = departure) or the one you're on (get off at `stop`). */
  transit?: NavTransit;
  /** Transit: the whole trip, one short line per leg ("WALK 4 MIN", "BUS 38 9:05 PM POWELL ST"). */
  legs?: string[];
  /** Drive with Google traffic: minutes the traffic adds to the ETA. */
  trafficMin?: number;
}

export interface NavTransit {
  phase: "board" | "ride";
  /** "38", "N", "RED LINE". */
  line: string;
  /** BUS, TRAIN, METRO, TRAM, FERRY, TRANSIT. */
  vehicle: string;
  /** Where to board (phase board) or get off (phase ride). */
  stop: string;
  /** Departure (board) or arrival (ride) time as the agency shows it, e.g. "9:05 PM". */
  time?: string;
  headsign?: string;
  stops?: number;
}

/** Which Navigate view the glasses show, so the hub draws the right map (or none). */
export type NavView = "map" | "full" | "eso" | "off";

/**
 * The Navigate map, rendered on the hub, levels 0..15, route-up: 288x288 with you at pixel (144, 220)
 * (view "map"), or the whole lens 576x288 with you at (288, 220) (view "full").
 */
export interface NavMap {
  w: 288 | 576;
  h: 288;
  /** base64 of pack4 (2 px per byte, high nibble first). */
  px: string;
  seq: number;
  /** Metres per pixel. */
  mpp: number;
  /** Degrees clockwise from north that point up on the map. */
  bearing: number;
  source: "google" | "osm" | "route";
  /** Zoom step (0 = closest) of `of`, and whether it was set by a swipe (held ~20 s) or is automatic. */
  zoom?: { step: number; of: number; manual: boolean };
}

/** A text or iMessage from the Mac's Messages app (src/hub/messages). Kept in the hub's memory only. */
export interface MessageItem {
  id: string;
  /** The chat's guid in Messages (replies go back into it). */
  chat: string;
  /** Contact name, else the phone number or email. "Me" for your own. */
  from: string;
  /** Group chat name (or "Group" when it has none); absent for one-to-one chats. */
  group?: string;
  text: string;
  at: number;
  mine: boolean;
}

/** Weather map layers (the WEATHER mode; swipe cycles them: sky, pressure, temp, precip, clouds, wind). sky = clouds + rain. */
export type WxLayer = "sky" | "pressure" | "temp" | "precip" | "clouds" | "wind";

/**
 * The weather map, rendered on the hub, levels 0..15, north up. view "detail" (the default): the whole
 * lens, 576x288, readouts drawn in; "fast" (compact): 288x288, California only (two tiles; the readouts
 * are text boxes built from `info`).
 */
export type WxView = "fast" | "detail";
export interface WxMap {
  w: 576 | 288;
  h: 288;
  view: WxView;
  /** base64 of pack4 (2 px per byte, high nibble first). */
  px: string;
  layer: WxLayer;
  /** Hours ahead (0, 6, 12 or 24). */
  step: number;
  /** Valid time (ms) and model run (initialisation, ms) of what is drawn. */
  valid: number;
  run?: number;
  /** Airflow animation: per frame, flat [x0, y0, x1, y1, ...] particle dashes to draw over px. */
  frames?: number[][];
  /** California's extremes for the layer (hPa, temperature unit, mph or mm/h), what the map shows. */
  info?: { lo: number; hi: number; source: "MODEL" | "RADAR"; interval?: number; tempUnit: "F" | "C"; /** sky, clouds: CA average cloud cover (%); sky: hi/lo are rain (mm/h). */ cloud?: number };
  /** Tile indices (row by row) in push order: California's tiles first. */
  order?: number[];
  seq: number;
}

export interface Dashboard {
  time: string;
  date: string;
  weather?: string;
  agenda: string[];
  headlines: string[];
  agents: string;
  at: number;
}

// ---- client -> hub ----
export type ClientMsg =
  | ({ t: "hello"; role: Role; token: string; nodeId?: string; name?: string; defaultCwd?: string } & NodeCapabilities)
  | { t: "approve"; id: string; decision: Decision; message?: string }
  | { t: "voice_text"; text: string }
  /**
   * Push-to-talk. purpose "note" saves the transcript as a note instead of running it as a command.
   * clip: the sender's number for this press, echoed in its `caption`s (so a quick second press
   * never shows the first one's words).
   */
  | { t: "audio_start"; sampleRate: number; purpose?: "command" | "note"; clip?: number }
  /** Continuous listening; binary PCM frames follow until listen_stop. */
  | { t: "listen_start"; purpose: ListenPurpose; sampleRate: number; lang?: string; target?: string; translate?: Partial<TranslateOptions> }
  /** Change how Chinese is shown, for the running Translate session and the next ones. */
  | { t: "translate_options"; options: Partial<TranslateOptions> }
  | { t: "listen_stop" }
  /** Who the glasses think is speaking (sent when it changes while listening). */
  | { t: "speaker"; role: "self" | "other" | "unknown" }
  /** Ask the copilot to dig deeper right now (optionally about something specific). */
  | { t: "copilot_ask"; question?: string }
  /** Feed text into a listening session as if it had been heard (phone typing, tests). */
  | { t: "heard"; text: string }
  | { t: "note_add"; text: string }
  | { t: "note_delete"; id: string }
  | { t: "script_set"; script: Script }
  | { t: "dashboard_get" }
  /** Phone GPS fix (from the glasses app or the phone page). */
  | { t: "location"; lat: number; lon: number; accuracy?: number }
  | { t: "nav_start"; query: string; profile?: "walk" | "bike" | "drive" | "transit" }
  // ---- mini-apps & Studio ----
  | { t: "miniapps_get" }
  /** Build a new app from a description, or change an existing one (id). */
  | { t: "studio_make"; prompt: string; id?: string; model?: string }
  /** Which models Studio can build with (answered with studio_models). */
  | { t: "studio_models_get" }
  | { t: "studio_delete"; id: string }
  /** Open a mini-app on the glasses (Studio's "On glasses" button). */
  | { t: "miniapp_open"; id: string }
  /** A running mini-app threw; the hub can ask Claude to fix it. */
  | { t: "app_error"; id: string; version: number; error: string }
  /** Pick the Claude model for the voice assistant or the Copilot (phone page). */
  | { t: "models_set"; role: "assistant" | "copilot"; model: "haiku" | "sonnet" | "opus" }
  | { t: "models_get" }
  /** Turn the glasses screen off (blank, see-through) or back on, from the phone page. */
  | { t: "screen_set"; on: boolean }
  /** Typed text fed into the current listening session as if it had been heard ("type to translate"). */
  | { t: "listen_text"; text: string }
  /** An error inside the glasses page itself, for the hub log (the lens can't show a console). */
  | { t: "glasses_log"; text: string }
  | { t: "app_ask"; reqId: string; prompt: string }
  | { t: "app_fetch"; reqId: string; url: string }
  | { t: "nav_stop" }
  /** The weather map for a layer and forecast step (hours ahead); answered with wx_map. */
  | { t: "wx_get"; layer: WxLayer; step: number; view?: WxView }
  // ---- Messages (src/hub/messages) ----
  | { t: "messages_get" }
  /** The glasses are showing this chat ("reply: on my way" goes to it); no chat = none. */
  | { t: "messages_focus"; chat?: string }
  /** Do not disturb: no message popups on the glasses (they still arrive in MESSAGES). */
  | { t: "messages_dnd"; on: boolean }
  /** MESSAGES was opened: clear the badge of messages that arrived quietly. */
  | { t: "messages_seen" }
  /** The Navigate view on the glasses changed (the hub draws the map that view needs). */
  | { t: "nav_view"; view: NavView }
  /** Navigate swipe: zoom the map in or out (held ~20 s after the last one, then automatic again). */
  | { t: "nav_zoom"; dir: "in" | "out" }
  | { t: "subscribe"; topics: ("transcript" | "copilot" | "translation")[] }
  | { t: "audio_end"; clip?: number }
  /** Drop the push-to-talk clip (the mic didn't open): no transcript, no reply. */
  | { t: "audio_cancel"; clip?: number }
  /** The next utterance is addressed to this agent (the one open on the glasses). */
  | { t: "voice_context"; agentId: string }
  | { t: "agent_send"; agentId: string; text: string }
  | { t: "agent_stop"; agentId: string }
  | { t: "agent_start"; nodeId: string; cwd?: string; prompt: string; name?: string; engine?: TaskEngine }
  /** The glasses are showing this agent (its computer-use thumbnails come only then); no agentId = none. */
  | { t: "agent_watch"; agentId?: string }
  // from device daemons
  | ({ t: "node_capabilities" } & NodeCapabilities)
  | { t: "agent_upsert"; agent: Agent }
  | { t: "agent_remove"; agentId: string }
  /** humanOnly: only a tap on the glasses or the phone may answer it, never the voice router (computer use). */
  | { t: "approval_request"; approval: Approval; detail: string; humanOnly?: boolean }
  /** A computer-use agent's latest screen as a lens tile: 288x144, base64 pack4 (opt-in, G2_COMPUTER_THUMBNAIL=1). */
  | { t: "agent_screen"; agentId: string; w: 288; h: 144; px: string };

// ---- hub -> client ----
export type HubMsg =
  /** Which model the assistant and the Copilot use. */
  | { t: "models"; assistant: "haiku" | "sonnet" | "opus"; copilot: "haiku" | "sonnet" | "opus" }
  /** Screen on/off for the glasses (voice "screen off", phone button). */
  | { t: "screen"; on: boolean }
  | { t: "welcome"; role: Role }
  | { t: "state"; state: HubState }
  | { t: "toast"; text: string }
  | { t: "voice_reply"; heard: string; reply: string }
  /** The assistant is running a tool for the utterance `heard` (before its voice_reply); tool = a short label. */
  | { t: "voice_working"; heard: string; tool: string }
  | { t: "error"; text: string }
  | { t: "transcript"; line: TranscriptLine }
  /**
   * Push-to-talk words so far, to the speaker's screen only (~8/s while held, then one final).
   * text[0, stable) won't change any more. Not a `transcript`, so listening modes ignore it.
   * clip = audio_start's. The final always comes (empty when nothing was heard or STT failed).
   */
  | { t: "caption"; text: string; stable: number; final: boolean; source: "ptt" | "note"; at: number; clip?: number }
  | { t: "copilot"; update: CopilotUpdate }
  /**
   * source = what speech-to-text heard, text = the translation. When Chinese is one side, also:
   * original = what was said, lightly corrected; hanzi = the Chinese side (original or text);
   * pinyin = its pinyin in the session's tone style. Other languages leave these out.
   */
  | { t: "translation"; source: string; text: string; from: string; to: string; at: number; original?: string; hanzi?: string; pinyin?: string }
  | { t: "translate_options"; options: TranslateOptions }
  | { t: "notes"; notes: Note[] }
  | { t: "script"; script: Script | null }
  | { t: "dashboard"; dashboard: Dashboard }
  | { t: "nav"; nav: NavState | null }
  | { t: "nav_map"; map: NavMap | null }
  | { t: "wx_map"; map: WxMap | null; error?: string }
  | { t: "miniapps"; apps: MiniAppInfo[] }
  | { t: "studio"; job: StudioJob }
  | { t: "studio_models"; models: StudioModelOption[]; default: StudioModel }
  | { t: "app_answer"; reqId: string; text?: string; data?: unknown; error?: string }
  /** Recent messages, newest first. queued = arrived without a popup (focus, DND) and not seen yet; issue = why they can't be read (permissions). */
  | { t: "messages"; messages: MessageItem[]; queued: number; dnd: boolean; issue?: string }
  /** One new message. popup false: the wearer is busy (Translate/Copilot/Teleprompter) or in do not disturb. */
  | { t: "message_new"; message: MessageItem; popup: boolean }
  /** Ask the glasses to open a mode (voice: "start translating Spanish"). */
  | { t: "open"; mode: "dashboard" | "copilot" | "translate" | "navigate" | "agents" | "notes" | "teleprompter" | "launcher" | "apps" | "messages" | "weather"; lang?: string; app?: string; wx?: { layer?: WxLayer; step?: number; view?: WxView } }
  | { t: "listening"; purpose: ListenPurpose | null; engine?: string }
  // to device daemons
  | { t: "approval_result"; id: string; decision: Decision; message?: string }
  | { t: "agent_start"; agentId: string; cwd: string; prompt: string; name: string; engine?: TaskEngine }
  | { t: "agent_send"; agentId: string; text: string }
  | { t: "agent_stop"; agentId: string }
  /** To the glasses watching that agent: its latest screen (see the ClientMsg of the same name). */
  | { t: "agent_screen"; agentId: string; w: 288; h: 144; px: string; at: number };

export const send = (ws: { send(data: string): void; readyState: number }, msg: HubMsg | ClientMsg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

export const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** One-line human summary of a tool call, small enough for the glasses. */
export function summarizeTool(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (tool) {
    case "Bash":
      return pick("command");
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      return pick("file_path") || pick("notebook_path");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query");
    default: {
      const s = JSON.stringify(i);
      return s === "{}" ? "" : s;
    }
  }
}
