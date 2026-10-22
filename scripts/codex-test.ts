import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgent, codexBin } from "../src/node/codex.js";
import { getEngineReadiness } from "../src/node/engines.js";

const dir = mkdtempSync(join(tmpdir(), "g2-codex-test-"));
const saved = { CODEX_BIN: process.env.CODEX_BIN, PATH: process.env.PATH, CODEX_TEST_LOG: process.env.CODEX_TEST_LOG };
const bin = join(dir, "codex");
const log = join(dir, "calls.jsonl");
const executable = (file: string, code: string) => writeFileSync(file, `#!${process.execPath}\n${code}`, { mode: 0o700 });
const waitFor = async (condition: () => boolean) => {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Timed out waiting for fake Codex");
    await new Promise((r) => setTimeout(r, 10));
  }
};
try {
  executable(bin, `
const fs = require('node:fs');
if (process.argv[2] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
let prompt = '';
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
 fs.appendFileSync(process.env.CODEX_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n');
 const emit = (x, newline = true) => process.stdout.write(JSON.stringify(x) + (newline ? '\\n' : ''));
 emit({type:'thread.started', thread_id:'test-thread'});
 if (prompt === 'fail') { console.error('test resume failure'); process.exitCode=7; return; }
 if (prompt === 'stream-error') { emit({type:'turn.failed',error:{message:'test turn failure'}}); return; }
 if (prompt === 'wait') {
  process.on('SIGINT', () => { emit({type:'item.completed',item:{type:'agent_message',text:'late response'}}); process.exit(0); });
  emit({type:'item.started',item:{type:'command_execution',command:'waiting'}});
  setInterval(() => {},1000); return;
 }
 if (prompt !== 'empty') emit({type:'item.completed',item:{type:'agent_message',text:'answer:'+prompt}}, false);
});
`);
  executable(join(dir, "claude"), `console.log(JSON.stringify({loggedIn:true,email:'private-account',token:'private-credential'}));`);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_TEST_LOG = log;
  process.env.PATH = dir;
  assert.equal(codexBin(), bin);
  const done: string[] = [], errors: string[] = [], texts: string[] = [], activities: string[] = [];
  const on = { text: (s: string) => texts.push(s), activity: (s: string) => activities.push(s), done: (s: string) => done.push(s), error: (s: string) => errors.push(s) };
  const agent = new CodexAgent(dir, false, on);
  agent.send("--prompt is text");
  await waitFor(() => done.length === 1);
  assert.equal(done[0], "answer:--prompt is text", "parses a final event without a newline");
  agent.send("fail");
  await waitFor(() => errors.length === 1);
  agent.send("empty");
  await waitFor(() => done.length === 2);
  assert.equal(done[1], "", "does not reuse the previous turn's last message");
  assert.match(errors[0], /test resume failure/);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls[0].args, ["exec", "--sandbox", "workspace-write", "--json", "--skip-git-repo-check", "--cd", dir, "-"]);
  assert.deepEqual(calls[1].args, ["exec", "--sandbox", "workspace-write", "--json", "--skip-git-repo-check", "resume", "test-thread", "-"]);
  assert.equal(calls[0].prompt, "--prompt is text");
  agent.send("stream-error");
  await waitFor(() => errors.length === 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done.length, 2, "a failed stream does not report success on process close");
  const readiness = await getEngineReadiness();
  assert.deepEqual(readiness.map((r) => [r.engine, r.ready]), [["claude", true], ["codex", true]]);
  assert.doesNotMatch(JSON.stringify(readiness), /private-account|private-credential/, "auth output stays private");
  const stopped = new CodexAgent(dir, false, on);
  stopped.send("wait");
  await waitFor(() => activities.length > 0);
  const before = [done.length, errors.length, texts.length];
  stopped.send("queued");
  stopped.stop();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual([done.length, errors.length, texts.length], before, "late stopped-process events do not overwrite terminal status");
  assert.ok(!readFileSync(log, "utf8").includes('"prompt":"queued"'));
  const broken = join(dir, "broken");
  writeFileSync(broken, "#!/missing-g2-test-interpreter\n", {mode:0o700});
  process.env.CODEX_BIN = broken;
  const bad = new CodexAgent(dir, false, on);
  bad.send("should fail to spawn");
  await waitFor(() => errors.length === 3);
  assert.match(errors[2], /Could not start Codex/);
  console.log("Codex driver checks passed: resume arguments, stdin prompts, fresh turn results, stream failures, private readiness, stop handling, spawn failures.");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
