// Behavioral tests for the dsh-spec-loop host half (no cordis runtime needed).
import {
  apply,
  parseSpecArgs,
  validateDeltaText,
  parseDelta,
  mergeDelta,
  countTasks,
  initSpecState,
  applySpecEvent,
} from './lib/index.js'

let failures = 0
const expect = (label, got, want) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a !== b) {
    failures++
    console.error(`FAIL ${label}: got ${a}, want ${b}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

expect('parse sub/arg', parseSpecArgs(' new 添加用户登录 功能'), { sub: 'new', arg: '添加用户登录 功能', first: '添加用户登录' })
expect('parse empty', parseSpecArgs('  '), { sub: '', arg: '', first: '' })

const goodDelta = [
  '## ADDED Requirements',
  '### Requirement: User login',
  'The system SHALL allow a user to log in.',
  '#### Scenario: Valid credentials',
  'Given valid credentials, the user logs in.',
].join('\n')
expect('delta valid', validateDeltaText(goodDelta).ok, true)
expect('delta no section', validateDeltaText('### Requirement: X').ok, false)
const noScenario = '## ADDED Requirements\n### Requirement: X\nno scenario here\n'
expect('delta no scenario', validateDeltaText(noScenario).errors.length > 0, true)

const parsed = parseDelta(goodDelta)
expect('parse sections', parsed.length, 1)
expect('parse kind', parsed[0].kind, 'ADDED')
expect('parse req name', parsed[0].requirements[0].name, 'User login')

expect('countTasks', countTasks('- [ ] a\n- [x] b\n- [ ] c'), { total: 3, done: 1 })

// merge ADDED into empty → creates spec
let merged = mergeDelta(goodDelta, null)
expect('merge added changed', merged.changed, true)
expect('merge added has section', /## Requirements/.test(merged.text), true)
expect('merge added has req', /### Requirement: User login/.test(merged.text), true)

// merge MODIFIED replaces same-named requirement
const existing = '## Requirements\n\n### Requirement: User login\nold body\n#### Scenario: old\n'
const modDelta = '## MODIFIED Requirements\n### Requirement: User login\nnew body\n#### Scenario: new\n'
merged = mergeDelta(modDelta, existing)
expect('merge modified replaces', merged.text.includes('new body'), true)
expect('merge modified drops old', merged.text.includes('old body'), false)

// merge REMOVED drops the block
const rmDelta = '## REMOVED Requirements\n### Requirement: User login\n'
merged = mergeDelta(rmDelta, existing)
expect('merge removed', merged.text.includes('User login'), false)

// ---------------------------------------------------------------------------
// Projection state machine
// ---------------------------------------------------------------------------

const ev = (type, data, seq) => ({ type, seq, time: 0, data })

let s = initSpecState()
// failed command must not move the machine
s = applySpecEvent(s, ev('command/run', { commandId: 'c1', name: 'spec', args: ' new 登录' }, 1))
s = applySpecEvent(s, ev('command/done', { commandId: 'c1', kind: 'error', text: 'x' }, 2))
expect('failed command no transition', s.change, null)
expect('pending cleared on done', Object.keys(s.pending).length, 0)

// new → proposing → assistant marker → proposed
s = applySpecEvent(s, ev('command/run', { commandId: 'c2', name: 'spec', args: ' new 用户登录' }, 3))
expect('run alone no transition', s.change, null)
s = applySpecEvent(s, ev('command/done', { commandId: 'c2', kind: 'success' }, 4))
expect('new success → proposing', s.change && s.change.status, 'proposing')
expect('proposing id empty', s.change.id, '')
expect('proposing title', s.change.title, '用户登录')
s = applySpecEvent(s, ev('assistant/message', { message: { content: [{ type: 'text', text: 'done\nSPEC_CHANGE_ID: add-user-login' }] } }, 5))
expect('marker → proposed', s.change && s.change.status, 'proposed')
expect('marker id', s.change.id, 'add-user-login')

// approve
s = applySpecEvent(s, ev('command/run', { commandId: 'c3', name: 'spec', args: ' approve add-user-login' }, 6))
s = applySpecEvent(s, ev('command/done', { commandId: 'c3', kind: 'success' }, 7))
expect('approve → approved', s.change.status, 'approved')

// implement
s = applySpecEvent(s, ev('command/run', { commandId: 'c4', name: 'spec', args: ' implement add-user-login' }, 8))
s = applySpecEvent(s, ev('command/done', { commandId: 'c4', kind: 'success' }, 9))
expect('implement → implementing', s.change.status, 'implementing')
s = applySpecEvent(s, ev('assistant/message', { message: { content: [{ type: 'text', text: 'all done. SPEC_IMPLEMENTED' }] } }, 10))
expect('marker → implemented', s.change.status, 'implemented')

// verify → verified, archive → archived, edit → proposed
s = applySpecEvent(s, ev('command/run', { commandId: 'c5', name: 'spec', args: ' verify add-user-login' }, 11))
s = applySpecEvent(s, ev('command/done', { commandId: 'c5', kind: 'success' }, 12))
expect('verify → verified', s.change.status, 'verified')
s = applySpecEvent(s, ev('command/run', { commandId: 'c6', name: 'spec', args: ' archive add-user-login' }, 13))
s = applySpecEvent(s, ev('command/done', { commandId: 'c6', kind: 'success' }, 14))
expect('archive → archived', s.change.status, 'archived')
s = applySpecEvent(s, ev('command/run', { commandId: 'c7', name: 'spec', args: ' edit add-user-login' }, 15))
s = applySpecEvent(s, ev('command/done', { commandId: 'c7', kind: 'success' }, 16))
expect('edit → proposed', s.change.status, 'proposed')

// init flag
s = applySpecEvent(s, ev('command/run', { commandId: 'c8', name: 'spec', args: ' init' }, 17))
s = applySpecEvent(s, ev('command/done', { commandId: 'c8', kind: 'success' }, 18))
expect('init → initialized', s.initialized, true)

// other commands do not move state
s = applySpecEvent(s, ev('command/run', { commandId: 'c9', name: 'spec', args: ' list' }, 19))
s = applySpecEvent(s, ev('command/done', { commandId: 'c9', kind: 'success' }, 20))
expect('list no transition', s.change.status, 'proposed')
expect('non-spec command ignored', applySpecEvent(s, ev('command/run', { commandId: 'c10', name: 'plan', args: ' x' }, 21)), s)

// ---------------------------------------------------------------------------
// Handler tests with a mock runtime
// ---------------------------------------------------------------------------

class MemFs {
  constructor() { this.entries = new Map() } // relpath -> {type, content}
  norm(rel) { return rel.replace(/^\.\//, '') }
  put(rel, type, content = '') {
    const parts = this.norm(rel).split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      if (!this.entries.has(parent)) this.entries.set(parent, { type: 'dir' })
    }
    this.entries.set(this.norm(rel), { type, content })
  }
  children(rel) {
    const prefix = this.norm(rel) === '' ? '' : this.norm(rel) + '/'
    const out = []
    for (const [path, entry] of this.entries) {
      if (!path.startsWith(prefix) || path === this.norm(rel)) continue
      const rest = path.slice(prefix.length)
      if (rest.includes('/')) continue
      out.push({ name: rest, type: entry.type === 'dir' ? 'directory' : 'file' })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
}

function makeRuntime({ seed = {}, snapshotState = null, userQuestions = undefined, llmStream = null, models = [] } = {}) {
  const fs = new MemFs()
  for (const [path, value] of Object.entries(seed)) fs.put(path, value.type ?? 'file', value.content ?? '')
  const registered = []
  const listeners = []
  const steered = []
  const shellCommands = []
  const ctx = {
    fs: {
      resolve: async (rel, opts) => ({ targetKey: 'k:' + rel, displayPath: rel === '.' ? '' : rel }),
      stat: async (target) => (target.displayPath === ''
        ? { type: 'directory', version: 'v' }
        : fs.entries.has(target.displayPath)
          ? { type: fs.entries.get(target.displayPath).type === 'dir' ? 'directory' : 'file', version: 'v' }
          : undefined),
      readText: async (target) => (fs.entries.has(target.displayPath) ? fs.entries.get(target.displayPath).content : ''),
      writeText: async (target, content) => { fs.put(target.displayPath, 'file', content); return { version: 'v' } },
      listDir: async (target) => fs.children(target.displayPath).map((c) => ({ ...c, target: { displayPath: target.displayPath + '/' + c.name } })),
    },
    shell: {
      resolve: (req) => req,
      run: async (spec) => {
        shellCommands.push(spec.command)
        // Emulate `mkdir -p X && mv SRC DST` for the archive handler.
        const m = spec.command.match(/^mkdir -p '([^']+)' && mv '([^']+)' '([^']+)'$/)
        if (m) {
          fs.put(m[1], 'dir')
          const srcPrefix = m[2] + '/'
          const moved = []
          for (const [path, entry] of [...fs.entries]) {
            if (path.startsWith(srcPrefix) || path === m[2]) {
              moved.push([path, entry])
              fs.entries.delete(path)
            }
          }
          for (const [path, entry] of moved) {
            fs.put(path === m[2] ? m[3] : m[3] + '/' + path.slice(srcPrefix.length), entry.type, entry.content)
          }
        }
        return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: '' }, stderr: { text: '' } }
      },
    },
    llm: {
      listModels: async () => models,
      stream: llmStream || (async function* () { yield { type: 'block-end', block: { type: 'text', text: '' } } })(),
    },
    sessionProjections: {
      register: (def) => { registered.push(def); return () => {} },
      snapshot: () => ({ asOfSeq: 0, values: { specLoop: snapshotState } }),
    },
    commands: {
      register: (def) => { registered.push(def); return () => {} },
    },
    agents: { get: () => undefined },
    on: (name, fn) => { listeners.push([name, fn]); return () => {} },
    get: (name) => (name === 'userQuestions' ? userQuestions : undefined),
  }
  apply(ctx)
  const commandDef = registered.find((d) => typeof d.handler === 'function')
  return { ctx, fs, commandDef, steered, listeners, shellCommands }
}

function makeAgent() {
  const steered = []
  const agent = {
    id: 'a1',
    session: { id: 's1', header: { cwd: '/ws' } },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    steer: (msg) => steered.push(msg),
  }
  return { agent, steered }
}

const signal = () => new AbortController().signal

// ---- /spec init ----
{
  const { commandDef, fs } = makeRuntime()
  const { agent } = makeAgent()
  let out = await commandDef.handler({ rawInput: ' init', agent, signal: signal() })
  expect('init kind', out.kind, 'success')
  expect('init project.md', fs.entries.has('openspec/project.md'), true)
  expect('init specs dir', fs.entries.has('openspec/specs/.gitkeep'), true)
  out = await commandDef.handler({ rawInput: ' init', agent, signal: signal() })
  expect('init idempotent error', out.kind, 'error')
}

// ---- /spec new: clarification + steer ----
{
  const asked = []
  const fakeQuestions = { ask: async (req) => { asked.push(req); return { answers: [{ id: 'scope', selected: ['新增能力'] }] } } }
  const { commandDef } = makeRuntime({ userQuestions: fakeQuestions, snapshotState: null })
  const { agent, steered } = makeAgent()
  const out = await commandDef.handler({ rawInput: ' new 做一个用户登录功能', agent, signal: signal() })
  expect('new kind', out.kind, 'success')
  expect('new asked questions', asked.length, 1)
  expect('new question count', asked[0].questions.length, 3)
  expect('new steered', steered.length, 1)
  const text = steered[0].content[0].text
  expect('new prompt has goal', text.includes('用户登录功能'), true)
  expect('new prompt has marker', text.includes('SPEC_CHANGE_ID: <change-id>'), true)
  expect('new prompt has answers', text.includes('新增能力'), true)
}

// ---- /spec validate catches a malformed delta ----
{
  const { commandDef } = makeRuntime({
    seed: {
      'openspec/changes/add-x/proposal.md': { content: 'Why: x\nWhat: y\nImpact: z' },
      'openspec/changes/add-x/tasks.md': { content: '- [ ] do it' },
      'openspec/changes/add-x/specs/x/spec.md': { content: '## ADDED Requirements\n### Requirement: X\nno scenario' },
    },
  })
  const { agent } = makeAgent()
  const out = await commandDef.handler({ rawInput: ' validate', agent, signal: signal() })
  expect('validate finds error', out.kind, 'error')
  expect('validate message', out.text.includes('Scenario'), true)
}

// ---- /spec approve: validation gate ----
{
  const { commandDef } = makeRuntime({
    seed: {
      'openspec/changes/add-x/proposal.md': { content: 'Why / What / Impact' },
      'openspec/changes/add-x/tasks.md': { content: '- [ ] do it' },
      'openspec/changes/add-x/specs/x/spec.md': { content: goodDelta },
    },
  })
  const { agent } = makeAgent()
  let out = await commandDef.handler({ rawInput: ' approve add-x', agent, signal: signal() })
  expect('approve ok', out.kind, 'success')
  out = await commandDef.handler({ rawInput: ' approve missing', agent, signal: signal() })
  expect('approve missing change', out.kind, 'error')
}

// ---- /spec implement: gate refuses non-approved; allows approved ----
{
  const base = {
    seed: {
      'openspec/changes/add-x/proposal.md': { content: 'p' },
      'openspec/changes/add-x/tasks.md': { content: '- [ ] a\n- [ ] b' },
      'openspec/changes/add-x/specs/x/spec.md': { content: goodDelta },
    },
  }
  const proposed = makeRuntime({ ...base, snapshotState: { initialized: true, change: { id: 'add-x', title: 'x', status: 'proposed', seq: 1 } } })
  const { agent } = makeAgent()
  let out = await proposed.commandDef.handler({ rawInput: ' implement add-x', agent, signal: signal() })
  expect('implement refused when proposed', out.kind, 'error')

  const approved = makeRuntime({ ...base, snapshotState: { initialized: true, change: { id: 'add-x', title: 'x', status: 'approved', seq: 1 } } })
  const { agent: agent2, steered } = makeAgent()
  out = await approved.commandDef.handler({ rawInput: ' implement add-x', agent: agent2, signal: signal() })
  expect('implement allowed when approved', out.kind, 'success')
  expect('implement steered', steered.length, 1)
  expect('implement prompt marker', steered[0].content[0].text.includes('SPEC_IMPLEMENTED'), true)
}

// ---- /spec archive: merge + move ----
{
  const seed = {
    'openspec/changes/add-x/proposal.md': { content: 'p' },
    'openspec/changes/add-x/tasks.md': { content: '- [x] a' },
    'openspec/changes/add-x/specs/x/spec.md': { content: goodDelta },
    'openspec/specs/.gitkeep': { content: '' },
  }
  const { commandDef, fs, shellCommands } = makeRuntime({ seed })
  const { agent } = makeAgent()
  const out = await commandDef.handler({ rawInput: ' archive add-x', agent, signal: signal() })
  expect('archive kind', out.kind, 'success')
  expect('archive shell ran', shellCommands.length, 1)
  expect('archive moved out', fs.entries.has('openspec/changes/add-x/proposal.md'), false)
  expect('archive moved in', fs.entries.has('openspec/changes/archive/' + new Date().toISOString().slice(0, 10) + '-add-x/proposal.md'), true)
  const spec = fs.entries.get('openspec/specs/x/spec.md')
  expect('archive merged spec', spec !== undefined && spec.content.includes('User login'), true)
}

// ---- /spec verify: flash judge, verdicts, verify.md ----
{
  const seed = {
    'openspec/changes/add-x/proposal.md': { content: 'p' },
    'openspec/changes/add-x/tasks.md': { content: '- [x] a' },
    'openspec/changes/add-x/specs/x/spec.md': { content: goodDelta },
    'src/app.js': { content: '// implementation' },
  }
  const judgeOut = [
    { type: 'block-end', block: { type: 'text', text: 'OK User login: Valid credentials — login implemented\nFAIL User login: Wrong password — not rejected yet' } },
  ]
  let sawPrompt = null
  const gen = () => {
    return (async function* () {
      for (const c of judgeOut) yield c
    })()
  }
  const { commandDef, fs } = makeRuntime({
    seed,
    llmStream: (opts) => { sawPrompt = opts.messages[0].content[0].text; return gen() },
    models: [{ id: 'deepseek-chat' }],
  })
  const { agent } = makeAgent()
  const out = await commandDef.handler({ rawInput: ' verify add-x', agent, signal: signal() })
  expect('verify one fail → error kind', out.kind, 'error')
  expect('verify mentions pass', out.text.includes('1/2'), true)
  expect('verify prompt collected workspace files', sawPrompt !== null && sawPrompt.includes('src/app.js'), true)
  const verifyMd = fs.entries.get('openspec/changes/add-x/verify.md')
  expect('verify.md written', verifyMd !== undefined, true)
  expect('verify.md has table', verifyMd.content.includes('✅') && verifyMd.content.includes('❌'), true)
}

// ---- auto-validate listener: marker in proposing state steers a fix ----
{
  const base = {
    snapshotState: { initialized: true, change: { id: 'add-x', title: 'x', status: 'proposing', seq: 1 } },
    seed: {
      'openspec/changes/add-x/proposal.md': { content: 'p' },
      // tasks.md missing on purpose → validation fails
      'openspec/changes/add-x/specs/x/spec.md': { content: goodDelta },
    },
  }
  const runtime2 = makeRuntime(base)
  const { agent, steered } = makeAgent()
  runtime2.ctx.agents.get = (id) => agent
  const sessionListener = runtime2.listeners.find(([name]) => name === 'session/event')
  expect('listener registered', sessionListener !== undefined, true)
  sessionListener[1](
    { id: 's1', header: { cwd: '/ws' } },
    { type: 'assistant/message', seq: 9, data: { message: { content: [{ type: 'text', text: 'done\nSPEC_CHANGE_ID: add-x' }] } } },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect('auto-validate steered fix', steered.length, 1)
  expect('fix prompt has id', steered[0].content[0].text.includes('add-x'), true)
  expect('fix prompt names error', steered[0].content[0].text.includes('tasks.md'), true)
}

console.log(failures ? `FAILURES: ${failures}` : 'ALL OK')
process.exitCode = failures ? 1 : 0
