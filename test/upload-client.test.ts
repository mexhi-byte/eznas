import { describe, expect, it } from "vitest";

/*
 * web/api.ts reads localStorage at module scope to remember which server the
 * console is pointed at, so it needs one to exist before it is imported. A
 * four-line stub is cheaper than a jsdom dependency for a helper that was
 * written to need no DOM otherwise — its XMLHttpRequest is injectable.
 */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { uploadFile } = await import("../web/api.js");

/** Enough of XMLHttpRequest for uploadFile, and nothing more. */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload = { onprogress: null as ((e: { loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  responseText = "{}";
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: unknown = null;
  aborted = false;
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string): void { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string): void { this.headers[k] = v; }
  send(body: unknown): void { this.sent = body; }
  abort(): void { this.aborted = true; this.onabort?.(); }
}

const make = () => new FakeXhr() as unknown as XMLHttpRequest;
const fileOf = (name: string, text: string) =>
  ({ name, size: text.length, type: "text/plain" }) as unknown as File;

describe("uploadFile", () => {
  it("POSTs to the upload route with the folder and name in the query", () => {
    uploadFile("/mnt/tank/docs", fileOf("a.txt", "hello"), () => {}, make);
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain("/api/files/upload");
    expect(xhr.url).toContain(`path=${encodeURIComponent("/mnt/tank/docs")}`);
    expect(xhr.url).toContain(`name=${encodeURIComponent("a.txt")}`);
  });

  it("escapes a name that would otherwise alter the query", () => {
    // A file called "a&name=b.txt" must not be able to add a parameter.
    uploadFile("/mnt/tank", fileOf("a&name=b.txt", "x"), () => {}, make);
    expect(FakeXhr.last!.url).toContain(encodeURIComponent("a&name=b.txt"));
  });

  it("sends the file itself, not a form wrapper", () => {
    const file = fileOf("a.txt", "hello");
    uploadFile("/mnt/tank", file, () => {}, make);
    // The server builds the multipart envelope. Wrapping it here as well would
    // nest one multipart body in another and store the inner headers as file
    // content.
    expect(FakeXhr.last!.sent).toBe(file);
  });

  it("reports progress as bytes go out", () => {
    const seen: Array<[number, number]> = [];
    uploadFile("/mnt/tank", fileOf("a.txt", "hello"), (s, t) => seen.push([s, t]), make);
    FakeXhr.last!.upload.onprogress!({ loaded: 3, total: 5 });
    expect(seen).toEqual([[3, 5]]);
  });

  it("resolves when the request completes", async () => {
    const h = uploadFile("/mnt/tank", fileOf("a.txt", "hi"), () => {}, make);
    FakeXhr.last!.onload!();
    await expect(h.promise).resolves.toBeUndefined();
  });

  it("rejects with the server's own message, not a generic one", async () => {
    const h = uploadFile("/mnt/tank", fileOf("a.txt", "hi"), () => {}, make);
    const xhr = FakeXhr.last!;
    xhr.status = 400;
    xhr.responseText = JSON.stringify({ error: "That file name cannot be used." });
    xhr.onload!();
    await expect(h.promise).rejects.toThrow("That file name cannot be used.");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const h = uploadFile("/mnt/tank", fileOf("a.txt", "hi"), () => {}, make);
    const xhr = FakeXhr.last!;
    xhr.status = 502;
    xhr.responseText = "<html>Bad Gateway</html>";
    xhr.onload!();
    await expect(h.promise).rejects.toThrow("502");
  });

  it("rejects when the connection drops", async () => {
    const h = uploadFile("/mnt/tank", fileOf("a.txt", "hi"), () => {}, make);
    FakeXhr.last!.onerror!();
    await expect(h.promise).rejects.toThrow(/connection/i);
  });

  it("rejects when aborted, and says it was cancelled", async () => {
    const h = uploadFile("/mnt/tank", fileOf("a.txt", "hi"), () => {}, make);
    h.abort();
    expect(FakeXhr.last!.aborted).toBe(true);
    await expect(h.promise).rejects.toThrow(/cancel/i);
  });

  it("attaches its handlers before sending", async () => {
    // An XHR that completed between send() and the assignment would fire into
    // nothing and the promise would never settle.
    const h = uploadFile("/mnt/tank", fileOf("a.txt", "hi"), () => {}, make);
    const xhr = FakeXhr.last!;
    expect(xhr.sent).not.toBeNull();
    expect(xhr.onload).not.toBeNull();
    expect(xhr.upload.onprogress).not.toBeNull();
    xhr.onload!();
    await expect(h.promise).resolves.toBeUndefined();
  });
});
