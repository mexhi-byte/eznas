import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getConnection, post, put, useResource } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill } from "./components";
import { Field, Input, Modal, Toggle, useSubmit } from "./ui";

/* ---------------------------------------------------------------- network */

interface Iface {
  id: string;
  name: string;
  type: string;
  description: string;
  dhcp: boolean;
  mtu: number | null;
  aliases: Array<{ address: string; netmask: number; type: string }>;
  linkState: string;
  mac: string;
}

interface NetworkData {
  pendingChanges: boolean;
  global: {
    hostname: string; domain: string; ipv4gateway: string;
    nameserver1: string; nameserver2: string; nameserver3: string;
  };
  interfaces: Iface[];
}

export function NetworkPage() {
  const { data, error, loading, reload } = useResource<NetworkData>("/api/network", 20_000);
  const [editing, setEditing] = useState<Iface | null>(null);
  const [editGlobal, setEditGlobal] = useState(false);
  const [commit, setCommit] = useState<{ deadline: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // While a commit is outstanding the NAS is counting down to an automatic
  // rollback, so the page has to keep showing how long is left.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!commit) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [commit]);

  const secondsLeft = commit ? Math.max(0, Math.round((commit.deadline - Date.now()) / 1000)) : 0;
  useEffect(() => {
    if (commit && secondsLeft === 0) {
      setCommit(null);
      setNote("The confirmation window closed, so the NAS rolled the change back.");
      void reload();
    }
  }, [commit, secondsLeft, reload]);

  async function doCommit() {
    const r = await post<{ checkinTimeout: number }>("/api/network/commit", { timeout: 60 });
    setCommit({ deadline: Date.now() + r.checkinTimeout * 1000 });
    setNote(null);
  }

  async function keep() {
    await post("/api/network/checkin");
    setCommit(null);
    setNote("Change confirmed and kept.");
    await reload();
  }

  async function revert() {
    await post("/api/network/rollback");
    setCommit(null);
    setNote("Rolled back.");
    await reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Network</h1>
          <div className="page-sub">Interfaces, addresses and DNS.</div>
        </div>
        <button className="btn" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setEditGlobal(true)}>
          Hostname & DNS
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {note && <div className="job done" style={{ marginBottom: 14 }}><span className="job-label">{note}</span></div>}

      {/* The single most dangerous thing in this console: an address change
          applied over the link being changed. The NAS reverts unless someone
          confirms, and this makes that window visible. */}
      {data?.pendingChanges && !commit && (
        <Card className="" >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="pill warn">unapplied changes</span>
            <span style={{ flex: 1, fontSize: 13, color: "var(--muted)" }}>
              Interface changes are staged but not live. Applying starts a 60-second timer — if you do not confirm,
              the NAS puts the old settings back, so a mistake cannot lock you out.
            </span>
            <button className="btn primary" style={{ flex: "none" }} onClick={() => void doCommit()}>Apply</button>
            <button className="btn" style={{ flex: "none" }} onClick={() => void revert()}>Discard</button>
          </div>
        </Card>
      )}

      {commit && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="pill bad">confirm within {secondsLeft}s</span>
            <span style={{ flex: 1, fontSize: 13, color: "var(--muted)" }}>
              The new settings are live. If this page still works, confirm them. Doing nothing reverts automatically.
            </span>
            <button className="btn primary" style={{ flex: "none" }} onClick={() => void keep()}>Keep them</button>
            <button className="btn danger" style={{ flex: "none" }} onClick={() => void revert()}>Revert now</button>
          </div>
        </Card>
      )}

      {loading && !data && <Loading rows={3} />}

      <div className="grid two" style={{ marginTop: 14 }}>
        <Card title="Global">
          {data && (
            <table>
              <tbody>
                <Row k="Hostname" v={`${data.global.hostname}${data.global.domain ? "." + data.global.domain : ""}`} />
                <Row k="Gateway" v={data.global.ipv4gateway || "—"} />
                <Row k="DNS" v={[data.global.nameserver1, data.global.nameserver2, data.global.nameserver3].filter(Boolean).join(", ") || "—"} />
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Interfaces">
          <div className="grid" style={{ gap: 10 }}>
            {data?.interfaces.map((i) => (
              <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 11, flexWrap: "wrap" }}>
                <strong className="mono" style={{ fontSize: 13.5 }}>{i.id}</strong>
                <Pill state={i.linkState === "LINK_STATE_UP" ? "ONLINE" : "OFFLINE"}>
                  {i.linkState === "LINK_STATE_UP" ? "up" : "down"}
                </Pill>
                {i.dhcp ? <span className="pill info">DHCP</span> : null}
                <span style={{ flex: 1, minWidth: 120, color: "var(--muted)", fontSize: 12.5 }} className="mono">
                  {i.aliases.map((a) => `${a.address}/${a.netmask}`).join(", ") || "no address"}
                </span>
                <button className="btn" style={{ flex: "none" }} onClick={() => setEditing(i)}>Edit</button>
              </div>
            ))}
            {!data?.interfaces.length && !loading && <Empty>No interfaces.</Empty>}
          </div>
        </Card>
      </div>

      {editing && (
        <IfaceForm iface={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />
      )}
      {editGlobal && data && (
        <GlobalForm cfg={data.global} onClose={() => setEditGlobal(false)} onSaved={() => { setEditGlobal(false); void reload(); }} />
      )}
    </>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <tr>
    <td style={{ color: "var(--muted)", width: 110 }}>{k}</td>
    <td className="mono">{v}</td>
  </tr>
);

function IfaceForm({ iface, onClose, onSaved }: { iface: Iface; onClose: () => void; onSaved: () => void }) {
  const [dhcp, setDhcp] = useState(iface.dhcp);
  const [address, setAddress] = useState(iface.aliases[0]?.address ?? "");
  const [netmask, setNetmask] = useState(String(iface.aliases[0]?.netmask ?? 24));
  const [mtu, setMtu] = useState(iface.mtu ? String(iface.mtu) : "");
  const [description, setDescription] = useState(iface.description ?? "");

  const { busy, error, submit } = useSubmit(async () => {
    await put(`/api/network/interfaces/${encodeURIComponent(iface.id)}`, {
      dhcp,
      description,
      mtu: mtu ? Number(mtu) : null,
      aliases: dhcp ? [] : [{ address, netmask: Number(netmask), type: "INET" }],
    });
    onSaved();
  });

  return (
    <Modal
      title={`Edit ${iface.id}`}
      subtitle="Changes are staged. Nothing takes effect until you apply them."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || (!dhcp && !address)} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Stage change"}
          </button>
        </>
      }
    >
      <Toggle checked={dhcp} onChange={setDhcp} label="Get an address automatically (DHCP)" />

      {!dhcp && (
        <div className="row">
          <Field label="Address">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="10.11.10.127" />
          </Field>
          <Field label="Prefix">
            <Input type="number" min="1" max="32" value={netmask} onChange={(e) => setNetmask(e.target.value)} />
          </Field>
        </div>
      )}

      <div className="row">
        <Field label="MTU" hint="Blank for the default.">
          <Input type="number" value={mtu} onChange={(e) => setMtu(e.target.value)} placeholder="1500" />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      <p className="modal-text">
        MAC {iface.mac || "unknown"} · {iface.type.toLowerCase()}
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

function GlobalForm({ cfg, onClose, onSaved }: { cfg: NetworkData["global"]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ ...cfg });
  const { busy, error, submit } = useSubmit(async () => {
    await put("/api/network/global", v);
    onSaved();
  });
  const set = (k: keyof NetworkData["global"]) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));

  return (
    <Modal
      title="Hostname & DNS"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="row">
        <Field label="Hostname"><Input value={v.hostname} onChange={set("hostname")} /></Field>
        <Field label="Domain"><Input value={v.domain} onChange={set("domain")} /></Field>
      </div>
      <Field label="Default gateway"><Input value={v.ipv4gateway} onChange={set("ipv4gateway")} /></Field>
      <div className="row">
        <Field label="DNS 1"><Input value={v.nameserver1} onChange={set("nameserver1")} /></Field>
        <Field label="DNS 2"><Input value={v.nameserver2} onChange={set("nameserver2")} /></Field>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

/* --------------------------------------------------------------- terminal */

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
