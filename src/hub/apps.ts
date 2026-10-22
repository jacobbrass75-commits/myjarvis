import { readFile } from "node:fs/promises";
import type { AppAction, AppDef } from "../shared/protocol.js";

// Your own apps are declared in apps.json; each action becomes a tool the voice router can call.

export async function loadApps(path: string): Promise<AppDef[]> {
  try {
    const apps = JSON.parse(await readFile(path, "utf8")) as AppDef[];
    // Allow "${ENV_VAR}" in header values so secrets stay in .env.
    for (const a of apps)
      for (const [k, v] of Object.entries(a.headers ?? {}))
        a.headers![k] = v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? "");
    return apps;
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw new Error(`Could not read ${path}: ${e.message}`);
  }
}

export async function callApp(app: AppDef, action: AppAction, params: Record<string, unknown>): Promise<string> {
  const method = action.method ?? "POST";
  // Path params: /notes/{id} takes params.id.
  let path = action.path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k];
    delete params[k];
    return encodeURIComponent(String(v ?? ""));
  });
  const url = new URL(path, app.baseUrl.endsWith("/") ? app.baseUrl : app.baseUrl + "/");
  const init: RequestInit = { method, headers: { ...app.headers }, signal: AbortSignal.timeout(30_000) };
  if (method === "GET" || method === "DELETE") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  } else {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(params);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  return `${res.status} ${res.statusText}\n${text.slice(0, 4000)}`;
}
