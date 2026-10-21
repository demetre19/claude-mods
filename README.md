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

Thresholds resolve against `compactReferenceWindow` (default `1m`), so every model compacts at the same absolute token count. Each threshold is also capped below Claude Code's own auto-compact line (notice ≤50%, warning ≤70%, forced ≤80% of the model's window), so self-compaction always fires first. To override them, put a `.claude/self-compact.json` in a project, or a `self-compact.json` in the plugin folder:

```json
{ "enabled": true, "compactSoftAt": "10%", "compactAt": "20%", "compactBuffer": "5%", "compactReferenceWindow": "1m" }
```

`/self-compact [on|off|status|reload]` turns it off or on for this session, shows the numbers, or re-reads the settings.

## calm

A port of the OMP `calm.js` extension (from firstmate's fm-calm). The transcript reads as the agent's prose:

- tool-call and tool-result rows are hidden
- mid-turn "working notes" (text of responses that ended in a tool call) are hidden, and only the final reply stays
- the per-turn duration row is hidden
- a little boat sails in place of the spinner while Claude works

ctrl+o (the expanded transcript) still shows everything. `/calm` toggles it for the session; it is ON at every session start.

## License

MIT
