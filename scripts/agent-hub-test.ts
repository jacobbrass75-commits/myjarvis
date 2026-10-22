import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hub } from "../src/hub/hub.js";
import { loadProjects, projectDirectory } from "../src/node/projects.js";

test("project catalog canonicalizes folders, ignores missing projects and removes duplicates", () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-projects-"));
  try {
    const project = join(root, "project"); mkdirSync(project);
    const catalog = join(root, "projects.json");
    writeFileSync(catalog, JSON.stringify([{ name: "My project", path: project }, { name: "duplicate", path: project }, { name: "missing", path: join(root, "missing") }]));
    const projects = loadProjects(project, catalog);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].path, projectDirectory(project, root));
    assert.throws(() => projectDirectory("relative/folder", root));
    assert.throws(() => projectDirectory(catalog, root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unready engines and disconnected devices cannot create phantom tasks", () => {
  const hub = new Hub([]);
  hub.nodes.set("main", { id: "main", name: "Main computer", defaultCwd: "/tmp", online: true, engines: ["codex"], engineIssues: { claude: "Sign in to Claude Code on this computer." } });
  assert.match(hub.startAgent("main", "Task", undefined, undefined, "claude") as string, /Sign in/);
  assert.match(hub.startAgent("main", "Task", undefined, undefined, "codex") as string, /not connected/);
  assert.equal(hub.agents.size, 0);
});

test("a running device can advertise a new login or project without reconnecting", () => {
  const hub = new Hub([]);
  hub.nodes.set("main", { id: "main", name: "Main computer", defaultCwd: "/default", online: true, engines: [], projects: [] });
  hub.updateNodeCapabilities("main", { engines: ["claude", "codex"], projects: [{ name: "New project", path: "/new-project" }], engineIssues: {} });
  assert.deepEqual(hub.nodes.get("main")?.engines, ["claude", "codex"]);
  assert.equal(hub.nodes.get("main")?.projects?.[0].path, "/new-project");
  assert.equal(hub.nodes.get("main")?.online, true);
});

test("a project task reaches its selected engine and computer; disconnect marks both engines offline", () => {
  const hub = new Hub([]);
  hub.nodes.set("main", { id: "main", name: "Main computer", defaultCwd: "/default", online: true, engines: ["claude", "codex"] });
  const sent: any[] = [];
  hub.clients.add({ role: "node", nodeId: "main", ws: { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) } as any });
  const claude = hub.startAgent("main", "Check project", "/my-project", "Review", "claude");
  const codex = hub.startAgent("main", "Check project", "/my-project", "Review", "codex");
  assert.equal(typeof claude, "object"); assert.equal(typeof codex, "object");
  assert.deepEqual(sent.map(({ engine, cwd }) => ({ engine, cwd })), [{ engine: "claude", cwd: "/my-project" }, { engine: "codex", cwd: "/my-project" }]);
  hub.dropNode("main");
  assert.ok([...hub.agents.values()].every((a) => a.status === "error"));
});
