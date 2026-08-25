import { useState } from "react";
import { del, post, put, useResource } from "./api";
import { Card, Empty, ErrorBanner, Loading, Pill } from "./components";
import { DangerConfirm, Field, Input, JobProgress, Modal, Select, Toggle, useSubmit } from "./ui";

interface SmbShare {
  id: number;
  name: string;
  path: string;
  enabled: boolean;
  comment?: string;
  readOnly: boolean;
}

interface NfsShare { id: number; path: string; enabled: boolean; comment?: string; networks?: string[]; hosts?: string[] }

interface Shares { smb: SmbShare[]; nfs: NfsShare[] }

interface Dataset { id: string; mountpoint: string; type: string }

interface Who { users: Array<{ uid: number; username: string }>; groups: Array<{ gid: number; group: string }> }

type Level = "read" | "write" | "full";
interface Grant { kind: "user" | "group"; id: number; level: Level }

export function SharesPage() {
  const { data, error, loading, reload } = useResource<Shares>("/api/shares", 60_000);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SmbShare | null>(null);
  const [removing, setRemoving] = useState<SmbShare | null>(null);
  const [removingNfs, setRemovingNfs] = useState<NfsShare | null>(null);
  const [jobs, setJobs] = useState<Array<{ id: number; label: string }>>([]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Shared folders</h1>
          <div className="page-sub">
            {data ? `${data.smb.length} on the network · ${data.nfs.length} NFS export${data.nfs.length === 1 ? "" : "s"}` : " "}
          </div>
        </div>
        <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setCreating(true)}>
          Share a folder
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {loading && !data && <Loading rows={3} />}

      <Card title="On the network (SMB)">
        {data?.smb.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Folder</th><th>Access</th><th>State</th><th style={{ width: 210 }} /></tr>
              </thead>
              <tbody>
                {data.smb.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                    <td className="mono" style={{ fontSize: 12.5, color: "var(--muted)" }}>{s.path}</td>
                    <td>
                      <span className={`pill ${s.readOnly ? "info" : "mute"}`}>
                        {s.readOnly ? "read only" : "read and write"}
                      </span>
                    </td>
                    <td><Pill state={s.enabled ? "ONLINE" : "STOPPED"}>{s.enabled ? "on" : "off"}</Pill></td>
                    <td>
                      <div className="row-actions">
                        <button className="btn" onClick={() => setEditing(s)}>Edit</button>
                        <button className="btn danger" onClick={() => setRemoving(s)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !loading && <Empty>Nothing is shared yet.</Empty>
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title="NFS exports">
          {data?.nfs.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Path</th><th>Allowed</th><th>State</th><th style={{ width: 110 }} /></tr></thead>
                <tbody>
                  {data.nfs.map((s) => {
                    const allowed = [...(s.networks ?? []), ...(s.hosts ?? [])];
                    return (
                      <tr key={s.path}>
                        <td className="mono" style={{ fontSize: 12.5 }}>{s.path}</td>
                        <td style={{ color: allowed.length ? "var(--muted)" : "var(--warn)" }}>
                          {allowed.length ? allowed.join(", ") : "everyone"}
                        </td>
                        <td><Pill state={s.enabled ? "ONLINE" : "STOPPED"}>{s.enabled ? "on" : "off"}</Pill></td>
                        <td>
                          <div className="row-actions">
                            <button className="btn danger" onClick={() => setRemovingNfs(s)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            !loading && <Empty>No NFS exports yet. Use “Share a folder” and choose Linux and Unix.</Empty>
          )}
        </Card>
      </div>

      {creating && (
        <ShareFolder
          onClose={() => setCreating(false)}
          onDone={(jobId) => {
            setCreating(false);
            if (jobId) setJobs((j) => [...j, { id: jobId, label: "Applying who can use it" }]);
            void reload();
          }}
        />
      )}

      {editing && <EditShare share={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}

      {removing && (
        <DangerConfirm
          what="share"
          name={removing.name}
          verb="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async (confirm) => {
            await del(`/api/shares/smb/${removing.id}`, { confirm });
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              The folder stops appearing on the network. Nothing inside it is touched, and the permissions on it stay
              as they are.
            </p>
          }
        />
      )}

      {removingNfs && (
        <DangerConfirm
          what="export"
          name={removingNfs.path}
          verb="Remove"
          onCancel={() => setRemovingNfs(null)}
          onConfirm={async (confirm) => {
            await del(`/api/shares/nfs/${removingNfs.id}`, { confirm });
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              The folder stops being mountable. Nothing inside it is touched, and machines that have it mounted now
              will see it stop responding rather than be told it has gone.
            </p>
          }
        />
      )}

      {!!jobs.length && (
        <div className="job-tray">
          {jobs.map((j) => (
            <JobProgress key={j.id} jobId={j.id} label={j.label}
              onDone={() => setTimeout(() => setJobs((all) => all.filter((x) => x.id !== j.id)), 6000)} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Share a folder and say who may use it, in one step.
 *
 * Creating the share alone is the trap: the folder turns up on the network and
 * then refuses everybody, because access is decided by the folder's
 * permissions rather than by the share. Both are set here, together.
 */
export function ShareFolder({ fixedPath, onClose, onDone }: {
  fixedPath?: string;
  onClose: () => void;
  onDone: (permissionsJobId: number | null) => void;
}) {
  const { data: datasets } = useResource<Dataset[]>("/api/datasets", 0);
  const { data: who } = useResource<Who>(
    `/api/files/permissions?path=${encodeURIComponent(fixedPath ?? "/mnt")}`,
    0,
  );

  const usable = (datasets ?? []).filter((d) => d.type !== "VOLUME" && d.mountpoint);
  const [path, setPath] = useState(fixedPath ?? "");
  const [name, setName] = useState(fixedPath ? (fixedPath.split("/").pop() ?? "") : "");
  const [readOnly, setReadOnly] = useState(false);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [recursive, setRecursive] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<"smb" | "nfs">("smb");
  // One empty row to start: an empty list is the dangerous default, so the
  // form should look like it is waiting for something rather than finished.
  const [networks, setNetworks] = useState<string[]>([""]);
  const [maproot, setMaproot] = useState(false);
  const [group, setGroup] = useState<number | null>(null);

  const chosen = path || usable[0]?.mountpoint || "";
  const shareName = name || chosen.split("/").pop() || "";

  const { busy, error, submit } = useSubmit(async () => {
    if (protocol === "nfs") {
      const r = await post<{ startedService: boolean; permissionsJobId: number | null }>("/api/shares/nfs", {
        path: chosen,
        networks: networks.map((n) => n.trim()).filter(Boolean),
        hosts: [],
        readOnly,
        comment: "",
        maproot,
        // The server reads `group`. Sending `groupId` here would leave the
        // folder's permissions untouched and the export unwritable, silently.
        group,
        recursive,
      });
      setDone(r.startedService ? "Exported, and NFS was switched on for you." : "Exported.");
      onDone(r.permissionsJobId);
      return;
    }
    const r = await post<{ startedService: boolean; permissionsJobId: number | null }>("/api/shares/smb", {
      name: shareName,
      path: chosen,
      readOnly,
      access: grants,
      recursive,
    });
    setDone(
      r.startedService
        ? "Shared, and Windows file sharing was switched on for you."
        : "Shared.",
    );
    onDone(r.permissionsJobId);
  });

  const unassigned = [
    ...(who?.users ?? [])
      .filter((u) => !grants.some((g) => g.kind === "user" && g.id === u.uid))
      .map((u) => ({ kind: "user" as const, id: u.uid, label: u.username })),
    ...(who?.groups ?? [])
      .filter((gr) => !grants.some((g) => g.kind === "group" && g.id === gr.gid))
      .map((gr) => ({ kind: "group" as const, id: gr.gid, label: `${gr.group} (group)` })),
  ];

  const nameOf = (g: Grant) =>
    g.kind === "group"
      ? who?.groups.find((x) => x.gid === g.id)?.group ?? `group ${g.id}`
      : who?.users.find((x) => x.uid === g.id)?.username ?? `user ${g.id}`;

  if (done) {
    return (
      <Modal title={protocol === "nfs" ? "Exported" : "Shared"} subtitle={chosen} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p className="modal-text">{done}</p>
        {protocol === "nfs" ? (
          <p className="modal-text">
            On Linux:{" "}
            <strong className="mono">sudo mount -t nfs {location.hostname}:{chosen} /mnt/somewhere</strong>
          </p>
        ) : (
          <p className="modal-text">
            On Windows it is <strong className="mono">\\{location.hostname}\{shareName}</strong>; on a Mac, Go → Connect
            to Server. People sign in with their NAS account.
          </p>
        )}
        {protocol === "smb" && !grants.length && (
          <p className="modal-text" style={{ color: "var(--warn)" }}>
            Nobody was given access, so the folder's existing permissions decide who can open it — which may be
            nobody. Use Access on the folder to grant someone.
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title="Share a folder"
      subtitle={protocol === "nfs"
        ? "Exported to the machines you name, mounted by path."
        : "Windows, macOS and Linux see it as a normal network folder."}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          {/* An NFS export with no machines is refused by the server; disabling
              the button says so before the round trip rather than after. */}
          <button
            className="btn primary"
            disabled={busy || !chosen || (protocol === "smb" ? !shareName : !networks.some((n) => n.trim()))}
            onClick={() => void submit(undefined as void)}
          >
            {busy ? (protocol === "nfs" ? "Exporting…" : "Sharing…") : protocol === "nfs" ? "Export it" : "Share it"}
          </button>
        </>
      }
    >
      {/* Asked first, because it changes what the rest of the form asks. SMB
          authenticates people; NFS without Kerberos authenticates machines and
          then trusts whatever user id they claim. */}
      <Field label="Who needs to reach it">
        <div className="proto-switch">
          <button type="button" className={`proto ${protocol === "smb" ? "on" : ""}`} onClick={() => setProtocol("smb")}>
            <strong>Windows, Mac and phones</strong>
            <span>People sign in with their NAS account.</span>
          </button>
          <button type="button" className={`proto ${protocol === "nfs" ? "on" : ""}`} onClick={() => setProtocol("nfs")}>
            <strong>Linux and Unix</strong>
            <span>Machines are allowed by address, not by account.</span>
          </button>
        </div>
      </Field>

      {fixedPath ? (
        <Field label="Folder"><Input value={fixedPath} readOnly /></Field>
      ) : (
        <Field label="Folder" hint="Only datasets can be shared — each one is its own filesystem.">
          <Select value={chosen} onChange={(e) => setPath(e.target.value)}>
            {usable.map((d) => <option key={d.id} value={d.mountpoint}>{d.id}</option>)}
          </Select>
        </Field>
      )}

      {/* An NFS export is reached by path, not by a name of its own. */}
      {protocol === "smb" && (
        <Field label="Name on the network" hint="What it is called when somebody browses to this server.">
          <Input
            value={name}
            placeholder={chosen.split("/").pop() ?? ""}
            onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9 _-]/g, ""))}
          />
        </Field>
      )}

      {protocol === "nfs" && (
        <>
          <Field
            label="Which machines"
            hint="An address like 192.168.1.50, or a whole network like 192.168.1.0/24."
          >
            {networks.map((n, i) => (
              <div key={i} className="net-row">
                <Input
                  value={n}
                  placeholder="192.168.1.0/24"
                  onChange={(e) => setNetworks(networks.map((x, j) => (j === i ? e.target.value : x)))}
                />
                {networks.length > 1 && (
                  <button className="link-btn" onClick={() => setNetworks(networks.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button className="link-btn" onClick={() => setNetworks([...networks, ""])}>Add another</button>
            {!networks.some((n) => n.trim()) && (
              <p className="modal-text" style={{ color: "var(--warn)" }}>
                Leaving this empty would export the folder to every device on your network. The console refuses to
                create that.
              </p>
            )}
          </Field>

          {!readOnly && (
            <Field label="Which group owns it" hint="Members of this group get write access to the folder itself.">
              <Select value={String(group ?? "")} onChange={(e) => setGroup(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Leave the folder's permissions alone</option>
                {(who?.groups ?? []).map((g) => <option key={g.gid} value={g.gid}>{g.group}</option>)}
              </Select>
              {group === null && (
                <p className="modal-text" style={{ color: "var(--warn)" }}>
                  A dataset starts owned by root with everyone else read-only, so a read-write export nobody adjusted
                  mounts and then refuses every write.
                </p>
              )}
            </Field>
          )}

          <details className="advanced">
            <summary>Advanced</summary>
            <Toggle
              checked={maproot}
              onChange={setMaproot}
              label="Let root on those machines write as root here"
            />
            <p className="modal-text" style={{ color: "var(--warn)" }}>
              With this on, anyone with administrator access to any machine you allowed above can read, change and
              delete anything in this folder, whatever its permissions say. It is the usual advice in forum threads
              about NFS permissions because it makes the symptom go away. Leave it off unless something specifically
              needs it.
            </p>
          </details>
        </>
      )}

      <div className="dh-section" style={{ marginTop: 18, display: protocol === "smb" ? undefined : "none" }}>
        <h3>Who can use it</h3>
        <div className="perm-rows">
          {grants.map((g, i) => (
            <div key={`${g.kind}-${g.id}`} className="perm-row">
              <span>{nameOf(g)}{g.kind === "group" ? " (group)" : ""}</span>
              <Select
                value={g.level}
                onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, level: e.target.value as Level } : x)))}
              >
                <option value="read">Read only</option>
                <option value="write">Read and write</option>
                <option value="full">Full control</option>
              </Select>
              <button className="btn danger" onClick={() => setGrants(grants.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}

          {unassigned.length > 0 && (
            <div className="perm-row">
              <Select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const [kind, id] = e.target.value.split(":");
                  setGrants([...grants, { kind: kind as "user" | "group", id: Number(id), level: "write" }]);
                }}
              >
                <option value="">Add somebody…</option>
                {unassigned.map((u) => <option key={`${u.kind}:${u.id}`} value={`${u.kind}:${u.id}`}>{u.label}</option>)}
              </Select>
              <span />
              <span />
            </div>
          )}
        </div>

        {!grants.length && (
          <p className="modal-text" style={{ color: "var(--warn)" }}>
            Nobody chosen yet. A share with no permissions set appears on the network and then refuses everyone — the
            single most common reason SMB looks broken.
          </p>
        )}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <Toggle checked={readOnly} onChange={setReadOnly} label="Read-only share — nobody can change anything through it" />
        <Toggle checked={recursive} onChange={setRecursive} label="Apply this access to everything already in the folder" />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

function EditShare({ share, onClose, onSaved }: { share: SmbShare; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(share.name);
  const [comment, setComment] = useState(share.comment ?? "");
  const [readOnly, setReadOnly] = useState(share.readOnly);
  const [enabled, setEnabled] = useState(share.enabled);

  const { busy, error, submit } = useSubmit(async () => {
    await put(`/api/shares/smb/${share.id}`, { name, comment, readOnly, enabled });
    onSaved();
  });

  return (
    <Modal
      title={`Edit ${share.name}`}
      subtitle={share.path}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !name} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Name on the network">
        <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9 _-]/g, ""))} />
      </Field>
      <Field label="Note" hint="Only for you — it shows in the share list.">
        <Input value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <div style={{ display: "grid", gap: 8 }}>
        <Toggle checked={readOnly} onChange={setReadOnly} label="Read-only" />
        <Toggle checked={enabled} onChange={setEnabled} label="Available on the network" />
      </div>
      <p className="modal-text">
        Who can open it is set on the folder itself — use <strong>Access</strong> on it under My files.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}
