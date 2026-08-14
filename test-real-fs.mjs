// Real-filesystem smoke test for dsh-spec-loop: runs the built host handlers
// against a temp workspace backed by node:fs and a real `mv` shell, then
// checks the produced directory layout.
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { apply } from './lib/index.js'

const execFileAsync = promisify(execFile)
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

const signal = () => new AbortController().signal
const isDir = async (p) => { try { return (await stat(p)).isDirectory() } catch { return false } }
const isFile = async (p) => { try { return (await stat(p)).isFile() } catch { return false } }
const read = async (p) => readFile(p, 'utf8')

const cwd = await mkdtemp(join(tmpdir(), 'dsh-spec-loop-'))
console.log('temp workspace:', cwd)

// Real fs adapter with the ctx.fs surface.
const fsAdapter = {
  resolve: async (rel) => ({ targetKey: join(cwd, rel), displayPath: rel }),
  stat: async (target) => {
    try {
      const s = await stat(join(cwd, target.displayPath))
      return { type: s.isDirectory() ? 'directory' : 'file', version: 'v' }
    } catch { return undefined }
  },
  readText: async (target) => { try { return await readFile(join(cwd, target.displayPath), 'utf8') } catch { return '' } },
  writeText: async (target, content) => {
    const abs = join(cwd, target.displayPath)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return { version: 'v' }
  },
  listDir: async (target) => {
    try {
      const names = await readdir(join(cwd, target.displayPath))
      const out = []
      for (const name of names) {
        const s = await stat(join(cwd, target.displayPath, name))
        out.push({ name, type: s.isDirectory() ? 'directory' : 'file', target: { displayPath: target.displayPath + '/' + name } })
      }
      return out
    } catch { return [] }
  },
}

const registered = []
const steered = []
const agent = {
  id: 'a1',
  session: { id: 's1', header: { cwd } },
  options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  steer: (msg) => steered.push(msg),
}
const ctx = {
  fs: fsAdapter,
  shell: {
    resolve: (req) => req,
    run: async (spec) => {
      try {
        await execFileAsync('sh', ['-c', spec.command], { cwd, timeout: 15000 })
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      } catch (error) {
        return { exitCode: error.code ?? 1, stdout: { text: '' }, stderr: { text: String(error.stderr ?? error) } }
      }
    },
  },
  llm: { listModels: async () => [{ id: 'deepseek-chat' }], stream: async function* () { yield { type: 'block-end', block: { type: 'text', text: '' } } } },
  sessionProjections: {
    register: (def) => { registered.push(def); return () => {} },
    snapshot: () => ({ asOfSeq: 0, values: { specLoop: { initialized: true, change: { id: 'add-user-login', title: '用户登录', status: 'approved', seq: 1 } } } }),
  },
  commands: { register: (def) => { registered.push(def); return () => {} } },
  agents: { get: () => undefined },
  on: () => () => {},
  get: () => undefined,
}
apply(ctx)
const commandDef = registered.find((d) => typeof d.handler === 'function')
const run = (raw) => commandDef.handler({ rawInput: raw, agent, signal: signal() })

try {
  // ---- /spec init ----
  let out = await run(' init')
  expect('init ok', out.kind, 'success')
  expect('project.md created', await isFile(join(cwd, 'openspec/project.md')), true)
  expect('specs dir created', await isDir(join(cwd, 'openspec/specs')), true)
  expect('changes dir created', await isDir(join(cwd, 'openspec/changes')), true)
  expect('archive dir created', await isDir(join(cwd, 'openspec/changes/archive')), true)

  // ---- /spec new steers the agent ----
  out = await run(' new 做一个用户登录功能')
  expect('new ok', out.kind, 'success')
  expect('new steered', steered.length, 1)
  expect('new prompt marker', steered[0].content[0].text.includes('SPEC_CHANGE_ID'), true)

  // ---- agent writes the proposal files (simulating the steered agent) ----
  await fsAdapter.writeText({ displayPath: 'openspec/changes/add-user-login/proposal.md' },
    '# add-user-login\n\n## Why\n用户需要登录。\n\n## What Changes\n- 新增登录接口\n\n## Impact\n- 前端\n')
  await fsAdapter.writeText({ displayPath: 'openspec/changes/add-user-login/tasks.md' },
    '- [ ] 建登录接口\n- [ ] 加校验\n- [ ] 写测试\n')
  await fsAdapter.writeText({ displayPath: 'openspec/changes/add-user-login/specs/user-auth/spec.md' },
    '## ADDED Requirements\n### Requirement: 用户登录\n用户可以用账号密码登录。\n#### Scenario: 正确凭证\n登录成功。\n#### Scenario: 错误密码\n拒绝并提示。\n')

  // ---- /spec validate ----
  out = await run(' validate')
  expect('validate ok', out.kind, 'success')
  expect('validate lists id', out.text.includes('add-user-login'), true)

  // malformed delta → validate error
  await fsAdapter.writeText({ displayPath: 'openspec/changes/bad-x/proposal.md' }, 'p')
  await fsAdapter.writeText({ displayPath: 'openspec/changes/bad-x/tasks.md' }, '- [ ] x')
  await fsAdapter.writeText({ displayPath: 'openspec/changes/bad-x/specs/x/spec.md' }, '## ADDED Requirements\n### Requirement: X\nno scenario')
  out = await run(' validate bad-x')
  expect('validate catches malformed', out.kind, 'error')

  // ---- /spec show ----
  out = await run(' show add-user-login')
  expect('show ok', out.kind, 'success')
  expect('show has body', out.text.includes('用户需要登录'), true)

  // ---- /spec approve ----
  out = await run(' approve add-user-login')
  expect('approve ok', out.kind, 'success')

  // ---- /spec implement (gate passes via mocked projection) ----
  out = await run(' implement add-user-login')
  expect('implement ok', out.kind, 'success')
  expect('implement steered', steered.length, 2)

  // ---- /spec list ----
  out = await run(' list')
  expect('list ok', out.kind, 'success')
  expect('list has task counts', /3\/3|0\/3/.test(out.text), true)

  // ---- /spec archive: merge + real mv ----
  out = await run(' archive add-user-login')
  expect('archive ok', out.kind, 'success')
  expect('change moved out', await isDir(join(cwd, 'openspec/changes/add-user-login')), false)
  const archiveDir = join(cwd, 'openspec/changes/archive', new Date().toISOString().slice(0, 10) + '-add-user-login')
  expect('archive dir created', await isDir(archiveDir), true)
  expect('proposal archived', await isFile(join(archiveDir, 'proposal.md')), true)
  const mergedSpec = await read(join(cwd, 'openspec/specs/user-auth/spec.md'))
  expect('spec merged into specs/', mergedSpec.includes('用户登录'), true)
  expect('scenario preserved', mergedSpec.includes('#### Scenario: 正确凭证'), true)

  // ---- /spec validate still catches the remaining malformed change ----
  out = await run(' validate')
  expect('validate all finds bad-x', out.kind, 'error')
  expect('validate names bad-x', out.text.includes('bad-x'), true)
} finally {
  await rm(cwd, { recursive: true, force: true })
}

console.log(failures ? `FAILURES: ${failures}` : 'ALL OK')
process.exitCode = failures ? 1 : 0
