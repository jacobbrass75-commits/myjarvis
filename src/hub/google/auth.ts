import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Your own Google account, for Calendar and Gmail. OAuth for an installed app: a "Desktop app" client,
// the loopback redirect (http://127.0.0.1:<random port>) and PKCE. The refresh token lives in
// ~/.g2-orchestrator/google-token.json (mode 600); nothing here ever logs a token or a code.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
export const DEFAULT_TOKEN_FILE = join(homedir(), ".g2-orchestrator", "google-token.json");

/** A Google problem worth saying out loud as is ("not connected", "access revoked", "HTTP 403 ..."). */
export class GoogleError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export const NOT_CONFIGURED =
  "Google isn't set up: add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to .env (docs/PLAYBOOK.md, Google account).";
export const NOT_CONNECTED = "Google isn't connected: run npm run google:connect on the Mac, or Connect on the phone page.";
const EXPIRED =
  "Google sign-in expired or was revoked (apps in Testing expire after 7 days): run npm run google:connect again.";

interface TokenFile {
  refresh_token: string;
  scope?: string;
  email?: string;
  connected_at?: number;
}

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email?: string;
  /** The last refresh failed (expired / revoked); reconnecting fixes it. */
  error?: string;
}

export interface AuthOptions {
  clientId?: string;
  clientSecret?: string;
  tokenFile?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export class GoogleAuth {
  readonly clientId: string;
  private clientSecret: string;
  readonly tokenFile: string;
  private fetchFn: typeof fetch;
  private access: { token: string; exp: number; refresh: string } | null = null;
  private refreshing: Promise<string> | null = null;
  private lastError: string | undefined;
  private flow: { server: Server; timer: NodeJS.Timeout } | null = null;

  constructor(opts: AuthOptions = {}) {
    this.clientId = (opts.clientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
    this.clientSecret = (opts.clientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
    this.tokenFile = opts.tokenFile ?? process.env.G2_GOOGLE_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
    this.fetchFn = opts.fetch ?? fetch;
  }

  get configured() {
    return !!(this.clientId && this.clientSecret);
  }

  /** Read fresh each time: `npm run google:connect` may have written it while the hub runs. */
  private stored(): TokenFile | null {
    try {
      const t = JSON.parse(readFileSync(this.tokenFile, "utf8")) as TokenFile;
      return t?.refresh_token ? t : null;
    } catch {
      return null;
    }
  }

  private save(t: TokenFile) {
    mkdirSync(dirname(this.tokenFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.tokenFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.tokenFile);
  }

  status(): GoogleStatus {
    const t = this.stored();
    return { configured: this.configured, connected: !!t, email: t?.email, error: t ? this.lastError : undefined };
  }

  /** A valid access token, refreshing it when it is within a minute of expiring. */
  async accessToken(): Promise<string> {
    if (!this.configured) throw new GoogleError(NOT_CONFIGURED);
    const t = this.stored();
    if (!t) throw new GoogleError(NOT_CONNECTED);
    if (this.access && this.access.refresh === t.refresh_token && this.access.exp > Date.now() + 60_000) return this.access.token;
    this.refreshing ??= this.refresh(t).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(t: TokenFile): Promise<string> {
    const r = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: this.clientId, client_secret: this.clientSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      this.access = null;
      if (j.error === "invalid_grant") {
        this.lastError = EXPIRED;
        throw new GoogleError(EXPIRED, r.status);
      }
      if (j.error === "invalid_client") throw new GoogleError("Google rejected the OAuth client: check GOOGLE_OAUTH_CLIENT_ID/SECRET in .env.", r.status);
      throw new GoogleError(`Google token refresh failed (HTTP ${r.status}${j.error ? `, ${j.error}` : ""}).`, r.status);
    }
    this.lastError = undefined;
    // Google may rotate the refresh token; keep whichever is current.
    const refresh = j.refresh_token || t.refresh_token;
    if (j.refresh_token && j.refresh_token !== t.refresh_token) this.save({ ...t, refresh_token: j.refresh_token });
    this.access = { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000, refresh };
    return j.access_token;
  }

  /** An authorized JSON call to a Google REST endpoint. Retries once on 401 with a fresh token. */
  async request<T = any>(url: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | string[] | undefined> } = {}): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(init.query ?? {}))
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
      else if (v !== undefined) u.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const r = await this.fetchFn(u, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 401 && attempt === 0) {
        this.access = null;
        continue;
      }
      if (r.status === 204) return undefined as T;
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Google's own message is short and says what's wrong (API not enabled, scope missing, ...);
        // it never contains message bodies.
        const msg = String(j?.error?.message ?? j?.error_description ?? j?.error ?? "").slice(0, 200);
        throw new GoogleError(`Google ${u.hostname.split(".")[0]} error ${r.status}${msg ? `: ${msg}` : ""}`, r.status);
      }
      return j as T;
    }
  }

  // ---------- connecting ----------

  /**
   * Start the consent flow: a one-shot loopback server on 127.0.0.1 waits for Google's redirect.
   * Returns the consent URL (open it in a browser on this Mac) and a promise for the account email.
   */
  async beginConnect(timeoutMs = 5 * 60_000): Promise<{ url: string; done: Promise<string> }> {
    if (!this.configured) throw new GoogleError(NOT_CONFIGURED);
    this.cancelConnect();
    const { verifier, challenge } = pkcePair();
    const state = b64url(randomBytes(16));
    let finish!: (email: string) => void, fail!: (e: Error) => void;
    const done = new Promise<string>((res, rej) => ((finish = res), (fail = rej)));
    done.catch(() => {}); // callers may not wait on it
    let redirectUri = "";
    const page = (title: string, text: string) =>
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px -apple-system,sans-serif;margin:40px"><h2>${title}</h2><p>${text}</p></body>`;
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/oauth2callback") return res.writeHead(404).end();
      const reply = (code: number, title: string, text: string) => res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }).end(page(title, text));
      if (u.searchParams.get("state") !== state) return reply(400, "Wrong sign-in attempt", "Start again from the hub.");
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      try {
        if (err || !code) throw new GoogleError(err === "access_denied" ? "Google access was declined." : `Google sign-in failed${err ? `: ${err}` : ""}.`);
        const email = await this.exchange(code, verifier, redirectUri);
        reply(200, "Google connected", `Signed in as ${email.replace(/[<>&"]/g, "")}. You can close this tab.`);
        finish(email);
      } catch (e: any) {
        reply(400, "Google not connected", String(e?.message ?? e).replace(/[<>&"]/g, ""));
        fail(e);
      } finally {
        this.cancelConnect();
      }
    });
    await new Promise<void>((res, rej) => server.once("error", rej).listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as { port: number }).port;
    redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const timer = setTimeout(() => {
      fail(new GoogleError("Google sign-in timed out; start it again."));
      this.cancelConnect();
    }, timeoutMs);
    timer.unref?.();
    this.flow = { server, timer };
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent", // always hand out a refresh token, also on a reconnect
    }).toString();
    return { url: url.toString(), done };
  }

  cancelConnect() {
    if (!this.flow) return;
    clearTimeout(this.flow.timer);
    this.flow.server.close();
    this.flow.server.closeAllConnections?.();
    this.flow = null;
  }

  get connecting() {
    return !!this.flow;
  }

  /** Code -> tokens; stores the refresh token and returns the account's address. */
  async exchange(code: string, verifier: string, redirectUri: string): Promise<string> {
    const r = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: this.clientId, client_secret: this.clientSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new GoogleError(`Google sign-in failed (HTTP ${r.status}${j.error ? `, ${j.error}` : ""}).`, r.status);
    const refresh = j.refresh_token || this.stored()?.refresh_token;
    if (!refresh) throw new GoogleError("Google sent no refresh token: remove the app's access at myaccount.google.com/permissions and connect again.");
    const missing = GOOGLE_SCOPES.filter((s) => j.scope && !String(j.scope).split(" ").includes(s));
    this.access = { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000, refresh };
    let email = "";
    try {
      const p: any = await this.fetchFn(PROFILE_URL, { headers: { Authorization: `Bearer ${j.access_token}` }, signal: AbortSignal.timeout(10_000) }).then((x) => x.json());
      email = String(p?.emailAddress ?? "");
    } catch {}
    this.save({ refresh_token: refresh, scope: j.scope, email: email || undefined, connected_at: Date.now() });
    this.lastError = missing.length ? `Some permissions were not granted (${missing.map((s) => s.split("/").pop()).join(", ")}); reconnect and tick every box.` : undefined;
    return email || "your Google account";
  }

  /** Revoke the grant at Google and delete the local token file. */
  async disconnect(): Promise<void> {
    const t = this.stored();
    this.access = null;
    this.lastError = undefined;
    if (t) {
      try {
        await this.fetchFn(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: t.refresh_token }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {} // the local token goes either way
    }
    rmSync(this.tokenFile, { force: true });
  }
}
