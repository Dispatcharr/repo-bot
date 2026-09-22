import * as core from '@actions/core'
import * as github from '@actions/github'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const VALID_PROVIDERS = ['auto', 'copilot', 'openai'] as const
const VALID_STATUSES = ['still-an-issue', 'fixed-released', 'fixed-unreleased', 'unclear', 'working-as-designed', 'invalid', 'duplicate', 'related'] as const
const VALID_EFFORTS = ['trivial', 'small', 'medium', 'large'] as const
const VALID_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const
const CLOSING_DISPOSITIONS = new Set(['close-completed', 'close-duplicate', 'close-not-planned', 'close-invalid', 'close-wontfix', 'close-stale', 'working-as-designed'])

type Provider = typeof VALID_PROVIDERS[number]
type Octokit = ReturnType<typeof github.getOctokit>
type TriageResult = {
  status: typeof VALID_STATUSES[number]
  statusReason: string
  effort: typeof VALID_EFFORTS[number]
  effortReason: string
  priority: typeof VALID_PRIORITIES[number]
  priorityReason: string
  functionalArea: string
  disposition: string
  dispositionReason: string
  labelsToAdd: string[]
  labelsToRemove: string[]
  relatedIssueNumbers: number[]
  comment: string
}

function csv(input: string): string[] {
  return input.split(',').map(value => value.trim()).filter(Boolean)
}

function parsePositiveInteger(input: string, name: string): number {
  const value = Number(input)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`)
  return value
}

function hasLabel(labels: Array<string | { name?: string | null }>, name: string): boolean {
  return labels.some(label => (typeof label === 'string' ? label : label.name) === name)
}

function markerComment(comment: { body?: string | null, user?: { login?: string | null } | null }, marker: string, botLogin: string): boolean {
  return comment.user?.login === botLogin && comment.body?.includes(`<!-- ${marker} -->`) === true
}

async function isCollaborator(octokit: Octokit, owner: string, repo: string, username: string): Promise<boolean> {
  try {
    await octokit.rest.repos.checkCollaborator({ owner, repo, username })
    return true
  } catch {
    return false
  }
}

function quoteEvidence(name: string, value: unknown): string {
  return `<untrusted-evidence source="${name}">\n${JSON.stringify(value, null, 2)}\n</untrusted-evidence>`
}

function searchTerms(title: string, body: string | null): string {
  return `${title} ${body ?? ''}`
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4)
    .slice(0, 8)
    .join(' ')
}

function parseRepository(input: string, fallback: { owner: string, repo: string }): { owner: string, repo: string } {
  if (!input.trim()) return fallback
  const [owner, repo, extra] = input.trim().split('/')
  if (!owner || !repo || extra || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('context-repository must use owner/repository format')
  }
  return { owner, repo }
}

async function readContextFiles(octokit: Octokit, owner: string, repo: string, ref: string, files: string[], maxBytes: number): Promise<Record<string, string>> {
  const contexts: Record<string, string> = {}

  for (const file of files) {
    if (!file || file.startsWith('/') || file.split(/[\\/]/).includes('..')) {
      core.warning(`Skipping unsafe context file path: ${file}`)
      continue
    }
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: file, ref })
      if (Array.isArray(data) || data.type !== 'file' || !data.content) {
        core.warning(`Skipping non-file context path: ${file}`)
        continue
      }
      contexts[`${ref}:${file}`] = Buffer.from(data.content, 'base64').subarray(0, maxBytes).toString('utf8')
    } catch {
      core.info(`Context file unavailable from ${owner}/${repo}: ${file}`)
    }
  }
  return contexts
}

async function collectRepositoryContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchInput: string,
  files: string[],
  terms: string,
  maxBytes: number,
  maxFiles: number,
): Promise<Record<string, string>> {
  const { data: repository } = await octokit.rest.repos.get({ owner, repo })
  const branch = branchInput.trim() || repository.default_branch
  if (files.length > 0) return readContextFiles(octokit, owner, repo, branch, files, maxBytes)

  const queryTerms = terms.split(' ').slice(0, 3)
  if (queryTerms.length === 0) {
    core.warning(`No searchable issue terms for ${owner}/${repo}@${branch}; no repository context included`)
    return {}
  }
  try {
    const searches = await Promise.all(queryTerms.map(term => octokit.rest.search.code({
      q: `repo:${owner}/${repo} ref:${branch} ${term}`,
      per_page: maxFiles,
    })))
    const paths = [...new Set(searches.flatMap(search => search.data.items.map(item => item.path)))].slice(0, maxFiles)
    core.info(`Found ${paths.length} repository context file(s) in ${owner}/${repo}@${branch}`)
    return readContextFiles(octokit, owner, repo, branch, paths, maxBytes)
  } catch (error) {
    core.warning(`Repository context search failed for ${owner}/${repo}@${branch}: ${(error as Error).message}`)
    return {}
  }
}

function userPrompt(input: {
  issue: unknown
  comments: unknown
  labels: string[]
  relatedIssues: unknown
  contextFiles: Record<string, string>
  allowedDispositions: string[]
}): string {
  return [
    'Return one JSON object with this exact shape:',
    JSON.stringify({
      status: 'one allowed status', statusReason: 'evidence-based string', effort: 'one allowed effort', effortReason: 'evidence-based string',
      priority: 'one allowed priority', priorityReason: 'evidence-based string', functionalArea: 'affected component or Unclear', disposition: 'one allowed disposition', dispositionReason: 'evidence-based string',
      labelsToAdd: ['repository label names'], labelsToRemove: ['repository label names'], relatedIssueNumbers: [123], comment: 'concise report',
    }, null, 2),
    `Allowed status values: ${VALID_STATUSES.join(', ')}`,
    `Allowed effort values: ${VALID_EFFORTS.join(', ')}`,
    `Allowed priority values: ${VALID_PRIORITIES.join(', ')}`,
    `Allowed disposition values: ${input.allowedDispositions.join(', ')}`,
    `Repository labels: ${JSON.stringify(input.labels)}`,
    quoteEvidence('issue', input.issue),
    quoteEvidence('issue-comments', input.comments),
    quoteEvidence('related-issues', input.relatedIssues),
    quoteEvidence('repository-context', input.contextFiles),
  ].join('\n\n')
}

async function readPrompt(promptFile: string): Promise<string> {
  const path = promptFile || resolve(__dirname, '..', 'prompts', 'triage.md')
  return readFile(path, 'utf8')
}

async function requestOpenAi(baseUrl: string, key: string, model: string, system: string, user: string): Promise<unknown> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  })
  if (!response.ok) throw new Error(`Inference request failed with HTTP ${response.status}`)
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error('Inference response did not contain a message')
  try {
    return JSON.parse(content)
  } catch {
    throw new Error('Inference response was not valid JSON')
  }
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const timeout = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(new Error(`Unable to start ${command}: ${error.message}`))
    })
    child.once('close', code => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`${command} failed with exit code ${code ?? 'unknown'}: ${stderr.trim().slice(0, 2000)}`))
      else resolveOutput(stdout)
    })
  })
}

async function copilotCliPath(configuredPath: string, version: string): Promise<string> {
  if (configuredPath) return configuredPath
  if (version !== 'latest' && !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
    throw new Error('copilot-cli-version must be latest or an exact semver version')
  }
  const prefix = resolve(process.env.RUNNER_TEMP ?? process.cwd(), 'repo-bot-copilot-cli')
  const executable = resolve(prefix, 'node_modules', '.bin', 'copilot')
  try {
    await access(executable)
    return executable
  } catch {
    await mkdir(prefix, { recursive: true })
    core.info(`Installing Copilot CLI (${version}) in the runner temporary directory`)
    await runCommand('npm', ['install', '--no-save', '--prefix', prefix, `@github/copilot@${version}`], process.env, 120_000)
    return executable
  }
}

async function requestCopilot(token: string, model: string, configuredCliPath: string, cliVersion: string, system: string, user: string): Promise<unknown> {
  if (!token) throw new Error('provider-key must be the workflow GITHUB_TOKEN when provider is copilot')
  const prompt = `${system}\n\n${user}`
  let output: string
  try {
    output = await runCommand(await copilotCliPath(configuredCliPath, cliVersion), [
        '--prompt', prompt,
        '--model', model || 'auto',
        '--deny-tool=shell',
        '--deny-tool=write',
      ],
      // Installation tokens are accepted only through the CLI runtime environment.
      { ...process.env, COPILOT_GITHUB_TOKEN: token, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
      120_000)
  } catch (error) {
    throw new Error((error as Error).message.split(token).join('***'))
  }
  try {
    return JSON.parse(output)
  } catch {
    throw new Error('Copilot response was not valid JSON')
  }
}

function isGitHubToken(value: string): boolean {
  return /^(gh[opsu]_\w+|github_pat_\w+)/.test(value)
}

async function requestInference(provider: Provider, key: string, model: string, baseUrl: string, cliPath: string, cliVersion: string, system: string, user: string): Promise<unknown> {
  if (provider === 'copilot') return requestCopilot(key, model, cliPath, cliVersion, system, user)
  if (provider === 'auto' && isGitHubToken(key)) return requestCopilot(key, model, cliPath, cliVersion, system, user)
  if (!key || !model) throw new Error('provider-key and provider-model are required for OpenAI-compatible inference')
  if (provider === 'auto') core.info('provider-key is not a GitHub token; using the OpenAI-compatible fallback')
  return requestOpenAi(baseUrl, key, model, system, user)
}

function validateResult(value: unknown, repositoryLabels: Set<string>, allowedDispositions: Set<string>, maxCommentLength: number, marker: string): TriageResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Inference response must be a JSON object')
  const result = value as Record<string, unknown>
  const string = (key: string): string => {
    if (typeof result[key] !== 'string' || !result[key].trim()) throw new Error(`Inference response field ${key} must be a non-empty string`)
    return result[key].trim()
  }
  const strings = (key: string): string[] => {
    if (!Array.isArray(result[key]) || !result[key].every(item => typeof item === 'string')) throw new Error(`Inference response field ${key} must be a string array`)
    return [...new Set(result[key] as string[])].map(item => item.trim()).filter(Boolean)
  }
  const numbers = (key: string): number[] => {
    if (!Array.isArray(result[key]) || !result[key].every(item => Number.isInteger(item) && (item as number) > 0)) throw new Error(`Inference response field ${key} must be a positive integer array`)
    return [...new Set(result[key] as number[])]
  }
  const status = string('status') as TriageResult['status']
  const effort = string('effort') as TriageResult['effort']
  const priority = string('priority') as TriageResult['priority']
  const functionalArea = string('functionalArea')
  const disposition = string('disposition')
  if (!VALID_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`)
  if (!VALID_EFFORTS.includes(effort)) throw new Error(`Invalid effort: ${effort}`)
  if (!VALID_PRIORITIES.includes(priority)) throw new Error(`Invalid priority: ${priority}`)
  if (functionalArea.length > 120) throw new Error('Inference response functionalArea exceeds 120 characters')
  if (!allowedDispositions.has(disposition)) throw new Error(`Invalid disposition: ${disposition}`)
  const labelsToAdd = strings('labelsToAdd')
  const labelsToRemove = strings('labelsToRemove')
  if ([...labelsToAdd, ...labelsToRemove].some(label => !repositoryLabels.has(label))) throw new Error('Inference response proposed a label that does not exist in this repository')
  if (labelsToAdd.some(label => labelsToRemove.includes(label))) throw new Error('Inference response cannot add and remove the same label')
  const comment = string('comment')
  if (comment.length > maxCommentLength) throw new Error(`Inference response comment exceeds max-comment-length (${maxCommentLength})`)
  if (comment.includes('<!--') || comment.includes(marker)) throw new Error('Inference response comment contains a reserved marker')
  return { status, statusReason: string('statusReason'), effort, effortReason: string('effortReason'), priority, priorityReason: string('priorityReason'), functionalArea, disposition, dispositionReason: string('dispositionReason'), labelsToAdd, labelsToRemove, relatedIssueNumbers: numbers('relatedIssueNumbers'), comment }
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const botLogin = core.getInput('bot-login', { required: true })
  const provider = (core.getInput('provider') || 'auto') as Provider
  if (!VALID_PROVIDERS.includes(provider)) throw new Error(`Invalid provider: ${provider}`)
  const triageLabel = core.getInput('triage-label') || 'Triage'
  const marker = core.getInput('completion-marker') || 'repo-bot:issue-triage'
  const allowedDispositions = new Set(csv(core.getInput('allowed-dispositions')))
  if (allowedDispositions.size === 0) throw new Error('allowed-dispositions must not be empty')
  const allowLabelChanges = core.getBooleanInput('allow-label-changes')
  const allowClose = core.getBooleanInput('allow-close')
  const removeTriageLabel = core.getBooleanInput('remove-triage-label')
  const bypassForMembers = core.getBooleanInput('bypass-for-members')
  const dryRun = core.getBooleanInput('dry-run')
  const maxContextBytes = parsePositiveInteger(core.getInput('max-context-bytes'), 'max-context-bytes')
  const maxContextFiles = parsePositiveInteger(core.getInput('max-context-files'), 'max-context-files')
  const maxRelatedIssues = parsePositiveInteger(core.getInput('max-related-issues'), 'max-related-issues')
  const maxCommentLength = parsePositiveInteger(core.getInput('max-comment-length'), 'max-comment-length')
  const { eventName, payload, repo } = github.context
  if (eventName !== 'issues' || !payload.issue) return core.info('Issue Triage only runs on issue events')
  const eventAction = payload.action
  const addedLabel = payload.label?.name
  if (eventAction !== 'opened' && !(eventAction === 'labeled' && addedLabel === triageLabel)) return core.info('Event does not add the triage label, skipping')

  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo
  const contextRepository = parseRepository(core.getInput('context-repository'), { owner, repo: repoName })
  const issueNumber = payload.issue.number
  const { data: issue } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issueNumber })
  if (issue.state !== 'open' || !hasLabel(issue.labels, triageLabel)) return core.info(`Issue #${issueNumber} is not an open triage candidate`)
  if (bypassForMembers && issue.user?.login && await isCollaborator(octokit, owner, repoName, issue.user.login)) return core.info(`Skipping collaborator issue #${issueNumber}`)
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo: repoName, issue_number: issueNumber, per_page: 100 })
  if (comments.some(comment => markerComment(comment, marker, botLogin))) return core.info(`Issue #${issueNumber} was already triaged by this bot`)

  const [labels, relatedIssues, contextFiles, prompt] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo: repoName, per_page: 100 }),
    octokit.rest.search.issuesAndPullRequests({ q: `repo:${contextRepository.owner}/${contextRepository.repo} is:issue ${searchTerms(issue.title, issue.body ?? null)}`, per_page: maxRelatedIssues }),
    collectRepositoryContext(
      octokit,
      contextRepository.owner,
      contextRepository.repo,
      core.getInput('context-branch'),
      csv(core.getInput('context-files')),
      searchTerms(issue.title, issue.body ?? null),
      maxContextBytes,
      maxContextFiles,
    ),
    readPrompt(core.getInput('prompt-file')),
  ])
  const repositoryLabels = new Set(labels.map(label => label.name))
  const result = validateResult(await requestInference(provider, core.getInput('provider-key'), core.getInput('provider-model'), core.getInput('provider-base-url'), core.getInput('copilot-cli-path'), core.getInput('copilot-cli-version'), prompt, userPrompt({
    issue: { number: issue.number, title: issue.title, body: issue.body, createdAt: issue.created_at, updatedAt: issue.updated_at, labels: issue.labels.map(label => typeof label === 'string' ? label : label.name) },
    comments: comments.map(comment => ({ author: comment.user?.login, createdAt: comment.created_at, body: comment.body })),
    labels: [...repositoryLabels],
    relatedIssues: relatedIssues.data.items.filter(item => item.number !== issueNumber).map(item => ({ number: item.number, title: item.title, state: item.state, body: item.body, labels: item.labels })),
    contextFiles,
    allowedDispositions: [...allowedDispositions],
  })), repositoryLabels, allowedDispositions, maxCommentLength, marker)
  core.info(`Validated triage for issue #${issueNumber}: ${JSON.stringify({ status: result.status, effort: result.effort, priority: result.priority, disposition: result.disposition, labelsToAdd: result.labelsToAdd, labelsToRemove: result.labelsToRemove, relatedIssueNumbers: result.relatedIssueNumbers })}`)

  const report = `**Assessment:** ${result.status}. ${result.statusReason}\n\n**Effort:** ${result.effort}. ${result.effortReason}\n\n**Functional area:** ${result.functionalArea}\n\n**Priority:** ${result.priority}. ${result.priorityReason}\n\n**Recommendation:** ${result.disposition}. ${result.dispositionReason}\n\n${result.comment}\n\n<!-- ${marker} -->`
  if (dryRun) {
    core.info(`[dry-run] Would add labels: ${result.labelsToAdd.join(', ') || '(none)'}`)
    core.info(`[dry-run] Would remove labels: ${result.labelsToRemove.join(', ') || '(none)'}${removeTriageLabel ? `, ${triageLabel}` : ''}`)
    core.info(`[dry-run] Would comment: ${report}`)
    core.info(`[dry-run] Would close: ${allowClose && CLOSING_DISPOSITIONS.has(result.disposition)}`)
    return
  }
  if (allowLabelChanges && result.labelsToAdd.length) await octokit.rest.issues.addLabels({ owner, repo: repoName, issue_number: issueNumber, labels: result.labelsToAdd })
  if (allowLabelChanges) {
    for (const label of result.labelsToRemove) await octokit.rest.issues.removeLabel({ owner, repo: repoName, issue_number: issueNumber, name: label })
  }
  await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: issueNumber, body: report })
  if (allowClose && CLOSING_DISPOSITIONS.has(result.disposition)) await octokit.rest.issues.update({ owner, repo: repoName, issue_number: issueNumber, state: 'closed' })
  if (removeTriageLabel) await octokit.rest.issues.removeLabel({ owner, repo: repoName, issue_number: issueNumber, name: triageLabel })
  core.info(`Applied triage to issue #${issueNumber}`)
}

run().catch(error => core.setFailed((error as Error).message))
