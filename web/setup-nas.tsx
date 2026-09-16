import { useEffect, useState } from "react";
import { bytes, get, post } from "./api";
import { ErrorBanner, Loading } from "./components";
import { Field, Input, Modal, Toggle } from "./ui";

/**
 * A box with empty drives to a working home server, in one sitting.
 *
 * The pieces all exist as dialogs — pool, folder, user, share, snapshot
 * schedule, scrub — and a first-time owner would have to find each, in the
 * right order, knowing what the next one needs from the last. This asks the
 * questions in that order with the usual answers filled in, shows one
 * summary, and then does the work in sequence, saying what it is doing and
 * stopping at the first thing that fails rather than pretending.
 */

type Step = "pool" | "folders" | "people" | "protection" | "summary" | "run";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "pool", label: "Pool" },
  { id: "folders", label: "Folders" },
  { id: "people", label: "People" },
  { id: "protection", label: "Protection" },
  { id: "summary", label: "Go" },
];

interface Layouts {
  drives: Array<{ name: string; size: number; type?: string }>;
  options: Array<{
    layout: string;
    usable: number;
    survives: number;
    summary: string;
    note: string;
    recommended: boolean;
  }>;
}
interface Person {
  username: string;
  password: string;
}
interface StepResult {
  label: string;
  state: "pending" | "running" | "done" | "failed";
  detail?: string;
}

const SUGGESTED = ["Family", "Media", "Backups"];

export function SetupNasWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>("pool");
  const [layouts, setLayouts] = useState<Layouts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [poolName, setPoolName] = useState("tank");
  const [layout, setLayout] = useState("");
  const [folders, setFolders] = useState<string[]>([...SUGGESTED]);
  const [customFolder, setCustomFolder] = useState("");
  const [people, setPeople] = useState<Person[]>([{ username: "", password: "" }]);
  const [snapshots, setSnapshots] = useState(true);
  const [scrub, setScrub] = useState(true);
  const [smart, setSmart] = useState(true);
  const [results, setResults] = useState<StepResult[]>([]);

  useEffect(() => {
    get<Layouts>("/api/pools/layouts")
      .then((l) => {
        setLayouts(l);
        setLayout(l.options.find((o) => o.recommended)?.layout ?? "");
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  const chosen = layouts?.options.find((o) => o.layout === layout);
  const validPeople = people.filter((p) => p.username.trim() && p.password.length >= 8);
  const index = STEPS.findIndex((s) => s.id === step);

  async function run() {
    setStep("run");
    const plan: Array<{ label: string; go: (ctx: Record<string, unknown>) => Promise<string | void> }> = [];
    plan.push({
      label: `Create the pool ${poolName} (${layout})`,
      go: async () => {
        const { jobId } = await post<{ jobId: number }>("/api/pools", {
          name: poolName,
          layout,
          disks: layouts!.drives.map((d) => d.name),
        });
        // Building a pool takes a little while; wait for the NAS to say so.
        for (;;) {
          const j = await get<{ state: string; error: string | null }>(`/api/jobs/${jobId}`);
          if (j.state === "SUCCESS") return;
          if (j.state === "FAILED" || j.state === "ABORTED")
            throw new Error(j.error ?? "The NAS could not build the pool.");
          await new Promise((r) => setTimeout(r, 1500));
        }
      },
    });
    for (const f of folders) {
      plan.push({
        label: `Create the folder ${f}`,
        go: async () => {
          await post("/api/datasets", { name: `${poolName}/${f}`, type: "FILESYSTEM", compression: "LZ4" });
        },
      });
    }
    for (const p of validPeople) {
      plan.push({
        label: `Create the account ${p.username}`,
        go: async (ctx) => {
          const u = await post<{ id: number }>("/api/users", {
            username: p.username.trim(),
            fullName: p.username.trim(),
            password: p.password,
            smb: true,
          });
          (ctx.userIds as number[]).push(u.id);
        },
      });
    }
    for (const f of folders) {
      plan.push({
        label: `Share ${f} with everyone in the household`,
        go: async (ctx) => {
          const r = await post<{ startedService: boolean }>("/api/shares/smb", {
            name: f,
            path: `/mnt/${poolName}/${f}`,
            readOnly: false,
            access: (ctx.userIds as number[]).map((id) => ({ kind: "user", id, level: "write" })),
            recursive: true,
          });
          return r.startedService ? "and switched Windows file sharing on" : undefined;
        },
      });
    }
    if (snapshots) {
      for (const f of folders) {
        plan.push({
          label: `Take a snapshot of ${f} every night, kept two weeks`,
          go: async () => {
            await post("/api/snapshot-tasks", {
              dataset: `${poolName}/${f}`,
              recursive: true,
              lifetimeValue: 2,
              lifetimeUnit: "WEEK",
              schedule: { minute: "0", hour: "2" },
            });
          },
        });
      }
    }
    if (scrub)
      plan.push({
        label: `Scrub ${poolName} monthly`,
        go: async () => void (await post("/api/safety/scrubs", { pool: poolName })),
      });
    if (smart)
      plan.push({
        label: "Test every drive weekly",
        go: async () => void (await post("/api/safety/smart-tests", { type: "SHORT" })),
      });

    const state: StepResult[] = plan.map((p) => ({ label: p.label, state: "pending" }));
    setResults([...state]);
    const ctx: Record<string, unknown> = { userIds: [] };
    for (let i = 0; i < plan.length; i++) {
      state[i] = { ...state[i], state: "running" };
      setResults([...state]);
      try {
        const detail = await plan[i].go(ctx);
        state[i] = { ...state[i], state: "done", detail: detail ?? undefined };
      } catch (e) {
        state[i] = { ...state[i], state: "failed", detail: e instanceof Error ? e.message : String(e) };
        setResults([...state]);
        return;
      }
      setResults([...state]);
    }
  }

  const finished = results.length > 0 && results.every((r) => r.state === "done");
  const failed = results.find((r) => r.state === "failed");

  return (
    <Modal
      title="Set up this NAS"
      subtitle="A pool, some folders, the people, the shares, and the protection — then one button."
      onClose={onClose}
      wide
      footer={
        step === "run" ? (
          <button className="btn primary" onClick={finished ? onDone : onClose}>
            {finished ? "Open the console" : failed ? "Close" : "Working…"}
          </button>
        ) : (
          <>
            {index > 0 && (
              <button className="btn" style={{ marginRight: "auto" }} onClick={() => setStep(STEPS[index - 1].id)}>
                Back
              </button>
            )}
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            {step === "summary" ? (
              <button className="btn primary" onClick={() => void run()} disabled={!chosen || !folders.length}>
                Do it
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={(step === "pool" && (!chosen || !poolName.trim())) || (step === "folders" && !folders.length)}
                onClick={() => setStep(STEPS[index + 1].id)}
              >
                Next
              </button>
            )}
          </>
        )
      }
    >
      {step !== "run" && (
        <ol className="wizard-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={s.id === step ? "on" : i < index ? "done" : ""}>
              <span>{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>
      )}

      {step === "pool" && (
        <>
          {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
          {!layouts && !loadError && <Loading rows={3} />}
          {layouts && !layouts.drives.length && (
            <p className="modal-text">
              Every drive is already in a pool. This wizard is for a box with empty drives; the Pools tab can grow what
              exists.
            </p>
          )}
          {layouts && layouts.drives.length > 0 && (
            <>
              <p className="modal-text" style={{ marginTop: 0 }}>
                {layouts.drives.length} drive{layouts.drives.length === 1 ? "" : "s"} not in any pool:{" "}
                {layouts.drives.map((d) => `${d.name} (${bytes(d.size)})`).join(", ")}. All of them go into the pool.
              </p>
              <Field label="Pool name" hint="Short, lower-case. It becomes part of every folder's path.">
                <Input
                  value={poolName}
                  onChange={(e) => setPoolName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                />
              </Field>
              <div className="layout-options">
                {layouts.options.map((o) => (
                  <label key={o.layout} className={`layout-option ${layout === o.layout ? "on" : ""}`}>
                    <input
                      type="radio"
                      name="layout"
                      checked={layout === o.layout}
                      onChange={() => setLayout(o.layout)}
                    />
                    <div>
                      <div>
                        <strong>{o.layout.toLowerCase()}</strong>
                        {o.recommended && (
                          <span className="pill ok" style={{ marginLeft: 8 }}>
                            recommended
                          </span>
                        )}
                      </div>
                      <div className="modal-text" style={{ margin: "2px 0" }}>
                        {o.summary}
                      </div>
                      <div className="stat-foot">{o.note}</div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {step === "folders" && (
        <>
          <p className="modal-text" style={{ marginTop: 0 }}>
            Each becomes its own folder on the pool, with its own snapshots and its own share. Three is a good start.
          </p>
          <div style={{ display: "grid", gap: 6 }}>
            {[...new Set([...SUGGESTED, ...folders])].map((f) => (
              <Toggle
                key={f}
                checked={folders.includes(f)}
                onChange={(on) => setFolders((cur) => (on ? [...cur, f] : cur.filter((x) => x !== f)))}
                label={f}
              />
            ))}
          </div>
          <Field label="Another folder" hint="Letters, numbers, dashes.">
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                value={customFolder}
                onChange={(e) => setCustomFolder(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
                placeholder="Photos"
              />
              <button
                className="btn"
                style={{ flex: "none" }}
                disabled={!customFolder || folders.includes(customFolder)}
                onClick={() => {
                  setFolders((cur) => [...cur, customFolder]);
                  setCustomFolder("");
                }}
              >
                Add
              </button>
            </div>
          </Field>
        </>
      )}

      {step === "people" && (
        <>
          <p className="modal-text" style={{ marginTop: 0 }}>
            One account per person. Each signs in to the shared folders with these from a Windows or Mac machine.
            Passwords need at least 8 characters. Leave this empty to add people later.
          </p>
          {people.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <Input
                value={p.username}
                placeholder="anna"
                onChange={(e) =>
                  setPeople((cur) =>
                    cur.map((x, j) =>
                      j === i ? { ...x, username: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") } : x,
                    ),
                  )
                }
              />
              <Input
                type="password"
                value={p.password}
                placeholder="password"
                autoComplete="new-password"
                onChange={(e) =>
                  setPeople((cur) => cur.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)))
                }
              />
              <button
                className="btn"
                style={{ flex: "none" }}
                onClick={() => setPeople((cur) => cur.filter((_, j) => j !== i))}
                disabled={people.length === 1}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="btn" onClick={() => setPeople((cur) => [...cur, { username: "", password: "" }])}>
            Another person
          </button>
        </>
      )}

      {step === "protection" && (
        <div style={{ display: "grid", gap: 10 }}>
          <Toggle
            checked={snapshots}
            onChange={setSnapshots}
            label="Snapshot every folder nightly and keep two weeks, so a deleted file can come back"
          />
          <Toggle
            checked={scrub}
            onChange={setScrub}
            label={`Scrub ${poolName} once a month, so silent corruption is found and repaired`}
          />
          <Toggle
            checked={smart}
            onChange={setSmart}
            label="Run a short self-test on every drive weekly, so a failing drive is caught early"
          />
          <p className="stat-foot">
            Copies off the NAS are the one thing this cannot set up for you: they need an account somewhere else.
            Backups &amp; checks has the form.
          </p>
        </div>
      )}

      {step === "summary" && chosen && (
        <div className="kv">
          <div>
            <span>Pool</span>
            <b>
              {poolName}, {chosen.layout.toLowerCase()} of {layouts?.drives.length} drives, {bytes(chosen.usable)}
            </b>
          </div>
          <div>
            <span>Folders</span>
            <b>{folders.join(", ")}</b>
          </div>
          <div>
            <span>People</span>
            <b>{validPeople.length ? validPeople.map((p) => p.username).join(", ") : "none yet"}</b>
          </div>
          <div>
            <span>Shares</span>
            <b>
              {folders.length} folder{folders.length === 1 ? "" : "s"} to{" "}
              {validPeople.length ? "everyone above, read and write" : "nobody yet"}
            </b>
          </div>
          <div>
            <span>Protection</span>
            <b>
              {[snapshots && "nightly snapshots", scrub && "monthly scrub", smart && "weekly self-tests"]
                .filter(Boolean)
                .join(", ") || "none"}
            </b>
          </div>
        </div>
      )}

      {step === "run" && (
        <div className="notice-list">
          {results.map((r, i) => (
            <div key={i} className={`notice ${r.state === "failed" ? "bad" : ""}`}>
              <span>
                {r.state === "done" ? "✅" : r.state === "failed" ? "❌" : r.state === "running" ? "⏳" : "·"}
              </span>
              <div>
                <div>{r.label}</div>
                {r.detail && <div className="stat-foot">{r.detail}</div>}
              </div>
            </div>
          ))}
          {failed && (
            <p className="modal-text" style={{ color: "var(--warn)" }}>
              Stopped there. What was done before it is done and stays; fix the reason and finish the rest by hand from
              the pages, or run this again for what is left.
            </p>
          )}
          {finished && <p className="modal-text">All done. The Home page now has something to show.</p>}
        </div>
      )}
    </Modal>
  );
}
