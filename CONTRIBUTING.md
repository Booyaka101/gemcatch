# Contributing

Thanks for considering it. This is a small tool with a deliberately small surface — that's a feature, and the bar for adding to it is "does this help someone get a background result back."

## Getting set up

```bash
git clone https://github.com/Booyaka101/gemcatch
cd gemcatch
npm install
npm test
```

You need Node.js 22+. **You do not need an API key to develop or run the tests** — the suite runs the real CLI against a mock Interactions API on localhost, so it costs nothing and works offline.

To try it for real, get a free key at <https://aistudio.google.com/apikey> (no billing account required) and:

```bash
export GEMINI_API_KEY=...
node index.js research "does this thing work"
```

Point `GEMCATCH_HOME` somewhere disposable while hacking so you don't pollute your real `~/.gemcatch`:

```bash
export GEMCATCH_HOME=/tmp/gemcatch-dev
```

## Layout

| File | Holds |
| --- | --- |
| `index.js` | CLI wiring, command actions, the daemon loop, output formatting. |
| `gemini.js` | Everything that talks to the Interactions API: both transports, pacing, retries. |
| `db.js` | SQLite store and schema migrations. |
| `status.js` | The interaction lifecycle states, shared by the other three. |
| `test-offline.js` | The whole suite: mock API + real CLI as a subprocess. |

## Things worth knowing before you change the API layer

These are all load-bearing and were each learned the hard way:

- **The API key goes in the `x-goog-api-key` header.** `Authorization: Bearer <key>` returns `401 ACCESS_TOKEN_TYPE_UNSUPPORTED` — that endpoint wants an OAuth2 token, not an API key.
- **The prompt field is `input`, not `contents`.** It accepts a plain string.
- **`output_text` is synthesised by the SDK.** Raw REST responses don't have it; the text has to be pulled out of `steps`. That's what `collectText` is for, and why the tests run through the REST path.
- **The SDK's error `.message` is a useless stub** (`400 API error occurred: {"httpMeta":{...}}`). The real payload is on `.body` as a JSON string. `friendly()` unwraps it.
- **Both transports funnel through `apiError()`** so guidance can't drift between them.
- **Every call goes through `call()`**, which paces it (`gate()`) and retries it. Add a new API operation and it must too, or it silently escapes both.
- **Concurrency is not a rate.** `mapLimit` in `index.js` bounds how many polls are open at once; `GEMCATCH_RPM` in `gemini.js` is what actually keeps a wide fan-out inside the free tier's requests-per-minute allowance. They are different limits and both matter.
- **Only transient failures retry.** 408/429/5xx and network errors, never 4xx: a bad key or bad model id fails the same way forever, so retrying it just spends the user's quota to reach the identical error. `shouldRetry()` is the one place that decides, and it's pinned by a test.
- **`agent` replaces `model` on create — they are mutually exclusive.** An agent run is submitted with `agent` and no `model`; the CLI rejects the combination before anything is written. The full preview agent ids live in ONE table (`AGENT_ALIASES` in `gemini.js`) — never hardcode them at a call site, they will be superseded.
- **An agent's report is in the FINAL step** (`steps[-1].content[0].text` per the docs); the earlier steps are its plan and interim drafts. `textFromSteps` takes the last answer-bearing step for every run — no special-casing on the agent id — and falls back to collecting everything if that step has no text.
- **Agent submissions cost dollars per task, so the spend guard is load-bearing.** Any new path that reaches `gemini.submit` with an agent must go through `confirmSpend()` first, *before* any row is written — a declined confirmation must leave the store untouched. `GEMCATCH_ASSUME_TTY=1` is the test hook that lets the suite drive the interactive y/N branch through a pipe.

## Tests

```bash
npm test
```

Every command is covered end-to-end by spawning the actual CLI against a mock server. If you add a command, add a case — the suite is one file and reads top to bottom.

Two rules that keep it honest:

- **The mock must stay faithful to the real API's shape.** If you find real behaviour that contradicts the mock, fix the mock, and say so in the PR.
- **Nothing in the suite may touch the network or need a key.** A contributor without a key should be able to run the whole thing.

## Pull requests

- Keep the style of the surrounding code. No linter is enforced; just match what's there.
- One concern per PR.
- Update `README.md` if you change behaviour, and add a `CHANGELOG.md` entry under "Unreleased".
- Say what you actually verified. "Tests pass" and "I ran it against a live key" are different claims, and both are useful — just don't blur them.

## Reporting bugs

Open an issue with what you ran, what happened, and what you expected. `gemcatch stats` and your Node version help. **Never paste your API key** — including in log output.
