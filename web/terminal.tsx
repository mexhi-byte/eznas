import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getConnection } from "./api";

export function TerminalPage() {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    if (!host.current) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      // Read from the live theme so the terminal is not the one element on the
      // page still wearing the old palette.
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue("--panel-solid").trim() || "#05080c",
        foreground: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#e8edf4",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const c = getConnection();
    const ws = new WebSocket(`${proto}//${window.location.host}/shell${c ? `?c=${encodeURIComponent(c)}` : ""}`);

    ws.onopen = () => {
      setStatus("open");
      term.focus();
    };
    ws.onmessage = (ev) => term.write(ev.data);
    ws.onclose = () => {
      setStatus("closed");
      term.write("\r\n\x1b[90m— session ended —\x1b[0m\r\n");
    };
    ws.onerror = () => setStatus("closed");

    term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(d));
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: { cols, rows } }));
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
    };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Terminal</h1>
          <div className="page-sub">A shell on the NAS itself. Everything here runs as the API user.</div>
        </div>
        <span className={`pill ${status === "open" ? "ok" : status === "connecting" ? "warn" : "mute"}`}>
          <i className={`dot ${status === "open" ? "live" : ""}`} />
          {status}
        </span>
      </div>

      <div className="term-wrap" style={{ height: "calc(100vh - 190px)", minHeight: 380 }}>
        <div ref={host} style={{ height: "100%" }} />
      </div>
    </>
  );
}
