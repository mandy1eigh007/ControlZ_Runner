import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type Status =
  | "idle" | "cloning" | "detecting" | "installing"
  | "running" | "error" | "stopped";

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
  const [status, setStatus] = useState<Status>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [activeSandbox, setActiveSandbox] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    setTimeout(() => fit.fit(), 0);
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
    terminalRef.current?.clear();
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          customCommand: customCommand.trim() || undefined,
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

      const qs = new URLSearchParams({ url, customCommand: customCommand || "" });
      const es = new EventSource(`/api/run/${sandboxId}/stream?${qs.toString()}`);
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
        const { url: u } = JSON.parse((e as MessageEvent).data) as { url: string };
        setPreviewUrl(u);
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
          onChange={(e) => setUrl(e.target.value)} onKeyDown={onUrlKey}
          placeholder="Paste a public GitHub repo URL" disabled={running}
          className="flex-1 rounded border border-emerald-900/60 bg-neutral-950 px-3 py-2 text-sm text-emerald-200 placeholder:text-emerald-700 focus:border-emerald-600/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:opacity-60" />
        <button onClick={handleRun}
          disabled={starting || running || !url.trim()}
          className="flex min-w-[88px] items-center justify-center rounded border border-emerald-700/60 bg-emerald-900 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/80 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:cursor-not-allowed disabled:border-emerald-900/40 disabled:bg-neutral-950 disabled:text-emerald-700/60">
          {starting ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : ("Run")}
        </button>
      </div>
      <details className="px-4 pb-2 text-sm">
        <summary className="cursor-pointer select-none text-emerald-400/80 hover:text-emerald-200">
          Advanced
        </summary>
        <div className="mt-2">
          <input type="text" value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            placeholder="Custom start command (optional)" disabled={running}
            className="w-full rounded border border-emerald-900/60 bg-neutral-950 px-3 py-2 text-sm font-mono text-emerald-200 placeholder:text-emerald-700 focus:border-emerald-600/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:opacity-60" />
        </div>
      </details>
      <div className="px-4 py-2">
        <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[status]}`}>
          {status}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-emerald-950">
        <div className="bg-neutral-950">
          <div ref={termRef} className="h-full w-full" />
        </div>
        <div className="bg-neutral-950">
          {previewUrl ? (
            <iframe src={previewUrl} className="h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
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
