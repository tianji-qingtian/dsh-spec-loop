/**
 * dsh-spec-loop — host half.
 *
 * Spec-driven development loop for DeepSeek Harness: a `/spec` command family
 * drives propose → approve → implement → verify → archive with
 * OpenSpec-compatible change directories under `<workspace>/openspec/`.
 *
 * Architecture (per REQUIREMENTS): commands orchestrate and touch the
 * filesystem only; proposal/implementation content generation is steered to
 * the agent's main model (`agent.steer`), verification runs as a bounded
 * judge call through `ctx.llm.stream` (flash by default, main model with
 * `--deep`).
 *
 * State machine: `proposed --approve--> approved --implement--> implemented
 * --verify--> verified --archive--> archived`, folded by a session projection
 * (`specLoop`) from KNOWN session events only — `command/run`/`command/done`
 * pairs (the command lifecycle events, logged by the commands runtime) and
 * `assistant/message` (machine-readable markers the steered agent emits).
 * Out-of-repo plugins must not append custom event types (the persistence
 * read path refuses unknown non-ignorable types), so every transition rides
 * standard vocabulary. The gate check (`implement` refuses non-approved
 * changes) reads the same projection, so behavior state and display state
 * stay in sync across restarts.
 *
 * Task progress x/y: the implement prompt makes the agent mirror tasks.md
 * into the standard `todo_write` tool, whose `todos` projection the client
 * reads — no RPC.
 */
import z from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['commands', 'llm', 'fs', 'shell', 'sessionProjections']

const ID = 'dsh-spec-loop'

const FLASH_RE = /(flash|chat|mini|turbo|haiku|lite|air|nano)/i
const STRONG_RE = /(pro|reasoner|opus|sonnet|max|ultra|premium|r1)/i

/** Change ids: kebab-case, verb-led, ASCII — same envelope OpenSpec uses. */
const CHANGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Agent must end its proposal/implementation reply with this exact line. */
const CHANGE_ID_MARKER_RE = /SPEC_CHANGE_ID[:=]\s*([a-z0-9][a-z0-9-]{1,63})/i
const IMPLEMENTED_MARKER_RE = /SPEC_IMPLEMENTED\b/

export const STATUSES = ['proposing', 'proposed', 'approved', 'implementing', 'implemented', 'verified', 'archived']

const IMPLEMENTABLE = ['approved', 'implementing', 'implemented']

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function hasZh(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''))
}

/** Split `/spec <sub> <rest>` raw input into its subcommand and argument. */
export function parseSpecArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/)
  const sub = parts[0] || ''
  const rest = parts.slice(1)
  return { sub, arg: rest.join(' '), first: rest[0] || '' }
}

/** Concatenated text of one assistant/user message's text blocks. */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

/**
 * Parse an OpenSpec delta file into its ADDED/MODIFIED/REMOVED sections and
 * requirement blocks. `body` keeps the original lines below the
 * `### Requirement:` header so merges and judges see the full text.
 */
export function parseDelta(text) {
  const lines = String(text || '').split(/\r?\n/)
  const sections = []
  let current = null
  let req = null
  for (const line of lines) {
    const h2 = line.match(/^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/i)
    if (h2) {
      current = { kind: h2[1].toUpperCase(), requirements: [] }
      sections.push(current)
      req = null
      continue
    }
    const h3 = line.match(/^###\s+(?:Requirement:\s*)?(.+?)\s*$/)
    if (h3 && current) {
      req = { name: h3[1].trim(), body: [line] }
      current.requirements.push(req)
      continue
    }
    if (current) {
      if (req) req.body.push(line)
    }
  }
  return sections
}

/** Text-level OpenSpec delta validation: sections, requirements, scenarios. */
export function validateDeltaText(text) {
  const lines = String(text || '').split(/\r?\n/)
  const sections = []
  let current = null
  let req = null
  for (const line of lines) {
    const h2 = line.match(/^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/i)
    if (h2) {
      current = { kind: h2[1].toUpperCase(), requirements: [] }
      sections.push(current)
      req = null
      continue
    }
    const h3 = line.match(/^###\s+(?:Requirement:\s*)?(.+?)\s*$/)
    if (h3 && current) {
      req = { name: h3[1].trim(), scenarios: 0 }
      current.requirements.push(req)
      continue
    }
    if (current && req && /^####\s+Scenario/.test(line)) req.scenarios++
  }
  const errors = []
  if (sections.length === 0) errors.push('missing section: ## ADDED|MODIFIED|REMOVED Requirements')
  for (const section of sections) {
    if (section.requirements.length === 0) {
      errors.push(`${section.kind} section has no ### Requirement entries`)
    }
    for (const r of section.requirements) {
      if (r.scenarios === 0) errors.push(`requirement "${r.name}" has no #### Scenario`)
    }
  }
  return { ok: errors.length === 0, errors, sections }
}

/** Count tasks.md checklist items: total and checked. */
export function countTasks(text) {
  const lines = String(text || '').split(/\r?\n/)
  let total = 0
  let done = 0
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]/)
    if (m) {
      total++
      if (m[1] !== ' ') done++
    }
  }
  return { total, done }
}

/**
 * Merge one delta file's requirements into a canonical spec body.
 * ADDED appends, MODIFIED replaces the same-named requirement (or appends
 * when absent), REMOVED drops it. Returns the new text and whether anything
 * changed.
 */
export function mergeDelta(deltaText, targetText) {
  const sections = parseDelta(deltaText)
  let out = targetText == null ? '' : targetText
  let changed = false
  for (const section of sections) {
    for (const req of section.requirements) {
      const block = ['### Requirement: ' + req.name, ...req.body.slice(1)].join('\n')
      if (section.kind === 'REMOVED') {
        const removed = removeRequirementBlock(out, req.name)
        if (removed.changed) {
          out = removed.text
          changed = true
        }
      } else if (section.kind === 'MODIFIED') {
        const replaced = replaceRequirementBlock(out, req.name, block)
        if (replaced.changed) {
          out = replaced.text
        } else {
          out = appendRequirementBlock(out, block)
        }
        changed = true
      } else {
        out = appendRequirementBlock(out, block)
        changed = true
      }
    }
  }
  return { text: out, changed }
}

function ensureRequirementsSection(text) {
  if (/^##\s+Requirements\s*$/m.test(text)) return text
  const base = text.trimEnd()
  return base + (base === '' ? '' : '\n\n') + '## Requirements\n'
}

function appendRequirementBlock(text, block) {
  const withSection = ensureRequirementsSection(text)
  return withSection.trimEnd() + '\n\n' + block.trimEnd() + '\n'
}

function replaceRequirementBlock(text, name, block) {
  const lines = String(text || '').split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s+(?:Requirement:\s*)?(.+?)\s*$/)
    if (m && m[1].trim() === name) {
      start = i
      for (let j = i + 1; j < lines.length; j++) {
        if (/^###\s/.test(lines[j])) { end = j; break }
      }
      break
    }
  }
  if (start === -1) return { changed: false, text }
  const next = [...lines.slice(0, start), ...block.split(/\r?\n/), ...lines.slice(end)]
  return { changed: true, text: next.join('\n') }
}

function removeRequirementBlock(text, name) {
  const lines = String(text || '').split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s+(?:Requirement:\s*)?(.+?)\s*$/)
    if (m && m[1].trim() === name) {
      start = i
      for (let j = i + 1; j < lines.length; j++) {
        if (/^###\s/.test(lines[j])) { end = j; break }
      }
      break
    }
  }
  if (start === -1) return { changed: false, text }
  const next = [...lines.slice(0, start), ...lines.slice(end)]
  return { changed: true, text: next.join('\n') }
}

// ---------------------------------------------------------------------------
// Session projection: the durable state machine, folded from standard events
// ---------------------------------------------------------------------------

export const projectionSchema = z.object({
  initialized: z.boolean(),
  change: z.union([z.null(), z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(STATUSES),
    seq: z.number(),
  })]),
})

export function initSpecState() {
  return { initialized: false, change: null, pending: {} }
}

function trimPending(pending) {
  const keys = Object.keys(pending)
  if (keys.length <= 16) return pending
  const next = {}
  for (const key of keys.slice(-16)) next[key] = pending[key]
  return next
}

function transition(state, sub, arg, seq) {
  const change = state.change
  if (sub === 'init') return { ...state, initialized: true }
  if (sub === 'new') {
    return {
      ...state,
      change: { id: '', title: arg.trim().slice(0, 200) || '(untitled)', status: 'proposing', seq },
    }
  }
  if (sub === 'edit') {
    const id = arg.trim().split(/\s+/)[0] || (change ? change.id : '')
    return {
      ...state,
      change: { id, title: change ? change.title : id, status: 'proposed', seq },
    }
  }
  if (sub === 'approve' || sub === 'implement' || sub === 'verify' || sub === 'archive') {
    const status = sub === 'approve' ? 'approved'
      : sub === 'implement' ? 'implementing'
      : sub === 'verify' ? 'verified'
      : 'archived'
    const id = arg.trim().split(/\s+/)[0]
    if (!id) return state
    const title = change && change.id === id ? change.title : id
    return { ...state, change: { id, title, status, seq } }
  }
  return state
}

/**
 * The specLoop projection unit. `apply` is pure: command lifecycle pairs
 * drive transitions (on `command/done` success — never on `command/run`
 * alone, so a failed handler cannot move the machine), and assistant
 * messages carry the agent's machine-readable completion markers.
 */
export function applySpecEvent(state, event) {
  if (event.type === 'command/run' && event.data && event.data.name === 'spec') {
    const parsed = parseSpecArgs(event.data.args)
    if (!parsed.sub) return state
    const pending = trimPending({
      ...state.pending,
      [String(event.data.commandId)]: { sub: parsed.sub, arg: parsed.arg },
    })
    if (pending === state.pending) return state
    return { ...state, pending }
  }
  if (event.type === 'command/done' && event.data) {
    const key = String(event.data.commandId)
    const entry = state.pending && state.pending[key]
    if (!entry) return state
    const pending = { ...state.pending }
    delete pending[key]
    let next = { ...state, pending }
    if (event.data.kind === 'success') {
      next = transition(next, entry.sub, entry.arg, Number(event.seq ?? 0))
    }
    if (next === state) return state
    return next
  }
  if (event.type === 'assistant/message') {
    const change = state.change
    if (!change) return state
    const text = messageText(event.data && event.data.message)
    if (change.status === 'proposing') {
      const m = text.match(CHANGE_ID_MARKER_RE)
      if (m) {
        return { ...state, change: { ...change, id: m[1], status: 'proposed', seq: Number(event.seq ?? 0) } }
      }
    }
    if (change.status === 'implementing' && IMPLEMENTED_MARKER_RE.test(text)) {
      return { ...state, change: { ...change, status: 'implemented', seq: Number(event.seq ?? 0) } }
    }
  }
  return state
}

export function viewSpecState(state) {
  return { initialized: state.initialized, change: state.change }
}

// ---------------------------------------------------------------------------
// Filesystem helpers over ctx.fs (workspace-rooted, relative paths)
// ---------------------------------------------------------------------------

async function fsStat(ctx, cwd, rel, signal) {
  try {
    const target = await ctx.fs.resolve(rel, { cwd, signal })
    return await ctx.fs.stat(target, signal)
  } catch (error) {
    return undefined
  }
}

async function fsRead(ctx, cwd, rel, signal) {
  try {
    const target = await ctx.fs.resolve(rel, { cwd, signal })
    const info = await ctx.fs.stat(target, signal)
    if (!info || info.type !== 'file') return null
    return await ctx.fs.readText(target, signal)
  } catch (error) {
    return null
  }
}

async function fsWrite(ctx, cwd, rel, content, signal) {
  const target = await ctx.fs.resolve(rel, { cwd, signal })
  await ctx.fs.writeText(target, content, undefined, signal)
}

async function fsList(ctx, cwd, rel, signal) {
  try {
    const target = await ctx.fs.resolve(rel, { cwd, signal })
    const info = await ctx.fs.stat(target, signal)
    if (!info || info.type !== 'directory') return []
    return await ctx.fs.listDir(target, signal)
  } catch (error) {
    return []
  }
}

async function shellRun(ctx, cwd, command, signal) {
  const spec = ctx.shell.resolve({ command, workdir: cwd, timeoutMs: 15000, signal })
  return await ctx.shell.run(spec)
}

/** Quote a path for POSIX sh single-quoting. */
function shQuote(path) {
  return "'" + String(path).replace(/'/g, `'\\''`) + "'"
}

// ---------------------------------------------------------------------------
// Validation over the filesystem
// ---------------------------------------------------------------------------

/**
 * List one change's spec delta files (OpenSpec layout:
 * `changes/<id>/specs/<capability>/spec.md`; a file placed directly under
 * specs/ is also accepted and names its own capability).
 */
async function listDeltaFiles(ctx, cwd, changeId, signal) {
  const dirRel = `openspec/changes/${changeId}/specs`
  const entries = await fsList(ctx, cwd, dirRel, signal)
  const deltas = []
  for (const entry of entries) {
    if (entry.type === 'file' && entry.name.endsWith('.md')) {
      deltas.push({ cap: entry.name.replace(/\.md$/, ''), rel: `${dirRel}/${entry.name}` })
    } else if (entry.type === 'directory' && !entry.name.startsWith('.')) {
      const files = await fsList(ctx, cwd, `${dirRel}/${entry.name}`, signal)
      for (const file of files) {
        if (file.type === 'file' && file.name.endsWith('.md')) {
          deltas.push({ cap: entry.name, rel: `${dirRel}/${entry.name}/${file.name}` })
        }
      }
    }
  }
  return deltas
}

export async function validateChange(ctx, cwd, id, signal) {
  const errors = []
  const warnings = []
  if (!CHANGE_ID_RE.test(id)) {
    return { ok: false, errors: [`change id "${id}" is not kebab-case ASCII`], warnings }
  }
  const dirRel = `openspec/changes/${id}`
  const dirInfo = await fsStat(ctx, cwd, dirRel, signal)
  if (!dirInfo || dirInfo.type !== 'directory') {
    return { ok: false, errors: [`${dirRel} does not exist`], warnings }
  }
  const proposal = await fsRead(ctx, cwd, `${dirRel}/proposal.md`, signal)
  if (proposal === null || proposal.trim() === '') errors.push(`${dirRel}/proposal.md missing or empty`)
  const tasks = await fsRead(ctx, cwd, `${dirRel}/tasks.md`, signal)
  if (tasks === null) {
    errors.push(`${dirRel}/tasks.md missing`)
  } else if (countTasks(tasks).total === 0) {
    errors.push(`${dirRel}/tasks.md has no - [ ] checklist items`)
  }
  const deltas = await listDeltaFiles(ctx, cwd, id, signal)
  if (deltas.length === 0) {
    errors.push(`${dirRel}/specs/ has no spec delta files`)
  } else {
    for (const delta of deltas) {
      const text = await fsRead(ctx, cwd, delta.rel, signal)
      const check = validateDeltaText(text === null ? '' : text)
      for (const err of check.errors) errors.push(`${delta.rel}: ${err}`)
      if (check.ok && text !== null && !/\r?\n$/.test(text)) warnings.push(`${delta.rel}: no trailing newline`)
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function newProposalPrompt(cwd, goal, answersText) {
  const zh = hasZh(goal)
  return [
    zh
      ? `你正在 ${cwd}/openspec/changes/<change-id>/ 下创建一份 OpenSpec 变更提案。`
      : `You are creating an OpenSpec change proposal in ${cwd}/openspec/changes/<change-id>/.`,
    zh
      ? '先读 openspec/project.md 与 openspec/specs/ 下的现有规格。产出：'
      : 'Read openspec/project.md and openspec/specs/ first. Produce:',
    '1. proposal.md — Why / What Changes / Impact 三节',
    "2. tasks.md — 有序的 `- [ ]` 实现清单（不要嵌套子项）",
    '3. specs/<capability>/spec.md — 规格增量：## ADDED Requirements（或 MODIFIED/REMOVED），每条 Requirement 至少一个 #### Scenario:',
    '',
    zh ? `变更目标：${goal}` : `Goal: ${goal}`,
    ...(answersText ? ['', answersText] : []),
    '',
    zh
      ? '要求：change-id 用 kebab-case、动词开头（如 add-user-login）；不要开始实现；完成后不要勾选 tasks.md 的复选框。'
      : 'Requirements: pick a kebab-case, verb-led change-id (e.g. add-user-login); do not start implementing; leave tasks.md checkboxes unticked.',
    zh
      ? '最后单独输出一行（这是机器标记，必须原样）：SPEC_CHANGE_ID: <change-id>'
      : 'End your reply with a single line containing exactly (machine marker, verbatim): SPEC_CHANGE_ID: <change-id>',
  ].join('\n')
}

function implementPrompt(cwd, id) {
  return [
    `Implement the approved OpenSpec change ${cwd}/openspec/changes/${id} in workspace ${cwd}.`,
    '',
    'Procedure:',
    '1. Read proposal.md, tasks.md, design.md (if present) and every spec delta under specs/.',
    '2. Mirror every task from tasks.md into the todo_write tool — one todo per task, same order — and keep it updated as you work.',
    '3. Implement each task. Immediately after a task is done, tick its checkbox in tasks.md with the edit tool (`- [ ]` → `- [x]`).',
    '4. Never modify files under openspec/changes/<id>/specs/ — deltas are approved and frozen.',
    '5. When every task is complete and every checkbox in tasks.md is ticked, end your reply with a single line containing exactly (machine marker, verbatim): SPEC_IMPLEMENTED',
  ].join('\n')
}

function editPrompt(cwd, id) {
  return [
    `Revise the OpenSpec change proposal openspec/changes/${id} in workspace ${cwd}.`,
    '',
    'Read proposal.md, tasks.md, design.md (if present) and the spec deltas. Update the files to reflect the revision.',
    'Keep the same change-id. Do not start implementing; leave tasks.md checkboxes unticked.',
    'End your reply with a single line containing exactly (machine marker, verbatim): SPEC_CHANGE_ID: ' + id,
  ].join('\n')
}

function fixPrompt(cwd, id, errorsText) {
  return [
    `The OpenSpec change proposal openspec/changes/${id} in workspace ${cwd} failed validation:`,
    '',
    errorsText,
    '',
    'Fix the files so every error is resolved (the validator requires proposal.md, a tasks.md with `- [ ]` checklist items, spec deltas with exactly one ## ADDED|MODIFIED|REMOVED Requirements section, every requirement carrying at least one #### Scenario:, and a kebab-case change id).',
    'Do not start implementing; leave tasks.md checkboxes unticked.',
    'End your reply with a single line containing exactly (machine marker, verbatim): SPEC_CHANGE_ID: ' + id,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Verify judge
// ---------------------------------------------------------------------------

function extractBashBlocks(text) {
  const blocks = []
  const re = /```bash\r?\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(String(text || ''))) !== null && blocks.length < 3) {
    const body = m[1].trim()
    if (body) blocks.push(body)
  }
  return blocks
}

function verifyPrompt(deltaText, filesText, tasksText, bashText) {
  return [
    'You are verifying an implementation against an OpenSpec change. For each Requirement and each Scenario below, judge whether the workspace implementation satisfies it, based on the provided file contents (paths are relative to the workspace root).',
    '',
    'Output exactly one line per scenario, nothing else:',
    'OK|FAIL <requirement>: <scenario> — <one-line reason>',
    '',
    'Do not invent requirements. A FAIL must name the concrete gap.',
    '',
    '## Spec',
    deltaText,
    '',
    '## Tasks (checkbox state)',
    tasksText,
    '',
    bashText ? '## Verification commands (already executed; results included)' + '\n' + bashText + '\n' : '',
    '## Workspace files',
    filesText,
  ].join('\n')
}

function parseVerdicts(text) {
  const verdicts = []
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^\s*(OK|FAIL)\s+(.+?)\s*$/)
    if (!m) continue
    const rest = m[2]
    const reasonIdx = rest.indexOf(' — ')
    const head = reasonIdx === -1 ? rest : rest.slice(0, reasonIdx)
    const reason = reasonIdx === -1 ? '' : rest.slice(reasonIdx + 3).trim()
    const colonIdx = head.indexOf(': ')
    const requirement = colonIdx === -1 ? head.trim() : head.slice(0, colonIdx).trim()
    const scenario = colonIdx === -1 ? '' : head.slice(colonIdx + 2).trim()
    verdicts.push({ pass: m[1] === 'OK', requirement, scenario, reason })
  }
  return verdicts
}

async function collectWorkspaceFiles(ctx, cwd, signal) {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'openspec', 'dist', 'coverage', '.next', '.turbo', 'build', 'out', 'lib'])
  const SKIP_FILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/
  const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|pdf|zip|gz|tar|mp3|mp4|mov|map|wasm)$/i
  const MAX_FILES = 300
  const MAX_FILE_BYTES = 100 * 1024
  const MAX_TOTAL = 240 * 1024
  const out = []
  let total = 0
  async function walk(rel) {
    if (out.length >= MAX_FILES || total >= MAX_TOTAL) return
    let entries
    try {
      // The local fs backend rejects the empty path (`resolve('')` throws
      // FS_NOT_FOUND), so the workspace root lists through '.'.
      entries = await fsList(ctx, cwd, rel === '' ? '.' : rel, signal)
    } catch (error) {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES || total >= MAX_TOTAL) return
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (!SKIP_DIRS.has(entry.name)) await walk(child)
      } else if (entry.type === 'file') {
        if (SKIP_FILES.test(child) || SKIP_EXT.test(child)) continue
        try {
          const text = await fsRead(ctx, cwd, child, signal)
          if (text === null || text.length === 0) continue
          if (text.length > MAX_FILE_BYTES) continue
          if (total + text.length > MAX_TOTAL) return
          total += text.length
          out.push({ path: child, text })
        } catch (error) {
          /* skip unreadable */
        }
      }
    }
  }
  await walk('')
  return out
}

async function findFlashModel(ctx, provider) {
  try {
    const models = await ctx.llm.listModels(provider)
    if (Array.isArray(models)) {
      for (const m of models) {
        const id = String((m && m.id) || '')
        if (id && FLASH_RE.test(id) && !STRONG_RE.test(id)) return id
      }
    }
  } catch (error) {
    console.error(`${ID}: model catalog failed for ${provider}: ${String(error)}`)
  }
  return null
}

async function judgeCall(ctx, opts, signal) {
  const stream = ctx.llm.stream({
    provider: opts.provider,
    model: opts.model,
    messages: [{
      id: `spec-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text: opts.text }],
      source: { kind: 'user' },
    }],
    maxTokens: opts.maxTokens,
    // Flash verdicts want the tiny budget untouched by thinking; --deep keeps
    // the main model's default reasoning for a more careful read.
    ...(opts.reasoningOff ? { reasoningEffort: 'off' } : {}),
    signal,
  })
  const blocks = []
  for await (const chunk of stream) {
    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text'
      && typeof chunk.block.text === 'string') {
      blocks.push(chunk.block.text)
    }
  }
  return blocks.join('\n\n').trim()
}

// ---------------------------------------------------------------------------
// The /spec command
// ---------------------------------------------------------------------------

function registerCommand(ctx) {
  ctx.commands.register({
    name: 'spec',
    description: 'Spec-driven development loop (OpenSpec): propose → approve → implement → verify → archive — 规格驱动开发闭环',
    input: { hint: 'init | new <goal> | list | show <id> | approve <id> | implement <id> | verify <id> [--deep] | archive <id> | validate [id] | edit <id>' },
    handler: async (invocation) => {
      const { sub, arg, first } = parseSpecArgs(invocation.rawInput)
      const agent = invocation.agent
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      if (!cwd) {
        return { kind: 'error', text: 'no workspace directory for this session (session header has no cwd)' }
      }
      const snapshot = ctx.sessionProjections.snapshot(agent.session)
      const specState = snapshot.values && snapshot.values.specLoop
      const title = specState && specState.change ? specState.change.title : ''
      const lang = hasZh(invocation.rawInput) || hasZh(title) ? 'zh' : 'en'
      const t = (zhText, enText) => (lang === 'zh' ? zhText : enText)
      const signal = invocation.signal
      try {
        switch (sub) {
          case 'init': return await cmdInit(ctx, cwd, signal, t)
          case 'new': return await cmdNew(ctx, agent, cwd, arg, signal, t)
          case 'list': return await cmdList(ctx, cwd, signal, t)
          case 'show': return await cmdShow(ctx, cwd, first, signal, t)
          case 'approve': return await cmdApprove(ctx, agent, cwd, first, signal, t)
          case 'implement': return await cmdImplement(ctx, agent, cwd, first, signal, t)
          case 'verify': return await cmdVerify(ctx, agent, cwd, arg, signal, t)
          case 'archive': return await cmdArchive(ctx, cwd, first, signal, t)
          case 'validate': return await cmdValidate(ctx, cwd, first, signal, t)
          case 'edit': return await cmdEdit(ctx, agent, cwd, first, signal, t)
          default:
            return {
              kind: 'error',
              text: t(
                '用法: /spec init | new <目标> | list | show <id> | approve <id> | implement <id> | verify <id> [--deep] | archive <id> | validate [id] | edit <id>',
                'usage: /spec init | new <goal> | list | show <id> | approve <id> | implement <id> | verify <id> [--deep] | archive <id> | validate [id] | edit <id>',
              ),
            }
        }
      } catch (error) {
        if (signal && signal.aborted) throw error
        console.error(`${ID}: /spec ${sub} failed: ${String(error)}`)
        return { kind: 'error', text: t(`/spec ${sub} 失败：${String(error)}`, `/spec ${sub} failed: ${String(error)}`) }
      }
    },
  })
}

async function cmdInit(ctx, cwd, signal, t) {
  const existing = await fsStat(ctx, cwd, 'openspec/project.md', signal)
  if (existing) return { kind: 'error', text: t('openspec/ 已存在（project.md 已初始化）', 'openspec/ already exists (project.md present)') }
  const projectMd = [
    '# Project Context',
    '',
    '## Purpose',
    '[Describe the project purpose and goals in 2-3 sentences.]',
    '',
    '## Tech Stack',
    '- [Language / runtime]',
    '- [Key frameworks]',
    '',
    '## Conventions',
    '- [Code style, testing, or workflow conventions]',
    '',
  ].join('\n')
  await fsWrite(ctx, cwd, 'openspec/project.md', projectMd, signal)
  // Keep the empty convention directories present (OpenSpec-compatible layout).
  await fsWrite(ctx, cwd, 'openspec/specs/.gitkeep', '', signal)
  await fsWrite(ctx, cwd, 'openspec/changes/.gitkeep', '', signal)
  await fsWrite(ctx, cwd, 'openspec/changes/archive/.gitkeep', '', signal)
  return {
    kind: 'success',
    text: t(
      '已初始化 openspec/（project.md + specs/ + changes/）。下一步：/spec new <功能目标>',
      'Initialized openspec/ (project.md + specs/ + changes/). Next: /spec new <goal>',
    ),
  }
}

async function cmdNew(ctx, agent, cwd, goal, signal, t) {
  if (!goal.trim()) return { kind: 'error', text: t('用法: /spec new <一句话目标>', 'usage: /spec new <one-line goal>') }
  const zh = hasZh(goal)
  let answersText = ''
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions !== undefined) {
    try {
      const answer = await userQuestions.ask({
        questions: [
          {
            id: 'scope',
            question: zh ? '这次变更属于哪类？' : 'What kind of change is this?',
            options: [
              { label: zh ? '新增能力' : 'New capability' },
              { label: zh ? '修改现有能力' : 'Modify existing capability' },
              { label: zh ? '重构' : 'Refactor' },
            ],
          },
          {
            id: 'constraints',
            question: zh ? '有哪些关键约束？（可多选）' : 'Key constraints? (multi-select)',
            multiSelect: true,
            options: [
              { label: zh ? '兼容现有接口' : 'Keep existing interfaces compatible' },
              { label: zh ? '性能敏感' : 'Performance sensitive' },
              { label: zh ? '需保留现有行为' : 'Preserve existing behavior' },
            ],
          },
          {
            id: 'acceptance',
            question: zh ? '验收方式？' : 'How should it be accepted?',
            options: [
              { label: zh ? '手动验证' : 'Manual verification' },
              { label: zh ? '可运行测试' : 'Runnable tests' },
              { label: zh ? '两者都要' : 'Both' },
            ],
          },
        ],
        agent,
        signal,
      })
      const lines = []
      for (const item of Array.isArray(answer.answers) ? answer.answers : []) {
        const selected = Array.isArray(item.selected) ? item.selected.join(', ') : ''
        if (!selected && !item.custom) continue
        const label = item.id === 'scope' ? (zh ? '范围' : 'Scope')
          : item.id === 'constraints' ? (zh ? '约束' : 'Constraints')
          : (zh ? '验收' : 'Acceptance')
        lines.push(`- ${label}: ${selected || item.custom}`)
      }
      if (lines.length > 0) answersText = (zh ? '澄清结果：' : 'Clarification answers:') + '\n' + lines.join('\n')
    } catch (error) {
      // DELEGATED_CALLER / CALLER_NOT_LIVE / missing UI provider — proceed
      // without clarification rather than failing the command.
      console.error(`${ID}: clarification skipped: ${String(error)}`)
    }
  }
  const prompt = newProposalPrompt(cwd, goal, answersText)
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: ID },
  }))
  return {
    kind: 'success',
    text: t(
      '提案任务已交给 agent（生成 proposal.md / tasks.md / 规格增量，完成后自动校验）。面板将显示进度。',
      'Proposal task handed to the agent (proposal.md / tasks.md / spec deltas; auto-validated on completion). Watch the dock card for progress.',
    ),
  }
}

async function cmdList(ctx, cwd, signal, t) {
  const changes = await fsList(ctx, cwd, 'openspec/changes', signal)
  const active = changes.filter((e) => e.type === 'directory' && e.name !== 'archive').map((e) => e.name).sort()
  const specs = await fsList(ctx, cwd, 'openspec/specs', signal)
  const caps = specs.filter((e) => e.type === 'directory' && !e.name.startsWith('.')).map((e) => e.name).sort()
  const lines = []
  if (active.length === 0) {
    lines.push(t('（无活跃变更 — /spec new <目标>）', '(no active changes — /spec new <goal>)'))
  } else {
    for (const id of active) {
      const tasks = await fsRead(ctx, cwd, `openspec/changes/${id}/tasks.md`, signal)
      const c = countTasks(tasks === null ? '' : tasks)
      lines.push(`- ${id} (${c.done}/${c.total})`)
    }
  }
  if (caps.length === 0) {
    lines.push(t('（无能力规格 — specs/ 为空）', '(no capability specs — specs/ is empty)'))
  } else {
    lines.push(...caps.map((cap) => `- specs/${cap}/spec.md`))
  }
  return { kind: 'success', text: lines.join('\n') }
}

async function cmdShow(ctx, cwd, id, signal, t) {
  if (!id) return { kind: 'error', text: t('用法: /spec show <id>', 'usage: /spec show <id>') }
  const proposal = await fsRead(ctx, cwd, `openspec/changes/${id}/proposal.md`, signal)
  if (proposal === null) return { kind: 'error', text: t(`未找到变更 openspec/changes/${id}/`, `no change at openspec/changes/${id}/`) }
  const design = await fsRead(ctx, cwd, `openspec/changes/${id}/design.md`, signal)
  const parts = [`# ${id}`, '', proposal]
  if (design !== null && design.trim() !== '') parts.push('', '---', design)
  return { kind: 'success', text: parts.join('\n') }
}

async function cmdApprove(ctx, agent, cwd, id, signal, t) {
  if (!id) return { kind: 'error', text: t('用法: /spec approve <id>', 'usage: /spec approve <id>') }
  const report = await validateChange(ctx, cwd, id, signal)
  if (!report.ok) {
    return {
      kind: 'error',
      text: t(`变更 ${id} 未通过校验，不能批准：\n- `, `change ${id} failed validation; approve refused:\n- `) + report.errors.join('\n- '),
    }
  }
  const snapshot = ctx.sessionProjections.snapshot(agent.session)
  const current = snapshot.values && snapshot.values.specLoop && snapshot.values.specLoop.change
  if (current && current.id === id && current.status === 'approved') {
    return { kind: 'success', text: t(`${id} 已是 approved`, `${id} is already approved`) }
  }
  return {
    kind: 'success',
    text: t(`已批准 ${id}。下一步：/spec implement ${id}（未批准的变更不能实现）`, `Approved ${id}. Next: /spec implement ${id} (implementation requires approval)`),
  }
}

async function cmdImplement(ctx, agent, cwd, id, signal, t) {
  if (!id) return { kind: 'error', text: t('用法: /spec implement <id>', 'usage: /spec implement <id>') }
  const dirInfo = await fsStat(ctx, cwd, `openspec/changes/${id}`, signal)
  if (!dirInfo || dirInfo.type !== 'directory') {
    return { kind: 'error', text: t(`未找到变更 openspec/changes/${id}/`, `no change at openspec/changes/${id}/`) }
  }
  // Gate: only approved (or already in the implementation chain) changes may
  // be implemented. Reads the projection — the same state the panel shows.
  const snapshot = ctx.sessionProjections.snapshot(agent.session)
  const change = snapshot.values && snapshot.values.specLoop && snapshot.values.specLoop.change
  if (!change || change.id !== id || !IMPLEMENTABLE.includes(change.status)) {
    return {
      kind: 'error',
      text: t(
        `${id} 尚未批准（状态: ${change && change.id === id ? change.status : 'unknown'}）。先 /spec approve ${id}`,
        `${id} is not approved (status: ${change && change.id === id ? change.status : 'unknown'}). Run /spec approve ${id} first`,
      ),
    }
  }
  const tasks = await fsRead(ctx, cwd, `openspec/changes/${id}/tasks.md`, signal)
  if (tasks === null) return { kind: 'error', text: t(`${id} 缺少 tasks.md`, `${id} has no tasks.md`) }
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: implementPrompt(cwd, id) }],
    source: { kind: 'plugin', plugin: ID },
  }))
  return {
    kind: 'success',
    text: t(
      `实现任务已交给 agent（按 tasks.md 逐项实现并勾选，todo 面板跟踪进度）。`,
      `Implementation handed to the agent (tasks.md order, checkboxes ticked per task, todo panel tracks progress).`,
    ),
  }
}

async function cmdVerify(ctx, agent, cwd, arg, signal, t) {
  const parts = arg.trim().split(/\s+/)
  const id = parts[0] || ''
  const deep = parts.includes('--deep')
  if (!id) return { kind: 'error', text: t('用法: /spec verify <id> [--deep]', 'usage: /spec verify <id> [--deep]') }
  const dirInfo = await fsStat(ctx, cwd, `openspec/changes/${id}`, signal)
  if (!dirInfo || dirInfo.type !== 'directory') {
    return { kind: 'error', text: t(`未找到变更 openspec/changes/${id}/`, `no change at openspec/changes/${id}/`) }
  }
  const proposal = await fsRead(ctx, cwd, `openspec/changes/${id}/proposal.md`, signal)
  const tasks = await fsRead(ctx, cwd, `openspec/changes/${id}/tasks.md`, signal)
  const deltas = await listDeltaFiles(ctx, cwd, id, signal)
  const deltaTexts = []
  for (const delta of deltas) {
    const text = await fsRead(ctx, cwd, delta.rel, signal)
    if (text !== null) deltaTexts.push(`### ${delta.cap}\n${text}`)
  }
  if (deltaTexts.length === 0) return { kind: 'error', text: t(`${id} 没有规格增量文件`, `${id} has no spec delta files`) }

  // Declared verification commands (```bash blocks in proposal.md) run first.
  let bashText = ''
  const bashBlocks = extractBashBlocks(proposal === null ? '' : proposal)
  if (bashBlocks.length > 0) {
    const results = []
    for (const block of bashBlocks) {
      let line = '$ ' + block
      try {
        const result = await shellRun(ctx, cwd, block, signal)
        line += `\n(exit ${result.exitCode})`
        const out = result.stdout && typeof result.stdout === 'object' && typeof result.stdout.text === 'string'
          ? result.stdout.text
          : ''
        if (out.trim()) line += '\n' + out.trim().split('\n').slice(-15).join('\n')
        if (result.sandbox && result.sandbox.denied) line += '\n[sandbox denied]'
      } catch (error) {
        line += '\n(failed to run: ' + String(error) + ')'
      }
      results.push(line)
    }
    bashText = results.join('\n\n')
  }

  // Model choice: --deep uses the agent's main model, default is flash.
  const options = agent && agent.options
  let provider = options && options.provider
  let model = null
  if (deep) {
    model = options && options.model
  } else {
    if (!provider) provider = 'deepseek-official'
    model = await findFlashModel(ctx, provider)
    if (model === null) model = 'deepseek-v4-flash'
  }
  if (!provider || !model) {
    return { kind: 'error', text: t('无法确定验收模型（缺少 provider/model 配置）', 'cannot determine the verify model (missing provider/model config)') }
  }

  const files = await collectWorkspaceFiles(ctx, cwd, signal)
  const filesText = files.map((f) => `--- ${f.path}\n${f.text}`).join('\n\n')
  const prompt = verifyPrompt(deltaTexts.join('\n\n'), filesText, tasks === null ? '(no tasks.md)' : tasks, bashText)
  let judged
  try {
    judged = await judgeCall(ctx, {
      provider,
      model,
      text: prompt,
      maxTokens: deep ? 8000 : 4000,
      reasoningOff: !deep,
    }, signal)
  } catch (error) {
    if (signal && signal.aborted) throw error
    return { kind: 'error', text: t(`验收模型调用失败：${String(error)}`, `verify model call failed: ${String(error)}`) }
  }
  const verdicts = parseVerdicts(judged)
  if (verdicts.length === 0) {
    // Persist the raw output so the "written to verify.md" claim is true.
    await fsWrite(ctx, cwd, `openspec/changes/${id}/verify.md`, [
      `# Verification — ${id}`,
      '',
      `Date: ${new Date().toISOString()}`,
      'Result: the judge produced no parseable OK|FAIL verdicts.',
      '',
      '## Raw judge output',
      '',
      '```',
      judged,
      '```',
      '',
    ].join('\n'), signal)
    return { kind: 'error', text: t('验收模型未产出任何 OK|FAIL 判定（原始输出已写入 verify.md）', 'verify model produced no OK|FAIL verdicts (raw output written to verify.md)') }
  }
  const passed = verdicts.filter((v) => v.pass).length
  const failed = verdicts.length - passed
  const table = [
    '| # | Result | Requirement | Scenario | Reason |',
    '|---|--------|-------------|----------|--------|',
    ...verdicts.map((v, i) => `| ${i + 1} | ${v.pass ? '✅' : '❌'} | ${v.requirement.replace(/\|/g, '\\|')} | ${v.scenario.replace(/\|/g, '\\|')} | ${v.reason.replace(/\|/g, '\\|')} |`),
  ].join('\n')
  const verifyMd = [
    `# Verification — ${id}`,
    '',
    `Date: ${new Date().toISOString()}`,
    `Change: openspec/changes/${id}`,
    `Model: ${provider} / ${model}${deep ? ' (--deep)' : ' (flash)'}`,
    '',
    `**${passed}/${verdicts.length} scenarios passed**`,
    '',
    '## Scenarios',
    '',
    table,
    '',
    ...(failed > 0 ? ['## Failures', '', ...verdicts.filter((v) => !v.pass).map((v) => `- ❌ ${v.requirement}: ${v.scenario} — ${v.reason}`), ''] : []),
    '## Raw judge output',
    '',
    '```',
    judged,
    '```',
    '',
  ].join('\n')
  await fsWrite(ctx, cwd, `openspec/changes/${id}/verify.md`, verifyMd, signal)
  const summary = t(
    `验收完成：${passed}/${verdicts.length} 通过（${failed} 失败）。报告：openspec/changes/${id}/verify.md`,
    `Verification done: ${passed}/${verdicts.length} passed (${failed} failed). Report: openspec/changes/${id}/verify.md`,
  )
  if (failed > 0) {
    const fails = verdicts.filter((v) => !v.pass).map((v) => `- ❌ ${v.requirement}: ${v.scenario} — ${v.reason}`).join('\n')
    return { kind: 'error', text: summary + '\n\n' + fails }
  }
  return { kind: 'success', text: summary }
}

async function cmdArchive(ctx, cwd, id, signal, t) {
  if (!id) return { kind: 'error', text: t('用法: /spec archive <id>', 'usage: /spec archive <id>') }
  const dirInfo = await fsStat(ctx, cwd, `openspec/changes/${id}`, signal)
  if (!dirInfo || dirInfo.type !== 'directory') {
    return { kind: 'error', text: t(`未找到变更 openspec/changes/${id}/`, `no change at openspec/changes/${id}/`) }
  }
  // 1. Merge the spec deltas into canonical specs/.
  const deltas = await listDeltaFiles(ctx, cwd, id, signal)
  const merged = []
  for (const delta of deltas) {
    const deltaText = await fsRead(ctx, cwd, delta.rel, signal)
    if (deltaText === null) continue
    const targetRel = `openspec/specs/${delta.cap}/spec.md`
    const existing = await fsRead(ctx, cwd, targetRel, signal)
    const result = mergeDelta(deltaText, existing)
    if (!result.changed) continue
    const header = existing !== null ? '' : `# ${delta.cap} Specification\n\n## Requirements\n`
    await fsWrite(ctx, cwd, targetRel, header + result.text, signal)
    merged.push(`specs/${delta.cap}/spec.md`)
  }
  // 2. Move the change dir into archive/<date>-<id>/.
  const date = new Date().toISOString().slice(0, 10)
  const src = `openspec/changes/${id}`
  const dst = `openspec/changes/archive/${date}-${id}`
  const command = `mkdir -p ${shQuote('openspec/changes/archive')} && mv ${shQuote(src)} ${shQuote(dst)}`
  let result
  try {
    result = await shellRun(ctx, cwd, command, signal)
  } catch (error) {
    return { kind: 'error', text: t(`归档移动失败：${String(error)}`, `archive move failed: ${String(error)}`) }
  }
  if (result.exitCode !== 0 || (result.sandbox && result.sandbox.denied)) {
    return {
      kind: 'error',
      text: t(`归档移动失败（exit ${result.exitCode}）`, `archive move failed (exit ${result.exitCode})`),
    }
  }
  const mergeNote = merged.length > 0 ? t(`已合并：${merged.join(', ')}`, `merged: ${merged.join(', ')}`) : t('（无规格增量）', '(no spec deltas)')
  return {
    kind: 'success',
    text: t(`已归档 ${id} → changes/archive/${date}-${id}/。`, `Archived ${id} → changes/archive/${date}-${id}/.`) + ' ' + mergeNote,
  }
}

async function cmdValidate(ctx, cwd, id, signal, t) {
  const changes = await fsList(ctx, cwd, 'openspec/changes', signal)
  const ids = (id
    ? [id]
    : changes.filter((e) => e.type === 'directory' && e.name !== 'archive').map((e) => e.name).sort())
  if (ids.length === 0) return { kind: 'success', text: t('没有活跃变更可校验', 'no active changes to validate') }
  const lines = []
  let allOk = true
  for (const changeId of ids) {
    const report = await validateChange(ctx, cwd, changeId, signal)
    if (report.ok) {
      lines.push(`✅ ${changeId}`)
    } else {
      allOk = false
      lines.push(`❌ ${changeId}`)
      for (const err of report.errors) lines.push(`  - ${err}`)
    }
    for (const warn of report.warnings) lines.push(`  ⚠ ${warn}`)
  }
  return { kind: allOk ? 'success' : 'error', text: lines.join('\n') }
}

async function cmdEdit(ctx, agent, cwd, id, signal, t) {
  if (!id) return { kind: 'error', text: t('用法: /spec edit <id>', 'usage: /spec edit <id>') }
  const dirInfo = await fsStat(ctx, cwd, `openspec/changes/${id}`, signal)
  if (!dirInfo || dirInfo.type !== 'directory') {
    return { kind: 'error', text: t(`未找到变更 openspec/changes/${id}/`, `no change at openspec/changes/${id}/`) }
  }
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: editPrompt(cwd, id) }],
    source: { kind: 'plugin', plugin: ID },
  }))
  return {
    kind: 'success',
    text: t(`修订任务已交给 agent（回到 proposed，需重新 approve）`, `Revision handed to the agent (back to proposed; re-approval required)`),
  }
}

// ---------------------------------------------------------------------------
// Auto-validation after proposal generation
// ---------------------------------------------------------------------------

export function apply(ctx) {
  ctx.sessionProjections.register({
    key: 'specLoop',
    schema: projectionSchema,
    init: initSpecState,
    apply: applySpecEvent,
    view: viewSpecState,
    stateVersion: 1,
  })

  registerCommand(ctx)

  // When the agent reports a proposal (SPEC_CHANGE_ID marker), validate the
  // produced change; on failure steer a correction request. Bounded per
  // change-id so a broken agent cannot loop forever.
  const autoValidateCounts = new Map()
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'assistant/message') return
      const text = messageText(event.data && event.data.message)
      const m = text.match(CHANGE_ID_MARKER_RE)
      if (!m) return
      const id = m[1]
      const snapshot = ctx.sessionProjections.snapshot(session)
      const state = snapshot.values && snapshot.values.specLoop
      if (!state || !state.change || state.change.status !== 'proposing' || state.change.id !== id) return
      const cwd = session.header && session.header.cwd
      if (!cwd) return
      const key = String(session.id) + ':' + id
      const attempts = autoValidateCounts.get(key) || 0
      if (attempts >= 3) return
      Promise.resolve()
        .then(async () => {
          const report = await validateChange(ctx, cwd, id, new AbortController().signal)
          if (report.ok) {
            autoValidateCounts.delete(key)
            return
          }
          autoValidateCounts.set(key, attempts + 1)
          const agent = ctx.agents.get(session.id)
          if (!agent) return
          agent.steer(createUserMessage({
            content: [{ type: 'text', text: fixPrompt(cwd, id, report.errors.map((e) => '- ' + e).join('\n')) }],
            source: { kind: 'plugin', plugin: ID },
          }))
          console.log(`${ID}: change ${id} failed validation (attempt ${attempts + 1}); steering correction`)
        })
        .catch((error) => {
          console.error(`${ID}: auto-validate failed for ${id}: ${String(error)}`)
        })
    } catch (error) {
      console.error(`${ID}: auto-validate listener failed: ${String(error)}`)
    }
  })
}
