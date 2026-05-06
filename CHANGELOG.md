# Update Log

Running log of changes to RepoRunner. Newest first. Dates are session dates.

---

## Unreleased

_(planned — see todo list)_

---

## 2026-05-06 — P0-FIX-8: process diagnostics dump on hang

When `ldr-web` (and other socketio.run-based apps) hangs after `create_app()`
without binding any port, the user just sees the backend poller report
"no ports listening yet" forever. We had no visibility into whether the
process was alive, dead, or stuck on something.

**Changes — [server/index.ts](server/index.ts):**

- New `dumpDiagnostics(label)` helper that runs inside the sandbox at
  T+30s, T+90s, T+180s after the Python start command launches (skipped
  if a preview URL already exists by then).
- Diagnostics include:
  - `ps -ef | grep` for python/node/gunicorn/uvicorn/uv/hypercorn/daphne/
    streamlit/gradio/flask processes (top 20)
  - Listening sockets via `ss -lntp` or `netstat -lntp` fallback
  - Tail of the last 10 lines of any `*.log` file in the repo modified
    in the last 5 minutes
- Output is prefixed with `→ Process diagnostics (30s):` so it's clearly
  scoped, and individual lines are sent as `stdout` events for proper
  formatting in the log pane.

Best-effort: any error in the diagnostic script is swallowed silently —
this never blocks or fails a run.

---

## 2026-05-06 — P0-FIX-7: extend backend poller to all Python stacks

After P0-FIX-6 made build-mode hybrids run as `python-pure`, we lost the
heartbeat poller (which was gated on `getHybridMode()`). LDR's `loguru`
backend never logs a parseable "Running on http://" line, so we'd sit in
silence for the full 75s fallback window with no preview.

**Changes — [server/index.ts](server/index.ts):**

- Backend poller now runs for `python-pure` AND `python-hybrid-vite`
  (previously hybrid-only). Renamed user-facing prefix from
  "Hybrid poller" → "Backend poller" since it's no longer hybrid-only.
- Same heartbeat / LOCAL_ONLY / external-IP probe behavior as before.

This means LDR-style apps (and any Flask/Django/Streamlit/Gradio that
suppresses startup banners) will now have their port detected actively
within 4-8s of the start command instead of waiting for the 75s fallback.

---

## 2026-05-06 — P0-FIX-6: prefer `npm run build` for hybrid Python+Vite

After five rounds of patches (P0-FIX..P0-FIX-5) trying to make Vite-dev +
Flask reach the iframe, we finally diagnosed the **structural** problem:
in dev mode Flask serves HTML on `:5000` containing `<script src="/static/...">`
tags pointing at Vite's `:5173`. In an e2b sandbox each port is a separate
`*.e2b.app` hostname, so every asset request inside the iframe is
**cross-origin** — CORS-blocks or 404s, regardless of which port we pick
or how cleverly we poll. No port-detection trick fixes a same-origin
violation.

**Fix:** when the hybrid repo has a `build` script, run it once and let
Flask serve the bundled assets itself. One origin, one port, one iframe
URL — no proxy, no port hunt, no diagnostics noise.

**Changes — [server/index.ts](server/index.ts):**

- New build-mode hybrid path inside the existing hybrid Python+Vite branch:
  1. `npm install`
  2. `<python install>` (existing)
  3. `npm run build --silent` (one-shot; failures are non-fatal)
  4. Skip starting Vite background; start the Python entry alone
  5. Mark stack as `python-pure` so the hybrid poller / dual-port preview
     UI don't kick in (we now have a single preview target).
- Falls back to the previous dev-mode behavior automatically when:
  - no `build` script exists in package.json, OR
  - the build fails (logged with `→ \`npm run build\` failed; falling
    back to dev-mode`).

This should make LDR (and the ~80% of Flask/Django+Vite repos that follow
the standard build-then-serve pattern) work end-to-end without further
tweaks.

---

## 2026-05-06 — P0-FIX-5: visible hybrid backend wait + wider port coverage

Hybrid runs (Python backend + Vite asset server) sometimes left the user
staring at a blank `:5173` preview for 30-90s with **zero log output** while
Flask finished booting. From the user's POV it looked like a hang.
Worse, when Flask did bind it often bound to `127.0.0.1` only — invisible
to the e2b preview proxy — and the runner had no way to detect or surface
this.

**Changes — [server/index.ts](server/index.ts):**

- Hybrid poller port list expanded:
  `[5000,8000,8080,3000]` → `[5000,5001,5050,8000,8080,3000,4000,7860,8501,8888]`
  (now covers Flask alt port, Gradio, Streamlit, Jupyter, common dev ports).
- First probe moved from 10s → 4s; interval 5s → 4s.
- Poll script now probes the **container's external link-local IP first**
  (e.g. `169.254.0.x` from `hostname -I`); only that path is reachable by
  the e2b preview proxy. A second pass tries `127.0.0.1` and reports
  `LOCAL_ONLY` so we can warn the user that the app bound to loopback only.
- New `LOCAL_ONLY` heartbeat: `→ Hybrid poller: Python backend listening
  on 127.0.0.1:NNNN but NOT on the container's external IP … set
  HOST=0.0.0.0 / LDR_HOST=0.0.0.0 / FLASK_RUN_HOST=0.0.0.0 in Advanced …`
- Poll script also lists TCP-open ports for progress hints.
- Heartbeat status line emitted on the **first probe** (so the user sees
  the new poller is alive) and every ~15s after that.
- When the 3-min poll window finally expires, emit a hint pointing at
  `Advanced > Environment variables` (`PORT=NNNN`) instead of silently
  giving up.
- Fallback-timer port list broadened to match the poller.

---

## 2026-05-06 — P2-14: categorized error messages

Top-level run failures are now categorized with actionable hints.

- The SSE `error` payload remains a string (UI-compatible), but is now formatted as:
  `[code] Title\nHint: …\nDetails: …`.
- Categories cover common cases like missing/invalid `E2B_API_KEY`, repo not found,
  missing entrypoints, install failures, timeouts, and OOM-kills (`Killed`).

---

## 2026-05-06 — P2-11: multi-port preview tabs (hybrid)

Hybrid repos (Python backend + Vite asset server) now surface multiple preview
targets instead of forcing a single iframe URL.

- Server emits a new typed `previews` SSE event: `{ options: [{port,url,label}], primaryPort }`.
  Options are recorded from discovered local URLs and from the known hybrid
  Vite port (:5173).
- UI renders compact tabs above the iframe when multiple options are present.
  By default it follows the server’s primary preview, but if you manually
  click a non-primary tab it keeps your selection until you click the primary
  tab again.

Hybrid runs now also seed the initial preview to Vite `:5173/static/` so the
iframe isn’t blank while the Python backend is still booting; the existing
hybrid poller continues to rebind to the backend as soon as it responds.

Preview diagnostics are now best-effort (no hard failure) to avoid confusing
`exit status 1` messages when a port is mid-boot or curl times out.

This includes the initial “wait for port to respond” step, which now fails
softly and logs `skipping probe` instead of surfacing an exception.

The readiness check also now handles curl connection failures correctly: curl
prints `000` for `%{http_code}` on connection errors, and the previous fallback
could accidentally append another `000` (yielding `000000`) and trigger an
early probe.

Finally, hybrid Vite previews are now more stable and less noisy:

- We seed `:5173` to `/` by default (many hybrids log `/static/` but serve the
  HTML entry at `/`).
- Diagnostics now tries to pick a working path before printing the full
  status+headers/body block, so you don’t see a guaranteed-404 probe first.
- Later Vite log URLs won’t overwrite the already-chosen `:5173` preview path,
  avoiding flip-flops between `/static/` and `/` depending on log order.

---

## 2026-05-06 — P2-12: quieter pip / npm install logs

Install commands now route stdout through a `quietPipLog()` filter that
drops the high-noise lines:

- `+ pkgname==1.2.3` per-package install confirmations (LDR alone produces
  ~260 of these)
- `Downloading X (NN MiB)` / `Downloaded X` per-file uv chatter
- `Collecting X` / `Downloading X-1.2.3-…whl` from pip
- `npm notice` upgrade nags

Lines containing `error|warning|traceback|failed|fatal|killed|cannot|unable`
are always kept. Summary lines (`Resolved N packages`, `Installed N
packages`, `Built foo`, `Building bar`) are always kept. Stderr is passed
through unfiltered. A heartbeat `… still installing (quieted N routine
lines so far)` is emitted every 8s when lines are being dropped, so long
silent installs don't look like a hang.

Wired into all three install paths: pure-Node, hybrid npm-then-pip, and
the generic `installCmd` path.

---

## 2026-05-06 — P2-13: recent-repos history (localStorage)

URL input now remembers up to 20 recently-used GitHub repos, persisted to
`localStorage` under `reporunner.recentRepos.v1`. Two ways to recall a URL:

1. The URL `<input>` is wired to a `<datalist>` so the browser shows native
   autocomplete as you type.
2. The most-recent 5 repos render as compact `owner/name` chips directly
   below the URL row — click to populate the input. A small `clear` button
   wipes history.

Push happens once a sandbox is successfully created (so failed/typo'd URLs
don't pollute history). Storage failures (private mode quotas, etc.) are
swallowed silently.

---

## 2026-05-06 — P2-10: status pill shows detected stack + preview port

Server now emits a typed `stack` SSE event from `setPrimaryStack()` carrying
both the stable enum value and a short human label (e.g. `"Python + Vite"`,
`"Vite"`, `"Python"`). The existing `preview` event payload now also includes
the bound port (`{ url, port }`).

`App.tsx` listens for both, stores `detectedStack` and `previewPort` state,
and renders two new emerald-bordered pills alongside the existing status
pill: `[detecting] [Python + Vite] [:5000]`. Pills are hidden until the
relevant signal arrives, so the layout doesn't flicker for non-web stacks.

---

## 2026-05-06 — P1-9: refactor isVite/hybridMode mutation into primaryStack enum

Replaced the two-boolean (`isVite`, `hybridMode`) state machine, which had to
be mutated mid-flow (`isVite = false; hybridMode = true;` once a hybrid
Python+Vite repo was detected), with an explicit `primaryStack` enum:

```
type PrimaryStack =
  | "unknown" | "node-vite" | "node-other" | "python-pure"
  | "python-hybrid-vite" | "static" | "rust" | "go" | "custom";
```

Single-assignment via a `setPrimaryStack()` helper that also emits a
`→ Primary stack: <name>` status log line so users can see which branch was
taken. `isVite` / `hybridMode` reads are now derived getters (`getIsVite()`,
`getHybridMode()`) — no behavior change, just clearer intent and easier
extension for upcoming P2 work (status pill, multi-port awareness).

---

## 2026-05-06 — P1-8: prefer `uv pip` for Python installs

Added a `PIP_SHIM_PREFIX` shell snippet that defines a `pip_install()` bash
function: when a venv is active and `uv` is on PATH (or can be lazily
installed via the official installer in ~5s), it routes `pip install` calls
through `uv pip install` (typically 10-100x faster, especially for large
dep graphs like LDR's). Falls back to `python -m pip install` cleanly when
no venv is active. Both Python install branches (hybrid + pure) now always
wrap their install command in `bashLc(... + PIP_SHIM_PREFIX + ...)` so the
shim is in scope. The CPU torch pre-install also routes through
`pip_install`. No behavior change when uv install fails — pip is always
the safety net.

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
