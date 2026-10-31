/** Base class of every error thrown by the SDK. */
export class Doc2JsonError extends Error {
  /** HTTP status, or undefined when no response was received. */
  readonly status: number | undefined;
  /** A stable machine-readable code, such as `rate_limited`. */
  readonly code: string;
  /** The `x-request-id` response header, when the server sent one. */
  readonly requestId: string | undefined;
  /** The parsed response body, when there was one. */
  readonly body: unknown;
  /** The response headers, when there was a response. */
  readonly headers: Headers | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      requestId?: string;
      body?: unknown;
      headers?: Headers;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code ?? "error";
    this.requestId = options.requestId;
    this.body = options.body;
    this.headers = options.headers;
  }
}

/** Fields that come with a failed parse. */
type CreditFields = { creditsUsed: number | undefined; creditsRemaining: number | undefined };

function credits(body: unknown): CreditFields {
  const record = isRecord(body) ? body : {};
  return {
    creditsUsed: typeof record.credits_used === "number" ? record.credits_used : undefined,
    creditsRemaining:
      typeof record.credits_remaining === "number" ? record.credits_remaining : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type APIErrorOptions = {
  status: number;
  requestId?: string;
  body?: unknown;
  headers?: Headers;
};

/** An error response from the API. */
export class APIError extends Doc2JsonError {
  declare readonly status: number;
  readonly creditsUsed: number | undefined;
  readonly creditsRemaining: number | undefined;

  constructor(message: string, options: APIErrorOptions & { code?: string }) {
    super(message, { ...options, code: options.code ?? "api_error" });
    const fields = credits(options.body);
    this.creditsUsed = fields.creditsUsed;
    this.creditsRemaining = fields.creditsRemaining;
  }
}

/** 400: the request was rejected before any credits were spent. */
export class ValidationError extends APIError {
  /** Pages in the document, when it was over the page limit. */
  readonly pages: number | undefined;
  readonly maxPages: number | undefined;

  constructor(message: string, options: APIErrorOptions) {
    super(message, { ...options, code: "validation_error" });
    const body = isRecord(options.body) ? options.body : {};
    this.pages = typeof body.pages === "number" ? body.pages : undefined;
    this.maxPages = typeof body.max_pages === "number" ? body.max_pages : undefined;
  }
}

/** 401: the API key is missing, unknown, revoked or expired. */
export class AuthenticationError extends APIError {
  constructor(message: string, options: APIErrorOptions) {
    super(message, { ...options, code: "authentication_error" });
  }
}

/** 402: the workspace does not have enough credits. Nothing was spent. */
export class InsufficientCreditsError extends APIError {
  readonly creditsRequired: number | undefined;
  /** Where to upgrade, such as `/billing`. */
  readonly upgrade: string | undefined;

  constructor(message: string, options: APIErrorOptions) {
    super(message, { ...options, code: "insufficient_credits" });
    const body = isRecord(options.body) ? options.body : {};
    this.creditsRequired =
      typeof body.credits_required === "number" ? body.credits_required : undefined;
    this.upgrade = typeof body.upgrade === "string" ? body.upgrade : undefined;
  }
}

/** 403: parsing is paused for this workspace. */
export class PermissionDeniedError extends APIError {
  constructor(message: string, options: APIErrorOptions) {
    super(message, { ...options, code: "permission_denied" });
  }
}

/** 404: the schema or route was not found. */
export class NotFoundError extends APIError {
  constructor(message: string, options: APIErrorOptions) {
    super(message, { ...options, code: "not_found" });
  }
}

/** 409: the schema name is taken, or the workspace is at its schema limit. */
export class ConflictError extends APIError {
  constructor(message: string, options: APIErrorOptions) {
    super(message, { ...options, code: "conflict" });
  }
}

/** 429: the workspace parsed too recently. Nothing was spent. */
export class RateLimitError extends APIError {
  /** Seconds to wait before trying again. */
  readonly retryAfter: number | undefined;

  constructor(message: string, options: APIErrorOptions & { retryAfter?: number }) {
    super(message, { ...options, code: "rate_limited" });
    this.retryAfter = options.retryAfter;
  }
}

/** 5xx: the server could not finish. A failed parse is refunded. */
export class InternalServerError extends APIError {
  constructor(message: string, options: APIErrorOptions) {
    super(message, { ...options, code: "server_error" });
  }
}

/** The request never got a response: network failure, DNS, TLS and so on. */
export class APIConnectionError extends Doc2JsonError {
  constructor(
    message = "Could not connect to the doc2json API.",
    options: { cause?: unknown } = {},
  ) {
    super(message, { ...options, code: "connection_error" });
  }
}

/** The request took longer than the timeout. */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "The request to the doc2json API timed out.") {
    super(message);
    (this as { code: string }).code = "timeout";
  }
}

/** The caller aborted the request with its AbortSignal. */
export class APIUserAbortError extends Doc2JsonError {
  constructor(message = "The request was aborted.", options: { cause?: unknown } = {}) {
    super(message, { ...options, code: "aborted" });
  }
}

/** Seconds from a Retry-After header or a `retry_after` body field. */
export function retryAfterSeconds(headers: Headers | undefined, body: unknown): number | undefined {
  const header = headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  }
  if (isRecord(body) && typeof body.retry_after === "number" && body.retry_after >= 0) {
    return body.retry_after;
  }
  return undefined;
}

const DEFAULT_MESSAGES: Record<number, string> = {
  401: "The API key is missing, unknown, revoked or expired.",
  402: "The workspace does not have enough credits.",
  403: "Parsing is paused for this workspace.",
  404: "Not found.",
  405: "Method not allowed.",
  409: "Conflict.",
  429: "Rate limited. Try again shortly.",
};

/** Build the typed error for an error response. */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers: Headers | undefined,
): APIError {
  const requestId = headers?.get("x-request-id") ?? undefined;
  const message =
    isRecord(body) && typeof body.message === "string" && body.message.length > 0
      ? body.message
      : (DEFAULT_MESSAGES[status] ??
        (status >= 500 ? `Server error (${status}).` : `Request failed (${status}).`));
  const options = { status, body, headers, ...(requestId ? { requestId } : {}) };
  if (status === 400 || status === 422) return new ValidationError(message, options);
  if (status === 401) return new AuthenticationError(message, options);
  if (status === 402) return new InsufficientCreditsError(message, options);
  if (status === 403) return new PermissionDeniedError(message, options);
  if (status === 404) return new NotFoundError(message, options);
  if (status === 409) return new ConflictError(message, options);
  if (status === 429) {
    const retryAfter = retryAfterSeconds(headers, body);
    return new RateLimitError(message, {
      ...options,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }
  if (status >= 500) return new InternalServerError(message, options);
  return new APIError(message, options);
}
