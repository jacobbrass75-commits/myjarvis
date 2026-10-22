// Where mini-apps run: never in the glasses page itself, which holds the hub token and the hub
// WebSocket (an app there could start a coding agent on the Mac). In a browser each app gets its own
// Web Worker: no DOM, no page globals, and its network, storage and messaging APIs removed before
// the app's code runs. Headless in Node (the native/ Mac runner) it's a child process under Node's
// permission model: no files (so not .env), no child processes, an env with nothing but PATH.
// Either way the app's source arrives as text (the page fetched it with the token) and the only way
// out is the message channel below, which modes/apps.ts checks against the MiniAppApi contract.
//
// Messages, page → app: load {source, store} · input {seq, g, index} · answer {reqId, value|error} · exit
// app → page: ready {title, kind, hasInput} · screen {screen} · frame {px, header} · input {seq, handled}
//   · store {key, value} · ask {reqId, prompt} · fetch {reqId, url} · toast {text} · exit · error {error} · exited

// The runtime, shared by both: plain old JavaScript (it isn't compiled), called with the sandbox's
// own post/listen/load/onFatal. It captures what it needs before the app's code can touch anything.
const RUNTIME = String.raw`(function (post, listen, load, onFatal) {
  "use strict";
  var W = 144, H = 72;
  var setI = setInterval, clearI = clearInterval, setT = setTimeout, stringify = JSON.stringify, isArray = Array.isArray;
  var now = typeof performance !== "undefined" && performance.now ? performance.now.bind(performance) : Date.now;
  var app = null, kind = "text", dead = false, timer = 0, last = 0, lastText = "", appUrl = "", refreshing = false;
  var saved = Object.create(null), calls = new Map(), nextCall = 1, early = [];

  function describe(e) {
    var s;
    try {
      s = e && typeof e === "object" && "stack" in e ? String(e.message) + "\n" + String(e.stack) : String(e);
    } catch (x) {
      s = "the app threw something that can't be shown";
    }
    if (appUrl) s = s.split(appUrl).join("app.js"); // blob:/data: URLs mean nothing to Studio
    return s.slice(0, 1500);
  }
  function fail(e) {
    if (dead) return;
    dead = true;
    clearI(timer);
    post({ t: "error", error: describe(e) });
  }
  /** Call into the app; a throw ends it. */
  function call(fn) {
    if (dead) return undefined;
    try {
      return fn();
    } catch (e) {
      fail(e);
      return undefined;
    }
  }
  // A throw in the app's own callbacks (say, after api.ask resolves): its stack names the app's file.
  onFatal(function (e) {
    var s = "";
    try { s = e instanceof Error ? String(e.stack) : ""; } catch (x) {}
    if (appUrl && s.indexOf(appUrl) >= 0) fail(e);
  });

  function request(msg) {
    return new Promise(function (resolve, reject) {
      var id = nextCall++;
      calls.set(id, { resolve: resolve, reject: reject });
      msg.reqId = id;
      post(msg);
    });
  }
  var api = {
    W: W,
    H: H,
    store: {
      get: function (k) { return saved[k]; },
      set: function (k, v) {
        k = String(k);
        v = String(v);
        saved[k] = v;
        post({ t: "store", key: k, value: v });
      },
    },
    ask: function (prompt) { return request({ t: "ask", prompt: String(prompt) }); },
    fetchJson: function (url) { return request({ t: "fetch", url: String(url) }); },
    toast: function (text) { post({ t: "toast", text: String(text) }); },
    refresh: function () {
      if (refreshing) return;
      refreshing = true;
      setT(function () { refreshing = false; show(); }, 0);
    },
    exit: function () { post({ t: "exit" }); },
  };

  /** Send what the app shows now: a picture every frame, text only when it changed. */
  function show() {
    if (dead || !app) return;
    if (kind === "pixels") {
      var px = new Uint8Array(W * H); // a fresh one is cleared already, and is handed over, not copied
      var head = call(function () {
        if (app.draw) app.draw(px);
        var h = app.header ? app.header() : "";
        return h ? String(h) : "";
      });
      if (!dead) post({ t: "frame", px: px, header: head }, [px.buffer]);
      return;
    }
    var out = call(function () {
      var s = app.screen ? app.screen() : null;
      if (!s) return { header: "", body: "" };
      return {
        header: s.header == null ? "" : String(s.header),
        body: s.body == null ? undefined : String(s.body),
        list: isArray(s.list) ? s.list.map(String) : undefined,
      };
    });
    if (dead) return;
    var key = stringify(out);
    if (key === lastText) return;
    lastText = key;
    post({ t: "screen", screen: out });
  }
  function frame() {
    if (dead || !app) return;
    var t = now(), dt = Math.min(0.2, (t - last) / 1000);
    last = t;
    call(function () { if (app.tick) app.tick(dt); });
    show();
  }

  function start(m) {
    var s = m.store && typeof m.store === "object" ? m.store : {};
    for (var k in s) if (typeof s[k] === "string") saved[k] = s[k];
    load(String(m.source))
      .then(function (r) {
        appUrl = r.url;
        var a = r.mod && r.mod.default;
        if (!a || typeof a !== "object") throw new Error("app.js has no default export");
        app = a;
        kind = a.kind === "pixels" ? "pixels" : "text";
        var title = typeof a.title === "string" ? a.title : "";
        var hasInput = typeof a.input === "function";
        call(function () { if (a.init) a.init(api); });
        if (dead) return;
        post({ t: "ready", title: title, kind: kind, hasInput: hasInput });
        last = now();
        timer = setI(frame, 33);
        show();
        early.splice(0).forEach(input);
      })
      .catch(fail);
  }
  function input(m) {
    if (dead) return;
    if (!app) return void early.push(m); // a gesture while it was still loading
    var handled = call(function () { return app.input ? app.input(m.g, m.index) : false; });
    if (dead) return;
    post({ t: "input", seq: m.seq, handled: !!handled });
    show();
  }

  listen(function (m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "load") start(m);
    else if (m.t === "input") input(m);
    else if (m.t === "answer") {
      var c = calls.get(m.reqId);
      if (!c) return;
      calls.delete(m.reqId);
      if (m.error != null) c.reject(new Error(String(m.error)));
      else c.resolve(m.value);
    } else if (m.t === "exit") {
      clearI(timer);
      var a = app;
      app = null;
      dead = true;
      try { if (a && a.exit) a.exit(); } catch (e) {}
      post({ t: "exited" });
    }
  });
})`;

// Web Worker: capture what the runtime needs, then take away everything that reaches outside the
// worker (network, origin storage, other contexts, a raw postMessage), on the object and on every
// prototype it inherits from. import() can't be removed (it's syntax), but there's nothing it could
// fetch that needs no token, and nothing secret in here to send.
const WORKER = String.raw`
var self_ = self, postRaw = self.postMessage.bind(self), on = self.addEventListener.bind(self);
var makeUrl = URL.createObjectURL.bind(URL), B = Blob;
var GONE = ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "WebTransport", "EventSource", "indexedDB", "caches",
  "cookieStore", "BroadcastChannel", "importScripts", "Worker", "SharedWorker", "postMessage", "requestFileSystem", "webkitRequestFileSystem"];
for (var i = 0; i < GONE.length; i++) {
  for (var o = self_; o; o = Object.getPrototypeOf(o)) try { delete o[GONE[i]]; } catch (e) {}
  try { if (GONE[i] in self_) Object.defineProperty(self_, GONE[i], { value: undefined, configurable: false }); } catch (e) {}
}
try {
  for (var n = self_.navigator; n; n = Object.getPrototypeOf(n)) for (var p of ["storage", "locks", "serviceWorker", "sendBeacon"]) try { delete n[p]; } catch (e) {}
} catch (e) {}
(${RUNTIME})(
  function (m, transfer) { postRaw(m, transfer || []); },
  function (f) { on("message", function (e) { f(e.data); }); },
  function (src) {
    var url = makeUrl(new B([src], { type: "text/javascript" }));
    return import(url).then(function (mod) { return { mod: mod, url: url }; });
  },
  function (f) {
    on("error", function (e) { e.preventDefault(); f(e.error || new Error(e.message)); });
    on("unhandledrejection", function (e) { f(e.reason); });
  }
);
`;

// Node child process (ES module given with -e): its only channel is the IPC pipe.
const CHILD = String.raw`
const send = process.send.bind(process);
process.send = undefined;
process.on("disconnect", () => process.exit(0));
(${RUNTIME})(
  (m) => send(m),
  (f) => process.on("message", f),
  (src) => {
    const url = "data:text/javascript;base64," + Buffer.from(src).toString("base64");
    return import(url).then((mod) => ({ mod, url }));
  },
  (f) => {
    process.on("uncaughtException", f);
    process.on("unhandledRejection", f);
  },
);
`;

export interface Sandbox {
  post(m: object): void;
  /** Stop it now. */
  kill(): void;
}

let workerUrl = "";

/**
 * Start an empty sandbox (load the app with post({t: "load", …})). `died` is called if it can't
 * start or ends by itself; everything it sends goes to `onMessage`, unchecked.
 */
export async function openSandbox(onMessage: (m: any) => void, died: (why: string) => void): Promise<Sandbox> {
  if (typeof Worker === "function") {
    // (The runtime holds no secrets, so one blob URL serves every app.)
    workerUrl ||= URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }));
    const w = new Worker(workerUrl, { type: "module" });
    let alive = true;
    w.onmessage = (e) => alive && onMessage(e.data);
    w.onerror = (e) => {
      e.preventDefault();
      if (alive) died(`the app sandbox failed: ${e.message || "couldn't start a worker"}`);
    };
    return {
      post: (m) => alive && w.postMessage(m),
      kill: () => {
        alive = false;
        w.terminate();
      },
    };
  }
  const proc = (globalThis as any).process;
  if (!proc?.versions?.node) throw new Error("no way to run mini-apps here (no Web Workers)");
  const cpName = "node:child_process"; // (a variable, so Vite leaves it out of the browser build)
  const { spawn } = await import(/* @vite-ignore */ cpName);
  const flag = ["--permission", "--experimental-permission"].find((f) => proc.allowedNodeEnvironmentFlags.has(f));
  if (!flag) console.warn("[glasses] this Node has no permission model: mini-apps run in a plain child process");
  const child = spawn(proc.execPath, [...(flag ? [flag] : []), "--input-type=module", "-e", CHILD], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "advanced", // typed arrays (frames) go as bytes, not JSON
    env: { PATH: proc.env.PATH ?? "" },
  });
  let alive = true;
  let stderr = "";
  child.stderr.on("data", (d: unknown) => (stderr = (stderr + String(d)).slice(-1500)));
  child.on("message", (m: unknown) => alive && onMessage(m));
  child.on("error", (e: Error) => alive && ((alive = false), died(`the app sandbox failed: ${e.message}`)));
  child.on("exit", (code: number | null) => alive && ((alive = false), died(stderr.trim() || `the app ended its process (exit ${code})`)));
  return {
    post: (m) => {
      if (alive && child.connected) child.send(m, (e: Error | null) => e && alive && log(e));
    },
    kill: () => {
      alive = false;
      child.kill();
    },
  };
}

const log = (e: Error) => console.warn(`[glasses] app sandbox: ${e.message}`);
