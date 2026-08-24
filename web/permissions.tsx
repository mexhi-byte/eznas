import { useEffect, useState } from "react";
import { post, put, useResource } from "./api";
import { ErrorBanner, Loading } from "./components";
import { Field, JobProgress, Modal, Select, Toggle } from "./ui";

type Level = "none" | "read" | "write" | "full";

interface Perms { read: boolean; write: boolean; execute: boolean }

interface Permissions {
  path: string;
  acltype: string;
  trivial: boolean;
  owner: { uid: number; name: string | null };
  group: { gid: number; name: string | null };
  mode: number;
  isDirectory: boolean;
  entries: Array<{ tag: string; id: number; who: string | null; isDefault: boolean; perms: Perms }>;
  users: Array<{ uid: number; username: string; full: string }>;
  groups: Array<{ gid: number; group: string }>;
}

interface Grant { kind: "user" | "group"; id: number; level: Level }

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: "none", label: "No access" },
  { id: "read", label: "Read only" },
  { id: "write", label: "Read and write" },
  { id: "full", label: "Full control" },
];

const permsToLevel = (p: Perms): Level =>
  p.write ? "write" : p.read ? "read" : "none";

/**
 * Who can get at one folder.
 *
 * The NAS models this as POSIX ACLs — owner, owning group, everybody else, and
 * a named entry per extra person. This shows exactly that, in those words,
 * because any friendlier abstraction would start lying the moment somebody
 * looks at the same folder in the TrueNAS interface.
 */
export function PermissionsModal({ path, onClose, onJob }: {
  path: string;
  onClose: () => void;
  onJob: (jobId: number, label: string) => void;
}) {
  const { data, error, loading } = useResource<Permissions>(
    `/api/files/permissions?path=${encodeURIComponent(path)}`,
    0,
  );

  const [ownerUid, setOwnerUid] = useState<number | null>(null);
  const [groupGid, setGroupGid] = useState<number | null>(null);
  const [ownerLevel, setOwnerLevel] = useState<Level>("full");
  const [groupLevel, setGroupLevel] = useState<Level>("read");
  const [otherLevel, setOtherLevel] = useState<Level>("none");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [recursive, setRecursive] = useState(false);
  const [inherit, setInherit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Seeded from what is actually on the folder, once, so the form opens
  // showing the truth rather than a set of defaults.
  useEffect(() => {
    if (!data) return;
    setOwnerUid(data.owner.uid);
    setGroupGid(data.group.gid);
    const find = (tag: string) => data.entries.find((e) => e.tag === tag && !e.isDefault);
    const ownerObj = find("USER_OBJ");
    const groupObj = find("GROUP_OBJ");
    const other = find("OTHER");
    if (ownerObj) setOwnerLevel(permsToLevel(ownerObj.perms));
    if (groupObj) setGroupLevel(permsToLevel(groupObj.perms));
    if (other) setOtherLevel(permsToLevel(other.perms));
    setGrants(
      data.entries
        .filter((e) => (e.tag === "USER" || e.tag === "GROUP") && !e.isDefault)
        .map((e) => ({ kind: e.tag === "GROUP" ? "group" : "user", id: e.id, level: permsToLevel(e.perms) })),
    );
  }, [data]);

  async function save() {
    if (!data) return;
    setBusy(true);
    setFailed(null);
    try {
      const r = await put<{ jobId: number }>("/api/files/permissions", {
        path,
        owner: { uid: ownerUid, gid: groupGid },
        ownerLevel, groupLevel, otherLevel,
        access: grants,
        recursive,
        inherit,
        isDirectory: data.isDirectory,
      });
      onJob(r.jobId, `Applying permissions to ${path.split("/").pop()}`);
      onClose();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const nameOf = (g: Grant): string =>
    g.kind === "group"
      ? data?.groups.find((x) => x.gid === g.id)?.group ?? `group ${g.id}`
      : data?.users.find((x) => x.uid === g.id)?.username ?? `user ${g.id}`;

  const unassigned = [
    ...(data?.users ?? [])
      .filter((u) => !grants.some((g) => g.kind === "user" && g.id === u.uid))
      .map((u) => ({ kind: "user" as const, id: u.uid, label: u.username })),
    ...(data?.groups ?? [])
      .filter((gr) => !grants.some((g) => g.kind === "group" && g.id === gr.gid))
      .map((gr) => ({ kind: "group" as const, id: gr.gid, label: `${gr.group} (group)` })),
  ];

  return (
    <Modal
      title="Who can use this folder"
      subtitle={path}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !data} onClick={() => void save()}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {failed && <ErrorBanner>{failed}</ErrorBanner>}
      {loading && !data && <Loading rows={4} />}

      {data && data.acltype !== "POSIX1E" && (
        <ErrorBanner>
          This folder uses {data.acltype} permissions. This console can read them but only writes POSIX ones, so
          saving is disabled — use the TrueNAS interface for this one.
        </ErrorBanner>
      )}

      {data && (
        <>
          <div className="dh-section">
            <h3>Owner</h3>
            <div className="row">
              <Field label="Person">
                <Select value={String(ownerUid ?? "")} onChange={(e) => setOwnerUid(Number(e.target.value))}>
                  {!data.users.some((u) => u.uid === data.owner.uid) && (
                    <option value={data.owner.uid}>{data.owner.name ?? `uid ${data.owner.uid}`}</option>
                  )}
                  {data.users.map((u) => <option key={u.uid} value={u.uid}>{u.username}</option>)}
                </Select>
              </Field>
              <Field label="Group">
                <Select value={String(groupGid ?? "")} onChange={(e) => setGroupGid(Number(e.target.value))}>
                  {!data.groups.some((g) => g.gid === data.group.gid) && (
                    <option value={data.group.gid}>{data.group.name ?? `gid ${data.group.gid}`}</option>
                  )}
                  {data.groups.map((g) => <option key={g.gid} value={g.gid}>{g.group}</option>)}
                </Select>
              </Field>
            </div>
          </div>

          <div className="dh-section">
            <h3>The basics</h3>
            <div className="perm-rows">
              <PermRow label="The owner" level={ownerLevel} onChange={setOwnerLevel} />
              <PermRow label="The owning group" level={groupLevel} onChange={setGroupLevel} />
              <PermRow
                label="Everybody else"
                level={otherLevel}
                onChange={setOtherLevel}
                hint="Anyone with an account on the NAS who is not the owner and not in the group."
              />
            </div>
          </div>

          <div className="dh-section">
            <h3>Specific people</h3>
            <div className="perm-rows">
              {grants.map((g, i) => (
                <div key={`${g.kind}-${g.id}`} className="perm-row">
                  <span>{nameOf(g)}{g.kind === "group" ? " (group)" : ""}</span>
                  <Select
                    value={g.level}
                    onChange={(e) =>
                      setGrants(grants.map((x, j) => (j === i ? { ...x, level: e.target.value as Level } : x)))
                    }
                  >
                    {LEVELS.filter((l) => l.id !== "none").map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </Select>
                  <button className="btn danger" onClick={() => setGrants(grants.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}

              {unassigned.length > 0 && (
                <div className="perm-row">
                  <Select
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const [kind, id] = e.target.value.split(":");
                      setGrants([...grants, { kind: kind as "user" | "group", id: Number(id), level: "read" }]);
                    }}
                  >
                    <option value="">Add somebody…</option>
                    {unassigned.map((u) => (
                      <option key={`${u.kind}:${u.id}`} value={`${u.kind}:${u.id}`}>{u.label}</option>
                    ))}
                  </Select>
                  <span />
                  <span />
                </div>
              )}

              {!grants.length && unassigned.length === 0 && (
                <p className="modal-text" style={{ margin: 0 }}>
                  There are no non-builtin users on the NAS yet. Add one under Household accounts first.
                </p>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {data.isDirectory && (
              <Toggle
                checked={inherit}
                onChange={setInherit}
                label="Give new files and folders created in here the same access"
              />
            )}
            <Toggle
              checked={recursive}
              onChange={setRecursive}
              label="Apply to everything already inside as well"
            />
          </div>

          {recursive && (
            <p className="modal-text" style={{ color: "var(--warn)" }}>
              This rewrites the permissions of every file and folder underneath, replacing whatever they have now.
              There is no undo.
            </p>
          )}

          <p className="modal-text">
            Read includes the right to open the folder — on a directory those cannot usefully be separated. Apps that
            write here run as their own user, so changing the owner can stop an app dead; the safer move is usually to
            add that person under <strong>Specific people</strong> and leave the owner alone.
          </p>
        </>
      )}
    </Modal>
  );
}

function PermRow({ label, level, onChange, hint }: {
  label: string;
  level: Level;
  onChange: (l: Level) => void;
  hint?: string;
}) {
  return (
    <div className="perm-row">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <Select value={level} onChange={(e) => onChange(e.target.value as Level)}>
        {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </Select>
      <span />
    </div>
  );
}
