const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { spawn } = require('node:child_process')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const DEFAULT_INPUTS = {
  provider: 'openai',
  'provider-key': '',
  'provider-model': '',
  'provider-base-url': 'https://openrouter.ai/api/v1',
  'copilot-cli-path': '',
  'copilot-cli-version': 'latest',
  'prompt-file': '',
  'triage-label': 'Triage',
  'completion-marker': 'repo-bot:issue-triage',
  'context-repository': '',
  'context-branch': 'dev',
  'allowed-dispositions': 'keep-open,needs-experienced-contributor,close-completed,close-duplicate,close-not-planned,close-invalid,close-wontfix,close-stale,working-as-designed',
  'allow-label-changes': 'true',
  'allow-type-changes': 'true',
  'allow-close': 'true',
  'allow-retriage': 'true',
  'allow-non-triage': 'true',
  'allow-closed': 'true',
  'bypass-for-members': 'false',
  'context-files': 'README.md,CHANGELOG.md,pyproject.toml',
  'max-context-bytes': '8000',
  'max-context-total-bytes': '24000',
  'max-context-files': '10',
  'max-related-issues': '5',
  'max-comment-length': '4000',
  'inference-timeout-seconds': '300',
  'inference-retries': '5',
  'validation-retries': '3',
  'dry-run': 'false',
}

function usage() {
  console.error('Usage: GITHUB_TOKEN=<token> OPENROUTER_API_KEY=<key> TRIAGE_MODEL=<model> yarn triage:dry-run https://github.com/OWNER/REPO/issues/NUMBER')
}

function parseIssueUrl(value) {
  const url = new URL(value)
  const match = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/)
  if (!match) throw new Error('Expected a GitHub issue URL in the form https://github.com/OWNER/REPO/issues/NUMBER')
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

function inputEnvironment(inputs) {
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.replace(/ /g, '_').toUpperCase()}`, value]))
}

async function run() {
  const [issueUrl] = process.argv.slice(2)
  if (!issueUrl || process.argv.length !== 3) {
    usage()
    process.exitCode = 1
    return
  }
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required for GitHub API access')
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for OpenRouter inference')
  if (!process.env.TRIAGE_MODEL) throw new Error('TRIAGE_MODEL is required for OpenRouter inference')

  const issue = parseIssueUrl(issueUrl)
  const inputs = {
    ...DEFAULT_INPUTS,
    'provider-key': process.env.OPENROUTER_API_KEY,
    'provider-model': process.env.TRIAGE_MODEL,
    'github-token': process.env.GITHUB_TOKEN,
    'bot-login': 'dispatcharr-issues-bot[bot]',
    'dry-run': 'true',
  }
  const eventDirectory = await mkdtemp(join(tmpdir(), 'issue-triage-'))
  const eventPath = join(eventDirectory, 'event.json')
  await writeFile(eventPath, JSON.stringify({ action: 'opened', issue: { number: issue.number }, repository: { full_name: `${issue.owner}/${issue.repo}` } }))

  try {
    const child = spawn(process.execPath, [resolve(__dirname, '..', 'actions', 'issue-triage', 'dist', 'index.js')], {
      env: {
        ...process.env,
        ...inputEnvironment(inputs),
        GITHUB_EVENT_NAME: 'issues',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: `${issue.owner}/${issue.repo}`,
        GITHUB_API_URL: process.env.GITHUB_API_URL || 'https://api.github.com',
      },
      stdio: 'inherit',
    })
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', code => resolveExit(code ?? 1))
    })
    process.exitCode = exitCode
  } finally {
    await rm(eventDirectory, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
