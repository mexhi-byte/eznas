import { describe, expect, it } from "vitest";
import { uploadForm } from "../server/upload.js";

const B = "----eznasBOUNDARY";

describe("uploadForm", () => {
  it("names the two fields TrueNAS expects", () => {
    const { prologue } = uploadForm(B, "/mnt/tank/a.txt", "a.txt", 5);
    const text = prologue.toString("utf8");
    expect(text).toContain('name="data"');
    expect(text).toContain('name="file"; filename="a.txt"');
    expect(text).toContain('"method":"filesystem.put"');
    expect(text).toContain("/mnt/tank/a.txt");
  });

  it("reports a content length that matches the bytes it will send", () => {
    const size = 5;
    const { prologue, epilogue, contentLength } = uploadForm(B, "/mnt/tank/a.txt", "a.txt", size);
    // The NAS rejects a request whose Content-Length disagrees with the body by
    // even one byte, and the failure looks like a network error rather than an
    // arithmetic one.
    expect(contentLength).toBe(prologue.length + size + epilogue.length);
  });

  it("closes the multipart body with the terminating boundary", () => {
    const { epilogue } = uploadForm(B, "/mnt/tank/a.txt", "a.txt", 5);
    expect(epilogue.toString("utf8")).toBe(`\r\n--${B}--\r\n`);
  });

  it("declares the boundary in the content type", () => {
    const { contentType } = uploadForm(B, "/mnt/tank/a.txt", "a.txt", 5);
    expect(contentType).toBe(`multipart/form-data; boundary=${B}`);
  });

  it("refuses a filename containing a quote", () => {
    // An unescaped quote ends the filename parameter early and lets the rest of
    // the name be read as further header parameters.
    expect(() => uploadForm(B, '/mnt/tank/a".txt', 'a".txt', 5)).toThrow(/name/i);
  });

  it("refuses a filename containing a newline", () => {
    expect(() => uploadForm(B, "/mnt/tank/a\nb.txt", "a\nb.txt", 5)).toThrow(/name/i);
  });

  it("refuses a filename containing a slash", () => {
    expect(() => uploadForm(B, "/mnt/tank/a/b.txt", "a/b.txt", 5)).toThrow(/name/i);
  });

  it("refuses . and .. as names", () => {
    expect(() => uploadForm(B, "/mnt/tank/.", ".", 5)).toThrow(/name/i);
    expect(() => uploadForm(B, "/mnt/tank/..", "..", 5)).toThrow(/name/i);
  });

  it("counts multibyte filenames in bytes, not characters", () => {
    // "café.txt" is 8 characters and 9 bytes. A length computed from
    // string.length would be one short and the upload would hang.
    const name = "café.txt";
    const { prologue, contentLength } = uploadForm(B, `/mnt/tank/${name}`, name, 0);
    expect(prologue.length).toBeGreaterThan(0);
    expect(contentLength).toBe(prologue.length + 0 + Buffer.byteLength(`\r\n--${B}--\r\n`));
  });
});
