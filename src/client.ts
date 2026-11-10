import { base64ToBytes } from "./encoding";
import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  Doc2JsonError,
  errorFromResponse,
  retryAfterSeconds,
} from "./errors";
import { buildParseBody, type ParseBody } from "./input";
import { resolveSchemaSlug } from "./schema-slug";
import type {
  CreateSchemaParams,
  ExportFile,
  Job,
  JobAccepted,
  JobList,
  JobSummary,
  ListJobsParams,
  ParseInput,
  ParseOptions,
  ParseResult,
  RequestOptions,
  SchemaRecord,
  SchemaSummary,
  UpdateSchemaParams,
  WaitForJobOptions,
  WhoAmI,
  ZodParseOptions,
  ZodParseResult,
} from "./types";
import { isJobId, newJobId } from "./uuid";
import { isZodSchema, resolveSchema, validateWithZod, type ZodSchemaLike } from "./zod";

export const DEFAULT_BASE_URL = "https://doc2json.manoonlabs.com";
/** The server stops a parse after 100 seconds, so wait a little longer. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;

export type Doc2JsonOptions = {
  /** Your API key. Defaults to the DOC2JSON_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to https://doc2json.manoonlabs.com. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 120000. */
  timeout?: number;
  /** Retries on 429, 5xx and network errors. Defaults to 2. */
  maxRetries?: number;
  /** A custom fetch, for tests or proxies. Defaults to the global fetch. */
  fetch?: typeof fetch;
};

type Body = { kind: "none" } | ParseBody;

type RequestSpec = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body: Body;
  options: RequestOptions;
  headers?: Record<string, string>;
  /** Sent as X-Job-Id. An `auto` key may be replaced when a retry follows a failed job. */
  jobId?: { key: string; auto: boolean };
};

const WAIT_TIMEOUT_MS = 600_000;
const MAX_POLL_INTERVAL_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The caller's key, or a fresh UUID so the SDK's own retries cannot run a parse twice. */
function jobIdFor(options: { idempotencyKey?: string }): { key: string; auto: boolean } {
  const key = options.idempotencyKey;
  if (key === undefined) return { key: newJobId(), auto: true };
  if (!isJobId(key)) {
    throw new Doc2JsonError("idempotencyKey must be a UUID (version 1 through 5).", {
      code: "invalid_input",
    });
  }
  return { key, auto: false };
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new APIUserAbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new APIUserAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter: 0.5s, 1s, 2s ... capped at 8s. */
export function backoffDelayMs(retry: number): number {
  const base = Math.min(500 * 2 ** retry, 8_000);
  return base * (0.5 + Math.random() * 0.5);
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toFormData(body: Extract<ParseBody, { kind: "multipart" }>): FormData {
  const form = new FormData();
  form.append("file", body.blob, body.filename);
  for (const [key, value] of Object.entries(body.fields)) form.append(key, value);
  return form;
}

/**
 * The doc2json client.
 *
 * ```ts
 * const doc2json = new Doc2Json({ apiKey: process.env.DOC2JSON_API_KEY });
 * const result = await doc2json.parse("invoice.pdf", { schema: "invoice" });
 * ```
 */
export class Doc2Json {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly schemas: Schemas;
  readonly jobs: Jobs;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: Doc2JsonOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("DOC2JSON_API_KEY");
    if (!apiKey) {
      throw new Doc2JsonError(
        "Missing API key. Pass { apiKey } or set the DOC2JSON_API_KEY environment variable.",
        { code: "missing_api_key" },
      );
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (typeof fetchImpl !== "function") {
      throw new Doc2JsonError("No fetch found. Use Node 18 or later, or pass { fetch }.", {
        code: "missing_fetch",
      });
    }
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.schemas = new Schemas(this);
    this.jobs = new Jobs(this);
  }

  /**
   * Extract structured JSON from a document.
   *
   * @param input A file path (Node, Bun, Deno), bytes, a Blob or File, `{ base64 }` or `{ text }`.
   * @param options schema, citations, export, filename, signal. With a Zod schema,
   *   `values` is typed from it and the result has a `validation` field.
   */
  async parse<S extends ZodSchemaLike>(
    input: ParseInput,
    options: ZodParseOptions<S>,
  ): Promise<ZodParseResult<S>>;
  async parse<T = Record<string, unknown>>(
    input: ParseInput,
    options?: ParseOptions,
  ): Promise<ParseResult<T>>;
  async parse(input: ParseInput, options: ParseOptions = {}): Promise<ParseResult<unknown>> {
    const zodSchema = isZodSchema(options.schema) ? options.schema : undefined;
    const resolved =
      options.schema === undefined
        ? options
        : { ...options, schema: await resolveSchema(options.schema) };
    const body = await buildParseBody(input, resolved);
    const raw = (await this.request({
      method: "POST",
      path: "/api/v1/parse",
      body,
      options,
      jobId: jobIdFor(options),
    })) as Record<string, unknown>;
    const result = raw as unknown as ParseResult<unknown> & { validation?: unknown };
    const exported = raw.export as Omit<ExportFile, "data"> | undefined;
    if (exported && typeof exported.content === "string") {
      result.export = { ...exported, data: base64ToBytes(exported.content) };
    }
    if (zodSchema) result.validation = await validateWithZod(zodSchema, result.values);
    return result;
  }

  /** The workspace and token behind this API key, and the credits left this month. */
  whoami(options: RequestOptions = {}): Promise<WhoAmI> {
    return this.request({
      method: "GET",
      path: "/api/v1/whoami",
      body: { kind: "none" },
      options,
    }) as Promise<WhoAmI>;
  }

  /** @internal Send one API call, with retries. */
  async request(spec: RequestSpec): Promise<unknown> {
    const maxRetries = Math.max(0, spec.options.maxRetries ?? this.maxRetries);
    const timeout = spec.options.timeout ?? this.timeout;
    const signal = spec.options.signal;
    let jobId = spec.jobId;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new APIUserAbortError();
      let response: Response;
      try {
        response = await this.#send(spec, jobId?.key, timeout, signal);
      } catch (error) {
        if (error instanceof APIUserAbortError) throw error;
        if (attempt < maxRetries) {
          await sleep(backoffDelayMs(attempt), signal);
          continue;
        }
        throw error;
      }
      const body = await readBody(response).catch(() => undefined);
      if (response.ok) {
        if (
          typeof body === "object" &&
          body !== null &&
          (body as { status?: unknown }).status === "error"
        ) {
          throw errorFromResponse(
            response.status >= 400 ? response.status : 500,
            body,
            response.headers,
          );
        }
        return body;
      }
      // A failed job replays the same failure, so retrying it only wastes time.
      const failedJob = isRecord(body) && body.job_status === "failed";
      // 429 and 503 charge nothing, so the same key is safe to send again. After
      // any other failure the key points at the failed job: a key we made is
      // replaced, and a key the caller chose is left to the caller.
      const keepsKey = response.status === 429 || response.status === 503;
      if (jobId && !keepsKey && !jobId.auto) {
        throw errorFromResponse(response.status, body, response.headers);
      }
      if (shouldRetry(response.status) && !failedJob && attempt < maxRetries) {
        if (jobId && !keepsKey) jobId = { key: newJobId(), auto: true };
        const after = retryAfterSeconds(response.headers, body);
        const delay =
          after === undefined
            ? backoffDelayMs(attempt)
            : Math.min(after * 1000, MAX_RETRY_DELAY_MS) + Math.random() * 100;
        await sleep(delay, signal);
        continue;
      }
      throw errorFromResponse(response.status, body, response.headers);
    }
  }

  async #send(
    spec: RequestSpec,
    jobId: string | undefined,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      ...spec.headers,
    };
    if (jobId) headers["X-Job-Id"] = jobId;
    let body: BodyInit | undefined;
    if (spec.body.kind === "json") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(spec.body.json);
    } else if (spec.body.kind === "multipart") {
      body = toFormData(spec.body);
    }

    try {
      return await this.#fetch(`${this.baseUrl}${spec.path}`, {
        method: spec.method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw new APIUserAbortError(undefined, { cause });
      if (timedOut) throw new APITimeoutError(`The request timed out after ${timeout} ms.`);
      throw new APIConnectionError(undefined, { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Parse jobs: start one without waiting, then fetch, list or wait for it. */
export class Jobs {
  readonly #client: Doc2Json;

  constructor(client: Doc2Json) {
    this.#client = client;
  }

  /**
   * Start a parse and return at once with its job id (`Prefer: respond-async`).
   * Fetch the result with `get()` or `wait()`. The same `idempotencyKey` with
   * the same request returns the same job without a second charge.
   */
  async create(input: ParseInput, options: ParseOptions = {}): Promise<JobAccepted> {
    const resolved =
      options.schema === undefined
        ? options
        : { ...options, schema: await resolveSchema(options.schema) };
    return (await this.#client.request({
      method: "POST",
      path: "/api/v1/parse",
      body: await buildParseBody(input, resolved),
      options,
      headers: { Prefer: "respond-async" },
      jobId: jobIdFor(options),
    })) as JobAccepted;
  }

  /**
   * Read a job. While it is queued or running only the status comes back. A
   * failed job throws the typed error for its failure, and an expired one throws
   * `ResultExpiredError`.
   */
  async get<T = Record<string, unknown>>(
    jobId: string,
    options: RequestOptions = {},
  ): Promise<Job<T>> {
    return (await this.#client.request({
      method: "GET",
      path: `/api/v1/parse/jobs/${encodeURIComponent(jobId)}`,
      body: { kind: "none" },
      options,
    })) as Job<T>;
  }

  /** List jobs, newest first. Parsed values are not included. */
  async list(params: ListJobsParams = {}, options: RequestOptions = {}): Promise<JobList> {
    const query = new URLSearchParams();
    if (params.page !== undefined) query.set("page", String(params.page));
    if (params.pageSize !== undefined) query.set("page_size", String(params.pageSize));
    if (params.status !== undefined) query.set("status", params.status);
    if (params.from !== undefined) query.set("from", new Date(params.from).toISOString());
    if (params.to !== undefined) query.set("to", new Date(params.to).toISOString());
    if (params.clientJobId !== undefined) query.set("client_job_id", params.clientJobId);
    const qs = query.toString();
    const body = (await this.#client.request({
      method: "GET",
      path: `/api/v1/parse/jobs${qs ? `?${qs}` : ""}`,
      body: { kind: "none" },
      options,
    })) as { jobs?: Array<Omit<JobSummary, "job_status"> & { status: JobSummary["job_status"] }> };
    const raw = body as unknown as { page: number; page_size: number; total: number };
    return {
      jobs: (body.jobs ?? []).map(({ status, ...rest }) => ({ ...rest, job_status: status })),
      page: raw.page,
      pageSize: raw.page_size,
      total: raw.total,
    };
  }

  /**
   * Poll a job until it succeeds and return it. A failed or expired job throws.
   * Polls start at `pollInterval` and slow down to every 10 seconds. Gives up
   * with `APITimeoutError` after `waitTimeout`; `signal` cancels earlier.
   */
  async wait<T = Record<string, unknown>>(
    jobId: string,
    options: WaitForJobOptions = {},
  ): Promise<Job<T>> {
    const { pollInterval = 1_000, waitTimeout = WAIT_TIMEOUT_MS, ...requestOptions } = options;
    const deadline = Date.now() + waitTimeout;
    let delay = pollInterval;
    for (;;) {
      const job = await this.get<T>(jobId, requestOptions);
      if (job.job_status !== "queued" && job.job_status !== "running") return job;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new APITimeoutError(`Job ${jobId} did not finish within ${waitTimeout} ms.`);
      }
      await sleep(Math.min(delay, left), options.signal);
      delay = Math.min(delay * 1.5, MAX_POLL_INTERVAL_MS);
    }
  }
}

/** Saved extraction schemas in this workspace. */
export class Schemas {
  readonly #client: Doc2Json;

  constructor(client: Doc2Json) {
    this.#client = client;
  }

  /** List the saved schemas (without their definitions). */
  async list(options: RequestOptions = {}): Promise<SchemaSummary[]> {
    const body = (await this.#client.request({
      method: "GET",
      path: "/api/v1/schemas",
      body: { kind: "none" },
      options,
    })) as { schemas?: SchemaSummary[] };
    return body.schemas ?? [];
  }

  /** Read one saved schema, including its definition. */
  async get(name: string, options: RequestOptions = {}): Promise<SchemaRecord> {
    const slug = resolveSchemaSlug(name);
    return strip(
      await this.#client.request({
        method: "GET",
        path: `/api/v1/schemas/${encodeURIComponent(slug)}`,
        body: { kind: "none" },
        options,
      }),
    );
  }

  /** Save a new named schema. */
  async create(params: CreateSchemaParams, options: RequestOptions = {}): Promise<SchemaRecord> {
    return strip(
      await this.#client.request({
        method: "POST",
        path: "/api/v1/schemas",
        body: {
          kind: "json",
          json: { name: params.name, schema: await resolveSchema(params.schema) },
        },
        options: { maxRetries: 0, ...options },
      }),
    );
  }

  /** Rename a schema, replace its definition, or both. */
  async update(
    name: string,
    params: UpdateSchemaParams,
    options: RequestOptions = {},
  ): Promise<SchemaRecord> {
    const slug = resolveSchemaSlug(name);
    const json: Record<string, unknown> = {};
    const rename = params.name ?? params.newName;
    if (rename !== undefined) json.name = rename;
    if (params.schema !== undefined) json.schema = await resolveSchema(params.schema);
    return strip(
      await this.#client.request({
        method: "PATCH",
        path: `/api/v1/schemas/${encodeURIComponent(slug)}`,
        body: { kind: "json", json },
        options,
      }),
    );
  }
}

function strip(body: unknown): SchemaRecord {
  const { status: _status, ...record } = body as SchemaRecord & { status?: string };
  return record;
}
