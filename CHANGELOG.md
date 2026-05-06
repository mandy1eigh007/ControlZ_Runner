# Update Log

Running log of changes to RepoRunner. Newest first. Dates are session dates.

---

## Unreleased

_(planned — see todo list)_

---

## 2026-05-06 — P1-7: detect Django / ASGI / WSGI Python entry points

`detectPythonStart()` now recognizes three additional conventional layouts
between the streamlit check and the `app.py`/`main.py` fallbacks:

- `manage.py` → `python -u manage.py runserver 0.0.0.0:3000` (Django)
- `asgi.py` → `python -m uvicorn asgi:application --host 0.0.0.0 --port 3000`
- `wsgi.py` → `python -m gunicorn wsgi:application --bind 0.0.0.0:3000`

Both ASGI/WSGI launchers use `python -m` so we don't depend on the
`uvicorn`/`gunicorn` console script being on PATH (which depends on whether
the venv was activated correctly). Order matters: streamlit > Django >
ASGI > WSGI > generic `app.py` > `main.py` > `[project.scripts]`.

---

## 2026-05-06 — P1-6: pre-clone GitHub language detection

Added `fetchRepoLanguages(owner, name)` that calls `GET /repos/:o/:r/languages`
before the clone phase (5s timeout, honors optional `GITHUB_TOKEN` to dodge
the 60/hr unauth limit). Top-3 languages are surfaced as a status log line
(e.g. `→ GitHub languages: Python 84%, JavaScript 12%, CSS 4%`) and the full
sorted list is stashed on the per-sandbox `RunConfig.githubLanguages` for use
by later detection heuristics (P1-7) and the status pill (P2-10). Failure
modes (network, 404, rate-limit, abort) all return `null` silently — never
blocks the clone.

---

## 2026-05-06 — P0-FIX-3 / P0-FIX-4: avoid CUDA OOM + active hybrid port poll

LDR install OOM-killed the sandbox: `torch` from PyPI defaults pulled
~2GB of CUDA wheels (`nvidia-cublas`, `nvidia-cudnn-cu13`, `nvidia-cusparse`,
`triton`, etc.) which the e2b sandbox couldn't fit in memory. Vite + Flask
were both `Killed` mid-boot. Separately, even when Flask did boot it didn't
log a parseable `Running on http://...` line so we never rebound preview.

**P0-FIX-3 — CPU-only torch wheel:**
- New `detectHeavyMlDeps()` scans pyproject + requirements for top-level
  `torch` dep.
- When found, prepends a shell prefix to the Python install that:
  - sets `PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu`
  - sets `PIP_NO_CACHE_DIR=1`
  - pre-installs `torch` from the CPU index (~200MB, zero NVIDIA deps)
- Subsequent `pip install .` resolution finds torch already installed and
  skips the CUDA wheels entirely.

**P0-FIX-4 — active hybrid port poll:**
- After the primary command starts in hybrid mode, kick off a poller that
  curls `http://127.0.0.1:{5000,8000,8080,3000}/` every 5s for up to 3min.
- First port returning a non-empty body wins; preview rebinds with `force`.
- Complements (doesn't replace) log-based detection and the one-shot
  fallback timer; this catches Flask/Django apps with custom loggers
  (loguru, gunicorn workers, socketio.run) that don't emit a parseable
  startup line.

---

## 2026-05-06 — P0-FIX-2: hybrid Flask port rebind + smarter preview probe

LDR (Flask + Vite hybrid) preview was locking onto port 3000 (or whatever
the fallback timer found first) before Flask actually finished booting on
its real port (often 5000). Diagnostics fired against an empty body and the
iframe stayed blank.

- New `hybridMode` flag set when the Python+Vite branch is taken.
- `handleLine` now keeps watching for local URLs even after preview is set
  in hybrid mode; if a non-Vite local port (e.g. `http://127.0.0.1:5000`)
  appears later, the preview is force-rebound to that port.
- `sendPreview` accepts `{ force }` and resets the diagnostics latch so the
  new port is re-probed.
- Fallback timer doubles (75s → 150s) in hybrid mode to give Flask time to
  finish booting; fallback probe is now content-aware (curl-checks each
  candidate for a non-empty body before picking) and probes Flask/Django
  defaults `[5000, 8000, 3000, 8080, 5173]` first in hybrid mode.
- Diagnostics now wait up to 60s (12 × 5s polls) for the target port to
  return *any* HTTP status before probing — no more empty `--- body head ---`
  output when the app is still starting.

---

## 2026-05-06 — P0-FIX: auto-install required Python via uv

LDR pyproject declares `requires-python = ">=3.12,<3.15"`, but the e2b sandbox
ships with Python 3.11.6. `pip install .` failed with
`Package 'local-deep-research' requires a different Python: 3.11.6 not in '<3.15,>=3.12'`.

- `parseRequiresPythonMin()` extracts the lowest satisfying `X.Y` from
  `pyproject.toml`'s `requires-python`.
- `ensurePythonEnvPrefix(pyMin)` checks the sandbox's Python; if too old, it
  installs `uv`, runs `uv python install <pyver>`, creates a seeded venv at
  `~/.cache/repo-venv-<pyver>`, and returns a shell prefix that activates it.
- Pure-Python and hybrid Python+Vite branches now wrap install + start with
  the prefix when the version gate fires; install commands switched to
  `python -m pip install ...` so they target whichever python is on PATH.
- No-op when sandbox Python already satisfies the constraint.

---

## 2026-05-06 — P0-4 / P0-5: timeouts

Heavy Python repos (LDR, anything with sqlcipher / weasyprint / numpy)
were getting killed mid-`pip install` by the 5-minute install timeout, and
slow-booting servers (Flask with first-boot DB migrations) missed the
30-second preview-fallback window.

**Changes — [server/index.ts](server/index.ts):**

- `SANDBOX_TIMEOUT_MS`: **10 min → 30 min**. Required so a 15-minute
  Python install doesn't hit the hard sandbox-lifetime cap. Cost ceiling
  is still bounded.
- New `INSTALL_TIMEOUT_MS_NODE = 5 min`, `INSTALL_TIMEOUT_MS_PYTHON = 15 min`.
  Generic `INSTALL_TIMEOUT_MS` retained as the conservative default for
  branches that don't set their own.
- New `installTimeoutMs` variable, set per branch:
  - Pure Node: 5 min
  - Pure Python: 15 min
  - Hybrid Py+JS: npm install gets 5 min, pip install gets 15 min
    (set inline at each `commands.run` call since they're separate commands).
- Install phase now logs the chosen timeout (`→ Install timeout: 15m`).
- `PREVIEW_FALLBACK_MS`: **30 s → 75 s**. Covers Flask DB migrations,
  Django `manage.py migrate` on first boot, model loads, etc.

---

## 2026-05-06 — P0 bundle: stack picker, env vars, open-in-tab

Direct user-facing fix for the LDR white-screen scenario. Three coupled
features that together let a user pick the right stack, supply credentials,
and escape the iframe when CSP/X-Frame-Options blocks it.

**Changes — [server/index.ts](server/index.ts):**

- New `Stack` type and `VALID_STACKS` whitelist:
  `auto | node | python | static | rust | go | hybrid-py-node`.
- Refactored `/api/run` to capture `{url, customCommand, stack, envs}` from
  the request body and stash them in a new `runConfigs` map keyed by
  sandbox ID. `/stream` now reads from this map instead of accepting
  url/customCommand via query string.
  - Why: env values can be long and sensitive (API keys); keeping them out
    of URLs avoids access logs and proxy logs leaking them, and removes the
    URL-length ceiling.
- New `parseEnvBlock()` — parses `KEY=VALUE` per-line input from the UI:
  - Skips blanks and `#` comments
  - Strips matched surrounding quotes
  - Validates keys against POSIX env-var name regex
  - Caps at 64 entries / 8 KB per value as a basic DoS guard
- New `wantsStack()` gate in the detection cascade. Each branch's
  `else if` now requires the stack override to be `auto` or to match the
  branch's stack.
- Hybrid branch now responds to `stack=hybrid-py-node` as a *force*: takes
  the hybrid path even when `vite` isn't in deps (covers webpack/parcel).
  Errors clearly if no Python entry can be detected under force.
- User envs are merged into both the Vite background command and the
  primary start command (user envs win over the runner's defaults so users
  can override `PORT`, `HOST`, etc.). A status log line names the injected
  keys (values stay in memory only).
- `disposeSandbox()` now also clears the `runConfigs` entry on cleanup.

**Changes — [src/App.tsx](src/App.tsx):**

- New `Stack` type + `STACK_OPTIONS` table mirroring the backend whitelist.
- New state: `stack` (default `"auto"`), `envVars` (raw textarea string).
- `/api/run` POST body now includes `stack` and `envs`. `/stream`
  EventSource URL is now plain `/api/run/${sandboxId}/stream` — no query.
- Advanced panel restructured into three labeled sections:
  - **Stack** — pill-button group for all 7 options, with `title` tooltips.
  - **Custom start command** — same input as before, now properly labeled.
  - **Environment variables** — multi-line textarea, monospace, 4 rows,
    `KEY=VALUE` per line. Placeholder shows two realistic examples.
- New **Open ↗** button overlaid on the preview pane (top-right). Opens
  the preview URL in a new tab with `rel="noopener noreferrer"`. Tooltip
  explains it bypasses iframe restrictions like X-Frame-Options/CSP.

**Tested:** `tsc -b` passes clean for both `src/` and `server/`.

**Known limitations / follow-ups:**

- Env vars only inject into the start command, not into `git clone` or
  `pip install` / `npm install`. Most repos don't need install-time secrets,
  but private package registries (e.g. `PIP_INDEX_URL`) currently won't work.
  Track as a follow-up if it comes up.
- The "Open ↗" button shows even when the preview iframe loads fine. That's
  intentional — it's also useful for full-screen testing — but if it gets
  noisy we can hide it conditionally on detected CSP failures.
- Stack override is informational only in the UI; there's no read-back of
  what the backend actually detected. Status pill still shows generic
  states. Tracked as P2-10.

---

## 2026-05-05 — Hybrid Python+Vite detection

**Context:** Submitting `https://github.com/LearningCircuit/local-deep-research`
produced a white-screen iframe. Vite's dev server returned `404` at `/static/`
because the repo is a Flask + Vite hybrid: Vite is configured purely as an
asset server (`root: 'src/.../static'`, `base: '/static/'`) and the actual
HTML is rendered by Flask on port 5000.

The runner's stack detection used a first-match cascade
(`package.json` → `requirements.txt` → `pyproject.toml` → ...), so it always
picked Vite when both stacks were present and never tried the Python entry.

**Changes — [server/index.ts](server/index.ts):**

- Added `detectPythonStart()` helper. Resolution order:
  1. `streamlit_app.py` / `app.py` / `main.py` at repo root
  2. `pyproject.toml` `[project.scripts]` — parsed in-sandbox via
     `python3 -c` + `tomllib`, scored to prefer entries containing
     `web` / `serve` / `server` / `app` / `run` / `start`
- Added a hybrid Python+Vite branch inside the `package.json` arm. When
  triggered: installs both stacks, starts `npm run dev` in the background as
  an asset server, runs the Python entry as the primary preview. For
  local-deep-research this resolves to `pip install .` + `ldr-web`.
- Consolidated the duplicated `requirements.txt` / `pyproject.toml` arms into
  one branch that uses `detectPythonStart`.
- Added a 404 diagnostics hint: when Vite's base path returns 404 *and* no
  fallback path on the same port responds with anything other than 404, log
  a clear message explaining the Flask/Django+Vite hybrid pattern and point
  the user at the Advanced field.

**Known caveats:**

- LDR has heavy native deps (SQLCipher, WeasyPrint, libcairo/libpango).
  `pip install .` can still fail at the system-library layer in the e2b
  base sandbox. The new diagnostics make that failure mode legible.
- The hybrid branch sets `isVite = false` after starting Vite to redirect
  port-probing fallbacks to Flask defaults. This is a mutation hack —
  P1-9 in the todo list refactors it into a proper `primaryStack` enum.

---

## Earlier

See git history. Notable prior work:

- Modern-Node bootstrap in sandbox (downloads Node 24 tarball when sandbox
  Node is too old for Vite).
- In-sandbox host-rewriting reverse proxy for Vite repos that block the
  E2B preview host header.
- Preview-path 404 fallback (tries `/`, `/index.html`, etc. when the
  detected base path 404s).
- ANSI-stripping for log parsing.
- Full sandbox cleanup on Stop, SSE disconnect, 10-min timeout, SIGINT/SIGTERM.
