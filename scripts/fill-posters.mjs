// Runs in GitHub Actions (servers there can reach IMDb / Wikipedia). For every movie without a local poster it
// downloads the image INTO THE REPO (public/posters/<imdbId>.jpg) and points posterUrl at that file, so the site
// serves posters from github.io itself and the viewer's network never needs IMDb, Wikipedia or TMDB.
// Sources, in order: the poster URL already stored, IMDb, Wikipedia/Wikidata, TMDB (only if TMDB_API_KEY secret is set).
import fs from "node:fs";
const FILE = process.env.MOVIES_FILE || "public/movies.json", DIR = process.env.POSTER_DIR || "public/posters";
const rows = JSON.parse(fs.readFileSync(FILE, "utf8"));
fs.mkdirSync(DIR, { recursive: true });
const isLocal = (u) => typeof u === "string" && u.startsWith("public/posters/") && fs.existsSync(u);
const todo = rows.filter((m) => m.imdbId && (!isLocal(m.posterUrl) || m.title === m.imdbId));
console.log(`${rows.length} movies, ${todo.length} to fill`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 (compatible; movie-archive-bot/1.0)" };

async function getJson(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
      return r.ok ? await r.json() : null;
    } catch { await sleep(800); }
  }
  return null;
}
const qs = (base, p) => `${base}?${new URLSearchParams({ format: "json", ...p })}`;
const cleanTitle = (t) => t.replace(/\s*\((?:[^()]*\s)?film\)\s*$/i, "").trim();
const yearFromTitle = (t) => { const m = t?.match(/\((\d{4})\s+(?:[^()]*\s)?film\)\s*$/i); return m ? Number(m[1]) : null; };
const imdbImg = (u) => u.replace(/\._V1_.*\.jpg$/i, "._V1_UX400_.jpg");

// each source -> { title, year, posters: [url] }
async function fromImdb(id) {
  const x = ((await getJson(`https://v2.sg.media-imdb.com/suggestion/t/${id}.json`))?.d ?? []).find((d) => d.id === id);
  return x ? { title: x.l, year: x.y ?? null, posters: x.i?.imageUrl ? [imdbImg(x.i.imageUrl)] : [] } : null;
}
async function fromWiki(id) {
  const WD = "https://www.wikidata.org/w/api.php";
  const qid = (await getJson(qs(WD, { action: "query", list: "search", srsearch: `haswbstatement:P345=${id}`, srlimit: "1" })))?.query?.search?.[0]?.title; if (!qid) return null;
  const e = (await getJson(qs(WD, { action: "wbgetentities", ids: qid, props: "claims|sitelinks|labels", sitefilter: "enwiki", languages: "en" })))?.entities?.[qid]; if (!e) return null;
  const page = e.sitelinks?.enwiki?.title; let poster = null;
  if (page) { const w = await getJson(qs("https://en.wikipedia.org/w/api.php", { action: "query", titles: page, prop: "pageimages", piprop: "thumbnail", pithumbsize: "500", redirects: "1", origin: "*" })); poster = Object.values(w?.query?.pages ?? {})[0]?.thumbnail?.source ?? null; }
  const ys = (e.claims?.P577 ?? []).map((c) => String(c.mainsnak?.datavalue?.value?.time ?? "").match(/^\+?(\d{4})/)?.[1]).filter(Boolean).map(Number);
  return { title: e.labels?.en?.value ?? (page ? cleanTitle(page) : null), year: yearFromTitle(page) ?? (ys.length ? Math.min(...ys) : null), posters: poster ? [poster] : [] };
}
async function fromTmdb(id) {
  const k = process.env.TMDB_API_KEY; if (!k) return null;
  const r = (await getJson(`https://api.themoviedb.org/3/find/${id}?external_source=imdb_id&api_key=${encodeURIComponent(k)}`))?.movie_results?.[0];
  return r ? { title: r.title, year: Number((r.release_date ?? "").slice(0, 4)) || null, posters: r.poster_path ? [`https://image.tmdb.org/t/p/w500${r.poster_path}`] : [] } : null;
}
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
async function download(url, id) {
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      const type = (r.headers.get("content-type") ?? "").split(";")[0];
      if (!r.ok || !EXT[type]) continue;
      const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 1500) continue;
      const path = `${DIR}/${id}.${EXT[type]}`; fs.writeFileSync(path, buf); return path;
    } catch { await sleep(800); }
  }
  return null;
}

let filled = 0, noPoster = 0, next = 0;
async function worker() {
  while (next < todo.length) {
    const m = todo[next++]; let changed = false, path = null, meta = {};
    const urls = [];
    if (m.posterUrl && /^https?:/.test(m.posterUrl)) urls.push(m.posterUrl);
    for (const src of [fromImdb, fromWiki, fromTmdb]) {
      if (path) break;
      let r = null; try { r = await src(m.imdbId); } catch { /* try next */ }
      if (!r) continue;
      meta.title ??= r.title; meta.year ??= r.year;
      for (const u of [...urls.splice(0), ...r.posters]) { path = await download(u, m.imdbId); if (path) break; }
    }
    if (!path && urls.length) for (const u of urls) { path = await download(u, m.imdbId); if (path) break; }
    if (path) { m.posterUrl = path; changed = true; }
    if (m.title === m.imdbId && meta.title) { m.title = meta.title; if (meta.year) m.releaseYear = meta.year; changed = true; }
    changed ? filled++ : noPoster++;
    await sleep(80);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
console.log(`updated ${filled}, nothing found for ${noPoster}`);
if (filled) fs.writeFileSync(FILE, `[\n${rows.map((m) => JSON.stringify(m)).join(",\n")}\n]\n`);
