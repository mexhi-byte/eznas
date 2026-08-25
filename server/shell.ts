import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as store from "./store.js";
import * as accounts from "./accounts.js";
import { COOKIE, read as readSession, readCookie } from "./auth.js";

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

  wss.handleUpgrade(req, socket, head, (client) => void bridge(client, conn));
  return true;
}

async function bridge(client: WebSocket, conn: store.Connection): Promise<void> {
  const say = (text: string) => {
    if (client.readyState === WebSocket.OPEN) client.send(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
  };

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
    nas.send(JSON.stringify({ token, options: { command: "", tty_size: { rows: 24, cols: 80 } } }));
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
          void store.clientFor(conn).call("core.resize_shell", [sessionId, resize.cols, resize.rows]).catch(() => {});
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
