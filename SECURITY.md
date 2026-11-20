# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Email **admin@manoonlabs.com** with a description, the steps to reproduce it and the affected version. We aim to reply within 3 working days and will keep you updated until it is fixed.

## Supported versions

Security fixes go into the latest published version of `@manoonlabs/doxtract`.

## API keys

Never commit your Doxtract API key or ship it in browser code that untrusted users can read. Load it from an environment variable, such as `DOXTRACT_API_KEY`, on your server. If a key leaks, revoke it in the Doxtract console and create a new one.
