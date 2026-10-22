const CATS = [
  ["Top", "https://feeds.bbci.co.uk/news/rss.xml"],
  ["World", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["Tech", "https://feeds.bbci.co.uk/news/technology/rss.xml"],
  ["Sports", "https://feeds.bbci.co.uk/sport/rss.xml"],
];
const COLS = 44, LINES = 5;
let api, cat = 0, items = [], status = "loading", mode = "list", pages = [], page = 0, reqId = 0, story = null;

function clean(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"').replace(/&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ").trim();
}
function wrap(text) {
  const out = []; let line = "";
  for (let w of text.split(" ")) {
    while (w.length > COLS) { if (line) { out.push(line); line = ""; } out.push(w.slice(0, COLS)); w = w.slice(COLS); }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= COLS) line += " " + w;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}
function cut(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function load() {
  const id = ++reqId;
  status = "loading"; items = [];
  api.refresh();
  const url = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(CATS[cat][1]);
  api.fetchJson(url).then(d => {
    if (id !== reqId) return;
    const arr = d && Array.isArray(d.items) ? d.items : [];
    items = arr.map(it => ({
      title: clean(it.title),
      text: clean(it.description) || clean(it.content),
      date: String(it.pubDate || "").slice(0, 16),
    })).filter(it => it.title);
    status = items.length ? "ok" : "No headlines found";
    api.refresh();
  }).catch(() => {
    if (id !== reqId) return;
    status = "Offline / failed. Tap Refresh";
    api.refresh();
  });
}

function open(it) {
  story = it;
  const body = it.text && it.text !== it.title ? it.text : "(No summary available.)";
  pages = [];
  const lines = wrap(it.title).concat([""], wrap(body));
  if (it.date) lines.push("", it.date);
  for (let i = 0; i < lines.length; i += LINES) pages.push(lines.slice(i, i + LINES).join("\n"));
  page = 0; mode = "story";
}

export default {
  title: "News",
  kind: "text",
  init(a) { api = a; load(); },
  screen() {
    if (mode === "story") {
      return { header: `${CATS[cat][0]} · ${page + 1}/${pages.length} · swipe, dbl=back`, body: pages[page] };
    }
    const head = [`◄ ${CATS[cat][0]} ► (tap: next category)`, "↻ Refresh"];
    if (status !== "ok") {
      return { header: "News · " + CATS[cat][0], list: head.concat([status === "loading" ? "Loading…" : status]) };
    }
    return { header: `News · ${CATS[cat][0]} · ${items.length}`, list: head.concat(items.map(i => cut(i.title, COLS))) };
  },
  input(g, index) {
    if (mode === "story") {
      if (g === "down" || (g === "tap" && page < pages.length - 1)) { if (page < pages.length - 1) page++; return true; }
      if (g === "up") { if (page > 0) page--; return true; }
      if (g === "tap" || g === "double") { mode = "list"; return true; }
      return false;
    }
    if (g === "tap") {
      if (index === 0) { cat = (cat + 1) % CATS.length; load(); }
      else if (index === 1) load();
      else if (status === "ok" && items[index - 2]) open(items[index - 2]);
      return true;
    }
    return false;
  },
};
