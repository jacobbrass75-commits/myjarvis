import { randomUUID } from "node:crypto";
import type { Hub } from "../hub.js";

// A yes/no card on the glasses (the same card as agent approvals: tap = yes, double tap = no; the
// phone shows it too). Only a person can answer it, never the voice router, and no answer in time
// counts as no.

export const CONFIRM_TIMEOUT_MS = Number(process.env.GOOGLE_CONFIRM_TIMEOUT_S || 60) * 1000;

export interface ConfirmCard {
  /** Header name, e.g. "Gmail" or "Calendar". */
  source: string;
  /** First line on the card, e.g. "SEND to sam@x.com". */
  action: string;
  /** Up to ~4 short lines of detail. */
  summary: string;
}

export type Confirm = (card: ConfirmCard) => Promise<boolean>;

export function glassesConfirm(hub: Hub, timeoutMs = CONFIRM_TIMEOUT_MS): Confirm {
  return (card) =>
    new Promise<boolean>((resolve) => {
      const id = `g-${randomUUID().slice(0, 8)}`;
      hub.addApproval(
        {
          approval: { id, agentId: `google-${card.source.toLowerCase()}`, agentName: card.source, nodeId: "", tool: card.action, summary: card.summary.slice(0, 500), createdAt: Date.now() },
          detail: "",
          humanOnly: true,
          resolveHook: (d) => resolve(d?.decision === "allow"), // null = timed out = no
        },
        timeoutMs,
      );
    });
}
