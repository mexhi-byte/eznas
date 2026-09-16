import { describe, expect, it } from "vitest";

process.env.DATA_DIR = "/somewhere/else";
process.env.ACCOUNTS_FILE = "/explicit/accounts.json";
delete process.env.SETTINGS_FILE;

const { dataDir, dataFile } = await import("../server/paths.js");

describe("where state files live", () => {
  it("moves everything with DATA_DIR", () => {
    expect(dataDir()).toBe("/somewhere/else");
    expect(dataFile("SETTINGS_FILE", "settings.json")).toBe("/somewhere/else/settings.json");
  });

  it("lets a per-file variable win, because existing unit files set them", () =>
    expect(dataFile("ACCOUNTS_FILE", "accounts.json")).toBe("/explicit/accounts.json"));
});
