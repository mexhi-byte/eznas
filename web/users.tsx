import { useState } from "react";
import { del, post, put, useResource } from "./api";
import { Card, Empty, ErrorBanner, Loading } from "./components";
import { DangerConfirm, Field, Input, Modal, Select, Toggle, useSubmit } from "./ui";
import { GroupsPage } from "./groups";

/* ------------------------------------------------------------------ users */

interface User {
  id: number;
  uid: number;
  username: string;
  fullName: string;
  email: string | null;
  shell: string;
  home: string;
  locked: boolean;
  builtin: boolean;
  smb: boolean;
  sudo: boolean;
}

/** People and their groups, one switch between the two. */
export function UsersPage() {
  const [view, setView] = useState<"people" | "groups">(() =>
    window.location.hash.endsWith("/groups") ? "groups" : "people",
  );
  return (
    <>
      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={view === "people" ? "on" : ""} onClick={() => setView("people")}>
          People
        </button>
        <button className={view === "groups" ? "on" : ""} onClick={() => setView("groups")}>
          Groups
        </button>
      </div>
      {view === "people" ? <PeoplePage /> : <GroupsPage />}
    </>
  );
}

function PeoplePage() {
  const [showBuiltin, setShowBuiltin] = useState(false);
  const { data, error, loading, reload } = useResource<User[]>(`/api/users?builtin=${showBuiltin ? 1 : 0}`, 30_000);
  const { data: groups } = useResource<Array<{ id: number; gid: number; name: string; builtin: boolean }>>(
    "/api/groups",
    0,
  );
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="page-sub">{data ? `${data.length} accounts` : " "}</div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Toggle checked={showBuiltin} onChange={setShowBuiltin} label="Show built-in" />
          <button
            className="btn primary"
            style={{ flex: "none", padding: "8px 16px" }}
            onClick={() => setEditing("new")}
          >
            Add user
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
                  <th>Username</th>
                  <th>Name</th>
                  <th className="num">UID</th>
                  <th>Shell</th>
                  <th>Flags</th>
                  <th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {data?.map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.username}</td>
                    <td style={{ color: "var(--muted)" }}>{u.fullName || "—"}</td>
                    <td className="num">{u.uid}</td>
                    <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
                      {u.shell?.split("/").pop()}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {u.builtin && <span className="pill mute">built-in</span>}
                        {u.locked && <span className="pill bad">locked</span>}
                        {u.smb && <span className="pill info">SMB</span>}
                        {u.sudo && <span className="pill warn">sudo</span>}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button className="btn" style={{ flex: "none" }} onClick={() => setEditing(u)}>
                          Edit
                        </button>
                        <button
                          className="btn danger"
                          style={{ flex: "none" }}
                          disabled={u.builtin}
                          onClick={() => setRemoving(u)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!data?.length && (
                  <tr>
                    <td colSpan={6}>
                      <Empty>No accounts.</Empty>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <UserForm
          user={editing === "new" ? null : editing}
          groups={groups ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="user"
          name={removing.username}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async (confirm) => {
            await del(`/api/users/${removing.id}`, { confirm, deleteGroup: true });
            await reload();
          }}
        />
      )}
    </>
  );
}

function UserForm({
  user,
  groups,
  onClose,
  onSaved,
}: {
  user: User | null;
  groups: Array<{ id: number; gid: number; name: string; builtin: boolean }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [group, setGroup] = useState("");
  const [smb, setSmb] = useState(user?.smb ?? true);
  const [locked, setLocked] = useState(user?.locked ?? false);
  const [homeCreate, setHomeCreate] = useState(false);

  const { busy, error, submit } = useSubmit(async () => {
    if (user) {
      await put(`/api/users/${user.id}`, { fullName, email, password: password || undefined, smb, locked });
    } else {
      await post("/api/users", {
        username,
        fullName,
        email: email || undefined,
        password: password || undefined,
        group: group || undefined,
        smb,
        homeCreate,
      });
    }
    onSaved();
  });

  return (
    <Modal
      title={user ? `Edit ${user.username}` : "Add a user"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || (!user && !username)}
            onClick={() => void submit(undefined as void)}
          >
            {busy ? "Saving…" : user ? "Save" : "Create"}
          </button>
        </>
      }
    >
      {!user && (
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder="jsmith" />
        </Field>
      )}

      <Field label="Full name">
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Smith" />
      </Field>

      <Field label="Email">
        <Input
          type="email"
          value={email ?? ""}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@example.com"
        />
      </Field>

      <Field
        label={user ? "New password (blank to leave unchanged)" : "Password"}
        hint={
          user
            ? undefined
            : "Leave blank to create the account with password login disabled — useful for key-only or SMB-only accounts."
        }
      >
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>

      {!user && (
        <Field label="Primary group" hint="Blank creates a group named after the user, which is what you usually want.">
          <Select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Create a new group</option>
            {groups
              .filter((g) => !g.builtin)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.gid})
                </option>
              ))}
          </Select>
        </Field>
      )}

      <Toggle checked={smb} onChange={setSmb} label="Allow SMB access" />
      {!user && <Toggle checked={homeCreate} onChange={setHomeCreate} label="Create a home directory" />}
      {user && <Toggle checked={locked} onChange={setLocked} label="Locked" />}

      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}

/* ---------------------------------------------------------------- catalog */
