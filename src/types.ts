import type { InferZod, ZodSchemaLike, ZodValidation } from "./zod";

/** A field in a schema definition. */
export type SchemaFieldType = "any" | "null" | "boolean" | "string" | "number" | "date";

export type SchemaObjectNode = {
  type: "object";
  properties: Record<string, SchemaNode>;
  required?: string[];
  description?: string;
};

export type SchemaArrayNode = {
  type: "array";
  items: SchemaNode;
  description?: string;
};

export type SchemaScalarNode = {
  type: SchemaFieldType;
  description?: string;
};

export type SchemaNode = SchemaScalarNode | SchemaArrayNode | SchemaObjectNode;

/** A schema definition: an object at the root. Dates come back as yyyy-mm-dd. */
export type SchemaDefinition = SchemaObjectNode;

/** Normalized page box `[x0, y0, x1, y1]`, fractions of the page from the top left. */
export type CitationBox = [number, number, number, number];

/**
 * - `verified`: the text was found on the page and holds the value.
 * - `fuzzy`: a close match was found.
 * - `mismatch`: the text was found but does not hold the value.
 * - `other_page`: found on a different page than cited.
 * - `unverified`: could not be checked.
 */
export type CitationStatus = "verified" | "fuzzy" | "mismatch" | "other_page" | "unverified";

/** `text_layer` for a box measured from the PDF text, `model` for scans and images. */
export type CitationSource = "text_layer" | "model";

/** Where one value was read. */
export type Citation = {
  /** 1-based page, or null for a text document. */
  page: number | null;
  /** The printed text the value was read from. */
  text: string;
  bbox: CitationBox | null;
  status: CitationStatus;
  source: CitationSource | null;
};

/** Citations keyed by value path, such as `invoice_number` or `line_items[0].amount`. */
export type CitationMap = Record<string, Citation>;

export type ExportFormat = "xlsx" | "csv";

/** The export file returned next to the JSON when `export` is set. */
export type ExportFile = {
  format: ExportFormat;
  /** Suggested file name, `<name>-<yyyy-mm-dd>.<ext>`. */
  filename: string;
  contentType: string;
  /** The file bytes as standard base64, as sent by the API. */
  content: string;
  /** The decoded file bytes, ready to write to disk or wrap in a Blob. */
  data: Uint8Array;
};

/** A successful parse. */
export type ParseResult<T = Record<string, unknown>> = {
  status: "ok";
  /** The extracted data. */
  values: T;
  credits_used: number;
  credits_remaining: number;
  /** Present when `citations: true` was sent. */
  citations?: CitationMap;
  /** Present when `export` was sent and the file could be built. */
  export?: ExportFile;
};

/** Raw base64 input. */
export type Base64Input = { base64: string; filename?: string };

/** Plain text input, such as an invoice email. */
export type TextInput = { text: string; filename?: string };

/**
 * A document to parse:
 * - a file path (Node, Bun and Deno only)
 * - bytes: `Uint8Array` (including `Buffer`) or `ArrayBuffer`
 * - a `Blob` or `File`
 * - `{ base64, filename? }`
 * - `{ text, filename? }`
 */
export type ParseInput = string | Uint8Array | ArrayBuffer | Blob | Base64Input | TextInput;

export type RequestOptions = {
  /** Cancel the request. */
  signal?: AbortSignal;
  /** Override the client timeout for this call, in milliseconds. */
  timeout?: number;
  /** Override the client retry count for this call. */
  maxRetries?: number;
};

export type ParseOptions = RequestOptions & {
  /**
   * The name of a saved schema, a definition used for this call only, or a
   * Zod 4 schema (converted for you, and `values` is typed from it).
   */
  schema?: string | SchemaDefinition | ZodSchemaLike;
  /** Ask where each value was read: page, text and bounding box. */
  citations?: boolean;
  /** Long documents only: fail the whole parse if any chunk of pages cannot be read. */
  strict?: boolean;
  /**
   * A UUID sent as `X-Job-Id`. The same key with the same request returns the
   * original job instead of running (or charging) again, for about 24 hours.
   * Defaults to a fresh UUID per call, so SDK retries are safe.
   */
  idempotencyKey?: string;
  /** Also return the result as an Excel or CSV file. */
  export?: ExportFormat;
  /** Name of the document. Defaults to the file name. */
  filename?: string;
};

export type WhoAmI = {
  status: "ok";
  workspaceId: string;
  tokenId: string;
  credits_remaining: number;
};

export type SchemaSummary = {
  id: string;
  name: string;
  keyCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SchemaRecord = SchemaSummary & { schema: SchemaDefinition };

export type CreateSchemaParams = { name: string; schema: SchemaDefinition | ZodSchemaLike };

export type UpdateSchemaParams = {
  /** New display name for the saved schema. */
  name?: string;
  /** @deprecated Use `name`. */
  newName?: string;
  schema?: SchemaDefinition | ZodSchemaLike;
};

/** Parse options with a Zod schema. */
export type ZodParseOptions<S extends ZodSchemaLike> = Omit<ParseOptions, "schema"> & { schema: S };

/** A parse with a Zod schema: `values` is typed as `z.infer<S>`, plus a `validation` result. */
export type ZodParseResult<S extends ZodSchemaLike> = ParseResult<InferZod<S>> & {
  /** `schema.safeParse(values)`. A mismatch is reported here, never thrown. */
  validation: ZodValidation<InferZod<S>>;
};

/** The state of a parse job. */
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "expired";

/** What `jobs.create()` returns: the job was accepted and is queued. */
export type JobAccepted = {
  status: "ok";
  job_id: string;
  job_status: "queued";
};

/** A parse job. The result fields are present once `job_status` is `succeeded`. */
export type Job<T = Record<string, unknown>> = {
  /** `partial` when some pages of a long document could not be read. */
  status: "ok" | "partial";
  job_id: string;
  job_status: JobStatus;
  /** The idempotency key you sent, when there was one. */
  client_job_id: string | null;
  schema: string | null;
  created_at: string;
  values?: T;
  credits_used?: number;
  credits_remaining?: number;
  citations?: CitationMap;
  warnings?: Array<{ code: string; message: string; pages?: [number, number] }>;
  /** Page ranges `[first, last]` missing from `values` in a partial result. */
  failed_page_ranges?: Array<[number, number]>;
};

/** One row of `jobs.list()`. Parsed values are not included. */
export type JobSummary = {
  job_id: string;
  job_status: JobStatus;
  created_at: string;
  schema: string | null;
  credits_used: number | null;
  client_job_id: string | null;
};

export type ListJobsParams = {
  page?: number;
  /** Up to 100. */
  pageSize?: number;
  status?: JobStatus;
  from?: Date | string;
  to?: Date | string;
  /** Find the job started with this idempotency key. */
  clientJobId?: string;
};

export type JobList = {
  jobs: JobSummary[];
  page: number;
  pageSize: number;
  total: number;
};

export type WaitForJobOptions = RequestOptions & {
  /** First delay between polls in milliseconds. Grows by half each poll up to 10 s. Defaults to 1000. */
  pollInterval?: number;
  /** Give up after this many milliseconds in total. Defaults to 600000 (10 minutes). */
  waitTimeout?: number;
};
