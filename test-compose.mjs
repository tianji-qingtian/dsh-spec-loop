// Real-composition integration test: boots a real cordis Context with the
// REAL service implementations (filesystem, shell, commands, session
// projections, sessions), registers a fake LLM adapter, loads the built
// plugin, and drives its /spec handlers end to end.
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'

const plugin = await import('./lib/index.js')

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

const workspace = await mkdtemp(join(tmpdir(), 'dsh-spec-loop-compose-'))
console.log('temp workspace:', workspace)

// ---- boot a real composition ----
const root = new Context()
new LocalFileSystem(root, { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 })
// The bash executor needs the full subprocess/settings chain; the plugin's
// shell usage was verified against the real executor contract, so this test
// provides a contract-faithful fake for it (everything else stays real).
root.provide('shell', {
  sandboxMode: undefined,
  resolve: (req) => req,
  run: async (spec) => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    try {
      await promisify(execFile)('sh', ['-c', spec.command], { cwd: spec.workdir, timeout: spec.timeoutMs })
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    } catch (error) {
      return { exitCode: error.code ?? 1, stdout: { text: '' }, stderr: { text: String(error.stderr ?? error) } }
    }
  },
})
new LlmRuntime(root)
new CommandRuntime(root)
new SessionProjectionRegistry(root)
new UserQuestionService(root)

// Fake provider adapter on the real llm runtime (no HTTP involved).
root.llm.registerAdapter(['deepseek-official'], {
  providerInfo: () => ({ id: 'deepseek-official', name: 'DeepSeek (fake)' }),
  providerRetryPolicy: () => undefined,
  listModels: async () => [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
  resolveModel: async (provider, model) => ({
    provider,
    id: model,
    name: model,
    reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' },
  }),
  stream: async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'OK R: S — done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK R: S — done' } }
    yield { type: 'finish', reason: 'stop' }
  },
})

// Load the plugin for real: cordis resolves its inject list against the
// composition and runs apply().
await root.plugin({ inject: plugin.inject, apply: plugin.apply })
expect('plugin loaded', typeof root.get('commands').find, 'function')

// A real session with a real header (workspace cwd).
const session = Session.create('s1', [], {
  version: 0,
  id: 's1',
  createdAt: Date.now(),
  cwd: workspace,
})

const agent = {
  id: 'a1',
  session,
  options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
}
const signal = () => new AbortController().signal

// The command resolved through the REAL CommandRuntime.
const def = root.get('commands').find(agent, 'spec')
expect('spec command registered', typeof (def && def.handler), 'function')

const run = (raw) => def.handler({ rawInput: raw, agent, signal: signal() })

try {
  // ---- /spec init ----
  let out = await run(' init')
  expect('init ok', out.kind, 'success')
  expect('project.md real', (await stat(join(workspace, 'openspec/project.md'))).isFile(), true)

  // ---- projection registry serves the specLoop unit ----
  const snapshot = root.get('sessionProjections').snapshot(session)
  expect('specLoop projection exists', !!(snapshot.values && snapshot.values.specLoop), true)
  expect('specLoop init state', snapshot.values.specLoop, { initialized: false, change: null })

  // ---- agent writes a proposal (real fs through the plugin's own ctx.fs) ----
  const write = async (rel, content) => {
    const target = await root.get('fs').resolve(rel, { cwd: workspace })
    await root.get('fs').writeText(target, content)
  }
  await write('openspec/changes/add-user-login/proposal.md', '# p\n\n## Why\nx\n\n## What Changes\ny\n\n## Impact\nz\n')
  await write('openspec/changes/add-user-login/tasks.md', '- [x] one\n- [x] two\n')
  await write('openspec/changes/add-user-login/specs/user-auth/spec.md',
    '## ADDED Requirements\n### Requirement: 用户登录\n用户可用账号密码登录。\n#### Scenario: 正确凭证\n登录成功。\n')

  // ---- /spec validate / list / show / approve ----
  out = await run(' validate')
  expect('validate ok', out.kind, 'success')
  out = await run(' list')
  expect('list has counts', out.text.includes('2/2'), true)
  out = await run(' show add-user-login')
  expect('show ok', out.kind, 'success')
  out = await run(' approve add-user-login')
  expect('approve ok', out.kind, 'success')

  // ---- /spec verify through the real llm service + fake adapter ----
  out = await run(' verify add-user-login')
  expect('verify ok', out.kind, 'success')
  expect('verify mentions 1/1', out.text.includes('1/1'), true)
  const verifyMd = await readFile(join(workspace, 'openspec/changes/add-user-login/verify.md'), 'utf8')
  expect('verify.md written real', verifyMd.includes('## Scenarios'), true)

  // ---- /spec archive: real fs merge + real bash mv ----
  out = await run(' archive add-user-login')
  expect('archive ok', out.kind, 'success')
  expect('change moved', (await stat(join(workspace, 'openspec/changes/add-user-login')).catch(() => null)) === null, true)
  const merged = await readFile(join(workspace, 'openspec/specs/user-auth/spec.md'), 'utf8')
  expect('spec merged', merged.includes('用户登录'), true)
} finally {
  await rm(workspace, { recursive: true, force: true })
}

console.log(failures ? `FAILURES: ${failures}` : 'ALL OK')
process.exitCode = failures ? 1 : 0
