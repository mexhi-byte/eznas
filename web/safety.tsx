import { useState } from "react";
import { del, post, useResource, when } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";

/**
 * Is the data safe, and what makes it so.
 *
 * One page for the things TrueNAS spreads across six: scrubs, self-tests,
 * cloud backups, copies to a second pool, locked folders, the UPS. Each gets
 * the two-or-three-field version of itself. The full versions stay in
 * TrueNAS for whoever needs them.
 */

interface Schedule {
  minute?: string;
  hour?: string;
  dom?: string;
  month?: string;
  dow?: string;
}
export interface Safety {
  pools: Array<{ name: string; healthy: boolean; lastScrub: number | null; scrubErrors: number }>;
  scrubs: Array<{ id: number; pool: string; schedule: Schedule; enabled: boolean; description: string }>;
  smartTests: Array<{
    id: number;
    type: string;
    allDisks: boolean;
    disks: number;
    schedule: Schedule;
    description: string;
  }>;
  cloud: Array<{
    id: number;
    description: string;
    path: string;
    direction: string;
    provider: string;
    credential: string;
    bucket: string | null;
    folder: string;
    schedule: Schedule;
    enabled: boolean;
    state: string | null;
    lastAt: number | null;
  }>;
  credentials: Array<{ id: number; name: string; provider: string }>;
  replication: Array<{
    id: number;
    name: string;
    transport: string;
    source: string[];
    target: string;
    schedule: Schedule;
    enabled: boolean;
    state: string | null;
    lastAt: number | null;
  }>;
  snapshotTasks: number;
  encrypted: Array<{ id: string; name: string; locked: boolean; keyFormat: string | null }>;
  ups: {
    service: { state: string; enable: boolean } | null;
    mode: string | null;
    driver: string | null;
    port: string | null;
  };
}

/** "every day at 01:00", "monthly on the 1st at 03:00", "Sundays at 02:00". */
export function describeSchedule(s: Schedule | undefined): string {
  if (!s) return "";
  const hh = (s.hour ?? "*").padStart(2, "0");
  const mm = (s.minute ?? "0").padStart(2, "0");
  const at = s.hour && s.hour !== "*" ? ` at ${hh}:${mm}` : "";
  if (s.dom && s.dom !== "*") return `monthly on day ${s.dom}${at}`;
  if (s.dow && s.dow !== "*") {
    const days = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
    return `${s.dow
      .split(",")
      .map((d) => days[Number(d)] ?? d)
      .join(", ")}${at}`;
  }
  return `every day${at}`;
}

export function SafetyPage() {
  const { data, error, loading, reload } = useResource<Safety>("/api/safety", 30_000);
  const { data: datasets } = useResource<Array<{ name: string; type: string }>>("/api/datasets", 0);
  const [adding, setAdding] = useState<"scrub" | "smart" | "cloud" | "credential" | "replication" | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [locking, setLocking] = useState<Safety["encrypted"][number] | null>(null);
  const [unlocking, setUnlocking] = useState<Safety["encrypted"][number] | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  const run = async (label: string, url: string) => {
    setFailed(null);
    try {
      const { jobId } = await post<{ jobId: number }>(url);
      setJobs((j) => [...j, { id: jobId, label }]);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async (url: string) => {
    setFailed(null);
    try {
      await del(url);
      await reload();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };
  const folders = (datasets ?? []).filter((d) => d.type === "FILESYSTEM").map((d) => d.name);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Backups and checks</h1>
          <div className="page-sub">What keeps the data safe, and how recently each thing ran.</div>
        </div>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {jobs.map((j) => (
        <JobProgress key={j.id} jobId={j.id} label={j.label} onDone={() => void reload()} />
      ))}
      {loading && !data && <Loading rows={6} />}
      {data && (
        <div className="grid two">
          <Card
            title="Scrubs"
            action={
              <button className="btn small" onClick={() => setAdding("scrub")}>
                Schedule one
              </button>
            }
          >
            <p className="modal-text" style={{ marginTop: 0 }}>
              A scrub reads every byte on a pool and repairs what has quietly rotted. Monthly is the usual rhythm.
            </p>
            {data.pools.map((p) => (
              <div key={p.name} className="kv-row">
                <span>
                  <strong>{p.name}</strong>{" "}
                  <span className="stat-foot">
                    {p.lastScrub
                      ? `last scrubbed ${when(p.lastScrub)}${p.scrubErrors ? `, ${p.scrubErrors} errors` : ", no errors"}`
                      : "never scrubbed"}
                  </span>
                </span>
                <Pill state={data.scrubs.some((s) => s.pool === p.name && s.enabled) ? "ONLINE" : "OFFLINE"}>
                  {data.scrubs.some((s) => s.pool === p.name && s.enabled) ? "scheduled" : "not scheduled"}
                </Pill>
              </div>
            ))}
            {data.scrubs.map((s) => (
              <div key={s.id} className="kv-row">
                <span className="stat-foot">
                  {s.pool}: {describeSchedule(s.schedule)}
                </span>
                <button className="btn small danger" onClick={() => void remove(`/api/safety/scrubs/${s.id}`)}>
                  Remove
                </button>
              </div>
            ))}
          </Card>

          <Card
            title="Drive self-tests"
            action={
              <button className="btn small" onClick={() => setAdding("smart")}>
                Schedule one
              </button>
            }
          >
            <p className="modal-text" style={{ marginTop: 0 }}>
              SMART tests ask each drive to check itself. A short test weekly and a long one monthly catches most
              failures before ZFS has to.
            </p>
            {data.smartTests.length ? (
              data.smartTests.map((t) => (
                <div key={t.id} className="kv-row">
                  <span>
                    <strong>{t.type === "LONG" ? "Long" : "Short"}</strong>{" "}
                    <span className="stat-foot">
                      {t.allDisks ? "every drive" : `${t.disks} drives`} · {describeSchedule(t.schedule)}
                    </span>
                  </span>
                  <button className="btn small danger" onClick={() => void remove(`/api/safety/smart-tests/${t.id}`)}>
                    Remove
                  </button>
                </div>
              ))
            ) : (
              <Empty>No self-tests are scheduled.</Empty>
            )}
          </Card>

          <Card
            title="Copies off the NAS"
            action={
              <button className="btn small" onClick={() => setAdding(data.credentials.length ? "cloud" : "credential")}>
                Add a backup
              </button>
            }
          >
            <p className="modal-text" style={{ marginTop: 0 }}>
              A copy in a bucket somewhere else is what survives a fire, a flood or a stolen box. Copies never delete
              from the bucket what was deleted here.
            </p>
            {data.cloud.length ? (
              data.cloud.map((c) => (
                <div key={c.id} className="kv-row">
                  <span>
                    <strong>{c.description}</strong>{" "}
                    <span className="stat-foot">
                      {c.path} → {c.provider} {c.bucket ?? ""}
                      {c.folder ? `/${c.folder}` : ""} · {describeSchedule(c.schedule)}
                      {c.lastAt ? ` · last ${when(c.lastAt)}` : ""}
                      {c.state ? ` · ${c.state.toLowerCase()}` : ""}
                    </span>
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn small"
                      onClick={() => void run(`Backing up ${c.description}`, `/api/safety/cloud/${c.id}/run`)}
                    >
                      Run now
                    </button>
                    <button className="btn small danger" onClick={() => void remove(`/api/safety/cloud/${c.id}`)}>
                      Remove
                    </button>
                  </span>
                </div>
              ))
            ) : (
              <Empty>Nothing is copied off this NAS yet.</Empty>
            )}
            {!!data.credentials.length && (
              <div className="stat-foot" style={{ marginTop: 8 }}>
                Accounts: {data.credentials.map((c) => `${c.name} (${c.provider})`).join(", ")}.{" "}
                <button className="link-btn inline" onClick={() => setAdding("credential")}>
                  Add another
                </button>
              </div>
            )}
          </Card>

          <Card
            title="Copies to a second pool"
            action={
              <button className="btn small" onClick={() => setAdding("replication")}>
                Add a copy
              </button>
            }
          >
            <p className="modal-text" style={{ marginTop: 0 }}>
              Replication copies a folder's snapshots to another pool, so losing one pool does not lose the history with
              it.{" "}
              {data.snapshotTasks
                ? `${data.snapshotTasks} snapshot schedule${data.snapshotTasks === 1 ? "" : "s"} feed it.`
                : "Schedule snapshots first; there is nothing to copy without them."}
            </p>
            {data.replication.length ? (
              data.replication.map((r) => (
                <div key={r.id} className="kv-row">
                  <span>
                    <strong>{r.name}</strong>{" "}
                    <span className="stat-foot">
                      {r.source.join(", ")} → {r.target} · {r.transport.toLowerCase()} · {describeSchedule(r.schedule)}
                      {r.lastAt ? ` · last ${when(r.lastAt)}` : ""}
                      {r.state ? ` · ${r.state.toLowerCase()}` : ""}
                    </span>
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn small"
                      onClick={() => void run(`Running ${r.name}`, `/api/safety/replication/${r.id}/run`)}
                    >
                      Run now
                    </button>
                    <button className="btn small danger" onClick={() => void remove(`/api/safety/replication/${r.id}`)}>
                      Remove
                    </button>
                  </span>
                </div>
              ))
            ) : (
              <Empty>No copies to another pool yet.</Empty>
            )}
          </Card>

          <Card title="Locked folders">
            <p className="modal-text" style={{ marginTop: 0 }}>
              An encrypted folder is unreadable without its passphrase, even to someone holding the drives. Lock it when
              the NAS leaves the house; export the key and keep it somewhere that is not the NAS.
            </p>
            {data.encrypted.length ? (
              data.encrypted.map((d) => (
                <div key={d.id} className="kv-row">
                  <span>
                    <strong>{d.name}</strong> <span className="stat-foot">{d.keyFormat?.toLowerCase() ?? "key"}</span>
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <Pill state={d.locked ? "OFFLINE" : "ONLINE"}>{d.locked ? "locked" : "unlocked"}</Pill>
                    {d.locked ? (
                      <button className="btn small" onClick={() => setUnlocking(d)}>
                        Unlock
                      </button>
                    ) : (
                      <button className="btn small" onClick={() => setLocking(d)}>
                        Lock
                      </button>
                    )}
                  </span>
                </div>
              ))
            ) : (
              <Empty>No encrypted folders. Create one under Drive array map → Folders with "Encrypt" on.</Empty>
            )}
            {exported && (
              <div className="job done" style={{ marginTop: 10 }}>
                Key: <span className="mono">{exported}</span>. Copy it now; it is not shown again.
              </div>
            )}
          </Card>

          <Card title="Power">
            <p className="modal-text" style={{ marginTop: 0 }}>
              A UPS lets the NAS shut down cleanly when the power goes, instead of mid-write.
            </p>
            <div className="kv">
              <div>
                <span>UPS service</span>
                <b>{data.ups.service ? data.ups.service.state.toLowerCase() : "not present"}</b>
              </div>
              <div>
                <span>Driver</span>
                <b>{data.ups.driver ?? "—"}</b>
              </div>
              <div>
                <span>Port</span>
                <b>{data.ups.port ?? "—"}</b>
              </div>
            </div>
            <p className="stat-foot" style={{ marginTop: 8 }}>
              Set up under TrueNAS → System → Services → UPS; this shows whether it is on.
            </p>
          </Card>
        </div>
      )}

      {adding === "scrub" && data && (
        <ScrubForm
          pools={data.pools.map((p) => p.name)}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void reload();
          }}
        />
      )}
      {adding === "smart" && (
        <SmartForm
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void reload();
          }}
        />
      )}
      {adding === "credential" && (
        <CredentialForm
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding("cloud");
            void reload();
          }}
        />
      )}
      {adding === "cloud" && data && (
        <CloudForm
          credentials={data.credentials}
          folders={folders}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void reload();
          }}
        />
      )}
      {adding === "replication" && (
        <ReplicationForm
          folders={folders}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void reload();
          }}
        />
      )}

      {locking && (
        <DangerConfirm
          what="folder"
          name={locking.id}
          verb="Lock"
          onCancel={() => setLocking(null)}
          onConfirm={async (confirm) => {
            const { jobId } = await post<{ jobId: number }>("/api/datasets/lock", { id: locking.id, confirm });
            setJobs((j) => [...j, { id: jobId, label: `Locking ${locking.name}` }]);
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              Everything inside becomes unreadable until the passphrase is entered again. Apps and shares using it will
              fail until then.
            </p>
          }
        />
      )}
      {unlocking && (
        <UnlockForm
          dataset={unlocking}
          onClose={() => setUnlocking(null)}
          onDone={() => {
            setUnlocking(null);
            void reload();
          }}
          onKey={setExported}
        />
      )}
    </>
  );
}

function ScrubForm({ pools, onClose, onSaved }: { pools: string[]; onClose: () => void; onSaved: () => void }) {
  const [pool, setPool] = useState(pools[0] ?? "");
  const [dom, setDom] = useState("1");
  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/safety/scrubs", { pool, schedule: { minute: "0", hour: "3", dom } });
    onSaved();
  });
  return (
    <Modal
      title="Schedule a scrub"
      subtitle="Monthly, at three in the morning."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !pool} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Schedule"}
          </button>
        </>
      }
    >
      <Field label="Pool">
        <Select value={pool} onChange={(e) => setPool(e.target.value)}>
          {pools.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </Select>
      </Field>
      <Field label="Day of the month">
        <Input type="number" min="1" max="28" value={dom} onChange={(e) => setDom(e.target.value)} />
      </Field>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

function SmartForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<"SHORT" | "LONG">("SHORT");
  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/safety/smart-tests", { type });
    onSaved();
  });
  return (
    <Modal
      title="Schedule a self-test"
      subtitle="Every drive, on the hour, overnight."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Schedule"}
          </button>
        </>
      }
    >
      <Field label="Which test">
        <Select value={type} onChange={(e) => setType(e.target.value as "SHORT" | "LONG")}>
          <option value="SHORT">Short — a few minutes, every Sunday at 02:00</option>
          <option value="LONG">Long — hours, on the 15th of each month at 02:00</option>
        </Select>
      </Field>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

function CredentialForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState<"B2" | "S3">("B2");
  const [name, setName] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    const attributes = provider === "B2" ? { account: a, key: b } : { access_key_id: a, secret_access_key: b };
    await post("/api/safety/cloud/credentials", { name: name || provider, provider, attributes });
    onSaved();
  });
  return (
    <Modal
      title="Add a backup account"
      subtitle="Stored encrypted on the NAS, never shown again."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !a || !b} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Service">
        <Select value={provider} onChange={(e) => setProvider(e.target.value as "B2" | "S3")}>
          <option value="B2">Backblaze B2</option>
          <option value="S3">Amazon S3, or anything S3-compatible</option>
        </Select>
      </Field>
      <Field label="Name for it here">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={provider === "B2" ? "Backblaze" : "S3"}
        />
      </Field>
      <Field label={provider === "B2" ? "Key ID" : "Access key ID"}>
        <Input value={a} onChange={(e) => setA(e.target.value)} autoComplete="off" />
      </Field>
      <Field label={provider === "B2" ? "Application key" : "Secret access key"}>
        <Input type="password" value={b} onChange={(e) => setB(e.target.value)} autoComplete="off" />
      </Field>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

function CloudForm({
  credentials,
  folders,
  onClose,
  onSaved,
}: {
  credentials: Safety["credentials"];
  folders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [credential, setCredential] = useState(credentials[0]?.id ?? 0);
  const [folder, setFolder] = useState(folders[0] ?? "");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [hour, setHour] = useState("1");
  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/safety/cloud", {
      description: `${folder.split("/").pop()} to ${credentials.find((c) => c.id === credential)?.name ?? "cloud"}`,
      path: `/mnt/${folder}`,
      credential,
      bucket,
      folder: prefix,
      schedule: { minute: "0", hour },
    });
    onSaved();
  });
  return (
    <Modal
      title="Copy a folder off the NAS"
      subtitle="Nightly. Files deleted here are kept there."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !bucket || !folder || !credential}
            onClick={() => void submit(undefined as void)}
          >
            {busy ? "Saving…" : "Start backing up"}
          </button>
        </>
      }
    >
      <Field label="Folder">
        <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
          {folders.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </Select>
      </Field>
      <Field label="Account">
        <Select value={credential} onChange={(e) => setCredential(Number(e.target.value))}>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.provider})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Bucket" hint="Must already exist at the provider.">
        <Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="home-nas-backup" />
      </Field>
      <Field label="Folder inside the bucket (optional)">
        <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="family" />
      </Field>
      <Field label="Run at (hour, 0–23)">
        <Input type="number" min="0" max="23" value={hour} onChange={(e) => setHour(e.target.value)} />
      </Field>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

function ReplicationForm({
  folders,
  onClose,
  onSaved,
}: {
  folders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [source, setSource] = useState(folders[0] ?? "");
  const [target, setTarget] = useState("");
  const [recursive, setRecursive] = useState(true);
  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/safety/replication", { source, target, recursive, schedule: { minute: "0", hour: "4" } });
    onSaved();
  });
  return (
    <Modal
      title="Copy a folder to another pool"
      subtitle="Its snapshots, nightly, so the history survives the pool."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !source || !target}
            onClick={() => void submit(undefined as void)}
          >
            {busy ? "Saving…" : "Start copying"}
          </button>
        </>
      }
    >
      <Field label="Folder to copy">
        <Select value={source} onChange={(e) => setSource(e.target.value)}>
          {folders.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </Select>
      </Field>
      <Field
        label="Where the copy lives"
        hint="A dataset on another pool, e.g. backup/family. It is created if it does not exist."
      >
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="fast/copies/family" />
      </Field>
      <Toggle checked={recursive} onChange={setRecursive} label="Include folders inside it" />
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

function UnlockForm({
  dataset,
  onClose,
  onDone,
  onKey,
}: {
  dataset: Safety["encrypted"][number];
  onClose: () => void;
  onDone: () => void;
  onKey: (k: string) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await post("/api/datasets/unlock", { id: dataset.id, passphrase });
    onDone();
  });
  return (
    <Modal
      title={`Unlock ${dataset.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void post<{ key: string }>("/api/datasets/export-key", { id: dataset.id, confirm: dataset.id })
                .then((r) => {
                  onKey(String(r.key));
                  onClose();
                })
                .catch(() => undefined)
            }
          >
            Export key
          </button>
          <button className="btn primary" disabled={busy || !passphrase} onClick={() => void submit(undefined as void)}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </>
      }
    >
      <Field label="Passphrase">
        <Input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
          autoComplete="off"
        />
      </Field>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}
