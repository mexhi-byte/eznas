import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as store from "./store.js";
import * as accounts from "./accounts.js";
import { COOKIE, read as readSession, readCookie } from "./auth.js";
import { commandFor, isAppName, isConsoleMode, isContainerId, type ConsoleMode } from "./app-shell.js";

/**
 * A shell on the NAS, proxied to the browser.
 *
 * TrueNAS exposes an interactive shell at /websocket/shell, gated by a
 * short-lived token from auth.generate_token rather than by the API key. The
 * proxy exists so that token is minted server-side and never reaches the
 * browser: handing it out would let any script in the page open a root shell
 * independently of this console's own session.
 */

const wss = new WebSocketServer({ noServer: true });

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/shell") return false;

  /*
   * Authorised at the upgrade, before anything is bridged. A WebSocket that
   * authenticates after connecting has already accepted the connection.
   *
   * Both halves matter. Proving a session exists is not enough: this endpoint
   * hands back a root shell on the NAS, and the HTTP gate that keeps viewers
   * read-only works by refusing every method that is not a GET — which an
   * upgrade request is. A viewer reaching /shell would therefore have passed
   * every check the console makes and arrived at a root prompt.
   */
  const session = readSession(readCookie(req.headers.cookie, COOKIE));
  const me = session ? accounts.byId(session.accountId) : undefined;
  if (!me) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return true;
  }
  if (me.role !== "admin") {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return true;
  }

  const conn = store.get(url.searchParams.get("c"));
  if (!conn) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return true;
  }

  /*
   * Which shell. No mode is the Terminal page: a login shell on the NAS.
   * A mode is an app's container — its logs, or a shell inside it — and the
   * command for it is built here from two validated parts. The query string
   * never carries a command, and anything that is not a mode this console
   * knows, or not an id and a name in the only shapes they can take, is
   * refused at the upgrade before anything is bridged.
   */
  const mode = url.searchParams.get("mode");
  const container = url.searchParams.get("container");
  const app = url.searchParams.get("app");
  let target: { mode: ConsoleMode; container: string; app: string } | null = null;
  if (mode !== null) {
    if (!isConsoleMode(mode) || !isContainerId(container) || !isAppName(app)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return true;
    }
    target = { mode, container, app };
  }

  wss.handleUpgrade(req, socket, head, (client) => void bridge(client, conn, target));
  return true;
}

/** The containers an app is running, from the NAS's own account of it. */
export async function containersOf(
  nas: { call<T>(method: string, params?: unknown[]): Promise<T> },
  app: string,
): Promise<Array<{ id: string; name: string; image: string; state: string }>> {
  const [row] = await nas.call<Array<Record<string, unknown>>>("app.query", [[["name", "=", app]]]);
  if (!row) throw new Error(`There is no app called "${app}".`);
  const details = ((row.active_workloads as Record<string, unknown> | undefined)?.container_details ?? []) as Array<
    Record<string, unknown>
  >;
  return details
    .map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.service_name ?? c.name ?? ""),
      image: String(c.image ?? ""),
      state: String(c.state ?? ""),
    }))
    .filter((c) => isContainerId(c.id));
}

async function bridge(
  client: WebSocket,
  conn: store.Connection,
  wanted: { mode: ConsoleMode; container: string; app: string } | null,
): Promise<void> {
  const say = (text: string) => {
    if (client.readyState === WebSocket.OPEN) client.send(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
  };

  // The container has to belong to the app it was asked for. The id shape was
  // checked at the upgrade; this is the check that it is one of *this* app's,
  // so a valid-looking id for some other container is refused too.
  let command = "";
  if (wanted) {
    try {
      const mine = await containersOf(store.clientFor(conn), wanted.app);
      if (!mine.some((c) => c.id === wanted.container)) {
        say(
          `${wanted.app} has no container ${wanted.container.slice(0, 12)}. It may have been restarted; open this again.`,
        );
        client.close();
        return;
      }
      command = commandFor(wanted.mode, wanted.container);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
      client.close();
      return;
    }
  }

  let token: string;
  try {
    // Short-lived and single-purpose: it only has to survive the handshake.
    token = await store.clientFor(conn).call<string>("auth.generate_token", [300, {}, false]);
  } catch (e) {
    say(`Could not get a shell token: ${e instanceof Error ? e.message : String(e)}`);
    client.close();
    return;
  }

  const target = conn.url.replace(/\/api\/current$/, "/websocket/shell");
  const nas = new WebSocket(target, { rejectUnauthorized: false });
  let ready = false;
  // The handshake names the session; resizing needs it, and an empty id
  // resized nothing at all.
  let sessionId = "";

  nas.on("open", () => {
    // An empty command is a login shell, which is what the Terminal page
    // has always asked for.
    nas.send(JSON.stringify({ token, options: { command, tty_size: { rows: 24, cols: 80 } } }));
  });

  nas.on("message", (raw) => {
    const text = raw.toString();
    // The first frame is a JSON handshake; everything after it is terminal
    // output and must be forwarded byte for byte, escape codes included.
    if (!ready) {
      try {
        const msg = JSON.parse(text);
        if (msg.msg === "connected") {
          ready = true;
          sessionId = String(msg.id ?? "");
          return;
        }
        if (msg.msg === "failed") {
          say("The NAS refused the shell session.");
          client.close();
          return;
        }
      } catch {
        // Not JSON, so the shell is already talking.
        ready = true;
      }
    }
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });

  nas.on("error", (e) => {
    say(`Shell connection failed: ${e.message}`);
    client.close();
  });
  nas.on("close", () => client.close());

  client.on("message", (raw) => {
    const text = raw.toString();
    // Resize requests arrive as a JSON control frame; keystrokes are raw.
    if (text.startsWith('{"resize"')) {
      try {
        const { resize } = JSON.parse(text) as { resize: { cols: number; rows: number } };
        if (sessionId) {
          void store
            .clientFor(conn)
            .call("core.resize_shell", [sessionId, resize.cols, resize.rows])
            .catch(() => {});
        }
        return;
      } catch {
        /* fall through and treat it as input */
      }
    }
    // Binary, not text.
    //
    // TrueNAS's shell endpoint reads only binary frames and drops text ones
    // without a word — no error, no close, the keystroke simply never arrives.
    // Sent as text, the terminal printed the login banner and then ignored
    // everything typed into it.
    if (nas.readyState === WebSocket.OPEN) nas.send(Buffer.from(text, "utf8"), { binary: true });
  });

  client.on("close", () => nas.close());
  client.on("error", () => nas.close());
}
