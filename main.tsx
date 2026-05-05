import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

type Status =
  | "idle" | "cloning" | "detecting" | "installing"
  | "running" | "error" | "stopped";

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

const STATUS_COLORS: Record<Status, string> = {
  idle: "bg-neutral-700 text-neutral-300",
  cloning: "bg-blue-700 text-white",
  detecting: "bg-blue-700 text-white",
  installing: "bg-blue-700 text-white",
  running: "bg-emerald-700 text-white",
  error: "bg-red-700 text-white",
  stopped: "bg-neutral-700 text-neutral-300",
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
      theme: { background: "#0a0a0a", foreground: "#e5e5e5" },
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
                    : stream === "status" ? C.cyan : "";
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
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div className="font-bold tracking-tight">RepoRunner</div>
        <button onClick={handleStop} disabled={!running}
          className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500">
          Stop sandbox
        </button>
      </div>
      <div className="flex gap-2 px-4 py-3">
        <input type="text" value={url}
          onChange={(e) => setUrl(e.target.value)} onKeyDown={onUrlKey}
          placeholder="Paste a public GitHub repo URL" disabled={running}
          className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none disabled:opacity-60" />
        <button onClick={handleRun}
          disabled={starting || running || !url.trim()}
          className="flex min-w-[88px] items-center justify-center rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500">
          {starting ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : ("Run")}
        </button>
      </div>
      <details className="px-4 pb-2 text-sm">
        <summary className="cursor-pointer select-none text-neutral-400 hover:text-neutral-200">
          Advanced
        </summary>
        <div className="mt-2">
          <input type="text" value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            placeholder="Custom start command (optional)" disabled={running}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm font-mono placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none disabled:opacity-60" />
        </div>
      </details>
      <div className="px-4 py-2">
        <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[status]}`}>
          {status}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-neutral-800">
        <div className="bg-neutral-950">
          <div ref={termRef} className="h-full w-full" />
        </div>
        <div className="bg-neutral-950">
          {previewUrl ? (
            <iframe src={previewUrl} className="h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-neutral-500">
              No preview yet — the app will appear here once a web server starts.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
