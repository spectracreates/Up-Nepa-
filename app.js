import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

// Public client credentials (safe to ship: all writes go through server-side checks)
const SUPABASE_URL = "https://dztgtjrysndwnlvvrums.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6dGd0anJ5c25kd25sdnZydW1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5Njg2MzAsImV4cCI6MjEwODU0NDYzMH0.GR5nBLFvmamVfMc9PnEbmbly9rWVlJu12YLmqwU1I30";
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("upnepa:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("upnepa:" + k, JSON.stringify(v)); } catch {} },
};

const S = {
  areas: store.get("areas", []),      // [{slug,name,lga,lat,lng}]
  status: new Map(),                  // slug -> status row
  notices: [],
  selected: store.get("selected", null),
  pos: null,                          // {lat,lng,acc}
  nearest: null,                      // {area, dist}
  manual: store.get("manual", false), // user picked area by hand
  signedIn: false,
  sending: false,
  tab: "pattern",
  filter: "all",
  lastReport: store.get("lastReport", {}), // slug -> ms
};
const bySlug = () => new Map(S.areas.map((a) => [a.slug, a]));

// ---------- utils ----------
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); if (m < 1) return "just now"; if (m < 60) return m + "m ago"; const h = Math.floor(m / 60); if (h < 24) return h + "h " + (m % 60) + "m ago"; return Math.floor(h / 24) + "d ago"; };
const fmt = (t) => new Date(t).toLocaleString("en-NG", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" });
const h12 = (h) => (h % 12 || 12) + (h < 12 ? "am" : "pm");
const lagosHour = () => +new Date().toLocaleString("en-NG", { hour: "numeric", hour12: false, timeZone: "Africa/Lagos" }) % 24;
const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + "m" : (m / 1000).toFixed(1) + "km");
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function statusWord(s) { if (!s) return { cls: "", word: "No reports" }; if (s.level === "mixed") return { cls: "mix", word: "Mixed" }; return s.is_on ? { cls: "on", word: "Light on" } : { cls: "off", word: "No light" }; }

// ---------- data ----------
async function loadAreas() {
  const { data, error } = await sb.from("areas").select("slug,name,lga,lat,lng").order("name");
  if (!error && data?.length) { S.areas = data; store.set("areas", data); }
}
async function loadStatus() {
  const { data, error } = await sb.rpc("area_status");
  if (error) return setLive(false);
  S.status = new Map(data.map((r) => [r.slug, r]));
  setLive(true);
  renderHero(); renderList(); renderMap();
}
async function loadNotices() {
  const { data } = await sb.from("notices").select("*").order("published_at", { ascending: false }).limit(20);
  if (data) { S.notices = data.filter((n) => !n.expires_at || new Date(n.expires_at) > new Date()); renderNotices(); }
}
async function loadDetail() {
  const slug = S.selected; if (!slug) return;
  const [p, l] = await Promise.all([sb.rpc("area_pattern", { p_slug: slug }), sb.rpc("area_log", { p_slug: slug })]);
  if (slug !== S.selected) return;
  renderPattern(p.data || []); renderLog(l.data || []);
}
const refreshStatus = debounce(loadStatus, 1200);
const refreshDetail = debounce(loadDetail, 1200);

function setLive(ok) { const el = $("live"); el.classList.toggle("on", ok); el.querySelector("span").textContent = ok ? "Live" : "Offline"; }

// ---------- location ----------
// Phones: get a quick network-based fix first (works indoors), then refine with GPS in the background.
const UA = navigator.userAgent || "";
const IN_APP = /FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|; wv\)|WhatsApp/i.test(UA);
const IOS = /iPhone|iPad|iPod/i.test(UA);
let watchId = null, gotFix = false;

function locHelp(msg) { const el = $("locHelp"); el.textContent = msg || ""; el.hidden = !msg; }

async function locate() {
  if (!("geolocation" in navigator) || !window.isSecureContext) {
    $("locLine").textContent = "Location not available";
    locHelp("This browser can't share location here. Open the site in Chrome or Safari, or tap Change to pick your area.");
    $("locBtn").hidden = true;
    return;
  }
  try {
    const st = await navigator.permissions?.query({ name: "geolocation" });
    if (st && st.state === "denied") return onPosErr({ code: 1 });
  } catch {}
  $("locLine").textContent = "Finding your location…";
  locHelp("");
  gotFix = false;
  // 1) fast, low-accuracy fix (cell/Wi-Fi), accepts a recent cached position
  navigator.geolocation.getCurrentPosition(onPos, (e) => {
    // 2) if that fails for a reason other than permission, try GPS with more time
    if (e.code === 1) return onPosErr(e);
    navigator.geolocation.getCurrentPosition(onPos, onPosErr, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  // 3) refine with GPS for up to 45s without blocking
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition((p) => {
    onPos(p);
    if (p.coords.accuracy <= 100) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }, () => {}, { enableHighAccuracy: true, timeout: 45000, maximumAge: 0 });
  setTimeout(() => { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }, 45000);
}
function onPos(p) {
  const next = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
  if (S.pos && gotFix && next.acc > S.pos.acc) return; // keep the better fix
  S.pos = next; gotFix = true;
  $("locBtn").hidden = true; locHelp("");
  let best = null;
  for (const a of S.areas) { const d = dist(S.pos, a); if (!best || d < best.dist) best = { area: a, dist: d }; }
  const changed = !S.nearest || !best || S.nearest.area.slug !== best.area.slug;
  S.nearest = best;
  if (best && best.dist <= 6000) {
    if ((!S.manual || !S.selected) && (changed || S.selected !== best.area.slug)) select(best.area.slug, false);
  } else {
    $("locLine").textContent = "You seem to be outside Lagos";
    if (!S.selected) openSheet();
  }
  renderHero(); renderMap(changed);
}
function onPosErr(e) {
  if (gotFix) return; // a later attempt already worked
  $("locBtn").hidden = false;
  $("locLine").textContent = e.code === 1 ? "Location blocked" : e.code === 3 ? "Location timed out" : "Couldn't get location";
  if (IN_APP) locHelp("You're inside another app's browser, which blocks location. Tap ⋮ or the share icon and choose Open in Chrome (or Safari).");
  else if (e.code === 1) locHelp(IOS
    ? "Location is blocked. On iPhone: Settings > Privacy & Security > Location Services > Safari Websites > While Using. Then tap 'Use my location'."
    : "Location is blocked for this site. Tap the icon left of the web address > Permissions > Location > Allow. Then tap 'Use my location'.");
  else locHelp("Turn on Location in your phone's quick settings, then tap 'Use my location'. Or tap Change to pick your area.");
  if (!S.selected) { $("areaLga").textContent = "Turn on location, or tap Change to pick your area"; }
  renderHero();
}

// ---------- selection ----------
function select(slug, manual) {
  S.selected = slug; store.set("selected", slug);
  if (manual !== undefined) { S.manual = manual; store.set("manual", manual); }
  renderHero(); loadDetail(); renderList(); renderMap();
}

// ---------- reporting ----------
async function report(isOn) {
  const slug = S.selected; if (!slug || S.sending) return;
  if (!S.signedIn) { toast("Still connecting. Try again in a moment."); return; }
  S.sending = true; renderActions();
  const args = { p_slug: slug, p_on: isOn };
  if (S.pos) Object.assign(args, { p_lat: S.pos.lat, p_lng: S.pos.lng, p_accuracy: S.pos.acc });
  const { data, error } = await sb.rpc("submit_report", args);
  S.sending = false;
  const note = $("actionNote");
  if (error) {
    const m = error.message || "";
    note.className = "note bad";
    if (m.startsWith("too_soon")) note.textContent = "You just reported here. You can update it again in " + (m.split(":")[1] || "a few") + " seconds.";
    else if (m.startsWith("too_far")) note.textContent = "You're about " + fmtDist(+m.split(":")[1]) + " from " + bySlug().get(slug).name + ". Only people nearby can report an area.";
    else if (m === "rate_limited") note.textContent = "That's a lot of reports in one hour. Try again later.";
    else if (m === "outside_lagos") note.textContent = "Your location is outside Lagos, so this report wasn't accepted.";
    else note.textContent = "That report didn't go through. Check your connection and try again.";
  } else {
    S.lastReport[slug] = Date.now(); store.set("lastReport", S.lastReport);
    note.className = "note good";
    note.textContent = data?.verified ? "Thanks! Your report is GPS-verified and counts fully." : "Thanks! Turn on location so your next report counts fully.";
    toast(isOn ? "Reported: light don come" : "Reported: light don go");
    if (navigator.vibrate) navigator.vibrate(30);
    loadStatus(); loadDetail();
  }
  renderActions();
}

// ---------- rendering ----------
function renderActions() {
  const last = S.lastReport[S.selected] || 0, wait = last + 120000 - Date.now();
  $("btnUp").disabled = $("btnDown").disabled = !S.selected || S.sending || wait > 0;
  if (wait > 0) { clearTimeout(renderActions.t); renderActions.t = setTimeout(renderActions, Math.min(wait + 50, 30000)); }
}
function renderHero() {
  $("clock").textContent = new Date().toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });
  const a = bySlug().get(S.selected);
  if (!a) { $("bigStatus").textContent = S.areas.length ? "PICK AREA" : "LOADING…"; renderActions(); return; }
  const s = S.status.get(a.slug);
  $("areaName").textContent = a.name;
  $("areaLga").textContent = a.lga + " LGA" + (S.nearest && S.nearest.area.slug === a.slug ? " · " + fmtDist(S.nearest.dist) + " from you" : S.manual ? " · picked by you" : "");
  if (S.pos && S.nearest) $("locLine").textContent = "Near " + S.nearest.area.name + " · ±" + fmtDist(S.pos.acc);
  if (!s) {
    $("bigStatus").textContent = "NO DATA YET";
    $("confLine").textContent = "No reports in 6h"; $("ageLine").textContent = "";
    $("voteNote").textContent = "Nobody has reported " + a.name + " in the last 6 hours. Be the first.";
    $("votes").children[0].style.width = "0"; $("votes").children[1].style.width = "0";
  } else {
    const n = s.n_on + s.n_off;
    $("bigStatus").textContent = s.level === "mixed" ? "MIXED REPORTS" : s.is_on ? "LIGHT DEY" : "NO LIGHT";
    $("confLine").textContent = { confirmed: "Confirmed", likely: "Likely", single: "Unconfirmed", mixed: "Neighbours disagree" }[s.level] + " · " + n + (n === 1 ? " report" : " reports");
    $("ageLine").textContent = ago(new Date(s.newest).getTime());
    $("votes").children[0].style.width = (s.n_on / n) * 100 + "%"; $("votes").children[1].style.width = (s.n_off / n) * 100 + "%";
    $("voteNote").textContent = s.n_on + " say light is on, " + s.n_off + " say it's off · " + s.verified_n + " GPS-verified" + (s.level === "single" ? ". One more neighbour will confirm it." : ".");
  }
  renderActions();
}
function renderPattern(rows) {
  const ch = $("chart"); ch.textContent = "";
  const counts = new Array(24).fill(0); rows.forEach((r) => (counts[r.hour] = r.n));
  const max = Math.max(1, ...counts), now = lagosHour();
  counts.forEach((v, h) => { const d = document.createElement("div"); d.className = "bar" + (v ? "" : " zero") + (h === now ? " now" : ""); d.style.height = (v ? Math.max(6, (v / max) * 100) : 3) + "%"; d.title = v + " at " + h12(h); ch.append(d); });
  const total = counts.reduce((a, b) => a + b, 0), name = bySlug().get(S.selected)?.name || "this area";
  if (total >= 3) {
    const peak = counts.indexOf(Math.max(...counts));
    $("insight").textContent = name + " usually gets light around " + h12(peak) + ", from " + total + " reports.";
  } else $("insight").textContent = "Once a few people report, you'll see when " + name + " usually gets light.";
}
function renderLog(rows) {
  const ul = $("log"); ul.textContent = "";
  rows.forEach((r) => {
    const li = document.createElement("li"), l = document.createElement("span"), dot = document.createElement("span");
    dot.className = "dot"; dot.style.background = r.is_on ? "var(--on)" : "var(--off)"; if (!r.is_on) dot.style.border = "1px solid var(--muted)";
    l.append(dot, document.createTextNode(r.is_on ? "Light came on" : "Light went off"));
    if (r.verified) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "GPS ✓"; l.append(t); }
    const tm = document.createElement("time"); tm.textContent = fmt(r.created_at); li.append(l, tm); ul.append(li);
  });
  $("logEmpty").hidden = rows.length > 0;
}
function areaRow(a, onPick) {
  const s = S.status.get(a.slug), w = statusWord(s);
  const li = document.createElement("li"), b = document.createElement("button"); b.type = "button";
  const left = document.createElement("span"), nm = document.createElement("span"), lg = document.createElement("span");
  nm.className = "nm"; nm.textContent = a.name; lg.className = "lga";
  lg.textContent = a.lga + (S.pos ? " · " + fmtDist(dist(S.pos, a)) : "") + (s ? " · " + ago(new Date(s.newest).getTime()) : "");
  left.append(nm, lg);
  const st = document.createElement("span"); st.className = "st " + w.cls; st.textContent = w.word;
  b.append(left, st); b.onclick = () => onPick(a.slug); li.append(b); return li;
}
function filtered(q, f) {
  q = q.trim().toLowerCase();
  let list = S.areas.filter((a) => !q || a.name.toLowerCase().includes(q) || a.lga.toLowerCase().includes(q));
  if (f === "on") list = list.filter((a) => { const s = S.status.get(a.slug); return s && s.is_on && s.level !== "mixed"; });
  if (f === "off") list = list.filter((a) => { const s = S.status.get(a.slug); return s && !s.is_on && s.level !== "mixed"; });
  if (f === "active") list = list.filter((a) => S.status.has(a.slug));
  if (S.pos) list.sort((x, y) => dist(S.pos, x) - dist(S.pos, y));
  else list.sort((x, y) => (S.status.has(y.slug) - S.status.has(x.slug)) || x.name.localeCompare(y.name));
  return list;
}
function renderList() {
  if (S.tab !== "areas") return;
  const ul = $("list"); ul.textContent = "";
  const list = filtered($("q").value, S.filter).slice(0, 80);
  const frag = document.createDocumentFragment();
  list.forEach((a) => frag.append(areaRow(a, (slug) => { select(slug, true); scrollTo({ top: 0, behavior: "smooth" }); })));
  ul.append(frag);
  if (!list.length) { const li = document.createElement("li"); li.className = "muted small"; li.textContent = S.filter === "all" ? "No area matches that. Try the LGA name, like Kosofe or Eti-Osa." : "No areas match this filter right now."; ul.append(li); }
}
function renderNotices() {
  const ul = $("notices"); ul.textContent = "";
  if (!S.notices.length) { const li = document.createElement("li"); li.textContent = "No official notices right now."; ul.append(li); return; }
  S.notices.forEach((n) => {
    const li = document.createElement("li"), h = document.createElement("h3"), p = document.createElement("p"), m = document.createElement("div");
    h.textContent = n.title; p.textContent = n.body; m.className = "meta";
    const sc = document.createElement("span"); sc.textContent = n.scope; const dt = document.createElement("span"); dt.textContent = fmt(n.published_at);
    m.append(sc, dt);
    if (n.source_url && /^https:\/\//.test(n.source_url)) { const a = document.createElement("a"); a.href = n.source_url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Source: " + (n.source_name || "link"); m.append(a); }
    li.append(h, p, m); ul.append(li);
  });
}

// ---------- map (lazy) ----------
let map = null, markers = new Map(), youMarker = null;
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function renderMap(recenter) {
  if (S.tab !== "map" || typeof L === "undefined") return;
  if (!map) {
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([6.53, 3.39], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap contributors" }).addTo(map);
    recenter = true;
  }
  const cOn = cssVar("--on"), cOff = cssVar("--off"), cMix = cssVar("--mix"), cNone = cssVar("--line"), cInk = cssVar("--ink");
  for (const a of S.areas) {
    const s = S.status.get(a.slug), w = statusWord(s);
    const fill = w.cls === "on" ? cOn : w.cls === "off" ? cOff : w.cls === "mix" ? cMix : cNone;
    const r = s ? 7 + Math.min(8, s.n_on + s.n_off) : 5;
    let m = markers.get(a.slug);
    if (!m) { m = L.circleMarker([a.lat, a.lng]).addTo(map); m.on("click", () => select(a.slug, true)); markers.set(a.slug, m); }
    m.setStyle({ radius: r, fillColor: fill, fillOpacity: s ? 0.95 : 0.6, color: a.slug === S.selected ? cInk : fill, weight: a.slug === S.selected ? 3 : 1 });
    m.bindTooltip(a.name + " · " + w.word + (s ? " (" + (s.n_on + s.n_off) + ")" : ""));
  }
  if (S.pos) {
    if (!youMarker) youMarker = L.circleMarker([S.pos.lat, S.pos.lng], { radius: 6, color: "#2a7de1", fillColor: "#2a7de1", fillOpacity: 1, weight: 3 }).addTo(map).bindTooltip("You");
    else youMarker.setLatLng([S.pos.lat, S.pos.lng]);
    if (recenter) map.setView([S.pos.lat, S.pos.lng], 13);
  }
  setTimeout(() => map.invalidateSize(), 50);
}

// ---------- sheet ----------
function openSheet() { $("sheet").hidden = false; $("sq").value = ""; renderSheet(); setTimeout(() => $("sq").focus(), 50); }
function closeSheet() { $("sheet").hidden = true; }
function renderSheet() {
  const ul = $("slist"); ul.textContent = "";
  filtered($("sq").value, "all").slice(0, 60).forEach((a) => ul.append(areaRow(a, (slug) => { select(slug, !(S.nearest && S.nearest.area.slug === slug)); closeSheet(); })));
}

// ---------- tabs ----------
function setTab(t) {
  S.tab = t;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t));
  ["pattern", "map", "areas", "notices"].forEach((x) => ($("p-" + x).hidden = x !== t));
  if (t === "map") renderMap(); if (t === "areas") renderList();
}

// ---------- wire up ----------
$("btnUp").onclick = () => report(true);
$("btnDown").onclick = () => report(false);
$("changeArea").onclick = openSheet;
$("sheetClose").onclick = closeSheet;
$("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
$("sq").addEventListener("input", debounce(renderSheet, 120));
$("q").addEventListener("input", debounce(renderList, 120));
$("locBtn").onclick = () => { S.manual = false; store.set("manual", false); locate(); };
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$("filters").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; S.filter = c.dataset.f; document.querySelectorAll("#filters .chip").forEach((x) => x.classList.toggle("on", x === c)); renderList(); });

async function boot() {
  renderHero();
  // Sign in anonymously so each phone counts as one voice
  sb.auth.getSession().then(async ({ data }) => {
    if (data.session) S.signedIn = true;
    else { const { error } = await sb.auth.signInAnonymously(); S.signedIn = !error; if (error) $("actionNote").textContent = "Reporting is temporarily unavailable. You can still see live status."; }
  });
  await Promise.all([S.areas.length ? Promise.resolve() : loadAreas(), loadNotices()]);
  if (!S.areas.length) await loadAreas(); else loadAreas(); // refresh cached list in background
  locate();
  await loadStatus();
  loadDetail();

  // Realtime: any report anywhere bumps a tick; refetch status (debounced) and detail if it's our area
  sb.channel("ticks")
    .on("postgres_changes", { event: "*", schema: "public", table: "area_ticks" }, (p) => {
      refreshStatus();
      const id = p.new?.area_id; if (id) refreshDetail();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "notices" }, () => loadNotices())
    .subscribe((st) => setLive(st === "SUBSCRIBED"));

  // Fallbacks: decay ages and catch missed events
  setInterval(renderHero, 30000);
  setInterval(loadStatus, 90000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadStatus(); loadDetail(); } });
}
boot();

if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  // when a new version takes over, reload once so phones run the latest code
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !sessionStorage.getItem("swr")) { sessionStorage.setItem("swr", "1"); location.reload(); } });
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").then((r) => r.update()).catch(() => {}));
}
