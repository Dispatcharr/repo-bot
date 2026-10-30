import * as core from '@actions/core'
import * as github from '@actions/github'

const VALID_ENFORCEMENTS = ['close', 'lock', 'close-and-lock', 'comment-only'] as const
const VALID_LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const
const VALID_PR_ACTIONS = ['opened', 'reopened', 'edited', 'synchronize', 'labeled', 'unlabeled'] as const
const DISCUSSION_URL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/discussions\/\d+(?:[/?#][^\s<]*)?/i

type Enforcement = typeof VALID_ENFORCEMENTS[number]
type LockReason = typeof VALID_LOCK_REASONS[number]

const DEFAULT_COMMENT =
  'This pull request was closed because significant features and substantial refactors require maintainer signoff in a linked proposal discussion before implementation begins. ' +
  'Please open a proposal discussion, wait for signoff, then reopen or submit your pull request.'

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

function matchesGlob(filename: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^/]+') +
    '$',
  )
  return regex.test(filename)
}

function parseNonNegativeInteger(value: string, inputName: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${inputName} must be a non-negative whole number`)
  return Number(value)
}

function parseUtcTimestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new Error('created-after must be a UTC ISO 8601 timestamp')
  }
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) throw new Error('created-after must be a valid UTC ISO 8601 timestamp')
  if (timestamp.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error('created-after must be a valid UTC ISO 8601 timestamp')
  }
  return timestamp
}

function formatComment(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match)
}

async function enforce(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repoName: string,
  prNumber: number,
  enforcement: Enforcement,
  lockReason: LockReason,
  comment: string,
): Promise<boolean> {
  await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body: comment })

  if (enforcement === 'close' || enforcement === 'close-and-lock') {
    await octokit.rest.pulls.update({ owner, repo: repoName, pull_number: prNumber, state: 'closed' })
    core.info(`Closed PR #${prNumber}`)
  }
  if (enforcement === 'lock' || enforcement === 'close-and-lock') {
    await octokit.rest.issues.lock({ owner, repo: repoName, issue_number: prNumber, lock_reason: lockReason })
    core.info(`Locked PR #${prNumber}`)
  }
  return enforcement === 'close' || enforcement === 'close-and-lock'
}

async function checkPullRequest(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repoName: string,
  prNumber: number,
  maxNetDelta: number,
  createdAfter: Date,
  triageLabel: string,
  bypassForMembers: boolean,
  ignoreGlobs: string[],
  enforcement: Enforcement,
  lockReason: LockReason,
  commentTemplate: string,
): Promise<boolean> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber })
  if (pr.state !== 'open') {
    core.info(`PR #${prNumber} is ${pr.state}, skipping`)
    return false
  }

  const author = pr.user?.login
  if (bypassForMembers && author && await isCollaborator(octokit, owner, repoName, author)) {
    core.info(`Bypassing enforcement: ${author} is a repository collaborator`)
    return false
  }

  const createdAt = new Date(pr.created_at)
  if (createdAt.getTime() <= createdAfter.getTime()) {
    core.info(`Skipping PR #${prNumber}: created at ${pr.created_at}, on or before cutoff ${createdAfter.toISOString()}`)
    return false
  }

  const labels = pr.labels.map(label => label.name)
  if (labels.length > 0 && (!triageLabel || !labels.includes(triageLabel))) {
    core.info(`Skipping PR #${prNumber}: labeled PR does not have the triage label "${triageLabel}"`)
    return false
  }

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo: repoName,
    pull_number: prNumber,
    per_page: 100,
  })
  const totals = files.reduce((result, file) => {
    if (ignoreGlobs.some(pattern => matchesGlob(file.filename, pattern))) return result
    result.additions += file.additions
    result.deletions += file.deletions
    return result
  }, { additions: 0, deletions: 0 })
  const netDelta = Math.abs(totals.additions - totals.deletions)
  if (netDelta <= maxNetDelta) {
    core.info(`PR #${prNumber} passed: net delta ${netDelta} is within the ${maxNetDelta} line limit`)
    return false
  }

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: repoName,
    issue_number: prNumber,
    per_page: 100,
  })
  const discussionLinked = DISCUSSION_URL.test(pr.body ?? '') || comments.some(comment => DISCUSSION_URL.test(comment.body ?? ''))
  if (discussionLinked) {
    core.info(`PR #${prNumber} passed: net delta ${netDelta} exceeds ${maxNetDelta}, but it links a GitHub Discussion`)
    return false
  }

  core.info(`PR #${prNumber} failed: net delta ${netDelta} exceeds ${maxNetDelta} without a linked GitHub Discussion`)
  const comment = formatComment(commentTemplate, {
    'net-delta': String(netDelta),
    'max-net-delta': String(maxNetDelta),
    'triage-label': triageLabel,
  })
  return enforce(octokit, owner, repoName, prNumber, enforcement, lockReason, comment)
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const enforcement = (core.getInput('enforcement') || 'close') as Enforcement
  const lockReason = (core.getInput('lock-reason') || 'off-topic') as LockReason
  const triageLabel = core.getInput('triage-label').trim()
  const bypassForMembers = core.getBooleanInput('bypass-for-members')
  const ignoreGlobs = core.getInput('ignore-globs').split(',').map(pattern => pattern.trim()).filter(Boolean)

  let maxNetDelta: number
  let createdAfter: Date
  try {
    maxNetDelta = parseNonNegativeInteger(core.getInput('max-net-delta-without-discussion', { required: true }), 'max-net-delta-without-discussion')
    createdAfter = parseUtcTimestamp(core.getInput('created-after', { required: true }))
  } catch (error) {
    core.setFailed((error as Error).message)
    return
  }
  if (!VALID_ENFORCEMENTS.includes(enforcement)) {
    core.setFailed(`Invalid enforcement: "${enforcement}". Must be one of: ${VALID_ENFORCEMENTS.join(', ')}`)
    return
  }
  if (!VALID_LOCK_REASONS.includes(lockReason)) {
    core.setFailed(`Invalid lock-reason: "${lockReason}". Must be one of: ${VALID_LOCK_REASONS.join(', ')}`)
    return
  }

  const { eventName, payload, repo } = github.context
  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo
  let prNumbers: number[]
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const action = payload.action ?? ''
    if (!(VALID_PR_ACTIONS as readonly string[]).includes(action)) {
      core.info(`Action is "${action}", skipping`)
      return
    }
    const prNumber = payload.pull_request?.number as number | undefined
    if (!prNumber) {
      core.info('No pull request number in context, skipping')
      return
    }
    prNumbers = [prNumber]
  } else if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    const pullRequests = await octokit.paginate(octokit.rest.pulls.list, { owner, repo: repoName, state: 'open', per_page: 100 })
    prNumbers = pullRequests.map(pr => pr.number)
  } else {
    core.info(`Event is "${eventName}", proposal-guard only runs on pull request, schedule, or workflow dispatch events`)
    return
  }

  let closedCount = 0
  for (const prNumber of prNumbers) {
    const closed = await checkPullRequest(
      octokit,
      owner,
      repoName,
      prNumber,
      maxNetDelta,
      createdAfter,
      triageLabel,
      bypassForMembers,
      ignoreGlobs,
      enforcement,
      lockReason,
      core.getInput('comment') || DEFAULT_COMMENT,
    )
    if (closed) closedCount += 1
  }
  core.setOutput('closed', closedCount > 0)
  core.setOutput('closed-count', closedCount)
}

run().catch(core.setFailed)
