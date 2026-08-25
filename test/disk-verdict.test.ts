import { describe, expect, it } from "vitest";
import { diskVerdict, failedTestCount, temperatureOf, testsForDisk, type VerdictInput } from "../server/disk-verdict.js";

const healthy: VerdictInput = {
  zfs: { pool: "tank", status: "ONLINE", readErrors: 0, writeErrors: 0, checksumErrors: 0, selfHealed: 0 },
  tempC: 31,
  failedTests: 0,
};

describe("temperatureOf", () => {
  // A drive that cannot answer reports 0, not null. Every virtual disk does
  // this, and drawing it as a healthy green 0°C is how the reading got
  // distrusted in the first place.
  it("treats 0 as no reading rather than as a very cold drive", () =>
    expect(temperatureOf(0)).toBeNull());
  it("treats null as no reading", () => expect(temperatureOf(null)).toBeNull());
  it("treats a missing entry as no reading", () => expect(temperatureOf(undefined)).toBeNull());
  it("keeps a real reading", () => expect(temperatureOf(38)).toBe(38));
  it("keeps a below-zero reading, which is a real reading", () => expect(temperatureOf(-4)).toBe(-4));
});

describe("failedTestCount", () => {
  it("counts nothing when every test completed without error", () =>
    expect(failedTestCount([{ status: "SUCCESS", status_verbose: "Completed without error" }])).toBe(0));
  it("counts a test that did not finish cleanly", () =>
    expect(failedTestCount([{ status_verbose: "Read failure" }])).toBe(1));
  it("prefers the verbose status when both are present", () =>
    expect(failedTestCount([{ status: "Read failure", status_verbose: "Completed without error" }])).toBe(0));
  it("counts nothing for an empty list", () => expect(failedTestCount([])).toBe(0));
});

describe("diskVerdict", () => {
  it("calls a clean drive ok and says why", () => {
    const v = diskVerdict(healthy);
    expect(v.level).toBe("ok");
    expect(v.reasons[0]).toMatch(/no read, write or checksum errors/i);
  });

  it("says something different for a drive in no pool", () => {
    const v = diskVerdict({ ...healthy, zfs: null });
    expect(v.level).toBe("ok");
    // "ZFS reports no errors" would be a lie about a drive ZFS is not watching.
    expect(v.reasons[0]).toMatch(/nothing is reporting a problem/i);
  });

  it("is bad when ZFS reports the device as anything but online", () => {
    const v = diskVerdict({ ...healthy, zfs: { ...healthy.zfs!, status: "FAULTED" } });
    expect(v.level).toBe("bad");
    expect(v.reasons.join(" ")).toMatch(/FAULTED.*tank/);
  });

  it("is bad on any ZFS error, and counts all three kinds", () => {
    const v = diskVerdict({
      ...healthy,
      zfs: { ...healthy.zfs!, readErrors: 1, writeErrors: 2, checksumErrors: 3 },
    });
    expect(v.level).toBe("bad");
    expect(v.reasons.join(" ")).toMatch(/6 ZFS errors: 1 read, 2 write, 3 checksum/);
  });

  it("is bad when a self-test did not finish cleanly", () => {
    expect(diskVerdict({ ...healthy, failedTests: 2 }).level).toBe("bad");
  });

  it("warns when running warm and fails when running hot", () => {
    expect(diskVerdict({ ...healthy, tempC: 41 }).level).toBe("ok");
    expect(diskVerdict({ ...healthy, tempC: 42 }).level).toBe("warn");
    expect(diskVerdict({ ...healthy, tempC: 49 }).level).toBe("warn");
    expect(diskVerdict({ ...healthy, tempC: 50 }).level).toBe("bad");
  });

  it("says nothing about temperature when there is no reading", () => {
    // The whole point of the virtualized case: no reading must not read as
    // a cold, healthy drive, and must not invent a problem either.
    const v = diskVerdict({ ...healthy, tempC: null });
    expect(v.level).toBe("ok");
    expect(v.reasons.join(" ")).not.toMatch(/°C/);
  });

  it("warns when ZFS has repaired bad data, in units a person reads", () => {
    const v = diskVerdict({ ...healthy, zfs: { ...healthy.zfs!, selfHealed: 1536 } });
    expect(v.level).toBe("warn");
    expect(v.reasons.join(" ")).toMatch(/1\.5 KiB/);
  });

  it("never lets a warning downgrade a failure", () => {
    const v = diskVerdict({
      ...healthy,
      tempC: 43, // warn
      zfs: { ...healthy.zfs!, status: "FAULTED", selfHealed: 4096 }, // bad
    });
    expect(v.level).toBe("bad");
  });

  it("gives no all-clear line once there is something to report", () => {
    const v = diskVerdict({ ...healthy, failedTests: 1 });
    expect(v.reasons.join(" ")).not.toMatch(/no read, write or checksum/i);
  });
});

describe("testsForDisk", () => {
  const rows = [
    { disk: "sda", tests: [{ status_verbose: "Completed without error" }] },
    { name: "sdb", tests: [{ status_verbose: "Read failure" }] },
  ];

  it("finds a row keyed by disk", () => expect(testsForDisk(rows, "sda")).toHaveLength(1));

  // Which field carries the name depends on the TrueNAS version. Checking only
  // one of them reports "no failed tests" for every drive on the other version,
  // which reads as a clean bill of health rather than as a lookup that missed.
  it("finds a row keyed by name instead", () =>
    expect(failedTestCount(testsForDisk(rows, "sdb"))).toBe(1));

  it("returns nothing for a drive with no row, rather than throwing", () =>
    expect(testsForDisk(rows, "sdz")).toEqual([]));

  it("returns nothing for a row that has no tests", () =>
    expect(testsForDisk([{ disk: "sdc" }], "sdc")).toEqual([]));

  it("caps a very long history so one drive cannot dominate the verdict", () =>
    expect(testsForDisk([{ disk: "sdc", tests: Array.from({ length: 40 }, () => ({})) }], "sdc")).toHaveLength(12));
});
