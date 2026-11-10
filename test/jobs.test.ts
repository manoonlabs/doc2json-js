import { describe, expect, it } from "vitest";
import {
  APITimeoutError,
  APIUserAbortError,
  ConflictError,
  IdempotencyKeyReusedError,
  InternalServerError,
  ModelTimeoutError,
  PayloadTooLargeError,
  ResultExpiredError,
  ServiceUnavailableError,
} from "../src";
import { isJobId, newJobId } from "../src/uuid";
import { header, jsonBody, jsonResponse, mockClient, OK } from "./helpers";

const KEY = "3f2b8c1e-5d4a-4b6c-9e7f-1a2b3c4d5e6f";
const ACCEPTED = { status: "ok", job_id: "job_1", job_status: "queued" };
const running = { status: "ok", job_id: "job_1", job_status: "running" };
const done = { ...OK, job_id: "job_1", job_status: "succeeded" };

describe("uuid", () => {
  it("a generated job id is a version 4 uuid the api accepts", () => {
    expect(isJobId(newJobId())).toBe(true);
  });

  it("a job id that is not a uuid is refused", () => {
    expect(isJobId("not-a-uuid")).toBe(false);
  });
});

describe("jobs.create", () => {
  it("starting a job sends Prefer respond-async and returns the job id", async () => {
    const { client, calls } = mockClient([jsonResponse(ACCEPTED, 202)]);
    const job = await client.jobs.create({ text: "x" }, { schema: "invoice" });
    expect(job.job_id).toBe("job_1");
    expect(calls[0]?.url).toContain("/api/v1/parse");
    expect(header(calls[0], "Prefer")).toBe("respond-async");
  });

  it("starting a job sends the idempotency key as X-Job-Id", async () => {
    const { client, calls } = mockClient([jsonResponse(ACCEPTED, 202)]);
    await client.jobs.create({ text: "x" }, { idempotencyKey: KEY });
    expect(header(calls[0], "X-Job-Id")).toBe(KEY);
  });

  it("an idempotency key that is not a uuid is refused before any request", async () => {
    const { client, fetchMock } = mockClient([]);
    await expect(client.jobs.create({ text: "x" }, { idempotencyKey: "abc" })).rejects.toThrow(
      /UUID/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the strict option is sent with the request", async () => {
    const { client, calls } = mockClient([jsonResponse(ACCEPTED, 202)]);
    await client.jobs.create({ text: "x" }, { strict: true });
    expect(jsonBody(calls[0]).strict).toBe(true);
  });
});

describe("jobs.get and jobs.list", () => {
  it("getting a job reads its path and returns the result", async () => {
    const { client, calls } = mockClient([jsonResponse(done)]);
    const job = await client.jobs.get("job_1");
    expect(calls[0]?.url).toContain("/api/v1/parse/jobs/job_1");
    expect(job.values).toEqual({ total: 12.5 });
  });

  it("a failed job throws the typed error with its job id and is not retried", async () => {
    const body = {
      status: "error",
      message: "The model timed out.",
      job_id: "job_1",
      job_status: "failed",
      credits_used: 0,
    };
    const { client, fetchMock } = mockClient([jsonResponse(body, 504)]);
    const error = await client.jobs.get("job_1").catch((e) => e);
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect(error.jobId).toBe("job_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an expired result throws ResultExpiredError", async () => {
    const { client } = mockClient([jsonResponse({ status: "error", message: "gone" }, 410)]);
    await expect(client.jobs.get("job_1")).rejects.toBeInstanceOf(ResultExpiredError);
  });

  it("listing jobs sends the filters and maps the page fields", async () => {
    const { client, calls } = mockClient([
      jsonResponse({
        status: "ok",
        jobs: [
          {
            job_id: "job_1",
            status: "succeeded",
            created_at: "2026-01-01T00:00:00.000Z",
            schema: "invoice",
            credits_used: 1,
            client_job_id: KEY,
          },
        ],
        page: 2,
        page_size: 5,
        total: 6,
      }),
    ]);
    const list = await client.jobs.list({
      page: 2,
      pageSize: 5,
      status: "succeeded",
      clientJobId: KEY,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("page_size")).toBe("5");
    expect(url.searchParams.get("status")).toBe("succeeded");
    expect(url.searchParams.get("client_job_id")).toBe(KEY);
    expect(list.pageSize).toBe(5);
    expect(list.jobs[0]?.job_status).toBe("succeeded");
  });
});

describe("jobs.wait", () => {
  it("waiting polls until the job succeeds", async () => {
    const { client, fetchMock } = mockClient([
      jsonResponse(running),
      jsonResponse(running),
      jsonResponse(done),
    ]);
    const job = await client.jobs.wait("job_1", { pollInterval: 1 });
    expect(job.job_status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("waiting gives up with a timeout error after waitTimeout", async () => {
    const { client } = mockClient([
      jsonResponse(running),
      jsonResponse(running),
      jsonResponse(running),
    ]);
    await expect(
      client.jobs.wait("job_1", { pollInterval: 5, waitTimeout: 8 }),
    ).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("aborting while waiting stops the polling", async () => {
    const controller = new AbortController();
    const { client } = mockClient([jsonResponse(running)]);
    const pending = client.jobs.wait("job_1", { pollInterval: 1000, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(APIUserAbortError);
  });
});

describe("idempotency and retries", () => {
  it("parse sends a generated uuid as X-Job-Id", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ text: "x" });
    expect(isJobId(header(calls[0], "X-Job-Id") ?? "")).toBe(true);
  });

  it("parse sends the caller's idempotency key", async () => {
    const { client, calls } = mockClient([jsonResponse(OK)]);
    await client.parse({ text: "x" }, { idempotencyKey: KEY });
    expect(header(calls[0], "X-Job-Id")).toBe(KEY);
  });

  it("a 503 is retried with the same key and Retry-After is honoured", async () => {
    const unavailable = jsonResponse(
      { status: "error", message: "down", failure_code: "SERVICE_UNAVAILABLE" },
      503,
      { "Retry-After": "0" },
    );
    const { client, calls } = mockClient([unavailable, jsonResponse(OK)]);
    await client.parse({ text: "x" });
    expect(calls).toHaveLength(2);
    expect(header(calls[1], "X-Job-Id")).toBe(header(calls[0], "X-Job-Id"));
  });

  it("a 503 that outlasts the retries throws ServiceUnavailableError with retryAfter", async () => {
    const body = { status: "error", message: "down", failure_code: "SERVICE_UNAVAILABLE" };
    const { client } = mockClient([jsonResponse(body, 503, { "Retry-After": "7" })], {
      maxRetries: 0,
    });
    const error = await client.parse({ text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toBeInstanceOf(InternalServerError);
    expect(error.retryAfter).toBe(7);
    expect(error.failureCode).toBe("SERVICE_UNAVAILABLE");
  });

  it("a 429 is retried with the same key", async () => {
    const { client, calls } = mockClient([
      jsonResponse({ status: "error", message: "slow", retry_after: 0 }, 429, {
        "Retry-After": "0",
      }),
      jsonResponse(OK),
    ]);
    await client.parse({ text: "x" });
    expect(header(calls[1], "X-Job-Id")).toBe(header(calls[0], "X-Job-Id"));
  });

  it("a network error is retried with the same key", async () => {
    const { client, calls } = mockClient([new TypeError("fetch failed"), jsonResponse(OK)]);
    await client.parse({ text: "x" });
    expect(header(calls[1], "X-Job-Id")).toBe(header(calls[0], "X-Job-Id"));
  });

  it("a failed parse is retried under a new generated key", async () => {
    const { client, calls } = mockClient([
      jsonResponse({ status: "error", message: "bad" }, 502),
      jsonResponse(OK),
    ]);
    await client.parse({ text: "x" });
    expect(header(calls[1], "X-Job-Id")).not.toBe(header(calls[0], "X-Job-Id"));
  });

  it("a failed parse under the caller's own key is not retried", async () => {
    const { client, fetchMock } = mockClient([
      jsonResponse({ status: "error", message: "bad" }, 502),
    ]);
    await expect(client.parse({ text: "x" }, { idempotencyKey: KEY })).rejects.toBeInstanceOf(
      InternalServerError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a reused key throws IdempotencyKeyReusedError and is not retried", async () => {
    const body = {
      status: "error",
      message: "reused",
      failure_code: "IDEMPOTENCY_KEY_REUSED",
      job_id: "job_1",
    };
    const { client, fetchMock } = mockClient([jsonResponse(body, 409)]);
    const error = await client.parse({ text: "x" }, { idempotencyKey: KEY }).catch((e) => e);
    expect(error).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.jobId).toBe("job_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 413 throws PayloadTooLargeError and is not retried", async () => {
    const { client, fetchMock } = mockClient([
      jsonResponse({ status: "error", message: "big" }, 413),
    ]);
    await expect(client.parse({ text: "x" })).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
