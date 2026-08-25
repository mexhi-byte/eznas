import { request } from "node:https";
import type { TrueNas } from "./truenas.js";
import type { Connection } from "./store.js";
import { connectPinned, httpBase } from "./pinned.js";

/**
 * Putting a file onto the NAS.
 *
 * TrueNAS takes uploads at /_upload as a two-part multipart form: a `data`
 * field naming the job to run, and a `file` field carrying the bytes. Unlike
 * move, rename and delete, this is a real API method — filesystem.put — so
 * upload works on every configured server with no stored NAS password.
 *
 * The envelope is built by hand rather than with a form library because the
 * body has to stream. A library wants the whole file in memory to work out a
 * length, and a NAS upload is precisely the case where the file does not fit.
 */

/**
 * Refuse anything that would break out of the Content-Disposition header.
 *
 * A quote ends the filename parameter early and lets the remainder be read as
 * further header parameters; a line break ends the header itself. Neither is
 * legal in a name this console will ever have listed, so refusing costs
 * nothing. The slash is refused separately: the folder is decided by the
 * caller, and a name containing one would move the target.
 */
function safeName(name: string): string {
  if (!name || name === "." || name === "..") {
    throw new Error("That file name cannot be used.");
  }
  if (/["\r\n\0/]/.test(name)) {
    throw new Error("That file name cannot be used: it contains a quote, a slash or a line break.");
  }
  return name;
}

export interface UploadEnvelope {
  prologue: Buffer;
  epilogue: Buffer;
  contentLength: number;
  contentType: string;
}

export function uploadForm(
  boundary: string,
  target: string,
  filename: string,
  size: number,
): UploadEnvelope {
  const name = safeName(filename);
  // 420 is 0o644. JSON has no octal, and a decimal that looks like a mistake is
  // better than an 0o644 literal that arrives as the string "0o644".
  const job = JSON.stringify({ method: "filesystem.put", params: [target, { mode: 420 }] });

  const prologue = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="data"\r\n\r\n` +
      `${job}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  return {
    prologue,
    epilogue,
    // Buffer.length is bytes, which is the only unit the NAS agrees with. A
    // length taken from string.length would be short by one for every
    // non-ASCII character in the name, and the request would hang rather than
    // fail — the NAS waiting for bytes that were never coming.
    contentLength: prologue.length + size + epilogue.length,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** A boundary that cannot occur in the body by accident. */
function newBoundary(): string {
  return `----eznas${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Stream one file to the NAS.
 *
 * The connection is opened and its certificate checked *before* the request
 * exists, because a pin verified in the response callback is verified after
 * the auth token and the entire file have already been sent. See pinned.ts.
 */
export async function uploadTo(
  nas: TrueNas,
  conn: Connection,
  target: string,
  body: NodeJS.ReadableStream,
  size: number,
): Promise<void> {
  const boundary = newBoundary();
  const filename = target.split("/").pop() ?? "";
  // Built first: a name this console will not send is a failure that should
  // cost neither a token nor a connection.
  const { prologue, epilogue, contentLength, contentType } =
    uploadForm(boundary, target, filename, size);

  const token = await nas.call<string>("auth.generate_token", [300, {}, false]);
  const socket = await connectPinned(conn);
  const base = httpBase(conn);

  return await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (base.protocol === "https:" ? 443 : 80),
        path: "/_upload",
        method: "POST",
        // Already connected and already verified. A fresh one per transfer:
        // on a reused keep-alive socket the peer certificate is no longer
        // retrievable, so it could not have been checked at all.
        createConnection: () => socket,
        agent: false,
        headers: {
          "content-type": contentType,
          "content-length": String(contentLength),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          // Enough of the NAS's own message to be useful, and not so much that
          // a stack trace ends up in a toast.
          if (text.length < 2048) text += c;
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`the NAS refused the upload (${res.statusCode}) ${text.slice(0, 200)}`.trim()));
          } else {
            resolve();
          }
        });
      },
    );

    req.on("error", reject);
    // A browser that hangs up mid-upload must tear down the NAS side too,
    // rather than leave it waiting for a body that will never finish.
    body.on("error", (e: Error) => req.destroy(e));

    req.write(prologue);
    body.pipe(req, { end: false });
    body.on("end", () => req.end(epilogue));
  });
}
