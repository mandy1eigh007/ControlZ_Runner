# RepoRunner

Paste any public GitHub URL → run it in an isolated cloud sandbox → see the live preview and logs streaming back, without installing anything locally.

![status](https://img.shields.io/badge/status-working-success)

## How it works

- **Frontend**: Vite + React + TypeScript + Tailwind on port 5173
- **Backend**: Express server on port 8787 that talks to [E2B](https://e2b.dev) sandboxes
- The frontend proxies `/api/*` to the backend; both run with one `npm run dev` command

When you submit a repo URL, the backend creates an E2B sandbox, clones the repo, auto-detects the stack (Node, Python, Rust, Go, static HTML), runs install + start commands, and streams logs back over Server-Sent Events. When a web server starts inside the sandbox, the public URL is loaded into a preview iframe.

## Quick start

```bash
# 1. Clone and install
git clone <your-repo-url> reporunner
cd reporunner
npm install

# 2. Add your E2B API key (get one at https://e2b.dev)
cp .env.example .env
# edit .env and paste your real key

# 3. Run both servers
npm run dev

# 4. Open http://localhost:5173
```

## Try it with these repos

- `https://github.com/expressjs/express` — Node lib; install + run, no preview
- Any small Vite React repo — install + dev server + live preview in iframe
- A simple Flask or FastAPI repo with `requirements.txt` and `app.py`
- A Rust CLI with `Cargo.toml`

If auto-detection fails, expand **Advanced** in the UI and paste a custom start command.

## Stack detection priority

1. `package.json` → `npm install` → `npm run dev` / `npm start` / `npm run serve`
2. `requirements.txt` → `pip install -r requirements.txt` → `streamlit_app.py` / `app.py` / `main.py`
3. `pyproject.toml` → `pip install .` → same Python entry detection
4. `Cargo.toml` → `cargo run`
5. `go.mod` → `go run .`
6. `index.html` only → `python3 -m http.server 3000`

A custom command from the Advanced field overrides detection entirely.

## Limits

- Public GitHub repos only (no auth-gated clones)
- Hard 10-minute timeout per sandbox
- E2B base sandbox doesn't have Docker-in-Docker, so `Dockerfile` is skipped
- Some repos won't run cleanly without env vars or a custom command — that's expected; use Advanced

## Architecture notes

- The browser **never** imports the E2B SDK; only `server/index.ts` does
- `E2B_API_KEY` lives only in the Express process via `process.env`
- E2B's `commands.run` callbacks receive a `string` (verified against the v2 SDK types)
- `getHost(port)` is synchronous
- SSE heartbeat every 15s prevents proxies from timing out long installs
- Sandboxes are killed when: the user clicks Stop, the SSE connection drops (tab closed), the 10-min timeout fires, or the server shuts down (SIGINT/SIGTERM). No leaked sandboxes burning credits.
- Vite-specific repos get `--host 0.0.0.0` appended and `__VITE_ADDITIONAL_*_ALLOWED_HOSTS` env vars set so the E2B preview URL isn't blocked

## Hybrid (Python + Vite) notes

Some repos run a **Python backend** plus a **Vite dev server** (often as an asset server).

- RepoRunner surfaces multiple preview targets (tabs) when it detects multiple ports.
- Vite’s logged “base path” can be misleading. For example, a Vite server may:
	- log `http://localhost:5173/static/`
	- redirect `/` → `/static/` (302)
	- but still return 404 on `/static/`

RepoRunner seeds the initial Vite preview to `/` and uses best-effort diagnostics to pick a working path when the first choice 404s.

## Deploying

Frontend: any static host (Vercel, Netlify, Cloudflare Pages) — `npm run build` produces a static `dist/`.

Backend: any Node host (Render, Railway, Fly.io). Set `E2B_API_KEY` in the host's environment and make sure the frontend's API base points to your deployed backend URL.

## License

MIT
