import type { TrueNas } from "../truenas.js";
import { bodyOf, confirmed, json, str } from "../http.js";
import { diskVerdict, failedTestCount, temperatureOf, testsForDisk } from "../disk-verdict.js";
import { poolIdOf, vdevMemberOf, type DiskRow, type PoolRow, type VdevLeaf } from "../nas-shapes.js";
import type { NasRouteContext } from "./context.js";

/**
 * Drives: the map's tiles with a verdict each, one drive's health in full,
 * self-tests, wiping, and the guided replacement of a failed member.
 */

export async function handleDiskRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, req, res, nas } = ctx;

  /* --- disks --- */
  if (path === "/api/disks") {
    /*
     * Four bulk calls, and a verdict for every drive.
     *
     * The map used to get names and a temperature, so its tiles could only
     * show a number or a status word — and nothing at all for a drive that had
     * neither. Every input the verdict needs is already a single call covering
     * every device, so asking for all of them costs the same whether the NAS
     * has four drives or forty.
     */
    const [details, temps, pools, testResults] = await Promise.all([
      nas.call<{ used: DiskRow[]; unused: DiskRow[] }>("disk.details"),
      readTemperatures(nas),
      nas.call<PoolRow[]>("pool.query").catch(() => [] as PoolRow[]),
      nas.call<Array<Record<string, unknown>>>("smart.test.results").catch(() => [] as Array<Record<string, unknown>>),
    ]);
    // imported_zpool is where the pool name actually lives. disk.query's own
    // `pool` field reads null for every disk on 25.04, which made every disk in
    // a healthy pool render as "unassigned".
    const shape = (d: DiskRow, inUse: boolean) => {
      const member = vdevMemberOf(pools, d.name);
      const stats = member?.stats ?? {};
      const tempC = temperatureOf(temps.values[d.name]);
      const verdict = diskVerdict({
        zfs: member
          ? {
              pool: member.pool,
              status: member.status ?? null,
              readErrors: stats.read_errors ?? 0,
              writeErrors: stats.write_errors ?? 0,
              checksumErrors: stats.checksum_errors ?? 0,
              selfHealed: stats.self_healed ?? 0,
            }
          : null,
        tempC,
        failedTests: failedTestCount(testsForDisk(testResults, d.name)),
      });
      return {
        name: d.name,
        model: d.model,
        serial: d.serial,
        size: d.size,
        type: d.type,
        rpm: d.rotationrate,
        pool: d.imported_zpool ?? d.pool ?? null,
        inUse,
        tempC,
        // Why there is no reading, so the tile can say it instead of going
        // blank. A blank space reads as a bug in the console; "this device
        // does not report one" reads as a fact about the drive.
        tempNote: tempC !== null ? null : temps.note,
        status: member?.status ?? null,
        health: verdict,
      };
    };
    json(res, 200, [
      ...(details.used ?? []).map((d) => shape(d, true)),
      ...(details.unused ?? []).map((d) => shape(d, false)),
    ]);
    return true;
  }

  if (path === "/api/disks/rescan" && method === "POST") {
    // retaste makes the NAS re-read every disk's label, which is how a drive
    // hot-plugged after boot becomes visible without a reboot.
    await nas.call("disk.retaste", [[]]).catch(() => nas.call("disk.retaste"));
    const details = await nas.call<{ unused: DiskRow[] }>("disk.details");
    json(res, 200, {
      unused: (details.unused ?? []).map((d) => ({ name: d.name, model: d.model, size: d.size, serial: d.serial })),
    });
    return true;
  }

  const diskWipe = /^\/api\/disks\/([^/]+)\/wipe$/.exec(path);
  if (diskWipe && method === "POST") {
    const name = diskWipe[1];
    const b = await bodyOf(req);
    confirmed(b, name);
    json(res, 200, { jobId: await nas.startJob("disk.wipe", [name, String(b.mode ?? "QUICK")]) });
    return true;
  }

  /**
   * Replacing a failed drive, guided.
   *
   * In the NAS's own interface this is ten steps across four screens, and the
   * one that goes wrong is picking the disk: the failed member is identified
   * by a ZFS guid, the replacement by a device name, and the two look nothing
   * alike. Getting it wrong offlines a healthy drive in an already-degraded
   * pool, which is how a recoverable failure becomes a lost pool.
   *
   * So the console does the identification. It reports the physical serial to
   * look for, offlines by guid, and afterwards replaces using the guid it
   * already knows — never a name the operator had to retype.
   */
  const replaceMatch = /^\/api\/pools\/([^/]+)\/replace\/(identify|offline|scan|replace)$/.exec(path);
  if (replaceMatch) {
    const [, poolName, step] = replaceMatch;
    const poolId = await poolIdOf(nas, poolName);
    const b = method === "POST" ? await bodyOf(req) : {};

    if (step === "identify" && method === "GET") {
      const [pool] = await nas.call<PoolRow[]>("pool.query", [[["name", "=", poolName]]]);
      if (!pool) throw new Error(`There is no pool called "${poolName}".`);
      const [details, disks] = await Promise.all([
        nas.call<{ used?: Array<Record<string, unknown>>; unused?: Array<Record<string, unknown>> }>("disk.details"),
        nas.call<Array<Record<string, unknown>>>("disk.query"),
      ]);
      const byName = new Map(disks.map((d) => [String(d.name), d]));

      // Every member that is not ONLINE, with whatever the NAS still knows
      // about the physical device behind it.
      const faulted: Array<Record<string, unknown>> = [];
      for (const [role, vdevs] of Object.entries((pool.topology ?? {}) as Record<string, VdevLeaf[]>)) {
        for (const vdev of vdevs ?? []) {
          const walk = (node: VdevLeaf & { guid?: string; name?: string }) => {
            const kids = node.children ?? [];
            if (!kids.length) {
              const dev = node.disk ?? node.device ?? null;
              if (node.status && node.status !== "ONLINE") {
                const d = dev ? byName.get(dev) : undefined;
                faulted.push({
                  guid: node.guid ?? node.name ?? null,
                  device: dev,
                  status: node.status,
                  role,
                  vdev: vdev.type,
                  model: d?.model ?? null,
                  serial: d?.serial ?? null,
                  size: d?.size ?? null,
                });
              }
            }
            for (const c of kids) walk(c as never);
          };
          walk(vdev as never);
        }
      }

      json(res, 200, {
        pool: poolName,
        status: pool.status,
        faulted,
        spare: (details.unused ?? []).map((d) => ({
          name: d.name,
          model: d.model,
          serial: d.serial,
          size: d.size,
          type: d.type,
        })),
      });
      return true;
    }

    if (step === "offline" && method === "POST") {
      const label = str(b, "label");
      confirmed(b, label);
      await nas.call("pool.offline", [poolId, { label }]);
      json(res, 200, { ok: true });
      return true;
    }

    if (step === "scan" && method === "POST") {
      // retaste makes the NAS re-read every disk's label, which is how a drive
      // plugged in after boot becomes visible without a reboot.
      await nas.call("disk.retaste", [[]]).catch(() => nas.call("disk.retaste"));
      const details = await nas.call<{ unused?: Array<Record<string, unknown>> }>("disk.details");
      json(res, 200, {
        spare: (details.unused ?? []).map((d) => ({
          name: d.name,
          model: d.model,
          serial: d.serial,
          size: d.size,
          type: d.type,
        })),
      });
      return true;
    }

    if (step === "replace" && method === "POST") {
      const label = str(b, "label");
      const disk = str(b, "disk");
      confirmed(b, disk);
      json(res, 200, {
        jobId: await nas.startJob("pool.replace", [
          poolId,
          {
            label,
            disk,
            force: b.force === true,
            preserve_settings: true,
          },
        ]),
      });
      return true;
    }
  }

  const diskHealth = /^\/api\/disks\/([^/]+)\/health$/.exec(path);
  if (diskHealth && method === "GET") {
    json(res, 200, await diskHealthOf(nas, diskHealth[1]));
    return true;
  }

  const diskTest = /^\/api\/disks\/([^/]+)\/smart-test$/.exec(path);
  if (diskTest && method === "POST") {
    const name = diskTest[1];
    const b = await bodyOf(req);
    const kind = String(b.type ?? "SHORT").toUpperCase();
    if (!["SHORT", "LONG", "CONVEYANCE", "OFFLINE"].includes(kind)) throw new Error(`Unknown test type "${kind}".`);
    // manual_test is addressed by the disk's stable identifier, not its device
    // name: sdb can become sdc across a reboot, and starting a long test on the
    // wrong drive is a real cost in a pool that is already degraded.
    const identifier = await identifierOf(nas, name);
    const out = await nas.call<Array<Record<string, unknown>>>("smart.test.manual_test", [
      [{ identifier, mode: "BACKGROUND", type: kind }],
    ]);
    const first = out?.[0] ?? {};
    if (first.error) throw new Error(readableSmartError(String(first.error), name));
    json(res, 200, { ok: true, expectedAt: (first.expected_result_time as { $date?: number })?.$date ?? null });
    return true;
  }

  return false;
}

/**
 * What smartctl said, in a sentence.
 *
 * The NAS hands back the tool's whole banner — version, copyright, build
 * string — with the actual reason on the last line. Showing that in a dialog
 * buries the one line that matters under four that never do.
 */
function readableSmartError(raw: string, disk: string): string {
  const last =
    raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? raw;
  if (/unsupported scsi opcode|not supported|unsupported/i.test(last)) {
    return `${disk} does not support self-tests. Virtual disks and some USB enclosures pass the drive through without SMART, so there is nothing to run — the health above is based on what ZFS has seen instead.`;
  }
  if (/device is busy|already running/i.test(last)) return `A test is already running on ${disk}.`;
  return last;
}

/** smart.test.manual_test addresses disks by identifier ("{serial}9KG1859L"). */
async function identifierOf(nas: TrueNas, name: string): Promise<string> {
  const rows = await nas.call<Array<{ identifier: string }>>("disk.query", [[["name", "=", name]]]);
  if (!rows.length || !rows[0].identifier) throw new Error(`There is no disk called "${name}".`);
  return rows[0].identifier;
}

/**
 * Everything the NAS knows about one drive, gathered for the health dialog.
 *
 * The interesting parts come from four places that do not agree with each
 * other: disk.query has the identity, disk.details has the partitions and the
 * pool it is actually imported into, pool.query's topology has the ZFS error
 * counters, and smart.* has the tests. SMART is the one that most often is not
 * there at all — on a VM every disk answers "Only ATA/SCSI/NVMe devices support
 * S.M.A.R.T. attributes" — so it is fetched last and its absence is reported as
 * a fact about the device rather than as a failure of the page.
 */
async function diskHealthOf(nas: TrueNas, name: string) {
  const [rows, details, temps, pools] = await Promise.all([
    nas.call<Array<Record<string, unknown>>>("disk.query", [[["name", "=", name]]]),
    nas.call<{ used?: Array<Record<string, unknown>>; unused?: Array<Record<string, unknown>> }>("disk.details"),
    readTemperatures(nas),
    nas.call<PoolRow[]>("pool.query"),
  ]);
  const disk = rows[0];
  if (!disk) throw new Error(`There is no disk called "${name}".`);
  const detail =
    (details.used ?? []).find((d) => d.name === name) ?? (details.unused ?? []).find((d) => d.name === name) ?? {};
  const inUse = (details.used ?? []).some((d) => d.name === name);

  const member = vdevMemberOf(pools, name);

  const smart = await nas
    .call<Array<Record<string, unknown>>>("disk.smart_attributes", [name])
    .then((attrs) => ({ supported: true, reason: null as string | null, attributes: attrs }))
    .catch((e: unknown) => ({
      supported: false,
      reason: e instanceof Error ? e.message.replace(/^\[EFAULT\]\s*/, "") : "SMART data is unavailable.",
      attributes: [] as Array<Record<string, unknown>>,
    }));

  const results = await nas
    .call<Array<Record<string, unknown>>>("smart.test.results")
    .then((all) => all.find((r) => r.disk === name || r.name === name) ?? null)
    .catch(() => null);
  const tests = ((results?.tests as Array<Record<string, unknown>>) ?? []).slice(0, 12);

  const stats = member?.stats ?? {};
  const tempC = temperatureOf(temps.values[name]);

  // The same verdict the drive map shows, from the same function, so a drive
  // cannot be amber on the map and green in its own dialog.
  const { level, reasons } = diskVerdict({
    zfs: member
      ? {
          pool: member.pool,
          status: member.status ?? null,
          readErrors: stats.read_errors ?? 0,
          writeErrors: stats.write_errors ?? 0,
          checksumErrors: stats.checksum_errors ?? 0,
          selfHealed: stats.self_healed ?? 0,
        }
      : null,
    tempC,
    failedTests: failedTestCount(tests),
  });
  // SMART support is a fact about the device rather than a judgement on it, so
  // it is appended to the reasons without moving the verdict.
  if (!smart.supported) reasons.push(smart.reason ?? "This device does not report SMART data.");

  return {
    name,
    identity: {
      identifier: disk.identifier,
      model: disk.model,
      serial: disk.serial,
      size: disk.size,
      type: disk.type,
      rpm: disk.rotationrate,
      bus: disk.bus,
      subsystem: disk.subsystem,
      description: disk.description || detail.descr || null,
      lunid: disk.lunid,
      sectorSize: detail.sectorsize ?? null,
      transferMode: disk.transfermode,
      standby: disk.hddstandby,
      powerManagement: disk.advpowermgmt,
      smartEnabled: disk.togglesmart === true,
      duplicateSerial: (detail.duplicate_serial as string[] | undefined) ?? [],
    },
    tempC,
    tempNote: tempC !== null ? null : temps.note,
    inUse,
    pool: (detail.imported_zpool as string | null) ?? member?.pool ?? null,
    exportedPool: (detail.exported_zpool as string | null) ?? null,
    partitions: ((detail.partitions as Array<Record<string, unknown>>) ?? []).map((p) => ({
      name: p.name ?? p.partition_name,
      size: p.size,
      type: p.partition_type ?? p.type,
    })),
    zfs: member
      ? {
          pool: member.pool,
          role: member.role,
          vdev: member.vdev,
          status: member.status ?? null,
          readErrors: stats.read_errors ?? 0,
          writeErrors: stats.write_errors ?? 0,
          checksumErrors: stats.checksum_errors ?? 0,
          selfHealed: stats.self_healed ?? 0,
          size: stats.size ?? null,
          allocated: stats.allocated ?? null,
          fragmentation: stats.fragmentation ?? null,
          // ops/bytes are [null, read, write, ...] counters since import.
          readBytes: stats.bytes?.[1] ?? null,
          writeBytes: stats.bytes?.[2] ?? null,
        }
      : null,
    smart: { supported: smart.supported, reason: smart.reason, attributes: smart.attributes },
    tests: tests.map((t) => ({
      num: t.num,
      type: t.type,
      status: t.status_verbose ?? t.status,
      remaining: t.remaining,
      lifetime: t.lifetime,
      description: t.description,
    })),
    runningTest: results?.current_test ?? null,
    health: { level, reasons },
  };
}

/**
 * Every drive's temperature, and why there is none when there is none.
 *
 * This call used to be wrapped in a bare `.catch(() => ({}))`, which collapsed
 * two different situations into one blank space: a drive with no sensor, and a
 * call that failed outright. Only one of those is worth investigating, and the
 * console gave no way to tell which had happened.
 */
async function readTemperatures(nas: TrueNas): Promise<{
  values: Record<string, number | null>;
  note: string;
}> {
  try {
    const values = await nas.call<Record<string, number | null>>("disk.temperatures");
    return {
      values,
      note: "This device does not report a temperature. Virtual disks, and drives behind a RAID controller that is not in passthrough mode, usually cannot.",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[disks] could not read temperatures: ${message}`);
    return { values: {}, note: `The NAS could not report temperatures: ${message}` };
  }
}
