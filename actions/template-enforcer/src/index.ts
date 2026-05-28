import * as core from '@actions/core'
import * as github from '@actions/github'

const VALID_EVENT_TYPES = ['issue', 'pull_request', 'any'] as const
const VALID_ENFORCEMENTS = ['close', 'lock', 'close-and-lock', 'comment-only'] as const
const VALID_LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const
const VALID_MATCH_MODES = ['all', 'any'] as const

type Enforcement = typeof VALID_ENFORCEMENTS[number]
type LockReason = typeof VALID_LOCK_REASONS[number]
type MatchMode = typeof VALID_MATCH_MODES[number]

interface CheckResult {
  name: string
  passed: boolean
  detail: string
}

async function isCollaborator(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repoName: string,
  username: string,
): Promise<boolean> {
  try {
    await octokit.rest.repos.checkCollaborator({ owner, repo: repoName, username })
    return true
  } catch {
    return false
  }
}

function checkMarkers(body: string, markers: string[]): CheckResult {
  const missing = markers.filter(m => !body.includes(m))
  return {
    name: 'markers',
    passed: missing.length === 0,
    detail: missing.length > 0 ? `missing: ${missing.join(', ')}` : 'ok',
  }
}

function checkLabels(itemLabels: string[], required: string[]): CheckResult {
  const missing = required.filter(l => !itemLabels.includes(l))
  return {
    name: 'labels',
    passed: missing.length === 0,
    detail: missing.length > 0 ? `missing: ${missing.join(', ')}` : 'ok',
  }
}

function checkType(itemType: string | null | undefined, allowed: string[]): CheckResult {
  const passed = !!itemType && allowed.some(t => t.toLowerCase() === itemType.toLowerCase())
  return {
    name: 'type',
    passed,
    detail: passed ? 'ok' : `type is "${itemType ?? 'none'}", expected one of: ${allowed.join(', ')}`,
  }
}

function defaultComment(itemLabel: string): string {
  return `This ${itemLabel} was not opened using one of the available templates.

Please open a new ${itemLabel} using the appropriate template: [{new-issue-url}]({new-issue-url})

*This ${itemLabel} was closed automatically.*`
}

async function enforce(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repoName: string,
  number: number,
  isPR: boolean,
  enforcement: Enforcement,
  lockReason: LockReason,
  comment: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo: repoName,
    issue_number: number,
    body: comment,
  })

  const shouldClose = enforcement === 'close' || enforcement === 'close-and-lock'
  const shouldLock = enforcement === 'lock' || enforcement === 'close-and-lock'
  const label = isPR ? 'PR' : 'issue'

  if (shouldClose) {
    if (isPR) {
      await octokit.rest.pulls.update({ owner, repo: repoName, pull_number: number, state: 'closed' })
    } else {
      await octokit.rest.issues.update({ owner, repo: repoName, issue_number: number, state: 'closed' })
    }
    core.info(`Closed ${label} #${number}`)
  }

  if (shouldLock) {
    await octokit.rest.issues.lock({ owner, repo: repoName, issue_number: number, lock_reason: lockReason })
    core.info(`Locked ${label} #${number}`)
  }
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const markersInput = core.getInput('required-markers')
  const labelsInput = core.getInput('required-labels')
  const typesInput = core.getInput('required-type')
  const matchInput = (core.getInput('match') || 'all') as MatchMode
  const eventTypeInput = core.getInput('event-type') || 'any'
  const enforcementInput = (core.getInput('enforcement') || 'close') as Enforcement
  const lockReasonInput = (core.getInput('lock-reason') || 'off-topic') as LockReason
  const bypassForMembers = core.getBooleanInput('bypass-for-members')

  if (!VALID_EVENT_TYPES.includes(eventTypeInput as typeof VALID_EVENT_TYPES[number])) {
    core.setFailed(`Invalid event-type: "${eventTypeInput}". Must be one of: ${VALID_EVENT_TYPES.join(', ')}`)
    return
  }
  if (!VALID_ENFORCEMENTS.includes(enforcementInput)) {
    core.setFailed(`Invalid enforcement: "${enforcementInput}". Must be one of: ${VALID_ENFORCEMENTS.join(', ')}`)
    return
  }
  if (!VALID_LOCK_REASONS.includes(lockReasonInput)) {
    core.setFailed(`Invalid lock-reason: "${lockReasonInput}". Must be one of: ${VALID_LOCK_REASONS.join(', ')}`)
    return
  }
  if (!VALID_MATCH_MODES.includes(matchInput)) {
    core.setFailed(`Invalid match: "${matchInput}". Must be one of: ${VALID_MATCH_MODES.join(', ')}`)
    return
  }

  const { eventName, payload, repo } = github.context

  if (eventTypeInput === 'issue' && eventName !== 'issues') {
    core.info(`event-type is "issue" but event is "${eventName}", skipping`)
    return
  }
  if (eventTypeInput === 'pull_request' && eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    core.info(`event-type is "pull_request" but event is "${eventName}", skipping`)
    return
  }

  const isPR = eventName === 'pull_request' || eventName === 'pull_request_target'
  const isIssue = eventName === 'issues'

  if (!isPR && !isIssue) {
    core.info(`Event is "${eventName}", nothing to do`)
    return
  }

  const action = payload.action
  if (action !== 'opened' && action !== 'reopened' && action !== 'edited') {
    core.info(`Action is "${action}", skipping`)
    return
  }

  const item = isPR ? payload.pull_request! : payload.issue!
  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo

  if (bypassForMembers) {
    const author = item.user?.login as string | undefined
    if (author && await isCollaborator(octokit, owner, repoName, author)) {
      core.info(`Bypassing enforcement: ${author} is a repository collaborator`)
      return
    }
  }

  const body = item.body ?? ''
  const itemLabels: string[] = (item.labels ?? []).map((l: { name: string }) => l.name)
  const itemType: string | null = (item as any).type?.name ?? null

  const markers = markersInput.split(',').map(m => m.trim()).filter(Boolean)
  const labels = labelsInput.split(',').map(l => l.trim()).filter(Boolean)
  const types = typesInput.split(',').map(t => t.trim()).filter(Boolean)

  const checks: CheckResult[] = []
  if (markers.length > 0) checks.push(checkMarkers(body, markers))
  if (labels.length > 0) checks.push(checkLabels(itemLabels, labels))
  if (types.length > 0) checks.push(checkType(itemType, types))

  if (checks.length === 0) {
    core.info('No checks configured, skipping enforcement')
    return
  }

  const isValid = matchInput === 'any'
    ? checks.some(c => c.passed)
    : checks.every(c => c.passed)

  if (isValid) {
    core.info(`#${item.number} passed (match=${matchInput}): ${checks.map(c => `${c.name}=${c.detail}`).join(', ')}`)
    return
  }

  const failed = checks.filter(c => !c.passed)
  core.info(`#${item.number} failed (match=${matchInput}): ${failed.map(c => `${c.name}: ${c.detail}`).join(', ')}`)

  const number = item.number as number
  const itemLabel = isPR ? 'pull request' : 'issue'
  const newIssueUrl = `https://github.com/${owner}/${repoName}/issues/new/choose`
  const commentTemplate = core.getInput('close-comment') || defaultComment(itemLabel)
  const comment = commentTemplate.replace(/\{new-issue-url\}/g, newIssueUrl)

  await enforce(octokit, owner, repoName, number, isPR, enforcementInput, lockReasonInput, comment)
}

run().catch(core.setFailed)
