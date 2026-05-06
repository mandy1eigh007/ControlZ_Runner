import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { Sandbox } from "e2b";

const PORT = 8787;
// Hard sandbox lifetime cap. Long enough to allow heavy Python installs
// (sqlcipher / cairo / weasyprint can take 10+ minutes on a cold sandbox)
// while still bounding cost if a user closes the tab.
const SANDBOX_TIMEOUT_MS = 30 * 60_000;
// Per-install timeouts. Python is intentionally larger because compiled
// wheels (numpy, sqlcipher, weasyprint) frequently exceed 5 minutes from
// a cold sandbox. Node installs are fast (npm registry + prebuilt deps).
const INSTALL_TIMEOUT_MS_NODE = 5 * 60_000;
const INSTALL_TIMEOUT_MS_PYTHON = 15 * 60_000;
// Generic fallback used when stack is unknown or for non-install commands.
const INSTALL_TIMEOUT_MS = 5 * 60_000;
// Wait this long after the start command before optimistically probing
// common ports. Flask apps with first-boot DB migrations or model loads
// regularly take >30s.
const PREVIEW_FALLBACK_MS = 75_000;

const app = express();
app.use(cors());
app.use(express.json());

const sandboxes = new Map<string, Sandbox>();
const sandboxTimers = new Map<string, NodeJS.Timeout>();

// Per-sandbox run config captured at /api/run time. /stream reads from here
// rather than re-accepting these via query params, which keeps env values
// (potentially long, potentially sensitive) out of URLs and access logs.
type Stack = "auto" | "node" | "python" | "static" | "rust" | "go" | "hybrid-py-node";
const VALID_STACKS: Stack[] = ["auto", "node", "python", "static", "rust", "go", "hybrid-py-node"];
type RunConfig = {
  url: string;
  customCommand: string;
  stack: Stack;
  envs: Record<string, string>;
};
const runConfigs = new Map<string, RunConfig>();

// Parse a `KEY=VALUE` per-line block from the UI into an env map.
// - Skips blank lines and `#` comments
// - Strips surrounding single/double quotes around values
// - Validates keys against POSIX env var name rules
// - Caps total entries to avoid DoS
function parseEnvBlock(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  const out: Record<string, string> = {};
  const MAX_ENTRIES = 64;
  const MAX_VALUE_LEN = 8192;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.length > MAX_VALUE_LEN) continue;
    out[key] = value;
    if (Object.keys(out).length >= MAX_ENTRIES) break;
  }
  return out;
}

function getNormalizedE2BApiKey(): { ok: true; value: string } | { ok: false; reason: string } {
  const raw = process.env.E2B_API_KEY;
  if (!raw) return { ok: false, reason: "missing" };

  // Common copy/paste issues that break the Authorization header:
  // - trailing newline(s)
  // - surrounding quotes
  // - leading/trailing whitespace
  let value = raw.replace(/\r?\n/g, "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  if (!value) return { ok: false, reason: "empty" };
  if (/\s/.test(value)) {
    // Still contains whitespace (space/tab/etc.) after normalization.
    return { ok: false, reason: "contains-whitespace" };
  }
  return { ok: true, value };
}

function isValidGitHubUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(url);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "").replace(/\.git$/, "");
}

// Centralized cleanup so we never double-kill or leak timers.
async function disposeSandbox(sandboxId: string) {
  const sbx = sandboxes.get(sandboxId);
  if (sbx) {
    sandboxes.delete(sandboxId);
    try {
      await sbx.kill();
    } catch {
      // already dead, ignore
    }
  }
  const timer = sandboxTimers.get(sandboxId);
  if (timer) {
    clearTimeout(timer);
    sandboxTimers.delete(sandboxId);
  }
  runConfigs.delete(sandboxId);
}

app.post("/api/run", async (req: Request, res: Response) => {
  try {
    const { url, customCommand, stack, envs } = req.body as {
      url?: string;
      customCommand?: string;
      stack?: string;
      envs?: string;
    };
    if (!url || !isValidGitHubUrl(url)) {
      return res.status(400).json({ error: "Invalid GitHub URL" });
    }
    const stackChoice: Stack =
      typeof stack === "string" && (VALID_STACKS as string[]).includes(stack)
        ? (stack as Stack)
        : "auto";
    const parsedEnvs = parseEnvBlock(envs);
    const key = getNormalizedE2BApiKey();
    if (!key.ok) {
      const hint =
        key.reason === "missing" ? "Set E2B_API_KEY in .env and restart the backend."
        : key.reason === "contains-whitespace" ? "Remove quotes/whitespace/newlines from E2B_API_KEY in .env and restart."
        : "Check E2B_API_KEY in .env and restart.";
      return res.status(500).json({ error: `Server missing/invalid E2B_API_KEY (${key.reason}). ${hint}` });
    }
    const sbx = await Sandbox.create({
      apiKey: key.value,
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    sandboxes.set(sbx.sandboxId, sbx);
    runConfigs.set(sbx.sandboxId, {
      url: normalizeUrl(url),
      customCommand: (customCommand ?? "").trim(),
      stack: stackChoice,
      envs: parsedEnvs,
    });

    // Hard kill timer — fires after 10 min regardless of activity.
    const timer = setTimeout(() => {
      void disposeSandbox(sbx.sandboxId);
    }, SANDBOX_TIMEOUT_MS);
    sandboxTimers.set(sbx.sandboxId, timer);

    res.json({ sandboxId: sbx.sandboxId });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});

app.get(
  "/api/run/:sandboxId/stream",
  async (req: Request, res: Response) => {
    const sandboxId = req.params.sandboxId;
    const sbx = sandboxes.get(sandboxId);
    if (!sbx) {
      res.status(404).json({ error: "Sandbox not found" });
      return;
    }
    const cfg = runConfigs.get(sandboxId);
    if (!cfg) {
      res.status(404).json({ error: "Run config not found for sandbox" });
      return;
    }
    const url = cfg.url;
    const customCommand = cfg.customCommand;
    const stackOverride: Stack = cfg.stack;
    const userEnvs: Record<string, string> = cfg.envs;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let closed = false;
    const send = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: ping\n\n`);
    }, 15_000);

    // Client closed the tab / disconnected — kill the sandbox so we
    // don't burn E2B credits on a sandbox no one is watching.
    req.on("close", () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void disposeSandbox(sandboxId);
    });

    // ★★★ CRITICAL: e2b SDK passes a STRING to onStdout/onStderr.
    // Type signature: onStdout?: (data: string) => void | Promise<void>
    // Do NOT write `data.line` or `msg.line` — that returns undefined.
    const log =
      (stream: "stdout" | "stderr") =>
      (data: string) =>
        send("log", { stream, line: data });
    const status = (s: string) => send("status", s);
    const errorAndEnd = (msg: string) => {
      send("error", msg);
      clearInterval(heartbeat);
      closed = true;
      try {
        res.end();
      } catch {}
      void disposeSandbox(sandboxId);
    };

    try {
      // PHASE 1 — clone
      status("cloning");
      send("log", { stream: "status", line: `→ Cloning ${url}` });
      const clone = await sbx.commands.run(
        `git clone --depth 1 ${JSON.stringify(url)} /home/user/repo`,
        { onStdout: log("stdout"), onStderr: log("stderr") },
      );
      if (clone.exitCode !== 0) {
        return errorAndEnd("Repository not found or not public");
      }

      // PHASE 2 — detect
      status("detecting");
      const has = async (p: string) => {
        const r = await sbx.commands.run(
          `test -e /home/user/repo/${p} && echo yes || echo no`,
        );
        return r.stdout.trim() === "yes";
      };

      const repoHasAny = async (findExpr: string) => {
        const r = await sbx.commands.run(
          `sh -lc ${JSON.stringify(
            `find /home/user/repo -maxdepth 4 -type f ${findExpr} -print -quit`,
          )}`,
        );
        return r.stdout.trim().length > 0;
      };

      const looksDocsOnly = async () => {
        const hasDocs =
          (await has("README.md")) ||
          (await repoHasAny("\\( -iname 'readme*' -o -name '*.md' \\)"));
        if (!hasDocs) return false;

        const hasCode = await repoHasAny(
          "\\( " +
            [
              "-name '*.ts'",
              "-name '*.tsx'",
              "-name '*.js'",
              "-name '*.jsx'",
              "-name '*.mjs'",
              "-name '*.cjs'",
              "-name '*.py'",
              "-name '*.go'",
              "-name '*.rs'",
              "-name '*.java'",
              "-name '*.cs'",
              "-name '*.php'",
              "-name '*.rb'",
              "-name '*.sh'",
              "-name '*.ps1'",
            ].join(" -o ") +
            " \\)",
        );

        return !hasCode;
      };

      let installCmd: string | null = null;
      let startCmd: string | null = null;
      let isVite = false;
      // Per-install timeout, chosen by the branch that owns the install.
      // Defaults to the conservative generic value; overridden below.
      let installTimeoutMs = INSTALL_TIMEOUT_MS;

      const shellSingleQuote = (value: string) => {
        // Wrap in single quotes and escape embedded single quotes safely.
        // e.g. abc'def -> 'abc'"'"'def'
        return `'${value.replace(/'/g, `'"'"'`)}'`;
      };

      const bashLc = (script: string) => `bash -lc ${shellSingleQuote(script)}`;

      const parseNodeVersion = (v: string) => {
        const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
        if (!m) return null;
        return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
      };

      const isViteCompatibleNode = (v: { major: number; minor: number; patch: number }) => {
        // Vite currently requires Node >= 20.19 or >= 22.12.
        if (v.major > 22) return true;
        if (v.major === 22) return v.minor >= 12;
        if (v.major === 20) return v.minor >= 19;
        return false;
      };

      const parseEnginesNodeMajor = (enginesNode: unknown): number | null => {
        if (typeof enginesNode !== "string") return null;
        // Very small heuristic: grab the first major in a ">=24" or "24.x" style range.
        const m = enginesNode.match(/(\d{2})(?:\.|\s|$)/);
        return m ? Number(m[1]) : null;
      };

      const ensureModernNodePrefix = async (reason: string): Promise<string> => {
        // Avoid nvm in the sandbox (often not persisted / not sourced). Instead,
        // download a prebuilt Node tarball and prepend it to PATH.
        const desiredNode = "24.14.0";

        const v = await sbx.commands.run(bashLc("node -v 2>/dev/null || true"));
        const parsed = parseNodeVersion(v.stdout);
        if (parsed && isViteCompatibleNode(parsed)) {
          return "";
        }

        send("log", {
          stream: "status",
          line: `→ Upgrading Node in sandbox (${reason}; found ${v.stdout.trim() || "unknown"})`,
        });

        const script = [
          "set -e",
          'export HOME="${HOME:-/home/user}"',
          `nodeVer="${desiredNode}"`,
          'arch="$(uname -m)"',
          'case "$arch" in x86_64|amd64) nodeArch="x64" ;; aarch64|arm64) nodeArch="arm64" ;; *) echo "Unsupported arch: $arch" 1>&2; exit 1 ;; esac',
          'cache="$HOME/.cache"',
          'dir="$cache/node-v${nodeVer}-linux-${nodeArch}"',
          'if [ ! -x "$dir/bin/node" ]; then',
          '  mkdir -p "$cache"',
          '  tmp="$(mktemp -d)"',
          '  url="https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-linux-${nodeArch}.tar.xz"',
          '  echo "Downloading $url"',
          '  curl -fsSL "$url" -o "$tmp/node.tar.xz"',
          '  tar -xJf "$tmp/node.tar.xz" -C "$tmp"',
          '  rm -rf "$dir"',
          '  mv "$tmp/node-v${nodeVer}-linux-${nodeArch}" "$dir"',
          '  rm -rf "$tmp"',
          'fi',
          'export PATH="$dir/bin:$PATH"',
          'node -v',
          'npm -v >/dev/null 2>&1 || true',
        ].join("\n");

        return script + "\n";
      };

      // Parse pyproject.toml's `requires-python` and return the lowest
      // satisfying X.Y string (e.g. ">=3.12,<3.15" -> "3.12"). Returns null
      // if absent or unparseable.
      const parseRequiresPythonMin = (text: string): string | null => {
        const m = text.match(/requires[-_]python\s*=\s*["']([^"']+)["']/i);
        if (!m) return null;
        const spec = m[1];
        const pick = spec.match(/>=\s*(\d+)\.(\d+)/) || spec.match(/~=\s*(\d+)\.(\d+)/);
        return pick ? `${pick[1]}.${pick[2]}` : null;
      };

      const compareVersion = (a: string, b: string) => {
        const pa = a.split(".").map((n) => Number(n) || 0);
        const pb = b.split(".").map((n) => Number(n) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const x = pa[i] || 0;
          const y = pb[i] || 0;
          if (x !== y) return x - y;
        }
        return 0;
      };

      // If the repo's pyproject requires a newer Python than the sandbox
      // ships with, install uv + the requested Python version, create a
      // venv, and return a shell prefix that activates it. Returns "" if
      // no upgrade is needed.
      const ensurePythonEnvPrefix = async (pyMin?: string | null): Promise<string> => {
        if (!pyMin) return "";
        const v = await sbx.commands.run(
          `python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true`,
        );
        const cur = (v.stdout || "").trim();
        if (cur && compareVersion(cur, pyMin) >= 0) return "";

        send("log", {
          stream: "status",
          line: `→ Upgrading Python in sandbox (need >=${pyMin}; found ${cur || "unknown"}). Installing via uv.`,
        });

        const script = [
          "set -e",
          'export HOME="${HOME:-/home/user}"',
          'export PATH="$HOME/.local/bin:$PATH"',
          "if ! command -v uv >/dev/null 2>&1; then",
          "  curl -LsSf https://astral.sh/uv/install.sh | sh",
          '  export PATH="$HOME/.local/bin:$PATH"',
          "fi",
          `pyver="${pyMin}"`,
          'uv python install "$pyver"',
          'venv="$HOME/.cache/repo-venv-${pyver}"',
          'if [ ! -x "$venv/bin/python" ]; then',
          '  uv venv "$venv" --python "$pyver" --seed',
          "fi",
          '. "$venv/bin/activate"',
          'export VIRTUAL_ENV="$venv"',
          'export PATH="$venv/bin:$PATH"',
          "python --version",
        ].join("\n");
        return script + "\n";
      };

      // Detect a Python install + start command pair. Used by both the
      // pure-Python branch and the hybrid Python+Vite branch.
      // Resolution order:
      //   1. streamlit_app.py / app.py / main.py at repo root
      //   2. pyproject.toml [project.scripts] — pick a "web/serve/app/run"-ish
      //      script if available, else the first one. After `pip install .`,
      //      the script is on PATH.
      const detectPythonStart = async (): Promise<
        { install: string; start: string; pyMin: string | null } | null
      > => {
        let install: string | null = null;
        if (await has("requirements.txt")) {
          install = "python -m pip install -r requirements.txt";
        } else if (await has("pyproject.toml")) {
          install = "python -m pip install .";
        } else {
          return null;
        }

        let pyMin: string | null = null;
        if (await has("pyproject.toml")) {
          try {
            const text = await sbx.files.read("/home/user/repo/pyproject.toml");
            pyMin = parseRequiresPythonMin(text);
          } catch {
            // ignore — pyMin stays null
          }
        }

        if (await has("streamlit_app.py")) {
          return {
            install,
            start:
              "streamlit run streamlit_app.py --server.port 3000 --server.address 0.0.0.0 --server.headless true",
            pyMin,
          };
        }
        if (await has("app.py")) return { install, start: "python -u app.py", pyMin };
        if (await has("main.py")) return { install, start: "python -u main.py", pyMin };

        if (await has("pyproject.toml")) {
          // Parse [project.scripts] inside the sandbox via Python (tomllib).
          const pyScript = [
            "import sys",
            "try:",
            "    import tomllib",
            "except ImportError:",
            "    import tomli as tomllib  # type: ignore",
            "with open('/home/user/repo/pyproject.toml', 'rb') as f:",
            "    d = tomllib.load(f)",
            "scripts = ((d.get('project') or {}).get('scripts')) or {}",
            "keys = list(scripts.keys())",
            "def score(k):",
            "    kl = k.lower()",
            "    for w in ('web', 'serve', 'server', 'app', 'run', 'start'):",
            "        if w in kl: return 0",
            "    return 1",
            "keys.sort(key=score)",
            "print(keys[0] if keys else '')",
          ].join("\n");
          try {
            const r = await sbx.commands.run(
              `python3 -c ${shellSingleQuote(pyScript)}`,
            );
            // Plain `python3 -c` output — no ANSI codes to strip.
            const name = (r.stdout || "").trim();
            if (name && /^[A-Za-z0-9._-]+$/.test(name)) {
              return { install, start: name, pyMin };
            }
          } catch {
            // tomllib unavailable (Python <3.11 with no tomli); fall through.
          }
        }

        return null;
      };

      // Stack override gate: if the user selected a specific stack, only that
      // branch (and "auto") will match. "hybrid-py-node" is special-cased
      // inside the Node branch.
      const wantsStack = (...kinds: Stack[]): boolean =>
        stackOverride === "auto" || kinds.includes(stackOverride);

      if (stackOverride !== "auto") {
        send("log", {
          stream: "status",
          line: `→ Stack override: ${stackOverride} (auto-detection skipped)`,
        });
      }

      if (customCommand) {
        startCmd = customCommand;
      } else if (wantsStack("node", "hybrid-py-node") && (await has("package.json"))) {
        installCmd = "npm install --no-audit --no-fund --loglevel=error";
        const pkgText = await sbx.files.read("/home/user/repo/package.json");
        let pkg: any = {};
        try {
          pkg = JSON.parse(pkgText);
        } catch {}
        const scripts = pkg.scripts || {};
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };
        isVite = "vite" in allDeps;

        const enginesMajor = parseEnginesNodeMajor(pkg?.engines?.node);
        const needsModernNode = isVite || (typeof enginesMajor === "number" && enginesMajor >= 24);
        const nodePrefix = needsModernNode
          ? await ensureModernNodePrefix(
              isVite
                ? "Vite requires newer Node"
                : `package.json engines.node suggests >=${enginesMajor}`,
            )
          : "";

        // Hybrid Python + Vite (e.g. Flask + Vite asset server). Vite alone
        // serves no index.html in these repos — the Python backend renders
        // HTML and pulls JS/CSS modules from the Vite dev server. Detect
        // this case and run Python as the primary preview, with Vite as a
        // background asset server.
        // When the user explicitly forced "hybrid-py-node", we always take
        // this branch even if Vite isn't in deps (covers webpack/parcel/etc.
        // hybrids — npm run dev still runs whatever the repo configured).
        const hasPython =
          (await has("pyproject.toml")) || (await has("requirements.txt"));
        const forceHybrid = stackOverride === "hybrid-py-node";
        const hybridPy =
          (forceHybrid || isVite) && hasPython
            ? await detectPythonStart()
            : null;
        if (forceHybrid && !hybridPy) {
          return errorAndEnd(
            "Stack=hybrid-py-node but no Python entry found. Add app.py / main.py / streamlit_app.py at repo root, or define [project.scripts] in pyproject.toml, or use Advanced.",
          );
        }

        if (hybridPy) {
          send("log", {
            stream: "status",
            line: "→ Detected hybrid Python + Vite repo: running Python backend as primary, Vite as background asset server.",
          });

          status("installing");
          const npmInstall = bashLc(
            nodePrefix + "npm install --no-audit --no-fund --loglevel=error",
          );
          const ni = await sbx.commands.run(npmInstall, {
            cwd: "/home/user/repo",
            onStdout: log("stdout"),
            onStderr: log("stderr"),
            timeoutMs: INSTALL_TIMEOUT_MS_NODE,
          });
          if (ni.exitCode !== 0) {
            return errorAndEnd("npm install failed. See logs above.");
          }

          const pyPrefix = await ensurePythonEnvPrefix(hybridPy.pyMin);
          const pyInstall = pyPrefix
            ? bashLc(pyPrefix + hybridPy.install)
            : hybridPy.install;
          const pi = await sbx.commands.run(pyInstall, {
            cwd: "/home/user/repo",
            onStdout: log("stdout"),
            onStderr: log("stderr"),
            timeoutMs: INSTALL_TIMEOUT_MS_PYTHON,
          });
          if (pi.exitCode !== 0) {
            return errorAndEnd(
              "Python install failed. See logs above. The repo's Python deps may need system libraries not present in the sandbox; try Advanced with a custom command.",
            );
          }

          // Start Vite dev server in the background (asset server only).
          const viteCmd = bashLc(
            nodePrefix + "npm run dev -- --host 0.0.0.0",
          );
          await sbx.commands.run(viteCmd, {
            background: true,
            cwd: "/home/user/repo",
            envs: {
              HOST: "0.0.0.0",
              __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b.app",
              __VITE_ADDITIONAL_PREVIEW_ALLOWED_HOSTS: ".e2b.app",
              ...userEnvs,
            },
            onStdout: (d) =>
              send("log", { stream: "stdout", line: `[vite] ${d}` }),
            onStderr: (d) =>
              send("log", { stream: "stderr", line: `[vite] ${d}` }),
          });
          send("log", {
            stream: "status",
            line: "→ Vite dev server started in background on :5173",
          });

          // Skip the regular install phase below; primary command is Python.
          installCmd = null;
          startCmd = pyPrefix
            ? bashLc(pyPrefix + hybridPy.start)
            : hybridPy.start;
          // Fallback port probing should prefer Flask defaults, not Vite's.
          isVite = false;
        } else {
          // For Vite, append --host 0.0.0.0 so it binds to all interfaces.
          // For other Node frameworks, HOST=0.0.0.0 env var handles it.
          const viteSuffix = isVite ? " -- --host 0.0.0.0" : "";
          if (scripts.dev) {
            startCmd = "npm run dev" + viteSuffix;
          } else if (scripts.start) {
            startCmd = "npm start";
          } else if (scripts.serve) {
            startCmd = "npm run serve" + viteSuffix;
          } else {
            return errorAndEnd("package.json has no dev/start/serve script");
          }

          // Ensure both install + start run under the modern Node if we upgraded.
          if (nodePrefix) {
            installCmd = bashLc(nodePrefix + installCmd);
            startCmd = bashLc(nodePrefix + startCmd);
          }
          installTimeoutMs = INSTALL_TIMEOUT_MS_NODE;
        }
      } else if (wantsStack("python") && ((await has("requirements.txt")) || (await has("pyproject.toml")))) {
        const py = await detectPythonStart();
        if (!py) {
          return errorAndEnd(
            (await has("requirements.txt"))
              ? "requirements.txt found but no app.py/main.py/streamlit_app.py and no [project.scripts] entry"
              : "pyproject.toml found but no app.py/main.py/streamlit_app.py and no [project.scripts] entry",
          );
        }
        const pyPrefix = await ensurePythonEnvPrefix(py.pyMin);
        installCmd = pyPrefix ? bashLc(pyPrefix + py.install) : py.install;
        startCmd = pyPrefix ? bashLc(pyPrefix + py.start) : py.start;
        installTimeoutMs = INSTALL_TIMEOUT_MS_PYTHON;
      } else if (wantsStack("rust") && (await has("Cargo.toml"))) {
        startCmd = "cargo run";
      } else if (wantsStack("go") && (await has("go.mod"))) {
        startCmd = "go run .";
      } else if (wantsStack("static") && (await has("index.html")) && !(await has("package.json"))) {
        startCmd = "python3 -m http.server 3000 --bind 0.0.0.0";
      } else {
        if (stackOverride !== "auto") {
          return errorAndEnd(
            `Stack=${stackOverride} but no matching project files were found in the repo. Try Auto or Advanced with a custom command.`,
          );
        }
        if (await looksDocsOnly()) {
          startCmd = "python3 -m http.server 3000 --bind 0.0.0.0";
        } else {
          return errorAndEnd(
            "Could not detect how to run this repo. Use Advanced to provide a custom start command.",
          );
        }
      }

      send("log", { stream: "status", line: `→ Will run: ${startCmd}` });

      // PHASE 3 — install
      if (installCmd) {
        status("installing");
        send("log", {
          stream: "status",
          line: `→ Install timeout: ${Math.round(installTimeoutMs / 60_000)}m`,
        });
        const ins = await sbx.commands.run(installCmd, {
          cwd: "/home/user/repo",
          onStdout: log("stdout"),
          onStderr: log("stderr"),
          timeoutMs: installTimeoutMs,
        });
        if (ins.exitCode !== 0) {
          return errorAndEnd("Install failed. See logs above.");
        }
      }

      // PHASE 4 — run + port detection
      status("running");
      let previewUrl: string | null = null;
      const portRegexes = [
        /(?:listening|running|server started|ready|started server).{0,40}?(?:port|:)\s*(\d{2,5})/i,
        /Uvicorn running on https?:\/\/[^:]+:(\d{2,5})/i,
        /You can now view .* in your browser.{0,80}?:(\d{2,5})/i,
      ];

      const stripAnsi = (text: string) =>
        text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

      const normalizeBasePath = (p?: string) => {
        if (!p) return "";
        // Keep only a path part, no spaces. Ensure leading slash.
        const path = stripAnsi(p).trim();
        if (!path) return "";
        if (!path.startsWith("/")) return "/" + path;
        return path;
      };

      const buildPreviewUrl = (port: number, basePath?: string) => {
        if (port < 1 || port > 65535) return null;
        const host = sbx.getHost(port); // SYNC
        const path = normalizeBasePath(basePath);
        return `https://${host}${path}`;
      };

      let previewDiagnosed = false;
      const runPreviewDiagnostics = (port: number, basePath?: string) => {
        if (previewDiagnosed || closed) return;
        previewDiagnosed = true;

        const path = normalizeBasePath(basePath) || "/";
        const safePath = path.startsWith("/") ? path : `/${path}`;
        const target = `http://127.0.0.1:${port}${safePath}`;

        void (async () => {
          try {
            send("log", {
              stream: "status",
              line: `→ Preview diagnostics: probing ${target}`,
            });

            const script = [
              "set -e",
              "command -v curl >/dev/null 2>&1 || { echo 'curl not available'; exit 0; }",
              `echo '--- status+headers ---'`,
              `curl -sS -L -D - -o /dev/null --max-time 5 ${JSON.stringify(target)} | sed -n '1,40p'`,
              `echo '--- key headers ---'`,
              `curl -sS -L -D - -o /dev/null --max-time 5 ${JSON.stringify(target)} | awk 'BEGIN{IGNORECASE=1} /^(x-frame-options|content-security-policy|cross-origin-opener-policy|cross-origin-embedder-policy|cross-origin-resource-policy|x-content-type-options|location|content-type):/ {print}'`,
              `echo '--- body head (first 400 bytes) ---'`,
              `curl -sS -L --max-time 5 ${JSON.stringify(target)} | head -c 400 | tr '\n' ' '`,
              `echo`,
            ].join("\n");

            const out = await sbx.commands.run(bashLc(script));
            const text = stripAnsi(out.stdout || "").trim();
            if (text) {
              for (const line of text.split(/\r?\n/)) {
                send("log", { stream: "status", line: `→ ${line}` });
              }
            }

            // If the detected base path isn't actually served, fall back to a
            // more likely entry point (usually `/` for Vite dev servers).
            const statusLine = (text.split(/\r?\n/).find((l) => /^HTTP\//.test(l)) || "").trim();
            const is404 = /\s404\s/.test(statusLine);
            if (is404 && safePath !== "/") {
              const trimmed = safePath.endsWith("/") ? safePath.slice(0, -1) : safePath;
              const candidates = Array.from(
                new Set([
                  safePath,
                  trimmed,
                  trimmed ? `${trimmed}/` : "/",
                  trimmed ? `${trimmed}/index.html` : "/index.html",
                  "/",
                  "/index.html",
                ]),
              ).filter(Boolean);

              const pickScript = [
                "set -e",
                `base=${JSON.stringify(`http://127.0.0.1:${port}`)}`,
                `for p in ${candidates.map((c) => JSON.stringify(c)).join(" ")}; do` +
                  " code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 \"$base$p\" || echo 000);" +
                  " if [ \"$code\" != \"404\" ] && [ \"$code\" != \"000\" ]; then echo $p; exit 0; fi;" +
                  " done; exit 1",
              ].join("\n");

              try {
                const pick = await sbx.commands.run(bashLc(pickScript));
                const pickedPath = stripAnsi(pick.stdout || "").trim();
                if (pickedPath && pickedPath !== safePath) {
                  const fixedUrl = buildPreviewUrl(port, pickedPath);
                  if (fixedUrl) {
                    send("log", {
                      stream: "status",
                      line: `→ Preview path fallback: ${safePath} returned 404; switching to ${pickedPath}`,
                    });
                    sendPreviewUrl(fixedUrl, { force: true });
                  }
                } else if (!pickedPath && isVite) {
                  // Vite returned 404 on its base path AND no other path on
                  // this port responded with anything other than 404. This
                  // is the classic Flask/Django + Vite hybrid signature:
                  // Vite is configured as an asset server only and the
                  // actual app lives in the Python backend on another port.
                  send("log", {
                    stream: "status",
                    line: `→ Hint: ${safePath} returned 404 and no other path on :${port} responded. This repo may be a Flask/Django + Vite hybrid where Vite only serves JS/CSS modules. Try Advanced with a Python start command (e.g. \`python -m <pkg>.web.app\` or the repo's documented entry).`,
                  });
                }
              } catch {
                // ignore
              }
            }
          } catch (e: any) {
            send("log", {
              stream: "status",
              line: `→ Preview diagnostics failed: ${e?.message ?? e}`,
            });
          }
        })();
      };

      const sendPreviewUrl = (url: string, opts?: { force?: boolean }) => {
        if (closed) return;
        if (!opts?.force && previewUrl) return;
        if (previewUrl === url) return;
        previewUrl = url;
        send("preview", { url });
        send("log", { stream: "status", line: `→ Preview: ${url}` });
      };

      const extractUrlFromLine = (line: string): { port: number; basePath: string } | null => {
        const clean = stripAnsi(line);
        const matches = clean.match(/https?:\/\/[^\s]+/g);
        if (!matches) return null;

        for (const raw of matches) {
          // Trim common trailing punctuation.
          const candidate = raw.replace(/[),.;]+$/, "");
          try {
            const u = new URL(candidate);
            const p = Number(u.port);
            if (!p || Number.isNaN(p)) continue;
            // Only treat local-ish URLs as port announcements.
            if (!/^(localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\]|169\.254\.)/.test(u.hostname)) continue;
            return { port: p, basePath: u.pathname || "" };
          } catch {
            // ignore
          }
        }
        return null;
      };

      const ensureHostRewriteProxy = async (targetPort: number, basePath?: string) => {
        if (!isVite) return;

        const targetHost = sbx.getHost(targetPort);
        const path = normalizeBasePath(basePath);

        // Simulate the external request's Host header. If Vite blocks it,
        // we run a tiny reverse-proxy on another port that rewrites Host
        // to localhost:<targetPort> and forwards WebSocket upgrades.
        const checkScript = [
          "set -e",
          `curl -fsSI -H ${JSON.stringify(`Host: ${targetHost}`)} ${JSON.stringify(`http://127.0.0.1:${targetPort}${path || "/"}`)} | head -n 1 || true`,
        ].join("\n");
        const check = await sbx.commands.run(bashLc(checkScript));
        const first = stripAnsi(check.stdout).trim();
        const isForbidden = /\s403\s/.test(first);
        if (!isForbidden) return;

        send("log", {
          stream: "status",
          line: "→ Vite appears to be blocking the E2B host header; starting an in-sandbox proxy…",
        });

        const proxyPorts = [3000, 4173, 8080];
        const choosePortScript = [
          "set -e",
          `for p in ${proxyPorts.join(" ")}; do (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 || { echo $p; exit 0; }; done; exit 1`,
        ].join("; ");
        const choose = await sbx.commands.run(`bash -lc ${JSON.stringify(choosePortScript)}`);
        const listenPort = parseInt(choose.stdout.trim(), 10);
        if (Number.isNaN(listenPort)) return;

        const proxyPath = "/home/user/.reporunner";
        const proxyFile = `${proxyPath}/host-rewrite-proxy.cjs`;

        const writeProxy = [
          "set -e",
          `mkdir -p ${JSON.stringify(proxyPath)}`,
          `cat > ${JSON.stringify(proxyFile)} <<'EOF'`,
          "const http = require('http');",
          "const net = require('net');",
          "const targetPort = Number(process.env.TARGET_PORT);",
          "const listenPort = Number(process.env.LISTEN_PORT);",
          "const targetHost = '127.0.0.1';",
          "const rewriteHost = `localhost:${targetPort}`;",
          "",
          "const server = http.createServer((req, res) => {",
          "  const headers = { ...req.headers, host: rewriteHost };",
          "  const proxyReq = http.request({ hostname: targetHost, port: targetPort, method: req.method, path: req.url, headers }, (proxyRes) => {",
          "    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);",
          "    proxyRes.pipe(res);",
          "  });",
          "  proxyReq.on('error', (err) => {",
          "    res.statusCode = 502;",
          "    res.setHeader('content-type', 'text/plain');",
          "    res.end(String(err && err.message ? err.message : err));",
          "  });",
          "  req.pipe(proxyReq);",
          "});",
          "",
          "server.on('upgrade', (req, socket, head) => {",
          "  const upstream = net.connect(targetPort, targetHost);",
          "  upstream.on('connect', () => {",
          "    const headers = { ...req.headers, host: rewriteHost };",
          "    let headerLines = '';",
          "    for (const [k, v] of Object.entries(headers)) {",
          "      if (typeof v === 'undefined') continue;",
          "      if (Array.isArray(v)) headerLines += `${k}: ${v.join(', ')}\\r\\n`;",
          "      else headerLines += `${k}: ${v}\\r\\n`;",
          "    }",
          "    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\\r\\n${headerLines}\\r\\n`);",
          "    if (head && head.length) upstream.write(head);",
          "    socket.pipe(upstream).pipe(socket);",
          "  });",
          "  upstream.on('error', () => socket.destroy());",
          "});",
          "",
          "server.listen(listenPort, '0.0.0.0', () => {",
          "  console.log(`[proxy] listening on :${listenPort} -> :${targetPort}`);",
          "});",
          "EOF",
        ].join("\n");
        await sbx.commands.run(bashLc(writeProxy));

        await sbx.commands.run(bashLc(`node ${JSON.stringify(proxyFile)}`), {
          background: true,
          envs: {
            TARGET_PORT: String(targetPort),
            LISTEN_PORT: String(listenPort),
          },
        });

        const fixedUrl = buildPreviewUrl(listenPort, path);
        if (fixedUrl) {
          sendPreviewUrl(fixedUrl, { force: true });
        }
      };

      const sendPreview = (port: number, basePath?: string) => {
        const url = buildPreviewUrl(port, basePath);
        if (!url) return;
        sendPreviewUrl(url);
        runPreviewDiagnostics(port, basePath);
        void ensureHostRewriteProxy(port, basePath);
      };
      const handleLine = (
        stream: "stdout" | "stderr",
        data: string,
      ) => {
        send("log", { stream, line: data });
        if (previewUrl) return;

        const u = extractUrlFromLine(data);
        if (u) {
          sendPreview(u.port, u.basePath);
          return;
        }
        for (const rx of portRegexes) {
          const m = data.match(rx);
          if (m) {
            const port = parseInt(m[1], 10);
            sendPreview(port);
            break;
          }
        }
      };

      if (Object.keys(userEnvs).length > 0) {
        send("log", {
          stream: "status",
          line: `→ Injecting ${Object.keys(userEnvs).length} user env var(s): ${Object.keys(userEnvs).join(", ")}`,
        });
      }

      await sbx.commands.run(startCmd!, {
        background: true,
        cwd: "/home/user/repo",
        envs: {
          HOST: "0.0.0.0",
          PORT: "3000",
          BROWSER: "none",
          CI: "true",
          __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b.app",
          __VITE_ADDITIONAL_PREVIEW_ALLOWED_HOSTS: ".e2b.app",
          ...userEnvs,
        },
        onStdout: (data) => handleLine("stdout", data),
        onStderr: (data) => handleLine("stderr", data),
      });

      // Fallback: if no port detected from logs after 30s, optimistically
      // expose the most likely port for the detected stack. Some repos
      // serve on non-standard ports (e.g. 5000), so probe a small set of
      // common ports and pick the first open one.
      setTimeout(() => {
        if (previewUrl || closed) return;
        void (async () => {
          const candidates = isVite
            ? [5173, 3000, 5000, 8000, 8080]
            : [3000, 5000, 5173, 8000, 8080];
          const script = [
            "set -e",
            `for p in ${candidates.join(" ")}; do (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && echo $p && exit 0; done; exit 1`,
          ].join("; ");

          try {
            const r = await sbx.commands.run(`bash -lc ${JSON.stringify(script)}`);
            const found = parseInt(r.stdout.trim(), 10);
            if (!Number.isNaN(found)) {
              sendPreview(found);
              return;
            }
          } catch {
            // ignore probe failures; fall back below
          }

          const fallbackPort = isVite ? 5173 : 3000;
          sendPreview(fallbackPort);
        })();
      }, PREVIEW_FALLBACK_MS);
    } catch (err: any) {
      errorAndEnd(err?.message ?? "Unknown error during execution");
    }
  },
);

app.post("/api/stop/:sandboxId", async (req: Request, res: Response) => {
  const sandboxId = req.params.sandboxId;
  if (!sandboxes.has(sandboxId)) {
    return res.status(404).json({ error: "Sandbox not found" });
  }
  await disposeSandbox(sandboxId);
  res.json({ ok: true });
});

// Belt-and-suspenders: if the process is killed (Ctrl+C, container shutdown),
// kill any live sandboxes so we don't keep paying for them.
async function shutdown() {
  const ids = Array.from(sandboxes.keys());
  await Promise.allSettled(ids.map((id) => disposeSandbox(id)));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
});
