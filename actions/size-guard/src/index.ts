import * as core from '@actions/core'
import * as github from '@actions/github'

const VALID_ENFORCEMENTS = ['close', 'lock', 'close-and-lock', 'comment-only'] as const
const VALID_LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const

type Enforcement = typeof VALID_ENFORCEMENTS[number]
type LockReason = typeof VALID_LOCK_REASONS[number]

const DEFAULT_COMMENT =
  'This pull request changes too many lines (+{additions}/-{deletions}). ' +
  'The limits are +{max-additions}/-{max-deletions}. Please split it into smaller pull requests.'

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

function matchesGlob(path: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^/]+') +
    '$'
  )
  return regex.test(path)
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

function parseLimit(input: string, name: string): number | null {
  const raw = input.trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: "${raw}". Must be a non-negative integer.`)
  }
  return value
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const enforcementInput = (core.getInput('enforcement') || 'comment-only') as Enforcement
  const lockReasonInput = (core.getInput('lock-reason') || 'off-topic') as LockReason
  const ignoreGlobsInput = core.getInput('ignore-globs')
  const commentTemplate = core.getInput('comment') || DEFAULT_COMMENT
  const bypassForMembers = core.getBooleanInput('bypass-for-members')

  let maxAdditions: number | null
  let maxDeletions: number | null
  try {
    maxAdditions = parseLimit(core.getInput('max-additions'), 'max-additions')
    maxDeletions = parseLimit(core.getInput('max-deletions'), 'max-deletions')
  } catch (err) {
    core.setFailed((err as Error).message)
    return
  }

  if (maxAdditions === null && maxDeletions === null) {
    core.setFailed('At least one of max-additions or max-deletions must be set')
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

  const { eventName, payload, repo } = github.context

  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    core.info(`Event is "${eventName}", size-guard only runs on pull_request events`)
    return
  }

  const prAction = payload.action
  if (prAction !== 'opened' && prAction !== 'reopened' && prAction !== 'edited' && prAction !== 'synchronize') {
    core.info(`Action is "${prAction}", skipping`)
    return
  }

  const pr = payload.pull_request!
  const prNumber = pr.number as number
  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo

  if (bypassForMembers) {
    const author = pr.user?.login as string | undefined
    if (author && await isCollaborator(octokit, owner, repoName, author)) {
      core.info(`Bypassing enforcement: ${author} is a repository collaborator`)
      return
    }
  }

  const ignoreGlobs = ignoreGlobsInput.split(',').map(g => g.trim()).filter(Boolean)

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo: repoName,
    pull_number: prNumber,
    per_page: 100,
  })

  let additions = 0
  let deletions = 0
  for (const file of files) {
    if (ignoreGlobs.some(g => matchesGlob(file.filename, g))) {
      core.info(`Ignoring ${file.filename}`)
      continue
    }
    additions += file.additions
    deletions += file.deletions
  }

  const additionsExceeded = maxAdditions !== null && additions > maxAdditions
  const deletionsExceeded = maxDeletions !== null && deletions > maxDeletions

  if (!additionsExceeded && !deletionsExceeded) {
    core.info(`PR #${prNumber} within limits (+${additions}/-${deletions})`)
    return
  }

  core.info(
    `PR #${prNumber} exceeds limits (+${additions}/-${deletions}, ` +
    `max +${maxAdditions ?? '∞'}/-${maxDeletions ?? '∞'})`
  )

  const comment = commentTemplate
    .replace(/\{additions\}/g, String(additions))
    .replace(/\{deletions\}/g, String(deletions))
    .replace(/\{max-additions\}/g, maxAdditions === null ? '∞' : String(maxAdditions))
    .replace(/\{max-deletions\}/g, maxDeletions === null ? '∞' : String(maxDeletions))

  await enforce(octokit, owner, repoName, prNumber, enforcementInput, lockReasonInput, comment)
}

run().catch(core.setFailed)
