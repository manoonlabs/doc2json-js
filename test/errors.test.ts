import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  ConflictError,
  Doc2JsonError,
  InsufficientCreditsError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
} from "../src";
import { formBody, jsonResponse, mockClient, OK } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

describe("typed errors", () => {
  it("400 is a ValidationError with credit fields", async () => {
    const { client } = mockClient([
      jsonResponse(
        {
          status: "error",
          message: "Unknown schema: invoice",
          credits_used: 0,
          credits_remaining: 59,
        },
        400,
        { "x-request-id": "req_123" },
      ),
    ]);
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(Doc2JsonError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("Unknown schema: invoice");
    expect(error.creditsUsed).toBe(0);
    expect(error.creditsRemaining).toBe(59);
    expect(error.requestId).toBe("req_123");
  });

  it("400 over the page limit exposes pages and maxPages", async () => {
    const { client } = mockClient([
      jsonResponse({ status: "error", message: "Too many pages.", pages: 80, max_pages: 50 }, 400),
    ]);
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error.pages).toBe(80);
    expect(error.maxPages).toBe(50);
  });

  it("401 with an empty body is an AuthenticationError", async () => {
    const { client } = mockClient([new Response(null, { status: 401 })]);
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toMatch(/API key/);
    expect(error.requestId).toBeUndefined();
  });

  it("402 is an InsufficientCreditsError", async () => {
    const { client } = mockClient([
      jsonResponse(
        {
          status: "error",
          message: "Workspace is out of credits.",
          credits_required: 3,
          credits_used: 0,
          credits_remaining: 0,
          upgrade: "/billing",
        },
        402,
      ),
    ]);
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error.creditsRequired).toBe(3);
    expect(error.upgrade).toBe("/billing");
  });

  it.each([
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
  ])("%i maps to its class", async (status, Klass) => {
    const { client } = mockClient([jsonResponse({ status: "error", message: "nope" }, status)]);
    await expect(client.schemas.list()).rejects.toBeInstanceOf(Klass);
  });

  it("a 200 with status error still throws", async () => {
    const { client } = mockClient([jsonResponse({ status: "error", message: "bad" }, 200)]);
    await expect(client.whoami()).rejects.toBeInstanceOf(InternalServerError);
  });
});

describe("retries", () => {
  it("retries 429 and honours Retry-After", async () => {
    vi.useFakeTimers();
    const { client, fetchMock } = mockClient([
      jsonResponse({ status: "error", message: "slow down", retry_after: 1 }, 429, {
        "Retry-After": "2",
      }),
      jsonResponse(OK),
    ]);
    const promise = client.parse({ text: "x" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to retry_after in the body", async () => {
    vi.useFakeTimers();
    const { client, fetchMock } = mockClient([
      jsonResponse({ status: "error", message: "slow down", retry_after: 3 }, 429),
      jsonResponse(OK),
    ]);
    const promise = client.parse({ text: "x" });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toMatchObject({ status: "ok" });
  });

  it("throws RateLimitError with retryAfter once retries run out", async () => {
    const { client, fetchMock } = mockClient(
      [
        jsonResponse({ status: "error", message: "slow down", retry_after: 1 }, 429, {
          "Retry-After": "1",
        }),
      ],
      { maxRetries: 0 },
    );
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx with backoff, then throws", async () => {
    vi.useFakeTimers();
    const fail = () =>
      jsonResponse(
        { status: "error", message: "The model could not extract this document.", credits_used: 0 },
        502,
      );
    const { client, fetchMock } = mockClient([fail, fail, fail]);
    const promise = client.parse({ text: "x" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await promise;
    expect(error).toBeInstanceOf(InternalServerError);
    expect(error.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries network errors and resends the multipart body", async () => {
    vi.useFakeTimers();
    const { client, calls } = mockClient([new TypeError("fetch failed"), jsonResponse(OK)]);
    const promise = client.parse(new Uint8Array([1, 2, 3]));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ status: "ok" });
    expect(calls).toHaveLength(2);
    const file = formBody(calls[1]).get("file") as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws APIConnectionError after the last network failure", async () => {
    const { client } = mockClient([new TypeError("fetch failed")], { maxRetries: 0 });
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error.code).toBe("connection_error");
    expect(error.status).toBeUndefined();
  });

  it("does not retry 4xx other than 429", async () => {
    const { client, fetchMock } = mockClient([
      jsonResponse({ status: "error", message: "bad" }, 400),
    ]);
    await expect(client.parse({ text: "x" })).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry schema creation by default", async () => {
    const { client, fetchMock } = mockClient([
      jsonResponse({ status: "error", message: "x" }, 500),
    ]);
    await expect(
      client.schemas.create({ name: "a", schema: { type: "object", properties: {} } }),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
}

describe("timeout and abort", () => {
  it("times out", async () => {
    const { client } = mockClient([], {
      timeout: 20,
      maxRetries: 0,
      fetch: hangingFetch() as unknown as typeof fetch,
    });
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(APITimeoutError);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error.code).toBe("timeout");
  });

  it("per-call timeout overrides the client", async () => {
    const { client } = mockClient([], {
      timeout: 60_000,
      maxRetries: 0,
      fetch: hangingFetch() as unknown as typeof fetch,
    });
    await expect(client.parse({ text: "x" }, { timeout: 10 })).rejects.toBeInstanceOf(
      APITimeoutError,
    );
  });

  it("aborts an in-flight request", async () => {
    const { client } = mockClient([], { fetch: hangingFetch() as unknown as typeof fetch });
    const controller = new AbortController();
    const promise = client.parse({ text: "x" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it("does not send when the signal is already aborted", async () => {
    const { client, fetchMock } = mockClient([jsonResponse(OK)]);
    const controller = new AbortController();
    controller.abort();
    await expect(client.parse({ text: "x" }, { signal: controller.signal })).rejects.toBeInstanceOf(
      APIUserAbortError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborting during a retry wait stops the retry", async () => {
    const controller = new AbortController();
    const { client, fetchMock } = mockClient([
      jsonResponse({ status: "error", message: "slow" }, 429, { "Retry-After": "30" }),
      jsonResponse(OK),
    ]);
    const promise = client.parse({ text: "x" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toBeInstanceOf(APIUserAbortError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
