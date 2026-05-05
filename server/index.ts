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
    if (!process.env.E2B_API_KEY) {
      return res.status(500).json({ error: "Server missing E2B_API_KEY" });
    }
    const sbx = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
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

      let installCmd: string | null = null;
      let startCmd: string | null = null;
      let isVite = false;

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
        return errorAndEnd(
          "Could not detect how to run this repo. Use Advanced to provide a custom start command.",
        );
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
        /https?:\/\/(?:localhost|0\.0\.0\.0|127\.0\.0\.1):(\d{2,5})/i,
        /Local:\s+https?:\/\/[^:\s]+:(\d{2,5})/i,
        /(?:listening|running|server started|ready|started server).{0,40}?(?:port|:)\s*(\d{2,5})/i,
        /Uvicorn running on https?:\/\/[^:]+:(\d{2,5})/i,
        /You can now view .* in your browser.{0,80}?:(\d{2,5})/i,
      ];
      const sendPreview = (port: number) => {
        if (previewSent || closed) return;
        if (port < 1 || port > 65535) return;
        const host = sbx.getHost(port); // SYNC
        send("preview", { url: `https://${host}` });
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
            sendPreview(parseInt(m[1], 10));
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
      // expose the most likely port for the detected stack. The iframe
      // will load whichever port is actually serving (or show a 502 if
      // nothing is — at least the user will see *something*).
      setTimeout(() => {
        if (previewSent || closed) return;
        const fallbackPort = isVite ? 5173 : 3000;
        sendPreview(fallbackPort);
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
