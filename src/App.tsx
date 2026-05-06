import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type Status =
  | "idle" | "cloning" | "detecting" | "installing"
  | "running" | "error" | "stopped";

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

const STATUS_COLORS: Record<Status, string> = {
  idle: "bg-neutral-950 text-emerald-300 border border-emerald-900/60",
  cloning: "bg-amber-950 text-amber-200 border border-amber-900/60",
  detecting: "bg-amber-950 text-amber-200 border border-amber-900/60",
  installing: "bg-amber-950 text-amber-200 border border-amber-900/60",
  running: "bg-emerald-900 text-emerald-50 border border-emerald-700/60",
  error: "bg-rose-950 text-rose-200 border border-rose-900/60",
  stopped: "bg-neutral-950 text-emerald-300 border border-emerald-900/60",
};

export function App() {
  const [url, setUrl] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [stack, setStack] = useState<Stack>("auto");
  const [envVars, setEnvVars] = useState("");
  const [status, setStatus] = useState<Status>("idle");
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
        background: "#050806",
        foreground: "#b7f0c5",
        cursor: "#d1fae5",
        cursorAccent: "#050806",
        selectionBackground: "#0f2a1a",
        black: "#050806",
        brightBlack: "#0b1410",
        green: "#34d399",
        brightGreen: "#86efac",
        red: "#fb7185",
        yellow: "#fbbf24",
        cyan: "#22d3ee",
        white: "#d1fae5",
        brightWhite: "#ecfdf5",
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
    terminalRef.current?.clear();
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          customCommand: customCommand.trim() || undefined,
          stack,
          envs: envVars,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        writeln(`Failed to start: ${body.error ?? res.statusText}`, C.red);
        setStatus("error");
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
      // SSE 'error' fires for BOTH server-sent named errors AND transport
      // blips. Only act on real server errors (have .data); let transport
      // blips auto-reconnect.
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (data) {
          const msg = JSON.parse(data) as string;
          writeln(`✖ ${msg}`, C.red);
          setStatus("error");
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
    <div className="flex h-full flex-col bg-neutral-950 text-emerald-200">
      <div className="flex items-center justify-between border-b border-emerald-900/60 px-4 py-3">
        <div className="font-bold tracking-tight text-emerald-200">RepoRunner</div>
        <button onClick={handleStop} disabled={!running}
          className="rounded border border-rose-900/60 bg-rose-950 px-3 py-1 text-sm font-medium text-rose-200 hover:bg-rose-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/80 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:cursor-not-allowed disabled:border-emerald-900/40 disabled:bg-neutral-950 disabled:text-emerald-700/60">
          Stop sandbox
        </button>
      </div>
      <div className="flex gap-2 px-4 py-3">
        <input type="text" value={url}
          list="recent-repos"
          onChange={(e) => setUrl(e.target.value)} onKeyDown={onUrlKey}
          placeholder="Paste a public GitHub repo URL" disabled={running}
          className="flex-1 rounded border border-emerald-900/60 bg-neutral-950 px-3 py-2 text-sm text-emerald-200 placeholder:text-emerald-700 focus:border-emerald-600/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:opacity-60" />
        <datalist id="recent-repos">
          {recentRepos.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <button onClick={handleRun}
          disabled={starting || running || !url.trim()}
          className="flex min-w-[88px] items-center justify-center rounded border border-emerald-700/60 bg-emerald-900 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/80 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:cursor-not-allowed disabled:border-emerald-900/40 disabled:bg-neutral-950 disabled:text-emerald-700/60">
          {starting ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : ("Run")}
        </button>
      </div>
      {recentRepos.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs">
          <span className="mr-1 text-emerald-700">Recent:</span>
          {recentRepos.slice(0, 5).map((r) => {
            // Show just owner/name to keep chips compact.
            const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(r);
            const label = m ? `${m[1]}/${m[2]}` : r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setUrl(r)}
                disabled={running}
                title={r}
                className="max-w-[28ch] truncate rounded-full border border-emerald-900/60 bg-neutral-950 px-2.5 py-0.5 text-emerald-300 hover:border-emerald-700/60 hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={clearRecentRepos}
            disabled={running}
            className="ml-auto text-emerald-700 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 disabled:cursor-not-allowed disabled:opacity-60"
            title="Clear history"
          >
            clear
          </button>
        </div>
      )}
      <details className="px-4 pb-2 text-sm">
        <summary className="cursor-pointer select-none text-emerald-400/80 hover:text-emerald-200">
          Advanced
        </summary>
        <div className="mt-3 space-y-3">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-emerald-400/70">
              Stack
            </label>
            <div className="flex flex-wrap gap-1.5">
              {STACK_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={running}
                  onClick={() => setStack(opt.value)}
                  title={opt.hint}
                  className={`rounded border px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:cursor-not-allowed disabled:opacity-50 ${
                    stack === opt.value
                      ? "border-emerald-700/60 bg-emerald-900 text-emerald-50"
                      : "border-emerald-900/60 bg-neutral-950 text-emerald-300 hover:border-emerald-700/60"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-emerald-400/70">
              Custom start command
            </label>
            <input type="text" value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="Overrides detection (e.g. python -u server.py)" disabled={running}
              className="w-full rounded border border-emerald-900/60 bg-neutral-950 px-3 py-2 text-sm font-mono text-emerald-200 placeholder:text-emerald-700 focus:border-emerald-600/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:opacity-60" />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-emerald-400/70">
              Environment variables
              <span className="ml-2 normal-case text-emerald-700">KEY=VALUE per line, # for comments</span>
            </label>
            <textarea value={envVars}
              onChange={(e) => setEnvVars(e.target.value)}
              placeholder={"OPENAI_API_KEY=sk-...\nLDR_BOOTSTRAP_ALLOW_UNENCRYPTED=true"}
              disabled={running} rows={4}
              spellCheck={false}
              className="w-full resize-y rounded border border-emerald-900/60 bg-neutral-950 px-3 py-2 text-sm font-mono text-emerald-200 placeholder:text-emerald-700 focus:border-emerald-600/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:opacity-60" />
          </div>
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[status]}`}>
          {status}
        </span>
        {detectedStack && (
          <span
            title="Detected primary stack"
            className="inline-block rounded-full border border-emerald-700/60 bg-emerald-950/60 px-3 py-1 text-xs font-medium text-emerald-300"
          >
            {detectedStack}
          </span>
        )}
        {previewPort != null && (
          <span
            title="Preview port inside sandbox"
            className="inline-block rounded-full border border-emerald-700/60 bg-emerald-950/60 px-3 py-1 text-xs font-medium text-emerald-300"
          >
            :{previewPort}
          </span>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-emerald-950">
        <div className="bg-neutral-950">
          <div ref={termRef} className="h-full w-full" />
        </div>
        <div className="relative bg-neutral-950">
          {previewUrl ? (
            <>
              {previewOptions.length > 1 && (
                <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-1.5">
                  {previewOptions.map((opt) => {
                    const active = previewPort != null ? opt.port === previewPort : opt.url === previewUrl;
                    const isPrimary =
                      (typeof primaryPreviewPort === "number" && opt.port === primaryPreviewPort) ||
                      (!!primaryPreviewUrl && opt.url === primaryPreviewUrl);
                    const label = isPrimary ? `${opt.label || "Preview"}*` : (opt.label || "Preview");
                    return (
                      <button
                        key={opt.port}
                        type="button"
                        onClick={() => selectPreview(opt)}
                        className={`rounded border px-2 py-1 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/80 ${
                          active
                            ? "border-emerald-700/60 bg-emerald-900/90 text-emerald-50"
                            : "border-emerald-900/60 bg-neutral-950/90 text-emerald-300 hover:border-emerald-700/60"
                        }`}
                        title={opt.url}
                      >
                        {label} :{opt.port}
                      </button>
                    );
                  })}
                </div>
              )}
              <iframe src={previewUrl} className="h-full w-full border-0"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
              <a href={previewUrl} target="_blank" rel="noopener noreferrer"
                className="absolute right-3 top-3 rounded border border-emerald-700/60 bg-emerald-900/90 px-2.5 py-1 text-xs font-medium text-emerald-50 shadow hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/80"
                title="Open in new tab (bypasses iframe restrictions like X-Frame-Options/CSP)">
                Open ↗
              </a>
            </>
          ) : (
            <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-emerald-700">
              No preview yet — the app will appear here once a web server starts.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
