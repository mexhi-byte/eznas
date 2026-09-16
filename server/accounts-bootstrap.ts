import { randomInt } from "node:crypto";

/**
 * The password the console makes for itself on first run.
 *
 * There is no default password. A fixed one would be printed in this
 * repository, and this console holds a TrueNAS API key that is equivalent to
 * root on the NAS — which makes a published credential exactly the thing mass
 * scanners look for. Generating one costs the operator nothing extra: it is
 * shown once, in the log they are already watching after an install.
 */

/*
 * No l, 1, o, 0, i or u.
 *
 * The first four get mistyped as each other off a terminal, and dropping the
 * vowels means a random string cannot accidentally spell something the owner
 * would rather it did not. What is left is 30 symbols — five groups of four is
 * a shade over 98 bits, which is not the weak link in anything here.
 */
const ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const GROUPS = 5;
const PER_GROUP = 4;

export function generatedPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let out = "";
    // randomInt, not Math.random: this is a credential, and Math.random is
    // seeded predictably enough that two consoles starting together could
    // produce the same one.
    for (let i = 0; i < PER_GROUP; i++) out += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(out);
  }
  // Grouped because a person reads this off a terminal and types it into a
  // browser. A password nobody can retype gets replaced with a worse one.
  return groups.join("-");
}

/** What to print so it cannot be missed in a wall of startup output. */
export function firstRunNotice(username: string, password: string): string {
  return [
    "",
    "  ┌─────────────────────────────────────────────────────────┐",
    "  │  No administrator account existed, so one was created.  │",
    "  └─────────────────────────────────────────────────────────┘",
    "",
    `      username:  ${username}`,
    `      password:  ${password}`,
    "",
    "  Sign in and change it — the console will ask you to.",
    "  This is the only time this password is shown.",
    "",
  ].join("\n");
}
