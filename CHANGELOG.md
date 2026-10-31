# Changelog

All notable changes to `@manoonlabs/doc2json` are listed here. This project follows [Semantic Versioning](https://semver.org).

## 0.1.0

First release.

- Zod schemas: pass a Zod 4 schema as `schema` and `values` is typed with `z.infer`, with no generic needed. The SDK converts it to a doc2json definition and adds a `validation` result (`schema.safeParse(values)`) that never throws. `schemas.create()` and `schemas.update()` accept Zod schemas too, and `zodToSchema()` shows the converted definition. `zod` is a peer dependency (`^4`), which npm 7 and later install automatically.

- `Doc2Json` client with `apiKey`, `baseUrl`, `timeout` and `maxRetries` options. The key defaults to `DOC2JSON_API_KEY`.
- `parse()` accepts a file path, `Buffer`, `Uint8Array`, `ArrayBuffer`, `Blob`, `File`, `{ base64 }` or `{ text }`.
- Parse options: `schema` (saved name or inline definition), `citations`, `export` (`xlsx` or `csv`, decoded to bytes), `filename` and `signal`.
- `whoami()` and `schemas.list()`, `schemas.get()`, `schemas.create()`, `schemas.update()`.
- Typed errors for every API status, plus connection, timeout and abort errors.
- Automatic retries with jittered backoff on 429, 5xx and network errors, honouring `Retry-After`.
- ESM, CommonJS and TypeScript types. Zero runtime dependencies besides the `zod` peer.
