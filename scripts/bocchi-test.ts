// The Bocchi persona offline: her names (and Jarvis), the avatar's moods, and the lens pages that
// show her (push-to-talk takeover, the Agents reply view) against a fake bridge.
//   node --import tsx --test scripts/bocchi-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripWakeName, toolLabel } from "../src/shared/assistant.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("names: Bocchi, Jarvis and common mishearings address her; other words don't", () => {
  assert.equal(stripWakeName("Hey Bocchi, open my notes"), "open my notes");
  assert.equal(stripWakeName("Jarvis, start translating Spanish"), "start translating Spanish");
  assert.equal(stripWakeName("okay jarvis set a timer for 5 minutes"), "set a timer for 5 minutes");
  assert.equal(stripWakeName("Botchy what's the weather?"), "what's the weather?");
  assert.equal(stripWakeName("Bochi."), "");
  assert.equal(stripWakeName("Jarvis?"), "");
  for (const s of ["boy that was fast", "remind me to call Bob", "Jarvisfoo test", "book a table"]) assert.equal(stripWakeName(s), s);
});

test("toolLabel: short lens labels for tool calls", () => {
  assert.equal(toolLabel("WebSearch"), "web search");
  assert.equal(toolLabel("mcp__hub__start_agent"), "start agent");
  assert.equal(toolLabel("mcp__hub__app_lights_turnOn"), "lights turn on");
});

// Through variables, like ptt-caption-test: the root typecheck doesn't cover the glasses project.
const G = "../glasses/src/";
const PREVIEW = "./lens-preview.mjs";
const { drawBocchi, bocchiRaster, captionMood, talkMs, AVATAR_W, AVATAR_H }: any = await import(G + "ui/bocchi.ts");
const ui: any = await import(G + "ui/caption.ts");
const coreMod: any = await import(G + "core.ts");
const { fakeBridge, settle }: any = await import(PREVIEW);
const { checkLayout }: any = await import(G + "ui/layout.ts");

const draw = (mood: any, frame: number) => {
  const px = new Uint8Array(144 * 72);
  drawBocchi(px, mood, frame);
  return px;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

test("avatar: each mood looks different; talking moves the mouth; idle only changes to blink", () => {
  const moods = ["listening", "thinking", "working", "talking"].map((m) => draw(m, 1));
  for (let i = 0; i < moods.length; i++) for (let j = i + 1; j < moods.length; j++) assert.ok(!same(moods[i], moods[j]), `moods ${i} and ${j} match`);
  // Talking: the mouth changes between frames.
  const talk = new Set(Array.from({ length: 12 }, (_, f) => draw("talking", f * 4).join(",")));
  assert.ok(talk.size >= 2);
  // Idle: few distinct frames over 3.5 s (open eyes, and a blink), so few image pushes.
  const idle = new Set(Array.from({ length: 14 }, (_, f) => draw("idle", f).join(",")));
  assert.ok(idle.size === 2, `idle frames: ${idle.size}`);
  // The tile stays in the lens's image limits and isn't a wall of light.
  const r = bocchiRaster("talking", 0);
  assert.equal(r.w, AVATAR_W);
  assert.equal(r.h, AVATAR_H);
  assert.ok(AVATAR_W <= 288 && AVATAR_H <= 144);
  const lit = r.px.filter((v: number) => v >= 12).length / r.px.length;
  assert.ok(lit < 0.15, `bright pixels ${lit}`);
  assert.ok(talkMs("ok") >= 1500 && talkMs("x".repeat(1000)) <= 8000);
});

test("caption mood: listening, thinking, working on voice_working for this clip, then talking", () => {
  ui.captionStart("ptt", 7);
  assert.equal(captionMood(), "listening");
  ui.onCaptionHub({ t: "caption", text: "what's the news", stable: 15, final: true, source: "ptt", at: Date.now(), clip: 7 });
  ui.captionRelease();
  assert.equal(captionMood(), "thinking");
  ui.onCaptionHub({ t: "voice_working", heard: "something else", tool: "web search" });
  assert.equal(captionMood(), "thinking"); // another utterance's tool
  ui.onCaptionHub({ t: "voice_working", heard: "what's the news", tool: "web search" });
  assert.equal(captionMood(), "working");
  assert.equal(ui.caption.working, "web search");
  assert.ok(ui.captionReply("what's the news", "U-um, the big story today is the launch."));
  assert.equal(captionMood(), "talking");
  ui.caption.repliedAt = Date.now() - 60_000;
  assert.equal(captionMood(), "idle");
  // Without the avatar the reply keeps its name tag; beside her it doesn't.
  assert.match(ui.captionLines(40, 4).done.join(" "), /BOCCHI > U-um/);
  assert.doesNotMatch(ui.captionLines(40, 4, { tag: false }).done.join(" "), /BOCCHI >/);
  ui.captionStop();
});

/** The lens page the fake bridge holds, checked like the iPhone app would. */
function page(b: any) {
  const p = { containerTotalNum: b.page.text.length + b.page.list.length + b.page.image.length, textObject: b.page.text, listObject: b.page.list, imageObject: b.page.image };
  checkLayout(p);
  return p;
}

test("lens: takeover shows her beside your words, the working header, then the reply; notes don't", async () => {
  const { core } = coreMod;
  const b = fakeBridge();
  core.bridge = b;
  core.ws = { readyState: 1, send() {} };
  core.stack = [{ id: "x", title: "", screen: () => ({ header: "", body: "" }), gesture: () => false }];
  core.toast = "";

  ui.captionStart("ptt", 9);
  core.talking = true;
  coreMod.render();
  await settle();
  let p = page(b);
  assert.equal(p.imageObject.length, 1);
  assert.equal(p.imageObject[0].width, AVATAR_W);
  const text = (name: string) => p.textObject.find((t: any) => t.containerName === name)?.content ?? "";
  assert.match(text("box0"), /SPEAK NOW/);

  ui.onCaptionHub({ t: "caption", text: "search the news", stable: 15, final: true, source: "ptt", at: Date.now(), clip: 9 });
  core.talking = false;
  ui.captionRelease();
  ui.onCaptionHub({ t: "voice_working", heard: "search the news", tool: "web search" });
  b.log.length = 0;
  coreMod.render();
  await settle();
  p = page(b);
  assert.equal(text("header"), "BOCCHI  WORKING: WEB SEARCH");
  assert.match(text("box0"), /search the news/);
  assert.ok(!b.log.includes("rebuild"), "same page shape from live to sent");
  assert.ok(b.log.includes("image:tile0"), "the working face went out");

  ui.captionReply("search the news", "U-um, okay. The rocket launch went well.");
  coreMod.render();
  await settle();
  p = page(b);
  assert.equal(text("header"), "BOCCHI   TAP: CLOSE");
  assert.match(text("box0"), /^> search the news\nU-um, okay\./);
  // A long reply fills the box beside her from the top and runs on below her.
  ui.caption.reply = "U-um, okay. The big story today is the rocket launch, and it went well. There is also a storm coming in later tonight, so take an umbrella.";
  coreMod.render();
  await settle();
  p = page(b);
  assert.match(text("box0"), /^U-um, okay\. The big story/);
  assert.match(text("box1"), /umbrella|…/);
  ui.captionStop();

  // A note keeps the full-width text page.
  ui.captionStart("note", 10);
  core.talking = true;
  coreMod.render();
  await settle();
  p = page(b);
  assert.equal(p.imageObject.length, 0);
  core.talking = false;
  ui.captionStop();
  await settle();
  core.bridge = null;
  core.ws = null;
});

test("lens: the Agents reply view puts her beside the paged reply, named Bocchi", async () => {
  const { core } = coreMod;
  const { agents }: any = await import(G + "modes/agents.ts");
  const b = fakeBridge();
  core.bridge = b;
  core.ws = { readyState: 1, send() {} };
  core.state = { agents: [], approvals: [], nodes: [], apps: [], voice: { listening: false, lastHeard: "", lastReply: "" } };
  core.stack = [agents];
  agents.onHub({ t: "voice_reply", heard: "Jarvis, what's on today?", reply: "U-um, you have standup at three and the gym at five thirty. ".repeat(4) });
  coreMod.render();
  await settle();
  const p = page(b);
  assert.equal(p.imageObject.length, 1);
  const header = p.textObject.find((t: any) => t.containerName === "header")!.content;
  assert.match(header, /^Bocchi  1\/\d$/);
  const body = p.textObject.find((t: any) => t.containerName === "body")!;
  assert.ok(body.xPosition! >= p.imageObject[0].xPosition! + p.imageObject[0].width!);
  assert.match(body.content!, /Jarvis, what's on today/);
  agents.gesture("down", 0);
  coreMod.render();
  await settle();
  assert.match(b.page.text.find((t: any) => t.containerName === "header").content, /^Bocchi  2\//);
  agents.gesture("tap", 0); // back to the list: she's gone and the redraw ticker winds down
  coreMod.render();
  await settle();
  assert.equal(b.page.image.length, 0);
  const shown = b.log.length;
  await tick(300);
  assert.equal(b.log.length, shown, "no more redraws once she's gone");
  await tick(300);
  core.bridge = null;
  core.ws = null;
});
