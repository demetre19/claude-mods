// calm — Claude Code port of the OMP calm.js extension (itself firstmate's fm-calm).
//   - hides tool-call / tool-result rows so the transcript reads as agent prose
//   - hides mid-turn "working notes" (text of responses that ended in tool use),
//     keeping only the final reply
//   - hides the per-turn duration row
//   - a little boat sails in place of the spinner while Claude works
//   - /calm toggles for this session; ON at every session start
// ctrl+o (the expanded transcript) still shows everything.
import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

const isOff = atom({ plugin: 'calm', key: 'isOff' } as const, false)
const frame = atom({ plugin: 'calm', key: 'frame' } as const, 0)
const notes = atom({ plugin: 'calm', key: 'notes' } as const, [])

const SEA = 30
const HULL = '\\__/'

function boat(f: number): [string, string] {
  const lap = SEA - HULL.length
  const step = f % (lap * 2)
  const x = step < lap ? step : lap * 2 - step
  const wave = Array.from({ length: SEA }, (_, i) => ((i + f) % 6 === 0 ? '-' : '~')).join('')
  const sail = `${' '.repeat(x + 1)}${step < lap ? '<|' : '|>'}`
  return [sail, wave.slice(0, x) + HULL + wave.slice(x + HULL.length)]
}

export const register: Register = on => {
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'calm', description: 'Toggle calm mode: hide tool rows and working notes', argumentHint: '[on|off]' })
    await update($, isOff, () => false)
    return next(e)
  })

  on('command.run', { command: 'calm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const off = arg === 'off' ? true : arg === 'on' ? false : !(await read($, isOff))
    await update($, isOff, () => off)
    $.ui.invalidate('ui.render')
    return { text: off ? 'Calm off: tool rows and working notes are shown.' : 'Calm on: tool rows and working notes are hidden (ctrl+o shows all).' }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      tick?.cancel()
      tick = $.clock.every(250, () => void update($, frame, f => f + 1))
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      tick?.cancel()
      tick = undefined
    }
    return next(e)
  })

  // A response that ended in tool use: its text is a working note, not the reply.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const text = r.answer.trim()
    if (e.agentId === undefined && r.stopReason === 'tool_use' && text) {
      await update($, notes, list => [...list, text].slice(-300))
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text.trim()
    if (!text || (await read($, isOff))) return next(e)
    const list = await read($, notes)
    if (!list.some(note => note.includes(text))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, isOff))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, isOff))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, isOff))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (await read($, isOff)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, isOff))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || (await read($, isOff))) return next(e)
    const [sail, sea] = boat(await read($, frame))
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="claude">{sail}</Text>
        <Text>
          <Text color="suggestion">{sea}</Text>
          <Text dimColor> {e.props.message ?? e.props.word}…</Text>
        </Text>
      </Box>
    )
  })
}
