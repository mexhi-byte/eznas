import { useState } from "react";
import { del, post, put, useResource, when } from "./api";
import { Card, Empty, ErrorBanner, Loading } from "./components";
import { DangerConfirm, Field, Input, Modal, Select, useSubmit } from "./ui";

export interface ConsoleAccount {
  id: string;
  username: string;
  role: "admin" | "viewer";
  mfa: boolean;
  recoveryRemaining: number;
  createdAt: number;
  lastSeen: number | null;
}

/**
 * Who can sign in to this console.
 *
 * Deliberately not the same list as Household accounts: those are TrueNAS
 * users, who own files and connect to shares. These are people who open this
 * dashboard. Somebody can easily need one without the other.
 */
export function ConsoleUsersTab({ meUsername }: { meUsername: string }) {
  const { data, error, loading, reload } = useResource<ConsoleAccount[]>("/api/accounts", 0);
  const [editing, setEditing] = useState<ConsoleAccount | "new" | null>(null);
  const [removing, setRemoving] = useState<ConsoleAccount | null>(null);

  const admins = (data ?? []).filter((a) => a.role === "admin").length;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <span className="card-title">
          People who can sign in here. Administrators can change things; viewers can only look.
        </span>
        <button className="btn primary" style={{ flex: "none", padding: "8px 16px" }} onClick={() => setEditing("new")}>
          Add someone
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        {loading && !data ? (
          <Loading rows={3} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Can do</th>
                  <th>2FA</th>
                  <th>Last signed in</th>
                  <th style={{ width: 170 }} />
                </tr>
              </thead>
              <tbody>
                {data?.map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600 }}>
                      {a.username}
                      {a.username === meUsername && <span className="pill info" style={{ marginLeft: 8 }}>you</span>}
                    </td>
                    <td>
                      <span className={`pill ${a.role === "admin" ? "warn" : "mute"}`}>
                        {a.role === "admin" ? "everything" : "view only"}
                      </span>
                    </td>
                    <td style={{ color: a.mfa ? "var(--ok)" : "var(--faint)" }}>
                      {a.mfa ? `on · ${a.recoveryRemaining} codes left` : "off"}
                    </td>
                    <td style={{ color: "var(--muted)" }}>{a.lastSeen ? when(a.lastSeen) : "never"}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn" onClick={() => setEditing(a)}>Edit</button>
                        <button
                          className="btn danger"
                          disabled={a.username === meUsername || (a.role === "admin" && admins === 1)}
                          title={
                            a.username === meUsername
                              ? "You cannot delete the account you are signed in with."
                              : a.role === "admin" && admins === 1
                                ? "This is the only administrator."
                                : undefined
                          }
                          onClick={() => setRemoving(a)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!data?.length && <tr><td colSpan={5}><Empty>Nobody yet.</Empty></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <AccountForm
          account={editing === "new" ? null : editing}
          isMe={editing !== "new" && editing.username === meUsername}
          onlyAdmin={editing !== "new" && editing.role === "admin" && admins === 1}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}

      {removing && (
        <DangerConfirm
          what="account"
          name={removing.username}
          verb="Delete"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/accounts/${removing.id}`);
            await reload();
          }}
          extra={
            <p className="modal-text" style={{ marginTop: 10 }}>
              They stop being able to sign in here. Nothing on the NAS changes — this is not their file access.
            </p>
          }
        />
      )}
    </>
  );
}

function AccountForm({ account, isMe, onlyAdmin, onClose, onSaved }: {
  account: ConsoleAccount | null;
  isMe: boolean;
  onlyAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState(account?.username ?? "");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">(account?.role ?? "viewer");

  const { busy, error, submit } = useSubmit(async () => {
    if (account) {
      await put(`/api/accounts/${account.id}`, {
        username,
        role,
        ...(password ? { password, ...(isMe ? { currentPassword } : {}) } : {}),
      });
    } else {
      await post("/api/accounts", { username, password, role });
    }
    onSaved();
  });

  const needCurrent = isMe && !!password;
  const ready = username.trim().length >= 2 && (account ? true : password.length >= 8) && (!needCurrent || !!currentPassword);

  return (
    <Modal
      title={account ? `Edit ${account.username}` : "Add someone"}
      subtitle={account ? "Leave the password empty to keep the current one." : "They will sign in with this username and password."}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !ready} onClick={() => void submit(undefined as void)}>
            {busy ? "Saving…" : account ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <Field label="Username">
        <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="off" />
      </Field>

      {needCurrent && (
        <Field label="Your current password" hint="Proof it is really you, not just an unlocked browser.">
          <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
        </Field>
      )}

      <Field label={account ? "New password" : "Password"} hint="At least 8 characters.">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder={account ? "unchanged" : ""}
        />
      </Field>

      <Field
        label="Can do"
        hint={
          onlyAdmin
            ? "This is the only administrator, so the role cannot be changed."
            : "A viewer sees every page but every change is refused — by the server, not just by hiding buttons."
        }
      >
        <Select value={role} onChange={(e) => setRole(e.target.value as "admin" | "viewer")} disabled={onlyAdmin}>
          <option value="admin">Everything</option>
          <option value="viewer">View only</option>
        </Select>
      </Field>

      {error && <ErrorBanner>{error}</ErrorBanner>}
    </Modal>
  );
}
