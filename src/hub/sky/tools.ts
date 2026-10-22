import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Hub } from "../hub.js";
import { sky } from "./service.js";

// The voice router's SKY tools: open the star chart, find something in the sky, ISS passes. Positions
// come from the phone's GPS when the glasses share it, else the hub's own approximate location.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: any) => text(`Sky lookup failed: ${String(e?.message ?? e).slice(0, 100)}`);

export function skyTools(hub: Hub) {
  const pos = () => hub.jarvis?.nav.pos ?? null;
  return [
    tool(
      "show_sky",
      "Open the night-sky star chart on the glasses (\"show me the stars\", \"what's in the sky\", \"what's up tonight\") and get a short summary of what is up to answer with. view now = the all-sky chart (default; hours = look ahead that many hours), tonight = the list of planets, Moon, ISS passes and meteor showers for tonight.",
      {
        view: z.enum(["now", "tonight"]).optional(),
        hours: z.number().optional().describe("For now: show the sky this many hours ahead (0-6)"),
      },
      async ({ view, hours }) => {
        hub.toUIs({ t: "open", mode: "sky", sky: { view: view ?? "now", step: hours } });
        return sky.summary(pos()).then(text, fail);
      },
    ),
    tool(
      "sky_find",
      "Where something is in the sky right now from the wearer's position: a planet, the Moon or Sun, a bright star (Vega, Sirius...), a constellation (Orion, the Big Dipper = Ursa Major) or the ISS. Answers with direction, altitude and rise/set times.",
      { object: z.string().describe('What to find, e.g. "Jupiter", "Vega", "Orion", "Ursa Major", "Moon", "ISS"') },
      async ({ object }) => sky.find(object, pos()).then(text, fail),
    ),
    tool(
      "iss_passes",
      "When the International Space Station passes over next where the wearer is (\"when does the ISS pass\", \"can I see the space station tonight\"): visible passes with time, directions, height and brightness. Also opens tonight's sky list on the glasses unless show is false.",
      { show: z.boolean().optional().describe("Open TONIGHT on the glasses (default true)") },
      async ({ show }) => {
        if (show !== false) hub.toUIs({ t: "open", mode: "sky", sky: { view: "tonight" } });
        return sky.issText(pos()).then(text, fail);
      },
    ),
  ];
}
