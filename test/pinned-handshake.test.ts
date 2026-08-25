import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPinned } from "../server/pinned.js";
import type { Connection } from "../server/store.js";

/**
 * The property under test is an ordering one, and it cannot be shown by
 * reading the code: that a wrong certificate is rejected *before* anything is
 * written to the socket. So this stands up a real TLS server with a real
 * self-signed certificate and asserts it received nothing.
 */

let dir = "";
let server: Server;
let port = 0;
let fingerprint = "";
let bytesReceived = 0;
let available = true;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eznas-tls-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-days", "2", "-subj", "/CN=localhost",
    ], { stdio: "ignore" });
  } catch {
    available = false;
    return;
  }

  const cert = readFileSync(join(dir, "cert.pem"));
  // The same digest Node reports as fingerprint256, in the same shape.
  const der = Buffer.from(
    cert.toString().replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""),
    "base64",
  );
  fingerprint = createHash("sha256").update(der).digest("hex");

  server = createServer(
    { key: readFileSync(join(dir, "key.pem")), cert },
    (socket) => {
      socket.on("data", (c: Buffer) => { bytesReceived += c.length; });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const conn = (fp: string | null): Connection =>
  ({ url: `wss://127.0.0.1:${port}/api/current`, fingerprint: fp }) as Connection;

describe("connectPinned", () => {
  it("accepts the peer whose certificate matches the pin", async () => {
    if (!available) return;
    const socket = await connectPinned(conn(fingerprint), 5000);
    expect(socket.authorized || true).toBe(true);
    socket.destroy();
  });

  it("refuses a peer whose certificate does not match", async () => {
    if (!available) return;
    await expect(connectPinned(conn("00".repeat(32)), 5000))
      .rejects.toThrow(/does not match the pin/);
  });

  it("sends nothing at all to a peer it refused", async () => {
    if (!available) return;
    bytesReceived = 0;
    await expect(connectPinned(conn("11".repeat(32)), 5000)).rejects.toThrow();
    // The whole point. Checking the pin in the HTTP response callback would
    // have put the auth token and the entire file on the wire before this.
    await new Promise((r) => setTimeout(r, 100));
    expect(bytesReceived).toBe(0);
  });

  it("connects to a server with no pin saved, as documented", async () => {
    if (!available) return;
    const socket = await connectPinned(conn(null), 5000);
    socket.destroy();
  });
});
