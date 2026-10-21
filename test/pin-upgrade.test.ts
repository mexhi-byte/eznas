import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { verifyPinOnUpgrade } from "../server/pinned.js";
import type { WebSocket } from "ws";

/**
 * The shell proxy and the main NAS socket both mint a secret on the browser
 * side and send it over this WebSocket at `open`. If the pin check runs any
 * later than the HTTP upgrade event, that secret has already left the process
 * by the time we discover the certificate is wrong. These tests pin that
 * ordering: on a mismatched fingerprint the socket terminates in the upgrade
 * handler, before anything else gets a chance.
 */

const match = "a".repeat(64);
const mismatch = "b".repeat(64);

function fakeWs(): WebSocket & { emitUpgrade: (fp: string | undefined) => void; terminate: ReturnType<typeof vi.fn> } {
  const ws = new EventEmitter() as unknown as EventEmitter & {
    terminate: ReturnType<typeof vi.fn>;
    emitUpgrade: (fp: string | undefined) => void;
  };
  ws.terminate = vi.fn();
  ws.emitUpgrade = (fp) => {
    ws.emit("upgrade", {
      socket: {
        getPeerX509Certificate: () => (fp === undefined ? undefined : { fingerprint256: fp }),
      },
    });
  };
  return ws as unknown as WebSocket & typeof ws;
}

describe("verifyPinOnUpgrade", () => {
  it("does nothing when no pin is saved", () => {
    const ws = fakeWs();
    verifyPinOnUpgrade(ws, null, () => {
      throw new Error("onMismatch should not be called when there is no pin to check");
    });
    ws.emitUpgrade(mismatch);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("accepts a matching certificate without touching the socket", () => {
    const ws = fakeWs();
    const onMismatch = vi.fn();
    verifyPinOnUpgrade(ws, match, onMismatch);
    ws.emitUpgrade(match);
    expect(onMismatch).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("terminates the socket on a mismatched certificate, before the open event", () => {
    const ws = fakeWs();
    const onMismatch = vi.fn();
    verifyPinOnUpgrade(ws, match, onMismatch);
    ws.emitUpgrade(mismatch);
    // Both the terminate call and the callback — the callback writes the error
    // to the client terminal, the terminate stops anything else from being sent.
    expect(onMismatch).toHaveBeenCalledWith(mismatch);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it("treats a missing certificate as a mismatch rather than a free pass", () => {
    const ws = fakeWs();
    const onMismatch = vi.fn();
    verifyPinOnUpgrade(ws, match, onMismatch);
    ws.emitUpgrade(undefined);
    expect(onMismatch).toHaveBeenCalledWith("(none)");
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it("compares with the same leniency as the TLS layer: colons and case ignored", () => {
    const ws = fakeWs();
    const onMismatch = vi.fn();
    const saved = "ABCDEF" + "0".repeat(58);
    const presented = "AB:CD:EF" + ":00".repeat(29); // 29 pairs → 58 zeros
    verifyPinOnUpgrade(ws, saved.toLowerCase(), onMismatch);
    ws.emitUpgrade(presented);
    expect(onMismatch).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });
});
