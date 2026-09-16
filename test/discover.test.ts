import { describe, expect, it } from "vitest";
import { defaultGateway } from "../server/discover.js";

// A real table from a Docker container: eth0 with 172.17.0.1 as its gateway.
const TABLE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0
`;

describe("defaultGateway", () => {
  it("decodes the little-endian hex gateway of the default route", () =>
    expect(defaultGateway(TABLE)).toBe("172.17.0.1"));

  it("ignores routes that are not the default", () => {
    const noDefault = TABLE.split("\n")
      .filter((l) => !l.includes("\t00000000\t010011AC"))
      .join("\n");
    expect(defaultGateway(noDefault)).toBeNull();
  });

  it("ignores a default route without the gateway flag", () => {
    // Flags 0001 is UP without GATEWAY: a directly attached default, no hop.
    const direct = TABLE.replace("010011AC\t0003", "010011AC\t0001");
    expect(defaultGateway(direct)).toBeNull();
  });

  it("copes with an empty or malformed table", () => {
    expect(defaultGateway("")).toBeNull();
    expect(defaultGateway("garbage\nmore garbage")).toBeNull();
  });
});
