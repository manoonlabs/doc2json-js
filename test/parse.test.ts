import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Doc2Json, Doc2JsonError } from "../src";
import { formBody, header, jsonBody, jsonResponse, mockClient, OK } from "./helpers";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1

async function fileText(form: FormData): Promise<{ name: string; bytes: Uint8Array }> {
  const file = form.get("file") as File;
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

describe("client setup", () => {
  it("reads DOC2JSON_API_KEY from the environment", () => {
    const before = process.env.DOC2JSON_API_KEY;
    process.env.DOC2JSON_API_KEY = "env_key";
    try {
      expect(() => new Doc2Json({ fetch: (() => {}) as unknown as typeof fetch })).not.toThrow();
    } finally {
      if (before === undefined) delete process.env.DOC2JSON_API_KEY;
      else process.env.DOC2JSON_API_KEY = before;
    }
  });

  it("throws without an API key", () => {
    const before = process.env.DOC2JSON_API_KEY;
    delete process.env.DOC2JSON_API_KEY;
    try {
      expect(() => new Doc2Json()).toThrow(Doc2JsonError);
    } finally {
      if (before !== undefined) process.env.DOC2JSON_API_KEY = before;
    }
  });

  it("sends the bearer token to the default base URL", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ text: "hello" });
    expect(calls[0]?.url).toBe("https://doc2json.manoonlabs.com/api/v1/parse");
    expect(calls[0]?.init.method).toBe("POST");
    expect(header(calls[0], "Authorization")).toBe("Bearer test_key");
  });

  it("trims a trailing slash from baseUrl", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)], { baseUrl: "http://localhost:3000/" });
    await client.parse({ text: "hello" });
    expect(calls[0]?.url).toBe("http://localhost:3000/api/v1/parse");
  });
});

describe("parse inputs", () => {
  it("uploads a file path as multipart with its base name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doc2json-"));
    const path = join(dir, "invoice.pdf");
    await writeFile(path, PDF);
    const { client, calls } = mockClient([jsonResponse(OK)]);
    const result = await client.parse(path, { schema: "invoice" });
    expect(result.values).toEqual({ total: 12.5 });
    const form = formBody(calls[0]);
    const file = await fileText(form);
    expect(file.name).toBe("invoice.pdf");
    expect(file.bytes).toEqual(PDF);
    expect(form.get("schema")).toBe("invoice");
    expect(header(calls[0], "Content-Type")).toBeUndefined();
  });

  it("rejects a path that does not exist", async () => {
    const { client, fetchMock } = mockClient([]);
    await expect(client.parse("/no/such/file.pdf")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads a Buffer", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse(Buffer.from(PDF), { filename: "scan.pdf" });
    const form = formBody(calls[0]);
    const file = await fileText(form);
    expect(file.bytes).toEqual(PDF);
    expect(file.name).toBe("scan.pdf");
    expect(form.get("filename")).toBe("scan.pdf");
  });

  it("uploads a Uint8Array with a default name", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse(PDF);
    const file = await fileText(formBody(calls[0]));
    expect(file.bytes).toEqual(PDF);
    expect(file.name).toBe("document");
    expect(formBody(calls[0]).get("filename")).toBeNull();
  });

  it("uploads an ArrayBuffer", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse(PDF.slice().buffer);
    expect((await fileText(formBody(calls[0]))).bytes).toEqual(PDF);
  });

  it("uploads a Blob", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse(new Blob([PDF], { type: "application/pdf" }));
    expect((await fileText(formBody(calls[0]))).bytes).toEqual(PDF);
  });

  it.skipIf(typeof File === "undefined")("uploads a File and keeps its name", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse(new File([PDF], "receipt.png"));
    expect((await fileText(formBody(calls[0]))).name).toBe("receipt.png");
  });

  it("sends base64 as JSON file_base64", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ base64: "JVBERi0x", filename: "invoice.pdf" }, { schema: "invoice" });
    expect(header(calls[0], "Content-Type")).toBe("application/json");
    expect(jsonBody(calls[0])).toEqual({
      file_base64: "JVBERi0x",
      filename: "invoice.pdf",
      schema: "invoice",
    });
  });

  it("strips a data URL prefix from base64", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ base64: "data:application/pdf;base64,JVBERi0x" });
    expect(jsonBody(calls[0]).file_base64).toBe("JVBERi0x");
  });

  it("sends text as JSON", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ text: "Invoice INV-1 total 12.50" });
    expect(jsonBody(calls[0])).toEqual({ text: "Invoice INV-1 total 12.50" });
  });

  it("rejects an object with both base64 and text", async () => {
    const { client } = mockClient([]);
    await expect(
      client.parse({ base64: "a", text: "b" } as unknown as { text: string }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unsupported input", async () => {
    const { client } = mockClient([]);
    await expect(client.parse(42 as unknown as string)).rejects.toBeInstanceOf(Doc2JsonError);
  });
});

describe("parse options", () => {
  const schema = {
    type: "object" as const,
    properties: { total: { type: "number" as const } },
    required: ["total"],
  };

  it("sends an inline schema as an object in JSON", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ text: "x" }, { schema });
    expect(jsonBody(calls[0]).schema).toEqual(schema);
  });

  it("sends an inline schema as a JSON string in multipart", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse(PDF, { schema });
    expect(JSON.parse(String(formBody(calls[0]).get("schema")))).toEqual(schema);
  });

  it("sends citations as a boolean in JSON and a string in multipart", async () => {
    const { client, calls } = mockClient([jsonResponse(OK), jsonResponse(OK)]);
    await client.parse({ text: "x" }, { citations: true });
    await client.parse(PDF, { citations: false });
    expect(jsonBody(calls[0]).citations).toBe(true);
    expect(formBody(calls[1]).get("citations")).toBe("false");
  });

  it("returns citations", async () => {
    const citations = {
      total: {
        page: 1,
        text: "Total 12.50",
        bbox: [0.1, 0.8, 0.3, 0.82],
        status: "verified",
        source: "text_layer",
      },
    };
    const { client } = mockClient([jsonResponse({ ...OK, citations })]);
    const result = await client.parse<{ total: number }>(PDF, { citations: true });
    expect(result.values.total).toBe(12.5);
    expect(result.citations?.total?.bbox).toEqual([0.1, 0.8, 0.3, 0.82]);
    expect(result.citations?.total?.status).toBe("verified");
  });

  it("decodes an export file to bytes", async () => {
    const csv = "\uFEFFtotal\r\n12.5\r\n";
    const exported = {
      format: "csv",
      filename: "invoice-2026-11-01.csv",
      contentType: "text/csv; charset=utf-8",
      content: Buffer.from(csv).toString("base64"),
    };
    const { client, calls } = mockClient([jsonResponse({ ...OK, export: exported })]);
    const result = await client.parse(PDF, { export: "csv" });
    expect(formBody(calls[0]).get("export")).toBe("csv");
    expect(result.export?.filename).toBe("invoice-2026-11-01.csv");
    expect(result.export?.content).toBe(exported.content);
    expect(new TextDecoder().decode(result.export?.data)).toBe("total\r\n12.5\r\n");
    expect(result.values).toEqual({ total: 12.5 });
  });

  it("sends export in JSON bodies", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ text: "x" }, { export: "xlsx" });
    expect(jsonBody(calls[0]).export).toBe("xlsx");
  });
});

describe("other endpoints", () => {
  it("whoami", async () => {
    const me = { status: "ok", workspaceId: "w", tokenId: "t", credits_remaining: 50 };
    const { client, calls } = mockClient([jsonResponse(me)]);
    expect(await client.whoami()).toEqual(me);
    expect(calls[0]?.url).toMatch(/\/api\/v1\/whoami$/);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("schemas.list", async () => {
    const item = { id: "s", name: "invoice", keyCount: 3, createdAt: "a", updatedAt: "b" };
    const { client } = mockClient([jsonResponse({ status: "ok", schemas: [item] })]);
    expect(await client.schemas.list()).toEqual([item]);
  });

  it("schemas.get encodes the name", async () => {
    const record = {
      status: "ok",
      id: "s",
      name: "my schema",
      keyCount: 1,
      createdAt: "a",
      updatedAt: "b",
      schema: { type: "object", properties: {} },
    };
    const { client, calls } = mockClient([jsonResponse(record)]);
    const got = await client.schemas.get("my schema");
    expect(calls[0]?.url).toMatch(/\/api\/v1\/schemas\/my%20schema$/);
    expect(got).not.toHaveProperty("status");
    expect(got.name).toBe("my schema");
  });

  it("schemas.create and update", async () => {
    const record = {
      status: "ok",
      id: "s",
      name: "invoice",
      keyCount: 1,
      createdAt: "a",
      updatedAt: "b",
      schema: { type: "object", properties: { total: { type: "number" } } },
    };
    const { client, calls } = mockClient([jsonResponse(record, 201), jsonResponse(record)]);
    await client.schemas.create({ name: "invoice", schema: record.schema as never });
    await client.schemas.update("invoice", { newName: "bill" });
    expect(calls[0]?.init.method).toBe("POST");
    expect(jsonBody(calls[0])).toEqual({ name: "invoice", schema: record.schema });
    expect(calls[1]?.init.method).toBe("PATCH");
    expect(jsonBody(calls[1])).toEqual({ newName: "bill" });
  });
});
