import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";
import {
  Doc2JsonError,
  isZodSchema,
  jsonSchemaToDefinition,
  type ParseResult,
  type ZodValidation,
  zodToSchema,
} from "../src";
import { jsonBody, jsonResponse, mockClient, OK } from "./helpers";

const Invoice = z.object({
  vendor: z.string().nullable(),
  total: z.number().nullable(),
  issued: z.iso.date().nullable(),
  paid: z.boolean().optional(),
  lineItems: z.array(z.object({ description: z.string(), amount: z.number() })),
});

describe("isZodSchema", () => {
  it("matches Zod 4 schemas by shape", () => {
    expect(isZodSchema(Invoice)).toBe(true);
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(zm.object({ a: zm.string() }))).toBe(true);
  });

  it("does not match plain schemas, names or other values", () => {
    expect(isZodSchema({ type: "object", properties: { a: { type: "string" } } })).toBe(false);
    expect(isZodSchema("invoice")).toBe(false);
    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
    expect(isZodSchema({ _zod: null })).toBe(false);
  });
});

describe("zodToSchema", () => {
  it("converts strings, numbers, booleans, dates, nullable, arrays and required", async () => {
    expect(await zodToSchema(Invoice)).toEqual({
      type: "object",
      properties: {
        vendor: { type: "string" },
        total: { type: "number" },
        issued: { type: "date" },
        paid: { type: "boolean" },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number" },
            },
            required: ["description", "amount"],
          },
        },
      },
      required: ["vendor", "total", "issued", "lineItems"],
    });
  });

  it("drops $schema, additionalProperties, patterns and bounds", async () => {
    const out = JSON.stringify(await zodToSchema(Invoice));
    for (const key of ["$schema", "additionalProperties", "pattern", "format", "anyOf"]) {
      expect(out).not.toContain(key);
    }
  });

  it("keeps descriptions, including on nullable fields", async () => {
    const schema = z
      .object({
        total: z.number().describe("Grand total with tax").nullable(),
        vendor: z.string().nullable().describe("Seller name"),
      })
      .describe("An invoice");
    expect(await zodToSchema(schema)).toEqual({
      type: "object",
      description: "An invoice",
      properties: {
        total: { type: "number", description: "Grand total with tax" },
        vendor: { type: "string", description: "Seller name" },
      },
      required: ["total", "vendor"],
    });
  });

  it("maps integers, Date, literals and enums", async () => {
    const schema = z.object({
      count: z.number().int(),
      when: z.date(),
      kind: z.literal("invoice"),
      currency: z.enum(["USD", "LKR"]).describe("Currency code"),
    });
    expect((await zodToSchema(schema)).properties).toEqual({
      count: { type: "number" },
      when: { type: "date" },
      kind: { type: "string" },
      currency: { type: "string", description: 'Currency code. One of: "USD", "LKR".' },
    });
  });

  it("falls back to any for shapes doc2json has no type for", async () => {
    const schema = z.object({
      mixed: z.union([z.string(), z.number()]),
      tags: z.record(z.string(), z.string()),
      empty: z.object({}),
      raw: z.unknown(),
    });
    expect((await zodToSchema(schema)).properties).toEqual({
      mixed: { type: "any" },
      tags: { type: "any" },
      empty: { type: "any" },
      raw: { type: "any" },
    });
  });

  it("converts zod/mini schemas", async () => {
    const schema = zm.object({ total: zm.nullable(zm.number()), note: zm.optional(zm.string()) });
    expect(await zodToSchema(schema)).toEqual({
      type: "object",
      properties: { total: { type: "number" }, note: { type: "string" } },
      required: ["total"],
    });
  });

  it("rejects a root that is not an object with keys", async () => {
    await expect(zodToSchema(z.string())).rejects.toBeInstanceOf(Doc2JsonError);
    await expect(zodToSchema(z.object({}))).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("names Zod 3 schemas in the error", async () => {
    const zod3 = { _def: { typeName: "ZodObject" }, safeParse: () => ({ success: true }) };
    await expect(zodToSchema(zod3 as never)).rejects.toThrow(/Zod 3/);
  });
});

describe("jsonSchemaToDefinition", () => {
  it("reads plain JSON Schema with type arrays and integer", () => {
    expect(
      jsonSchemaToDefinition({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          n: { type: ["integer", "null"] },
          d: { type: "string", format: "date" },
          s: { type: "string", format: "date-time" },
        },
        required: ["n", "missing"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: { n: { type: "number" }, d: { type: "date" }, s: { type: "string" } },
      required: ["n"],
    });
  });
});

describe("parse with a Zod schema", () => {
  const values = {
    vendor: "Acme",
    total: 12.5,
    issued: "2026-10-01",
    lineItems: [{ description: "Widget", amount: 12.5 }],
  };

  it("sends the converted schema as JSON", async () => {
    const { client, calls } = mockClient([jsonResponse({ ...OK, values })]);
    const result = await client.parse({ text: "invoice" }, { schema: Invoice });
    expect(jsonBody(calls[0]).schema).toEqual(await zodToSchema(Invoice));
    expect(result.values.total).toBe(12.5);
    expect(result.validation.success).toBe(true);
  });

  it("sends the converted schema in a multipart upload", async () => {
    const { client, calls } = mockClient([jsonResponse({ ...OK, values })]);
    await client.parse(new Uint8Array([1, 2, 3]), { schema: Invoice, filename: "a.pdf" });
    const form = calls[0]?.init.body as FormData;
    expect(JSON.parse(String(form.get("schema")))).toEqual(await zodToSchema(Invoice));
  });

  it("reports a mismatch in validation without throwing", async () => {
    const { client } = mockClient([jsonResponse({ ...OK, values: { ...values, total: "12" } })]);
    const result = await client.parse({ text: "invoice" }, { schema: Invoice });
    expect(result.validation.success).toBe(false);
    expect(result.validation.error?.issues[0]?.path).toEqual(["total"]);
    expect(result.values.total).toBe("12");
  });

  it("validates zod/mini schemas too", async () => {
    const schema = zm.object({ total: zm.number() });
    const { client } = mockClient([jsonResponse({ ...OK, values: { total: 3 } })]);
    const result = await client.parse({ text: "x" }, { schema });
    expect(result.validation).toMatchObject({ success: true, data: { total: 3 } });
  });

  it("leaves plain schemas alone, with no validation field", async () => {
    const plain = { type: "object" as const, properties: { total: { type: "number" as const } } };
    const { client, calls } = mockClient([jsonResponse(OK)]);
    const result = await client.parse({ text: "x" }, { schema: plain });
    expect(jsonBody(calls[0]).schema).toEqual(plain);
    expect("validation" in result).toBe(false);
  });

  it("converts Zod schemas in schemas.create and schemas.update", async () => {
    const record = { status: "ok", id: "1", name: "invoice", schema: {} };
    const { client, calls } = mockClient([jsonResponse(record), jsonResponse(record)]);
    await client.schemas.create({ name: "invoice", schema: Invoice });
    await client.schemas.update("invoice", { schema: Invoice });
    const expected = await zodToSchema(Invoice);
    expect(jsonBody(calls[0]).schema).toEqual(expected);
    expect(jsonBody(calls[1]).schema).toEqual(expected);
  });
});

describe("types", () => {
  it("infers values from a Zod schema", () => {
    const { client } = mockClient([]);
    const call = () => client.parse("invoice.pdf", { schema: Invoice });
    type Result = Awaited<ReturnType<typeof call>>;
    expectTypeOf<Result["values"]>().toEqualTypeOf<z.infer<typeof Invoice>>();
    expectTypeOf<Result["values"]["total"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["values"]["issued"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Result["values"]["paid"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Result["values"]["lineItems"]>().toEqualTypeOf<
      { description: string; amount: number }[]
    >();
    expectTypeOf<Result["validation"]>().toEqualTypeOf<ZodValidation<z.infer<typeof Invoice>>>();
  });

  it("infers without a generic at the call site", () => {
    const { client } = mockClient([]);
    const call = () => client.parse("invoice.pdf", { schema: Invoice });
    expectTypeOf(call)
      .returns.resolves.toHaveProperty("values")
      .toEqualTypeOf<z.infer<typeof Invoice>>();
    const mini = () =>
      client.parse("a.pdf", { schema: zm.object({ n: zm.nullable(zm.number()) }) });
    expectTypeOf(mini).returns.resolves.toHaveProperty("values").toEqualTypeOf<{
      n: number | null;
    }>();
  });

  it("keeps the plain generic and default types", () => {
    const { client } = mockClient([]);
    type Plain = { total: number | null };
    const typed = () => client.parse<Plain>("a.pdf", { schema: "invoice" });
    expectTypeOf(typed).returns.resolves.toEqualTypeOf<ParseResult<Plain>>();
    const untyped = () => client.parse("a.pdf");
    expectTypeOf(untyped).returns.resolves.toEqualTypeOf<ParseResult<Record<string, unknown>>>();
    const inline = () =>
      client.parse("a.pdf", {
        schema: { type: "object", properties: { total: { type: "number" } } },
      });
    expectTypeOf(inline).returns.resolves.toEqualTypeOf<ParseResult<Record<string, unknown>>>();
  });
});
