import assert from "node:assert/strict";
import test from "node:test";
import { COLS, textWidth, wrap, wrapWide } from "../glasses/src/core.ts";
import { block, translate, translateTo } from "../glasses/src/modes/translate.ts";
import { Translator, defaultTranslateOptions, mergeTranslateOptions, parseReply, pinyinOf } from "../src/hub/translate.ts";

// Chinese in live translation: pinyin formatting, translator reply parsing and the lens layout.
// No hub, model or glasses are used (the Translator's Claude session only starts on its first ask).

test("pinyin: tone marks or numbers, polyphones from context", () => {
  assert.equal(pinyinOf("你好"), "nǐ hǎo");
  assert.equal(pinyinOf("你好", "numbers"), "ni3 hao3");
  assert.equal(pinyinOf("银行"), "yín háng");
  assert.equal(pinyinOf("银行", "numbers"), "yin2 hang2");
  assert.equal(pinyinOf("行走"), "xíng zǒu");
  assert.equal(pinyinOf("重庆"), "chóng qìng");
  // ü stays ü with marks, becomes v as plain ASCII; the neutral tone has no number.
  assert.equal(pinyinOf("绿色"), "lǜ sè");
  assert.equal(pinyinOf("绿色", "numbers"), "lv4 se4");
  assert.equal(pinyinOf("妈妈", "numbers"), "ma1 ma");
  // Erhua merges into the syllable before it; 女儿 keeps a full ér.
  assert.equal(pinyinOf("你在哪儿？"), "nǐ zài nǎr?");
  assert.equal(pinyinOf("好玩儿", "numbers"), "hao3 wanr2");
  assert.equal(pinyinOf("女儿"), "nǚ ér");
  assert.match(pinyinOf("女儿，绿色……", "numbers"), /^[\x20-\x7e]+$/);
});

test("pinyin: punctuation, quotes, Latin words and numbers read like a sentence", () => {
  assert.equal(pinyinOf("你好，请问火车站在哪里？"), "nǐ hǎo, qǐng wèn huǒ chē zhàn zài nǎ lǐ?");
  assert.equal(pinyinOf("他说：“你好！”我们走吧。"), 'tā shuō: "nǐ hǎo!" wǒ men zǒu ba.');
  assert.equal(pinyinOf("女儿喜欢绿色（真的）。"), "nǚ ér xǐ huan lǜ sè (zhēn de).");
  assert.equal(pinyinOf("我想买iPhone手机"), "wǒ xiǎng mǎi iPhone shǒu jī");
  assert.equal(pinyinOf("现在是3:30，好吗？"), "xiàn zài shì 3:30, hǎo ma?");
});

test("pinyin: hyphens/emails stay whole, full-width forms, 0 only stripped from syllables", () => {
  assert.equal(pinyinOf("我在Wi-Fi下"), "wǒ zài Wi-Fi xià");
  assert.equal(pinyinOf("COVID-19疫情", "numbers"), "COVID-19 yi4 qing2");
  assert.equal(pinyinOf("我的email是a@b.com"), "wǒ de email shì a@b.com");
  assert.equal(pinyinOf("价格是￥100"), "jià gé shì ¥100");
  assert.equal(pinyinOf("ＯＫ１２３％，好的", "numbers"), "OK123%, hao3 de");
  assert.equal(pinyinOf("版本v0好", "numbers"), "ban3 ben3 v0 hao3");
  assert.equal(pinyinOf("妈妈", "numbers"), "ma1 ma");
  // A character with no reading stays off the pinyin line (it must not need CJK glyphs).
  assert.equal(pinyinOf("𠮷野家"), "yě jiā");
});

test("translator replies: odd formats from the model", () => {
  const zh = new Translator({ code: "en", name: "English" }, { code: "zh-CN", name: "Chinese" });
  const p = (s) => parseReply(s, zh.labels);
  const both = { from: "zh", original: "你好", to: "en", text: "Hello" };
  for (const s of ["**zh:** 你好\n**en:** Hello", "Chinese: 你好\nEnglish: Hello", "中文：你好\n英文：Hello", "zh: 你好\npinyin: nǐ hǎo\nen: Hello",
    "Here is the translation:\nzh: 你好\nen: Hello", "```\nzh: 你好\nen: Hello\n```", "- zh: 你好\n- en: Hello"]) assert.deepEqual(p(s), both, s);
  // "Word:" inside the text is text, not a new language.
  assert.deepEqual(p("en: The menu has three options:\nOne: soup\nzh: 三个选项：汤"), { from: "en", original: "The menu has three options: One: soup", to: "zh", text: "三个选项：汤" });
  const es = new Translator({ code: "en", name: "English" }, { code: "es-ES", name: "Spanish" });
  assert.deepEqual(parseReply("en: Where is it?\nNote: informal", es.labels), { from: "", to: "en", original: "", text: "Where is it? Note: informal" });
  zh.close();
  es.close();
});

test("translator replies: one line (other languages) or both sides (Chinese)", () => {
  assert.deepEqual(parseReply("en: Where is the station?"), { from: "", to: "en", original: "", text: "Where is the station?" });
  assert.deepEqual(parseReply("Where is the station?"), { from: "", to: "", original: "", text: "Where is the station?" });
  assert.deepEqual(parseReply("zh: 火车站在哪？\nen: Where is the train station?"), {
    from: "zh", original: "火车站在哪？", to: "en", text: "Where is the train station?",
  });
  assert.deepEqual(parseReply("  EN: How much is this?\n\nzh-CN：这个多少钱？ "), {
    from: "en", original: "How much is this?", to: "zh", text: "这个多少钱？",
  });
  // A wrapped line belongs to the line above (no space inside Chinese).
  assert.equal(parseReply("en: It is far.\nzh: 很远，\n要坐车。").text, "很远，要坐车。");
});

test("Chinese sessions carry hanzi + pinyin either way; others are unchanged", () => {
  const zh = new Translator({ code: "en", name: "English" }, { code: "zh-CN", name: "Chinese" });
  assert.equal(zh.chinese, true);
  // They spoke Chinese.
  let r = zh.complete(parseReply("zh: 银行在哪儿？\nen: Where is the bank?"), "银行在哪儿", "marks");
  assert.deepEqual([r.from, r.to, r.hanzi, r.pinyin, r.text], ["zh", "en", "银行在哪儿？", "yín háng zài nǎr?", "Where is the bank?"]);
  // You spoke English: the Chinese to read out, with numbered pinyin.
  r = zh.complete(parseReply("en: Thank you very much.\nzh: 非常感谢。"), "thank you very much", "numbers");
  assert.deepEqual([r.from, r.to, r.original, r.hanzi, r.pinyin], ["en", "zh", "Thank you very much.", "非常感谢。", "fei1 chang2 gan3 xie4."]);
  // A one-line reply still gets both sides, from what was heard.
  r = zh.complete(parseReply("en: Hello"), "你好", "marks");
  assert.deepEqual([r.from, r.original, r.hanzi, r.pinyin], ["zh", "你好", "你好", "nǐ hǎo"]);
  r = zh.complete(parseReply("你好"), "hello", "marks");
  assert.deepEqual([r.from, r.to, r.original, r.hanzi], ["en", "zh", "hello", "你好"]);
  zh.close();

  const es = new Translator({ code: "en", name: "English" }, { code: "es-ES", name: "Spanish" });
  assert.equal(es.chinese, false);
  r = es.complete(parseReply("en: Where is the station?"), "dónde está la estación", "marks");
  assert.deepEqual(r, { from: "", to: "en", original: "", text: "Where is the station?" });
  es.close();
});

test("options: env defaults, validated per-session changes", () => {
  assert.deepEqual(defaultTranslateOptions({}), { pinyin: "marks", glassesHanzi: true });
  assert.deepEqual(defaultTranslateOptions({ TRANSLATE_PINYIN_TONES: "numbers", TRANSLATE_GLASSES_HANZI: "0" }), { pinyin: "numbers", glassesHanzi: false });
  const cur = { pinyin: "marks", glassesHanzi: true };
  assert.deepEqual(mergeTranslateOptions(cur, { glassesHanzi: false }), { pinyin: "marks", glassesHanzi: false });
  assert.deepEqual(mergeTranslateOptions(cur, { pinyin: "bogus", glassesHanzi: "no" }), cur);
  assert.deepEqual(mergeTranslateOptions(cur, undefined), cur);
});

test("width-aware wrap: CJK counts double, Latin wraps exactly like wrap()", () => {
  assert.equal(textWidth("你好"), 4);
  assert.equal(textWidth("nǐ hǎo"), 6);
  assert.equal(textWidth("ＡＢ，"), 6);
  const latin = [
    "Hello, where is the train station? I need to get to the airport before six tonight.",
    "a b  c\n\nsupercalifragilisticexpialidocious-and-then-some-more-words-without-spaces end",
    "",
  ];
  for (const s of latin) for (const cols of [10, 20, COLS]) assert.deepEqual(wrapWide(s, cols), wrap(s, cols), `${cols}: ${s}`);

  const zh = "你好，请问火车站在哪里？我想去北京，坐高铁要多长时间？";
  const rows = wrapWide(zh, 20);
  assert.deepEqual(rows, ["你好，请问火车站在哪", "里？我想去北京，坐高", "铁要多长时间？"]);
  assert.equal(rows.join(""), zh);
  for (const cols of [7, 11, 20, COLS]) for (const r of wrapWide(zh, cols)) {
    assert.ok(textWidth(r) <= cols, `${cols}: ${r}`);
    assert.doesNotMatch(r, /^[，。？！]/);
  }
  // Latin inside Chinese stays whole and glued (no space added).
  assert.deepEqual(wrapWide("我想买一部iPhone手机，多少钱？", 12), ["我想买一部", "iPhone手机，", "多少钱？"]);
  assert.deepEqual(wrapWide("我想买 iPhone 手机", COLS), ["我想买 iPhone 手机"]);
});

test("lens layout: hanzi, pinyin, meaning; hanzi can be hidden; tall sentences fit", () => {
  const them = { source: "你好请问火车站在哪", text: "Hello, where is the train station?", from: "zh", to: "en", original: "你好，请问火车站在哪？", hanzi: "你好，请问火车站在哪？", pinyin: "nǐ hǎo, qǐng wèn huǒ chē zhàn zài nǎ?" };
  assert.deepEqual(block(them), ["» 你好，请问火车站在哪？", "  nǐ hǎo, qǐng wèn huǒ chē zhàn zài nǎ?", "  Hello, where is the train station?"]);
  assert.deepEqual(block(them, 7, { pinyin: "marks", glassesHanzi: false }), ["» nǐ hǎo, qǐng wèn huǒ chē zhàn zài nǎ?", "  Hello, where is the train station?"]);
  // Your English, shown with the Chinese to read out.
  const me = { source: "how much is this", text: "这个多少钱？", from: "en", to: "zh", original: "How much is this?", hanzi: "这个多少钱？", pinyin: "zhè ge duō shǎo qián?" };
  assert.deepEqual(block(me), ["« 这个多少钱？", "  zhè ge duō shǎo qián?", "  How much is this?"]);

  const hanzi = "我们明天早上八点在火车站门口见面，然后一起坐高铁去上海，晚上再回来吃饭好不好？";
  const long = { ...them, hanzi, original: hanzi, pinyin: pinyinOf(hanzi), text: "Let's meet at the station entrance at eight tomorrow morning, take the high-speed train to Shanghai together, and come back for dinner in the evening, OK?" };
  for (const room of [7, 6, 4, 3]) {
    const b = block(long, room);
    assert.ok(b.length <= room, `room ${room}: ${b.length} rows`);
    assert.ok(b.every((r) => textWidth(r) <= COLS), b.join("\n"));
    assert.match(b[0], /^» 我们/);
    assert.match(b[b.length - 1], /^ {2}\S/);
  }
  assert.ok(block(long, 7).some((r) => r.endsWith("…")));

  // Other languages keep the old two-part layout.
  assert.deepEqual(block({ source: "dónde está la estación", text: "Where is the station?", from: "", to: "en" }), ["» Where is the station?", "   dónde está la estación"]);

  // Odd replies with hanzi off: no CJK glyphs anywhere, and no Chinese passed off as the meaning.
  const off = { pinyin: "marks", glassesHanzi: false };
  assert.deepEqual(block({ source: "你好吗", text: "How are you?", from: "zh", to: "en" }, 7, off), ["» How are you?"]);
  assert.deepEqual(block({ source: "你好吗", text: "你好吗？", from: "en", to: "zh", original: "你好吗", hanzi: "你好吗？", pinyin: "nǐ hǎo ma?" }, 7, off), ["« nǐ hǎo ma?"]);
});

test("lens screen: newest sentence whole, older Chinese ones only whole, swipe scrolls back", () => {
  translateTo("zh-CN"); // no hub or bridge here: just selects the language
  const msg = (r) => translate.onHub({ t: "translation", at: Date.now(), ...r });
  msg({ source: "你好请问火车站在哪", text: "Hello, where is the train station?", from: "zh", to: "en", original: "你好，请问火车站在哪？", hanzi: "你好，请问火车站在哪？", pinyin: pinyinOf("你好，请问火车站在哪？") });
  msg({ source: "how far is it", text: "有多远？", from: "en", to: "zh", original: "How far is it?", hanzi: "有多远？", pinyin: pinyinOf("有多远？") });
  let rows = translate.screen().body.split("\n");
  assert.deepEqual(rows, [
    "» 你好，请问火车站在哪？", "  nǐ hǎo, qǐng wèn huǒ chē zhàn zài nǎ?", "  Hello, where is the train station?",
    "« 有多远？", "  yǒu duō yuǎn?", "  How far is it?",
  ]);
  const long = "不远，走路十分钟就到了。你可以先去银行，然后左转。";
  msg({ source: long, text: "Not far, it's a ten-minute walk. You can go to the bank first, then turn left.", from: "zh", to: "en", original: long, hanzi: long, pinyin: pinyinOf(long) });
  rows = translate.screen().body.split("\n");
  assert.equal(rows.length, 6);
  assert.match(rows[0], /^» 不远/); // the 3-row sentence above didn't fit whole, so it's left out
  assert.match(rows[5], /turn left\.$/);
  translate.gesture("up", 0);
  assert.match(translate.screen().body, /^» 你好[\s\S]*How far is it\?$/);
  translate.gesture("down", 0);
  // Hanzi off: pinyin leads, and a Chinese partial isn't drawn as glyphs.
  translate.onHub({ t: "translate_options", options: { pinyin: "marks", glassesHanzi: false } });
  translate.onHub({ t: "transcript", line: { text: "那里有", at: Date.now(), final: false } });
  rows = translate.screen().body.split("\n");
  assert.match(rows[rows.length - 1], /^…$/);
  assert.ok(rows.every((r) => !/\p{Script=Han}/u.test(r)), rows.join("\n"));
  translate.exit();
});
