/**
 * One verdict for a drive, and the reasons behind it.
 *
 * This used to live inside the health dialog's route, which meant the drive map
 * had no verdict at all — its tiles showed a temperature or a ZFS status word,
 * and nothing when it had neither. Two places deciding separately whether a
 * drive is healthy is two places to disagree, so the decision lives here and
 * both of them read it.
 *
 * Everything it needs arrives in bulk: pool.query carries the ZFS status and
 * error counters for every device, smart.test.results carries every test, and
 * disk.temperatures carries every reading. So a verdict for one drive and a
 * verdict for forty cost the same three calls.
 */

export type HealthLevel = "ok" | "warn" | "bad";

/** What ZFS knows about a device, or null for one it is not watching. */
export interface ZfsFacts {
  pool: string;
  status: string | null;
  readErrors: number;
  writeErrors: number;
  checksumErrors: number;
  selfHealed: number;
}

export interface VerdictInput {
  zfs: ZfsFacts | null;
  /** null when the device reports no usable reading — see temperatureOf. */
  tempC: number | null;
  failedTests: number;
}

export interface Verdict {
  level: HealthLevel;
  reasons: string[];
}

/** Warm enough to mention. */
export const TEMP_WARN_C = 42;
/** Hot enough to be the headline. */
export const TEMP_BAD_C = 50;

/**
 * A drive that cannot answer reports 0, not null.
 *
 * Every virtual disk comes back as exactly 0°C, which the UI drew as a healthy
 * green zero. Nothing spinning is at freezing point, so treat it as "no
 * reading" rather than as a very cold drive. A genuine sub-zero reading is left
 * alone: cold storage exists, and 0 is the sentinel, not the range.
 */
export function temperatureOf(v: number | null | undefined): number | null {
  return v === null || v === undefined || v === 0 ? null : v;
}

/**
 * The self-tests belonging to one drive.
 *
 * smart.test.results is one row per device, and which field carries the device
 * name depends on the TrueNAS version — `disk` on some, `name` on others. A
 * lookup that checks only one of them silently reports "no failed tests" for
 * every drive, which reads as a clean bill of health.
 */
export function testsForDisk(
  results: Array<Record<string, unknown>>,
  name: string,
): Array<Record<string, unknown>> {
  const row = results.find((r) => r.disk === name || r.name === name);
  return ((row?.tests as Array<Record<string, unknown>>) ?? []).slice(0, 12);
}

/** Self-tests that did not finish cleanly. */
export function failedTestCount(tests: Array<Record<string, unknown>>): number {
  return tests.filter(
    (t) => !/without error|completed/i.test(String(t.status_verbose ?? t.status ?? "")),
  ).length;
}

const bytesish = (n: number | undefined): string => {
  if (!n) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

/**
 * The verdict, leading with an answer rather than a wall of counters the
 * reader has to grade themselves.
 */
export function diskVerdict(input: VerdictInput): Verdict {
  const { zfs, tempC, failedTests } = input;
  const reasons: string[] = [];
  let level: HealthLevel = "ok";
  const worse = (l: "warn" | "bad") => {
    if (l === "bad" || level === "ok") level = l;
  };

  if (zfs && zfs.status && zfs.status !== "ONLINE") {
    worse("bad");
    reasons.push(`ZFS reports this device as ${zfs.status} in ${zfs.pool}.`);
  }

  const errors = zfs ? zfs.readErrors + zfs.writeErrors + zfs.checksumErrors : 0;
  if (errors > 0 && zfs) {
    worse("bad");
    reasons.push(
      `${errors} ZFS error${errors === 1 ? "" : "s"}: ${zfs.readErrors} read, ${zfs.writeErrors} write, ${zfs.checksumErrors} checksum.`,
    );
  }

  if (failedTests > 0) {
    worse("bad");
    reasons.push(`${failedTests} SMART self-test${failedTests === 1 ? "" : "s"} did not finish cleanly.`);
  }

  // No reading says nothing either way. It must not read as a cold, healthy
  // drive, and it must not invent a problem that nobody reported.
  if (tempC !== null && tempC >= TEMP_BAD_C) {
    worse("bad");
    reasons.push(`Running at ${tempC}°C.`);
  } else if (tempC !== null && tempC >= TEMP_WARN_C) {
    worse("warn");
    reasons.push(`Running warm at ${tempC}°C.`);
  }

  if (zfs && zfs.selfHealed > 0) {
    worse("warn");
    reasons.push(`ZFS repaired ${bytesish(zfs.selfHealed)} of bad data on this device.`);
  }

  if (level === "ok") {
    reasons.unshift(
      zfs
        ? "ZFS reports no read, write or checksum errors on this device."
        : "Nothing is reporting a problem with this device.",
    );
  }

  return { level, reasons };
}
