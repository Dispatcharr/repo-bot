import * as core from '@actions/core'
import * as github from '@actions/github'

const MEMBER_ASSOCIATIONS = new Set(['COLLABORATOR', 'MEMBER', 'OWNER'])
const DEFAULT_INTAKE_COMMENT =
  'Thanks for contributing. Your pull request has been received and will be triaged by maintainers.'

type Octokit = ReturnType<typeof github.getOctokit>
type Label = { name?: string | null }
type User = { login?: string | null }
type PullRequest = {
  number: number
  title: string
  author_association?: string
  labels: Label[]
  assignees?: User[] | null
  updated_at?: string | null
}
type Review = {
  state?: string
  author_association?: string
  user?: User | null
  submitted_at?: string | null
}

function isMemberAssociation(association?: string): boolean {
  return MEMBER_ASSOCIATIONS.has(association ?? '')
}

function isMemberPullRequest(pullRequest: PullRequest): boolean {
  return isMemberAssociation(pullRequest.author_association)
}

function hasLabel(pullRequest: PullRequest, label: string): boolean {
  return pullRequest.labels.some(item => item.name === label)
}

function parsePositiveInteger(input: string, name: string): number {
  const value = Number(input.trim())
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`)
  }
  return value
}

async function getPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequest> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })
  return data
}

async function processIntake(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullRequest: PullRequest,
  intakeLabel: string,
  intakeComment: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    core.notice(`[dry-run] INTAKE #${pullRequest.number}: add label "${intakeLabel}" and post intake comment`)
    return
  }

  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: pullRequest.number,
    labels: [intakeLabel],
  })
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullRequest.number,
    body: intakeComment,
  })
  core.info(`INTAKE processed PR #${pullRequest.number}`)
}

async function processReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullRequest: PullRequest,
  reviewer: string,
  intakeLabel: string,
  reviewLabel: string,
  dryRun: boolean,
): Promise<void> {
  if (!hasLabel(pullRequest, intakeLabel)) {
    core.info(`Skipping REVIEW for PR #${pullRequest.number}: it no longer has the intake label "${intakeLabel}"`)
    return
  }

  if (dryRun) {
    core.notice(
      `[dry-run] REVIEW #${pullRequest.number}: remove label "${intakeLabel}", add label "${reviewLabel}", and assign ${reviewer}`,
    )
    return
  }

  await octokit.rest.issues.removeLabel({ owner, repo, issue_number: pullRequest.number, name: intakeLabel })
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: pullRequest.number, labels: [reviewLabel] })
  await octokit.rest.issues.addAssignees({ owner, repo, issue_number: pullRequest.number, assignees: [reviewer] })
  core.info(`REVIEW transitioned PR #${pullRequest.number} to ${reviewer}`)
}

async function processClosed(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullRequest: PullRequest,
  dryRun: boolean,
): Promise<void> {
  const labels = pullRequest.labels.flatMap(label => label.name ? [label.name] : [])
  const assignees = (pullRequest.assignees ?? []).flatMap(assignee => assignee.login ? [assignee.login] : [])

  if (dryRun) {
    core.notice(
      `[dry-run] CLOSED #${pullRequest.number}: remove labels: ${labels.join(', ') || '(none)'}; unassign: ${assignees.join(', ') || '(none)'}`,
    )
    return
  }

  if (assignees.length > 0) {
    await octokit.rest.issues.removeAssignees({ owner, repo, issue_number: pullRequest.number, assignees })
  }
  for (const label of labels) {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: pullRequest.number, name: label })
  }
  core.info(`CLOSED cleaned up PR #${pullRequest.number}`)
}

async function latestChangesRequestedReviewer(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string | null> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  })
  const latestByReviewer = new Map<string, Review>()

  for (const review of reviews) {
    const reviewer = review.user?.login
    if (!reviewer || !review.submitted_at) continue
    const previous = latestByReviewer.get(reviewer)
    if (!previous || new Date(review.submitted_at).getTime() > new Date(previous.submitted_at!).getTime()) {
      latestByReviewer.set(reviewer, review)
    }
  }

  const changesRequested = [...latestByReviewer.values()]
    .filter(review => review.state === 'CHANGES_REQUESTED' && isMemberAssociation(review.author_association))
    .sort((left, right) => new Date(right.submitted_at!).getTime() - new Date(left.submitted_at!).getTime())

  return changesRequested[0]?.user?.login ?? null
}

async function scanLifecycle(
  octokit: Octokit,
  owner: string,
  repo: string,
  intakeLabel: string,
  intakeComment: string,
  reviewLabel: string,
  closedLookbackDays: number,
  bypassForMembers: boolean,
  dryRun: boolean,
): Promise<void> {
  let intakes = 0
  let reviews = 0
  let closed = 0

  for (let page = 1; ; page += 1) {
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 100,
      page,
    })
    for (const pullRequest of pullRequests) {
      if (bypassForMembers && isMemberPullRequest(pullRequest)) continue
      if (pullRequest.labels.length === 0) {
        intakes += 1
        await processIntake(octokit, owner, repo, pullRequest, intakeLabel, intakeComment, dryRun)
        continue
      }
      if (!hasLabel(pullRequest, intakeLabel)) continue

      const reviewer = await latestChangesRequestedReviewer(octokit, owner, repo, pullRequest.number)
      if (!reviewer) continue
      reviews += 1
      await processReview(octokit, owner, repo, pullRequest, reviewer, intakeLabel, reviewLabel, dryRun)
    }
    if (pullRequests.length < 100) break
  }

  const cutoff = Date.now() - closedLookbackDays * 24 * 60 * 60 * 1000
  let reachedCutoff = false
  for (let page = 1; !reachedCutoff; page += 1) {
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      page,
    })
    for (const pullRequest of pullRequests) {
      if (!pullRequest.updated_at || new Date(pullRequest.updated_at).getTime() < cutoff) {
        reachedCutoff = true
        break
      }
      if (bypassForMembers && isMemberPullRequest(pullRequest)) continue
      if (pullRequest.labels.length === 0 && (pullRequest.assignees?.length ?? 0) === 0) continue
      closed += 1
      await processClosed(octokit, owner, repo, pullRequest, dryRun)
    }
    if (pullRequests.length < 100) break
  }

  core.notice(
    `${dryRun ? 'Dry run found' : 'Processed'} ${intakes} intake, ${reviews} review, and ${closed} closed pull request(s).`,
  )
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const intakeLabel = core.getInput('intake-label') || 'Triage'
  const intakeComment = core.getInput('intake-comment') || DEFAULT_INTAKE_COMMENT
  const reviewLabel = core.getInput('review-label') || 'In Review'
  const bypassForMembers = core.getBooleanInput('bypass-for-members')
  const dryRun = core.getBooleanInput('dry-run')
  let closedLookbackDays: number
  try {
    closedLookbackDays = parsePositiveInteger(
      core.getInput('closed-lookback-days') || '7',
      'closed-lookback-days',
    )
  } catch (error) {
    core.setFailed((error as Error).message)
    return
  }
  const { eventName, payload, repo } = github.context
  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pullRequest = payload.pull_request as PullRequest | undefined
    if (!pullRequest) {
      core.setFailed('Pull request event payload is missing pull_request')
      return
    }
    if (bypassForMembers && isMemberPullRequest(pullRequest)) {
      core.info(`Skipping PR #${pullRequest.number}: author is a repository member`)
      return
    }
    if (payload.action === 'opened') {
      await processIntake(octokit, owner, repoName, pullRequest, intakeLabel, intakeComment, dryRun)
      return
    }
    if (payload.action === 'closed') {
      const currentPullRequest = await getPullRequest(octokit, owner, repoName, pullRequest.number)
      if (bypassForMembers && isMemberPullRequest(currentPullRequest)) {
        core.info(`Skipping PR #${currentPullRequest.number}: author is a repository member`)
        return
      }
      await processClosed(octokit, owner, repoName, currentPullRequest, dryRun)
      return
    }
    core.info(`Action is "${payload.action}", skipping`)
    return
  }

  if (eventName === 'pull_request_review') {
    const pullRequest = payload.pull_request as PullRequest | undefined
    const review = payload.review as Review | undefined
    const reviewer = review?.user?.login
    if (!pullRequest || !review) {
      core.setFailed('Pull request review event payload is missing pull_request or review')
      return
    }
    if (payload.action !== 'submitted' || review.state !== 'CHANGES_REQUESTED') {
      core.info('Skipping REVIEW: event is not a submitted changes-requested review')
      return
    }
    if (!reviewer || !isMemberAssociation(review.author_association)) {
      core.info('Skipping REVIEW: reviewer is not a repository member')
      return
    }
    const currentPullRequest = await getPullRequest(octokit, owner, repoName, pullRequest.number)
    if (bypassForMembers && isMemberPullRequest(currentPullRequest)) {
      core.info(`Skipping PR #${currentPullRequest.number}: author is a repository member`)
      return
    }
    await processReview(octokit, owner, repoName, currentPullRequest, reviewer, intakeLabel, reviewLabel, dryRun)
    return
  }

  if (eventName !== 'schedule' && eventName !== 'workflow_dispatch') {
    core.info(`Event is "${eventName}", pr-intake only runs on pull request, pull request review, schedule, or workflow dispatch events`)
    return
  }

  await scanLifecycle(
    octokit,
    owner,
    repoName,
    intakeLabel,
    intakeComment,
    reviewLabel,
    closedLookbackDays,
    bypassForMembers,
    dryRun,
  )
}

run().catch(core.setFailed)
