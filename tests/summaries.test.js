const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const actions = ['branch-guard', 'comment-collapse', 'issue-triage', 'pr-freshness', 'pr-intake', 'proposal-guard', 'template-enforcer']

function invoke(action, inputs = {}, withSummary = true) {
  const dir = mkdtempSync(join(tmpdir(), 'action-summary-test-'))
  try {
    const summary = join(dir, 'summary.md')
    const event = join(dir, 'event.json')
    writeFileSync(summary, '')
    writeFileSync(event, '{}')
    const env = { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'owner/repo' }
    for (const key of Object.keys(env)) if (key.startsWith('INPUT_') || key === 'GITHUB_STEP_SUMMARY') delete env[key]
    if (withSummary) env.GITHUB_STEP_SUMMARY = summary
    for (const [key, value] of Object.entries(inputs)) env[`INPUT_${key.toUpperCase()}`] = value
    const result = spawnSync(process.execPath, [resolve('actions', action, 'dist/index.js')], { env, encoding: 'utf8' })
    return { ...result, summary: readFileSync(summary, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const action of actions) {
  test(`${action} summarizes invalid input failures`, () => {
    const result = invoke(action)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.summary, /Outcome: Failed/)
    assert.match(result.summary, /Failed:/)
  })
}

test('branch guard summarizes an unsupported event', () => {
  const result = invoke('branch-guard', { 'github-token': 'test', 'allowed-targets': 'main', 'bypass-for-members': 'false' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.summary, /Outcome: Completed/)
  assert.match(result.summary, /workflow_dispatch/)
})

test('summary write failure does not fail an otherwise successful action', () => {
  const result = invoke('branch-guard', { 'github-token': 'test', 'allowed-targets': 'main', 'bypass-for-members': 'false' }, false)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Could not write workflow summary/)
})

test('summary escapes untrusted event data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'action-summary-escape-'))
  try {
    const summary = join(dir, 'summary.md')
    const event = join(dir, 'event.json')
    writeFileSync(summary, '')
    writeFileSync(event, '{}')
    const result = spawnSync(process.execPath, [resolve('actions/branch-guard/dist/index.js')], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_EVENT_NAME: '<script>bad</script>', GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'owner/repo', 'INPUT_GITHUB-TOKEN': 'test', 'INPUT_ALLOWED-TARGETS': 'main', 'INPUT_BYPASS-FOR-MEMBERS': 'false' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const text = readFileSync(summary, 'utf8')
    assert.match(text, /&lt;script&gt;bad&lt;\/script&gt;/)
    assert.doesNotMatch(text, /<script>/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
