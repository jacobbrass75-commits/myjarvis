/**
 * The mini-app contract. A mini-app is ONE plain JavaScript ES module (miniapps/<id>/app.js) with a
 * default export implementing `MiniApp`. The Jarvis glasses app loads it from the hub at runtime,
 * so new and edited apps show up on the glasses instantly. Claude writes these from a description
 * (Studio); this file is also the spec it is given.
 *
 * Display: the G2 lens is 576x288, monochrome green, 16 brightness levels. Two kinds of app:
 *  - "text":   you return a header line plus either a body (about 46 characters x 6 lines) or a
 *              list (one selectable row per item; swiping moves the highlight, tap selects).
 *  - "pixels": you draw a 144x72 picture (shown 2x, 288x144) with levels 0..15 per pixel, plus a
 *              header line. Real glasses refresh pictures only about 6-8 times a second, so games
 *              must stay playable at low frame rates (slow movers, turn-based, puzzles, big shapes).
 *
 * Input (temple touchpads or the R1 ring): "tap", "double", "up", "down" (swipes), "hold" and
 * "release" (long press). A double tap you don't handle (input returns false) exits the app.
 *
 * Rules: no imports, no DOM, no network or timers of your own (use tick and the api), keep state
 * in the module, keep it under ~400 lines. Apps run sandboxed (a Web Worker on the glasses): the api
 * below is all there is.
 */

export type MiniGesture = "tap" | "double" | "up" | "down" | "hold" | "release";

export interface MiniScreen {
  header: string;
  body?: string;
  list?: string[];
}

export interface MiniAppApi {
  /** Pixel canvas size for "pixels" apps. */
  readonly W: 144;
  readonly H: 72;
  /** Small persistent storage for this app (high scores, settings). Values are strings; 64 KB in all. */
  store: { get(key: string): string | undefined; set(key: string, value: string): void };
  /**
   * Ask Claude something (trivia, a riddle, a fact, a reply). Resolves with plain text in ~2-5 s.
   * Like fetchJson it can reject (offline, timeout): always .catch() and show a message, or the app
   * waits forever. Don't assume the answer has an exact format; parse it defensively.
   */
  ask(prompt: string): Promise<string>;
  /**
   * GET a URL and parse the JSON (fetched by the hub, so no CORS issues). Public internet only (no
   * local or private addresses), at most 1 MB and 10 s.
   */
  fetchJson(url: string): Promise<any>;
  /** Flash a short message in the header for a few seconds. */
  toast(text: string): void;
  /** Ask the glasses to redraw now (text apps; e.g. after an async answer arrives). */
  refresh(): void;
  /** Leave the app. */
  exit(): void;
}

export interface MiniApp {
  title: string;
  kind?: "text" | "pixels";
  /** Called once when the app opens. */
  init?(api: MiniAppApi): void;
  /** Called about 30 times a second while open; dt is seconds since the last call. */
  tick?(dt: number): void;
  /** Text apps: what to show. Called whenever the screen may have changed. */
  screen?(): MiniScreen;
  /** Pixel apps: fill px (length 144*72, row-major, values 0..15). It is cleared to 0 first. */
  draw?(px: Uint8Array): void;
  /** Pixel apps: the line above the picture (score, lives…). */
  header?(): string;
  /** A gesture; `index` is the highlighted list row for text apps with a list. Return true if handled. */
  input?(g: MiniGesture, index?: number): boolean | void;
  /** Called when the app closes. */
  exit?(): void;
}

export interface MiniAppInfo {
  id: string;
  title: string;
  kind: "text" | "pixels";
  version: number;
  description: string;
  updatedAt: number;
}
