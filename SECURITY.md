# Security Policy

## Supported versions

The latest published version on npm is the only one that gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/gemi-research-daemon/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this tool touches

Worth knowing if you're assessing risk — the surface is small but not empty:

- **Your API key** is read from the `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) environment variable. It is sent to Google over HTTPS in the `x-goog-api-key` header, and it is **never written to `tasks.db`, never logged, and never printed** — including in error output.
- **Your prompts and results are stored unencrypted** in SQLite at `~/.gemi/tasks.db` (or `GEMI_HOME`). Anyone who can read that file can read your research. It's an ordinary file with ordinary permissions — treat it like your shell history.
- **`GEMI_BASE_URL` redirects every API call**, key included. It exists for proxies, gateways and the test suite. Don't point it at a host you don't trust, and be aware that anything setting it in your environment can capture your key.
- **Network egress** is limited to `generativelanguage.googleapis.com`, unless you override `GEMI_BASE_URL`.

## Scope

In scope: anything that leaks the API key, leaks the task store to another local user, or lets a crafted API response cause code execution.

Out of scope: what the model itself says. Prompt injection and model output are Google's domain, not this tool's — `gemi` prints the response it is handed.
