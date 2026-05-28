import * as core from '@actions/core'
import * as github from '@actions/github'

const VALID_ENFORCEMENTS = ['close', 'lock', 'close-and-lock', 'comment-only'] as const
const VALID_LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const

type Enforcement = typeof VALID_ENFORCEMENTS[number]
type LockReason = typeof VALID_LOCK_REASONS[number]

const DEFAULT_COMMENT =
  'This pull request targets `{target-branch}`, which is not an allowed target branch. Please retarget your PR to an allowed branch.'

function matchesPattern(branch: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^/]+') +
    '$'
  )
  return regex.test(branch)
}

async function enforce(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repoName: string,
  prNumber: number,
  enforcement: Enforcement,
  lockReason: LockReason,
  comment: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo: repoName,
    issue_number: prNumber,
    body: comment,
  })

  const shouldClose = enforcement === 'close' || enforcement === 'close-and-lock'
  const shouldLock = enforcement === 'lock' || enforcement === 'close-and-lock'

  if (shouldClose) {
    await octokit.rest.pulls.update({ owner, repo: repoName, pull_number: prNumber, state: 'closed' })
    core.info(`Closed PR #${prNumber}`)
  }

  if (shouldLock) {
    await octokit.rest.issues.lock({ owner, repo: repoName, issue_number: prNumber, lock_reason: lockReason })
    core.info(`Locked PR #${prNumber}`)
  }
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const allowedTargetsInput = core.getInput('allowed-targets', { required: true })
  const enforcementInput = (core.getInput('enforcement') || 'comment-only') as Enforcement
  const lockReasonInput = (core.getInput('lock-reason') || 'off-topic') as LockReason
  const commentTemplate = core.getInput('comment') || DEFAULT_COMMENT

  if (!VALID_ENFORCEMENTS.includes(enforcementInput)) {
    core.setFailed(`Invalid enforcement: "${enforcementInput}". Must be one of: ${VALID_ENFORCEMENTS.join(', ')}`)
    return
  }

  if (!VALID_LOCK_REASONS.includes(lockReasonInput)) {
    core.setFailed(`Invalid lock-reason: "${lockReasonInput}". Must be one of: ${VALID_LOCK_REASONS.join(', ')}`)
    return
  }

  const { eventName, payload, repo } = github.context

  if (eventName !== 'pull_request') {
    core.info(`Event is "${eventName}", branch-guard only runs on pull_request events`)
    return
  }

  const prAction = payload.action
  if (prAction !== 'opened' && prAction !== 'reopened' && prAction !== 'edited') {
    core.info(`Action is "${prAction}", skipping`)
    return
  }

  const pr = payload.pull_request!
  const targetBranch = pr.base.ref as string
  const prNumber = pr.number as number

  const patterns = allowedTargetsInput.split(',').map(p => p.trim()).filter(Boolean)
  const allowed = patterns.some(p => matchesPattern(targetBranch, p))

  if (allowed) {
    core.info(`PR #${prNumber} targets "${targetBranch}" - allowed`)
    return
  }

  core.info(`PR #${prNumber} targets "${targetBranch}" - not in allowed patterns: ${patterns.join(', ')}`)

  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo
  const comment = commentTemplate.replace(/\{target-branch\}/g, targetBranch)

  await enforce(octokit, owner, repoName, prNumber, enforcementInput, lockReasonInput, comment)
}

run().catch(core.setFailed)
