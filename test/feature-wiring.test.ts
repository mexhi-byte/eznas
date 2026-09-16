import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every shipped feature has a way in.
 *
 * 0.5.0 shipped uploads, search and NFS exports. All three had a server route,
 * a tested client helper, and a green suite — and none of them had a single
 * caller in any component, so from the browser they did not exist. Every test
 * covered a seam; none asked whether a person could reach the thing.
 *
 * This is deliberately crude. It reads the source and checks that the entry
 * point is mentioned somewhere a user could click. That is enough to catch a
 * feature whose interface was never built, which is the failure it exists for.
 */

const WEB = new URL("../web/", import.meta.url).pathname;

/** Every web source file except the API client, which is where these are defined. */
function componentSources(): Array<{ file: string; text: string }> {
  return readdirSync(WEB)
    .filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && f !== "api.ts" && !f.endsWith(".d.ts"))
    .map((f) => ({ file: f, text: readFileSync(join(WEB, f), "utf8") }));
}

/**
 * Files mentioning `needle` as a whole word.
 *
 * A bare `includes` cannot tell "uploadFile" from "uploadFileXX", so it
 * reported the feature as wired no matter what — a guard against unreachable
 * code that was itself unreachable. Caught by mutating the wiring away and
 * watching it pass anyway.
 */
const mentions = (needle: string): string[] => {
  const word = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return componentSources()
    .filter((s) => word.test(s.text))
    .map((s) => s.file);
};

describe("every shipped feature is reachable from the interface", () => {
  it("uploads have a caller, not just a transport", () => {
    // The exact gap in 0.5.0: web/api.ts exported uploadFile and nothing
    // imported it, so there was no way to upload a file.
    expect(mentions("uploadFile")).not.toEqual([]);
  });

  it("the upload entry point is an input a person can click", () => {
    const files = componentSources().filter((s) => s.text.includes("uploadFile"));
    expect(files.some((s) => s.text.includes('type="file"'))).toBe(true);
  });

  it("search has a caller, not just a transport", () => {
    expect(mentions("searchFiles")).not.toEqual([]);
  });

  it("app details are reachable from both app pages", () => {
    // The modal is shared, so one page wiring it up would look like success
    // while the other still had no way in.
    const pages = mentions("AppDetailsModal").filter((f) => f !== "app-details.tsx");
    expect(pages).toContain("apps.tsx");
    expect(pages).toContain("catalog.tsx");
  });

  it("the recycle bin is reachable as a folder, not only a button", () => {
    // It used to be a toolbar button, which meant you had to know it existed.
    const page = componentSources().find((s) => s.file === "files-page.tsx");
    expect(page?.text).toContain('kind === "bin"');
  });

  it("the first-run setup is shown by the shell, and asks the server where the NAS is", () => {
    expect(mentions("FirstRunSetup")).toContain("App.tsx");
    expect(componentSources().some((s) => s.text.includes("/api/setup/discover"))).toBe(true);
  });

  it("installing an app renders the app's own questions, not only a name field", () => {
    const page = componentSources().find((s) => s.file === "catalog.tsx");
    expect(page?.text).toContain("/api/catalog/app/schema");
    expect(page?.text).toContain("QuestionList");
  });

  it("backups and checks have a page and a card on Home", () => {
    expect(mentions("SafetyPage")).toContain("App.tsx");
    expect(componentSources().find((s) => s.file === "home.tsx")?.text).toContain("/api/safety");
    const page = componentSources().find((s) => s.file === "safety.tsx")?.text ?? "";
    for (const route of [
      "/api/safety/scrubs",
      "/api/safety/smart-tests",
      "/api/safety/cloud",
      "/api/safety/replication",
      "/api/datasets/unlock",
    ]) {
      expect(page).toContain(route);
    }
  });

  it("time machine is a switch on the share dialog, and encryption one on the folder dialog", () => {
    expect(componentSources().find((s) => s.file === "shares.tsx")?.text).toContain("timeMachine");
    expect(componentSources().find((s) => s.file === "storage.tsx")?.text).toContain("passphrase");
  });

  it("the console can be backed up and restored from Settings", () => {
    const page = componentSources().find((s) => s.file === "settings.tsx")?.text ?? "";
    expect(page).toContain("/api/console/export");
    expect(page).toContain("/api/console/import");
  });

  it("app logs and a container shell are buttons on the app card", () => {
    expect(mentions("AppConsoleModal")).toContain("apps.tsx");
    const modal = componentSources().find((s) => s.file === "app-console.tsx");
    expect(modal?.text).toContain("/containers");
    // The browser sends a mode and a container, never a command.
    expect(modal?.text).not.toMatch(/command=/);
  });

  it("groups can be created, edited and deleted from a page, with the orphan warning", () => {
    const page = componentSources().find((s) => s.file === "groups.tsx");
    expect(page?.text).toContain("/api/groups");
    expect(page?.text).toContain("/orphans");
    expect(mentions("GroupsPage")).toContain("users.tsx");
  });

  it("restart and shutdown have buttons, and go through the typed confirmation", () => {
    const pages = componentSources().filter((s) => s.text.includes("/api/system/power"));
    expect(pages).not.toEqual([]);
    // The route insists on the hostname being typed back; a button that
    // skipped the dialog would be refused, so the dialog is the way in.
    expect(pages.some((s) => s.text.includes("DangerConfirm"))).toBe(true);
  });

  it("NFS exports have a dialog, not just a route", () => {
    // A path fragment rather than an identifier: the dialog posts to the
    // endpoint directly, so there is no imported function name to look for.
    expect(componentSources().filter((s) => s.text.includes("/api/shares/nfs"))).not.toEqual([]);
  });
});
