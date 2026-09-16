import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrueNas } from "../truenas.js";
import type { Account } from "../accounts.js";

/**
 * What every route module receives.
 *
 * index.ts authenticates the request, applies the role and first-run gates,
 * picks the NAS from ?c=, and hands the rest to one module after another
 * until one says it answered. A module never imports index.ts — it starts the
 * server at import time — so this is the whole contract between them.
 */
export interface NasRouteContext {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  nas: TrueNas;
  /** The signed-in console account. Every route here runs as somebody. */
  me: Account;
}

/** The routes that belong to the console itself rather than to a NAS. */
export type ConsoleRouteContext = Omit<NasRouteContext, "nas">;
