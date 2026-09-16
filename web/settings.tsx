import { useState } from "react";
import { del, get, getConnection, post, put, setConnection, useResource } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill, TAGLINE } from "./components";
import { DangerConfirm, Field, Input, Modal, Toggle, useSubmit } from "./ui";
import {
  AppearanceTab,
  ConsoleUpdateTab,
  EmailTab,
  NotificationsTab,
  SecurityTab,
  UpdatesTab,
  type WatchConfig,
  type Webhook,
} from "./settings-tabs";
import { ConsoleUsersTab } from "./console-users";
import { describeCertificate, prettyFingerprint, type SeenCertificate } from "./certificate";

/* --------------------------------------------------------------- settings */

export interface Conn {
  id: string;
  name: string;
  url: string;
  fingerprint: string | null;
  hasKey: boolean;
  isDefault: boolean;
  connected: boolean;
  error: string | null;
  hasSudo: boolean;
}

function ServersTab() {
  const { data, error, loading, reload } = useResource<Conn[]>("/api/connections", 15_000);
  const [editing, setEditing] = useState<Conn | "new" | null>(null);
  const [removing, setRemoving] = useState<Conn | null>(null);

  return (
    <>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}
      >
        <span className="card-title">Which TrueNAS machines this console can manage.</span>
        <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setEditing("new")}>
          Add a server
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {loading && !data && <Loading rows={2} />}

      <div className="grid" style={{ gap: 12 }}>
        {data?.map((c) => (
          <Card key={c.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <strong style={{ fontSize: 15 }}>{c.name}</strong>
                  {c.isDefault && <span className="pill info">default</span>}
                  <Pill state={c.connected ? "ONLINE" : "OFFLINE"}>{c.connected ? "connected" : "not connected"}</Pill>
                </div>
                <div className="stat-foot mono" style={{ marginTop: 4 }}>
                  {c.url}
                </div>
                {c.error && (
                  <div className="stat-foot" style={{ color: "var(--bad)", marginTop: 4 }}>
                    {c.error}
                  </div>
                )}
                <div className="stat-foot" style={{ marginTop: 4 }}>
                  {c.fingerprint ? `certificate pinned · ${c.fingerprint.slice(0, 16)}…` : "certificate not pinned"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 7 }}>
                {getConnection() !== c.id && (
                  <button
                    className="btn"
                    style={{ flex: "none" }}
                    onClick={() => {
                      setConnection(c.id);
                      window.location.reload();
                    }}
                  >
                    Use
                  </button>
                )}
                <button className="btn" style={{ flex: "none" }} onClick={() => setEditing(c)}>
                  Edit
                </button>
                <button className="btn danger" style={{ flex: "none" }} onClick={() => setRemoving(c)}>
                  Remove
                </button>
              </div>
            </div>
          </Card>
        ))}
        {!loading && !data?.length && (
          <Card>
            <Empty>No servers yet. Add one to get started.</Empty>
          </Card>
        )}
      </div>

      {!!data?.length && <PowerCard />}

      {editing && (
        <ConnectionForm
          conn={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="server"
          name={removing.name}
          verb="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/connections/${removing.id}`);
            if (getConnection() === removing.id) setConnection(null);
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              This only forgets the connection here. Nothing on the NAS changes.
            </p>
          }
        />
      )}
    </>
  );
}

/**
 * Restart or shut down the NAS this console is pointed at.
 *
 * Here rather than on Home because it is not something anyone does often, and
 * because the confirmation needs the machine's own hostname, which this tab is
 * already about. The server refuses the request without that name typed back.
 */
function PowerCard() {
  const [action, setAction] = useState<"reboot" | "shutdown" | null>(null);
  const [hostname, setHostname] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(next: "reboot" | "shutdown") {
    setError(null);
    setDone(null);
    try {
      const { hostname: h } = await get<{ hostname: string }>("/api/system/power");
      setHostname(h);
      setAction(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const verb = action === "reboot" ? "Restart" : "Shut down";

  return (
    <Card title="Power" className="power-card">
      <p className="modal-text" style={{ marginTop: 0 }}>
        Every app and every shared folder goes offline while the NAS is down. A restart comes back on its own in a few
        minutes; after a shutdown, somebody has to press the button on the machine.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void ask("reboot")}>
          Restart the NAS…
        </button>
        <button className="btn danger" onClick={() => void ask("shutdown")}>
          Shut down the NAS…
        </button>
      </div>
      {done && (
        <div className="job done" style={{ marginTop: 12, marginBottom: 0 }}>
          {done}
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {action && hostname !== null && (
        <DangerConfirm
          what="the NAS"
          name={hostname}
          verb={verb}
          onCancel={() => setAction(null)}
          onConfirm={async (confirm) => {
            const r = await post<{ hostname: string }>("/api/system/power", { action, confirm });
            setDone(
              action === "reboot"
                ? `${r.hostname} is restarting. This console will show it as unreachable until it is back.`
                : `${r.hostname} is shutting down.`,
            );
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              {action === "reboot"
                ? "Apps stop, shares disappear, and the console loses contact until the NAS is back — usually two to five minutes."
                : "Nothing on the network will reach this machine until somebody turns it on again at the machine itself."}
            </p>
          }
        />
      )}
    </Card>
  );
}

function ConnectionForm({ conn, onClose, onSaved }: { conn: Conn | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(conn?.name ?? "");
  const [url, setUrl] = useState(conn?.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [tested, setTested] = useState<{ ok: boolean; error?: string; version?: string; hostname?: string } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);

  /*
   * Trust on first use. The console looks at the certificate the address
   * presents and offers to remember it; the operator sees what is being
   * trusted rather than pasting a hex string from somewhere else. On by
   * default for a new server, because a pin is the only authentication this
   * connection will ever have. For an existing pinned server the switch
   * reflects the pin, and a changed certificate is pointed out rather than
   * silently re-pinned.
   */
  const [cert, setCert] = useState<SeenCertificate | null>(null);
  const [certError, setCertError] = useState<string | null>(null);
  const [pin, setPin] = useState(conn ? !!conn.fingerprint : true);
  const changed = !!conn?.fingerprint && !!cert && cert.fingerprint !== conn.fingerprint;

  async function look(): Promise<SeenCertificate | null> {
    if (!url.trim()) return null;
    setCertError(null);
    try {
      const seen = await post<SeenCertificate>("/api/connections/certificate", { url });
      setCert(seen);
      return seen;
    } catch (e) {
      setCert(null);
      setCertError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  const { busy, error, submit } = useSubmit(async () => {
    // Pinning without having looked is not pinning. Look now, and refuse to
    // save a pin that could not be read rather than saving none quietly.
    let seen = cert;
    if (pin && !seen) {
      seen = await look();
      if (!seen)
        throw new Error(
          "The certificate could not be read, so it cannot be pinned. Turn pinning off to save without it.",
        );
    }
    const fingerprint = pin ? (seen?.fingerprint ?? conn?.fingerprint ?? null) : null;
    const payload = { name, url, apiKey, fingerprint, sudoPassword: sudoPassword || undefined };
    if (conn) await put(`/api/connections/${conn.id}`, payload);
    else await post("/api/connections", payload);
    onSaved();
  });

  async function test() {
    setTesting(true);
    setTested(null);
    try {
      const r = await post<{
        ok: boolean;
        error?: string;
        version?: string;
        hostname?: string;
        certificate: SeenCertificate | null;
      }>("/api/connections/test", { url, apiKey, fingerprint: pin ? (conn?.fingerprint ?? null) : null });
      setTested(r);
      if (r.certificate) setCert(r.certificate);
      if (r.ok && r.hostname && !name) setName(r.hostname);
    } catch (e) {
      setTested({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal
      title={conn ? `Edit ${conn.name}` : "Add a TrueNAS server"}
      subtitle="The API key is stored encrypted and never sent back to the browser."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={() => void test()} disabled={testing || !url || (!apiKey && !conn)}>
            {testing ? "Testing…" : "Test"}
          </button>
          <button
            className="btn primary"
            disabled={busy || !name || !url || (!conn && !apiKey)}
            onClick={() => void submit(undefined as void)}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main NAS" autoFocus />
      </Field>

      <Field label="Address" hint="An address is enough — 192.168.1.10. https:// and /api/current are added for you.">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => void look()}
          placeholder="192.168.1.10"
        />
      </Field>

      <Field
        label={conn ? "API key (leave blank to keep the current one)" : "API key"}
        hint="TrueNAS → Credentials → Local Users → API keys. The key inherits that user's privileges."
      >
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={conn ? "unchanged" : "1-…"}
        />
      </Field>

      <div className="cert-block">
        <div className="cert-head">
          <span className="field-label">Certificate</span>
          <button type="button" className="btn small" onClick={() => void look()} disabled={!url.trim()}>
            {cert ? "Look again" : "Look"}
          </button>
        </div>
        {cert ? (
          <>
            <p className="modal-text" style={{ marginTop: 6 }}>
              {describeCertificate(cert)}
            </p>
            <div className="mono cert-fp">{prettyFingerprint(cert.fingerprint)}</div>
            {changed && (
              <p className="modal-text" style={{ color: "var(--warn)" }}>
                This is not the certificate that was pinned. If the NAS renewed it, save to pin the new one. If it did
                not, do not trust this connection.
              </p>
            )}
          </>
        ) : (
          <p className="modal-text" style={{ marginTop: 6 }}>
            {certError ??
              (conn?.fingerprint
                ? `Pinned to ${prettyFingerprint(conn.fingerprint).slice(0, 23)}…`
                : "Enter the address and the console will look at the certificate it presents.")}
          </p>
        )}
        <Toggle checked={pin} onChange={setPin} label="Pin this certificate, so a different one is refused" />
        <div className="field-hint" style={{ marginTop: 4 }}>
          TrueNAS uses a self-signed certificate, so this pin is the only way the connection can be authenticated.
          Without it the API key travels over a link nothing has verified.
        </div>
      </div>

      <Field
        label={
          conn?.hasSudo ? "Account password (saved — type a new one to replace it)" : "Account password (optional)"
        }
        hint="Only needed to move, rename or reorganise files. TrueNAS has no API for those, so they run as a shell command, and that shell cannot write into a pool without this. Stored encrypted, never sent back to the browser. Leave empty and the file browser stays read-only."
      >
        <Input
          type="password"
          value={sudoPassword}
          onChange={(e) => setSudoPassword(e.target.value)}
          placeholder={conn?.hasSudo ? "saved" : "not saved"}
        />
      </Field>

      {tested && (
        <div className={tested.ok ? "job done" : "error-banner"} style={{ marginBottom: 0 }}>
          {tested.ok ? `Reached ${tested.hostname} running TrueNAS ${tested.version}.` : tested.error}
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

type TabId =
  "servers" | "people" | "appearance" | "security" | "notifications" | "email" | "updates" | "console-update" | "about";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "servers", label: "Servers" },
  { id: "people", label: "Console users" },
  { id: "appearance", label: "Appearance" },
  { id: "security", label: "Security" },
  { id: "notifications", label: "Notifications" },
  { id: "email", label: "Email" },
  { id: "updates", label: "NAS updates" },
  { id: "console-update", label: "App updates" },
  { id: "about", label: "About" },
];

export interface ConsoleSettings {
  theme: string;
  mfa: { enabled: boolean; recoveryRemaining: number };
  notify: {
    watchDisks: boolean;
    email: boolean;
    recipients: string[];
    watch: WatchConfig;
    emailLevel: "info" | "warn" | "bad";
    webhooks: Webhook[];
    greetName: string;
  };
}

export function SettingsPage({ me }: { me: { username: string; role: "admin" | "viewer" } }) {
  const [tab, setTab] = useState<TabId>("servers");
  const { data, reload } = useResource<ConsoleSettings>("/api/settings", 0);

  async function applyTheme(theme: string) {
    // Applied to the document first so the choice is felt immediately; the
    // round trip only decides what a fresh browser gets.
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tnui:theme", theme);
    await put("/api/settings", { theme });
    await reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="page-sub">This console, and the NAS behind it.</div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "servers" && <ServersTab />}
      {tab === "people" && <ConsoleUsersTab meUsername={me.username} />}
      {tab === "appearance" && (
        <AppearanceTab
          theme={document.documentElement.dataset.theme ?? data?.theme ?? "midnight"}
          onTheme={(t) => void applyTheme(t)}
        />
      )}
      {tab === "security" && <SecurityTab me={me} />}
      {tab === "notifications" && data && <NotificationsTab notify={data.notify} onSaved={() => void reload()} />}
      {tab === "email" && <EmailTab />}
      {tab === "updates" && <UpdatesTab />}
      {tab === "console-update" && <ConsoleUpdateTab />}
      {tab === "about" && <AboutTab />}
    </>
  );
}

function AboutTab() {
  const { data } = useResource<{ connected: boolean; error: string | null }>("/api/health", 30_000);

  return (
    <div className="grid two">
      <Card title="This console">
        <p className="modal-text" style={{ fontSize: 14.5, marginTop: 0 }}>
          {TAGLINE}
        </p>
        <p className="modal-text">
          Everything here speaks the JSON-RPC API on <span className="mono">wss://…/api/current</span> — the same
          interface the NAS's own interface uses, and the only one that survives the removal of the REST API. The live
          numbers on Overview are a subscription, not a poll: the NAS pushes them about once a second.
        </p>
        <div className="kv" style={{ marginTop: 12 }}>
          <div>
            <span>NAS connection</span>
            <b>{data ? (data.connected ? "connected" : "unreachable") : "…"}</b>
          </div>
          <div>
            <span>Transport</span>
            <b>JSON-RPC 2.0 over WebSocket</b>
          </div>
        </div>
        {data && !data.connected && data.error && (
          <p className="modal-text" style={{ color: "var(--bad)" }}>
            {data.error}
          </p>
        )}
      </Card>

      <Card title="Built for homelabs">
        <p className="modal-text" style={{ marginTop: 0 }}>
          The screens here are the ones a homelab actually opens: pools and their disks, datasets, snapshots and the
          schedules that expire them, files, apps, shares, users, the network, and a terminal. Anything rarer is a click
          away in the NAS's own interface, linked at the bottom of the sidebar.
        </p>
        <p className="modal-text">
          Destructive actions ask you to type the name of what you are about to lose, and the API enforces that too, so
          a mis-aimed script fails instead of succeeding on the wrong pool.
        </p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ users */
