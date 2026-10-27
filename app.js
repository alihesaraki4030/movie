"use strict";
/* Movie Archive — plain HTML/CSS/JS. Database = public/movies.json in the GitHub repo (edited through the GitHub API).
   Posters/titles come from several sources tried in turn (IMDb, Wikipedia/Wikidata, optional TMDB / OMDb keys).
   A source that is unreachable from your network is switched off automatically and the next one is used. */
const FILE = "public/movies.json", K_CFG = "ma-gh", K_LIST = "ma-list", K_POST = "ma-posters", K_KEYS = "ma-keys";
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / disabled */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const uid = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- state ---------- */
let movies = null, cfg = store.get(K_CFG, null), sha, keys = store.get(K_KEYS, { tmdb: "", omdb: "" });
const posterCache = store.get(K_POST, {});           // imdbId/id -> poster url that loaded in this browser
const pending = new Map();                           // movie id -> new poster url waiting to be committed
let dirty = false, running = false, filters = { q: "", year: "", rated: false, sort: "desc" };

/* ---------- network helpers ---------- */
async function jget(url, ms = 7000, init = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...init, signal: ac.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
function jsonp(url, cb, ms = 6000) {
  return new Promise((res, rej) => {
    const s = document.createElement("script"), done = () => { s.remove(); delete window[cb]; clearTimeout(t); };
    const t = setTimeout(() => { done(); rej(new Error("timeout")); }, ms);
    window[cb] = (d) => { done(); res(d); }; s.onerror = () => { done(); rej(new Error("blocked")); };
    s.src = url; document.head.appendChild(s);
  });
}
function canLoad(url, ms = 10000) {
  return new Promise((res) => {
    const i = new Image(), t = setTimeout(() => { i.src = ""; res(false); }, ms);
    i.referrerPolicy = "no-referrer"; i.onload = () => { clearTimeout(t); res(i.naturalWidth > 1); }; i.onerror = () => { clearTimeout(t); res(false); }; i.src = url;
  });
}

/* ---------- sources (health tracking: 3 network failures in a row and never a success => off) ---------- */
const health = { imdb: { ok: 0, fail: 0, off: false }, wiki: { ok: 0, fail: 0, off: false }, tmdb: { ok: 0, fail: 0, off: false }, omdb: { ok: 0, fail: 0, off: false } };
const NAMES = { imdb: "IMDb", wiki: "Wikipedia", tmdb: "TMDB", omdb: "OMDb" };
async function guard(name, fn) {
  const s = health[name]; if (s.off) return null;
  try { const r = await fn(); s.ok++; s.fail = 0; renderHealth(); return r; }
  catch { s.fail++; if (s.fail >= 3 && !s.ok) s.off = true; renderHealth(); return null; }
}
function renderHealth() {
  const box = $("#health"); box.replaceChildren(h("span", {}, "Poster sources:"));
  for (const n of order(true)) {
    const s = health[n], cls = s.off ? "bad" : s.ok ? "ok" : "";
    box.append(h("span", { class: "chip " + cls, onclick: () => { Object.assign(health[n], { ok: 0, fail: 0, off: false }); renderHealth(); render(); } },
      NAMES[n] + (s.off ? " ✗ unreachable (click to retry)" : s.ok ? " ✓" : "")));
  }
}
function order(all = false) { const o = []; if (keys.tmdb) o.push("tmdb"); o.push("imdb", "wiki"); if (keys.omdb) o.push("omdb"); return all ? o : o.filter((n) => !health[n].off); }
const imdbImg = (u, w) => u.replace(/\._V1_.*\.jpg$/i, `._V1_UX${w}_.jpg`);
const cleanTitle = (t) => t.replace(/\s*\((?:[^()]*\s)?film\)\s*$/i, "").trim();
const yearFromTitle = (t) => { const m = t?.match(/\((\d{4})\s+(?:[^()]*\s)?film\)\s*$/i); return m ? Number(m[1]) : null; };

async function imdbSuggest(text) {
  const k = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); if (k.length < 2) return [];
  try { return (await jget(`https://v2.sg.media-imdb.com/suggestion/${k[0]}/${k}.json`, 6000)).d ?? []; }
  catch { return (await jsonp(`https://sg.media-imdb.com/suggests/${k[0]}/${k}.json`, `imdb$${k}`)).d ?? []; }
}
const wiki = (params, base = "https://en.wikipedia.org/w/api.php") => jget(base + "?" + new URLSearchParams({ format: "json", origin: "*", ...params }));
const WD = "https://www.wikidata.org/w/api.php";
const wdImdb = (e) => { const v = e?.claims?.P345?.[0]?.mainsnak?.datavalue?.value; return /^tt\d{5,10}$/.test(v ?? "") ? v : null; };
const wdYear = (e) => { const ys = (e?.claims?.P577 ?? []).map((c) => String(c.mainsnak?.datavalue?.value?.time ?? "").match(/^\+?(\d{4})/)?.[1]).filter(Boolean).map(Number); return ys.length ? Math.min(...ys) : null; };
const wdTv = (e) => (e?.claims?.P31 ?? []).some((c) => ["Q5398426", "Q21191270", "Q15416", "Q1259759"].includes(c.mainsnak?.datavalue?.value?.id));

// Each provider: IMDb ID -> { title, year, posters: [url...] } (posters empty when it has none; throws only on network failure)
const PROVIDERS = {
  async imdb(id) { const x = (await imdbSuggest(id)).find((d) => d.id === id); return x ? { title: x.l, year: x.y ?? null, posters: x.i?.imageUrl ? [imdbImg(x.i.imageUrl, 400)] : [] } : { posters: [] }; },
  async wiki(id) {
    const s = await wiki({ action: "query", list: "search", srsearch: `haswbstatement:P345=${id}`, srlimit: "1" }, WD);
    const qid = s?.query?.search?.[0]?.title; if (!qid) return { posters: [] };
    const d = await wiki({ action: "wbgetentities", ids: qid, props: "claims|sitelinks|labels", sitefilter: "enwiki", languages: "en" }, WD);
    const e = d?.entities?.[qid]; if (!e) return { posters: [] };
    const page = e.sitelinks?.enwiki?.title; let poster = null;
    if (page) { const w = await wiki({ action: "query", titles: page, prop: "pageimages", piprop: "thumbnail", pithumbsize: "400", redirects: "1" }); poster = Object.values(w?.query?.pages ?? {})[0]?.thumbnail?.source ?? null; }
    return { title: e.labels?.en?.value ?? (page ? cleanTitle(page) : null), year: yearFromTitle(page) ?? wdYear(e), posters: poster ? [poster] : [] };
  },
  async tmdb(id) {
    const r = (await jget(`https://api.themoviedb.org/3/find/${id}?external_source=imdb_id&api_key=${encodeURIComponent(keys.tmdb)}`)).movie_results?.[0];
    return r ? { title: r.title, year: Number((r.release_date ?? "").slice(0, 4)) || null, posters: r.poster_path ? [`https://image.tmdb.org/t/p/w342${r.poster_path}`] : [] } : { posters: [] };
  },
  async omdb(id) {
    const d = await jget(`https://www.omdbapi.com/?i=${id}&apikey=${encodeURIComponent(keys.omdb)}`);
    return d.Response === "True" ? { title: d.Title, year: Number(d.Year) || null, posters: d.Poster && d.Poster !== "N/A" ? [d.Poster] : [] } : { posters: [] };
  },
};
// All sources in turn, merged: title / year / every poster candidate.
async function lookupMeta(id) {
  const out = { title: null, year: null, posters: [] };
  for (const n of order()) {
    const r = await guard(n, () => PROVIDERS[n](id)); if (!r) continue;
    out.title ??= r.title ?? null; out.year ??= r.year ?? null;
    for (const p of r.posters) if (!out.posters.includes(p)) out.posters.push(p);
  }
  return out;
}
async function* candidates(m) {
  const seen = new Set(), key = m.imdbId || m.id;
  for (const u of [m.posterUrl, posterCache[key]]) if (u && !seen.has(u)) { seen.add(u); yield u; }
  if (!m.imdbId) return;
  for (const n of order()) {
    const r = await guard(n, () => PROVIDERS[n](m.imdbId)); if (!r) continue;
    for (const u of r.posters) if (!seen.has(u)) { seen.add(u); yield u; }
  }
}

/* ---------- search (add form) ---------- */
async function searchMovies(q, onHits, alive) {
  let acc = []; const push = (hits) => { for (const x of hits) { const i = acc.findIndex((a) => a.imdbId === x.imdbId); if (i < 0) acc.push(x); else if (!acc[i].poster && x.poster) acc[i].poster = x.poster; } if (alive()) onHits(acc.slice(0, 10)); };
  const id = q.match(/tt\d{5,10}/)?.[0];
  if (id) { const m = await lookupMeta(id); push([{ title: m.title ?? id, year: m.year, imdbId: id, poster: m.posters[0] ?? null }]); return; }
  await Promise.all([
    health.imdb.off ? 0 : guard("imdb", async () => push((await imdbSuggest(q)).filter((x) => x.id?.startsWith("tt") && (x.qid === "movie" || x.qid === "tvMovie")).slice(0, 8)
      .map((x) => ({ title: x.l, year: x.y ?? null, imdbId: x.id, poster: x.i?.imageUrl ? imdbImg(x.i.imageUrl, 100) : null })))),
    health.wiki.off ? 0 : guard("wiki", async () => {
      const s = await wiki({ action: "query", generator: "search", gsrsearch: q + " film", gsrlimit: "10", prop: "pageimages|pageprops", piprop: "thumbnail", pithumbsize: "200", ppprop: "wikibase_item" });
      const pages = Object.values(s?.query?.pages ?? {}).sort((a, b) => a.index - b.index);
      const qids = pages.map((p) => p.pageprops?.wikibase_item).filter(Boolean); if (!qids.length) return;
      const d = await wiki({ action: "wbgetentities", ids: qids.join("|"), props: "claims" }, WD), hits = [];
      for (const p of pages) { const e = d?.entities?.[p.pageprops?.wikibase_item], imdbId = e && wdImdb(e); if (imdbId && !wdTv(e)) hits.push({ title: cleanTitle(p.title), year: yearFromTitle(p.title) ?? wdYear(e), imdbId, poster: p.thumbnail?.source ?? null }); }
      push(hits);
    }),
  ]);
}

/* ---------- lazy poster loading ---------- */
const queue = []; let active = 0, idleTimer;
function enqueue(fn) { queue.push(fn); pump(); }
function pump() {
  while (active < 4 && queue.length) { active++; queue.shift()().catch(() => {}).finally(() => { active--; pump(); if (!active && !queue.length) { clearTimeout(idleTimer); idleTimer = setTimeout(persistPending, 1500); } }); }
}
async function loadPoster(m, img, box) {
  if (!img.isConnected) return;
  box.classList.add("loading");
  for await (const u of candidates(m)) {
    if (!img.isConnected) return;
    if (await canLoad(u)) {
      img.src = u; img.classList.add("ok"); box.classList.remove("loading");
      posterCache[m.imdbId || m.id] = u; store.set(K_POST, posterCache);
      if (u !== m.posterUrl && m.id) pending.set(m.id, u);
      return;
    }
  }
  box.classList.remove("loading");
}
const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); const m = movies?.find((x) => x.id === e.target.dataset.id); if (m) enqueue(() => loadPoster(m, e.target, e.target.parentElement)); }
}, { rootMargin: "500px" }) : null;
function posterEl(m) {
  const img = h("img", { alt: m.title + " poster", referrerpolicy: "no-referrer", "data-id": m.id, decoding: "async" });
  const box = h("div", { class: "poster" }, img, h("div", { class: "ph" }, "No poster"));
  io ? io.observe(img) : enqueue(() => loadPoster(m, img, box));
  return box;
}
// New posters found in this browser are committed to movies.json in one go (when connected to GitHub).
function persistPending() {
  if (!pending.size || !cfg || !movies) return;
  const p = new Map(pending); pending.clear();
  commit(movies.map((m) => (p.has(m.id) ? { ...m, posterUrl: p.get(m.id) } : m)), true);
}

/* ---------- GitHub storage ---------- */
class Conflict extends Error {}
const ghUrl = () => `https://api.github.com/repos/${cfg.repo}/contents/${FILE}`;
const ghHead = (raw) => ({ Authorization: `Bearer ${cfg.token}`, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
const b64dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
function b64enc(s) { const b = new TextEncoder().encode(s); let o = ""; for (let i = 0; i < b.length; i += 8192) o += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(o); }
const serialize = (ms) => `[\n${ms.map((m) => JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)))).join(",\n")}\n]\n`;
const fill = (ms) => ms.map((m) => ({ originalTitle: null, imdbId: null, posterUrl: null, personalRating: null, notes: null, ...m }));
async function fetchRemote(c = cfg) {
  const saved = cfg; cfg = c;
  try {
    const r = await fetch(`${ghUrl()}?ref=${encodeURIComponent(c.branch)}`, { headers: ghHead(), cache: "no-store" });
    if (r.status === 401 || r.status === 403) throw new Error("GitHub token rejected (needs Contents: read & write on this repo)");
    if (r.status === 404) throw new Error(`Cannot find ${FILE} in ${c.repo} (branch ${c.branch})`);
    if (!r.ok) throw new Error("GitHub error " + r.status);
    const d = await r.json();
    const text = d.content ? b64dec(d.content) : await (await fetch(`${ghUrl()}?ref=${encodeURIComponent(c.branch)}`, { headers: ghHead(true), cache: "no-store" })).text();
    return { list: fill(JSON.parse(text)), sha: d.sha };
  } finally { cfg = saved; }
}
async function loadPublic() {
  const repo = location.hostname.endsWith(".github.io") ? `${location.hostname.split(".")[0]}/${location.pathname.split("/")[1] || location.hostname}` : "";
  const urls = [new URL(FILE, location.href).href, ...(repo ? [`https://raw.githubusercontent.com/${repo}/main/${FILE}`] : [])];
  for (const u of urls) { try { return fill(await jget(u + "?t=" + Date.now(), 10000, { cache: "no-store" })); } catch { /* next */ } }
  throw new Error("Could not load " + FILE);
}
async function save(list) {
  const r = await fetch(ghUrl(), { method: "PUT", headers: { ...ghHead(), "Content-Type": "application/json" }, body: JSON.stringify({ message: "Update movies", content: b64enc(serialize(list)), branch: cfg.branch, sha }) });
  if (r.status === 409 || r.status === 422) throw new Conflict();
  if (r.status === 401 || r.status === 403) throw new Error("GitHub token rejected or expired");
  if (!r.ok) throw new Error("GitHub save failed (" + r.status + ")");
  sha = (await r.json()).content.sha;
}
// Update the screen immediately, commit in the background (changes made meanwhile are merged into one commit).
function commit(list, quiet) {
  movies = list; store.set(K_LIST, list); if (!quiet) render(); else renderCounts();
  if (cfg) { dirty = true; flush(); }
}
async function flush() {
  if (running) return; running = true; setSync("saving");
  try {
    while (dirty && cfg) {
      dirty = false;
      try { await save(movies); }
      catch (e) {
        dirty = true; if (!(e instanceof Conflict)) throw e;
        const r = await fetchRemote(); sha = r.sha; const rm = new Map(r.list.map((m) => [m.id, m]));
        movies = movies.map((m) => { const x = rm.get(m.id); return x ? { ...m, posterUrl: m.posterUrl ?? x.posterUrl } : m; });
      }
    }
    setSync("idle");
  } catch (e) { setSync("error"); toast(e.message, false); } finally { running = false; }
}
function setSync(s) { $("#sync").textContent = !cfg ? "" : s === "saving" ? "Saving…" : s === "error" ? "⚠ Not saved" : "✓ Saved"; }
addEventListener("beforeunload", (e) => { if (dirty || running) e.preventDefault(); });

/* ---------- UI ---------- */
let toastT;
function toast(msg, ok = true) { const t = $("#toast"); t.textContent = msg; t.className = ok ? "" : "bad"; t.style.display = "block"; clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = "none"), 3500); }
function modal(title, ...kids) {
  const close = () => { ov.remove(); removeEventListener("keydown", esc); };
  const esc = (e) => e.key === "Escape" && close();
  const ov = h("div", { class: "overlay", onclick: (e) => e.target === ov && close() }, h("div", { class: "modal", role: "dialog", "aria-label": title }, ...kids));
  addEventListener("keydown", esc); document.body.append(ov); return close;
}
const filtered = () => {
  const q = filters.q.trim().toLowerCase();
  return movies.filter((m) => (!q || [m.title, m.originalTitle, String(m.releaseYear), m.imdbId].some((v) => v?.toLowerCase().includes(q))) && (!filters.year || m.releaseYear === Number(filters.year)) && (!filters.rated || m.personalRating != null));
};
function renderCounts() { $("#count").textContent = movies ? `${filtered().length} movies` : ""; }
function render() {
  const root = $("#list"); root.replaceChildren(); renderCounts();
  const canEdit = !!cfg; $("#add").hidden = !canEdit; $("#import").hidden = !canEdit;
  $("#connect").textContent = canEdit ? "Disconnect" : "Connect GitHub to edit";
  if (!movies) return root.append(h("p", { class: "empty" }, "Loading…"));
  const years = [...new Set(movies.map((m) => m.releaseYear))].sort((a, b) => b - a), ys = $("#year");
  if (ys.options.length - 1 !== years.length) { ys.replaceChildren(h("option", { value: "" }, "All"), ...years.map((y) => h("option", { value: y }, y))); ys.value = filters.year; }
  if (!movies.length) return root.append(h("p", { class: "empty" }, "Your archive is empty."));
  const list = filtered(); if (!list.length) return root.append(h("p", { class: "empty" }, "No movies match your search or filters."));
  const by = new Map(); for (const m of list) (by.get(m.releaseYear) ?? by.set(m.releaseYear, []).get(m.releaseYear)).push(m);
  const dir = filters.sort === "asc" ? 1 : -1;
  for (const [y, ms] of [...by].sort((a, b) => (a[0] - b[0]) * dir)) {
    ms.sort((a, b) => (b.personalRating ?? -1) - (a.personalRating ?? -1) || a.title.localeCompare(b.title));
    root.append(h("section", { class: "yr" }, h("h2", {}, y), h("div", { class: "grid" }, ms.map(card))));
  }
}
function card(m) {
  return h("div", { class: "card", tabindex: "0", onclick: () => showDetail(m), onkeydown: (e) => e.key === "Enter" && showDetail(m) },
    posterEl(m),
    cfg && h("div", { class: "tools" }, h("button", { onclick: (e) => { e.stopPropagation(); openForm(m); } }, "Edit"), h("button", { class: "danger", onclick: (e) => { e.stopPropagation(); confirmDelete(m); } }, "Del")),
    h("div", { class: "meta" }, h("b", { title: m.title }, m.title), h("div", {}, h("span", {}, m.releaseYear), m.personalRating != null && h("span", { class: "r" }, `★ ${m.personalRating}/10`))));
}
function showDetail(m) {
  const close = modal(m.title, h("div", { class: "detail" }, posterEl(m), h("div", {},
    h("h2", {}, m.title), m.originalTitle && h("p", { class: "hint" }, m.originalTitle), h("p", {}, m.releaseYear),
    m.imdbId && h("a", { href: `https://www.imdb.com/title/${m.imdbId}/`, target: "_blank", rel: "noreferrer" }, "Open on IMDb"),
    m.personalRating != null && h("p", {}, `My rating: ${m.personalRating}/10`), m.notes && h("p", { style: "white-space:pre-wrap" }, m.notes),
    h("div", { class: "actions", style: "justify-content:flex-start" }, cfg && h("button", { onclick: () => { close(); openForm(m); } }, "Edit"), cfg && h("button", { class: "danger", onclick: () => { close(); confirmDelete(m); } }, "Delete"), h("button", { onclick: close }, "Close")))));
}
function confirmDelete(m) {
  const close = modal("Confirm delete", h("p", {}, `Delete “${m.title}” permanently?`),
    h("div", { class: "actions" }, h("button", { onclick: close }, "Cancel"), h("button", { class: "danger", onclick: () => { close(); commit(movies.filter((x) => x.id !== m.id)); toast("Deleted"); } }, "Delete")));
}

const FIELDS = [["title", "Title *", "text"], ["originalTitle", "Original title", "text"], ["releaseYear", "Release year *", "number"], ["imdbId", "IMDb ID or link (tt0111161)", "text"], ["posterUrl", "Poster URL (optional)", "url"], ["personalRating", "Personal rating (0–10)", "number"]];
function openForm(movie) {
  const inputs = {}, res = h("ul", { class: "hits" }), status = h("p", { class: "hint" }), err = h("p", { class: "err", role: "alert" });
  res.hidden = true;
  const fields = FIELDS.map(([k, label, type]) => { inputs[k] = h("input", { type, value: movie?.[k] ?? "", step: type === "number" ? "any" : null }); return h("label", {}, label, inputs[k]); });
  const notes = h("textarea", { rows: 3 }, movie?.notes ?? "");
  const save = h("button", { class: "primary", type: "submit" }, "Save");
  let close, timer, seq = 0;
  const search = h("input", { type: "search", placeholder: "Movie name or IMDb ID / link…", autofocus: true });
  search.addEventListener("input", () => {
    clearTimeout(timer); const q = search.value.trim(), my = ++seq; res.replaceChildren(); res.hidden = true; status.textContent = "";
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      status.textContent = "Searching…";
      try { await searchMovies(q, (hits) => {
        res.replaceChildren(...hits.map((x) => h("li", {}, h("button", { type: "button", onclick: () => { Object.assign(inputs.title, { value: x.title }); inputs.releaseYear.value = x.year ?? ""; inputs.imdbId.value = x.imdbId; inputs.posterUrl.value = x.poster ?? ""; res.hidden = true; res.replaceChildren(); search.value = ""; status.textContent = ""; } },
          x.poster ? h("img", { src: x.poster, alt: "", referrerpolicy: "no-referrer", onerror: (e) => (e.target.style.visibility = "hidden") }) : h("span", { class: "noimg" }), h("span", {}, `${x.title} (${x.year ?? "?"})`)))));
        res.hidden = !hits.length; }, () => my === seq);
        if (my === seq) status.textContent = res.hidden ? "No results. Fill the form manually or paste an IMDb ID." : "";
      } catch { if (my === seq) status.textContent = "Search sources are unreachable from this network — fill the form manually or paste an IMDb ID."; }
    }, 400);
  });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    const v = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
    const id = v.imdbId.match(/tt\d{5,10}/)?.[0] ?? v.imdbId;
    if (/^tt\d{5,10}$/.test(id) && (!v.title || !v.releaseYear || !v.posterUrl)) {   // only an IMDb ID: look up title / year / poster
      save.disabled = true; save.textContent = "Looking up…";
      const m = await lookupMeta(id).catch(() => null);
      if (m) { v.title ||= m.title ?? ""; v.releaseYear ||= String(m.year ?? ""); if (!v.posterUrl && m.posters[0]) v.posterUrl = m.posters[0]; }
      save.disabled = false; save.textContent = "Save";
    }
    const p = validate({ ...v, imdbId: id, title: v.title || id, releaseYear: v.releaseYear || (id ? String(new Date().getFullYear()) : ""), notes: notes.value });
    if (p.error) return (err.textContent = p.error);
    const key = (t, y) => `${t.toLowerCase()}|${y}`;
    if (movies.some((m) => m.id !== movie?.id && ((p.data.imdbId && m.imdbId === p.data.imdbId) || key(m.title, m.releaseYear) === key(p.data.title, p.data.releaseYear)))) return (err.textContent = "This movie already exists in your archive");
    const next = { ...(movie ?? { id: uid(), createdAt: new Date().toISOString() }), ...p.data };
    close(); commit([...movies.filter((m) => m.id !== next.id), next]); toast("Saved");
  } },
    h("h2", {}, movie ? "Edit movie" : "Add movie"),
    !movie && h("div", {}, h("label", {}, "Search (IMDb + Wikipedia)", search), status, res),
    h("div", { class: "row" }, fields), h("label", {}, "Personal notes", notes),
    h("p", { class: "hint" }, "Tip: an IMDb ID alone is enough — title, year and poster are looked up when you save."), err,
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => close() }, "Cancel"), save));
  close = modal("Movie form", form);
}
function validate(o) {
  const s = (k, max) => { const v = String(o[k] ?? "").trim(); if (v.length > max) throw new Error(k + " is too long"); return v || null; };
  const n = (k, lo, hi, label) => { const v = String(o[k] ?? "").trim(); if (!v) return null; const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${label} must be between ${lo} and ${hi}`); return x; };
  try {
    const title = s("title", 300); if (!title) throw new Error("Title is required");
    const year = n("releaseYear", 1888, 2100, "Release year"); if (year == null || !Number.isInteger(year)) throw new Error("Release year is required");
    const imdbId = s("imdbId", 20); if (imdbId && !/^tt\d{5,10}$/.test(imdbId)) throw new Error("Invalid IMDb ID (e.g. tt0111161)");
    const posterUrl = s("posterUrl", 1000); if (posterUrl && !/^(https?:\/\/|public\/)\S+$/.test(posterUrl)) throw new Error("Invalid poster URL");
    return { data: { title, originalTitle: s("originalTitle", 300), releaseYear: year, imdbId, posterUrl, personalRating: n("personalRating", 0, 10, "Personal rating"), notes: s("notes", 2000) } };
  } catch (e) { return { error: e.message }; }
}

function openConnect() {
  const repo = h("input", { type: "text", required: true, placeholder: "username/repo", value: location.hostname.endsWith(".github.io") ? `${location.hostname.split(".")[0]}/${location.pathname.split("/")[1] || location.hostname}` : "" });
  const branch = h("input", { type: "text", required: true, value: "main" }), token = h("input", { type: "password", required: true, autocomplete: "off" });
  const err = h("p", { class: "err", role: "alert" }), go = h("button", { class: "primary" }, "Connect"); let close;
  close = modal("Connect GitHub", h("form", { onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true; err.textContent = "";
    const c = { token: token.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || "main" };
    try { const r = await fetchRemote(c); cfg = c; store.set(K_CFG, c); sha = r.sha; movies = r.list; store.set(K_LIST, movies); close(); render(); setSync("idle"); toast("Connected — changes are saved to movies.json"); }
    catch (x) { err.textContent = x.message; go.disabled = false; }
  } }, h("h2", {}, "Connect GitHub to edit"),
    h("p", { class: "hint" }, "Create a token at github.com/settings/personal-access-tokens/new — Repository access: only this repo, Permissions → Contents: Read and write. It is stored only in this browser."),
    h("label", {}, "Repository (owner/name)", repo), h("label", {}, "Branch", branch), h("label", {}, "Token", token), err,
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => close() }, "Cancel"), go)));
}
function openSettings() {
  const tm = h("input", { type: "text", value: keys.tmdb, placeholder: "optional — themoviedb.org API key (v3)", autocomplete: "off" }), om = h("input", { type: "text", value: keys.omdb, placeholder: "optional — omdbapi.com key", autocomplete: "off" });
  const close = modal("Settings", h("form", { onsubmit: (e) => { e.preventDefault(); keys = { tmdb: tm.value.trim(), omdb: om.value.trim() }; store.set(K_KEYS, keys); for (const n in health) Object.assign(health[n], { ok: 0, fail: 0, off: false }); close(); renderHealth(); render(); toast("Saved"); } },
    h("h2", {}, "Poster sources"),
    h("p", { class: "hint" }, "IMDb and Wikipedia work without any key. If posters still don't load on your network, add a free TMDB key (the most reliable source). Keys stay only in this browser."),
    h("label", {}, "TMDB API key", tm), h("label", {}, "OMDb API key", om),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => { for (const k of Object.keys(posterCache)) delete posterCache[k]; store.del(K_POST); toast("Poster cache cleared"); } }, "Clear poster cache"), h("button", { type: "button", onclick: () => close() }, "Cancel"), h("button", { class: "primary" }, "Save"))));
}

/* ---------- wiring ---------- */
$("#q").addEventListener("input", (e) => { filters.q = e.target.value; render(); });
$("#sort").addEventListener("change", (e) => { filters.sort = e.target.value; render(); });
$("#year").addEventListener("change", (e) => { filters.year = e.target.value; render(); });
$("#rated").addEventListener("change", (e) => { filters.rated = e.target.checked; render(); });
$("#add").addEventListener("click", () => openForm(null));
$("#settings").addEventListener("click", openSettings);
$("#connect").addEventListener("click", () => { if (cfg) { cfg = null; store.del(K_CFG); setSync("idle"); render(); } else openConnect(); });
$("#export").addEventListener("click", () => { const a = h("a", { href: URL.createObjectURL(new Blob([serialize(movies ?? [])], { type: "application/json" })), download: "movies.json" }); a.click(); URL.revokeObjectURL(a.href); });
$("#import").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const data = JSON.parse(await f.text()), rows = Array.isArray(data) ? data : data?.movies; if (!Array.isArray(rows)) throw new Error("Invalid file");
    const ids = new Set(movies.map((m) => m.imdbId).filter(Boolean)), keysSeen = new Set(movies.map((m) => `${m.title.toLowerCase()}|${m.releaseYear}`)), fresh = []; let dup = 0, bad = 0;
    for (const r of rows) { const v = validate(r); if (v.error) { bad++; continue; } const d = v.data, k = `${d.title.toLowerCase()}|${d.releaseYear}`; if ((d.imdbId && ids.has(d.imdbId)) || keysSeen.has(k)) { dup++; continue; } if (d.imdbId) ids.add(d.imdbId); keysSeen.add(k); fresh.push(d); }
    if (!fresh.length) return toast(`Nothing new to import (${dup} duplicates, ${bad} invalid)`, false);
    if (!confirm(`Import ${fresh.length} new movies? (${dup} duplicates skipped, ${bad} invalid)`)) return;
    const now = new Date().toISOString(); commit([...movies, ...fresh.map((d) => ({ ...d, id: uid(), createdAt: now }))]); toast(`Imported ${fresh.length} movies`);
  } catch (x) { toast(x.message, false); }
});

(async function init() {
  renderHealth(); setSync("idle"); movies = store.get(K_LIST, null); render();            // cached list first, instantly
  try {
    if (cfg) {
      try { const r = await fetchRemote(); sha = r.sha; movies = r.list; }
      catch (e) { // token / repo / branch problem: still show the public list, read-only, and say what is wrong
        cfg = null; setSync("idle"); toast(e.message + " — showing read-only. Click Connect GitHub and check repo, branch and token.", false);
        movies = await loadPublic();
      }
    } else movies = await loadPublic();
    store.set(K_LIST, movies);
  } catch (e) { movies ??= []; toast(e.message, false); }
  render();
})();
