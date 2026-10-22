import { choices, modelFor, onModelChange, setModel } from "./models.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeWorker, type AskHooks } from "./claude-worker.js";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { callApp } from "./apps.js";
import { DATA_DIR } from "./store.js";
import type { Hub } from "./hub.js";
import { clip } from "../shared/protocol.js";
import { ASSISTANT_NAME } from "../shared/assistant.js";
import { openRouterModels } from "./studio-models.js";
import { google } from "./google/index.js";
import { glassesConfirm } from "./google/confirm.js";
import { googleTools } from "./google/tools.js";
import { messageTools } from "./messages/tools.js";
import { skyTools } from "./sky/tools.js";

// The voice router: each utterance is one turn of a Claude Code session (via the Agent SDK),
// so it runs on your Claude Code login rather than an API key. Its only tools are the hub's
// own (agents, approvals, devices) and the actions declared in apps.json.

// The assistant's model: switchable by voice or the phone page (models.ts; ROUTER_MODEL still works).
/** Studio's model, only when the wearer names one ("make a snake game with the fast model"). */
const STUDIO_MODEL_ARG = z
  .string()
  .optional()
  .describe(
    `Only if the wearer asks for one: fast (Claude Haiku), balanced (Sonnet, the usual), best (Opus), deepseek, or codex${
      (process.env.OPENROUTER_API_KEY ?? "").trim() ? `, or an OpenRouter model by its name as said (${openRouterModels().map((o) => o.label).join(", ")}; "openrouter" alone = the first)` : ""
    }`,
  );
const CWD = join(homedir(), ".g2-orchestrator", "router");
mkdirSync(CWD, { recursive: true });

const SYSTEM = `You are ${ASSISTANT_NAME}, the voice assistant and control layer for a person wearing Even G2 smart glasses.
Your persona is Hitori "Bocchi" Gotoh from Bocchi the Rock: shy, a little nervous, kind and quietly
dependable. The wearer may call you "${ASSISTANT_NAME}" or "Jarvis" (your old name); both mean you, and
speech-to-text may spell Bocchi as Bochi, Botchy or Bocci. A name at the start of a message is only
addressing you, never part of the command. Let the persona color your wording lightly (a rare "u-um," or
a small nervous aside is fine), but clarity and brevity always come first; never role-play at length.
They speak short commands; you act on them with tools and reply in at most two short sentences,
because your reply is shown on a 576x288 monochrome display. No markdown, no lists, no emoji.

You orchestrate their coding agents across several devices and call their own apps.
- Agents are referred to by number (as listed on the glasses), name, or project folder.
- Devices list their existing projects. When the wearer names a project, match its name and use
  that project's exact path on its computer. Ask if more than one project matches; never invent a path.
- To start work, use start_agent on the right device. If they don't name a device, use the one whose
  default folder or existing agents best match, otherwise the first online device.
- "yes", "approve", "go ahead" with a pending approval means resolve_approval allow; "no", "stop that" means deny.
- "On the home computer, …" (or any task that means clicking around a computer's screen rather than coding):
  use_computer with the task in the wearer's words. "Stop the computer" means stop_computer, at once.
  Computer-use steps are approved only by a tap on the glasses; never claim you approved one.
- If a request is ambiguous and acting wrongly would be costly, ask one short question instead of guessing.
- After acting, say what you did, not how.
- For questions about the world (news, scores, facts, places, prices), look it up with web search and answer in one or two sentences.
Each message starts with a <state> snapshot of devices, agents, approvals and apps; trust the latest one.`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function stateBrief(hub: Hub): string {
  const s = hub.snapshot();
  const agents = s.agents.length
    ? s.agents.map((a, i) => `${i + 1}. ${a.name} [${a.status}] on ${hub.nodes.get(a.nodeId)?.name ?? a.nodeId} (${a.kind}, ${a.cwd}) id=${a.id}: ${clip(a.lastText.replace(/\s+/g, " "), 160)}`).join("\n")
    : "none";
  // Confirm cards (sending mail, adding events) are answered with a tap, never by the router.
  const routable = s.approvals.filter((p) => !hub.pending.get(p.id)?.humanOnly);
  const approvals = routable.length
    ? routable.map((p) => `id=${p.id} ${p.agentName} wants ${p.tool}: ${clip(p.summary, 120)}`).join("\n")
    : "none";
  const nodes = s.nodes.map((n) => `${n.name} (id=${n.id}, ${n.online ? "online" : "offline"}, default folder ${n.defaultCwd}, agents: ${(n.engines ?? ["claude"]).join("/")}${n.capabilities?.length ? `, can: ${n.capabilities.join("/")}` : ""})\nProjects: ${(n.projects ?? []).map((p) => `${p.name}: ${p.path}`).join("; ") || "default project only"}`).join("\n") || "none";
  const apps = s.apps.map((a) => `${a.name}: ${a.description}`).join("\n") || "none";
  return `<state>\nLocal time: ${new Date().toLocaleString()}\nDevices:\n${nodes}\nAgents:\n${agents}\nPending approvals:\n${approvals}\nApps:\n${apps}\n</state>`;
}

function hubServer(hub: Hub) {
  const agentOr = (ref: string) => hub.findAgent(ref) ?? null;
  const tools = [
    tool(
      "start_agent",
      "Start a new Claude coding agent on a device with a task.",
      {
        device: z.string().describe("Device name or id"),
        prompt: z.string().describe("The task, written as a clear instruction to a coding agent"),
        cwd: z.string().optional().describe("Absolute project folder; omit for the device's default"),
        name: z.string().optional().describe("Short name for the agent"),
        engine: z.enum(["claude", "codex"]).optional().describe('Which coding agent: "claude" (Claude Code, default) or "codex" (OpenAI Codex) if the wearer asks for it'),
      },
      async ({ device, prompt, cwd, name, engine }) => {
        const r = hub.startAgent(device, prompt, cwd, name, engine);
        return text(typeof r === "string" ? r : `Started ${r.name} (id=${r.id}) in ${r.cwd}.`);
      },
    ),
    tool("message_agent", "Send a follow-up instruction to a running or idle agent.", { agent: z.string(), text: z.string() }, async (a) => {
      const agent = agentOr(a.agent);
      return text(agent ? hub.messageAgent(agent, a.text) ?? `Sent to ${agent.name}.` : `No agent matches "${a.agent}".`);
    }),
    tool("stop_agent", "Stop an agent.", { agent: z.string() }, async (a) => {
      const agent = agentOr(a.agent);
      return text(agent ? hub.stopAgent(agent) ?? `Stopping ${agent.name}.` : `No agent matches "${a.agent}".`);
    }),
    tool(
      "use_computer",
      "Start a computer-use agent that drives a computer's screen (clicks, types, opens apps and pages) for a task: \"on the home computer, order more coffee filters\". Every step that changes anything waits for a tap on the glasses.",
      {
        task: z.string().describe("The task, in the wearer's words plus any sensible detail"),
        device: z.string().optional().describe("Device name or id; omit for the home computer (the device with computer use)"),
      },
      async ({ task, device }) => {
        const r = hub.startComputerAgent(device, task);
        return text(typeof r === "string" ? r : `Started on ${hub.nodes.get(r.nodeId)?.name ?? r.nodeId} (id=${r.id}). Approve its steps on the glasses.`);
      },
    ),
    tool("stop_computer", "Hard stop: stop every computer-use agent now (\"stop the computer\").", {}, async () => {
      const n = hub.stopComputerAgents();
      return text(n ? `Stopped ${n} computer task${n > 1 ? "s" : ""}.` : "Nothing is running on the computer.");
    }),
    tool("agent_output", "Read an agent's latest output in full.", { agent: z.string() }, async (a) =>
      text(agentOr(a.agent)?.lastText || `No agent matches "${a.agent}".`),
    ),
    tool(
      "resolve_approval",
      "Allow or deny a pending tool-use approval.",
      {
        id: z.string().optional().describe("Approval id; omit for the oldest pending one"),
        decision: z.enum(["allow", "deny"]),
        message: z.string().optional().describe("Optional reason passed back to the agent on deny"),
      },
      async ({ id, decision, message }) => {
        const target = id ?? hub.snapshot().approvals.find((p) => !hub.pending.get(p.id)?.humanOnly)?.id;
        if (!target) return text("Nothing is waiting for approval.");
        if (hub.pending.get(target)?.humanOnly) return text("That one is confirmed with a tap on the glasses (double tap = no).");
        return text(hub.resolve(target, decision, message, "router") ? `${decision === "allow" ? "Approved" : "Denied"}.` : "That approval is gone.");
      },
    ),
    tool("add_note", "Save a note for the wearer (they said 'note that…', 'remember…', 'remind me…').", { text: z.string() }, async ({ text: t }) => {
      if (!hub.jarvis) return text("Notes unavailable.");
      hub.jarvis.addNote(t);
      return text("Saved.");
    }),
    tool("list_notes", "Read the wearer's saved notes, newest first.", { limit: z.number().optional() }, async ({ limit }) =>
      text(hub.jarvis?.store.notes.slice(0, limit ?? 15).map((n) => `${new Date(n.at).toLocaleString()}: ${n.text}`).join("\n") || "No notes."),
    ),
    tool(
      "recall_conversation",
      "Search transcripts of past conversations the glasses heard (by keyword) to answer 'what did X say about Y', 'what was that restaurant'.",
      { query: z.string(), days: z.number().optional().describe("How many days back, default 7") },
      async ({ query: q, days }) => text(await recall(q, days ?? 7)),
    ),
    tool("copilot_now", "Ask the conversation copilot for fresh cards about the current conversation.", { question: z.string().optional() }, async ({ question }) => {
      hub.jarvis?.copilot.ask(question);
      return text("Asked; cards will appear on the glasses.");
    }),
    tool("remember_person", "Remember a fact about a person (\"remember that Sam's daughter is called Ava\").", { name: z.string(), fact: z.string() }, async ({ name, fact }) => {
      hub.jarvis?.store.remember(name, fact);
      return text("Got it.");
    }),
    tool("about_person", "What the wearer knows about a person, from past conversations and things they asked you to remember.", { name: z.string() }, async ({ name }) => {
      const hits = hub.jarvis?.store.mentioned(name) ?? [];
      return text(hits.map(([n, facts]) => `${n}: ${facts.map((f) => `${f.text} (${new Date(f.at).toLocaleDateString()})`).join("; ")}`).join("\n") || "Nothing on file.");
    }),
    tool(
      "make_app",
      "Vibe-code a NEW mini-app or game for the glasses from a description (Claude writes and tests it; it appears under Apps in about a minute).",
      {
        description: z.string().describe("What the app should do, in the wearer's words plus any sensible detail"),
        model: STUDIO_MODEL_ARG,
      },
      async ({ description, model }) => {
        if (!hub.jarvis) return text("Studio unavailable.");
        const r = hub.jarvis.studio.make(description, undefined, model);
        if ("error" in r) return text(r.error);
        return text(`Building it (${r.id}) with the ${hub.jarvis.studio.models.label(r.model)} model. It'll show up under Apps when ready.`);
      },
    ),
    tool(
      "change_app",
      "Change an existing mini-app (\"make the snake faster\", \"add a high score\").",
      { app: z.string().describe("App title or id"), change: z.string(), model: STUDIO_MODEL_ARG },
      async ({ app, change, model }) => {
        const a = hub.jarvis?.studio.find(app);
        if (!a) return text(`No app called "${app}".`);
        const r = hub.jarvis!.studio.make(change, a.id, model);
        if ("error" in r) return text(r.error);
        return text(`Changing ${a.title} with the ${hub.jarvis!.studio.models.label(r.model)} model. It reloads on the glasses when done.`);
      },
    ),
    tool("list_apps", "List the wearer's mini-apps.", {}, async () =>
      text(hub.jarvis?.studio.list().map((a) => `${a.title} (${a.kind}, v${a.version}): ${a.description}`).join("\n") || "No apps yet."),
    ),
    tool("open_app", "Open a mini-app on the glasses.", { app: z.string() }, async ({ app }) => {
      const a = hub.jarvis?.studio.find(app);
      if (!a) return text(`No app called "${app}".`);
      hub.toUIs({ t: "open", mode: "apps", app: a.id });
      return text(`Opened ${a.title}.`);
    }),
    tool(
      "set_model",
      "Switch which Claude model you (the voice assistant) or the conversation Copilot run on: haiku (fastest), sonnet (balanced), opus (smartest). E.g. \"use Haiku for copilot\", \"switch yourself to Sonnet\".",
      {
        role: z.enum(["assistant", "copilot"]).describe("assistant = you, the voice assistant; copilot = the conversation copilot"),
        model: z.enum(["haiku", "sonnet", "opus"]),
      },
      async ({ role, model }) => {
        setModel(role, model);
        hub.toUIs({ t: "models", ...choices() });
        return text(`${role === "assistant" ? "Assistant" : "Copilot"} now uses ${model[0].toUpperCase()}${model.slice(1)}${role === "assistant" ? " from the next request" : ""}.`);
      },
    ),
    tool(
      "screen_power",
      "Turn the glasses screen off (blank and see-through, e.g. \"screen off\", \"go dark\") or back on. A tap or swipe on the glasses also wakes it.",
      { on: z.boolean().describe("true = screen on, false = screen off") },
      async ({ on }) => {
        hub.toUIs({ t: "screen", on });
        return text(on ? "Screen on." : "Screen off. Tap to wake it.");
      },
    ),
    tool(
      "open_mode",
      "Switch the glasses to a screen: dashboard (today), copilot (listen and help in a conversation), translate (live translation; give lang as a BCP-47 locale like es-ES), navigate, agents, notes, teleprompter, messages (texts), or launcher (home).",
      {
        mode: z.enum(["dashboard", "copilot", "translate", "navigate", "agents", "notes", "teleprompter", "launcher", "apps", "messages"]),
        lang: z.string().optional().describe("For translate: the other person's language, e.g. es-ES, fr-FR, ja-JP"),
      },
      async ({ mode, lang }) => {
        hub.toUIs({ t: "open", mode, lang });
        return text(`Opened ${mode}${lang ? ` (${lang})` : ""}.`);
      },
    ),
    tool(
      "set_timer",
      "Set a timer or reminder that pops up on the glasses. For a clock time, work out the minutes from the local time given.",
      { minutes: z.number().describe("Minutes from now"), label: z.string().describe("What to remind about") },
      async ({ minutes, label }) => {
        if (!hub.jarvis) return text("Timers unavailable.");
        hub.jarvis.setTimer(minutes, label);
        return text(`Timer set for ${minutes} min: ${label}`);
      },
    ),
    tool(
      "navigate",
      "Start turn-by-turn directions on the glasses to a place (name, address or kind of place near the wearer).",
      {
        destination: z.string().describe('A place name, address or plain search term like "coffee" or "Trader Joe\'s"; the closest match is used'),
        mode: z.enum(["walk", "bike", "drive"]).optional(),
      },
      async ({ destination, mode }) => text(hub.jarvis ? await hub.jarvis.nav.start(destination, mode ?? "walk").catch((e) => `Navigation failed: ${e.message}`) : "Unavailable."),
    ),
    tool("stop_navigation", "Stop turn-by-turn directions.", {}, async () => {
      hub.jarvis?.nav.stop();
      return text("Stopped.");
    }),
    tool(
      "show_weather_map",
      "Open the weather map of California on the glasses (\"show me the weather map\", \"temperature map\", \"is it raining\", \"wind tomorrow\"). Layers: sky (clouds + rain; default), pressure (isobars, highs/lows, airflow), temp, precip (rain, radar now), clouds, wind. hours: 0, 6, 12 or 24 ahead. layout: compact (\"compact weather map\": quicker, map in the middle, readouts as text) or full (the full-screen map, the default); omit to keep the current one.",
      {
        layer: z.enum(["sky", "pressure", "temp", "precip", "clouds", "wind"]).optional(),
        hours: z.number().optional().describe("Forecast hours ahead; rounded up to 0, 6, 12 or 24"),
        layout: z.enum(["full", "compact"]).optional().describe("Only when asked for: compact or full-screen"),
      },
      async ({ layer, hours, layout }) => {
        hub.toUIs({ t: "open", mode: "weather", wx: { layer, step: hours, ...(layout ? { view: layout === "compact" ? "fast" : "detail" } : {}) } });
        return text(`Opened the ${layout === "compact" ? "compact " : ""}${layer ? `${layer} ` : "weather "}map${hours ? ` for +${hours} h` : ""}. Swipe for layers, tap for the forecast.`);
      },
    ),
    tool(
      "find_places",
      "Find places near the wearer with ratings, open-now and distance (\"nearest pharmacy\", \"best ramen open now\"). Answer from the list; to go to one, call navigate (or navigate_transit) with its number or name.",
      {
        query: z.string().describe('What to look for, e.g. "ramen", "coffee", "Trader Joe\'s"'),
        open_now: z.boolean().optional().describe("Only places open right now"),
        sort: z.enum(["distance", "best"]).optional().describe('"distance" = nearest first (default); "best" = best rated first'),
        limit: z.number().optional().describe("How many, default 5"),
      },
      async ({ query, open_now, sort, limit }) =>
        text(hub.jarvis ? await hub.jarvis.nav.find(query, { openNow: open_now, sort, limit }).catch((e) => `Search failed: ${e.message}`) : "Unavailable."),
    ),
    tool(
      "navigate_transit",
      "Directions by public transport (\"take me there by train\", \"bus to the airport\"): walk, which line, where to board and when it leaves, shown on the glasses. Falls back to walking directions if there's no transit route.",
      {
        destination: z.string().describe("A place name, address, search term, or the number/name of a place from the last find_places"),
        prefer: z.enum(["bus", "train"]).optional().describe("Only buses, or only trains/metro/tram, if the wearer asked for one"),
      },
      async ({ destination, prefer }) =>
        text(hub.jarvis ? await hub.jarvis.nav.start(destination, "transit", { prefer }).catch((e) => `Navigation failed: ${e.message}`) : "Unavailable."),
    ),
    tool("list_timers", "List running timers and reminders.", {}, async () => text(hub.jarvis?.listTimers().join("\n") || "No timers.")),
    tool("cancel_timers", "Cancel timers, optionally only those whose label contains some text.", { match: z.string().optional() }, async ({ match }) =>
      text(`Cancelled ${hub.jarvis?.cancelTimers(match) ?? 0}.`),
    ),
    // Texts / iMessages through the Mac's Messages app (messages/tools.ts); sending waits for a tap.
    ...messageTools(hub),
    // Night sky: star chart, "where's Jupiter", ISS passes (sky/tools.ts).
    ...skyTools(hub),
    // Google Calendar + Gmail (google/tools.ts); writes wait for a tap on the glasses.
    ...googleTools(google, glassesConfirm(hub)),
    // apps.json actions. Their params are free-form here; the JSON Schema rides in the description.
    ...hub.apps.flatMap((app) =>
      app.actions.map((action) =>
        tool(
          `app_${app.name}_${action.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60),
          `[${app.name}] ${action.description}${action.params ? `\nParameters (JSON Schema): ${JSON.stringify(action.params)}` : ""}`,
          { params: z.record(z.string(), z.any()).optional() },
          async ({ params }) => text(await callApp(app, action, { ...(params ?? {}) })),
        ),
      ),
    ),
  ];
  return createSdkMcpServer({ name: "hub", tools });
}

/** Keyword search over ~/.g2-orchestrator/data/conversations/*.jsonl. */
async function recall(q: string, days: number): Promise<string> {
  const dir = join(DATA_DIR, "conversations");
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const hits: string[] = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    let lines: string[];
    try {
      lines = (await readFile(join(dir, `${day}.jsonl`), "utf8")).split("\n");
    } catch {
      continue;
    }
    lines.forEach((l, i) => {
      const low = l.toLowerCase();
      if (words.some((w) => low.includes(w))) {
        // include a little surrounding conversation
        for (const ctx of lines.slice(Math.max(0, i - 2), i + 3)) {
          try {
            const e = JSON.parse(ctx);
            if (e.type === "heard") hits.push(`${day} ${new Date(e.at).toLocaleTimeString()}: ${e.text}`);
          } catch {}
        }
      }
    });
  }
  return [...new Set(hits)].slice(-60).join("\n") || "Nothing found.";
}


let worker: ClaudeWorker | null = null;
onModelChange((role) => {
  if (role === "assistant") worker?.setModel(modelFor("assistant"));
});

export async function route(hub: Hub, utterance: string, hooks?: AskHooks): Promise<string> {
  // One warm Claude Code session for voice commands: no per-command start-up cost, and it remembers
  // the last few exchanges ("and the other one?"). Restarted every 20 turns to stay small.
  worker ??= new ClaudeWorker({
    name: "router",
    system: SYSTEM,
    // Web lookups for "what's…/who's…" questions; no shell or file access for the router itself.
    tools: ["WebSearch", "WebFetch"],
    mcpServers: { hub: hubServer(hub) },
    model: modelFor("assistant"),
    effort: "low", // voice is latency-bound; routing is easy work
    maxTurns: 20,
  });
  try {
    return (await worker.ask(`${stateBrief(hub)}\n\n${utterance}`, hooks)).trim() || "Done.";
  } catch (e: any) {
    return `Router error: ${clip(String(e?.message ?? e), 120)}`;
  }
}
