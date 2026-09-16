import { describe, expect, it } from "vitest";
import { generatedPassword } from "../server/accounts-bootstrap.js";

describe("generatedPassword", () => {
  it("is long enough that guessing is not a strategy", () =>
    expect(generatedPassword().replace(/-/g, "").length).toBeGreaterThanOrEqual(16));

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatedPassword()));
    expect(seen.size).toBe(50);
  });

  /*
   * Grouped, because this gets read off a terminal and typed into a browser by
   * a person. An unbroken run of random characters is where transcription
   * errors come from, and a password nobody can retype gets replaced with a
   * worse one.
   */
  it("is grouped so it can be read aloud and typed back", () => {
    const p = generatedPassword();
    expect(p).toMatch(/^[0-9a-z]{4}(-[0-9a-z]{4})+$/);
  });

  it("avoids characters that look like each other", () => {
    // No l/1, o/0, i, u — the pairs that get mistyped, and the vowel that
    // makes random strings occasionally spell something.
    const joined = Array.from({ length: 200 }, () => generatedPassword()).join("");
    expect(joined).not.toMatch(/[lo01iu]/);
  });
});
