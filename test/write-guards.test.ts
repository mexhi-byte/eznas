import { describe, expect, it } from "vitest";
import { acceptableWriteType, sameOrigin, SECURITY_HEADERS } from "../server/http.js";

describe("sameOrigin", () => {
  it("allows a request with no Origin, which carries no ambient session to abuse", () =>
    expect(sameOrigin({ host: "nas.local:8080" }, false)).toBe(true));

  it("allows the console's own pages", () =>
    expect(sameOrigin({ host: "nas.local:8080", origin: "http://nas.local:8080" }, false)).toBe(true));

  it("refuses another site", () =>
    expect(sameOrigin({ host: "nas.local:8080", origin: "https://evil.example" }, false)).toBe(false));

  it("refuses a malformed Origin rather than guessing", () =>
    expect(sameOrigin({ host: "nas.local", origin: "not a url" }, false)).toBe(false));

  it("ignores x-forwarded-host unless a proxy is trusted", () => {
    const h = { host: "127.0.0.1:8080", origin: "https://nas.example.com", "x-forwarded-host": "nas.example.com" };
    expect(sameOrigin(h, false)).toBe(false);
    expect(sameOrigin(h, true)).toBe(true);
  });

  it("compares hosts case-insensitively", () =>
    expect(sameOrigin({ host: "NAS.local", origin: "http://nas.LOCAL" }, false)).toBe(true));
});

describe("acceptableWriteType", () => {
  it("takes JSON, an upload, or nothing", () => {
    expect(acceptableWriteType("application/json")).toBe(true);
    expect(acceptableWriteType("application/json; charset=utf-8")).toBe(true);
    expect(acceptableWriteType("application/octet-stream")).toBe(true);
    expect(acceptableWriteType(undefined)).toBe(true);
  });

  it("refuses what a cross-site form would send", () => {
    expect(acceptableWriteType("application/x-www-form-urlencoded")).toBe(false);
    expect(acceptableWriteType("text/plain")).toBe(false);
    expect(acceptableWriteType("multipart/form-data; boundary=x")).toBe(false);
  });
});

describe("SECURITY_HEADERS", () => {
  const csp = SECURITY_HEADERS["content-security-policy"];

  it("lets no script run from anywhere but the console", () => expect(csp).toMatch(/script-src 'self'(;|$)/));

  /*
   * 'self', not 'none': the file browser previews PDFs in an iframe from this
   * origin, and 'none' would blank it. A test, because 'none' is the value
   * every hardening guide recommends and the one somebody will "fix" it to.
   */
  it("allows framing by itself, for the PDF preview", () => {
    expect(csp).toContain("frame-ancestors 'self'");
    expect(SECURITY_HEADERS["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("stops MIME sniffing", () => expect(SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff"));
});
