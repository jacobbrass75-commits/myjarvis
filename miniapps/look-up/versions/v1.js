// API found via web search: Open Notify ISS Location API (free, no key)
// http://api.open-notify.org/iss-now.json -> { iss_position: { latitude, longitude }, timestamp }
// https://open-notify-api.readthedocs.io/en/latest/iss_location.html
let api, lat = null, lon = null, ts = 0, err = "", timer = 0, loading = false;

function load() {
  if (loading) return;
  loading = true;
  api.fetchJson("http://api.open-notify.org/iss-now.json").then((j) => {
    loading = false;
    const p = j && j.iss_position;
    if (!p) { err = "Bad response"; api.refresh(); return; }
    lat = parseFloat(p.latitude);
    lon = parseFloat(p.longitude);
    ts = j.timestamp || 0;
    err = "";
    api.refresh();
  }).catch(() => {
    loading = false;
    err = "Offline, retrying...";
    api.refresh();
  });
}

const fmt = (v, pos, neg) => Math.abs(v).toFixed(2) + "° " + (v >= 0 ? pos : neg);

export default {
  title: "ISS Tracker",
  kind: "text",
  init(a) { api = a; timer = 0; load(); },
  tick(dt) {
    timer += dt;
    if (timer >= 30) { timer = 0; load(); }
  },
  screen() {
    if (lat === null) return { header: "ISS Tracker", body: err || "Locating the station..." };
    const t = ts ? new Date(ts * 1000).toISOString().slice(11, 19) + " UTC" : "";
    let body = "Latitude:  " + fmt(lat, "N", "S") + "\nLongitude: " + fmt(lon, "E", "W") +
      "\n\nUpdated: " + t + "\nNext update in " + Math.max(0, Math.ceil(30 - timer)) + "s";
    if (err) body += "\n" + err;
    return { header: "ISS Position", body };
  },
  input(g) {
    if (g === "tap") { timer = 0; load(); return true; }
    return false;
  },
};
