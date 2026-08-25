import { describe, expect, it } from "vitest";
import { catalogIconIndex, hostOf, iconFor, portLinks } from "../server/app-links.js";

describe("hostOf", () => {
  // The portal has to point at the address this person reaches the NAS on.
  // The NAS's own idea of its hostname is frequently not that.
  it("takes the host out of a websocket url", () =>
    expect(hostOf("wss://192.168.1.50/api/current")).toBe("192.168.1.50"));
  it("takes the host out of an https url", () =>
    expect(hostOf("https://nas.local/api/current")).toBe("nas.local"));
  it("drops the NAS's own port, which is not the app's", () =>
    expect(hostOf("https://192.168.1.50:444/api/current")).toBe("192.168.1.50"));
  it("keeps an IPv6 host bracketed so a port can be appended", () =>
    expect(hostOf("wss://[fd00::1]/api/current")).toBe("[fd00::1]"));
  it("returns null for something that is not a url", () => expect(hostOf("not a url")).toBeNull());
  it("returns null for an empty string", () => expect(hostOf("")).toBeNull());
});

describe("portLinks", () => {
  const ports = [{ host_ports: [{ host_port: 30027 }, { host_port: 8080 }] }];

  it("builds one link per exposed port", () => {
    expect(portLinks("192.168.1.50", ports)).toEqual([
      { port: 30027, url: "http://192.168.1.50:30027" },
      { port: 8080, url: "http://192.168.1.50:8080" },
    ]);
  });

  it("has no links at all when the host is unknown", () =>
    expect(portLinks(null, ports)).toEqual([]));

  it("has no links when nothing is exposed", () =>
    expect(portLinks("192.168.1.50", [])).toEqual([]));

  it("survives a workload that lists no host ports", () =>
    expect(portLinks("192.168.1.50", [{}])).toEqual([]));

  it("drops a duplicate port rather than offering it twice", () => {
    const dupes = [{ host_ports: [{ host_port: 80 }] }, { host_ports: [{ host_port: 80 }] }];
    expect(portLinks("10.0.0.2", dupes)).toEqual([{ port: 80, url: "http://10.0.0.2:80" }]);
  });

  it("brackets an IPv6 host so the port is not read as part of the address", () =>
    expect(portLinks("[fd00::1]", [{ host_ports: [{ host_port: 80 }] }]))
      .toEqual([{ port: 80, url: "http://[fd00::1]:80" }]));
});

describe("catalogIconIndex", () => {
  const rows = [
    { name: "nextcloud", icon_url: "https://media/nextcloud.png" },
    { name: "qBittorrent", icon_url: "https://media/qbit.png" },
    { name: "no-icon", icon_url: null },
  ];

  it("keys apps by name", () =>
    expect(catalogIconIndex(rows).get("nextcloud")).toBe("https://media/nextcloud.png"));

  // The app is called "qbittorrent" on the system and "qBittorrent" in the
  // catalog. Matching case-sensitively finds neither.
  it("matches regardless of case", () =>
    expect(catalogIconIndex(rows).get("qbittorrent")).toBe("https://media/qbit.png"));

  it("leaves out an entry with no icon rather than storing a null", () =>
    expect(catalogIconIndex(rows).has("no-icon")).toBe(false));
});

describe("iconFor", () => {
  const index = new Map([["nextcloud", "https://media/nextcloud.png"]]);

  it("keeps the icon the app already carries", () =>
    expect(iconFor("nextcloud", "https://own/icon.png", index)).toBe("https://own/icon.png"));

  // The whole point: a compose app deployed in the TrueNAS UI has no metadata
  // icon, and TrueNAS will never give it one.
  it("falls back to the catalog when the app carries none", () =>
    expect(iconFor("nextcloud", null, index)).toBe("https://media/nextcloud.png"));

  it("matches the catalog regardless of case", () =>
    expect(iconFor("NextCloud", null, index)).toBe("https://media/nextcloud.png"));

  it("stays null for an app the catalog has never heard of", () =>
    expect(iconFor("monitoring", null, index)).toBeNull());

  it("stays null when there is no catalog to consult", () =>
    expect(iconFor("nextcloud", null, null)).toBeNull());
});
