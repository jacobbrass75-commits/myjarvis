// Live check of the Soniox engine against the real API: synthesizes speech with `say` (English, and
// Mandarin with a Chinese voice), converts it with `afconvert` to 16 kHz s16le mono, streams it in
// 100 ms chunks through createStreamingSTT and prints partials/finals with timing.
//
//   node --env-file-if-exists=.env --import tsx scripts/stt-live-test.mjs          # needs SONIOX_API_KEY
//   node --env-file-if-exists=.env --import tsx scripts/stt-live-test.mjs --fast   # don't pace in real time
//   node --import tsx scripts/stt-live-test.mjs --bad-key   # no key needed: a rejected key must hand over to the local engine
//
// Billing: a full run streams about 40 s of audio (well under a cent).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SR = 16000;
const args = process.argv.slice(2);
const fast = args.includes("--fast");
const badKey = args.includes("--bad-key");

if (badKey) process.env.SONIOX_API_KEY = "invalid-key-for-the-live-test";
else if (!process.env.SONIOX_API_KEY?.trim()) {
  console.log("SONIOX_API_KEY is not set: skipping the live test (add it to .env; get one at https://console.soniox.com).");
  console.log("Without a key you can still run --bad-key to check the auth-failure fallback against the real server.");
  process.exit(0);
}
delete process.env.STT_ENGINE;
delete process.env.STT_PROVIDER;

const { createStreamingSTT, stopWhisperServer } = await import("../src/stt/index.ts");
const { SonioxStream, clearSonioxBench } = await import("../src/stt/soniox.ts");
const { transcribe } = await import("../src/hub/stt.ts");

const voices = execFileSync("say", ["-v", "?"], { encoding: "utf8" });
const hasVoice = (v) => new RegExp(`^${v}\\s`, "m").test(voices);
const enVoice = ["Samantha", "Alex", "Fred"].find(hasVoice);
const zhVoice = ["Tingting", "Meijia"].find(hasVoice);

function synth(text, voice) {
  const dir = mkdtempSync(join(tmpdir(), "g2-stt-live-"));
  try {
    const aiff = join(dir, "s.aiff");
    const wav = join(dir, "s.wav");
    execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", aiff, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${SR}`, "-c", "1", aiff, wav]);
    const b = readFileSync(wav);
    for (let off = 12; off < b.length - 8; ) {
      const id = b.toString("ascii", off, off + 4);
      const len = b.readUInt32LE(off + 4);
      if (id === "data") return b.subarray(off + 8, off + 8 + len);
      off += 8 + len + (len & 1);
    }
    throw new Error("no data chunk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const silence = (sec) => Buffer.alloc(Math.round(sec * SR) * 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ");

const EN = "Please ask Claude to run the tests, and tell me when the build is green.";
const ZH = "你好，请问火车站在哪里？我想买两张去上海的票。";
const enExpect = ["claude", "tests", "build", "green"];
const zhExpect = [["火车站", "火車站"], ["上海"], ["票"]];

/** Stream pcm through createStreamingSTT in 100 ms chunks; print everything with timing. */
async function run(name, pcm, opts, expect) {
  console.log(`\n=== ${name} (${(pcm.length / 2 / SR).toFixed(1)} s, ${opts.lang}${opts.alsoLangs ? ` + ${opts.alsoLangs}` : ""}) ===`);
  const stt = createStreamingSTT(opts);
  const finals = [];
  const fallbacks = [];
  let t0 = Date.now();
  let partials = 0;
  let firstPartial = 0;
  stt.on("ready", (i) => console.log(`  ready ${JSON.stringify(i)}`));
  stt.on("status", (m) => console.log(`  status: ${m}`));
  stt.on("error", (e) => console.log(`  ERROR: ${e.message}`));
  stt.on("fallback", (f) => (fallbacks.push(f), console.log(`  FALLBACK -> ${f.to}: ${f.reason}`)));
  stt.on("partial", (e) => {
    partials++;
    firstPartial ||= Date.now() - t0;
    console.log(`  +${String(Date.now() - t0).padStart(5)}ms partial  ${JSON.stringify(e.text)}`);
  });
  stt.on("final", (e) => {
    const at = Date.now() - t0;
    finals.push({ ...e, at });
    const after = fast ? "" : `, ${((at - e.end * 1000) / 1000).toFixed(2)} s after it`;
    const tags = [e.engine, e.detectedLang, e.speaker && `speaker ${e.speaker}`, e.confidence != null && `conf ${e.confidence}`].filter(Boolean).join(" ");
    console.log(`  +${String(at).padStart(5)}ms FINAL [${tags}] ${JSON.stringify(e.text)} (audio ${e.start.toFixed(2)}-${e.end.toFixed(2)} s${after})`);
  });
  console.log(`  engine: ${await stt.engine}`);
  t0 = Date.now();
  const step = SR * 0.1 * 2;
  for (let off = 0, n = 0; off < pcm.length; off += step, n++) {
    if (!fast) {
      const wait = t0 + n * 100 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    stt.write(pcm.subarray(off, off + step));
  }
  const tEnd = Date.now();
  await stt.close();
  const text = finals.map((f) => f.text).join(" ");
  const got = norm(text);
  const missing = expect.filter((alts) => ![alts].flat().some((w) => got.includes(w)));
  const ok = finals.length > 0 && missing.length === 0;
  console.log(
    `  -> ${ok ? "PASS" : "FAIL"}: ${finals.length} finals, ${partials} partials, first partial +${firstPartial} ms, close took ${Date.now() - tEnd} ms` +
      (missing.length ? `, missing ${JSON.stringify(missing)}` : ""),
  );
  return { ok, finals, fallbacks };
}

const results = [];
const en = synth(EN, enVoice);
const zh = zhVoice ? synth(ZH, zhVoice) : null;
if (!zhVoice) console.log("No Mandarin voice (Tingting/Meijia) installed: skipping the Chinese cases.");

if (badKey) {
  // The real server's answer to a bad key, then the same through "auto": it must fall back.
  const direct = await new Promise((res) => {
    const s = new SonioxStream({ lang: "en-US" });
    s.on("error", (e) => res(e));
    s.on("ready", () => res(null));
  });
  console.log(`direct: ${direct ? `${direct.type} (${direct.code}): ${direct.message}` : "no error?!"}`);
  clearSonioxBench(); // that rejection benched Soniox; let "auto" try it once more
  const r = await run("bad key -> local fallback", Buffer.concat([silence(0.3), en, silence(1)]), { lang: "en-US" }, enExpect);
  results.push(direct?.type === "unauthenticated", r.ok && r.fallbacks.length === 1 && r.finals.every((f) => f.engine !== "soniox"));
} else {
  results.push((await run("english", Buffer.concat([silence(0.5), en, silence(1.5)]), { lang: "en-US", engine: "soniox" }, enExpect)).ok);
  if (zh) {
    results.push((await run("mandarin", Buffer.concat([silence(0.5), zh, silence(1.5)]), { lang: "zh-CN", engine: "soniox" }, zhExpect)).ok);
    // Translate mode: the other person's language + the wearer's English in one stream.
    const mixed = await run("mixed zh + en", Buffer.concat([silence(0.5), zh, silence(0.8), en, silence(1.5)]), { lang: "zh-CN", alsoLangs: ["en"], engine: "soniox" }, [...zhExpect, ...enExpect]);
    const langs = mixed.finals.map((f) => f.detectedLang);
    console.log(`  detected languages per final: ${JSON.stringify(langs)}`);
    results.push(mixed.ok);
  }
  // Push-to-talk batch path (hub/stt.ts): a stream run on the whole clip.
  const t = Date.now();
  const text = await transcribe(Buffer.concat([en, silence(0.3)]), SR);
  const ok = enExpect.every((w) => norm(text).includes(w));
  console.log(`\n=== push-to-talk transcribe() ===\n  ${JSON.stringify(text)} in ${Date.now() - t} ms -> ${ok ? "PASS" : "FAIL"}`);
  results.push(ok);
}

stopWhisperServer();
const allOk = results.every(Boolean);
console.log(allOk ? "\nLIVE TEST PASS" : "\nLIVE TEST FAIL");
process.exit(allOk ? 0 : 1);
