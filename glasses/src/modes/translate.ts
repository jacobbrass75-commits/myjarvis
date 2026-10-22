import type { HubMsg, TranslateOptions } from "../../../src/shared/protocol";
import { COLS, fitWidth, startListening, stopListening, textWidth, wrapWide, type Mode } from "../core";
import { G } from "../ui/kit";

// Live two-way translation. Pick the other person's language; what they say appears in yours, and
// what you say appears in theirs. Swipe to scroll back, double tap to change language.
// Chinese shows three compact parts per sentence: hanzi, pinyin, meaning (hanzi can be turned off
// from the phone page if the lens font has no CJK glyphs).

const LANGS: [code: string, locale: string, name: string][] = [
  ["es", "es-ES", "Spanish"], ["fr", "fr-FR", "French"], ["de", "de-DE", "German"], ["it", "it-IT", "Italian"],
  ["pt", "pt-BR", "Portuguese"], ["zh", "zh-CN", "Chinese"], ["ja", "ja-JP", "Japanese"], ["ko", "ko-KR", "Korean"],
  ["ar", "ar-SA", "Arabic"], ["ru", "ru-RU", "Russian"], ["hi", "hi-IN", "Hindi"], ["he", "he-IL", "Hebrew"],
];
const MINE = (navigator.language || "en").slice(0, 2);
const ROWS = 7;
const HAN = /\p{Script=Han}/u;

type Line = { source: string; text: string; to: string; from: string; original?: string; hanzi?: string; pinyin?: string };

let lang: (typeof LANGS)[number] | null = null;
let lines: Line[] = [];
let back = 0;
let partial = "";
let partialWho: "me" | "them" | undefined;
let opts: TranslateOptions = { pinyin: "marks", glassesHanzi: true };

/** The end of s that fits in `cols` columns. */
function tail(s: string, cols: number) {
  const cs = Array.from(s);
  let i = cs.length;
  for (let w = 0; i > 0 && (w += textWidth(cs[i - 1])) <= cols; ) i--;
  return cs.slice(i).join("");
}

/** One sentence's rows, at most `room` of them. */
export function block(l: Line, room = ROWS, o: TranslateOptions = opts): string[] {
  const mark = l.to === MINE ? "»" : "«";
  if (!l.hanzi) {
    const rows = [...wrapWide(`${mark} ${l.text}`).slice(0, 2), fitWidth(`   ${l.source}`, COLS)];
    // A Chinese session's sentence that came without hanzi (an odd reply): its heard text is still
    // Chinese, so keep it off a lens without CJK glyphs.
    return !o.glassesHanzi && (l.from === "zh" || l.to === "zh") ? rows.filter((r) => !HAN.test(r)) : rows;
  }
  // Hanzi, pinyin, meaning: up to 2/3/2 rows; a tall sentence loses pinyin rows first, then hanzi.
  // The meaning is the non-Chinese side; none if the reply had none (what was heard is then Chinese).
  const meaning = (l.from === "zh" ? [l.text] : [l.original, l.source]).find((t) => t && !HAN.test(t)) ?? "";
  const parts = [o.glassesHanzi ? l.hanzi : "", l.pinyin ?? "", meaning].map((t) => (t ? wrapWide(t, COLS - 2) : []));
  const caps = parts.map((p, i) => Math.min(p.length, i === 1 ? 3 : 2));
  for (const i of [1, 0, 2]) while (caps[i] > 1 && caps.reduce((a, b) => a + b) > room) caps[i]--;
  const out: string[] = [];
  parts.forEach((p, i) => {
    const rows = p.slice(0, caps[i]);
    if (p.length > caps[i]) rows[rows.length - 1] = fitWidth(rows[rows.length - 1], COLS - 3) + "…";
    for (const r of rows) out.push((out.length ? "  " : `${mark} `) + r);
  });
  return out;
}

/** Start translating straight away (voice: "start translating Japanese"). */
export function translateTo(locale: string) {
  const l = LANGS.find(([code, loc]) => loc.toLowerCase() === locale.toLowerCase() || code === locale.slice(0, 2).toLowerCase());
  if (!l) return;
  lang = l;
  lines = [];
  startListening("translate", l[1], MINE);
}

export const translate: Mode = {
  id: "translate",
  title: "Translate",
  quiet: true,
  enter() {
    lang = null;
    lines = [];
  },
  exit() {
    stopListening();
  },
  resume() {
    if (lang) startListening("translate", lang[1], MINE);
  },
  onHub(m: HubMsg) {
    if (m.t === "translate_options") opts = m.options;
    if (!lang) return;
    if (m.t === "translation") {
      lines.push({ source: m.source, text: m.text, to: m.to, from: m.from, original: m.original, hanzi: m.hanzi, pinyin: m.pinyin });
      if (lines.length > 50) lines.shift();
      back = 0;
      partial = "";
    } else if (m.t === "transcript" && !m.line.final) {
      partial = m.line.text;
      partialWho = m.line.who;
    }
  },
  screen() {
    if (!lang) return { header: `Translate · with someone speaking…`, list: LANGS.map(([, , n]) => n) };
    const header = `● ${lang[2]} ⇄ ${MINE}`;
    const shown = lines.slice(0, lines.length - back).slice(-3);
    // Words still being heard: who, then their end and the "_" cursor. Without CJK glyphs on the lens,
    // a Chinese partial would be boxes: just show that it's hearing.
    const who = partialWho === "me" ? "YOU > " : partialWho === "them" ? "THEM > " : "";
    const words = opts.glassesHanzi || !HAN.test(partial) ? partial.trim() : "";
    const end = tail(words, COLS - who.length - textWidth(G.ell) - 2);
    const live = partial && !back ? (words ? `${who}${end === words ? "" : G.ell}${end}_` : `${who}${G.ell}`) : "";
    const room = ROWS - (live ? 1 : 0);
    const body: string[] = [];
    if (shown.length) {
      // The newest sentence always shows whole; older ones fill what's left above it (Chinese ones
      // only whole: a meaning without its hanzi/pinyin reads like part of the next sentence).
      body.push(...block(shown[shown.length - 1], room));
      for (const l of shown.slice(0, -1).reverse()) {
        const b = block(l);
        const left = room - body.length;
        if (b.length <= left) body.unshift(...b);
        else {
          if (!l.hanzi && left > 0) body.unshift(...b.slice(-left));
          break;
        }
      }
    } else body.push("", "Listening… speak or let them speak.");
    if (live) body.push(live);
    return { header, body: body.slice(-ROWS).join("\n") };
  },
  gesture(g, i) {
    if (!lang) {
      if (g === "tap" && LANGS[i]) {
        lang = LANGS[i];
        startListening("translate", lang[1], MINE);
        return true;
      }
      return g !== "double";
    }
    if (g === "up") back = Math.min(back + 1, Math.max(0, lines.length - 1));
    else if (g === "down") back = Math.max(0, back - 1);
    else if (g === "double") {
      stopListening();
      lang = null;
    } else return false;
    return true;
  },
};
