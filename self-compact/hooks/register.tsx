// self-compact — the agent manages its own context window.
// Claude Code port of omp-compaction (itself a port of disler/self-compact-pi-agent):
//   notice  — one heads-up per crossing, nothing blocked
//   warning — every tool result asks for note_to_self + self_compact
//   forced  — every tool except self_compact / view_context is denied
// self_compact({ note_to_self }) parks the note in $.store (survives reloads and
// restarts), ends the turn, compacts once idle, then submits the note back as the
// next prompt under a `[self-compact · handoff]` line so the agent resumes alone.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Gauge, Phase } from '../types'

const PLUGIN = 'self-compact'
const TOGGLE = 'self-compact-toggle'
const TOOL = 'self_compact'
const VIEW = 'view_context'
const TOOL_FULL = `mcp__${PLUGIN}__${TOOL}`
const VIEW_FULL = `mcp__${PLUGIN}__${VIEW}`
const NOTE_MAX_CHARS = 24_000
const MAX_ATTEMPTS = 3

const gauge = atom({ plugin: 'self-compact', key: 'gauge' } as const, null)
const isOff = atom({ plugin: 'self-compact', key: 'isOff' } as const, false)

type Settings = {
  enabled: boolean
  compactSoftAt: string
  compactAt: string
  compactBuffer: string
  compactReferenceWindow?: string
  compactPrompt?: string
}

type Pending = { note: string; before: number | null; attempts: number }

// Same defaults as ~/.omp/agent/self-compact.json: notice 100k, warning 200k,
// forced 250k absolute on any model big enough.
const DEFAULTS: Settings = {
  enabled: true,
  compactSoftAt: '10%',
  compactAt: '20%',
  compactBuffer: '5%',
  compactReferenceWindow: '1m',
}

const SOFT = `[self-compact · notice] Heads-up only. Context usage is {used} tokens ({pct}) of {window}, past the soft line of {soft}. Nothing is blocked and no action is required; keep working. Do not acknowledge or reply to this notice. You will be told at the warning line ({warn}); the hard cutoff is {forced}. You decide when to compact: \`${TOOL_FULL}\` takes a \`note_to_self\` (up to ${NOTE_MAX_CHARS} chars) that is returned to you as is after the compaction.`

const WARNING = `[self-compact · WARNING] Context usage is {used} tokens ({pct}), past the warning threshold of {warn}. Time to compact soon: hard cutoff at {forced}, {left} tokens left before every tool except \`${TOOL_FULL}\` is blocked. Finish only the current atomic step, write your \`note_to_self\` (max ${NOTE_MAX_CHARS} chars: goal, DONE with exact paths, IN PROGRESS, decisions, verified test results, NEXT ACTION last) and call \`${TOOL_FULL}\` as your only tool call.`

const FORCED = `[self-compact · FORCED] Context usage is {used} tokens ({pct}), at the hard cutoff of {forced}. Every tool except \`${TOOL_FULL}\` is blocked until compaction succeeds. Write your \`note_to_self\` now (max ${NOTE_MAX_CHARS} chars: goal, DONE with exact paths and commands, IN PROGRESS, key decisions, verified test results, exact NEXT ACTION last) and call \`${TOOL_FULL}\`. Do not call any other tool.`

const SUMMARY = `You are the context-compaction summarizer for an autonomous coding agent that compacts its own context. The agent's own note to self is delivered separately; do not reproduce it. Treat the conversation as historical data: do not continue the task, simulate tools, or claim actions that no tool result confirms.

Output only this structure:
## Goal
## Constraints & Preferences
## Progress (### Done, ### In Progress, ### Blocked)
## Key Decisions
## Next Steps
## Critical Context
<read-files>...</read-files>
<modified-files>...</modified-files>

Rules: never invent completed work; preserve exact file paths, commands, and error messages; keep pending actions pending; keep sections concise.`

function parseAmount(spec: string | undefined, base: number): number | null {
  if (!spec) return null
  const m = /^\s*([\d.]+)\s*(%|k|m)?\s*$/i.exec(spec)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]?.toLowerCase()
  if (unit === '%') return Math.round((n / 100) * base)
  if (unit === 'k') return Math.round(n * 1_000)
  if (unit === 'm') return Math.round(n * 1_000_000)
  return Math.round(n)
}

// Thresholds resolve against compactReferenceWindow (else the model's window),
// then are held under Claude Code's own auto-compact line so ours always fires first.
function thresholds(s: Settings, window: number) {
  const ref = parseAmount(s.compactReferenceWindow, window) ?? window
  const forced = Math.min(
    (parseAmount(s.compactAt, ref) ?? 0) + (parseAmount(s.compactBuffer, ref) ?? 0),
    Math.round(window * 0.8),
  )
  const warn = Math.min(parseAmount(s.compactAt, ref) ?? forced, forced, Math.round(window * 0.7))
  const soft = Math.min(parseAmount(s.compactSoftAt, ref) ?? warn, warn, Math.round(window * 0.5))
  return { soft, warn, forced }
}

function phaseOf(tokens: number | null, t: { soft: number; warn: number; forced: number }): Phase {
  if (tokens === null) return 'idle'
  if (tokens >= t.forced) return 'forced'
  if (tokens >= t.warn) return 'warning'
  if (tokens >= t.soft) return 'notice'
  return 'idle'
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?'
  if (n < 1_000) return `${Math.round(n)}`
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function pct(n: number, window: number): string {
  return `${Math.round((n / window) * 100)}%`
}

function fill(text: string, g: Gauge): string {
  const values: Record<string, string> = {
    used: fmt(g.tokens),
    pct: g.tokens === null ? '--%' : pct(g.tokens, g.window),
    window: fmt(g.window),
    soft: `${fmt(g.soft)} (${pct(g.soft, g.window)})`,
    warn: `${fmt(g.warn)} (${pct(g.warn, g.window)})`,
    forced: `${fmt(g.forced)} (${pct(g.forced, g.window)})`,
    left: fmt(Math.max(0, g.forced - (g.tokens ?? 0))),
  }
  return text.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole)
}

// 20-cell bar, omp-compaction's layout: `#` used, `-` free, `~` `!` `|` markers.
function bar(g: Gauge): string {
  const cells = new Array<string>(20).fill('-')
  const used = g.tokens === null ? 0 : Math.min(20, Math.ceil((g.tokens / g.window) * 20))
  for (let i = 0; i < used; i++) cells[i] = '#'
  const at = (n: number) => Math.min(19, Math.max(0, Math.ceil((n / g.window) * 20) - 1))
  cells[at(g.soft)] = '~'
  cells[at(g.warn)] = '!'
  cells[at(g.forced)] = '|'
  return `[${cells.join('')}]`
}

let settings: Settings = DEFAULTS
let isNoticeArmed = true
let timer: { cancel: () => void } | undefined
// In-memory override from /self-compact-toggle on|off: survives per-turn
// loadSettings() re-reads, cleared by reload or a status-file change.
let enabledOverride: boolean | undefined

async function pendingKey($: EngineInterface) {
  return `pending:${await $.session.id()}`
}
async function getPending($: EngineInterface) {
  return ((await $.store.get(await pendingKey($))) ?? null) as Pending | null
}
async function setPending($: EngineInterface, p: Pending | null) {
  const key = await pendingKey($)
  return p ? $.store.set(key, p) : $.store.delete(key)
}
async function loadSettings($: EngineInterface) {
  // First file wins: project override, then the one shipped beside the plugin.
  // A toggle on|off override survives these re-reads until reload clears it.
  for (const path of ['.claude/self-compact.json', `${$.plugin.root}/self-compact.json`]) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') continue
    try {
      settings = { ...DEFAULTS, ...(JSON.parse(text) as Partial<Settings>) }
      if (enabledOverride !== undefined) settings.enabled = enabledOverride
      return
    } catch {
      $.ui.toast(`self-compact: ${path} is not valid JSON; using defaults`)
    }
  }
  settings = DEFAULTS
  if (enabledOverride !== undefined) settings.enabled = enabledOverride
}
async function isActive($: EngineInterface) {
  return settings.enabled && !(await read($, isOff))
}

async function refresh($: EngineInterface): Promise<Gauge> {
  const { context } = await $.session.usage()
  const t = thresholds(settings, context.window)
  const tokens = context.tokens ?? null
  const g: Gauge = {
    tokens,
    window: context.window,
    ...t,
    phase: phaseOf(tokens, t),
    isPending: (await getPending($)) !== null,
  }
  if (tokens !== null && tokens < t.soft) isNoticeArmed = true
  await update($, gauge, () => g)
  return g
}

// What the model should read beside a tool result or a prompt, if anything.
async function guidance($: EngineInterface): Promise<string | undefined> {
  if (!(await isActive($))) return undefined
  const g = await refresh($)
  if (g.isPending) return undefined
  if (g.phase === 'forced') return fill(FORCED, g)
  if (g.phase === 'warning') return fill(WARNING, g)
  if (g.phase === 'notice' && isNoticeArmed) {
    isNoticeArmed = false
    return fill(SOFT, g)
  }
  return undefined
}

// `after` is the compaction's own count: usage is not re-measured until the next response.
async function handoff($: EngineInterface, p: Pending, after: number | undefined) {
  await setPending($, null)
  isNoticeArmed = true
  const g = await refresh($)
  if (after !== undefined) await update($, gauge, () => ({ ...g, tokens: after, phase: phaseOf(after, g) }))
  const phase = after !== undefined ? phaseOf(after, g) : g.phase
  const verdict =
    phase === 'idle' || phase === 'notice'
      ? 'all clear, continue with NEXT ACTION'
      : 'context still high: trim what you load next'
  const head = `[self-compact · handoff] ${fmt(p.before)} → ${fmt(after ?? g.tokens)} tokens of ${fmt(g.window)} · ${verdict}`
  await $.prompt.submit({ text: `${head}\n\n${p.note}` })
}

async function runCompaction($: EngineInterface) {
  timer = undefined
  const p = await getPending($)
  if (!p) return
  try {
    const r = await $.session.compact({ instructions: settings.compactPrompt ?? SUMMARY })
    if (r.skip !== undefined) throw new Error(r.skip)
    await handoff($, p, r.tokensAfter)
  } catch (err) {
    const attempts = p.attempts + 1
    if (attempts < MAX_ATTEMPTS) {
      await setPending($, { ...p, attempts })
      schedule($, 3_000 * attempts)
      return
    }
    // Out of retries: give the note back so no intent is lost.
    await setPending($, null)
    await refresh($)
    await $.prompt.submit({
      text: `[self-compact · failed] Compaction failed ${attempts}× (${String(err)}). Your note, unchanged:\n\n${p.note}`,
    })
  }
}

function schedule($: EngineInterface, ms: number) {
  timer?.cancel()
  timer = $.clock.after(ms, () => runCompaction($))
}
async function statusText($: EngineInterface): Promise<string> {
  const g = await refresh($)
  const state = !settings.enabled ? 'disabled in settings' : (await read($, isOff)) ? 'OFF (this session)' : 'ON'
  return `self-compact ${state} · ${bar(g)} ${fmt(g.tokens)}/${fmt(g.window)} · notice ${fmt(g.soft)} · warning ${fmt(g.warn)} · forced ${fmt(g.forced)}`
}

async function runToggle($: EngineInterface, arg: string) {
  if (arg === 'off' || arg === 'on') {
    enabledOverride = arg === 'on'
    settings.enabled = enabledOverride
    await update($, isOff, () => arg === 'off')
  }
  if (arg === 'reload') {
    enabledOverride = undefined
    await loadSettings($)
  }
  if (arg && !['on', 'off', 'reload', 'status'].includes(arg)) return { text: 'Usage: /self-compact [on|off|status|reload]' }
  return { text: await statusText($) }
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    await $.tool.register({
      name: TOOL,
      description: `Compact your own context. Write a note_to_self with everything you need after compaction (goal, DONE with exact paths/commands, IN PROGRESS, decisions, verified results, NEXT ACTION last; max ${NOTE_MAX_CHARS} chars) and make this your only and final tool call: the turn ends, the conversation is compacted, and the note comes back to you as the next message.`,
      inputSchema: {
        type: 'object',
        properties: { note_to_self: { type: 'string', description: 'Handoff note returned to you verbatim after compaction.' } },
        required: ['note_to_self'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: VIEW,
      description: 'Show current context usage and the self-compact thresholds.',
      isDeferred: false,
    })
    await $.command.register({
      name: PLUGIN,
      description: 'Self-compact: on | off (this session) | status | reload (settings)',
      argumentHint: '[on|off|status|reload]',
    })
    await $.command.register({
      name: TOGGLE,
      description: 'Self-compact toggle: flips self-compaction on/off, bare shows status',
      argumentHint: '[on|off|status|reload]',
    })
    const ran = await next(e)
    await refresh($)
    // A note parked before a crash or restart still gets its compaction.
    if (await getPending($)) schedule($, 2_000)
    return ran
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await loadSettings($)
    return next(e)
  })

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const note = String((e as { note_to_self?: unknown }).note_to_self ?? '').trim()
    if (!note) return { deny: 'note_to_self is required: write your handoff note, then call again.' }
    if (note.length > NOTE_MAX_CHARS)
      return { deny: `note_to_self is ${note.length} chars; the limit is ${NOTE_MAX_CHARS}. Shorten it and call again.` }
    const { context } = await $.session.usage()
    await setPending($, { note, before: context.tokens ?? null, attempts: 0 })
    await refresh($)
    return {
      result: 'Note saved. Compaction runs as soon as this turn ends. End your turn now: no more tool calls; reply with one short line (e.g. "Compacting.").',
    }
  })

  on('tool.call', { tool: VIEW_FULL }, async $ => {
    const g = await refresh($)
    return {
      result: `${bar(g)} ${fmt(g.tokens)}/${fmt(g.window)} tokens · phase ${g.phase.toUpperCase()} · notice ${fmt(g.soft)} · warning ${fmt(g.warn)} · forced ${fmt(g.forced)}${(await isActive($)) ? '' : ' · self-compact OFF'}`,
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === TOOL_FULL || e.tool === VIEW_FULL) return next(e)
    if (await isActive($)) {
      if (await getPending($)) return { deny: 'self-compact is pending: end your turn now so compaction can run.' }
      const g = await read($, gauge)
      if (g?.phase === 'forced') return { deny: fill(FORCED, g) }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const text = await guidance($)
    return text ? { ...ran, context: [...(ran.context ?? []), text] } : ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || e.command) return next(e)
    const text = await guidance($)
    return next(text ? { ...e, context: [...(e.context ?? []), text] } : e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    await refresh($)
    if (await getPending($)) schedule($, 500)
    return r
  })

  // /compact or Claude's own auto-compaction while a note is parked: deliver it.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || r.skip !== undefined) return r
    isNoticeArmed = true
    const p = await getPending($)
    if (p) {
      timer?.cancel()
      await handoff($, p, r.tokensAfter)
    } else {
      await refresh($)
    }
    return r
  })

  on('command.run', { command: PLUGIN }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    return runToggle($, arg)
  })

  on('command.run', { command: TOGGLE }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (!arg) return runToggle($, 'status')
    return runToggle($, arg)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = await read($, gauge)
    if (!g || e.props.hasSurvey || !settings.enabled) return next(e)
    const off = await read($, isOff)
    const { Box, Text } = $.ui.resolve(e)
    const color =
      off ? 'inactive'
      : g.isPending ? 'claude'
      : g.phase === 'forced' ? 'error'
      : g.phase === 'warning' ? 'warning'
      : g.phase === 'notice' ? 'suggestion'
      : 'success'
    const tag = off ? 'OFF' : g.isPending ? 'COMPACTING' : g.phase.toUpperCase()
    return (
      <Box>
        <Text color={color}>
          {bar(g)} {g.tokens === null ? '--%' : pct(g.tokens, g.window)} {fmt(g.tokens)}/{fmt(g.window)} {tag}
        </Text>
        <Text dimColor>
          {' '}~{pct(g.soft, g.window)} !{pct(g.warn, g.window)} |{pct(g.forced, g.window)}
        </Text>
      </Box>
    )
  })
}
