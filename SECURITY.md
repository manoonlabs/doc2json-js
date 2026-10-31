# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Email **admin@manoonlabs.com** with a description, the steps to reproduce it and the affected version. We aim to reply within 3 working days and will keep you updated until it is fixed.

## Supported versions

Security fixes go into the latest published version of `@manoonlabs/doc2json`.

## API keys

Never commit your doc2json API key or ship it in browser code that untrusted users can read. Load it from an environment variable, such as `DOC2JSON_API_KEY`, on your server. If a key leaks, revoke it in the doc2json console and create a new one.
