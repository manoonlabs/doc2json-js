import { vi } from "vitest";
import { Doc2Json, type Doc2JsonOptions } from "../src";

export type Call = { url: string; init: RequestInit };

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const OK = { status: "ok", credits_used: 1, credits_remaining: 49, values: { total: 12.5 } };

/** A client whose fetch returns the given responses in order. */
export function mockClient(
  responses: Array<Response | Error | (() => Response | Promise<Response>)>,
  options: Doc2JsonOptions = {},
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("No more mocked responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  const client = new Doc2Json({
    apiKey: "test_key",
    fetch: fetchMock as unknown as typeof fetch,
    ...options,
  });
  return { client, calls, fetchMock };
}

export function jsonBody(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body));
}

export function formBody(call: Call | undefined): FormData {
  const body = call?.init.body;
  if (!(body instanceof FormData)) throw new Error("Expected a FormData body");
  return body;
}

export function header(call: Call | undefined, name: string): string | undefined {
  return (call?.init.headers as Record<string, string> | undefined)?.[name];
}
