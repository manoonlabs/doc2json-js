import { Doc2JsonError } from "./errors";
import type { SchemaDefinition, SchemaNode, SchemaObjectNode } from "./types";

/**
 * Any Zod 4 schema (`zod` or `zod/mini`). Matched by shape, so the SDK never
 * imports zod unless you pass a Zod schema.
 */
export type ZodSchemaLike = {
  readonly _zod: { readonly def: unknown; readonly output: unknown };
};

/** The output type of a Zod schema, the same as `z.infer<S>`. */
export type InferZod<S extends ZodSchemaLike> = S["_zod"]["output"];

/** A Zod issue, as found on `validation.error.issues`. */
export type ZodIssueLike = {
  code?: string;
  path: PropertyKey[];
  message: string;
};

/**
 * The result of checking `values` against your Zod schema with `safeParse`.
 * The parse never throws on a mismatch; check `success` yourself.
 */
export type ZodValidation<T> =
  | { success: true; data: T; error?: undefined }
  | { success: false; data?: undefined; error: Error & { issues: ZodIssueLike[] } };

type JsonSchema = Record<string, unknown>;

type ZodRuntime = {
  _zod: { def: { type?: unknown } };
  toJSONSchema?: (params?: unknown) => unknown;
  safeParse?: (data: unknown) => unknown;
};

type ZodCore = {
  toJSONSchema(schema: unknown, params?: unknown): unknown;
  safeParse(schema: unknown, data: unknown): unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a Zod 4 schema. Checks the shape, not `instanceof`, so any copy of zod works. */
export function isZodSchema(value: unknown): value is ZodSchemaLike {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const internals = (value as { _zod?: unknown })._zod;
  return isRecord(internals) && isRecord(internals.def);
}

/** A Zod 3 schema has `_def` and `safeParse` but no `_zod`. */
function isZod3Schema(value: unknown): boolean {
  return (
    isRecord(value) &&
    !("_zod" in value) &&
    isRecord(value._def) &&
    typeof value.safeParse === "function"
  );
}

let corePromise: Promise<ZodCore> | undefined;

/** Load zod only when a schema has no method we can call directly (zod/mini). */
function loadCore(): Promise<ZodCore> {
  corePromise ??= import("zod/v4/core").then(
    (mod) => mod as unknown as ZodCore,
    (cause) => {
      corePromise = undefined;
      throw new Doc2JsonError("Could not load zod. Install it with `npm i zod`.", {
        code: "invalid_schema",
        cause,
      });
    },
  );
  return corePromise;
}

const JSON_SCHEMA_PARAMS = {
  target: "draft-2020-12",
  io: "output",
  unrepresentable: "any",
  override(ctx: { zodSchema: unknown; jsonSchema: JsonSchema }) {
    // A Date has no JSON form. doc2json reads it as a yyyy-mm-dd date.
    const def = (ctx.zodSchema as ZodRuntime)._zod?.def;
    if (def?.type === "date") {
      ctx.jsonSchema.type = "string";
      ctx.jsonSchema.format = "date";
    }
  },
};

const NULL_NODE: SchemaNode = { type: "null" };

function isNullSchema(value: unknown): boolean {
  return isRecord(value) && value.type === "null" && Object.keys(value).length === 1;
}

function withDescription<T extends SchemaNode>(node: T, description: unknown): T {
  if (typeof description !== "string" || description.trim().length === 0) return node;
  return { ...node, description: description.trim() };
}

/** Join an enum's values into the field hint, so the reader knows the allowed values. */
function enumHint(description: unknown, values: unknown[]): string {
  const list = `One of: ${values.map((value) => JSON.stringify(value)).join(", ")}.`;
  if (typeof description !== "string" || description.trim().length === 0) return list;
  const trimmed = description.trim();
  return /[.!?]$/.test(trimmed) ? `${trimmed} ${list}` : `${trimmed}. ${list}`;
}

function scalarType(value: unknown): "string" | "number" | "boolean" | "null" | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return undefined;
}

/** The one non-null type of a node, or undefined when there are several. */
function pickType(schema: JsonSchema): string | undefined {
  const raw = schema.type;
  if (typeof raw === "string") return raw === "integer" ? "number" : raw;
  if (Array.isArray(raw)) {
    const types = [...new Set(raw.map((t) => (t === "integer" ? "number" : t)))];
    const nonNull = types.filter((t) => t !== "null");
    if (nonNull.length === 1) return nonNull[0] as string;
    if (nonNull.length === 0 && types.includes("null")) return "null";
    return undefined;
  }
  if ("const" in schema) return scalarType(schema.const);
  if (Array.isArray(schema.enum)) {
    const types = [...new Set(schema.enum.map(scalarType))].filter((t) => t !== "null");
    return types.length === 1 ? types[0] : undefined;
  }
  if (isRecord(schema.properties)) return "object";
  if ("items" in schema) return "array";
  return undefined;
}

function convertNode(schema: unknown): SchemaNode {
  if (!isRecord(schema)) return { type: "any" };

  // .nullable() and .optional().nullable() come out as anyOf [T, null].
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
  if (Array.isArray(union)) {
    const rest = union.filter((member) => !isNullSchema(member));
    if (rest.length === 1 && isRecord(rest[0])) {
      const inner = convertNode(rest[0]);
      return withDescription(inner, schema.description ?? inner.description);
    }
    if (rest.length === 0 && union.length > 0)
      return withDescription(NULL_NODE, schema.description);
    return withDescription({ type: "any" }, schema.description);
  }

  const type = pickType(schema);
  switch (type) {
    case "string": {
      const node: SchemaNode = { type: schema.format === "date" ? "date" : "string" };
      if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return { ...node, description: enumHint(schema.description, schema.enum) };
      }
      return withDescription(node, schema.description);
    }
    case "number":
    case "boolean": {
      if (Array.isArray(schema.enum) && schema.enum.length > 1) {
        return { type, description: enumHint(schema.description, schema.enum) };
      }
      return withDescription({ type }, schema.description);
    }
    case "null":
      return withDescription(NULL_NODE, schema.description);
    case "array": {
      const items = isRecord(schema.items) ? convertNode(schema.items) : { type: "any" as const };
      return withDescription({ type: "array", items }, schema.description);
    }
    case "object": {
      const object = convertObject(schema);
      return object ?? withDescription({ type: "any" }, schema.description);
    }
    default:
      return withDescription({ type: "any" }, schema.description);
  }
}

/** An object with named keys. A record or an empty object has none, so it returns undefined. */
function convertObject(schema: JsonSchema): SchemaObjectNode | undefined {
  if (!isRecord(schema.properties)) return undefined;
  const keys = Object.keys(schema.properties);
  if (keys.length === 0) return undefined;
  const properties: Record<string, SchemaNode> = {};
  for (const key of keys) properties[key] = convertNode(schema.properties[key]);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string" && key in properties)
    : [];
  const node: SchemaObjectNode = { type: "object", properties };
  if (required.length > 0) node.required = required;
  return withDescription(node, schema.description);
}

/**
 * Turn a JSON Schema, such as the output of `z.toJSONSchema()`, into a doc2json
 * schema definition. `$schema`, `additionalProperties`, patterns and bounds are
 * dropped; `integer` becomes `number`; `format: "date"` becomes `date`; a type
 * with `null` keeps the other type, since every doc2json value can be null.
 * Anything with no doc2json form, such as a union of two types, becomes `any`.
 */
export function jsonSchemaToDefinition(schema: unknown): SchemaDefinition {
  const root = isRecord(schema) ? convertObject(schema) : undefined;
  if (!root) {
    throw new Doc2JsonError(
      "A Zod schema for doc2json must be a z.object() with at least one key.",
      { code: "invalid_schema" },
    );
  }
  return root;
}

async function toJsonSchema(schema: ZodSchemaLike): Promise<unknown> {
  const runtime = schema as unknown as ZodRuntime;
  try {
    if (typeof runtime.toJSONSchema === "function") {
      return runtime.toJSONSchema(JSON_SCHEMA_PARAMS);
    }
    const core = await loadCore();
    return core.toJSONSchema(schema, JSON_SCHEMA_PARAMS);
  } catch (cause) {
    if (cause instanceof Doc2JsonError) throw cause;
    throw new Doc2JsonError(
      `Could not convert the Zod schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      { code: "invalid_schema", cause },
    );
  }
}

/**
 * Convert a Zod 4 schema into the doc2json schema definition sent to the API.
 *
 * ```ts
 * const definition = await zodToSchema(z.object({ total: z.number().nullable() }));
 * // { type: "object", properties: { total: { type: "number" } }, required: ["total"] }
 * ```
 */
export async function zodToSchema(schema: ZodSchemaLike): Promise<SchemaDefinition> {
  if (!isZodSchema(schema)) {
    throw new Doc2JsonError(
      isZod3Schema(schema)
        ? "Zod 3 schemas are not supported. Upgrade to zod 4 (`npm i zod@4`)."
        : "Expected a Zod 4 schema.",
      { code: "invalid_schema" },
    );
  }
  return jsonSchemaToDefinition(await toJsonSchema(schema));
}

/** Pass a Zod schema through `zodToSchema`, and anything else through unchanged. */
export async function resolveSchema<T>(schema: T | ZodSchemaLike): Promise<T | SchemaDefinition> {
  if (isZodSchema(schema)) return zodToSchema(schema);
  if (isZod3Schema(schema)) return zodToSchema(schema as unknown as ZodSchemaLike);
  return schema as T;
}

/** Check parsed values against the schema. Never throws on a mismatch. */
export async function validateWithZod<T>(
  schema: ZodSchemaLike,
  values: unknown,
): Promise<ZodValidation<T>> {
  const runtime = schema as unknown as ZodRuntime;
  if (typeof runtime.safeParse === "function") {
    return runtime.safeParse(values) as ZodValidation<T>;
  }
  const core = await loadCore();
  return core.safeParse(schema, values) as ZodValidation<T>;
}
