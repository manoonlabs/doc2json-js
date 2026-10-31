# Changelog

All notable changes to `@manoonlabs/doc2json` are listed here. This project follows [Semantic Versioning](https://semver.org).

## 0.1.0

First release.

- `Doc2Json` client with `apiKey`, `baseUrl`, `timeout` and `maxRetries` options. The key defaults to `DOC2JSON_API_KEY`.
- `parse()` accepts a file path, `Buffer`, `Uint8Array`, `ArrayBuffer`, `Blob`, `File`, `{ base64 }` or `{ text }`.
- Parse options: `schema` (saved name or inline definition), `citations`, `export` (`xlsx` or `csv`, decoded to bytes), `filename` and `signal`.
- `whoami()` and `schemas.list()`, `schemas.get()`, `schemas.create()`, `schemas.update()`.
- Typed errors for every API status, plus connection, timeout and abort errors.
- Automatic retries with jittered backoff on 429, 5xx and network errors, honouring `Retry-After`.
- ESM, CommonJS and TypeScript types. Zero runtime dependencies.
