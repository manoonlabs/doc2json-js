import { Doc2JsonError } from "./errors";
import type { ParseInput, ParseOptions } from "./types";

/** The body of one POST /api/v1/parse, ready to send (and resend on retry). */
export type ParseBody =
  | { kind: "json"; json: Record<string, unknown> }
  | { kind: "multipart"; blob: Blob; filename: string; fields: Record<string, string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function fileName(value: unknown): string | undefined {
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Last path segment, for both / and \ separators. */
export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function isNodeLike(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === "string" || "Deno" in globalThis || "Bun" in globalThis;
}

async function readPath(path: string): Promise<Uint8Array> {
  if (!isNodeLike()) {
    throw new Doc2JsonError(
      "A file path can only be read in Node, Bun or Deno. In the browser, pass a File, Blob or bytes.",
      { code: "invalid_input" },
    );
  }
  // A variable specifier keeps browser bundlers from trying to resolve node:fs.
  const specifier = "node:fs/promises";
  const fs = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as {
    readFile(path: string): Promise<Uint8Array>;
  };
  try {
    return new Uint8Array(await fs.readFile(path));
  } catch (cause) {
    throw new Doc2JsonError(`Could not read file: ${path}`, { code: "invalid_input", cause });
  }
}

function sharedFields(options: ParseOptions): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (options.schema !== undefined) fields.schema = options.schema;
  if (options.citations !== undefined) fields.citations = options.citations;
  if (options.export !== undefined) fields.export = options.export;
  if (options.filename !== undefined) fields.filename = options.filename;
  return fields;
}

function multipart(blob: Blob, name: string | undefined, options: ParseOptions): ParseBody {
  const fields: Record<string, string> = {};
  if (options.schema !== undefined) {
    fields.schema =
      typeof options.schema === "string" ? options.schema : JSON.stringify(options.schema);
  }
  if (options.citations !== undefined) fields.citations = options.citations ? "true" : "false";
  if (options.export !== undefined) fields.export = options.export;
  if (options.filename !== undefined) fields.filename = options.filename;
  return { kind: "multipart", blob, filename: options.filename ?? name ?? "document", fields };
}

function toBlob(bytes: Uint8Array | ArrayBuffer): Blob {
  return new Blob([bytes as BlobPart]);
}

/**
 * Turn any supported input into a request body. Bytes, blobs and paths go up
 * as multipart/form-data; base64 and text go as JSON.
 */
export async function buildParseBody(
  input: ParseInput,
  options: ParseOptions = {},
): Promise<ParseBody> {
  if (typeof input === "string") {
    const bytes = await readPath(input);
    return multipart(toBlob(bytes), basename(input), options);
  }
  if (isBlob(input)) return multipart(input, fileName(input), options);
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return multipart(toBlob(input), undefined, options);
  }
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return multipart(
      toBlob(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
      undefined,
      options,
    );
  }
  if (isRecord(input)) {
    const hasBase64 = "base64" in input;
    const hasText = "text" in input;
    if (hasBase64 === hasText) {
      throw new Doc2JsonError("Pass exactly one of { base64 } or { text }.", {
        code: "invalid_input",
      });
    }
    const filename = options.filename ?? (input.filename as string | undefined);
    const json: Record<string, unknown> = { ...sharedFields(options) };
    if (filename !== undefined) json.filename = filename;
    if (hasBase64) {
      if (typeof input.base64 !== "string") {
        throw new Doc2JsonError("base64 must be a string.", { code: "invalid_input" });
      }
      json.file_base64 = input.base64.replace(/^data:[^;,]*;base64,/, "");
    } else {
      if (typeof input.text !== "string") {
        throw new Doc2JsonError("text must be a string.", { code: "invalid_input" });
      }
      json.text = input.text;
    }
    return { kind: "json", json };
  }
  throw new Doc2JsonError(
    "Unsupported input. Pass a file path, bytes, a Blob or File, { base64 } or { text }.",
    { code: "invalid_input" },
  );
}
