import { execFile } from "node:child_process";

// Sending through the Mac's Messages app with osascript. The recipient and text go in as argv to an
// `on run argv` script, never spliced into the AppleScript source, so no quoting can break out.
// The first send asks for Automation permission (node -> Messages); refused, osascript fails with -1743.

export interface SendTarget {
  /** Reply into this existing chat (its guid in chat.db). */
  chat?: string;
  /** Else (or when the chat can't be found) send to this phone number / email. */
  handle?: string;
  service?: "iMessage" | "SMS";
}

export type Runner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const osascript: Runner = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    }),
  );

const CHAT_SCRIPT = ["on run argv", 'tell application "Messages"', "send (item 2 of argv) to chat id (item 1 of argv)", "end tell", "end run"];
const handleScript = (service: "iMessage" | "SMS") => [
  "on run argv",
  'tell application "Messages"',
  `set acct to 1st account whose service type = ${service}`,
  "send (item 2 of argv) to participant (item 1 of argv) of acct",
  "end tell",
  "end run",
];

/** The osascript command line for one send (what a dry run prints). */
export function sendCommand(how: "chat" | "handle", target: SendTarget, text: string): { file: string; args: string[]; script: string } {
  const lines = how === "chat" ? CHAT_SCRIPT : handleScript(target.service ?? "iMessage");
  const to = how === "chat" ? target.chat! : target.handle!;
  return { file: "/usr/bin/osascript", args: [...lines.flatMap((l) => ["-e", l]), to, text], script: lines.join("\n") };
}

export class SendError extends Error {
  constructor(public kind: "automation" | "not-found" | "failed", message: string) {
    super(message);
  }
}

/** From osascript's stderr only: execFile's own message repeats the command line, text included. */
function classify(e: any): SendError {
  const err = String(e?.stderr ?? "").trim();
  const msg = err || (e?.killed ? "osascript timed out" : `osascript failed (${e?.code ?? "?"})`);
  if (/-1743|not authori[sz]ed to send apple events/i.test(err)) return new SendError("automation", msg);
  if (/-1728|-1719|can.t get (chat|participant|buddy|account)|invalid key form/i.test(err)) return new SendError("not-found", msg);
  return new SendError("failed", msg);
}

/** Send one message: into the chat when there is one, falling back to the handle if Messages can't find that chat. */
export async function sendText(target: SendTarget, text: string, run: Runner = osascript): Promise<"chat" | "handle"> {
  if (!target.chat && !target.handle) throw new SendError("not-found", "no recipient");
  if (target.chat) {
    const c = sendCommand("chat", target, text);
    try {
      await run(c.file, c.args);
      return "chat";
    } catch (e) {
      const err = classify(e);
      if (err.kind !== "not-found" || !target.handle) throw err;
    }
  }
  const c = sendCommand("handle", target, text);
  try {
    await run(c.file, c.args);
    return "handle";
  } catch (e) {
    throw classify(e);
  }
}
