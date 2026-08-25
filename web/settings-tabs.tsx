import { useState } from "react";
import QRCode from "qrcode";
import { del, post, put, useResource, watchJob, withConn, type Job } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";

/* ------------------------------------------------------------- appearance */

const THEMES = [
  { id: "midnight", name: "Midnight", note: "dark, blue", colors: ["#080b10", "#10151d", "#45b8f5", "#3ddc97"] },
  { id: "daylight", name: "Daylight", note: "light", colors: ["#f4f6f9", "#ffffff", "#1c7fc4", "#1a9c68"] },
  { id: "glacier", name: "Glacier", note: "cool grey", colors: ["#1a2029", "#262f3b", "#8fc0e0", "#9dc99b"] },
  { id: "ember", name: "Ember", note: "warm dark", colors: ["#12100e", "#1e1a16", "#f0a24a", "#a8c86a"] },
  { id: "nord", name: "Nord", note: "slate and pastel", colors: ["#2e3440", "#3b4252", "#88c0d0", "#a3be8c"] },
  { id: "dracula", name: "Dracula", note: "purple and pink", colors: ["#282a36", "#343746", "#bd93f9", "#50fa7b"] },
  { id: "cyberpunk", name: "Cyberpunk", note: "black and neon", colors: ["#07070b", "#101018", "#00e5a0", "#ff2e63"] },
  { id: "cozy", name: "Cozy", note: "warm brown, night", colors: ["#1c1714", "#26201b", "#e0a878", "#a8c08a"] },
];

export function AppearanceTab({ theme, onTheme }: { theme: string; onTheme: (t: string) => void }) {
  return (
    <Card title="Theme">
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`theme-card ${theme === t.id ? "on" : ""}`}
            onClick={() => onTheme(t.id)}
          >
            <div className="theme-swatch">
              {t.colors.map((c) => <i key={c} style={{ background: c }} />)}
            </div>
            <span className="theme-name">
              {t.name}
              <small>{t.note}</small>
            </span>
          </button>
        ))}
      </div>
      <p className="modal-text" style={{ marginTop: 14 }}>
        Applied immediately and remembered on this device, and saved as the default for anyone who signs in here.
      </p>
    </Card>
  );
}

/* --------------------------------------------------------------- security */

/**
 * Two-factor authentication, for the account you are signed in with.
 *
 * It used to be one switch for the whole console, which made no sense once
 * more than one person could sign in: turning it on for yourself would have
 * demanded a code from everybody, out of an authenticator only you hold.
 */
export function SecurityTab({ me }: { me: { username: string; role: "admin" | "viewer" } }) {
  const { data: everyone, reload: reloadAccounts } =
    useResource<Array<{ username: string; mfa: boolean; recoveryRemaining: number }>>("/api/accounts", 0);
  const mine = everyone?.find((a) => a.username === me.username);
  const mfa = { enabled: mine?.mfa ?? false, recoveryRemaining: mine?.recoveryRemaining ?? 0 };
  const onChanged = () => void reloadAccounts();

  const [enrolling, setEnrolling] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setError(null);
    try {
      setEnrolling(await post<{ secret: string; uri: string }>("/api/mfa/begin"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ recovery: string[] }>("/api/mfa/enable", { code });
      setRecovery(r.recovery);
      setEnrolling(null);
      setCode("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="Two-factor authentication">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Pill state={mfa.enabled ? "ONLINE" : "STOPPED"}>{mfa.enabled ? "on" : "off"}</Pill>
          <span style={{ flex: 1, minWidth: 200, fontSize: 13, color: "var(--muted)" }}>
            {mfa.enabled
              ? `A code from your authenticator app is required to sign in. ${mfa.recoveryRemaining} recovery codes left.`
              : "Sign-in needs only the password. Adding a second factor means a leaked password is not enough on its own."}
          </span>
          {mfa.enabled ? (
            <button className="btn danger" style={{ flex: "none" }} onClick={() => setDisabling(true)}>Turn off</button>
          ) : (
            <button className="btn primary" style={{ flex: "none" }} onClick={() => void begin()}>Set up</button>
          )}
        </div>
        {error && !enrolling && <ErrorBanner>{error}</ErrorBanner>}
      </Card>

      {enrolling && (
        <Modal
          title="Set up two-factor authentication"
          subtitle="Scan this with Google Authenticator, 1Password, Aegis or similar."
          onClose={() => { setEnrolling(null); setError(null); }}
          footer={
            <>
              <button className="btn" onClick={() => setEnrolling(null)} disabled={busy}>Cancel</button>
              <button className="btn primary" disabled={busy || code.length < 6} onClick={() => void confirm()}>
                {busy ? "Checking…" : "Confirm"}
              </button>
            </>
          }
        >
          <div style={{ display: "grid", placeItems: "center", padding: "6px 0" }}>
            <QrCode text={enrolling.uri} />
          </div>
          <Field label="Or type this secret in by hand">
            <Input readOnly value={enrolling.secret} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Field label="Enter the six-digit code to confirm">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoFocus
            />
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}
        </Modal>
      )}

      {recovery && (
        <Modal
          title="Save your recovery codes"
          subtitle="Shown once. Each works a single time, for when the phone is not to hand."
          onClose={() => setRecovery(null)}
          footer={<button className="btn primary" onClick={() => setRecovery(null)}>I have saved them</button>}
        >
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
            {recovery.map((c) => <span key={c}>{c}</span>)}
          </div>
          <button
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => void navigator.clipboard?.writeText(recovery.join("\n"))}
          >
            Copy all
          </button>
        </Modal>
      )}

      {disabling && (
        <DangerConfirm
          what="two-factor authentication"
          name="off"
          verb="Turn"
          onCancel={() => setDisabling(false)}
          onConfirm={async () => { await post("/api/mfa/disable", { code }); onChanged(); }}
          extra={
            <Field label="Current code or a recovery code">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" />
            </Field>
          }
        />
      )}
    </>
  );
}

/**
 * A QR code, rendered locally.
 *
 * The obvious alternative — an <img> pointing at a chart service — would post
 * the TOTP secret to a third party to have it drawn, which is a strange thing
 * to do with the one value the second factor depends on.
 *
 * The encoder is a library rather than hand-rolled: a subtly wrong matrix still
 * looks like a QR code and simply fails to scan, which is a miserable thing to
 * debug during enrolment.
 */
function QrCode({ text }: { text: string }) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const scale = 5;
  const quiet = 4;
  const total = (size + quiet * 2) * scale;

  const rects = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y * size + x]) continue;
      rects.push(<rect key={`${x}-${y}`} x={(x + quiet) * scale} y={(y + quiet) * scale} width={scale} height={scale} fill="#000" />);
    }
  }

  return (
    <svg width={total} height={total} viewBox={`0 0 ${total} ${total}`} style={{ borderRadius: 8 }}>
      <rect width={total} height={total} fill="#fff" />
      {rects}
    </svg>
  );
}

/* ---------------------------------------------------------- notifications */

export interface WatchConfig {
  poolHealth: boolean; capacity: boolean; capacityPercent: number;
  temperature: boolean; temperatureC: number;
  zfsErrors: boolean; apps: boolean; scrubs: boolean; updates: boolean; reachability: boolean;
}

export type WebhookKind = "discord" | "telegram" | "ntfy" | "generic";

export interface Webhook {
  id: string;
  kind: WebhookKind;
  url: string;
  botToken?: string;
  chatId?: string;
  topic?: string;
  enabled: boolean;
  level: "info" | "warn" | "bad";
}

const KINDS: Array<{ id: WebhookKind; label: string; hint: string }> = [
  { id: "discord", label: "Discord", hint: "Server Settings → Integrations → Webhooks → Copy Webhook URL." },
  { id: "telegram", label: "Telegram", hint: "Make a bot with @BotFather, then message it once and use your chat id." },
  { id: "ntfy", label: "ntfy", hint: "Pick any topic name and subscribe to it in the ntfy app. No account needed." },
  { id: "generic", label: "Anything else", hint: "A plain JSON POST — Slack, Home Assistant, Gotify, your own script." },
];

export function NotificationsTab({ notify, onSaved }: {
  notify: {
    watchDisks: boolean; email: boolean; recipients: string[];
    watch: WatchConfig; emailLevel: "info" | "warn" | "bad";
    webhooks: Webhook[]; greetName: string;
  };
  onSaved: () => void;
}) {
  const [watchDisks, setWatchDisks] = useState(notify.watchDisks);
  const [watch, setWatch] = useState<WatchConfig>(notify.watch);
  const [email, setEmail] = useState(notify.email);
  const [emailLevel, setEmailLevel] = useState(notify.emailLevel);
  const [recipients, setRecipients] = useState(notify.recipients.join(", "));
  const [testing, setTesting] = useState<string | null>(null);
  const [hooks, setHooks] = useState<Webhook[]>(notify.webhooks ?? []);
  const [greetName, setGreetName] = useState(notify.greetName ?? "");
  const [hookNote, setHookNote] = useState<string | null>(null);

  const patchHook = (i: number, patch: Partial<Webhook>) =>
    setHooks(hooks.map((h, j) => (j === i ? { ...h, ...patch } : h)));

  async function testHook(h: Webhook) {
    setHookNote("Sending…");
    try {
      await post("/api/notify/test", h);
      setHookNote("Sent. Check your phone.");
    } catch (e) {
      setHookNote(e instanceof Error ? e.message : String(e));
    }
  }

  const set = <K extends keyof WatchConfig>(k: K, v: WatchConfig[K]) => setWatch({ ...watch, [k]: v });

  const { busy, error, submit } = useSubmit(async () => {
    await put("/api/settings", {
      notify: {
        watchDisks,
        email,
        emailLevel,
        watch,
        recipients: recipients.split(",").map((s) => s.trim()).filter(Boolean),
        webhooks: hooks,
        greetName,
      },
    });
    onSaved();
  });

  async function sendTest() {
    setTesting("sending");
    try {
      await post("/api/mail/test", { to: recipients.split(",").map((s) => s.trim()).filter(Boolean) });
      setTesting("Sent. If it does not arrive, check the SMTP settings under Email.");
    } catch (e) {
      setTesting(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <Card title="What this console watches">
        <p className="modal-text" style={{ marginTop: 0 }}>
          Checked every minute, independently of TrueNAS's own alerts. A condition that is already in the list is not
          raised again, so a pool sitting above its limit is one notification rather than one a minute.
        </p>

        <div className="grid" style={{ gap: 12, marginTop: 14 }}>
          <Toggle checked={watchDisks} onChange={setWatchDisks} label="Disks appearing or disappearing" />
          <Toggle checked={watch.poolHealth} onChange={(v) => set("poolHealth", v)} label="A pool becoming unhealthy" />
          <Toggle checked={watch.zfsErrors} onChange={(v) => set("zfsErrors", v)} label="Read, write or checksum errors on a drive" />
          <Toggle checked={watch.apps} onChange={(v) => set("apps", v)} label="An app stopping on its own" />
          <Toggle checked={watch.scrubs} onChange={(v) => set("scrubs", v)} label="A scrub finishing, and what it found" />
          <Toggle checked={watch.updates} onChange={(v) => set("updates", v)} label="Updates being available" />
          <Toggle checked={watch.reachability} onChange={(v) => set("reachability", v)} label="The NAS not answering" />

          <div>
            <Toggle checked={watch.capacity} onChange={(v) => set("capacity", v)} label="A pool filling up" />
            {watch.capacity && (
              <Field label="Tell me at" hint="ZFS slows down noticeably past about 90%.">
                <div className="row">
                  <Input
                    type="number" min={50} max={99}
                    value={String(watch.capacityPercent)}
                    onChange={(e) => set("capacityPercent", Number(e.target.value))}
                  />
                  <span className="field-hint" style={{ alignSelf: "center" }}>% full</span>
                </div>
              </Field>
            )}
          </div>

          <div>
            <Toggle checked={watch.temperature} onChange={(v) => set("temperature", v)} label="A drive running hot" />
            {watch.temperature && (
              <Field label="Tell me at" hint="Spinning drives are happy under about 40°C and worrying past 50.">
                <div className="row">
                  <Input
                    type="number" min={30} max={80}
                    value={String(watch.temperatureC)}
                    onChange={(e) => set("temperatureC", Number(e.target.value))}
                  />
                  <span className="field-hint" style={{ alignSelf: "center" }}>°C</span>
                </div>
              </Field>
            )}
          </div>
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title="On your phone">
          <p className="modal-text" style={{ marginTop: 0 }}>
            Push the same notifications somewhere you will actually see them. Nobody opens a server dashboard on a
            Saturday, and a drive failing at 2am matters within the hour.
          </p>

          <Field label="Call me" hint="Optional. Puts your name in the message so it reads like a person wrote it.">
            <Input value={greetName} onChange={(e) => setGreetName(e.target.value)} placeholder="Mexhit" style={{ maxWidth: 240 }} />
          </Field>

          <div className="grid" style={{ gap: 12, marginTop: 6 }}>
            {hooks.map((h, i) => {
              const kind = KINDS.find((k) => k.id === h.kind);
              return (
                <div key={h.id} className="hook-card">
                  <div className="hook-top">
                    <Select value={h.kind} onChange={(e) => patchHook(i, { kind: e.target.value as WebhookKind })}>
                      {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </Select>
                    <Select value={h.level} onChange={(e) => patchHook(i, { level: e.target.value as "warn" })}>
                      <option value="bad">Only problems</option>
                      <option value="warn">Problems and warnings</option>
                      <option value="info">Everything</option>
                    </Select>
                    <Toggle checked={h.enabled} onChange={(v) => patchHook(i, { enabled: v })} label="On" />
                    <button className="btn" onClick={() => void testHook(h)}>Test</button>
                    <button className="btn danger" onClick={() => setHooks(hooks.filter((_, j) => j !== i))}>Remove</button>
                  </div>

                  {h.kind === "telegram" ? (
                    <div className="row">
                      <Field label="Bot token">
                        <Input
                          type="password"
                          value={h.botToken ?? ""}
                          onChange={(e) => patchHook(i, { botToken: e.target.value })}
                          placeholder="123456:ABC-DEF…"
                        />
                      </Field>
                      <Field label="Chat id">
                        <Input value={h.chatId ?? ""} onChange={(e) => patchHook(i, { chatId: e.target.value })} placeholder="123456789" />
                      </Field>
                    </div>
                  ) : h.kind === "ntfy" ? (
                    <div className="row">
                      <Field label="Server">
                        <Input value={h.url} onChange={(e) => patchHook(i, { url: e.target.value })} placeholder="https://ntfy.sh" />
                      </Field>
                      <Field label="Topic">
                        <Input value={h.topic ?? ""} onChange={(e) => patchHook(i, { topic: e.target.value })} placeholder="my-nas-alerts" />
                      </Field>
                    </div>
                  ) : (
                    <Field label="Webhook URL">
                      <Input value={h.url} onChange={(e) => patchHook(i, { url: e.target.value })} placeholder="https://…" />
                    </Field>
                  )}

                  <p className="field-hint">{kind?.hint}</p>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {KINDS.map((k) => (
              <button
                key={k.id}
                className="btn"
                style={{ flex: "none" }}
                onClick={() =>
                  setHooks([...hooks, {
                    id: `new-${Date.now()}-${k.id}`,
                    kind: k.id,
                    url: k.id === "ntfy" ? "https://ntfy.sh" : "",
                    enabled: true,
                    level: "warn",
                  }])
                }
              >
                + {k.label}
              </button>
            ))}
          </div>

          {hookNote && (
            <div className={hookNote === "Sending…" ? "job" : "job done"} style={{ marginTop: 12 }}>
              <span className="job-label">{hookNote}</span>
            </div>
          )}

          <p className="modal-text">
            Saved with the Save button below. A test sends through what is saved, so save a new one first.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Email">
          <Toggle checked={email} onChange={setEmail} label="Also send an email" />
          <p className="modal-text" style={{ marginTop: 6 }}>
            Sent through the NAS's own mail settings, so there is one place to configure SMTP.
          </p>

          {email && (
            <>
              <Field label="Email me about" hint="Everything still shows in the bell — this only limits what is mailed.">
                <Select value={emailLevel} onChange={(e) => setEmailLevel(e.target.value as "info")}>
                  <option value="bad">Only problems</option>
                  <option value="warn">Problems and warnings</option>
                  <option value="info">Everything</option>
                </Select>
              </Field>

              <Field label="Recipients" hint="Comma separated.">
                <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="you@example.com" />
              </Field>
            </>
          )}

          {testing && <div className={testing === "sending" ? "job" : "job done"}><span className="job-label">{testing === "sending" ? "Sending…" : testing}</span></div>}
          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn primary" style={{ flex: "none" }} disabled={busy} onClick={() => void submit(undefined as void)}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn" style={{ flex: "none" }} disabled={!recipients.trim()} onClick={() => void sendTest()}>
              Send a test
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ email */

interface MailCfg {
  fromemail: string; fromname: string; outgoingserver: string;
  port: number; security: string; smtp: boolean; user: string | null; hasPassword: boolean;
}

export function EmailTab() {
  const { data, error, loading, reload } = useResource<MailCfg>("/api/mail", 0);
  const [v, setV] = useState<Partial<MailCfg> & { pass?: string }>({});
  const merged = { ...(data ?? {}), ...v } as MailCfg & { pass?: string };

  const { busy, error: saveErr, submit } = useSubmit(async () => {
    await put("/api/mail", merged);
    setV({});
    await reload();
  });

  if (loading && !data) return <Loading rows={3} />;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));

  return (
    <Card title="Outgoing mail (SMTP)">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="grid" style={{ gap: 13 }}>
        <div className="row">
          <Field label="From address"><Input value={merged.fromemail ?? ""} onChange={set("fromemail")} placeholder="truenas@example.com" /></Field>
          <Field label="From name"><Input value={merged.fromname ?? ""} onChange={set("fromname")} placeholder="TrueNAS" /></Field>
        </div>

        <div className="row">
          <Field label="Server"><Input value={merged.outgoingserver ?? ""} onChange={set("outgoingserver")} placeholder="smtp.gmail.com" /></Field>
          <Field label="Port"><Input type="number" value={merged.port ?? 587} onChange={set("port")} /></Field>
        </div>

        <Field label="Security" hint="STARTTLS on 587 is the usual choice; SSL on 465 for older servers.">
          <Select value={merged.security ?? "TLS"} onChange={set("security")}>
            <option value="PLAIN">None</option>
            <option value="TLS">STARTTLS</option>
            <option value="SSL">SSL/TLS</option>
          </Select>
        </Field>

        <Toggle checked={merged.smtp ?? false} onChange={(b) => setV((p) => ({ ...p, smtp: b }))} label="The server requires a login" />

        {merged.smtp && (
          <div className="row">
            <Field label="Username"><Input value={merged.user ?? ""} onChange={set("user")} /></Field>
            <Field
              label={data?.hasPassword ? "Password (blank keeps the current one)" : "Password"}
              hint="For Gmail and similar this must be an app password, not the account password."
            >
              <Input type="password" value={v.pass ?? ""} onChange={set("pass")} placeholder={data?.hasPassword ? "unchanged" : ""} />
            </Field>
          </div>
        )}

        {saveErr && <ErrorBanner>{saveErr}</ErrorBanner>}
        <button className="btn primary" style={{ flex: "none", alignSelf: "flex-start" }} disabled={busy} onClick={() => void submit(undefined as void)}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- updates */

interface UpdateInfo {
  currentVersion: string;
  productType: string;
  trains: Array<{ name: string; description: string }>;
  currentTrain: string;
  selectedTrain: string;
  available: { status?: string; changes?: Array<{ new?: { version?: string } }>; release_notes_url?: string; error?: string } | null;
  bootEnvironments: Array<{ id: string; active: string; created: unknown }>;
}

export function UpdatesTab() {
  const { data, error, loading, reload } = useResource<UpdateInfo>("/api/update", 0);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);
  const [applying, setApplying] = useState(false);
  const [licensing, setLicensing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const newVersion = data?.available?.changes?.[0]?.new?.version;
  const upToDate = data?.available?.status === "UNAVAILABLE";

  async function setTrain(train: string) {
    await put("/api/update/train", { train });
    setNote(`Switched to ${train}. Checking what that offers…`);
    await reload();
  }

  async function download() {
    const { jobId } = await post<{ jobId: number }>("/api/update/download");
    setJobs((j) => [...j, { id: jobId, label: "Downloading the update" }]);
  }

  if (loading && !data) return <Loading rows={3} />;

  return (
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {note && <div className="job done" style={{ marginBottom: 14 }}><span className="job-label">{note}</span></div>}

      <div className="grid" style={{ gap: 14 }}>
        <Card title="Version">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="stat-value" style={{ fontSize: 22 }}>{data?.currentVersion}</div>
              <div className="stat-foot">
                {data?.productType === "COMMUNITY_EDITION" ? "Community Edition" : data?.productType} · train {data?.currentTrain}
              </div>
            </div>
            {upToDate && <span className="pill ok">up to date</span>}
            {newVersion && <span className="pill warn">{newVersion} available</span>}
            {data?.available?.status === "ERROR" && <span className="pill bad">could not check</span>}
          </div>

          {data?.available?.error && (
            <p className="modal-text" style={{ marginTop: 10 }}>{data.available.error}</p>
          )}

          {newVersion && (
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn" style={{ flex: "none" }} onClick={() => void download()}>Download only</button>
              <button className="btn primary" style={{ flex: "none" }} onClick={() => setApplying(true)}>
                Install {newVersion}
              </button>
              {data.available?.release_notes_url && (
                <a className="btn" style={{ flex: "none", textAlign: "center" }} href={data.available.release_notes_url} target="_blank" rel="noreferrer">
                  Release notes ↗
                </a>
              )}
            </div>
          )}
        </Card>

        <Card title="Release train">
          <Field
            label="Train"
            hint="A train is a release series. Moving to a newer one is a major upgrade — read the release notes first, and expect a reboot."
          >
            <Select value={data?.selectedTrain ?? ""} onChange={(e) => void setTrain(e.target.value)}>
              {data?.trains.map((t) => <option key={t.name} value={t.name}>{t.description}</option>)}
            </Select>
          </Field>
        </Card>

        <Card title="Licence">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 220, fontSize: 13, color: "var(--muted)" }}>
              {data?.productType === "COMMUNITY_EDITION"
                ? "Running Community Edition. An iXsystems licence key unlocks Enterprise features on supported hardware."
                : `Licensed: ${data?.productType}.`}
            </span>
            <button className="btn" style={{ flex: "none" }} onClick={() => setLicensing(true)}>Enter a licence key</button>
          </div>
        </Card>

        <Card title="Boot environments">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>State</th></tr></thead>
              <tbody>
                {data?.bootEnvironments.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.id}</td>
                    <td>{String(b.active) === "true" || b.active === "NR" ? <span className="pill ok">active</span> : <span className="pill mute">standby</span>}</td>
                  </tr>
                ))}
                {!data?.bootEnvironments.length && <tr><td colSpan={2}><Empty>None reported.</Empty></td></tr>}
              </tbody>
            </table>
          </div>
          <p className="modal-text" style={{ marginTop: 10 }}>
            An update creates a new boot environment, so a bad upgrade is undone by booting the previous one rather
            than by reinstalling.
          </p>
        </Card>
      </div>

      {applying && newVersion && (
        <DangerConfirm
          what={`update to ${newVersion}`}
          name={newVersion}
          verb="Install"
          onCancel={() => setApplying(false)}
          onConfirm={async (confirm) => {
            const { jobId } = await post<{ jobId: number }>("/api/update/apply", { confirm, version: newVersion, reboot: false });
            setJobs((j) => [...j, { id: jobId, label: `Installing ${newVersion}` }]);
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              Every app and share on this NAS stops while it reboots. The update is staged into a new boot
              environment, so the previous version stays bootable if something goes wrong.
            </p>
          }
        />
      )}

      {licensing && <LicenceForm onClose={() => setLicensing(false)} onSaved={() => { setLicensing(false); void reload(); }} />}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress key={j.id} jobId={j.id} label={j.label}
              onDone={() => { void reload(); setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 8000); }} />
          ))}
        </div>
      )}
    </>
  );
}

function LicenceForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [license, setLicense] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/update/license", { license });
    onSaved();
  });

  return (
    <Modal
      title="Enter a licence key"
      subtitle="Provided by iXsystems for Enterprise systems."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !license.trim()} onClick={() => void submit(undefined as void)}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      <Field label="Licence key">
        <textarea
          className="input"
          style={{ minHeight: 110, fontFamily: "var(--mono)", fontSize: 12 }}
          value={license}
          onChange={(e) => setLicense(e.target.value)}
          placeholder="Paste the key here"
        />
      </Field>
      <p className="modal-text">
        The NAS validates the key against its own hardware. A key issued for different hardware is rejected, and
        Community Edition installs generally cannot be converted this way.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

export { watchJob, del };
export type { Job };

/* --------------------------------------------------------- updating itself */

interface Release {
  version: string; name: string; notes: string; url: string;
  publishedAt: string | null; prerelease: boolean;
}

interface UpdateCheck {
  current: string;
  latest: Release | null;
  updateAvailable: boolean;
  canSelfUpdate: boolean;
  reason: string | null;
}

/**
 * The console's own version, and whatever has been published since.
 *
 * Separate from the TrueNAS updater in the next tab: that one updates the NAS,
 * this one updates the dashboard sitting in front of it, and confusing the two
 * is how somebody reboots a file server expecting a UI refresh.
 */
export function ConsoleUpdateTab() {
  const { data, error, loading, reload } = useResource<UpdateCheck>("/api/console/update", 0);
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Release | null>(null);

  async function install(tag: string) {
    setConfirming(null);
    setBusy(true);
    setLog("Starting…\n");
    try {
      const res = await fetch(withConn("/api/console/update"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      // Streamed, so the log fills in as npm works rather than arriving in one
      // lump after two silent minutes.
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setLog(text);
      }
      await reload();
    } catch (e) {
      setLog((l) => `${l ?? ""}\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="This console">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {loading && !data && <Loading rows={2} />}

        {data && (
          <>
            <div className="kv">
              <div><span>Running</span><b>v{data.current}</b></div>
              <div><span>Newest published</span><b>{data.latest ? `v${data.latest.version}` : "none found"}</b></div>
            </div>

            {data.updateAvailable && data.latest ? (
              <>
                <p className="modal-text" style={{ marginTop: 14 }}>
                  <strong>{data.latest.name}</strong> is available
                  {data.latest.publishedAt ? `, published ${new Date(data.latest.publishedAt).toLocaleDateString()}` : ""}.
                </p>
                {data.latest.notes && <pre className="release-notes">{data.latest.notes}</pre>}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    className="btn primary"
                    style={{ flex: "none" }}
                    disabled={busy || !data.canSelfUpdate}
                    onClick={() => setConfirming(data.latest!)}
                  >
                    {busy ? "Updating…" : `Update to v${data.latest.version}`}
                  </button>
                  <a className="btn" style={{ flex: "none", textAlign: "center" }} href={data.latest.url} target="_blank" rel="noreferrer">
                    Read the release ↗
                  </a>
                </div>
              </>
            ) : (
              <p className="modal-text" style={{ marginTop: 14 }}>
                {data.latest ? "This is the newest release." : "No releases have been published yet."}
              </p>
            )}

            {!data.canSelfUpdate && data.reason && (
              <p className="modal-text" style={{ color: "var(--warn)" }}>{data.reason}</p>
            )}

            <div style={{ marginTop: 12 }}>
              <button className="btn" style={{ flex: "none" }} disabled={busy} onClick={() => void reload()}>
                Check again
              </button>
            </div>
          </>
        )}

        {log && <pre className="release-notes" style={{ marginTop: 14 }}>{log}</pre>}
      </Card>

      {confirming && (
        <Modal
          title={`Update to v${confirming.version}`}
          subtitle="The current build is copied aside first."
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
              <button className="btn primary" onClick={() => void install(confirming.version)}>Update</button>
            </>
          }
        >
          <p className="modal-text">
            The console fetches the release, installs its dependencies and rebuilds. It takes a couple of minutes and
            the page will be unresponsive at the end while the service restarts.
          </p>
          <p className="modal-text">
            Your servers, accounts, settings and recycle bins are in <span className="mono">data/</span> and are not
            touched. The build being replaced is kept as <span className="mono">dist.prev</span>.
          </p>
        </Modal>
      )}
    </>
  );
}
