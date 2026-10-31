# doc2json for JavaScript and TypeScript

[![npm version](https://img.shields.io/npm/v/@manoonlabs/doc2json.svg)](https://www.npmjs.com/package/@manoonlabs/doc2json)
[![CI](https://github.com/manoonlabs/doc2json-js/actions/workflows/ci.yml/badge.svg)](https://github.com/manoonlabs/doc2json-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@manoonlabs/doc2json.svg)](./LICENSE)

The official JavaScript/TypeScript SDK for [doc2json](https://doc2json.manoonlabs.com): turn PDFs and images into structured JSON.

- TypeScript-first, fully typed
- Zero runtime dependencies, built on native `fetch`
- Works in Node 18+, Bun, Deno and browsers (ESM and CommonJS)
- Citations with bounding boxes for every value
- Typed errors and automatic retries

Sign up at [doc2json.manoonlabs.com](https://doc2json.manoonlabs.com) and get **50 free credits** every month, no card needed. One credit is one page. See how doc2json scores on the [benchmark](https://doc2json.manoonlabs.com/benchmark).

## Install

```sh
npm install @manoonlabs/doc2json
```

## Quick start

```ts
import { Doc2Json } from "@manoonlabs/doc2json";
const doc2json = new Doc2Json({ apiKey: process.env.DOC2JSON_API_KEY });
const { values } = await doc2json.parse("invoice.pdf", { schema: "invoice" });
```

Create an API key in the doc2json console. If you leave out `apiKey`, the client reads `DOC2JSON_API_KEY` from the environment.

## Inputs

`parse()` takes the document in whatever form you have it:

```ts
// A file path (Node, Bun and Deno)
await doc2json.parse("./invoice.pdf");

// Bytes: Buffer, Uint8Array or ArrayBuffer
await doc2json.parse(await fs.readFile("invoice.pdf"), { filename: "invoice.pdf" });

// A Blob or File, for example from an <input type="file">
await doc2json.parse(input.files[0]);

// Base64 (a data: URL prefix is removed for you)
await doc2json.parse({ base64: pdfBase64, filename: "invoice.pdf" });

// Plain text, such as an invoice email
await doc2json.parse({ text: "Invoice INV-1042 from Northwind Supply. Total 1280.50 USD." });
```

PDF, PNG, JPEG and UTF-8 text files work. The type is read from the file bytes, not the name. Files, bytes and paths are uploaded as `multipart/form-data`; base64 and text are sent as JSON.

## Schemas

Without a schema, the model picks the fields. Pass the name of a schema saved in your workspace, or a definition for this call only:

```ts
type Invoice = {
  vendor: string | null;
  total: number | null;
  issued: string | null; // yyyy-mm-dd
  lineItems: { description: string; amount: number }[];
};

const result = await doc2json.parse<Invoice>("invoice.pdf", {
  schema: {
    type: "object",
    properties: {
      vendor: { type: "string" },
      total: { type: "number" },
      issued: { type: "date" },
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
    required: ["vendor", "total"],
  },
});

result.values.total; // number | null
```

Field types are `string`, `number`, `boolean`, `date`, `array`, `object`, `null` and `any`. A value the model cannot find is `null`, and an array field is always an array (`[]` when there are no rows).

Manage saved schemas:

```ts
await doc2json.schemas.list(); // [{ id, name, keyCount, createdAt, updatedAt }]
await doc2json.schemas.get("invoice"); // includes .schema, the definition
await doc2json.schemas.create({ name: "invoice", schema });
await doc2json.schemas.update("invoice", { newName: "invoice-v2", schema });
```

## Citations with bounding boxes

Set `citations: true` to learn where each value was read. It costs nothing extra.

```ts
const result = await doc2json.parse("invoice.pdf", { citations: true });

result.citations?.["total"];
// {
//   page: 1,
//   text: "Total due 1,280.50",
//   bbox: [0.62, 0.81, 0.93, 0.84],
//   status: "verified",
//   source: "text_layer"
// }
result.citations?.["lineItems[0].amount"];
```

- Keys are value paths, such as `total` or `lineItems[0].amount`.
- `bbox` is `[x0, y0, x1, y1]` as fractions of the page from the top left, or `null`. Multiply by the rendered page size to draw a highlight.
- `status` is `verified`, `fuzzy`, `mismatch`, `other_page` or `unverified`.
- `source` is `text_layer` (measured from the PDF text), `model` (scans and images) or `null`.
- Text documents get no boxes.

## Excel and CSV export

```ts
import { writeFile } from "node:fs/promises";

const result = await doc2json.parse("invoice.pdf", { schema: "invoice", export: "xlsx" });
result.values; // the JSON is always returned
if (result.export) await writeFile(result.export.filename, result.export.data);
```

`export.data` is the decoded file as a `Uint8Array`. `export.content` is the original base64 and `export.contentType` is the MIME type.

## Credits and identity

```ts
const result = await doc2json.parse("invoice.pdf");
result.credits_used; // 1
result.credits_remaining; // 49

await doc2json.whoami(); // { workspaceId, tokenId, credits_remaining }
```

## Error handling

Every error extends `Doc2JsonError`, which has `status`, `code`, `message` and `requestId` (when the server sent one).

```ts
import {
  AuthenticationError,
  Doc2JsonError,
  InsufficientCreditsError,
  RateLimitError,
  ValidationError,
} from "@manoonlabs/doc2json";

try {
  await doc2json.parse("invoice.pdf", { schema: "invoice" });
} catch (error) {
  if (error instanceof ValidationError) console.error("Bad request:", error.message);
  else if (error instanceof AuthenticationError) console.error("Check your API key");
  else if (error instanceof InsufficientCreditsError)
    console.error("Out of credits:", error.upgrade);
  else if (error instanceof RateLimitError) console.error(`Retry in ${error.retryAfter}s`);
  else if (error instanceof Doc2JsonError) console.error(error.code, error.message);
  else throw error;
}
```

| Class                      | When                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `ValidationError`          | 400: bad input, unknown schema, too many pages. Nothing is spent. |
| `AuthenticationError`      | 401: missing, unknown, revoked or expired key                     |
| `InsufficientCreditsError` | 402: not enough credits. Has `creditsRequired` and `upgrade`.     |
| `PermissionDeniedError`    | 403: parsing is paused for the workspace                          |
| `NotFoundError`            | 404: schema not found                                             |
| `ConflictError`            | 409: schema name taken, or schema limit reached                   |
| `RateLimitError`           | 429: one parse per second per workspace. Has `retryAfter`.        |
| `InternalServerError`      | 5xx: the parse failed or timed out. The charge is refunded.       |
| `APIConnectionError`       | No response: network, DNS or TLS failure                          |
| `APITimeoutError`          | The request took longer than `timeout`                            |
| `APIUserAbortError`        | You aborted the request with `signal`                             |

API errors also carry `creditsUsed` and `creditsRemaining` when the server sends them.

## Retries, timeouts and cancellation

Requests that fail with 429, 5xx or a network error are retried twice by default, with jittered exponential backoff. A `Retry-After` header (or `retry_after` in the body) is honoured. Creating a schema is not retried.

```ts
const doc2json = new Doc2Json({
  timeout: 120_000, // ms per attempt, the default
  maxRetries: 2, // the default
});

const controller = new AbortController();
await doc2json.parse("invoice.pdf", { signal: controller.signal, timeout: 60_000, maxRetries: 0 });
```

## Runtime support

| Runtime  | Supported                                             |
| -------- | ----------------------------------------------------- |
| Node.js  | 18 and later                                          |
| Bun      | Yes                                                   |
| Deno     | Yes (`npm:@manoonlabs/doc2json`)                      |
| Browsers | Yes, with `Blob`, `File`, bytes, base64 or text input |

File paths are read with `node:fs`, loaded only when you pass a path, so browser bundles stay clean. In the browser, do not expose a secret API key to untrusted users: call doc2json from your server, or use a key you are happy to share.

## Options

| Option       | Default                           |                                        |
| ------------ | --------------------------------- | -------------------------------------- |
| `apiKey`     | `DOC2JSON_API_KEY`                | Your API key                           |
| `baseUrl`    | `https://doc2json.manoonlabs.com` | API origin                             |
| `timeout`    | `120000`                          | Milliseconds per attempt               |
| `maxRetries` | `2`                               | Retries on 429, 5xx and network errors |
| `fetch`      | global `fetch`                    | A custom fetch, for proxies or tests   |

## Documentation

- [API docs](https://doc2json.manoonlabs.com/docs)
- [Benchmark](https://doc2json.manoonlabs.com/benchmark)
- [Example script](./examples/basic.ts)
- [Changelog](./CHANGELOG.md)

## License

[MIT](./LICENSE), Copyright (c) 2026 ManoonLabs
