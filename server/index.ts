import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { Sandbox } from "e2b";

const PORT = 8787;
const SANDBOX_TIMEOUT_MS = 600_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PREVIEW_FALLBACK_MS = 30_000;

const app = express();
app.use(cors());
app.use(express.json());

const sandboxes = new Map<string, Sandbox>();
const sandboxTimers = new Map<string, NodeJS.Timeout>();

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
}

app.post("/api/run", async (req: Request, res: Response) => {
  try {
    const { url, customCommand } = req.body as {
      url?: string;
      customCommand?: string;
    };
    if (!url || !isValidGitHubUrl(url)) {
      return res.status(400).json({ error: "Invalid GitHub URL" });
    }
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
    const url = normalizeUrl(String(req.query.url ?? ""));
    const customCommand = String(req.query.customCommand ?? "").trim();

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

      if (customCommand) {
        startCmd = customCommand;
      } else if (await has("package.json")) {
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
      } else if (await has("requirements.txt")) {
        installCmd = "pip install -r requirements.txt";
        if (await has("streamlit_app.py"))
          startCmd =
            "streamlit run streamlit_app.py --server.port 3000 --server.address 0.0.0.0 --server.headless true";
        else if (await has("app.py")) startCmd = "python -u app.py";
        else if (await has("main.py")) startCmd = "python -u main.py";
        else
          return errorAndEnd(
            "requirements.txt found but no app.py/main.py/streamlit_app.py",
          );
      } else if (await has("pyproject.toml")) {
        installCmd = "pip install .";
        if (await has("streamlit_app.py"))
          startCmd =
            "streamlit run streamlit_app.py --server.port 3000 --server.address 0.0.0.0 --server.headless true";
        else if (await has("app.py")) startCmd = "python -u app.py";
        else if (await has("main.py")) startCmd = "python -u main.py";
        else
          return errorAndEnd(
            "pyproject.toml found but no app.py/main.py/streamlit_app.py",
          );
      } else if (await has("Cargo.toml")) {
        startCmd = "cargo run";
      } else if (await has("go.mod")) {
        startCmd = "go run .";
      } else if ((await has("index.html")) && !(await has("package.json"))) {
        startCmd = "python3 -m http.server 3000 --bind 0.0.0.0";
      } else {
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
        const ins = await sbx.commands.run(installCmd, {
          cwd: "/home/user/repo",
          onStdout: log("stdout"),
          onStderr: log("stderr"),
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
        if (ins.exitCode !== 0) {
          return errorAndEnd("Install failed. See logs above.");
        }
      }

      // PHASE 4 — run + port detection
      status("running");
      let previewSent = false;
      const portRegexes = [
        // Capture port and optional base path (some apps serve under /static/ etc.)
        /https?:\/\/(?:localhost|0\.0\.0\.0|127\.0\.0\.1):(\d{2,5})(\/\S*)?/i,
        /Local:\s+https?:\/\/[^:\s]+:(\d{2,5})(\/\S*)?/i,
        /(?:listening|running|server started|ready|started server).{0,40}?(?:port|:)\s*(\d{2,5})/i,
        /Uvicorn running on https?:\/\/[^:]+:(\d{2,5})/i,
        /You can now view .* in your browser.{0,80}?:(\d{2,5})/i,
      ];
      const normalizeBasePath = (p?: string) => {
        if (!p) return "";
        // Keep only a path part, no spaces. Ensure leading slash.
        const path = p.trim();
        if (!path) return "";
        if (!path.startsWith("/")) return "/" + path;
        return path;
      };

      const sendPreview = (port: number, basePath?: string) => {
        if (previewSent || closed) return;
        if (port < 1 || port > 65535) return;
        const host = sbx.getHost(port); // SYNC
        const path = normalizeBasePath(basePath);
        send("preview", { url: `https://${host}${path}` });
        previewSent = true;
      };
      const handleLine = (
        stream: "stdout" | "stderr",
        data: string,
      ) => {
        send("log", { stream, line: data });
        if (previewSent) return;
        for (const rx of portRegexes) {
          const m = data.match(rx);
          if (m) {
            const port = parseInt(m[1], 10);
            const basePath = m.length >= 3 ? m[2] : undefined;
            sendPreview(port, basePath);
            break;
          }
        }
      };

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
        },
        onStdout: (data) => handleLine("stdout", data),
        onStderr: (data) => handleLine("stderr", data),
      });

      // Fallback: if no port detected from logs after 30s, optimistically
      // expose the most likely port for the detected stack. Some repos
      // serve on non-standard ports (e.g. 5000), so probe a small set of
      // common ports and pick the first open one.
      setTimeout(() => {
        if (previewSent || closed) return;
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
