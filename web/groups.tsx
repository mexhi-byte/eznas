import { useEffect, useState } from "react";
import { del, get, post, put, useResource } from "./api";
import { Card, Empty, ErrorBanner, Loading } from "./components";
import { DangerConfirm, Field, Input, Modal, Toggle, useSubmit } from "./ui";

/**
 * The household's groups: who is in them, and what deleting one would break.
 *
 * Users had create, edit and delete for a release while groups next to them
 * were a read-only list. The one thing here that TrueNAS's own interface does
 * not do is the warning on delete: it removes a group and leaves every shared
 * folder that granted it access pointing at a number nobody owns.
 */

export interface Group {
  id: number;
  gid: number;
  name: string;
  builtin: boolean;
  smb?: boolean;
  users: number;
  members: number[];
}

interface Member {
  id: number;
  username: string;
  fullName: string;
  builtin: boolean;
}

interface Orphans {
  group: string;
  affected: Array<{ name: string; path: string }>;
  warning: string | null;
}

export function GroupsPage() {
  const [showBuiltin, setShowBuiltin] = useState(false);
  const { data, error, loading, reload } = useResource<Group[]>("/api/groups", 30_000);
  const { data: users } = useResource<Member[]>("/api/users?builtin=0", 0);
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [removing, setRemoving] = useState<Group | null>(null);

  const groups = (data ?? []).filter((g) => showBuiltin || !g.builtin).sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: number) => users?.find((u) => u.id === id)?.username ?? `#${id}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Groups</h1>
          <div className="page-sub">{data ? `${groups.length} groups` : " "}</div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Toggle checked={showBuiltin} onChange={setShowBuiltin} label="Show built-in" />
          <button
            className="btn primary"
            style={{ flex: "none", padding: "8px 16px" }}
            onClick={() => setEditing("new")}
          >
            Add group
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        {loading && !data ? (
          <Loading rows={4} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Members</th>
                  <th>Windows sharing</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <strong>{g.name}</strong>
                      <div className="stat-foot mono">gid {g.gid}</div>
                    </td>
                    <td>
                      {g.members.length ? (
                        g.members.slice(0, 6).map(nameOf).join(", ") +
                        (g.members.length > 6 ? ` +${g.members.length - 6}` : "")
                      ) : (
                        <span style={{ color: "var(--faint)" }}>nobody</span>
                      )}
                    </td>
                    <td>{g.smb === false ? "no" : "yes"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn small" onClick={() => setEditing(g)} disabled={g.builtin}>
                        Edit
                      </button>{" "}
                      <button className="btn small danger" onClick={() => setRemoving(g)} disabled={g.builtin}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!groups.length && <Empty>No groups yet. Built-in ones are hidden unless you ask.</Empty>}
          </div>
        )}
      </Card>

      {editing && (
        <GroupForm
          group={editing === "new" ? null : editing}
          users={users ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}

      {removing && <DeleteGroup group={removing} onCancel={() => setRemoving(null)} onDone={() => void reload()} />}
    </>
  );
}

function GroupForm({
  group,
  users,
  onClose,
  onSaved,
}: {
  group: Group | null;
  users: Member[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [smb, setSmb] = useState(group?.smb !== false);
  const [members, setMembers] = useState<number[]>(group?.members ?? []);
  const [filter, setFilter] = useState("");

  const { busy, error, submit } = useSubmit(async () => {
    if (group) await put(`/api/groups/${group.id}`, { name, smb, members });
    else await post("/api/groups", { name, smb, members });
    onSaved();
  });

  const toggle = (id: number) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const shown = users.filter(
    (u) => !filter || `${u.username} ${u.fullName}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <Modal
      title={group ? `Edit ${group.name}` : "Add a group"}
      subtitle="A group is how several people get the same access to a folder, and how a share names them all at once."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() => void submit(undefined as void)}
          >
            {busy ? "Saving…" : group ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <Field
        label="Name"
        hint="Letters, numbers, dashes and underscores. This is the name shares and folders will show."
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="family" autoFocus />
      </Field>
      <Toggle checked={smb} onChange={setSmb} label="Usable from Windows and Mac shares (SMB)" />

      <Field
        label={`Members (${members.length})`}
        hint="Tick who belongs. A person can be in as many groups as you like."
      >
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a person…" />
        <div className="member-pick">
          {shown.map((u) => (
            <label key={u.id} className={`toggle ${members.includes(u.id) ? "on" : ""}`}>
              <input type="checkbox" checked={members.includes(u.id)} onChange={() => toggle(u.id)} />
              <span>
                {u.username}
                {u.fullName && u.fullName !== u.username ? (
                  <span style={{ color: "var(--muted)" }}> · {u.fullName}</span>
                ) : null}
              </span>
            </label>
          ))}
          {!shown.length && <span style={{ color: "var(--faint)", fontSize: 13 }}>Nobody matches.</span>}
        </div>
      </Field>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

/**
 * Delete, with the warning TrueNAS does not give.
 *
 * Fetched when the dialog opens, so the person reads which folders will be
 * left granting access to a dead id before they type the name. Fetch failure
 * is said plainly rather than shown as "no folders affected".
 */
function DeleteGroup({ group, onCancel, onDone }: { group: Group; onCancel: () => void; onDone: () => void }) {
  const [orphans, setOrphans] = useState<Orphans | null | "failed">(null);

  useEffect(() => {
    get<Orphans>(`/api/groups/${group.id}/orphans`)
      .then(setOrphans)
      .catch(() => setOrphans("failed"));
  }, [group.id]);

  return (
    <DangerConfirm
      what="group"
      name={group.name}
      verb="Delete"
      onCancel={onCancel}
      onConfirm={async (confirm) => {
        await del(`/api/groups/${group.id}`, { confirm });
        onDone();
      }}
      extra={
        <div style={{ marginTop: 12 }}>
          {orphans === null && <p className="modal-text">Checking which shared folders grant this group access…</p>}
          {orphans === "failed" && (
            <p className="modal-text" style={{ color: "var(--warn)" }}>
              The shared folders could not be checked, so it is not known whether any grant this group access.
            </p>
          )}
          {orphans && orphans !== "failed" && orphans.warning && (
            <p className="modal-text" style={{ color: "var(--warn)" }}>
              {orphans.warning}
            </p>
          )}
          {orphans && orphans !== "failed" && !orphans.warning && (
            <p className="modal-text">No shared folder grants this group access. Its members keep their own.</p>
          )}
        </div>
      }
    />
  );
}
