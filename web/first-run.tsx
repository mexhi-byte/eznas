import { useEffect, useState } from "react";
import { get, post, setConnection } from "./api";
import { Toggle } from "./ui";
import { describeCertificate, prettyFingerprint, type SeenCertificate } from "./certificate";

/**
 * From a console with no server to a console showing one, in five screens.
 *
 * Before this, a first sign-in landed on a dashboard with nothing in it and a
 * sentence about Settings → Servers. The person then had to know that an API
 * key existed, where TrueNAS keeps them, what a certificate fingerprint was,
 * and why the console wanted their password as well. This asks those things
 * one at a time, in order, with the answer that is usually right already
 * filled in: the address of the NAS the console is running on, the
 * certificate it presents, the hostname it reports.
 *
 * Nothing is saved until the last screen. Every earlier step only looks.
 */

type Step = "where" | "trust" | "key" | "files" | "done";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "where", label: "Where" },
  { id: "trust", label: "Certificate" },
  { id: "key", label: "API key" },
  { id: "files", label: "Files" },
  { id: "done", label: "Done" },
];

interface Candidate {
  host: string;
  certificate: SeenCertificate | null;
}

interface TestResult {
  ok: boolean;
  error?: string;
  version?: string;
  hostname?: string;
  certificate: SeenCertificate | null;
}

/** Just the host part of whatever was typed: "https://nas.local/" → "nas.local". */
const hostOnly = (s: string) =>
  s
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "");

export function FirstRunSetup({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [step, setStep] = useState<Step>("where");
  const [host, setHost] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [cert, setCert] = useState<SeenCertificate | null>(null);
  const [certError, setCertError] = useState<string | null>(null);
  const [pin, setPin] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [tested, setTested] = useState<TestResult | null>(null);
  const [name, setName] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A guess at the address, made once. Wrong guesses cost a glance.
  useEffect(() => {
    get<{ candidates: Candidate[] }>("/api/setup/discover")
      .then((r) => setCandidates(r.candidates.filter((c) => c.certificate)))
      .catch(() => setCandidates([]));
  }, []);

  async function look(): Promise<SeenCertificate | null> {
    setBusy(true);
    setCertError(null);
    try {
      const seen = await post<SeenCertificate>("/api/connections/certificate", { url: host });
      setCert(seen);
      return seen;
    } catch (e) {
      setCert(null);
      setCertError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setTested(null);
    try {
      const r = await post<TestResult>("/api/connections/test", {
        url: host,
        apiKey,
        fingerprint: pin && cert ? cert.fingerprint : null,
      });
      setTested(r);
      if (r.ok && r.hostname && !name) setName(r.hostname);
    } catch (e) {
      setTested({ ok: false, error: e instanceof Error ? e.message : String(e), certificate: null });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const conn = await post<{ id: string }>("/api/connections", {
        name: name || hostOnly(host),
        url: host,
        apiKey,
        fingerprint: pin && cert ? cert.fingerprint : null,
        sudoPassword: sudoPassword || undefined,
      });
      setConnection(conn.id);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const keyPage = host ? `https://${hostOnly(host)}/ui/credentials/users/api-keys` : null;
  const index = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="login-wrap">
      <div className="login-card wide setup">
        <ol className="wizard-steps" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={s.id === step ? "on" : i < index ? "done" : ""} aria-current={s.id === step}>
              <span>{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>

        {step === "where" && (
          <>
            <h1>Where is your TrueNAS?</h1>
            <p>An address is enough. https:// and the API path are added for you.</p>
            {candidates?.length ? (
              <div className="setup-hint">
                This console seems to be running on a NAS. A certificate
                {candidates[0].certificate?.subject ? ` for ${candidates[0].certificate.subject}` : ""} answered at{" "}
                <span className="mono">{candidates[0].host}</span>.
                <div>
                  <button type="button" className="btn small" onClick={() => setHost(candidates[0].host)}>
                    Use {candidates[0].host}
                  </button>
                </div>
              </div>
            ) : null}
            <label>
              Address
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && host.trim()) void look().then(() => setStep("trust"));
                }}
              />
            </label>
            <div className="actions">
              <button type="button" className="btn aside" onClick={onSkip}>
                Skip setup for now
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!host.trim() || busy}
                onClick={() => void look().then(() => setStep("trust"))}
              >
                {busy ? "Looking…" : "Next"}
              </button>
            </div>
          </>
        )}

        {step === "trust" && (
          <>
            <h1>Trust its certificate</h1>
            {cert ? (
              <>
                <p>{describeCertificate(cert)}</p>
                <div className="mono cert-fp">{prettyFingerprint(cert.fingerprint)}</div>
                <p>
                  TrueNAS makes its own certificate, so no authority vouches for it. Remembering this one is how the
                  console knows it is talking to the same machine next time — and how it can refuse to send your API key
                  to a different one. Compare the fingerprint with System → Certificates on the NAS if you want to be
                  sure.
                </p>
                <Toggle checked={pin} onChange={setPin} label="Remember this certificate and refuse any other" />
              </>
            ) : (
              <>
                <p className="login-error">{certError ?? "No certificate could be read at that address."}</p>
                <p>
                  Check the address, and that the NAS's web interface answers on HTTPS. You can also continue without
                  pinning, and pin later from Settings → Servers.
                </p>
              </>
            )}
            <div className="actions">
              <button type="button" className="btn aside" onClick={() => setStep("where")}>
                Back
              </button>
              <button type="button" className="btn" onClick={() => void look()} disabled={busy}>
                {busy ? "Looking…" : "Look again"}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  if (!cert) setPin(false);
                  setStep("key");
                }}
              >
                {cert ? "Next" : "Continue without pinning"}
              </button>
            </div>
          </>
        )}

        {step === "key" && (
          <>
            <h1>An API key</h1>
            <p>
              The console acts on the NAS with a key made for it. On the NAS, open <strong>Credentials → Users</strong>,
              choose the user this console should act as, and add an API key. It inherits that user's permissions, so an
              administrator's key can do anything the NAS can.
            </p>
            {keyPage && (
              <p>
                <a className="btn" href={keyPage} target="_blank" rel="noreferrer">
                  Open the API keys page on the NAS ↗
                </a>
              </p>
            )}
            <label>
              API key
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTested(null);
                }}
                placeholder="1-…"
                autoComplete="off"
                autoFocus
              />
            </label>
            {tested && (
              <p className={tested.ok ? "setup-ok" : "login-error"}>
                {tested.ok ? `Reached ${tested.hostname} running TrueNAS ${tested.version}.` : tested.error}
              </p>
            )}
            <p>The key is stored encrypted on this console and is never sent back to a browser.</p>
            <div className="actions">
              <button type="button" className="btn aside" onClick={() => setStep("trust")}>
                Back
              </button>
              <button type="button" className="btn" onClick={() => void test()} disabled={!apiKey.trim() || busy}>
                {busy ? "Testing…" : "Test"}
              </button>
              <button type="button" className="btn primary" disabled={!tested?.ok} onClick={() => setStep("files")}>
                Next
              </button>
            </div>
          </>
        )}

        {step === "files" && (
          <>
            <h1>Moving and deleting files</h1>
            <p>
              TrueNAS has no API for moving, renaming or deleting a file, so the console runs those as commands on the
              NAS, and that needs the password of the account the API key belongs to. Without it, the file browser can
              still show, upload, download and search — it just cannot rearrange anything.
            </p>
            <label>
              Account password (optional)
              <input
                type="password"
                value={sudoPassword}
                onChange={(e) => setSudoPassword(e.target.value)}
                placeholder="leave empty to decide later"
                autoComplete="off"
                autoFocus
              />
            </label>
            <p>
              Stored encrypted, like the key, and never shown again. It can be added or removed later under Settings →
              Servers.
            </p>
            <div className="actions">
              <button type="button" className="btn aside" onClick={() => setStep("key")}>
                Back
              </button>
              <button type="button" className="btn primary" onClick={() => setStep("done")}>
                {sudoPassword ? "Next" : "Skip for now"}
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h1>Ready</h1>
            <div className="kv">
              <div>
                <span>Server</span>
                <b>{tested?.hostname ?? hostOnly(host)}</b>
              </div>
              <div>
                <span>Address</span>
                <b className="mono">{hostOnly(host)}</b>
              </div>
              <div>
                <span>Certificate</span>
                <b>{pin && cert ? "pinned" : "not pinned"}</b>
              </div>
              <div>
                <span>File operations</span>
                <b>{sudoPassword ? "enabled" : "read-only until a password is added"}</b>
              </div>
            </div>
            <label>
              What to call it here
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tested?.hostname ?? "Main NAS"}
              />
            </label>
            {error && <p className="login-error">{error}</p>}
            <div className="actions">
              <button type="button" className="btn aside" onClick={() => setStep("files")} disabled={busy}>
                Back
              </button>
              <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Open the console"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
