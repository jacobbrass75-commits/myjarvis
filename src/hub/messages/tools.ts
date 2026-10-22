import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Hub } from "../hub.js";
import { messages } from "./index.js";

// The voice router's Messages tools. Reading is free; a text goes out only after a tap on the
// glasses' confirm card (send_message never sends by itself).

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const OFF = "Messages isn't running on the hub.";

export function messageTools(hub: Hub) {
  return [
    tool(
      "read_messages",
      "Read the wearer's recent texts and iMessages (from the Mac's Messages app), newest first, and open MESSAGES on the glasses. Optionally only one person or group chat. Summarize briefly; don't read long threads out in full.",
      {
        from: z.string().optional().describe("A contact or group chat name, to read only that conversation"),
        limit: z.number().optional().describe("How many, default 8"),
      },
      async ({ from, limit }) => {
        const m = messages();
        if (!m) return text(OFF);
        hub.toUIs({ t: "open", mode: "messages" });
        return text(m.read(from, limit ?? 8));
      },
    ),
    tool(
      "send_message",
      "Text someone through the Mac's Messages app: 'text Sam I'm 5 minutes out', 'reply to Mom: on my way', 'reply: sounds good' (no name = the conversation on the glasses, else the latest message). You may tidy the wording (speech-to-text slips, punctuation, capitals) but keep their meaning, voice and length; never add anything. This NEVER sends by itself: it puts a confirm card on the glasses (tap sends, double tap or no answer cancels) and returns at once. Never say it was sent; say it's waiting for their tap. If it answers with a question (which contact?), ask the wearer.",
      {
        to: z.string().optional().describe("Contact name, group chat name, phone number or email; omit to reply to the conversation on the glasses or the latest message"),
        text: z.string().describe("The message, as it will be sent"),
      },
      async ({ to, text: body }) => {
        const m = messages();
        return text(m ? m.requestSend(to, body) : OFF);
      },
    ),
    tool(
      "messages_do_not_disturb",
      "Turn message popups on the glasses off (do not disturb: messages still arrive in MESSAGES) or back on.",
      { on: z.boolean().describe("true = do not disturb (no popups)") },
      async ({ on }) => {
        const m = messages();
        if (!m) return text(OFF);
        m.setDnd(on);
        return text(on ? "Do not disturb is on: no message popups." : "Message popups are back on.");
      },
    ),
  ];
}
