# Releasing

Notes for the maintainer. This file is intentionally excluded from the npm
tarball (see `files` in `package.json`).

## Before the first publish

The placeholders are filled in. Each choice below is defensible but reversible —
check the ones you care about, because they get expensive to change once the
package is on npm and in someone's install script.

### 1. GitHub owner: `Booyaka101`

Taken from `git config user.name` and confirmed against the live GitHub account
(login `Booyaka101`). It appears in 10 places across 6 files — `README.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
`package.json`, `.github/ISSUE_TEMPLATE/config.yml`. If the repo will live under
a different account or an org:

```bash
grep -rl Booyaka101 --exclude-dir=node_modules --exclude-dir=.git . \
  | xargs sed -i 's/Booyaka101/the-real-owner/g'
```

Get this wrong and the CI badge, the clone URLs and the private-reporting link
all point at nothing, so it is worth one look.

### 2. Author: `Booyaka101`

`package.json` carries the username with no email. npm already lists the
publishing account, so an address there adds nothing except a scraping target.
Add `<you@example.com>` if you want to be reachable directly.

### 3. Code of Conduct contact: GitHub private reporting

`CODE_OF_CONDUCT.md` routes conduct reports through the same private form as
`SECURITY.md` rather than an email address, so nothing scrapable goes on a
public repo and there is no alias to retire later. Swap in a dedicated address
(`gemi-conduct@yourdomain`) if you'd rather have one.

### 4. License attribution

`LICENSE` reads `Copyright (c) 2026 gemi-research-daemon contributors`. That's a
real and common convention, but if you'd rather it carry your name, change it
now — it's harder once other people have contributed.

## The single best first distribution step

**Publish to npm, then post it as a reply in the comments of the July 7
background-execution announcement and its HN/Reddit threads.**

The npm publish is the blocking prerequisite — `npx gemi-research-daemon` *is*
the pitch, and the name is currently unregistered.

Then go where the pain already is. Everyone reading that announcement just
learned they can fire off background interactions, and is about to discover the
unglamorous part: they now have to babysit interaction IDs themselves. That's a
specific, freshly-created problem with a known audience and a timestamp. A
comment that says "here's a small CLI that does the client side for you" lands
better there than a cold Show HN, because the reader already has the context
that makes the tool make sense.

Lead with the one-liner, not the repo:

```
npx gemi-research-daemon research "your question"
```

## Publish

```bash
npm test                    # also runs automatically via prepublishOnly
npm pack --dry-run          # confirm the tarball contents
npm publish --access public
```

The name `gemi-research-daemon` was unregistered on npm as of 2026-07-17. Verify
before you count on it:

```bash
npm view gemi-research-daemon version
# E404 means it's still free
```

Publishing needs an npm account (`npm login`). The package is public and free.

## Push to GitHub

The repo is initialised on `main` with an initial commit, but has no remote:

```bash
gh repo create gemi-research-daemon --public --source=. --push
```

CI runs on push and needs no secrets: the test suite mocks the API, so it works
on forks and without a `GEMINI_API_KEY`.

## A note on line endings

`.gitattributes` pins the whole tree to `eol=lf`. Don't relax that. `index.js`
is the published `gemi` binary and starts with a shebang; checked out with CRLF
(the default on Windows, where `core.autocrlf=true`) it publishes as
`#!/usr/bin/env node\r`, which Linux and macOS reject with "bad interpreter".

CI can't catch it — the Unix runners check out LF whatever your setting, and the
Windows job runs the bin through an npm `.cmd` shim that never reads the
shebang. If you ever suspect it, check the tarball itself rather than the repo:

```bash
npm pack && tar -xzOf gemi-research-daemon-*.tgz package/index.js | head -c 20 | xxd | head -2
# 0d anywhere in that shebang line means it is broken for Unix users
```

## Cutting a version

1. Move the `CHANGELOG.md` "Unreleased" entries under a new version heading with a date.
2. `npm version <patch|minor|major>` — this commits and tags.
3. `git push --follow-tags`
4. `npm publish --access public`

## Verifying against the live API

The test suite never touches the network, which is a feature — but it means a
real round-trip is worth doing by hand before a release that touches
`gemini.js`:

```bash
export GEMINI_API_KEY=...        # free: https://aistudio.google.com/apikey
export GEMI_HOME=/tmp/gemi-smoke
node index.js research "name three colours" -w
node index.js research "name three animals"     # leave one in flight...
node index.js daemon --exit-when-idle -i 15     # ...and let the daemon collect it
node index.js stats
```

Do it once with `GEMI_FORCE_REST=1` too — that exercises the raw-fetch fallback,
which has a genuinely different response shape (no `output_text`; the text has
to be recovered from `steps`).

The suite pins the retry and pacing policies against a mock, but only a live key
tells you whether Google's *real* 429 body still matches what `apiError()`
expects. Worth one deliberate look if you ever touch that path.
