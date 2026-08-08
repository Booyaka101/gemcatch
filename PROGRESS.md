# PROGRESS — gemcatch 0.4.0 (Deep Research agents)

**State: COMPLETE.** Branch `feat/deep-research-agents` (off `fix/better-sqlite3-13`, which carries the better-sqlite3 13 bump not yet on `main`), commit `c5869cc`. Version bumped 0.3.0 → 0.4.0, CHANGELOG entry written, README has the new "Research agents" section.

## Verified working (all offline, `npm test`, 64 tests green — 49 pre-existing + 15 new)

- `research`/`batch -a/--agent`: `agent` sent INSTEAD of `model` on create (both SDK-stub and REST paths asserted); aliases resolve through the one table in `gemini.js` (`deep-research` → `deep-research-preview-04-2026`, `deep-research-max` → `…-max-preview-04-2026`); unknown ids pass through and the API's 4xx surfaces unretried; `--model` + `--agent` is a clean error with zero rows written.
- Spend guard: band printed before every agent submission ($1.00–$3.00 / $3.00–$7.00, hedged "preview rates, subject to change"); batch prints N × band; interactive y/N (test hook `GEMCATCH_ASSUME_TTY=1`); non-TTY without `--yes` refused; decline → zero rows, exit 1; `--dry-run` on research and batch prints projected spend, submits nothing.
- Extraction: final answer-bearing step (docs: `steps[-1].content[0].text`) with collect-all fallback; interim agent steps never leak; citations persisted (new column), printed as `Sources:`, in `--json`.
- Migration: v1 and v0.3.0 `tasks.db` upgrade in place, all rows kept, `agent` NULL for old rows.
- `incomplete` (max_total_tokens budget pause) and agent-404-after-retention both retire cleanly; daemon converges.
- Default model now `gemini-3.5-flash-lite`.
- Packaging: `npm pack` → tarball installed in a clean scratch dir, `.bin/gemcatch --version` → 0.4.0; full worked-example session driven for real against a standalone mock (confirm-y submit → batch dry-run → daemon → get with sources → list AGENT column → stats agent tally).

## Phase 0 (all re-verified live 2026-08-08)

deep-research doc (agent ids, `agent=` vs `model=`, background mandatory, `steps[-1]`, citations, price bands + hedge); interactions-overview (55 days paid / 1 day free, three agents listed); blog 2026-07-28 (free-tier managed agents; `max_total_tokens` → `status: "incomplete"`); changelog (3.5-flash-lite GA 2026-07-21).

## Next steps (owner, from the phone)

1. Merge `fix/better-sqlite3-13` → `main` (PR #? — the dependabot-adjacent branch), then PR `feat/deep-research-agents` → `main`.
2. `npm publish` (prepublishOnly runs the suite) + `git tag v0.4.0` + GitHub release — per RELEASING.md.
3. Optional live smoke on a real key: `gemcatch research "test" -w` (free model, $0) and `gemcatch research "…" --agent deep-research --dry-run` ($0). A real agent run costs $1–$3 — owner's call.
4. Distribution: the 0.4.0 story writes itself — "the docs require background execution for Deep Research agents; gemcatch already was that client" (dev.to per the usual channel playbook).
