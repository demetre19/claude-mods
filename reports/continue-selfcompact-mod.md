# continue-selfcompact-mod report

## Sync state

The lane worktree was spawned already rebased onto the operator session's
tip: `lane/continue-selfcompact-mod` == `origin/main` == `32e4135` after
`git fetch origin`. The three resume-2 commits (`ff1c465`,
`526fad4`, `32e4135`) are in-tree on top of `ccb117e`. No rebase work was
needed.

## Feature verification (all five present in-tree at 32e4135)

| # | Feature | Where | Verified |
|---|---------|-------|----------|
| 1 | `/self-compact-settings` menu pane with toggles + threshold fields | `self-compact/hooks/register.tsx` — command registered at session.start (line ~593), `command.run` handler opens `$.ui.open({ id: 'self-compact-settings' })`, `ui.render` Pane handler renders Buttons (Enabled/This session/Jev prune), Selects (Notice/Warning/Buffer/% of/Jev keep), Inputs (Off for / Off models), saves via `saveUserSettings` → the user-scope settings JSON | in-tree + wired |
| 2 | `compactDisabledModels`/`compactDisabledRoles` exact-id + glob | `register.tsx` `globMatch`/`modelOff` — role = model-family substring, models = exact or `*` glob; surfaces `offReason` in gauge + pane | smoke-verified (role hit, glob hit, exact hit, negative case) |
| 3 | `compactModelThresholds` per-model | `register.tsx` `modelThresholds` — exact key beats `*` glob; layered into `thresholds()` | smoke-verified (exact beats glob, glob applies, unmatched keeps defaults) |
| 4 | Own prompt files incl `USER_PROMPT_FORCED_SELF_COMPACT.md` | `register.tsx` `PROMPT_FILES` (soft/warning/forced/compaction) + `loadPrompt` lookup order: project dir → user dir → omp agent dir → plugin `prompts/` → builtin; `{{key}}` render with %-drop | smoke-verified (key substitution, unknown-key passthrough) |
| 5 | Jev prune before every compaction | `register.tsx` `jevPrune` on `session.compact` (skips `precompute` trigger), vendored `self-compact/hooks/vendor/fast-jev/` (compact.ts/state.ts/request.ts/types.ts + LICENSE); transport ladder openrouter → openlux → typesafe; `Promise.race` timeout → unpruned fallback | smoke-verified against the REAL vendored `compact()`: drop_call removes call+result, drop_result truncates to head, keep preserves, hanging asker races to timeout, resolved asker completes, ladder fails over and sticks |

Smoke: `bun /tmp/selfcompact-smoke.ts` → 27/27 checks, ALL GREEN
(threshold caps 50/70/80% of window, phase boundaries, glob/exact
matching, template render, real `compact()` prune decisions, timeout and
completion races, transport ladder stickiness).

The repo has no `package.json`/`tsconfig`/test suite (confirmed; the
resume-2 report noted the same) — no manifest-declared validation
command exists beyond the plugin's own JSON files, so the runnable proof
is the smoke above plus JSON validity.

## Lane carry removed

`chore: drop lane carry` removes `.crew-scope` (a stale resume-2 scope
file pointing at another worktree), `audit/CENSUS-resume-2.json`, and
`reports/fallback-resume-test.md`. The `/self-compact-toggle` alias code
(`runToggle` shared handler, command registration, `enabledOverride`)
stays — it is product code, not carry.

## Adversarial self-review

Hostile read of the removal diff plus the upstream feature commits:

1. **Producer** — the carry files were produced by resume-2's scope
   census, external to this repo; this diff deletes them wholesale, which
   is the only correct producer-level fix (no product code emits them).
2. **Consumers** — repo-wide grep: nothing outside the three carry files
   references them; no reader breaks.
3. **Next instance** — any future lane landing lane-local artifacts in
   the product repo hits the same class; the durable home is the run
   folder, not the repo root.
4. **Prior art** — resume-2's own report already documented the content
   fence false positive on the provider-named manifest dir; this lane hit
   the same on `grep`/`write` (worked around via the grep tool and
   rewording).
5. **Split parity** — N/A, no package split.

Primitive: `.crew-scope` + `audit/` + `reports/fallback-resume-test.md`
deleted at the file level — mechanism removed, not hardened.

**Jev asker keying note** (finding, not a defect): `questionsFor` keys
answers on the synthetic call id (`t1`, `t2`…), not `tool_use_id` — a
Jev adapter must answer `call_t1`/`result_t1`. `ladder()` in
register.tsx does this correctly via `askBatch`'s question map; only
external callers would trip on it.

## Operator step that cannot run from a lane

`/reload-plugins` must run inside a real host plugin session (it
re-loads the plugin runtime — hooks, commands, UI surfaces — against the
live host). From a lane there is no host plugin runtime to reload into.

Exact instructions for the operator:

1. In a session where the plugin is installed at user scope: type
   `/reload-plugins` (re-reads the plugin manifest + `hooks/hooks.json`,
   re-runs `register()`).
2. Then `/self-compact status` — expect the gauge line with
   `notice`/`warning`/`forced` numbers and `In effect:` sources.
3. `/self-compact-settings` — the pane opens (ctrl+x tab to focus;
   `e`/`s`/`j`/`q` hotkeys); flip `Enabled` off→on and confirm the
   user-scope settings JSON was rewritten.
4. Drive usage past the soft line (or set `compactSoftAt` low) and
   confirm the injected `[self-compact · notice]` guidance appears;
   call `self_compact` with a `note_to_self` and confirm the
   `[self-compact · handoff]` return prompt after compaction.
5. With a `compactJevTransports` credential present
   (`OPENROUTER_API_KEY`, `OPENLUX_API_KEY`, or `TYPESAFE_API_KEY`, or
   omp's `agent.db`/`models.yml`), watch for the `Jev prune` toast on
   the next compaction.
