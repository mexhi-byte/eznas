import { bodyOf, json, optStr } from "../http.js";
import type { NasRouteContext } from "./context.js";

/**
 * Network configuration, with the rollback countdown. Changing an address over
 * the network being changed is exactly how a box becomes unreachable, so a
 * commit carries a check-in timeout and the NAS reverts on its own if nobody
 * confirms.
 */

export async function handleNetworkRoutes(ctx: NasRouteContext): Promise<boolean> {
  const { path, method, req, res, nas } = ctx;

  /* --- network --- */

  if (path === "/api/network") {
    const [ifaces, global, pending] = await Promise.all([
      nas.call<Array<Record<string, unknown>>>("interface.query"),
      nas.call<Record<string, unknown>>("network.configuration.config"),
      nas.call<boolean>("interface.has_pending_changes"),
    ]);
    json(res, 200, {
      pendingChanges: pending,
      global: {
        hostname: global.hostname,
        domain: global.domain,
        ipv4gateway: global.ipv4gateway,
        ipv6gateway: global.ipv6gateway,
        nameserver1: global.nameserver1,
        nameserver2: global.nameserver2,
        nameserver3: global.nameserver3,
      },
      interfaces: ifaces.map((i) => {
        const state = (i.state ?? {}) as Record<string, unknown>;
        return {
          id: i.id,
          name: i.name,
          type: i.type,
          description: i.description,
          dhcp: i.ipv4_dhcp,
          autoconf: i.ipv6_auto,
          mtu: i.mtu,
          aliases: ((i.aliases ?? []) as Array<Record<string, unknown>>).map((a) => ({
            address: a.address,
            netmask: a.netmask,
            type: a.type,
          })),
          linkState: state.link_state,
          activeMediaSubtype: state.active_media_subtype,
          mac: state.link_address,
        };
      }),
    });
    return true;
  }

  const ifaceMatch = /^\/api\/network\/interfaces\/([^/]+)$/.exec(path);
  if (ifaceMatch && method === "PUT") {
    const b = await bodyOf(req);
    const patch: Record<string, unknown> = {};
    if (typeof b.dhcp === "boolean") patch.ipv4_dhcp = b.dhcp;
    if (b.mtu !== undefined) patch.mtu = b.mtu === null ? null : Number(b.mtu);
    if (optStr(b, "description") !== undefined) patch.description = optStr(b, "description") ?? "";
    if (Array.isArray(b.aliases)) {
      patch.aliases = (b.aliases as Array<Record<string, unknown>>).map((a) => ({
        address: String(a.address),
        netmask: Number(a.netmask),
        type: String(a.type ?? "INET"),
      }));
    }
    json(res, 200, await nas.call("interface.update", [ifaceMatch[1], patch]));
    return true;
  }

  if (path === "/api/network/global" && method === "PUT") {
    const b = await bodyOf(req);
    const patch: Record<string, unknown> = {};
    for (const k of ["hostname", "domain", "ipv4gateway", "nameserver1", "nameserver2", "nameserver3"]) {
      if (b[k] !== undefined) patch[k] = String(b[k] ?? "");
    }
    json(res, 200, await nas.call("network.configuration.update", [patch]));
    return true;
  }

  if (path === "/api/network/commit" && method === "POST") {
    const b = await bodyOf(req);
    // checkin_timeout is the safety net: if nobody confirms within it, the NAS
    // rolls the change back on its own. Changing an address over the network
    // being changed is exactly how a box becomes unreachable.
    await nas.call("interface.commit", [{ rollback: true, checkin_timeout: Number(b.timeout ?? 60) }]);
    json(res, 200, { ok: true, checkinTimeout: Number(b.timeout ?? 60) });
    return true;
  }

  if (path === "/api/network/checkin" && method === "POST") {
    await nas.call("interface.checkin");
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/network/rollback" && method === "POST") {
    await nas.call("interface.rollback");
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
