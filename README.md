# claude-mods

Claude Code plugins (function-hook mods) ported from Oh My Pi extensions. They are plain plugins: nothing patches the Claude Code binary, so they keep working across Claude Code updates.

## Install

At the prompt of a terminal session:

```
/plugin install self-compact --marketplace demetre19/claude-mods
/plugin install calm --marketplace demetre19/claude-mods
```

Answer `y` to add the marketplace, then pick the **user** scope so the plugin loads in every Claude Code session. From a shell:

```
claude plugin marketplace add demetre19/claude-mods
claude plugin install self-compact@claude-mods --scope user
claude plugin install calm@claude-mods --scope user
```

## self-compact

Lets a long-running agent manage its own context window. It is a port of [omp-compaction](https://github.com/demetre19/omp-compaction), which in turn comes from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent). Credit for the design goes to IndyDevDan.

- **Notice** (default 100k tokens): one heads-up reaches the model each time usage crosses the line. Nothing is blocked.
- **Warning** (200k): every tool result tells the agent to write a `note_to_self` and call `self_compact`.
- **Forced** (250k): every tool except `self_compact` and `view_context` is denied until compaction succeeds.

`self_compact({ note_to_self })` saves the note in the plugin store, so it survives reloads and restarts. The turn then ends and the conversation compacts once the session is idle. After that, the note is submitted as the next prompt under a `[self-compact · handoff]` line with the before→after token counts, and the agent continues from its `NEXT ACTION`. A failed compaction is retried 3 times; if all three fail, the note is handed back unchanged. If you run `/compact` yourself, or Claude Code auto-compacts, while a note is waiting, the note is delivered too.

A gauge above the prompt shows the context fill with the same layout as OMP: `[####~----!-|--] 41% 107.5k/262.0k NOTICE ~38% !76% |90%`. Its color tracks the phase: green, then accent, orange, red.

Thresholds resolve against `compactReferenceWindow` (default `1m`), so every model compacts at the same absolute token count. Each threshold is also capped below Claude Code's own auto-compact line (notice ≤50%, warning ≤70%, forced ≤80% of the model's window), so self-compaction always fires first.

### Settings

`/self-compact-settings` opens a menu (ctrl+x tab focuses it; `e`, `s`, `j`, `q` are hotkeys). It holds the on/off switches, the thresholds, the Jev cutoff and the model lists, and saves to `~/.claude/self-compact.json`. Settings are layered, later wins: built-in defaults ← `self-compact.json` in the plugin folder ← `~/.claude/self-compact.json` ← a project's `.claude/self-compact.json`.

```json
{
  "enabled": true,
  "compactSoftAt": "10%",
  "compactAt": "20%",
  "compactBuffer": "5%",
  "compactReferenceWindow": "1m",
  "compactDisabledRoles": ["haiku"],
  "compactDisabledModels": ["claude-sonnet-*"],
  "compactModelThresholds": { "claude-opus-*": { "compactSoftAt": "15%", "compactAt": "30%" } },
  "compactPrompt": "optional literal summary prompt",
  "compactJev": true,
  "compactJevThreshold": 0.5,
  "compactJevPreserve": 3,
  "compactJevHeadChars": 300,
  "compactJevTransports": ["openrouter", "openlux", "typesafe"],
  "compactJevTimeoutMs": 60000
}
```

- **Off for roles or models.** A role is a model family (`haiku`, `opus`, `sonnet`, `fable`) matched anywhere in the model id. `compactDisabledModels` takes exact ids or `*` globs. For a model that is off, the plugin does nothing at all, and the gauge reads `OFF (role haiku)`.
- **Per-model thresholds.** `compactModelThresholds` maps a model id or glob to its own `compactSoftAt` / `compactAt` / `compactBuffer`. An exact id beats a glob.
- `/self-compact [on|off|status|reload]` turns it off or on (`on`/`off` also override the `enabled` setting until `reload`), shows the numbers, or re-reads the settings. `/self-compact-toggle [on|off|status|reload]` is the same switch under a conflict-free name; bare, it shows the status.

### Your own prompts

You can drop in omp-compaction's prompt files: `USER_PROMPT_SOFT_SELF_COMPACT.md`, `USER_PROMPT_WARNING_SELF_COMPACT.md`, `USER_PROMPT_COMPACTION_MESSAGE.md` (the summary prompt), and this port's `USER_PROMPT_FORCED_SELF_COMPACT.md`. Lookup order, first hit wins: the project's `.claude/self-compact/`, then `~/.claude/self-compact/`, `~/.omp/agent/self-compact/`, the plugin's `prompts/`, and finally the built-in text. The files are read fresh on every use, and `compactPrompt` overrides the summary file. Templates use omp's `{{key}}` names: `used_tokens`, `used_percent`, `context_window`, `remaining_tokens`, `soft_tokens`, `soft_percent`, `warning_tokens`, `warning_percent`, `forced_tokens`, `forced_percent`, `remaining_to_forced`, `cycle`, `note_max_chars`. `` `self_compact` `` and `` `view_context` `` are rewritten to the full tool names.

### Jev prune

Before every compaction except the background precompute, [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (vendored under `self-compact/hooks/vendor/fast-jev/`, MIT) asks Jev (TypeSafe System One) whether each tool call, and each result, still matters. Stale calls are dropped, and stale results are cut to their first `compactJevHeadChars` characters, so the summarizer reads less noise. Transports are tried in order, and the first one that works stays active:

| transport | endpoint | key from |
| --- | --- | --- |
| openrouter | `openrouter.ai/api/alpha/decisions` (`typesafe/jev-1.13`) | `OPENROUTER_API_KEY`, or omp's `~/.omp/agent/agent.db` |
| openlux | `<models.yml baseUrl>/systemone` (`jev-1.13.0`) | `OPENLUX_API_KEY`, or the `apiKey` directive in omp's `models.yml` |
| typesafe | `api.typesafe.ai/v1/systemone` (`jev-latest`) | `TYPESAFE_API_KEY`, or omp's `agent.db` |

Keys are only read from these places and are never stored. With no key, a failure or a timeout, the conversation compacts unpruned. A toast reports what was pruned.

## calm

A port of the OMP `calm.js` extension (from firstmate's fm-calm). The transcript reads as the agent's prose:

- tool-call and tool-result rows are hidden
- mid-turn "working notes" (text of responses that ended in a tool call) are hidden, and only the final reply stays
- the per-turn duration row is hidden
- a little boat sails in place of the spinner while Claude works

ctrl+o (the expanded transcript) still shows everything. `/calm` toggles it for the session; it is ON at every session start.

## License

MIT
