import { describe, expect, it } from "vitest";
import { orphanWarning, referencedBy } from "../server/orphans.js";

const shares = [
  { name: "Family", path: "/mnt/tank/family" },
  { name: "Media", path: "/mnt/tank/media" },
  { name: "Backups", path: "/mnt/tank/backups" },
];

const acls = new Map([
  [
    "/mnt/tank/family",
    {
      acl: [
        { tag: "GROUP", id: 3001 },
        { tag: "USER", id: 1000 },
      ],
    },
  ],
  ["/mnt/tank/media", { acl: [{ tag: "GROUP", id: 3002 }] }],
  // A user with the same number as the group is a different thing entirely.
  ["/mnt/tank/backups", { acl: [{ tag: "USER", id: 3001 }] }],
]);

describe("referencedBy", () => {
  it("finds the shares whose ACL names the group", () =>
    expect(referencedBy(3001, acls, shares)).toEqual([{ name: "Family", path: "/mnt/tank/family" }]));

  it("does not confuse a user id with a group id", () =>
    expect(referencedBy(3001, acls, shares).map((s) => s.name)).not.toContain("Backups"));

  it("is empty for a group no folder grants anything to", () => expect(referencedBy(9999, acls, shares)).toEqual([]));

  it("skips a share whose ACL could not be read rather than guessing", () =>
    expect(referencedBy(3001, new Map(), shares)).toEqual([]));

  it("reports a path once even if two shares point at it", () => {
    const twice = [...shares, { name: "Family again", path: "/mnt/tank/family" }];
    expect(referencedBy(3001, acls, twice)).toHaveLength(1);
  });
});

describe("orphanWarning", () => {
  it("is null when nothing is affected, so the dialog can stay short", () =>
    expect(orphanWarning("family", [])).toBeNull());

  it("names the folders and says what goes wrong", () => {
    const w = orphanWarning("family", shares.slice(0, 2));
    expect(w).toContain("2 shared folders");
    expect(w).toContain("Family, Media");
    expect(w).toMatch(/numeric id/);
  });

  it("gets the grammar right for one folder", () =>
    expect(orphanWarning("family", shares.slice(0, 1))).toContain("1 shared folder:"));
});
