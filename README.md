# Movie Archive (plain HTML / CSS / JS)

No build step. Files: `index.html`, `style.css`, `app.js`, data in `public/movies.json` (keep your existing one).

## Install over the old Next.js version
1. Upload `index.html`, `style.css`, `app.js`, `README.md` and `.github/workflows/deploy.yml` to the repo root (replace the old deploy.yml).
2. **Do not overwrite `public/movies.json`** — it is your live database.
3. Delete the old files: `src/`, `scripts/`, `tests/`, `package.json`, `next.config.mjs`, `tailwind.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `tsconfig.tsbuildinfo`, and `.github/workflows/fill-posters.yml` (if you added it).
4. Settings → Pages → Source: **GitHub Actions**. Wait for the deploy, then open the site (hard refresh: Ctrl+F5).

## Editing
Click **Connect GitHub to edit** (repo `user/repo`, branch `main`, fine-grained token with Contents: Read and write). Add / edit / delete / import commit `public/movies.json`.

## Posters
Each poster is looked up when its card scrolls into view, trying in order: TMDB (only if you add a key in ⚙), IMDb, Wikipedia/Wikidata, OMDb (only with a key). A source your network can't reach is switched off automatically (see the "Poster sources" line under the header; click a source to retry). When connected to GitHub, the posters that were found are saved into `movies.json` in one commit, so next time they load instantly.
