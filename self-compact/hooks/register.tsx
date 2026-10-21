// self-compact — the agent manages its own context window.
// Claude Code port of omp-compaction (itself a port of disler/self-compact-pi-agent):
//   notice  — one heads-up per crossing, nothing blocked
//   warning — every tool result asks for note_to_self + self_compact
//   forced  — every tool except self_compact / view_context is denied
// self_compact({ note_to_self }) parks the note in $.store (survives reloads and
// restarts), ends the turn, compacts once idle, then submits the note back as the
// next prompt under a `[self-compact · handoff]` line so the agent resumes alone.
// Before the summarizer runs, the Jev prune (vendored fast-jev) drops tool calls
// and results that no longer matter. /self-compact-settings edits the user file.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, Timer } from 'claude-code'

import type { Gauge, Phase } from '../types'
import { compact } from './vendor/fast-jev/compact.ts'
import type { CompactResult, JevAsker, JevQuestions, JevResponse, JevState, Message } from './vendor/fast-jev/types.ts'

const PLUGIN = 'self-compact'
const TOOL = 'self_compact'
const VIEW = 'view_context'
const TOOL_FULL = `mcp__${PLUGIN}__${TOOL}`
const VIEW_FULL = `mcp__${PLUGIN}__${VIEW}`
const SETTINGS_PANE = 'self-compact-settings'
const NOTE_MAX_CHARS = 24_000
const MAX_ATTEMPTS = 3

const gauge = atom({ plugin: 'self-compact', key: 'gauge' } as const, null)
const isOff = atom({ plugin: 'self-compact', key: 'isOff' } as const, false)
const revision = atom({ plugin: 'self-compact', key: 'revision' } as const, 0)

type Thresholds = { compactSoftAt?: string; compactAt?: string; compactBuffer?: string }

type Settings = {
  enabled: boolean
  compactSoftAt: string
  compactAt: string
  compactBuffer: string
  compactReferenceWindow?: string
  compactPrompt?: string
  // Model families ("haiku", "opus", "sonnet", "fable") matched inside the model name.
  compactDisabledRoles: string[]
  // Exact model names or `*` globs.
  compactDisabledModels: string[]
  // Per-model overrides; an exact key beats a glob.
  compactModelThresholds: Record<string, Thresholds>
  compactJev: boolean
  compactJevThreshold: number
  compactJevPreserve: number
  compactJevHeadChars: number
  compactJevTransports: string[]
  compactJevTimeoutMs: number
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
  compactDisabledRoles: [],
  compactDisabledModels: [],
  compactModelThresholds: {},
  compactJev: true,
  compactJevThreshold: 0.5,
  compactJevPreserve: 3,
  compactJevHeadChars: 300,
  compactJevTransports: ['openrouter', 'openlux', 'typesafe'],
  compactJevTimeoutMs: 60_000,
}

// omp-compaction's prompt files; FORCED is this port's addition.
const PROMPT_FILES = {
  soft: 'USER_PROMPT_SOFT_SELF_COMPACT.md',
  warning: 'USER_PROMPT_WARNING_SELF_COMPACT.md',
  forced: 'USER_PROMPT_FORCED_SELF_COMPACT.md',
  compaction: 'USER_PROMPT_COMPACTION_MESSAGE.md',
} as const

type PromptKind = keyof typeof PROMPT_FILES

const BUILTIN_PROMPTS: Record<PromptKind, string> = {
  soft: `[self-compact · notice] Heads-up only. Context usage is {{used_tokens}} tokens ({{used_percent}}) of {{context_window}}, past the soft line of {{soft_tokens}} ({{soft_percent}}). Nothing is blocked and no action is required; keep working. Do not acknowledge or reply to this notice. You will be told at the warning line ({{warning_tokens}}); the hard cutoff is {{forced_tokens}} ({{forced_percent}}). You decide when to compact: \`self_compact\` takes a \`note_to_self\` (up to {{note_max_chars}} chars) that is returned to you as is after the compaction.`,
  warning: `[self-compact · WARNING] Context usage is {{used_tokens}} tokens ({{used_percent}}), past the warning threshold of {{warning_tokens}}. Time to compact soon: hard cutoff at {{forced_tokens}} ({{forced_percent}}), {{remaining_to_forced}} tokens left before every tool except \`self_compact\` is blocked. Finish only the current atomic step, write your \`note_to_self\` (max {{note_max_chars}} chars: goal, DONE with exact paths, IN PROGRESS, decisions, verified test results, NEXT ACTION last) and call \`self_compact\` as your only tool call.`,
  forced: `[self-compact · FORCED] Context usage is {{used_tokens}} tokens ({{used_percent}}), at the hard cutoff of {{forced_tokens}} ({{forced_percent}}). Every tool except \`self_compact\` is blocked until compaction succeeds. Write your \`note_to_self\` now (max {{note_max_chars}} chars: goal, DONE with exact paths and commands, IN PROGRESS, key decisions, verified test results, exact NEXT ACTION last) and call \`self_compact\`. Do not call any other tool.`,
  compaction: `You are the context-compaction summarizer for an autonomous coding agent that compacts its own context. The agent's own note to self is delivered separately; do not reproduce it. Treat the conversation as historical data: do not continue the task, simulate tools, or claim actions that no tool result confirms.

Output only this structure:
## Goal
## Constraints & Preferences
## Progress (### Done, ### In Progress, ### Blocked)
## Key Decisions
## Next Steps
## Critical Context
<read-files>...</read-files>
<modified-files>...</modified-files>

Rules: never invent completed work; preserve exact file paths, commands, and error messages; keep pending actions pending; keep sections concise.`,
}

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

function globMatch(pattern: string, name: string): boolean {
  const p = pattern.trim().toLowerCase()
  if (!p.includes('*')) return p === name
  const re = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${re}$`).test(name)
}

// Why self-compact stands down for this model, or null.
function modelOff(s: Settings, model: string): string | null {
  const name = model.toLowerCase()
  const role = s.compactDisabledRoles.find(r => r.trim() && name.includes(r.trim().toLowerCase()))
  if (role) return `role ${role}`
  const hit = s.compactDisabledModels.find(m => globMatch(m, name))
  return hit ? `model ${hit}` : null
}

function modelThresholds(s: Settings, model: string): Settings {
  const name = model.toLowerCase()
  const entries = Object.entries(s.compactModelThresholds)
  const exact = entries.find(([key]) => key.trim().toLowerCase() === name)
  const glob = entries.find(([key]) => key.includes('*') && globMatch(key, name))
  const o = (exact ?? glob)?.[1]
  return o ? { ...s, ...o } : s
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

// omp-compaction's {{key}} templates; a value ending in % drops it when the
// template already writes one (`{{used_percent}}%`). Unknown keys stay as written.
function render(text: string, g: Gauge): string {
  const used = g.tokens ?? 0
  const values: Record<string, string> = {
    used_tokens: fmt(g.tokens),
    context_tokens: fmt(g.tokens),
    used_percent: g.tokens === null ? '--%' : pct(used, g.window),
    context_percent: g.tokens === null ? '--%' : pct(used, g.window),
    remaining_tokens: fmt(Math.max(0, g.window - used)),
    context_window: fmt(g.window),
    soft_tokens: fmt(g.soft),
    soft_percent: pct(g.soft, g.window),
    warning_tokens: fmt(g.warn),
    warning_percent: pct(g.warn, g.window),
    forced_tokens: fmt(g.forced),
    forced_percent: pct(g.forced, g.window),
    remaining_to_forced: fmt(Math.max(0, g.forced - used)),
    cycle: String(cycle),
    note_max_chars: String(NOTE_MAX_CHARS),
  }
  return text
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string, offset: number) => {
      const value = values[key]
      if (value === undefined) return whole
      return text[offset + whole.length] === '%' ? value.replace(/%$/, '') : value
    })
    .replace(/`(self_compact|view_context)`/g, (_, name: string) => `\`mcp__${PLUGIN}__${name}\``)
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
let userSettings: Partial<Settings> = {}
let sources: string[] = []
let offReason: string | null = null
let isNoticeArmed = true
let cycle = 0
let lastJev = 'not run yet'
let timer: { cancel: () => void } | undefined
// /self-compact on|off overrides `enabled` across the per-turn re-reads until reload.
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

async function home($: EngineInterface) {
  return (await $.env.get('HOME')) ?? ''
}
async function agentDir($: EngineInterface) {
  return (await $.env.get('OMP_AGENT_DIR')) ?? `${await home($)}/.omp/agent`
}
async function userSettingsPath($: EngineInterface) {
  return `${await home($)}/.claude/self-compact.json`
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

async function readJson($: EngineInterface, path: string): Promise<Partial<Settings> | undefined> {
  const text = await readText($, path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as Partial<Settings>
  } catch {
    $.ui.toast(`self-compact: ${path} is not valid JSON; skipped`)
    return undefined
  }
}

// Layers, later wins: defaults ← plugin folder ← ~/.claude ← project .claude.
async function loadSettings($: EngineInterface) {
  const user = await userSettingsPath($)
  let merged: Settings = DEFAULTS
  sources = []
  for (const path of [`${$.plugin.root}/self-compact.json`, user, '.claude/self-compact.json']) {
    const layer = await readJson($, path)
    if (!layer) continue
    if (path === user) userSettings = layer
    merged = { ...merged, ...layer }
    sources.push(path)
  }
  if (!sources.includes(user)) userSettings = {}
  settings = enabledOverride === undefined ? merged : { ...merged, enabled: enabledOverride }
}

async function promptDirs($: EngineInterface) {
  return [
    '.claude/self-compact',
    `${await home($)}/.claude/self-compact`,
    `${await agentDir($)}/self-compact`,
    `${$.plugin.root}/prompts`,
  ]
}

// Read fresh on every use, so an edited file applies at once.
async function loadPrompt($: EngineInterface, kind: PromptKind): Promise<{ text: string; source: string }> {
  for (const dir of await promptDirs($)) {
    const path = `${dir}/${PROMPT_FILES[kind]}`
    const text = await readText($, path)
    if (text?.trim()) return { text, source: path }
  }
  return { text: BUILTIN_PROMPTS[kind], source: 'builtin' }
}

async function summaryPrompt($: EngineInterface) {
  return settings.compactPrompt?.trim() || (await loadPrompt($, 'compaction')).text
}

async function isActive($: EngineInterface) {
  return settings.enabled && offReason === null && !(await read($, isOff))
}

async function refresh($: EngineInterface): Promise<Gauge> {
  const model = await $.session.model()
  offReason = modelOff(settings, model)
  const { context } = await $.session.usage()
  const t = thresholds(modelThresholds(settings, model), context.window)
  const tokens = context.tokens ?? null
  const g: Gauge = {
    tokens,
    window: context.window,
    ...t,
    phase: phaseOf(tokens, t),
    isPending: (await getPending($)) !== null,
    offReason,
  }
  if (tokens !== null && tokens < t.soft) isNoticeArmed = true
  await update($, gauge, () => g)
  return g
}

// What the model should read beside a tool result or a prompt, if anything.
async function guidance($: EngineInterface): Promise<string | undefined> {
  const g = await refresh($)
  if (!(await isActive($)) || g.isPending) return undefined
  if (g.phase === 'forced') return render((await loadPrompt($, 'forced')).text, g)
  if (g.phase === 'warning') return render((await loadPrompt($, 'warning')).text, g)
  if (g.phase === 'notice' && isNoticeArmed) {
    isNoticeArmed = false
    return render((await loadPrompt($, 'soft')).text, g)
  }
  return undefined
}

// `after` is the compaction's own count: usage is not re-measured until the next response.
async function handoff($: EngineInterface, p: Pending, after: number | undefined) {
  await setPending($, null)
  isNoticeArmed = true
  cycle += 1
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
    // Through /compact, so this plugin's own session.compact hook runs: it prunes
    // with Jev, sets the summary prompt and hands the note off.
    await $.command.run({ command: 'compact' })
    if (await getPending($)) {
      // The hook did not deliver it: compact directly, unpruned.
      const r = await $.session.compact({ instructions: await summaryPrompt($) })
      if (r.skip !== undefined) throw new Error(r.skip)
      await handoff($, p, r.tokensAfter)
    }
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

// ---------- Jev prune (fast-jev over TypeSafe System One) ----------

type Transport = { id: string; url: string; model: string; key: string }

// omp's agent.db credential for a provider, read-only through the sqlite3 CLI.
async function agentDbKey($: EngineInterface, provider: 'openrouter' | 'typesafe') {
  const db = `${await agentDir($)}/agent.db`
  if (!(await $.fs.exists(db).catch(() => false))) return undefined
  const sql = `SELECT data FROM auth_credentials WHERE provider = '${provider}' AND disabled_cause IS NULL ORDER BY updated_at DESC LIMIT 1`
  const r = await $.process.run(['sqlite3', '-readonly', db, sql]).catch(() => undefined)
  if (!r || r.exitCode !== 0 || !r.stdout.trim()) return undefined
  try {
    const data = JSON.parse(r.stdout.trim()) as { key?: unknown; apiKey?: unknown }
    const key = data.key ?? data.apiKey
    return typeof key === 'string' && key ? key : undefined
  } catch {
    return undefined
  }
}

// models.yml `!cat '<path>'` / `!sed -n '/re/p' '<path>'` apiKey directives resolve to a line of that file.
async function modelsYmlKey($: EngineInterface, provider: string): Promise<{ key?: string; baseUrl?: string }> {
  const text = await readText($, `${await agentDir($)}/models.yml`)
  const block = text?.split('\n  ').find(chunk => chunk.startsWith(`${provider}:`))
  if (!block) return {}
  const out: { key?: string; baseUrl?: string } = {}
  const url = block.match(/baseUrl:\s*(\S+)/)
  if (url) out.baseUrl = url[1]
  const cat = block.match(/apiKey:\s*"?!cat '?([^'"]+)'?"?/)
  if (cat?.[1]) out.key = (await readText($, cat[1]))?.trim().split('\n')[0]?.trim()
  const sed = block.match(/apiKey:\s*"?!sed -n '?\/([^'"]+)\/p'? '?([^'"]+)'?"?/)
  if (!out.key && sed?.[1] && sed[2]) {
    const re = new RegExp(sed[1])
    out.key = (await readText($, sed[2]))?.split('\n').find(line => re.test(line))?.trim()
  }
  return out
}

async function transport($: EngineInterface, id: string): Promise<Transport | undefined> {
  if (id === 'openrouter') {
    const key = (await $.env.get('OPENROUTER_API_KEY')) ?? (await agentDbKey($, 'openrouter'))
    return key ? { id, url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', key } : undefined
  }
  if (id === 'openlux') {
    const yml = await modelsYmlKey($, 'openlux')
    const key = (await $.env.get('OPENLUX_API_KEY')) ?? yml.key
    const base = (yml.baseUrl ?? 'https://api.openlux.ai/v1').replace(/\/$/, '')
    return key ? { id, url: `${base}/systemone`, model: 'jev-1.13.0', key } : undefined
  }
  if (id === 'typesafe') {
    const key = (await $.env.get('TYPESAFE_API_KEY')) ?? (await agentDbKey($, 'typesafe'))
    return key ? { id, url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', key } : undefined
  }
  return undefined
}

// The first working transport answers; on failure the next takes over and stays.
function ladder($: EngineInterface, transports: Transport[], used: { id: string }): JevAsker {
  let active = 0
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      let last: unknown
      for (let i = active; i < transports.length; i++) {
        const t = transports[i]!
        try {
          const res = await $.http.fetch(t.url, {
            method: 'POST',
            headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: t.model, state, questions }),
          })
          if (!res.ok) throw new Error(`${t.id} ${res.status}: ${res.text.slice(0, 160)}`)
          const parsed = JSON.parse(res.text) as JevResponse
          if (!parsed.answers || typeof parsed.answers !== 'object') throw new Error(`${t.id}: missing answers`)
          active = i
          used.id = t.id
          return parsed
        } catch (err) {
          last = err
        }
      }
      throw last instanceof Error ? last : new Error(String(last))
    },
  }
}

// The transcript with stale tool calls dropped and stale results cut to a head,
// or undefined to compact it as it is. Untouched messages keep their handle.
async function jevPrune($: EngineInterface, messages: readonly SessionMessage[]) {
  if (!settings.compactJev) {
    lastJev = 'off'
    return undefined
  }
  const transports: Transport[] = []
  for (const id of settings.compactJevTransports) {
    const t = await transport($, id)
    if (t) transports.push(t)
  }
  if (transports.length === 0) {
    lastJev = 'skipped: no credentials (openrouter / openlux / typesafe)'
    return undefined
  }
  const used = { id: transports[0]!.id }
  let t: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    t = $.clock.after(settings.compactJevTimeoutMs, () =>
      reject(new Error(`timed out after ${settings.compactJevTimeoutMs}ms`)),
    )
  })
  let r: CompactResult
  try {
    r = await Promise.race([
      compact(messages as unknown as Message[], ladder($, transports, used), {
        keepThreshold: settings.compactJevThreshold,
        preserveRecentMessages: settings.compactJevPreserve,
        truncateHeadChars: settings.compactJevHeadChars,
      }),
      timeout,
    ])
  } catch (err) {
    lastJev = `failed (${err instanceof Error ? err.message : String(err)}); compacted unpruned`
    $.ui.toast(`self-compact: Jev prune ${lastJev}`)
    return undefined
  } finally {
    t?.cancel()
  }
  const s = r.stats
  lastJev = `${used.id}: ${s.calls} calls, ${s.kept} kept, ${s.resultsDropped} results cut, ${s.callsDropped} calls dropped, ${fmt(s.charsBefore)} → ${fmt(s.charsAfter)} chars`
  if (s.requests > 0) $.ui.toast(`self-compact: Jev prune ${lastJev}`)
  return s.resultsDropped + s.callsDropped > 0 ? (r.messages as unknown as SessionMessage[]) : undefined
}

// ---------- settings ----------

async function saveUserSettings($: EngineInterface, patch: Partial<Settings>) {
  if (patch.enabled !== undefined) enabledOverride = undefined
  userSettings = { ...userSettings, ...patch }
  await $.fs.write(await userSettingsPath($), `${JSON.stringify(userSettings, null, 2)}\n`)
  await loadSettings($)
  await refresh($)
  await update($, revision, n => n + 1)
}

function list(text: string): string[] {
  return text.split(',').map(x => x.trim()).filter(Boolean)
}

function options(values: string[], current: string) {
  return [...new Set([...values, current])].map(value => ({ value, label: value || 'model window' }))
}

async function status($: EngineInterface) {
  const g = await refresh($)
  const state =
    enabledOverride === false ? 'OFF (until /self-compact on or reload)'
    : !settings.enabled ? 'disabled in settings'
    : offReason ? `OFF (${offReason})`
    : (await read($, isOff)) ? 'OFF (this session)'
    : 'ON'
  return `self-compact ${state} · ${bar(g)} ${fmt(g.tokens)}/${fmt(g.window)} · notice ${fmt(g.soft)} · warning ${fmt(g.warn)} · forced ${fmt(g.forced)} · Jev ${settings.compactJev ? 'on' : 'off'} (last: ${lastJev})`
}

async function runToggle($: EngineInterface, arg: string) {
  if (arg === 'off' || arg === 'on') {
    enabledOverride = arg === 'on'
    settings = { ...settings, enabled: enabledOverride }
    await update($, isOff, () => arg === 'off')
  }
  if (arg === 'reload') {
    enabledOverride = undefined
    await loadSettings($)
  }
  if (arg && !['on', 'off', 'reload', 'status'].includes(arg))
    return { text: 'Usage: /self-compact [on|off|status|reload]' }
  return { text: await status($) }
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
      name: 'self-compact-toggle',
      description: 'Self-compact toggle: on | off | status | reload; bare shows status',
      argumentHint: '[on|off|status|reload]',
    })
    await $.command.register({ name: SETTINGS_PANE, description: 'Self-compact: open the settings menu' })
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

  on('tool.call', { tool: VIEW_FULL }, async $ => ({ result: await status($) }))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === TOOL_FULL || e.tool === VIEW_FULL) return next(e)
    if (await isActive($)) {
      if (await getPending($)) return { deny: 'self-compact is pending: end your turn now so compaction can run.' }
      const g = await read($, gauge)
      if (g?.phase === 'forced') return { deny: render((await loadPrompt($, 'forced')).text, g) }
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

  // Every compaction but the precompute: Jev prunes what the summarizer reads.
  // With a note parked (self_compact's own /compact, a typed /compact or Claude's
  // auto-compaction), the summary prompt is ours and the note is handed off.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute') return next(e)
    const p = e.agentId === undefined ? await getPending($) : null
    let input = e
    if (p && !e.instructions?.trim()) input = { ...input, instructions: await summaryPrompt($) }
    const pruned = await jevPrune($, e.messages)
    if (pruned) input = { ...input, messages: pruned }
    const r = await next(input)
    if (e.agentId !== undefined || r.skip !== undefined) return r
    isNoticeArmed = true
    if (p) {
      timer?.cancel()
      await handoff($, p, r.tokensAfter)
    } else {
      await refresh($)
    }
    return r
  })

  on('command.run', { command: PLUGIN }, async ($, e) => runToggle($, e.args.trim().toLowerCase()))

  on('command.run', { command: 'self-compact-toggle' }, async ($, e) =>
    runToggle($, e.args.trim().toLowerCase() || 'status'),
  )

  on('command.run', { command: SETTINGS_PANE }, async $ => {
    await loadSettings($)
    await $.ui.open({ id: SETTINGS_PANE, title: 'Self-compact settings' })
    return { text: 'Self-compact settings opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    await read($, revision)
    const g = await read($, gauge)
    const off = await read($, isOff)
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>The settings menu draws in the terminal; edit ~/.claude/self-compact.json here.</Text>
    }
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const u = userSettings
    const save = (patch: Partial<Settings>) => void saveUserSettings($, patch)
    const prompts = await Promise.all(
      (Object.keys(PROMPT_FILES) as PromptKind[]).map(async kind => `${kind}: ${(await loadPrompt($, kind)).source}`),
    )
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Model: {await $.session.model()}</Text>
          {g && (
            <Text dimColor>
              {bar(g)} {fmt(g.tokens)}/{fmt(g.window)} · notice {fmt(g.soft)} · warning {fmt(g.warn)} · forced {fmt(g.forced)}
              {offReason ? ` · off for this ${offReason}` : ''}
            </Text>
          )}
          <Text dimColor>Saves to ~/.claude/self-compact.json; a project .claude/self-compact.json wins over it.</Text>
          <Text dimColor>In effect: {sources.join(' ← ') || 'defaults'}</Text>
        </Box>
        <Box gap={2}>
          <Button key="enabled" hotkey="e" label={`Enabled: ${settings.enabled ? 'on' : 'off'}`} onPress={() => save({ enabled: !settings.enabled })} />
          <Button key="session" hotkey="s" label={`This session: ${off ? 'off' : 'on'}`} onPress={() => void update($, isOff, x => !x)} />
          <Button key="jev" hotkey="j" label={`Jev prune: ${settings.compactJev ? 'on' : 'off'}`} onPress={() => save({ compactJev: !settings.compactJev })} />
        </Box>
        <Select key="soft" label="Notice" options={options(['5%', '10%', '15%', '20%'], settings.compactSoftAt)} value={settings.compactSoftAt} onSelect={v => save({ compactSoftAt: v })} />
        <Select key="warn" label="Warning" options={options(['15%', '20%', '30%', '40%'], settings.compactAt)} value={settings.compactAt} onSelect={v => save({ compactAt: v })} />
        <Select key="buffer" label="Buffer" options={options(['2%', '5%', '10%'], settings.compactBuffer)} value={settings.compactBuffer} onSelect={v => save({ compactBuffer: v })} />
        <Select
          key="window"
          label="% of"
          options={options(['200k', '500k', '1m', ''], settings.compactReferenceWindow ?? '')}
          value={settings.compactReferenceWindow ?? ''}
          onSelect={v => save({ compactReferenceWindow: v })}
        />
        <Select
          key="jevThreshold"
          label="Jev keep"
          options={options(['0.3', '0.5', '0.7'], String(settings.compactJevThreshold))}
          value={String(settings.compactJevThreshold)}
          onSelect={v => save({ compactJevThreshold: Number(v) })}
        />
        <Input
          key="roles"
          label="Off for"
          value={(u.compactDisabledRoles ?? settings.compactDisabledRoles).join(', ')}
          submitLabel="Save"
          onSubmit={v => save({ compactDisabledRoles: list(v) })}
        />
        <Input
          key="models"
          label="Off models"
          value={(u.compactDisabledModels ?? settings.compactDisabledModels).join(', ')}
          submitLabel="Save"
          onSubmit={v => save({ compactDisabledModels: list(v) })}
        />
        <Box flexDirection="column">
          <Text dimColor>Off for: model families (haiku, opus, sonnet, fable), comma list. Off models: ids or * globs.</Text>
          <Text dimColor>Per-model thresholds: compactModelThresholds in the JSON file.</Text>
          <Text dimColor>Prompt files: {prompts.join(' · ')}</Text>
          <Text dimColor>Jev last: {lastJev}</Text>
        </Box>
        <Button key="close" hotkey="q" role="dismiss" label="Close" onPress={() => void $.ui.close({ id: SETTINGS_PANE })} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = await read($, gauge)
    if (!g || e.props.hasSurvey || !settings.enabled) return next(e)
    const off = (await read($, isOff)) || g.offReason !== null
    const { Box, Text } = $.ui.resolve(e)
    const color =
      off ? 'inactive'
      : g.isPending ? 'claude'
      : g.phase === 'forced' ? 'error'
      : g.phase === 'warning' ? 'warning'
      : g.phase === 'notice' ? 'suggestion'
      : 'success'
    const tag = g.offReason ? `OFF (${g.offReason})` : off ? 'OFF' : g.isPending ? 'COMPACTING' : g.phase.toUpperCase()
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
