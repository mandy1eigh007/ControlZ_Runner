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
  githubLanguages?: Array<[string, number]> | null;
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

// Extract {owner, name} from a normalized https://github.com/<owner>/<name> URL.
// Returns null if it doesn't match (callers should already have called isValidGitHubUrl).
function parseOwnerRepo(url: string): { owner: string; name: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

// Pre-clone: query GitHub's languages API so we can hint the stack before we
// pay the clone cost. Returns a sorted list of [lang, bytes] tuples (largest
// first), or null on any failure (network/404/rate-limit). Never throws.
// Honors GITHUB_TOKEN if set to dodge the 60/hr unauth limit.
async function fetchRepoLanguages(
  owner: string,
  name: string,
): Promise<Array<[string, number]> | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ControlZ-Runner",
    };
    const tok = process.env.GITHUB_TOKEN?.trim();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const r = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/languages`,
      { headers, signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!r.ok) return null;
    const json = (await r.json()) as Record<string, number>;
    if (!json || typeof json !== "object") return null;
    const entries = Object.entries(json).filter(
      ([, v]) => typeof v === "number" && v > 0,
    );
    entries.sort((a, b) => b[1] - a[1]);
    return entries;
  } catch {
    return null;
  }
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

    // Wraps `log()` for noisy package-install commands (pip / uv pip / npm).
    // A full LDR install dumps 200+ lines of `+ pkgname==1.2.3` and even more
    // `Downloading X (NN MiB)` lines, which buries useful signal. We:
    //   - drop the per-package install-confirmation lines
    //   - drop the per-file "Downloading" / "Downloaded" / "Prepared" chatter
    //   - keep "Resolved N packages" / "Installed N packages" summary lines
    //   - keep ANY line containing error/warning/traceback/failed
    //   - keep stderr verbatim (errors deserve full visibility)
    //   - emit a periodic heartbeat (`… quieted N lines, still working`) so
    //     long silent stretches don't look like a hang
    const quietPipLog = (stream: "stdout" | "stderr") => {
      let dropped = 0;
      let lastHeartbeat = Date.now();
      const HEARTBEAT_MS = 8_000;
      const DROP_PATTERNS: RegExp[] = [
        // `+ package==1.2.3` or ` + package==1.2.3 (from ...)` from uv pip
        /^\s*\+\s+[A-Za-z0-9_.-]+==[^\s]+/,
        // uv per-file download chatter
        /^\s*Downloading\s+[A-Za-z0-9_.-]+\s+\([\d.]+\s*[KMG]i?B\)/i,
        /^\s*\u2713?\s*Downloaded\s+[A-Za-z0-9_.-]+\s*$/i,
        // pip's `Collecting xyz` / `Downloading xyz-1.2.3-...whl` lines
        /^\s*Collecting\s+[A-Za-z0-9_.-]+/,
        /^\s*Downloading\s+\S+\.whl/,
        /^\s*Downloading\s+\S+\.tar\.gz/,
        // pip progress bars (rendered as plain text by e2b)
        /^\s*[\u2500-\u259F\u2580-\u259F]+\s+[\d.]+\/[\d.]+\s*[KMG]?B/,
        // npm "Downloading…" extras
        /^\s*npm\s+notice/,
      ];
      const KEEP_PATTERNS: RegExp[] = [
        /error|warning|traceback|failed|fatal|killed|cannot|unable/i,
        /Resolved\s+\d+\s+packages?/i,
        /Installed\s+\d+\s+packages?/i,
        /Prepared\s+\d+\s+packages?/i,
        /Built\s+/,
        /Building\s+/,
        /Successfully installed/i,
      ];
      return (data: string) => {
        // Always pass stderr through unfiltered — errors must be visible.
        if (stream === "stderr") {
          if (data) send("log", { stream, line: data });
          return;
        }
        const lines = data.split(/\r?\n/);
        const kept: string[] = [];
        for (const ln of lines) {
          if (!ln.trim()) continue;
          if (KEEP_PATTERNS.some((rx) => rx.test(ln))) {
            kept.push(ln);
            continue;
          }
          if (DROP_PATTERNS.some((rx) => rx.test(ln))) {
            dropped++;
            continue;
          }
          kept.push(ln);
        }
        if (kept.length) {
          send("log", { stream, line: kept.join("\n") });
        }
        const now = Date.now();
        if (dropped > 0 && now - lastHeartbeat >= HEARTBEAT_MS) {
          send("log", {
            stream: "status",
            line: `… still installing (quieted ${dropped} routine lines so far)`,
          });
          lastHeartbeat = now;
        }
      };
    };
    const status = (s: string) => send("status", s);

    type ErrorCode =
      | "invalid-github-url"
      | "missing-e2b-api-key"
      | "repo-not-found"
      | "stack-detect-failed"
      | "missing-entrypoint"
      | "install-failed"
      | "install-timeout"
      | "runtime-failed"
      | "oom-killed"
      | "unknown";

    const categorizeError = (raw: string): { code: ErrorCode; title: string; hint?: string } => {
      const msg = (raw || "").trim();
      const m = msg.toLowerCase();

      if (!msg) return { code: "unknown", title: "Unknown error" };

      if (m.includes("invalid github url")) {
        return {
          code: "invalid-github-url",
          title: "Invalid GitHub URL",
          hint: "Use https://github.com/<owner>/<repo> for a public repo.",
        };
      }
      if (m.includes("e2b_api_key")) {
        return {
          code: "missing-e2b-api-key",
          title: "Missing or invalid E2B API key",
          hint: "Set E2B_API_KEY in .env (no quotes/newlines), restart the backend, and try again.",
        };
      }
      if (m.includes("repository not found") || m.includes("not public") || m.includes("repository not found or not public")) {
        return {
          code: "repo-not-found",
          title: "Repository not found or not public",
          hint: "Make sure the repo exists and is public (private repos aren’t supported yet).",
        };
      }

      // Detection / entry point issues.
      if (m.includes("could not detect how to run")) {
        return {
          code: "stack-detect-failed",
          title: "Could not detect how to run this repo",
          hint: "Open Advanced and provide a custom start command (or choose a stack override).",
        };
      }
      if (m.includes("package.json has no dev/start/serve")) {
        return {
          code: "missing-entrypoint",
          title: "No Node start script found",
          hint: "Add a dev/start/serve script to package.json, or use Advanced with a custom command.",
        };
      }
      if (m.includes("no python entry found") || m.includes("no app.py") || m.includes("no main.py") || m.includes("no [project.scripts]")) {
        return {
          code: "missing-entrypoint",
          title: "No Python entrypoint found",
          hint: "Add app.py/main.py/streamlit_app.py, or define [project.scripts] in pyproject.toml, or use Advanced with a custom command.",
        };
      }

      // Timeouts and resource failures.
      if (m.includes("timeout") || m.includes("timed out")) {
        // Most timeouts in this app are install timeouts, but keep it generic.
        return {
          code: "install-timeout",
          title: "Command timed out",
          hint: "Try again (cold sandboxes can be slow), or use Advanced to run a smaller install/start command.",
        };
      }
      if (m.includes("killed") || m.includes("oom") || m.includes("out of memory")) {
        return {
          code: "oom-killed",
          title: "Sandbox ran out of memory (process was killed)",
          hint: "This repo may pull heavy native/ML deps. Try a lighter command, CPU-only deps, or trimming optional extras.",
        };
      }

      // Install failures.
      if (m.includes("npm install failed") || m.includes("python install failed") || m.includes("install failed")) {
        return {
          code: "install-failed",
          title: "Dependency install failed",
          hint: "Check the logs for the first error. You may need extra system libs (not present in the base sandbox) or env vars.",
        };
      }

      return { code: "unknown", title: "Run failed", hint: "Check the logs above for the first error line." };
    };

    const formatUserError = (raw: string): string => {
      const info = categorizeError(raw);
      const details = raw?.trim() ? `\nDetails: ${raw.trim()}` : "";
      const hint = info.hint ? `\nHint: ${info.hint}` : "";
      return `[${info.code}] ${info.title}${hint}${details}`;
    };

    const errorAndEnd = (msg: string) => {
      send("error", formatUserError(msg));
      clearInterval(heartbeat);
      closed = true;
      try {
        res.end();
      } catch {}
      void disposeSandbox(sandboxId);
    };

    // Pre-clone: ask GitHub what languages this repo uses. Purely advisory —
    // we surface it as a status hint and stash it on the run config so later
    // detection / UI can use it (P2-10 status pill, P1-7 fallback heuristics).
    // Never blocks the clone: a null result just means we skip the hint.
    let githubLanguages: Array<[string, number]> | null = null;
    {
      const parsed = parseOwnerRepo(url);
      if (parsed) {
        githubLanguages = await fetchRepoLanguages(parsed.owner, parsed.name);
        if (githubLanguages && githubLanguages.length > 0) {
          const total = githubLanguages.reduce((a, [, b]) => a + b, 0) || 1;
          const top = githubLanguages
            .slice(0, 3)
            .map(([lang, b]) => `${lang} ${Math.round((b / total) * 100)}%`)
            .join(", ");
          send("log", {
            stream: "status",
            line: `→ GitHub languages: ${top}`,
          });
        }
      }
    }
    // Persist for downstream consumers (status pill, etc.).
    {
      const cfgRef = runConfigs.get(sandboxId);
      if (cfgRef) cfgRef.githubLanguages = githubLanguages;
    }

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
      // Single source of truth for what we're actually running. Replaces the
      // old `isVite` boolean + `hybridMode` boolean pair, which had to be
      // mutated mid-flow (`isVite = false; hybridMode = true;`) and made it
      // hard to reason about which branch downstream code was on.
      // - "unknown": detection hasn't run yet (or stack didn't match anything)
      // - "node-vite": npm-managed Vite app, primary preview is Vite on :5173
      // - "node-other": npm-managed non-Vite app (Next/Express/etc.)
      // - "python-pure": Python is the only thing running
      // - "python-hybrid-vite": Python is primary, Vite runs as background
      //   asset server (e.g. Flask + Vite hybrids like LDR)
      // - "static" / "rust" / "go" / "custom": as named
      type PrimaryStack =
        | "unknown"
        | "node-vite"
        | "node-other"
        | "python-pure"
        | "python-hybrid-vite"
        | "static"
        | "rust"
        | "go"
        | "custom";
      let primaryStack: PrimaryStack = "unknown";
      // Short human-friendly labels for the UI status pill. Keep these
      // stable: they're shown verbatim to users.
      const stackLabel = (s: PrimaryStack): string => {
        switch (s) {
          case "node-vite": return "Vite";
          case "node-other": return "Node";
          case "python-pure": return "Python";
          case "python-hybrid-vite": return "Python + Vite";
          case "static": return "Static";
          case "rust": return "Rust";
          case "go": return "Go";
          case "custom": return "Custom";
          default: return "Detecting…";
        }
      };
      const setPrimaryStack = (s: PrimaryStack) => {
        primaryStack = s;
        send("log", { stream: "status", line: `→ Primary stack: ${s}` });
        // Typed event so the UI can render a status pill without parsing
        // free-form log text. Includes the stable enum value plus a short
        // human label.
        send("stack", { stack: s, label: stackLabel(s) });
      };
      // Backward-compatible derived view: `isVite` means "the primary preview
      // we expect on :5173 is Vite". Hybrid mode flips this off because the
      // primary preview is the Python backend (Vite is asset-only). Read-only
      // — never assign; assign to primaryStack instead.
      const getIsVite = () => primaryStack === "node-vite";
      const getHybridMode = () => primaryStack === "python-hybrid-vite";
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

      // Shell prefix that defines a `pip_install` function preferring `uv pip`
      // (10-100x faster than pip) when a venv is active and uv is on PATH.
      // Lazily installs uv (~5s) the first time it's used inside a venv.
      // Falls back to `python -m pip install` for non-venv installs to avoid
      // uv's --system requirement and keep behavior identical to the legacy
      // path when ensurePythonEnvPrefix didn't fire.
      const PIP_SHIM_PREFIX = [
        "pip_install() {",
        '  if [ -n "${VIRTUAL_ENV:-}" ]; then',
        "    if ! command -v uv >/dev/null 2>&1; then",
        '      curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true',
        '      export PATH="$HOME/.local/bin:$PATH"',
        "    fi",
        "    if command -v uv >/dev/null 2>&1; then",
        '      uv pip install "$@" && return 0',
        "    fi",
        "  fi",
        '  python -m pip install "$@"',
        "}",
        "",
      ].join("\n");

      // Scan pyproject.toml + requirements.txt for `torch` to decide whether
      // to use the CPU-only PyTorch wheel index. The default index pulls
      // ~2GB of CUDA wheels (nvidia-cublas, nvidia-cudnn-cu13, etc.) which
      // OOM-kills the e2b sandbox before the app can start. The CPU wheel is
      // ~200MB and pulls zero NVIDIA deps. Returns a shell prefix to prepend
      // to the install command (sets PIP_EXTRA_INDEX_URL + pre-installs
      // torch from the CPU index), or "" if torch isn't requested.
      const detectHeavyMlDeps = async (): Promise<string> => {
        let blob = "";
        try {
          if (await has("pyproject.toml")) {
            blob += await sbx.files.read("/home/user/repo/pyproject.toml");
          }
        } catch {}
        try {
          if (await has("requirements.txt")) {
            blob += "\n" + await sbx.files.read("/home/user/repo/requirements.txt");
          }
        } catch {}
        // Match `torch` as a top-level dep (not `torchvision`, `torchaudio`
        // standalone are also pulled in by torch). `\btorch\b` would match
        // strings inside other names; use a tighter check.
        const wantsTorch = /(^|[\n,\s\"'\[])torch(?:\s*[<>=!~]|\s*[,\"'\]\n]|$)/m.test(blob);
        if (!wantsTorch) return "";

        send("log", {
          stream: "status",
          line: "→ Detected `torch` in deps; pre-installing CPU-only PyTorch (~200MB) instead of default CUDA build (~2GB) to fit the sandbox.",
        });

        // Pre-install CPU torch BEFORE the main install so resolution picks
        // the already-installed version. Set PIP_EXTRA_INDEX_URL so any
        // remaining torch-related deps (torchvision, torchaudio) also resolve
        // from the CPU index. Keep PIP_NO_CACHE_DIR=1 to free disk pressure.
        return [
          'export PIP_EXTRA_INDEX_URL="https://download.pytorch.org/whl/cpu"',
          'export PIP_NO_CACHE_DIR=1',
          'pip_install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch || true',
          "",
        ].join("\n");
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
          install = "pip_install -r requirements.txt";
        } else if (await has("pyproject.toml")) {
          install = "pip_install .";
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
        // Django: manage.py is the universal entry point. runserver binds to
        // 0.0.0.0:3000 so the e2b preview proxy can reach it.
        if (await has("manage.py")) {
          return {
            install,
            start: "python -u manage.py runserver 0.0.0.0:3000",
            pyMin,
          };
        }
        // ASGI app (FastAPI/Starlette/Django-ASGI). Convention: `asgi.py`
        // exposes an `application` callable. Use `python -m uvicorn` so we
        // don't depend on the `uvicorn` console script being on PATH.
        if (await has("asgi.py")) {
          return {
            install,
            start:
              "python -m uvicorn asgi:application --host 0.0.0.0 --port 3000",
            pyMin,
          };
        }
        // WSGI app (classic Flask/Django). Convention: `wsgi.py` exposes an
        // `application` callable. Use `python -m gunicorn` for the same
        // PATH-independence reason as above.
        if (await has("wsgi.py")) {
          return {
            install,
            start:
              "python -m gunicorn wsgi:application --bind 0.0.0.0:3000",
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
        setPrimaryStack("custom");
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
        const hasVite = "vite" in allDeps;
        // Tentative — may be promoted to "python-hybrid-vite" below if a
        // Python backend is also detected. We don't call setPrimaryStack
        // here because we don't want to log a misleading status that we'll
        // immediately overwrite.
        let tentativeNodeStack: PrimaryStack = hasVite ? "node-vite" : "node-other";

        const enginesMajor = parseEnginesNodeMajor(pkg?.engines?.node);
        const needsModernNode = hasVite || (typeof enginesMajor === "number" && enginesMajor >= 24);
        const nodePrefix = needsModernNode
          ? await ensureModernNodePrefix(
              hasVite
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
          (forceHybrid || hasVite) && hasPython
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
            line: "→ Detected hybrid Python + Vite repo.",
          });

          // ────────────────────────────────────────────────────────────
          // Strategy: prefer `npm run build` over `npm run dev`.
          //
          // Why: in dev mode Flask serves HTML on :5000 with `<script
          // src="/static/...">` tags that point at Vite's :5173. In a
          // browser-on-localhost setup that's same-origin (both localhost),
          // but in an e2b sandbox each port is a *different* https hostname
          // (`5000-<id>.e2b.app` vs `5173-<id>.e2b.app`), so the iframe
          // either CORS-blocks or 404s every asset request. No amount of
          // port-detection cleverness solves a cross-origin problem.
          //
          // The fix is structural: build the Vite assets once into the
          // static directory the Flask app serves, then run Flask alone.
          // One origin, one port, one iframe URL — no proxy needed.
          //
          // We fall back to dev-mode (the previous behavior) only when:
          //   - no `build` script exists in package.json, OR
          //   - the build fails (we report the error and continue with
          //     dev mode so the user at least sees Flask's HTML).
          // ────────────────────────────────────────────────────────────
          const hasBuildScript = typeof scripts.build === "string" && scripts.build.length > 0;
          const useBuildMode = hasBuildScript;
          if (useBuildMode) {
            send("log", {
              stream: "status",
              line: `→ Build-mode hybrid: will run \`npm run build\` once, then Flask alone (avoids cross-origin asset issue).`,
            });
          } else {
            send("log", {
              stream: "status",
              line: "→ No `build` script in package.json; falling back to dev-mode (Vite + Flask side-by-side).",
            });
          }

          status("installing");
          const npmInstall = bashLc(
            nodePrefix + "npm install --no-audit --no-fund --loglevel=error",
          );
          const ni = await sbx.commands.run(npmInstall, {
            cwd: "/home/user/repo",
            onStdout: quietPipLog("stdout"),
            onStderr: quietPipLog("stderr"),
            timeoutMs: INSTALL_TIMEOUT_MS_NODE,
          });
          if (ni.exitCode !== 0) {
            return errorAndEnd("npm install failed. See logs above.");
          }

          const pyPrefix = await ensurePythonEnvPrefix(hybridPy.pyMin);
          const mlPrefix = await detectHeavyMlDeps();
          const pyInstall = bashLc(
            (pyPrefix || "") + PIP_SHIM_PREFIX + (mlPrefix || "") + hybridPy.install,
          );
          const pi = await sbx.commands.run(pyInstall, {
            cwd: "/home/user/repo",
            onStdout: quietPipLog("stdout"),
            onStderr: quietPipLog("stderr"),
            timeoutMs: INSTALL_TIMEOUT_MS_PYTHON,
          });
          if (pi.exitCode !== 0) {
            return errorAndEnd(
              "Python install failed. See logs above. The repo's Python deps may need system libraries not present in the sandbox; try Advanced with a custom command.",
            );
          }

          let buildSucceeded = false;
          if (useBuildMode) {
            send("log", {
              stream: "status",
              line: "→ Running `npm run build` (one-time asset build)…",
            });
            const buildCmd = bashLc(nodePrefix + "npm run build --silent");
            const buildResult = await sbx.commands.run(buildCmd, {
              cwd: "/home/user/repo",
              onStdout: (d) =>
                send("log", { stream: "stdout", line: `[build] ${d}` }),
              onStderr: (d) =>
                send("log", { stream: "stderr", line: `[build] ${d}` }),
              timeoutMs: INSTALL_TIMEOUT_MS_NODE,
            });
            buildSucceeded = buildResult.exitCode === 0;
            if (!buildSucceeded) {
              send("log", {
                stream: "status",
                line: "→ `npm run build` failed; falling back to dev-mode (Vite + Flask).",
              });
            } else {
              send("log", {
                stream: "status",
                line: "→ Vite build complete; Flask will serve the bundled assets.",
              });
            }
          }

          // If build mode worked, do NOT start Vite — Flask serves the
          // built static files itself. If build mode is unavailable or
          // failed, fall back to the previous dev-mode behavior.
          if (!buildSucceeded) {
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
          }

          // Skip the regular install phase below; primary command is Python.
          installCmd = null;
          startCmd = pyPrefix
            ? bashLc(pyPrefix + hybridPy.start)
            : hybridPy.start;
          // Mark the stack accordingly so downstream port-probing/preview
          // logic knows whether it's looking for one (build mode) or two
          // (dev mode) services.
          if (buildSucceeded) {
            // Build-mode: Flask serves everything. Treat as pure Python so
            // we don't seed Vite as a preview tab or run the hybrid poller
            // in dual-port mode.
            setPrimaryStack("python-pure");
            send("log", {
              stream: "status",
              line: "→ Running Flask as the single preview target (build-mode hybrid).",
            });
          } else {
            setPrimaryStack("python-hybrid-vite");
          }
        } else {
          setPrimaryStack(tentativeNodeStack);
          // For Vite, append --host 0.0.0.0 so it binds to all interfaces.
          // For other Node frameworks, HOST=0.0.0.0 env var handles it.
          const viteSuffix = hasVite ? " -- --host 0.0.0.0" : "";
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
        const mlPrefix = await detectHeavyMlDeps();
        const combined = (pyPrefix || "") + PIP_SHIM_PREFIX + (mlPrefix || "");
        installCmd = bashLc(combined + py.install);
        startCmd = pyPrefix ? bashLc(pyPrefix + py.start) : py.start;
        installTimeoutMs = INSTALL_TIMEOUT_MS_PYTHON;
        setPrimaryStack("python-pure");
      } else if (wantsStack("rust") && (await has("Cargo.toml"))) {
        startCmd = "cargo run";
        setPrimaryStack("rust");
      } else if (wantsStack("go") && (await has("go.mod"))) {
        startCmd = "go run .";
        setPrimaryStack("go");
      } else if (wantsStack("static") && (await has("index.html")) && !(await has("package.json"))) {
        startCmd = "python3 -m http.server 3000 --bind 0.0.0.0";
        setPrimaryStack("static");
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
          onStdout: quietPipLog("stdout"),
          onStderr: quietPipLog("stderr"),
          timeoutMs: installTimeoutMs,
        });
        if (ins.exitCode !== 0) {
          return errorAndEnd("Install failed. See logs above.");
        }
      }

      // PHASE 4 — run + port detection
      status("running");
      let previewUrl: string | null = null;
      let primaryPreviewPort: number | null = null;

      type PreviewOption = { port: number; url: string; label: string };
      const previewOptions = new Map<number, PreviewOption>();
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

      const labelForPreviewPort = (port: number): string => {
        if (getHybridMode()) {
          return port === 5173 ? "Vite" : "Backend";
        }
        if (getIsVite() || port === 5173) return "Vite";
        if (primaryStack === "python-pure") return "Python";
        return "App";
      };

      const emitPreviews = () => {
        if (closed) return;
        const options = Array.from(previewOptions.values());
        // Primary first, then by label, then by port.
        options.sort((a, b) => {
          const ap = a.port === primaryPreviewPort ? 0 : 1;
          const bp = b.port === primaryPreviewPort ? 0 : 1;
          if (ap !== bp) return ap - bp;
          const lc = a.label.localeCompare(b.label);
          if (lc !== 0) return lc;
          return a.port - b.port;
        });
        send("previews", { options, primaryPort: primaryPreviewPort });
      };

      const registerPreviewOption = (port: number, basePath?: string, label?: string) => {
        const url = buildPreviewUrl(port, basePath);
        if (!url) return;
        const next: PreviewOption = { port, url, label: label ?? labelForPreviewPort(port) };
        const prev = previewOptions.get(port);
        if (prev && prev.url === next.url && prev.label === next.label) return;
        previewOptions.set(port, next);
        emitPreviews();
      };

      let previewDiagnosed = false;
      const runPreviewDiagnostics = (port: number, basePath?: string) => {
        if (previewDiagnosed || closed) return;
        previewDiagnosed = true;

        const path = normalizeBasePath(basePath) || "/";
        let safePath = path.startsWith("/") ? path : `/${path}`;
        let target = `http://127.0.0.1:${port}${safePath}`;

        void (async () => {
          try {
            // Wait for the port to actually accept connections + return a
            // body before probing. Flask + LDR can take 30-60s after the
            // first "Starting..." log to bind. We retry up to ~60s.
            const waitScript = [
              // Best-effort: diagnostics should never throw/abort on transient
              // curl errors or ports mid-boot.
              "set +e",
              // If curl isn't available, just consider the port "ready" and
              // let the probe script handle the rest.
              "command -v curl >/dev/null 2>&1 || { echo READY; exit 0; }",
              'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do',
              // Curl prints http_code=000 on connection errors *and* exits
              // non-zero. Do not append a fallback "000" (that yields
              // "000000" and can be misread as ready). Instead, rely on the
              // curl exit code and normalize the printed code.
              `  code=$(curl -sS -o /dev/null -w "%{http_code}\\n" --connect-timeout 1 --max-time 2 ${JSON.stringify(target)} 2>/dev/null); rc=$?; code=$(echo "$code" | tail -n 1 | tr -d '\r\n'); if [ "$rc" -ne 0 ]; then code=000; fi`,
              '  if [ "$code" != "000" ]; then echo READY; exit 0; fi',
              "  sleep 5",
              "done",
              "echo TIMEOUT",
              "exit 0",
            ].join("\n");
            let wait: any;
            try {
              wait = await sbx.commands.run(bashLc(waitScript));
            } catch (e: any) {
              send("log", {
                stream: "status",
                line: `→ Preview diagnostics: wait step failed (${e?.message ?? e}); skipping probe.`,
              });
              return;
            }
            const ready = /READY/.test(wait?.stdout || "");
            if (!ready) {
              send("log", {
                stream: "status",
                line: `→ Preview diagnostics: ${target} did not respond within 60s; skipping probe.`,
              });
              return;
            }

            // For some hybrid repos (notably Vite asset servers), the first
            // advertised base path may return 404 even though another entry
            // point on the same port works. If we can cheaply find a better
            // path, do it before printing probe output.
            const shouldTryPathPick = (() => {
              if (safePath !== "/") return true;
              return getHybridMode() && port === 5173;
            })();

            if (shouldTryPathPick) {
              const statusScript = [
                "set +e",
                "command -v curl >/dev/null 2>&1 || exit 0",
                `code=$(curl -sS -o /dev/null -w '%{http_code}\\n' --connect-timeout 1 --max-time 2 ${JSON.stringify(
                  target,
                )} 2>/dev/null); rc=$?; code=$(echo "$code" | tail -n 1 | tr -d '\\r\\n'); if [ "$rc" -ne 0 ]; then code=000; fi; echo $code`,
              ].join("\n");
              try {
                const r = await sbx.commands.run(bashLc(statusScript));
                const code = stripAnsi(r.stdout || "").trim();
                if (code === "404") {
                  const trimmed = safePath.endsWith("/") ? safePath.slice(0, -1) : safePath;
                  const candidates = (() => {
                    if (getHybridMode() && port === 5173) {
                      return ["/", "/index.html", "/static/", "/static/index.html"];
                    }
                    return Array.from(
                      new Set([
                        safePath,
                        trimmed,
                        trimmed ? `${trimmed}/` : "/",
                        trimmed ? `${trimmed}/index.html` : "/index.html",
                        "/",
                        "/index.html",
                      ]),
                    ).filter(Boolean);
                  })();

                  const pickScript = [
                    "set +e",
                    `base=${JSON.stringify(`http://127.0.0.1:${port}`)}`,
                    `for p in ${candidates.map((c) => JSON.stringify(c)).join(" ")}; do` +
                      " code=$(curl -sS -o /dev/null -w '%{http_code}\\n' --connect-timeout 1 --max-time 2 \"$base$p\" 2>/dev/null); rc=$?;" +
                      " code=$(echo \"$code\" | tail -n 1 | tr -d '\\r\\n');" +
                      " if [ \"$rc\" -ne 0 ]; then code=000; fi;" +
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
                        // Keep multi-preview options in sync with the corrected basePath.
                        registerPreviewOption(port, pickedPath);
                        sendPreviewUrl(fixedUrl, { force: true, port, basePath: pickedPath });
                        safePath = pickedPath;
                        target = `http://127.0.0.1:${port}${safePath}`;
                      }
                    }
                  } catch {
                    // ignore
                  }
                }
              } catch {
                // ignore
              }
            }

            send("log", {
              stream: "status",
              line: `→ Preview diagnostics: probing ${target}`,
            });

            const script = [
              // Best-effort: never fail the whole diagnostics block just
              // because curl times out or the port is mid-boot.
              "set +e",
              "command -v curl >/dev/null 2>&1 || { echo 'curl not available'; exit 0; }",
              `echo '--- status+headers ---'`,
              `curl -sS -L -D - -o /dev/null --max-time 5 ${JSON.stringify(target)} 2>&1 | sed -n '1,40p' || true`,
              `echo '--- key headers ---'`,
              `curl -sS -L -D - -o /dev/null --max-time 5 ${JSON.stringify(target)} 2>&1 | awk 'BEGIN{IGNORECASE=1} /^(x-frame-options|content-security-policy|cross-origin-opener-policy|cross-origin-embedder-policy|cross-origin-resource-policy|x-content-type-options|location|content-type):/ {print}' || true`,
              `echo '--- body head (first 400 bytes) ---'`,
              `curl -sS -L --max-time 5 ${JSON.stringify(target)} 2>&1 | head -c 400 | tr '\n' ' ' || true`,
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
                  "set +e",
                  `base=${JSON.stringify(`http://127.0.0.1:${port}`)}`,
                  `for p in ${candidates.map((c) => JSON.stringify(c)).join(" ")}; do` +
                    " code=$(curl -sS -o /dev/null -w '%{http_code}\\n' --connect-timeout 1 --max-time 2 \"$base$p\" 2>/dev/null); rc=$?;" +
                    " code=$(echo \"$code\" | tail -n 1 | tr -d '\\r\\n');" +
                    " if [ \"$rc\" -ne 0 ]; then code=000; fi;" +
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
                      // Keep multi-preview options in sync with the corrected basePath.
                      registerPreviewOption(port, pickedPath);
                      sendPreviewUrl(fixedUrl, { force: true, port, basePath: pickedPath });
                  }
                } else if (!pickedPath && getIsVite()) {
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

      const sendPreviewUrl = (url: string, opts?: { force?: boolean; port?: number; basePath?: string }) => {
        if (closed) return;
        if (!opts?.force && previewUrl) return;
        if (previewUrl === url) return;
        previewUrl = url;
        if (typeof opts?.port === "number") primaryPreviewPort = opts.port;
        // Include port (when known) so the UI can show "Vite · :5173" pill.
        send("preview", { url, port: opts?.port ?? null });
        send("log", { stream: "status", line: `→ Preview: ${url}` });
        // Keep the multi-preview list in sync with whatever we selected as primary.
        if (typeof opts?.port === "number") {
          registerPreviewOption(opts.port, opts.basePath);
        }
        emitPreviews();
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
        if (!getIsVite()) return;

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
          sendPreviewUrl(fixedUrl, { force: true, port: listenPort });
        }
      };

      const sendPreview = (port: number, basePath?: string, opts?: { force?: boolean }) => {
        registerPreviewOption(port, basePath);
        const url = buildPreviewUrl(port, basePath);
        if (!url) return;
        sendPreviewUrl(url, { ...opts, port });
        // Reset the diagnostics latch when we force a rebind so we re-probe
        // the new port.
        if (opts?.force) previewDiagnosed = false;
        runPreviewDiagnostics(port, basePath);
        void ensureHostRewriteProxy(port, basePath);
      };
      const handleLine = (
        stream: "stdout" | "stderr",
        data: string,
      ) => {
        send("log", { stream, line: data });

        const u = extractUrlFromLine(data);
        if (u) {
          const currentPort = (() => {
            if (!previewUrl) return null;
            try {
              const m = previewUrl.match(/^https:\/\/(\d+)-/);
              return m ? Number(m[1]) : null;
            } catch {
              return null;
            }
          })();
          // Record every discovered local URL as a preview option so the UI
          // can offer tabs (especially useful for hybrid Python+Vite repos).
          // Hybrid note: the Vite dev server often logs a URL with a base path
          // like `/static/`, but that doesn't necessarily mean the HTML entry
          // is served there. Once we've chosen a working path for :5173 (via
          // seeding/diagnostics), don't let later log lines overwrite it.
          if (!(getHybridMode() && u.port === 5173 && currentPort === 5173 && previewOptions.has(5173))) {
            registerPreviewOption(u.port, u.basePath);
          }
          // In hybrid mode, the Vite asset server may publish its URL first
          // (5173) but the actual app lives on Flask/Django's port. If we've
          // already locked preview but a new, non-Vite local URL appears,
          // rebind to it.
          if (!previewUrl) {
            sendPreview(u.port, u.basePath);
          } else if (getHybridMode() && u.port !== 5173) {
            if (currentPort !== u.port) {
              send("log", {
                stream: "status",
                line: `→ Hybrid: detected Python backend on :${u.port}; rebinding preview from :${currentPort ?? "?"}.`,
              });
              sendPreview(u.port, u.basePath, { force: true });
            }
          }
          return;
        }
        if (previewUrl && !getHybridMode()) return;
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

      // In hybrid mode we always have at least two interesting ports:
      // - Vite asset server (usually :5173)
      // - Python backend (varies; discovered later via logs/poller)
      // Register the Vite port up-front so the UI can render a tab even
      // before the backend port is discovered.
      if (getHybridMode()) {
        // Seed the preview to Vite early so the user sees *something* while
        // the Python backend warms up; the hybrid poller will rebind to the
        // backend as soon as it starts responding. In practice, many Vite
        // setups log a base like `/static/` but serve the HTML entry at `/`.
        registerPreviewOption(5173, "/", "Vite");
        if (!previewUrl) {
          sendPreview(5173, "/");
        }
      }

      // P0-FIX-9: wrap the start command so we always log its exit code +
      // duration to the user's stream. Without this, `background:true` makes
      // silent exits (Flask `main()` returning, missing env var crash, etc.)
      // invisible — the diagnostics dump shows "no process" but never says
      // *why* the process is gone. Write the original command to a temp
      // script (avoids quoting hell for multi-line bash -lc payloads), then
      // exec it from a tiny wrapper that traps the exit.
      try {
        await sbx.files.write(
          "/tmp/cz-start.sh",
          `#!/usr/bin/env bash\n${startCmd}\n`,
        );
      } catch (e: any) {
        send("log", {
          stream: "status",
          line: `→ Could not stage start script (${e?.message ?? e}); running raw.`,
        });
      }
      const wrappedStart = `bash -lc 'chmod +x /tmp/cz-start.sh 2>/dev/null; t0=$SECONDS; /tmp/cz-start.sh; rc=$?; echo "[ControlZ] start command exited rc=$rc after $((SECONDS-t0))s" >&2; exit $rc'`;
      await sbx.commands.run(wrappedStart, {
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

      // Hybrid mode: many Flask/Django apps don't log a parseable
      // "Running on http://..." line (e.g. socketio.run, gunicorn workers,
      // custom loggers via loguru). Actively poll the typical Python web
      // ports every ~4s for ~3 min and rebind preview when one starts
      // returning a non-empty body. This complements the log-based detection
      // in handleLine() and the one-shot fallback timer below.
      // Runs for any Python stack (pure or hybrid) since the loguru/no-log
      // pattern is common in both.
      const isPythonStack =
        (primaryStack as PrimaryStack) === "python-pure" ||
        (primaryStack as PrimaryStack) === "python-hybrid-vite";
      if (isPythonStack) {
        // Wider port coverage: Flask defaults (5000/5001), Django (8000),
        // generic dev (3000/4000/8080), Gradio (7860), Streamlit (8501),
        // Jupyter (8888), and a few uncommon-but-real (5050).
        const pyPorts = [5000, 5001, 5050, 8000, 8080, 3000, 4000, 7860, 8501, 8888];
        // Probe in parallel within the sandbox and print the first port
        // that returns a non-empty body. Also report ports that are at least
        // listening (TCP open) as a hint while we wait for a body.
        // Importantly: probe via the container's external link-local IP
        // (e.g. 169.254.0.21) when we can resolve one — that's the address
        // the e2b preview proxy connects to. A port bound to 127.0.0.1
        // only will respond to the loopback probe but the iframe will 502.
        const pollScript = [
          "set -e",
          "command -v curl >/dev/null 2>&1 || exit 0",
          // Find the container's non-loopback IPv4 (best effort).
          "ext=$(hostname -I 2>/dev/null | awk '{print $1}')",
          '[ -z "$ext" ] && ext=127.0.0.1',
          // First pass: try external IP. A body here means the e2b preview
          // proxy will also be able to reach it.
          `for p in ${pyPorts.join(" ")}; do`,
          "  body=$(curl -fsS --max-time 2 \"http://$ext:$p/\" 2>/dev/null | head -c 32 || true)",
          '  if [ -n "$body" ]; then echo "READY $p"; exit 0; fi',
          "done",
          // Second pass: loopback only — port is bound but only on 127.0.0.1.
          // Report as LOCAL_ONLY so we can warn the user.
          `for p in ${pyPorts.join(" ")}; do`,
          "  body=$(curl -fsS --max-time 2 \"http://127.0.0.1:$p/\" 2>/dev/null | head -c 32 || true)",
          '  if [ -n "$body" ]; then echo "LOCAL_ONLY $p"; exit 0; fi',
          "done",
          // Third pass: any TCP-open ports for progress hint.
          "open=\"\"",
          `for p in ${pyPorts.join(" ")}; do`,
          "  (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && open=\"$open $p\"",
          "done",
          'if [ -n "$open" ]; then echo "OPEN$open"; fi',
          "exit 0",
        ].join("\n");

        const start = Date.now();
        const POLL_MAX_MS = 3 * 60_000;
        const POLL_INTERVAL_MS = 4_000;
        const HEARTBEAT_MS = 15_000;
        let lastHeartbeat = 0;
        let lastOpenSig = "";
        let firstTick = true;
        send("log", {
          stream: "status",
          line: `→ Backend poller: watching ports [${pyPorts.join(",")}] for Python backend (will rebind preview when one responds).`,
        });
        const tick = async () => {
          if (closed) return;
          const elapsed = Date.now() - start;
          if (elapsed > POLL_MAX_MS) {
            send("log", {
              stream: "status",
              line: `→ Backend poller: gave up after ${Math.round(elapsed / 1000)}s without finding a Python backend on [${pyPorts.join(",")}]. If your app uses a non-standard port, set it via the Advanced > Environment variables panel (e.g. PORT=NNNN).`,
            });
            return;
          }
          try {
            const r = await sbx.commands.run(bashLc(pollScript));
            const out = (r.stdout || "").trim();
            const readyMatch = out.match(/^READY\s+(\d+)/m);
            if (readyMatch) {
              const found = Number(readyMatch[1]);
              const cur = previewUrl ? previewUrl.match(/^https:\/\/(\d+)-/) : null;
              const curPort = cur ? Number(cur[1]) : null;
              if (curPort !== found) {
                send("log", {
                  stream: "status",
                  line: `→ Backend poller: Python backend responding on :${found} after ${Math.round(elapsed / 1000)}s; rebinding preview from :${curPort ?? "?"}.`,
                });
                sendPreview(found, undefined, { force: true });
              }
              return;
            }
            // LOCAL_ONLY: a Python port is serving on 127.0.0.1 but not on
            // the container's external IP. The e2b preview proxy can't
            // reach it. Tell the user exactly what to do, then keep polling
            // in case the app re-binds (some apps log "running on" before
            // actually starting the server).
            const localMatch = out.match(/^LOCAL_ONLY\s+(\d+)/m);
            if (localMatch) {
              const lp = Number(localMatch[1]);
              if (firstTick || elapsed - lastHeartbeat >= HEARTBEAT_MS) {
                firstTick = false;
                lastHeartbeat = elapsed;
                send("log", {
                  stream: "status",
                  line: `→ Backend poller: Python backend listening on 127.0.0.1:${lp} but NOT on the container's external IP — the iframe preview cannot reach it. Set HOST=0.0.0.0 (and an app-specific equivalent like LDR_HOST=0.0.0.0 / FLASK_RUN_HOST=0.0.0.0) in Advanced > Environment variables, then re-run.`,
                });
              }
              setTimeout(() => void tick(), POLL_INTERVAL_MS);
              return;
            }
            // No READY yet; emit a heartbeat on the first probe (so the
            // user has visible proof the poller is alive) and then at most
            // every HEARTBEAT_MS afterwards.
            if (firstTick || elapsed - lastHeartbeat >= HEARTBEAT_MS) {
              firstTick = false;
              lastHeartbeat = elapsed;
              const openMatch = out.match(/^OPEN\s+(.+)$/m);
              const openPorts = openMatch ? openMatch[1].trim().split(/\s+/).join(",") : "";
              const openSig = openPorts;
              if (openSig !== lastOpenSig || elapsed >= HEARTBEAT_MS) {
                lastOpenSig = openSig;
                const detail = openPorts
                  ? `ports listening but not ready: [${openPorts}]`
                  : `no ports listening yet`;
                send("log", {
                  stream: "status",
                  line: `→ Backend poller: still waiting for Python backend (${Math.round(elapsed / 1000)}s elapsed; ${detail}).`,
                });
              }
            }
          } catch {
            // ignore — try again on next tick
          }
          setTimeout(() => void tick(), POLL_INTERVAL_MS);
        };
        // First probe after 4s — Flask can start binding very quickly when
        // there's no model load; waiting 10s just felt like a hang.
        setTimeout(() => void tick(), 4_000);

        // ─────────────────────────────────────────────────────────────
        // Process diagnostics: when the start command appears to hang
        // (no port appears within 30s, then 90s, then 180s), dump what's
        // actually running inside the sandbox so we can see whether the
        // process is alive, dead, or bound to an unexpected address.
        // This is generic and helps any "silent death" case, not just
        // hybrids.
        // ─────────────────────────────────────────────────────────────
        const diagScript = [
          "set +e",
          "echo '--- ps (python/node/gunicorn/uvicorn/uv) ---'",
          "ps -ef 2>/dev/null | grep -E '(python|node|gunicorn|uvicorn|uv |hypercorn|daphne|streamlit|gradio|flask)' | grep -v grep | head -20 || true",
          "echo '--- listening sockets (ss / netstat) ---'",
          "(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null || true) | head -20",
          "echo '--- recent .log files in repo (last 10 lines each) ---'",
          "find /home/user/repo -maxdepth 3 -name '*.log' -mmin -5 2>/dev/null | head -5 | while read f; do echo \"== $f ==\"; tail -10 \"$f\" 2>/dev/null; done",
          "echo '--- end diagnostics ---'",
        ].join("\n");
        const dumpDiagnostics = async (label: string) => {
          if (closed) return;
          if (previewUrl) return; // already have a preview — no point
          try {
            const r = await sbx.commands.run(bashLc(diagScript));
            const out = (r.stdout || "").trim();
            if (!out) return;
            send("log", {
              stream: "status",
              line: `→ Process diagnostics (${label}):`,
            });
            for (const line of out.split("\n")) {
              if (line.trim()) {
                send("log", { stream: "stdout", line: `  ${line}` });
              }
            }
          } catch {
            // best effort — never fail the run
          }
        };
        setTimeout(() => void dumpDiagnostics("30s"), 30_000);
        setTimeout(() => void dumpDiagnostics("90s"), 90_000);
        setTimeout(() => void dumpDiagnostics("180s"), 180_000);
      }

      // Fallback: if no port detected from logs after PREVIEW_FALLBACK_MS,
      // optimistically expose the most likely port for the detected stack.
      // In hybrid mode Flask boot can take 60-120s after npm install
      // finishes, so we wait longer before guessing.
      const fallbackDelay = getHybridMode() ? PREVIEW_FALLBACK_MS * 2 : PREVIEW_FALLBACK_MS;
      setTimeout(() => {
        if (closed) return;
        // In hybrid mode we may have already locked preview to Vite's :5173
        // via the background command; we still want to upgrade to Flask if
        // it's listening. So don't bail on previewUrl when hybrid.
        if (previewUrl && !getHybridMode()) return;
        void (async () => {
          // Order: in hybrid mode probe Flask/Django defaults first; in
          // pure-Vite probe 5173 first; otherwise standard order.
          const candidates = getHybridMode()
            ? [5000, 5001, 8000, 3000, 4000, 8080, 7860, 8501, 8888, 5050, 5173]
            : getIsVite()
              ? [5173, 3000, 5000, 8000, 8080]
              : [3000, 5000, 5173, 8000, 8080];
          // Content-aware probe: pick the first port that returns a non-empty
          // body (not just an open TCP socket — Vite dev server keeps :5173
          // open even when the actual app lives elsewhere).
          const script = [
            "set -e",
            'command -v curl >/dev/null 2>&1 || { echo NOCURL; exit 0; }',
            `for p in ${candidates.join(" ")}; do`,
            "  body=$(curl -fsS --max-time 4 \"http://127.0.0.1:$p/\" 2>/dev/null | head -c 32 || true)",
            '  if [ -n "$body" ]; then echo $p; exit 0; fi',
            "done",
            // Second pass: any port that's at least open, even if body is empty.
            `for p in ${candidates.join(" ")}; do`,
            "  (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && echo $p && exit 0",
            "done",
            "exit 1",
          ].join("\n");

          try {
            const r = await sbx.commands.run(bashLc(script));
            const found = parseInt((r.stdout || "").trim(), 10);
            if (!Number.isNaN(found)) {
              // If we already have a preview locked (hybrid), only swap when
              // the discovered port is different.
              if (previewUrl) {
                const cur = previewUrl.match(/^https:\/\/(\d+)-/);
                const curPort = cur ? Number(cur[1]) : null;
                if (curPort === found) return;
                send("log", {
                  stream: "status",
                  line: `→ Hybrid fallback: probed and selected :${found}; rebinding preview from :${curPort ?? "?"}.`,
                });
                sendPreview(found, undefined, { force: true });
              } else {
                sendPreview(found);
              }
              return;
            }
          } catch {
            // ignore probe failures; fall back below
          }

          if (previewUrl) return;
          const fallbackPort = getHybridMode() ? 5000 : getIsVite() ? 5173 : 3000;
          sendPreview(fallbackPort);
        })();
      }, fallbackDelay);
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
