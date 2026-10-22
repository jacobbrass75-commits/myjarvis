import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, basename, join } from "node:path";
import type { ProjectInfo } from "../shared/protocol.js";

/** Resolve a folder on THIS computer. Never silently run a task from the daemon's own cwd. */
export function projectDirectory(input: string, fallback: string): string {
  const value = (input || fallback).trim();
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error("Choose an absolute project folder on this computer.");
  const path = realpathSync(resolve(expanded));
  if (!statSync(path).isDirectory()) throw new Error("The selected project is not a folder.");
  return path;
}

/** Explicit local catalog: no filesystem crawling, copies, uploads, or project relocation. */
export function loadProjects(defaultCwd: string, file = process.env.G2_PROJECTS_FILE || join(homedir(), ".g2-orchestrator", "projects.json")): ProjectInfo[] {
  let entries: unknown = [];
  try {
    const catalog = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
    entries = JSON.parse(readFileSync(catalog, "utf8"));
    if (!Array.isArray(entries)) throw new Error("Expected an array of projects.");
  } catch (e: any) {
    if (e.code !== "ENOENT") console.warn("Project catalog could not be read; using the default project.");
  }
  const projects = new Map<string, ProjectInfo>();
  for (const item of [{ path: defaultCwd }, ...(Array.isArray(entries) ? entries : [])]) {
    if (!item || typeof item !== "object" || typeof item.path !== "string") continue;
    try {
      const path = projectDirectory(item.path, defaultCwd);
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 100) : basename(path);
      projects.set(path, { name, path });
    } catch {
      // A missing disk or a project that moved must not advertise an unusable folder.
    }
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}
