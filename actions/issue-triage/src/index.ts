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
const ISSUE_TYPE_LABELS = new Set(['Bug', 'Feature Request'])

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

function searchTerms(title: string, body: string | null): string[] {
  return `${title} ${body ?? ''}`
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4)
    .slice(0, 3)
}


function parseRepository(input: string, fallback: { owner: string, repo: string }): { owner: string, repo: string } {
  if (!input.trim()) return fallback
  const [owner, repo, extra] = input.trim().split('/')
  if (!owner || !repo || extra || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('context-repository must use owner/repository format')
  }
  return { owner, repo }
}

function truncateContext(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  return bytes.length <= maxBytes ? value : `${bytes.subarray(0, Math.max(0, maxBytes - 16)).toString('utf8')}\n[truncated]`
}

function contextExcerpt(value: string, queries: string[], maxBytes: number): string {
  const lowerValue = value.toLowerCase()
  const match = queries.map(query => lowerValue.indexOf(query.toLowerCase())).find(index => index >= 0)
  if (match === undefined) return truncateContext(value, maxBytes)
  const start = Math.max(0, match - 1_500)
  const end = Math.min(value.length, match + 2_500)
  return truncateContext(`${start > 0 ? '[... omitted ...]\n' : ''}${value.slice(start, end)}${end < value.length ? '\n[... omitted ...]' : ''}`, maxBytes)
}

async function readContextFiles(octokit: Octokit, owner: string, repo: string, ref: string, files: string[], maxBytes: number, totalBytes: number, queries: string[] = []): Promise<{ contexts: Record<string, string>, bytes: number }> {
  const contexts: Record<string, string> = {}
  let bytes = 0

  for (const file of files) {
    if (bytes >= totalBytes) break
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
      const content = Buffer.from(data.content, 'base64').toString('utf8')
      const excerpt = queries.length > 0 ? contextExcerpt(content, queries, Math.min(maxBytes, totalBytes - bytes)) : truncateContext(content, Math.min(maxBytes, totalBytes - bytes))
      contexts[`${ref}:${file}`] = excerpt
      bytes += Buffer.byteLength(excerpt)
    } catch {
      core.info(`Context file unavailable from ${owner}/${repo}: ${file}`)
    }
  }
  return { contexts, bytes }
}

function retryDelay(error: unknown): number | undefined {
  const match = (error instanceof Error ? error.message : String(error)).match(/try again in ([\d.]+)s/i)
  return match ? Math.ceil(Number(match[1])) * 1_000 + 1_000 : undefined
}

async function searchCodeWithRetry(octokit: Octokit, owner: string, repo: string, branch: string, query: string, maxFiles: number): Promise<Awaited<ReturnType<typeof octokit.rest.search.code>>['data']> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await octokit.rest.search.code({ q: `repo:${owner}/${repo} ref:${branch} ${query}`, per_page: maxFiles })).data
    } catch (error) {
      const delay = retryDelay(error)
      if (!delay || attempt === 2) throw error
      core.warning(`Code search "${query}" was rate-limited. Retrying in ${Math.round(delay / 1_000)}s (${attempt + 1}/2)`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error(`Code search retries exhausted for "${query}"`)
}

async function collectRepositoryContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchInput: string,
  files: string[],
  queries: string[],
  maxBytes: number,
  maxTotalBytes: number,
  maxFiles: number,
): Promise<Record<string, string>> {
  const { data: repository } = await octokit.rest.repos.get({ owner, repo })
  const branch = branchInput.trim() || repository.default_branch
  const explicit = files.length > 0 ? await readContextFiles(octokit, owner, repo, branch, files, maxBytes, maxTotalBytes) : { contexts: {}, bytes: 0 }
  if (files.length > 0) core.info(`Loaded ${Object.keys(explicit.contexts).length} configured context file(s), using ${explicit.bytes}/${maxTotalBytes} bytes: ${Object.keys(explicit.contexts).join(', ') || '(none)'}`)

  if (queries.length === 0) {
    core.warning(`No searchable issue terms for ${owner}/${repo}@${branch}; no additional repository context included`)
    return explicit.contexts
  }
  try {
    core.info(`Searching ${owner}/${repo}@${branch} code with ${queries.length} query(s): ${queries.join(', ')}`)
    const searches = []
    for (const query of queries) {
      const search = await searchCodeWithRetry(octokit, owner, repo, branch, query, maxFiles)
      core.info(`Code search "${query}" found ${search.items.length} file(s)`)
      searches.push(search)
    }
    const paths = [...new Set(searches.flatMap(search => search.items.map(item => item.path)))].filter(path => !files.includes(path)).slice(0, maxFiles)
    core.info(`Found ${paths.length} code context file(s): ${paths.join(', ') || '(none)'}`)
    const code = await readContextFiles(octokit, owner, repo, branch, paths, maxBytes, maxTotalBytes - explicit.bytes, queries)
    const contexts = { ...explicit.contexts, ...code.contexts }
    core.info(`Including ${Object.keys(contexts).length} total repository context file(s), using ${explicit.bytes + code.bytes}/${maxTotalBytes} bytes`)
    return contexts
  } catch (error) {
    core.warning(`Repository context search failed for ${owner}/${repo}@${branch}: ${(error as Error).message}`)
    return explicit.contexts
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

function redactError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-or-v1|sk)-[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 1_000)
}

async function requestOpenAi(baseUrl: string, key: string, model: string, system: string, user: string, timeoutSeconds: number): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1_000)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      let message = body
      try {
        const error = JSON.parse(body) as { error?: { message?: string } }
        message = error.error?.message || body
      } catch {
        // Some OpenAI-compatible providers return non-JSON error responses.
      }
      const requestId = response.headers.get('x-request-id')
      throw new Error(`Inference request failed with HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}: ${redactError(message)}`)
    }
    const payload = await response.json() as { choices?: Array<{ finish_reason?: string | null, message?: { content?: string | null } }>, error?: { message?: string } }
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new Error(`Inference response did not contain a message (finish reason: ${payload.choices?.[0]?.finish_reason ?? 'unknown'}${payload.error?.message ? `, error: ${redactError(payload.error.message)}` : ''})`)
    try {
      return JSON.parse(content)
    } catch {
      throw new Error('Inference response was not valid JSON')
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Inference request timed out after ${timeoutSeconds} seconds`)
    throw error
  } finally {
    clearTimeout(timeout)
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

async function requestCopilot(token: string, model: string, configuredCliPath: string, cliVersion: string, system: string, user: string, timeoutSeconds: number): Promise<unknown> {
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
      timeoutSeconds * 1_000)
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

async function requestInference(provider: Provider, key: string, model: string, baseUrl: string, cliPath: string, cliVersion: string, system: string, user: string, timeoutSeconds: number): Promise<unknown> {
  if (provider === 'copilot') return requestCopilot(key, model, cliPath, cliVersion, system, user, timeoutSeconds)
  if (provider === 'auto' && isGitHubToken(key)) return requestCopilot(key, model, cliPath, cliVersion, system, user, timeoutSeconds)
  if (!key || !model) throw new Error('provider-key and provider-model are required for OpenAI-compatible inference')
  if (provider === 'auto') core.info('provider-key is not a GitHub token; using the OpenAI-compatible fallback')
  return requestOpenAi(baseUrl, key, model, system, user, timeoutSeconds)
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
  let labelsToAdd = strings('labelsToAdd')
  const labelsToRemove = strings('labelsToRemove')
  if ([...labelsToAdd, ...labelsToRemove].some(label => !repositoryLabels.has(label))) throw new Error('Inference response proposed a label that does not exist in this repository')
  if (labelsToAdd.some(label => labelsToRemove.includes(label))) throw new Error('Inference response cannot add and remove the same label')
  if (CLOSING_DISPOSITIONS.has(disposition) && labelsToAdd.length) {
    core.info('Ignoring proposed label additions for a closing disposition')
    labelsToAdd = []
  }
  const comment = string('comment')
  if (comment.length > maxCommentLength) throw new Error(`Inference response comment exceeds max-comment-length (${maxCommentLength})`)
  if (comment.includes('<!--') || comment.includes(marker)) throw new Error('Inference response comment contains a reserved marker')
  return { status, statusReason: string('statusReason'), effort, effortReason: string('effortReason'), priority, priorityReason: string('priorityReason'), functionalArea, disposition, dispositionReason: string('dispositionReason'), labelsToAdd, labelsToRemove, relatedIssueNumbers: numbers('relatedIssueNumbers'), comment }
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
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
  const allowRetriage = core.getBooleanInput('allow-retriage')
  const bypassForMembers = core.getBooleanInput('bypass-for-members')
  const dryRun = core.getBooleanInput('dry-run')
  const maxContextBytes = parsePositiveInteger(core.getInput('max-context-bytes'), 'max-context-bytes')
  const maxContextTotalBytes = parsePositiveInteger(core.getInput('max-context-total-bytes'), 'max-context-total-bytes')
  const maxContextFiles = parsePositiveInteger(core.getInput('max-context-files'), 'max-context-files')
  const maxRelatedIssues = parsePositiveInteger(core.getInput('max-related-issues'), 'max-related-issues')
  const maxCommentLength = parsePositiveInteger(core.getInput('max-comment-length'), 'max-comment-length')
  const inferenceTimeoutSeconds = parsePositiveInteger(core.getInput('inference-timeout-seconds'), 'inference-timeout-seconds')
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
  if (!allowRetriage && comments.some(comment => markerComment(comment, marker, botLogin))) return core.info(`Issue #${issueNumber} was already triaged by this bot`)
  const contextQueries = searchTerms(issue.title, issue.body ?? null).slice(0, 3)
  core.info(`Using ${contextQueries.length} deterministic code-search query(s): ${contextQueries.join(', ') || '(none)'}`)

  const contextStartedAt = Date.now()
  core.info('Phase 1/2: collecting labels, related issues, configured files, and code context')
  const [labels, relatedIssues, contextFiles, prompt] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo: repoName, per_page: 100 }),
    octokit.rest.search.issuesAndPullRequests({ q: `repo:${contextRepository.owner}/${contextRepository.repo} is:issue ${contextQueries.join(' ')}`, per_page: maxRelatedIssues }),
    collectRepositoryContext(
      octokit,
      contextRepository.owner,
      contextRepository.repo,
      core.getInput('context-branch'),
      csv(core.getInput('context-files')),
      contextQueries,
      maxContextBytes,
      maxContextTotalBytes,
      maxContextFiles,
    ),
    readPrompt(core.getInput('prompt-file')),
  ])
  const repositoryLabels = new Set(labels.map(label => label.name))
  core.info(`Phase 1/2 complete in ${((Date.now() - contextStartedAt) / 1000).toFixed(1)}s. Collected ${Object.keys(contextFiles).length} context file(s), ${relatedIssues.data.items.length} related issue candidate(s), and ${repositoryLabels.size} label(s)`)
  const triageStartedAt = Date.now()
  core.info('Phase 2/2: requesting the triage assessment with prompts/triage.md')
  const inference = await requestInference(provider, core.getInput('provider-key'), core.getInput('provider-model'), core.getInput('provider-base-url'), core.getInput('copilot-cli-path'), core.getInput('copilot-cli-version'), prompt, userPrompt({
    issue: { number: issue.number, title: issue.title, body: issue.body, createdAt: issue.created_at, updatedAt: issue.updated_at, labels: issue.labels.map(label => typeof label === 'string' ? label : label.name) },
    comments: comments.map(comment => ({ author: comment.user?.login, createdAt: comment.created_at, body: comment.body })),
    labels: [...repositoryLabels],
    relatedIssues: relatedIssues.data.items.filter(item => contextRepository.owner !== owner || contextRepository.repo !== repoName || item.number !== issueNumber).map((item, index) => ({ number: item.number, title: item.title, state: item.state, body: index < 3 ? truncateContext(item.body ?? '', 6_000) : undefined, labels: item.labels })),
    contextFiles,
    allowedDispositions: [...allowedDispositions],
  }), inferenceTimeoutSeconds)
  core.info(`Phase 2/2 complete in ${((Date.now() - triageStartedAt) / 1000).toFixed(1)}s. Validating model output`)
  const result = validateResult(inference, repositoryLabels, allowedDispositions, maxCommentLength, marker)
  core.info(`Validated triage for issue #${issueNumber}: ${JSON.stringify({ status: result.status, effort: result.effort, priority: result.priority, disposition: result.disposition, labelsToAdd: result.labelsToAdd, labelsToRemove: result.labelsToRemove, relatedIssueNumbers: result.relatedIssueNumbers })}`)

  const closing = CLOSING_DISPOSITIONS.has(result.disposition)
  const automaticLabels = [result.priority, `Area: ${result.functionalArea}`].filter(label => repositoryLabels.has(label))
  const labelsToAdd = closing
    ? []
    : [...new Set([...result.labelsToAdd.filter(label => !ISSUE_TYPE_LABELS.has(label)), ...automaticLabels])]
  if (labelsToAdd.some(label => result.labelsToRemove.includes(label))) throw new Error('Inference response cannot remove a selected priority or functional-area label')
  const duplicateIssueNumber = result.disposition === 'close-duplicate' ? result.relatedIssueNumbers[0] : undefined
  if (result.disposition === 'close-duplicate' && (result.relatedIssueNumbers.length !== 1 || !relatedIssues.data.items.some(item => item.number === duplicateIssueNumber))) {
    throw new Error('close-duplicate requires exactly one supplied related canonical issue number')
  }
  const details = `${result.statusReason}\n\n${result.comment}`
  const reportTable = `| | |\n| --- | --- |\n| Effort | ${tableCell(result.effort)}. ${tableCell(result.effortReason)} |\n| Functional area | ${tableCell(result.functionalArea)} |\n| Priority | ${tableCell(result.priority)}. ${tableCell(result.priorityReason)} |\n| Details | ${tableCell(details)} |`
  const summaryTable = [
    [{ data: '', header: true }, { data: '', header: true }],
    ['Effort', tableCell(`${result.effort}. ${result.effortReason}`)],
    ['Functional area', tableCell(result.functionalArea)],
    ['Priority', tableCell(`${result.priority}. ${result.priorityReason}`)],
    ['Recommendation', tableCell(`${result.disposition}. ${result.dispositionReason}`)],
    ['Details', tableCell(details)],
  ]
  const report = `${reportTable}\n\n<!-- ${marker} -->`
  await core.summary.addHeading(`Issue triage: #${issueNumber}`).addTable(summaryTable).addRaw(dryRun ? '\n\n*Dry run: no changes were applied.*' : '').write()
  if (dryRun) {
    core.info(`[dry-run] Would add labels: ${labelsToAdd.join(', ') || '(none)'}`)
    core.info(`[dry-run] Would remove labels: ${[...new Set([...result.labelsToRemove, triageLabel])].join(', ')}`)
    core.info(`[dry-run] Would close: ${allowClose && closing}`)
    return
  }
  if (allowLabelChanges && labelsToAdd.length) await octokit.rest.issues.addLabels({ owner, repo: repoName, issue_number: issueNumber, labels: labelsToAdd })
  if (allowLabelChanges) {
    for (const label of result.labelsToRemove.filter(label => label !== triageLabel)) await octokit.rest.issues.removeLabel({ owner, repo: repoName, issue_number: issueNumber, name: label })
  }
  await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: issueNumber, body: report })
  if (allowClose && closing) {
    if (duplicateIssueNumber) {
      const { data: duplicateIssue } = await octokit.rest.issues.get({ owner: contextRepository.owner, repo: contextRepository.repo, issue_number: duplicateIssueNumber })
      const updateDuplicate = octokit.request as unknown as (route: string, parameters: Record<string, unknown>) => Promise<unknown>
      await updateDuplicate('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo: repoName, issue_number: issueNumber, state: 'closed', state_reason: 'duplicate', duplicate_issue_id: duplicateIssue.id })
    } else {
      await octokit.rest.issues.update({ owner, repo: repoName, issue_number: issueNumber, state: 'closed', state_reason: result.disposition === 'close-completed' ? 'completed' : 'not_planned' })
    }
  }
  await octokit.rest.issues.removeLabel({ owner, repo: repoName, issue_number: issueNumber, name: triageLabel })
  core.info(`Applied triage to issue #${issueNumber}`)
}

run().catch(error => core.setFailed((error as Error).message))
