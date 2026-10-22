import { customPinyin, pinyin } from "pinyin-pro";
import type { TranslateOptions } from "../shared/protocol.js";
import { ClaudeWorker } from "./claude-worker.js";

// Two-way live translation for a conversation: speech in the other person's language is shown in
// yours, and what you say in your language is shown in theirs (so you can read it out or show them).
// With Chinese on one side, every reply carries both sides, so the screens can show the hanzi, its
// pinyin (made here, deterministically, never by the model) and the meaning together.

export interface Side {
  /** BCP-47 locale or ISO 639-1 code, e.g. "zh-CN", "en". */
  code: string;
  /** "Chinese", "English", … */
  name: string;
}

export interface Translation {
  /** Language the sentence was spoken in (ISO 639-1), "" when the reply didn't say. */
  from: string;
  /** Language it was translated into. */
  to: string;
  /** What was said, lightly corrected ("" unless the reply gave it). */
  original: string;
  text: string;
  /** Chinese sessions: the Chinese side and its pinyin. */
  hanzi?: string;
  pinyin?: string;
}

export type PinyinTones = TranslateOptions["pinyin"];

const lang2 = (code: string) => code.slice(0, 2).toLowerCase();
const HAN = /\p{Script=Han}/u;

export function defaultTranslateOptions(env = process.env): TranslateOptions {
  return {
    pinyin: env.TRANSLATE_PINYIN_TONES === "numbers" ? "numbers" : "marks",
    glassesHanzi: env.TRANSLATE_GLASSES_HANZI !== "0",
  };
}

/** Merge untrusted option changes (phone page) onto the current ones. */
export function mergeTranslateOptions(cur: TranslateOptions, o?: Partial<TranslateOptions>): TranslateOptions {
  return {
    pinyin: o?.pinyin === "marks" || o?.pinyin === "numbers" ? o.pinyin : cur.pinyin,
    glassesHanzi: typeof o?.glassesHanzi === "boolean" ? o.glassesHanzi : cur.glassesHanzi,
  };
}

// ---- pinyin ----

// Full-width punctuation -> ASCII before pinyin-pro sees it, so the pinyin line reads like a sentence.
const PUNCT: Record<string, string> = {
  "，": ",", "、": ",", "。": ".", "．": ".", "？": "?", "！": "!", "：": ":", "；": ";", "（": "(", "）": ")",
  "【": "(", "】": ")", "“": '"', "”": '"', "「": '"', "」": '"', "『": '"', "』": '"', "《": '"', "》": '"',
  "‘": "'", "’": "'", "……": "…", "——": "-", "～": "~", "·": " ", "　": " ", "￥": "¥",
};
const PUNCT_RE = new RegExp(Object.keys(PUNCT).sort((a, b) => b.length - a.length).join("|"), "g");
// Full-width letters, digits and symbols (ＯＫ１２３％) -> ASCII.
const FULL_WIDTH = /[！-～]/g;
// A run of Latin/digits that may hold inner punctuation ("3:30", "1,000", "don't", "Wi-Fi",
// "a@b.com"), or any other single character.
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:[-.:',@/&_+][\p{L}\p{N}]+)*|\S/gu;
const CLOSE = /^[,.!?;:)\]}%…]$/;
const OPEN = /^[(\[{¥$€£]$/;
// Common erhua (哪儿 is "nǎr", not "nǎ ér"); 女儿, 儿子 etc. keep a full ér.
customPinyin({
  哪儿: "nǎr", 这儿: "zhèr", 那儿: "nàr", 一点儿: "yì diǎnr", 有点儿: "yǒu diǎnr", 一会儿: "yí huìr", 玩儿: "wánr",
  一块儿: "yí kuàir", 事儿: "shìr", 味儿: "wèir", 空儿: "kòngr", 小孩儿: "xiǎo háir", 一下儿: "yí xiàr",
});

/**
 * Pinyin for a Chinese sentence: "你好，银行在哪？" -> "nǐ hǎo, yín háng zài nǎ?" (marks) or
 * "ni3 hao3, yin2 hang2 zai4 na3?" (numbers: plain ASCII, ü as v, neutral tone unnumbered).
 * pinyin-pro picks polyphone readings from the surrounding words (银行 háng, 行走 xíng) and applies
 * 一/不 tone sandhi, i.e. what you'd say aloud. Latin words and numbers pass through.
 */
export function pinyinOf(hanzi: string, tones: PinyinTones = "marks"): string {
  const text = hanzi.replace(PUNCT_RE, (p) => PUNCT[p]).replace(FULL_WIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // One item per Chinese character (with its reading in context), or per run of anything else.
  const items = pinyin(text, { type: "all", toneType: tones === "numbers" ? "num" : "symbol", v: tones === "numbers", nonZh: "consecutive" });
  const toks: string[] = [];
  for (const it of items) {
    // Erhua leaves 儿 empty; numbers mode writes the neutral tone as 0, shown unnumbered. (Only for
    // syllables: "v0" in "版本v0" is a word.) A rare character with no reading is left out rather
    // than put on the pinyin line, which must not need CJK glyphs.
    if (!it.isZh) toks.push(...(it.origin.replace(/\p{Script=Han}/gu, " ").match(TOKEN) ?? []));
    else if (it.pinyin) toks.push(tones === "numbers" ? it.pinyin.replace(/0$/, "") : it.pinyin);
  }
  // Re-space: words apart, punctuation hugging the word before it, brackets/quotes hugging their insides.
  let out = "";
  let glue = true; // no space before the next token (start of line, or after an opening bracket/quote)
  const quotes = new Set<string>(); // quote marks currently open
  for (const tok of toks) {
    const quote = tok === '"' || tok === "'";
    const closing = CLOSE.test(tok) || (quote && quotes.has(tok));
    if (quote) quotes.has(tok) ? quotes.delete(tok) : quotes.add(tok);
    out += (glue || closing ? "" : " ") + tok;
    glue = OPEN.test(tok) || (quote && quotes.has(tok));
  }
  return tones === "numbers" ? out.replace(/…/g, "...") : out;
}

// ---- replies ----

// "zh: …", "zh-CN：…", "**English:** …", "- Chinese: …": a label, then the text.
const LABELED = /^(?:[-*•>]\s*)?[*_`]*([\p{L}]+(?:[-_][\p{L}\p{N}]+)*)[*_`]*\s*[:：]\s*[*_`]*\s*(.*)$/u;
// Labels other than ISO codes the model may use for the Chinese side; "-" = a line to drop (the
// hub makes its own pinyin).
const ZH_LABELS: Record<string, string> = {
  chinese: "zh", mandarin: "zh", 中文: "zh", 汉语: "zh", 漢語: "zh", 普通话: "zh", 國語: "zh", 华语: "zh", 華語: "zh",
  pinyin: "-", 拼音: "-", py: "-",
};

/**
 * Parse the model's reply: one or more "xx: text" lines. One line is the translation (the old
 * format, still used for languages other than Chinese); two are what was said, then the translation.
 * `labels` (label -> ISO code) are the ones this session expects; other "Word: …" lines are text,
 * except an unknown 2-3 letter code on the first line. Without it, any 2-3 letter code is a label.
 */
export function parseReply(reply: string, labels?: Record<string, string>): Translation {
  const parts: { code: string; text: string }[] = [];
  let drop = false; // inside a line to drop (and its wrapped continuation)
  for (const raw of reply.trim().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("```")) continue;
    const m = line.match(LABELED);
    const label = m?.[1].toLowerCase() ?? "";
    const base = label.split(/[-_]/)[0];
    const iso = /^[a-z]{2,3}$/.test(base) ? base : undefined;
    const code = !m ? undefined : labels ? (labels[label] ?? labels[base] ?? (parts.length ? undefined : iso)) : iso;
    if (code === "-") drop = true;
    else if (code !== undefined) {
      drop = false;
      parts.push({ code, text: m![2].trim() });
    } else if (drop) continue;
    else if (parts.length) parts[parts.length - 1].text += (HAN.test(line) ? "" : " ") + line;
    else parts.push({ code: "", text: line });
  }
  // A preamble before the labeled lines ("Here's the translation:") isn't part of the answer.
  const use = parts.some((p) => p.code) ? parts.filter((p) => p.code) : parts;
  const [a, b] = [use[0], use.find((p) => p !== use[0] && p.code !== use[0].code) ?? use[1]];
  if (a && b) return { from: a.code, original: a.text.trim(), to: b.code, text: b.text.trim() };
  return { from: "", to: a?.code ?? "", original: "", text: a?.text.trim() ?? "" };
}

export class Translator {
  private worker: ClaudeWorker;
  /** Chinese is one side: replies carry both sides, and hanzi + pinyin go to the screens. */
  readonly chinese: boolean;
  /** The non-Chinese side's ISO 639-1 code (Chinese sessions). */
  private other: string;
  /** Line labels a reply may use, for parseReply. */
  readonly labels: Record<string, string>;

  constructor(public mine: Side, public theirs: Side) {
    this.chinese = lang2(theirs.code) === "zh" || lang2(mine.code) === "zh";
    const other = lang2(theirs.code) === "zh" ? mine : theirs;
    const zh = other === mine ? theirs : mine;
    this.other = lang2(other.code);
    this.labels = { ...(this.chinese && ZH_LABELS), ...(this.other === "en" && this.chinese && { 英文: "en", 英语: "en", 英語: "en" }) };
    for (const s of [mine, theirs]) this.labels[lang2(s.code)] = this.labels[s.name.toLowerCase()] = lang2(s.code);
    // zh-TW / zh-HK / zh-Hant get traditional characters (pinyin-pro's polyphone words are mostly
    // simplified, so their pinyin is a little less reliable).
    const script = /-(tw|hk|mo|hant)\b/i.test(zh.code) ? "traditional" : "simplified";
    const o = this.other;
    const examples =
      o === "en"
        ? `\nExamples. Heard "你好请问火车站在哪":\nzh: 你好，请问火车站在哪？\nen: Hello, where is the train station?\n` +
          `Heard "how much is this one":\nen: How much is this one?\nzh: 这个多少钱？`
        : "";
    this.worker = new ClaudeWorker({
      name: "translate",
      system: this.chinese
        ? `You are a live interpreter between Chinese (Mandarin) and ${other.name}. Each message is one sentence
heard by a microphone. Speech recognition is set to ${theirs.name}, so expect small errors, wrong
homophones and missing punctuation, and ${mine.name} speech may come through garbled or as sound-alike
words; recover what was meant. Reply with exactly two lines and nothing else, the language that was
spoken FIRST:
zh: the sentence in Chinese: what was said with recognition errors fixed and punctuation added, or its natural spoken Chinese translation.
${o}: the sentence in ${other.name}: what was said with errors fixed, or its translation.
Use ${script} characters. Keep the speaker's words, tone and meaning. No pinyin, notes or quotes.${examples}`
        : `You are a live interpreter. Each message is one sentence heard by a microphone (speech
recognition, so expect small errors and missing punctuation). If it is in ${theirs.name}, translate it into
${mine.name}. If it is in ${mine.name}, translate it into ${theirs.name}. Keep the speaker's tone and meaning; fix
obvious recognition errors silently. Reply with ONLY the translation, prefixed with the target
language's ISO 639-1 code and a colon, e.g. "en: Where is the station?". Nothing else.`,
      model: process.env.TRANSLATE_MODEL || undefined,
      effort: "low",
      maxTurns: 40,
    });
  }

  async translate(heard: string, tones: PinyinTones = "marks"): Promise<Translation> {
    return this.complete(parseReply(await this.worker.ask(heard), this.labels), heard, tones);
  }

  /** Fill in the Chinese fields, and the side a one-line reply left out (from what was heard). */
  complete(r: Translation, heard: string, tones: PinyinTones): Translation {
    if (!this.chinese) return r;
    if (!r.to) r.to = HAN.test(r.text) ? "zh" : this.other;
    if (!r.from || r.from === r.to) r.from = r.to === "zh" ? this.other : "zh";
    if (!r.original) r.original = heard;
    const hanzi = r.from === "zh" ? r.original : r.to === "zh" ? r.text : "";
    if (HAN.test(hanzi)) {
      r.hanzi = hanzi;
      r.pinyin = pinyinOf(hanzi, tones);
    }
    return r;
  }

  close() {
    this.worker.close();
  }
}
