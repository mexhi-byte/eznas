import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { get, getConnection } from "./api";
import { ErrorBanner, Loading } from "./components";
import { Modal, Select } from "./ui";

/**
 * An app's logs, or a shell inside one of its containers, without leaving
 * the Apps page.
 *
 * Same proxy as the Terminal page, with a mode. The browser sends the app's
 * name and a container id and nothing else; the server decides what command
 * that means. Logs are read-only by nature but routinely contain tokens, and
 * a shell is a shell, so both are admin-only — the server refuses the
 * upgrade for anyone else, and the buttons are hidden from viewers as well.
 */

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
}

export function AppConsoleModal({ app, mode, onClose }: { app: string; mode: "logs" | "exec"; onClose: () => void }) {
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>("");

  useEffect(() => {
    get<Container[]>(`/api/apps/${encodeURIComponent(app)}/containers`)
      .then((list) => {
        setContainers(list);
        if (list.length && !chosen) setChosen(list[0].id);
        if (!list.length) setError(`${app} has no running containers. Start it first.`);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // Once, when opened. Choosing another container is done in the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app]);

  return (
    <Modal
      title={mode === "logs" ? `Logs · ${app}` : `Shell · ${app}`}
      subtitle={
        mode === "logs"
          ? "The last 200 lines, then live. Ctrl+C here only stops following."
          : "A shell inside the container, as the container's own user. Type exit to leave."
      }
      onClose={onClose}
      wide
      footer={
        <>
          {containers && containers.length > 1 && (
            <Select
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              style={{ marginRight: "auto", maxWidth: 320 }}
            >
              {containers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id.slice(0, 12)} · {c.state.toLowerCase()}
                </option>
              ))}
            </Select>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!containers && !error && <Loading rows={3} />}
      {chosen && <ConsoleTerminal key={chosen} app={app} mode={mode} container={chosen} />}
    </Modal>
  );
}

function ConsoleTerminal({ app, mode, container }: { app: string; mode: "logs" | "exec"; container: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      cursorBlink: mode === "exec",
      disableStdin: mode === "logs",
      convertEol: true,
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue("--panel-solid").trim() || "#05080c",
        foreground: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#e8edf4",
      },
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const c = getConnection();
    const q = new URLSearchParams({ mode, app, container });
    if (c) q.set("c", c);
    const ws = new WebSocket(`${proto}//${window.location.host}/shell?${q}`);

    ws.onopen = () => {
      setStatus("open");
      if (mode === "exec") term.focus();
    };
    ws.onmessage = (ev) => term.write(ev.data);
    ws.onclose = () => {
      setStatus("closed");
      term.write(`\r\n\x1b[90m— ${mode === "logs" ? "log stream ended" : "session ended"} —\x1b[0m\r\n`);
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
  }, [app, mode, container]);

  return (
    <div className="app-console">
      <div className="app-console-bar">
        <span className="mono">{container.slice(0, 12)}</span>
        <span className={`pill ${status === "open" ? "ok" : status === "connecting" ? "warn" : "mute"}`}>
          <i className={`dot ${status === "open" ? "live" : ""}`} />
          {status}
        </span>
      </div>
      <div ref={host} className="app-console-term" />
    </div>
  );
}
