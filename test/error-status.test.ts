import { describe, expect, it } from "vitest";
import { HttpError, statusForError } from "../server/http.js";

describe("statusForError", () => {
  /*
   * 502 is not a cosmetic choice here. A reverse proxy is entitled to replace
   * a 5xx body with its own error page, and Cloudflare does — so a 502 reaches
   * the browser as HTML, the client cannot parse it as JSON, and the reason is
   * destroyed in transit. Anything the user could act on must stay 4xx.
   */
  it("keeps 502 for a NAS this console genuinely cannot reach", () => {
    expect(statusForError(new Error("The NAS is not reachable."))).toBe(502);
    expect(statusForError(new Error("connect ECONNREFUSED 10.0.0.2:443"))).toBe(502);
    expect(statusForError(new Error("no TrueNAS server is configured"))).toBe(502);
  });

  it("treats a refusal by the NAS as a bad request, not a broken gateway", () =>
    expect(statusForError(new Error("dataset is busy"))).toBe(400));

  // The bug this was written for: an upload whose connection to the NAS drops
  // matched "socket hang up" and became a 502, so the proxy ate the reason and
  // the browser could only say "Upload failed (502)".
  it("honours a status the thrower chose over guessing from the message", () => {
    const e = new HttpError("the NAS closed the connection: socket hang up", 400);
    expect(statusForError(e)).toBe(400);
  });

  it("still guesses when nothing chose a status", () =>
    expect(statusForError(new Error("socket hang up"))).toBe(502));

  it("honours an explicit 502 as readily as an explicit 400", () =>
    expect(statusForError(new HttpError("gone", 502))).toBe(502));

  it("copes with something thrown that is not an Error at all", () =>
    expect(statusForError("just a string")).toBe(400));

  it("ignores a status that is not a number", () => {
    const e = Object.assign(new Error("odd"), { status: "nope" });
    expect(statusForError(e)).toBe(400);
  });

  it("ignores a status outside the range a response can carry", () => {
    expect(statusForError(Object.assign(new Error("odd"), { status: 99 }))).toBe(400);
    expect(statusForError(Object.assign(new Error("odd"), { status: 700 }))).toBe(400);
  });
});
