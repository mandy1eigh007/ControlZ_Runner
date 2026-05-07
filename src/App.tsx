import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type Status =
  | "idle" | "cloning" | "detecting" | "installing"
  | "running" | "error" | "stopped";

// ── ASCII Loading Screen ─────────────────────────────────────────────────────
const ASCII_LOGO = `
   ██████╗████████╗██████╗ ██╗     ███████╗
  ██╔════╝╚══██╔══╝██╔══██╗██║     ╚══███╔╝
  ██║        ██║   ██████╔╝██║       ███╔╝
  ██║        ██║   ██╔══██╗██║      ███╔╝
  ╚██████╗   ██║   ██║  ██║███████╗███████╗
   ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝`.trim();

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_MESSAGES: Record<string, string[]> = {
  cloning: [
    "Cloning repository…",
    "Fetching refs…",
    "Resolving objects…",
    "Unpacking files…",
  ],
  detecting: [
    "Scanning project structure…",
    "Reading package.json…",
    "Detecting stack…",
    "Checking for lockfiles…",
  ],
  installing: [
    "Installing dependencies…",
    "Resolving packages…",
    "This may take a minute…",
    "Hang tight — heavy deps take time…",
    "Still installing… almost there…",
  ],
  running: ["Starting server…", "Waiting for port…", "Binding preview…"],
};

function AsciiLoader({ status }: { status: Status }) {
  const [frame, setFrame] = useState(0);
  const [msgIdx, setMsgIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    setFrame(0);
    setMsgIdx(0);
  }, [status]);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const msgs = STATUS_MESSAGES[status] ?? [];
    if (!msgs.length) return;
    const id = setInterval(() => {
      setMsgIdx((i) => (i + 1) % msgs.length);
    }, 2800);
    return () => clearInterval(id);
  }, [status]);

  const msgs = STATUS_MESSAGES[status] ?? ["Working…"];
  const message = msgs[msgIdx % msgs.length];
  const spinner = SPINNER_FRAMES[frame];
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-[#080c14] select-none">
      <pre className="text-[10px] leading-tight text-indigo-500/60 font-mono whitespace-pre">
        {ASCII_LOGO}
      </pre>
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-mono text-indigo-300">
          <span className="text-indigo-400">{spinner}</span>
          <span>{message}</span>
        </div>
        <div className="font-mono text-xs text-slate-600">{timeStr} elapsed</div>
      </div>
      <div className="flex gap-1.5">
        {(["cloning", "detecting", "installing", "running"] as Status[]).map((s) => (
          <div
            key={s}
            className={`h-1 w-6 rounded-full transition-colors duration-500 ${
              status === s
                ? "bg-indigo-500"
                : (["cloning", "detecting", "installing", "running"] as Status[]).indexOf(s) <
                  (["cloning", "detecting", "installing", "running"] as Status[]).indexOf(status)
                  ? "bg-indigo-900"
                  : "bg-slate-800"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
// ────────────────────────────────────────────────────────────────────────────

type Stack = "auto" | "node" | "python" | "hybrid-py-node" | "static" | "rust" | "go";

type PreviewOption = { port: number; url: string; label: string };

const STACK_OPTIONS: { value: Stack; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Detect from repo files" },
  { value: "node", label: "Node", hint: "package.json (Vite, Next, Express…)" },
  { value: "python", label: "Python", hint: "requirements.txt / pyproject.toml" },
  { value: "hybrid-py-node", label: "Hybrid Py+JS", hint: "Flask/Django + Vite asset server" },
  { value: "static", label: "Static", hint: "index.html only" },
  { value: "rust", label: "Rust", hint: "cargo run" },
  { value: "go", label: "Go", hint: "go run ." },
];

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  amber: "\x1b[33m",
  dim: "\x1b[2m",
};

const STATUS_DOT: Record<Status, string> = {
  idle:       "bg-slate-600",
  cloning:    "bg-indigo-400 animate-pulse",
  detecting:  "bg-indigo-400 animate-pulse",
  installing: "bg-amber-400 animate-pulse",
  running:    "bg-emerald-400",
  error:      "bg-red-500",
  stopped:    "bg-slate-600",
};

const STATUS_LABEL: Record<Status, string> = {
  idle:       "Idle",
  cloning:    "Cloning…",
  detecting:  "Detecting…",
  installing: "Installing…",
  running:    "Running",
  error:      "Error",
  stopped:    "Stopped",
};

export function App() {
  const [url, setUrl] = useState("");
  const [subdir, setSubdir] = useState("");
  // Install command override (e.g. "pip install -r requirements.txt")
  const [installCommand, setInstallCommand] = useState("");
  // Start command override (e.g. "python -m uvicorn app.main:app --host 0.0.0.0 --port 8000")
  const [customCommand, setCustomCommand] = useState("");
  const [stack, setStack] = useState<Stack>("auto");
  const [envVars, setEnvVars] = useState("");
  // Anthropic API key for Claude pre-flight analysis — persisted to localStorage
  const ANTHROPIC_KEY_STORAGE = "reporunner.anthropicKey.v1";
  const [anthropicKey, setAnthropicKey] = useState<string>(() => {
    try { return localStorage.getItem(ANTHROPIC_KEY_STORAGE) ?? ""; } catch { return ""; }
  });
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [preflight, setPreflight] = useState<{
    summary?: string;
    language?: string;
    requiredEnvVars?: Array<{ key: string; description: string; required: boolean }>;
    optionalEnvVars?: Array<{ key: string; description: string; defaultValue?: string }>;
    externalServices?: string[];
    warnings?: string[];
    confidence?: string;
  } | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Commands detected by the backend — shown in a read-only preview after run starts
  const [detectedInstall, setDetectedInstall] = useState<string | null>(null);
  const [detectedStart, setDetectedStart] = useState<string | null>(null);
  const [detectedSubdir, setDetectedSubdir] = useState<string | null>(null);
  // Env keys detected from .env.example — shown as a pre-fill banner
  const [suggestedEnvKeys, setSuggestedEnvKeys] = useState<Array<{ key: string; defaultValue: string | null }>>([]);
  // UI error alert (in addition to terminal logs)
  const [errorAlert, setErrorAlert] = useState<string | null>(null);
  // Incrementing this forces the iframe to reload without changing src
  const [previewKey, setPreviewKey] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [primaryPreviewUrl, setPrimaryPreviewUrl] = useState<string | null>(null);
  const [primaryPreviewPort, setPrimaryPreviewPort] = useState<number | null>(null);
  const [previewOptions, setPreviewOptions] = useState<PreviewOption[]>([]);
  const [detectedStack, setDetectedStack] = useState<string | null>(null);
  const [activeSandbox, setActiveSandbox] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const manualPreviewRef = useRef(false);
  // Recent repos history (most-recent-first, deduped, capped). Persisted to
  // localStorage so it survives reloads. Used to power a native <datalist>
  // dropdown attached to the URL input — no extra UI surface, just type or
  // click the chevron to pick a previous repo.
  const RECENT_KEY = "reporunner.recentRepos.v1";
  const RECENT_MAX = 20;
  const [recentRepos, setRecentRepos] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const pushRecentRepo = (repoUrl: string) => {
    const u = repoUrl.trim();
    if (!u) return;
    setRecentRepos((prev) => {
      const next = [u, ...prev.filter((x) => x !== u)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // localStorage may be disabled (private mode quotas, etc.) — ignore.
      }
      return next;
    });
  };
  const clearRecentRepos = () => {
    setRecentRepos([]);
    try { localStorage.removeItem(RECENT_KEY); } catch {}
  };

  const termRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!termRef.current || terminalRef.current) return;
    const term = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#080c14",
        foreground: "#cbd5e1",
        cursor: "#818cf8",
        cursorAccent: "#080c14",
        selectionBackground: "#1e2a45",
        black: "#0f172a",
        brightBlack: "#1e293b",
        green: "#34d399",
        brightGreen: "#6ee7b7",
        red: "#f87171",
        yellow: "#fbbf24",
        cyan: "#67e8f9",
        white: "#cbd5e1",
        brightWhite: "#f1f5f9",
      },
    });

    const writeClipboard = async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fallback for environments where Clipboard API is unavailable/blocked.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "true");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
    };

    const copySelection = async () => {
      const text = term.getSelection();
      if (!text) return;
      await writeClipboard(text);
    };

    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      if (!mod) return true;
      const key = ev.key.toLowerCase();

      // Ctrl/Cmd+A: select all terminal output
      if (key === "a") {
        term.selectAll();
        return false;
      }

      // Copy behavior:
      // - Ctrl/Cmd+Shift+C always copies
      // - Ctrl/Cmd+C copies when there is a selection
      if (key === "c" && (ev.shiftKey || term.hasSelection())) {
        void copySelection();
        return false;
      }

      return true;
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    setTimeout(() => fit.fit(), 0);

    // Right-click copy when there is a selection (keeps default context menu otherwise).
    term.element?.addEventListener("contextmenu", (e) => {
      if (!term.hasSelection()) return;
      e.preventDefault();
      void copySelection();
    });

    terminalRef.current = term;
    fitRef.current = fit;
    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const writeln = (line: string, color = "") => {
    terminalRef.current?.writeln(color + line + (color ? C.reset : ""));
  };

  // Auto-run Claude pre-flight whenever the URL or Anthropic key changes.
  // Debounced 1.2 s so we don't hammer the API on every keystroke.
  useEffect(() => {
    const trimmed = url.trim();
    const key = anthropicKey.trim();
    if (!trimmed || !key || !trimmed.includes("github.com/")) {
      setPreflight(null);
      setPreflightLoading(false);
      return;
    }
    setPreflight(null);
    setPreflightLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/preflight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed, anthropicApiKey: key }),
        });
        if (res.ok) {
          const data = await res.json();
          setPreflight(data);
        }
      } catch {
        // silently ignore — preflight is optional
      } finally {
        setPreflightLoading(false);
      }
    }, 1200);
    return () => {
      clearTimeout(timer);
      setPreflightLoading(false);
    };
  }, [url, anthropicKey]);

  const handleRun = async () => {
    if (!url || starting || activeSandbox) return;
    setStarting(true);
    setStatus("idle");
    setPreviewUrl(null);
    setPreviewPort(null);
    setPrimaryPreviewUrl(null);
    setPrimaryPreviewPort(null);
    setPreviewOptions([]);
    manualPreviewRef.current = false;
    setDetectedStack(null);
    setDetectedInstall(null);
    setDetectedStart(null);
    setDetectedSubdir(null);
    setErrorAlert(null);
    setSuggestedEnvKeys([]);
    setPreflight(null);
    terminalRef.current?.clear();
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          subdir: subdir.trim() || undefined,
          installCommand: installCommand.trim() || undefined,
          customCommand: customCommand.trim() || undefined,
          stack,
          envs: envVars,
          anthropicApiKey: anthropicKey.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        writeln(`Failed to start: ${body.error ?? res.statusText}`, C.red);
        setStatus("error");
        setErrorAlert(body.error ?? res.statusText);
        setStarting(false);
        return;
      }
      const { sandboxId } = (await res.json()) as { sandboxId: string };
      setActiveSandbox(sandboxId);
      // Successfully kicked off a run — record the URL in history.
      pushRecentRepo(url.trim());

      // /stream looks up url/customCommand/stack/envs from server-side config
      // keyed on sandboxId; nothing sensitive (env vars) is sent in the URL.
      const es = new EventSource(`/api/run/${sandboxId}/stream`);
      esRef.current = es;

      es.addEventListener("status", (e) => {
        setStatus(JSON.parse((e as MessageEvent).data) as Status);
      });
      es.addEventListener("log", (e) => {
        const { stream, line } = JSON.parse((e as MessageEvent).data) as
          { stream: string; line: string };
        const color = stream === "stderr" ? C.red
                    : stream === "status" ? C.amber : "";
        writeln(line, color);
      });
      es.addEventListener("preview", (e) => {
        const { url: u, port } = JSON.parse((e as MessageEvent).data) as
          { url: string; port?: number | null };
        setPrimaryPreviewUrl(u);
        if (typeof port === "number") setPrimaryPreviewPort(port);

        setPreviewOptions((prev) => {
          if (typeof port !== "number") return prev;
          const next: PreviewOption = { url: u, port, label: "Primary" };
          const filtered = prev.filter((x) => x.port !== port);
          return [next, ...filtered];
        });

        // Default behavior: follow the primary preview emitted by the server.
        // If the user manually selected a non-primary tab, keep their choice.
        setPreviewUrl((cur) => {
          if (!cur) return u;
          if (manualPreviewRef.current) return cur;
          return u;
        });
        setPreviewPort((cur) => {
          if (typeof port !== "number") return cur;
          if (!cur) return port;
          if (manualPreviewRef.current) return cur;
          return port;
        });
      });
      es.addEventListener("previews", (e) => {
        const data = JSON.parse((e as MessageEvent).data) as
          { options: PreviewOption[]; primaryPort?: number | null };
        const opts = Array.isArray(data.options) ? data.options : [];
        setPreviewOptions(opts);
        if (typeof data.primaryPort === "number") setPrimaryPreviewPort(data.primaryPort);

        // If we don't have any preview yet, pick the primary (if known) else first.
        // If we're following primary (not manual), keep the iframe in sync.
        setPreviewUrl((cur) => {
          const primary = typeof data.primaryPort === "number"
            ? opts.find((o) => o.port === data.primaryPort)
            : null;
          if (!cur) return (primary ?? opts[0])?.url ?? null;
          if (!manualPreviewRef.current && primary) return primary.url;
          return cur;
        });
        setPreviewPort((cur) => {
          const primary = typeof data.primaryPort === "number"
            ? opts.find((o) => o.port === data.primaryPort)
            : null;
          if (!cur) return (primary ?? opts[0])?.port ?? null;
          if (!manualPreviewRef.current && primary) return primary.port;
          return cur;
        });
      });
      es.addEventListener("stack", (e) => {
        const { label } = JSON.parse((e as MessageEvent).data) as
          { stack: string; label: string };
        setDetectedStack(label);
      });
      es.addEventListener("commands", (e) => {
        const { installCmd, startCmd, subdir: detSubdir } = JSON.parse((e as MessageEvent).data) as
          { installCmd: string | null; startCmd: string | null; subdir?: string | null };
        setDetectedInstall(installCmd);
        setDetectedStart(startCmd);
        if (detSubdir && !subdir.trim()) {
          setDetectedSubdir(detSubdir);
        }
      });
      es.addEventListener("envkeys", (e) => {
        const keys = JSON.parse((e as MessageEvent).data) as Array<{ key: string; defaultValue: string | null }>;
        // Only surface keys the user hasn't already filled in
        const existing = new Set(
          envVars.split("\n").map((l) => l.split("=")[0].trim()).filter(Boolean)
        );
        const missing = keys.filter((k) => !existing.has(k.key));
        if (missing.length > 0) setSuggestedEnvKeys(missing);
      });
      // SSE 'error' fires for BOTH server-sent named errors AND transport
      // blips. Only act on real server errors (have .data); let transport
      // blips auto-reconnect.
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (data) {
          const msg = JSON.parse(data) as string;
          writeln(`✖ ${msg}`, C.red);
          setStatus("error");
          setErrorAlert(msg);
          es.close();
          esRef.current = null;
        }
      });
    } catch (err: any) {
      writeln(`Failed to start: ${err?.message ?? err}`, C.red);
      setStatus("error");
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    if (!activeSandbox) return;
    try { await fetch(`/api/stop/${activeSandbox}`, { method: "POST" }); } catch {}
    esRef.current?.close();
    esRef.current = null;
    setStatus("stopped");
    setActiveSandbox(null);
  };

  const onUrlKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleRun();
  };

  const running = activeSandbox !== null;

  const selectPreview = (opt: PreviewOption) => {
    // If the user clicks the primary tab, resume auto-follow behavior.
    const isPrimary =
      (typeof primaryPreviewPort === "number" && opt.port === primaryPreviewPort) ||
      (!!primaryPreviewUrl && opt.url === primaryPreviewUrl);
    manualPreviewRef.current = !isPrimary;
    setPreviewUrl(opt.url);
    setPreviewPort(opt.port);
  };

  return (
    <div className="flex h-full flex-col bg-[#080c14] text-slate-200">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-[13px] font-bold text-white select-none">⌃Z</span>
          <span className="text-sm font-semibold tracking-tight text-slate-100">ControlZ</span>
        </div>

        <div className="ml-3 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[status]}`} />
          <span className="text-xs text-slate-400">{STATUS_LABEL[status]}</span>
          {detectedStack && (
            <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">
              {detectedStack}
            </span>
          )}
          {previewPort != null && (
            <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[11px] text-slate-500">
              :{previewPort}
            </span>
          )}
        </div>

        <div className="ml-auto">
          <button
            onClick={handleStop}
            disabled={!running}
            className="rounded-md border border-red-900/50 bg-red-950/50 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/60 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-25"
          >
            ■ Stop
          </button>
        </div>
      </header>

      {/* ── URL bar ────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-800 bg-slate-900/40 px-4 py-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            list="recent-repos"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={onUrlKey}
            placeholder="https://github.com/owner/repo"
            disabled={running}
            className="flex-1 rounded-lg border border-slate-700/60 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 transition-colors focus:border-indigo-500/70 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 disabled:opacity-50"
          />
          <datalist id="recent-repos">
            {recentRepos.map((r) => <option key={r} value={r} />)}
          </datalist>
          <button
            onClick={handleRun}
            disabled={starting || running || !url.trim()}
            className="flex min-w-[84px] items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {starting
              ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              : "▶ Run"}
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2">
          {recentRepos.length > 0 && (
            <div className="flex flex-1 flex-wrap items-center gap-1.5 overflow-hidden">
              <span className="shrink-0 text-[11px] text-slate-600">Recent:</span>
              {recentRepos.slice(0, 5).map((r) => {
                const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(r);
                const label = m ? `${m[1]}/${m[2]}` : r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setUrl(r)}
                    disabled={running}
                    title={r}
                    className="max-w-[22ch] truncate rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={clearRecentRepos}
                disabled={running}
                className="text-[11px] text-slate-700 transition-colors hover:text-red-400 disabled:cursor-not-allowed"
              >
                clear
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            disabled={running}
            className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              showAdvanced
                ? "bg-indigo-600/20 text-indigo-300"
                : "text-slate-500 hover:bg-slate-800 hover:text-slate-300"
            }`}
          >
            ⚙ Settings
          </button>
        </div>
      </div>

      {/* ── Settings panel ─────────────────────────────────────────────── */}
      {showAdvanced && !running && (
        <div className="shrink-0 border-b border-slate-800 bg-slate-900/60 px-4 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Subdirectory
              </label>
              <input
                type="text"
                value={subdir}
                onChange={(e) => setSubdir(e.target.value)}
                placeholder="e.g. backend"
                className="w-full rounded-md border border-slate-700/50 bg-[#080c14] px-2.5 py-1.5 text-sm font-mono text-slate-200 placeholder:text-slate-700 transition-colors focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/25"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Stack
              </label>
              <div className="flex flex-wrap gap-1">
                {STACK_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setStack(opt.value)}
                    title={opt.hint}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      stack === opt.value
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Install command
              </label>
              <input
                type="text"
                value={installCommand}
                onChange={(e) => setInstallCommand(e.target.value)}
                placeholder="pip install -r requirements.txt"
                className="w-full rounded-md border border-slate-700/50 bg-[#080c14] px-2.5 py-1.5 text-sm font-mono text-slate-200 placeholder:text-slate-700 transition-colors focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/25"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Start command
              </label>
              <input
                type="text"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                placeholder="python -m uvicorn app.main:app --host 0.0.0.0 --port 3000"
                className="w-full rounded-md border border-slate-700/50 bg-[#080c14] px-2.5 py-1.5 text-sm font-mono text-slate-200 placeholder:text-slate-700 transition-colors focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/25"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Environment variables{" "}
                <span className="normal-case font-normal text-slate-700">· KEY=VALUE per line, # for comments</span>
              </label>
              <textarea
                value={envVars}
                onChange={(e) => setEnvVars(e.target.value)}
                placeholder={"OPENAI_API_KEY=sk-...\nDATABASE_URL=postgres://..."}
                rows={3}
                spellCheck={false}
                className="w-full resize-y rounded-md border border-slate-700/50 bg-[#080c14] px-2.5 py-1.5 text-sm font-mono text-slate-200 placeholder:text-slate-700 transition-colors focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/25"
              />
            </div>
            <div className="col-span-2 border-t border-slate-800/60 pt-3">
              <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <span className="text-indigo-400">✦</span> Claude pre-flight key
                <span className="normal-case font-normal text-slate-700">· optional · claude-haiku-4-5 · ~$0.001/run</span>
              </label>
              <div className="flex gap-2">
                <input
                  type={showAnthropicKey ? "text" : "password"}
                  value={anthropicKey}
                  onChange={(e) => {
                    setAnthropicKey(e.target.value);
                    try { localStorage.setItem(ANTHROPIC_KEY_STORAGE, e.target.value); } catch {}
                  }}
                  placeholder="sk-ant-..."
                  spellCheck={false}
                  className="flex-1 rounded-md border border-slate-700/50 bg-[#080c14] px-2.5 py-1.5 text-sm font-mono text-slate-200 placeholder:text-slate-700 transition-colors focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/25"
                />
                <button
                  type="button"
                  onClick={() => setShowAnthropicKey((v) => !v)}
                  className="rounded-md border border-slate-700/50 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
                >
                  {showAnthropicKey ? "hide" : "show"}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-700">
                When set, Claude reads your repo before install and flags missing env vars, external services, and build gotchas.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Info panels: preflight + env keys + error + detected commands ── */}
      {/* Max 40vh with scroll so they never shrink the terminal/preview split  */}
      <div className="shrink-0 overflow-y-auto" style={{ maxHeight: "40vh" }}>

      {/* ── Claude Pre-flight loading indicator ──────────────────────── */}
      {preflightLoading && !preflight && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-indigo-900/30 bg-indigo-950/10 px-3 py-2">
          <span className="animate-spin text-indigo-400">⠋</span>
          <span className="text-xs text-indigo-400/70">Claude is analysing the repo…</span>
        </div>
      )}

      {/* ── Claude Pre-flight panel ─────────────────────────────────────── */}
      {preflight && (
        <div className="mx-4 mt-2 shrink-0 rounded-lg border border-indigo-900/40 bg-indigo-950/20 px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-400/90">
              <span>✦</span> Claude pre-flight
              {preflight.language && <span className="ml-2 rounded bg-indigo-900/40 px-1.5 py-0.5 font-mono text-indigo-300">{preflight.language}</span>}
              {preflight.confidence && <span className={`rounded px-1.5 py-0.5 text-[10px] ${preflight.confidence === "high" ? "bg-emerald-900/30 text-emerald-400" : preflight.confidence === "low" ? "bg-red-900/30 text-red-400" : "bg-amber-900/30 text-amber-400"}`}>{preflight.confidence}</span>}
            </span>
            <button type="button" onClick={() => setPreflight(null)} className="text-xs leading-none text-indigo-800 transition-colors hover:text-indigo-300">×</button>
          </div>
          {preflight.summary && <p className="mb-2 text-xs text-slate-300 leading-relaxed">{preflight.summary}</p>}
          {(preflight.warnings ?? []).length > 0 && (
            <div className="mb-2 space-y-0.5">
              {(preflight.warnings ?? []).map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs text-amber-300/90">
                  <span className="mt-0.5 shrink-0 text-amber-500">⚠</span>{w}
                </div>
              ))}
            </div>
          )}
          {(preflight.externalServices ?? []).length > 0 && (
            <div className="mb-2 text-xs text-slate-400">
              <span className="text-slate-600">Needs: </span>
              {(preflight.externalServices ?? []).join(", ")}
            </div>
          )}
          {(preflight.requiredEnvVars ?? []).length > 0 && (
            <div className="mb-1">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Required env vars</div>
              <div className="space-y-1">
                {(preflight.requiredEnvVars ?? []).map(({ key, description }) => {
                  const alreadySet = envVars.split("\n").some((l) => l.trim().startsWith(key + "="));
                  return (
                    <div key={key} className="flex items-start gap-2">
                      <code className="w-44 shrink-0 truncate text-xs text-indigo-300/90">{key}</code>
                      <span className="flex-1 truncate text-xs text-slate-500">{description}</span>
                      {!alreadySet && (
                        <button
                          type="button"
                          onClick={() => {
                            setEnvVars((v) => (v.trim() ? v.trimEnd() + "\n" + key + "=" : key + "="));
                            setShowAdvanced(true);
                          }}
                          className="shrink-0 rounded bg-indigo-700/20 px-2 py-0.5 text-[11px] text-indigo-300 transition-colors hover:bg-indigo-600/30"
                        >add</button>
                      )}
                      {alreadySet && <span className="text-[11px] text-emerald-600">✓</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(preflight.optionalEnvVars ?? []).length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-slate-700 hover:text-slate-500">
                {(preflight.optionalEnvVars ?? []).length} optional vars
              </summary>
              <div className="mt-1 space-y-1">
                {(preflight.optionalEnvVars ?? []).map(({ key, description, defaultValue }) => (
                  <div key={key} className="flex items-start gap-2">
                    <code className="w-44 shrink-0 truncate text-xs text-slate-500">{key}</code>
                    <span className="flex-1 truncate text-xs text-slate-700">{description}{defaultValue ? ` (default: ${defaultValue})` : ""}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ── Required env vars banner (.env.example) ────────────────────── */}
      {suggestedEnvKeys.length > 0 && (
        <div className="mx-4 mt-2 shrink-0 rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500/80">
              Required env vars detected from .env.example
            </span>
            <button
              type="button"
              onClick={() => setSuggestedEnvKeys([])}
              className="text-xs leading-none text-amber-700 transition-colors hover:text-amber-400"
              title="Dismiss"
            >×</button>
          </div>
          <div className="space-y-1">
            {suggestedEnvKeys.map(({ key, defaultValue }) => (
              <div key={key} className="flex items-center gap-2">
                <code className="w-52 shrink-0 truncate text-xs text-amber-200/80">{key}</code>
                {defaultValue && (
                  <code className="flex-1 truncate text-xs text-slate-500">{defaultValue}</code>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const line = defaultValue ? `${key}=${defaultValue}` : `${key}=`;
                    setEnvVars((v) => (v.trim() ? v.trimEnd() + "\n" + line : line));
                    setSuggestedEnvKeys((prev) => prev.filter((k) => k.key !== key));
                    setShowAdvanced(true);
                  }}
                  className="rounded bg-amber-700/20 px-2 py-0.5 text-[11px] text-amber-300 transition-colors hover:bg-amber-600/30"
                >
                  add
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              const lines = suggestedEnvKeys.map(({ key, defaultValue }) =>
                defaultValue ? `${key}=${defaultValue}` : `${key}=`
              ).join("\n");
              setEnvVars((v) => (v.trim() ? v.trimEnd() + "\n" + lines : lines));
              setSuggestedEnvKeys([]);
              setShowAdvanced(true);
            }}
            className="mt-2 rounded bg-amber-700/20 px-2.5 py-1 text-[11px] text-amber-300 transition-colors hover:bg-amber-600/30"
          >
            Add all to env vars
          </button>
        </div>
      )}

      {/* ── Error alert ────────────────────────────────────────────────── */}
      {errorAlert && (
        <div className="mx-4 mt-2 shrink-0 flex items-start gap-2.5 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2.5 text-xs text-red-300">
          <span className="mt-0.5 shrink-0 text-red-500">✕</span>
          <span className="flex-1 whitespace-pre-wrap font-mono leading-relaxed">{errorAlert}</span>
          <button
            type="button"
            onClick={() => setErrorAlert(null)}
            className="ml-2 shrink-0 text-lg leading-none text-red-700 transition-colors hover:text-red-300"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Command preview ────────────────────────────────────────────── */}
      {(detectedInstall || detectedStart || detectedSubdir) && (
        <div className="mx-4 mt-2 shrink-0 rounded-lg border border-slate-700/40 bg-slate-900/50 px-3 py-2.5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Detected — click use to copy to settings
          </div>
          {detectedSubdir && (
            <div className="flex items-center gap-2 py-0.5">
              <span className="w-14 shrink-0 text-[11px] text-slate-600">subdir</span>
              <code className="flex-1 truncate text-xs text-slate-300">{detectedSubdir}</code>
              <button
                type="button"
                onClick={() => { setSubdir(detectedSubdir); setDetectedSubdir(null); setShowAdvanced(true); }}
                className="rounded bg-indigo-600/20 px-2 py-0.5 text-[11px] text-indigo-300 transition-colors hover:bg-indigo-600/40"
              >
                use
              </button>
            </div>
          )}
          {detectedInstall && (
            <div className="flex items-center gap-2 py-0.5">
              <span className="w-14 shrink-0 text-[11px] text-slate-600">install</span>
              <code className="flex-1 truncate text-xs text-slate-300">{detectedInstall}</code>
              <button
                type="button"
                onClick={() => { setInstallCommand(detectedInstall); setShowAdvanced(true); }}
                className="rounded bg-indigo-600/20 px-2 py-0.5 text-[11px] text-indigo-300 transition-colors hover:bg-indigo-600/40"
              >
                use
              </button>
            </div>
          )}
          {detectedStart && (
            <div className="flex items-center gap-2 py-0.5">
              <span className="w-14 shrink-0 text-[11px] text-slate-600">start</span>
              <code className="flex-1 truncate text-xs text-slate-300">{detectedStart}</code>
              <button
                type="button"
                onClick={() => { setCustomCommand(detectedStart); setShowAdvanced(true); }}
                className="rounded bg-indigo-600/20 px-2 py-0.5 text-[11px] text-indigo-300 transition-colors hover:bg-indigo-600/40"
              >
                use
              </button>
            </div>
          )}
        </div>
      )}

      </div>{/* end info panels scroll container */}

      {/* ── Main split: logs + preview ─────────────────────────────────── */}
      <div className="mt-2 grid min-h-0 flex-1 grid-cols-2 gap-px bg-slate-800/20">

        {/* Terminal pane */}
        <div className="flex min-h-0 flex-col bg-[#080c14]">
          <div className="flex shrink-0 items-center border-b border-slate-800 px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Logs</span>
          </div>
          <div ref={termRef} className="min-h-0 flex-1" />
        </div>

        {/* Preview pane */}
        <div className="flex min-h-0 flex-col bg-slate-950">
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Preview</span>            <div className="flex flex-1 flex-wrap items-center gap-1">
              {previewOptions.length > 1 && previewOptions.map((opt) => {
                const active = previewPort != null ? opt.port === previewPort : opt.url === previewUrl;
                const isPrimary =
                  (typeof primaryPreviewPort === "number" && opt.port === primaryPreviewPort) ||
                  (!!primaryPreviewUrl && opt.url === primaryPreviewUrl);
                return (
                  <button
                    key={opt.port}
                    type="button"
                    onClick={() => selectPreview(opt)}
                    title={opt.url}
                    className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      active
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                    }`}
                  >
                    {isPrimary ? `${opt.label || "App"} ★` : (opt.label || "App")} :{opt.port}
                  </button>
                );
              })}
            </div>
            {previewUrl && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPreviewKey((k) => k + 1)}
                  title="Reload preview"
                  className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                >⟳ Reload</button>
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in new tab"
                  className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                >↗ Open</a>
              </div>
            )}
          </div>
          <div className="relative min-h-0 flex-1">
            {!previewUrl && status !== "idle" && status !== "stopped" && status !== "error" && (
              <AsciiLoader status={status} />
            )}
            {previewUrl ? (
              <iframe
                key={previewKey}
                src={previewUrl}
                className="h-full w-full border-0"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-8 text-center text-sm text-slate-700">
                Preview will appear here once a web server starts
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
