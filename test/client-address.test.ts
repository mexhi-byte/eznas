import { describe, expect, it } from "vitest";
import { clientAddress, trustProxy } from "../server/http.js";

describe("clientAddress", () => {
  /*
   * The property that matters. The rate limit is keyed on this value, so a
   * header the client can set must not be able to change it unless the
   * operator has said a proxy is the one setting it.
   */
  it("ignores forwarded headers unless a proxy is trusted", () => {
    expect(clientAddress({ "cf-connecting-ip": "1.2.3.4" }, "10.0.0.9", false)).toBe("10.0.0.9");
    expect(clientAddress({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.9", false)).toBe("10.0.0.9");
  });

  it("prefers cf-connecting-ip behind a trusted proxy", () =>
    expect(clientAddress({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }, "10.0.0.9", true)).toBe("1.2.3.4"));

  it("takes the first x-forwarded-for entry, which is the original client", () =>
    expect(clientAddress({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, "10.0.0.9", true)).toBe("1.2.3.4"));

  it("falls back to the socket when a trusted proxy sent nothing", () =>
    expect(clientAddress({}, "10.0.0.9", true)).toBe("10.0.0.9"));

  it("does not treat an empty header as an address", () =>
    expect(clientAddress({ "cf-connecting-ip": "  " }, "10.0.0.9", true)).toBe("10.0.0.9"));
});

describe("trustProxy", () => {
  it("accepts the usual spellings of yes and nothing else", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(trustProxy(v)).toBe(true);
    for (const v of [undefined, "", "0", "false", "no", "maybe"]) expect(trustProxy(v)).toBe(false);
  });
});
