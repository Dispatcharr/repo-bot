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
}
type Review = {
  state?: string
  author_association?: string
  user?: User
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

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const intakeLabel = core.getInput('intake-label') || 'Triage'
  const intakeComment = core.getInput('intake-comment') || DEFAULT_INTAKE_COMMENT
  const reviewLabel = core.getInput('review-label') || 'In Review'
  const bypassForMembers = core.getBooleanInput('bypass-for-members')
  const dryRun = core.getBooleanInput('dry-run')
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

  if (eventName !== 'workflow_dispatch') {
    core.info(`Event is "${eventName}", pr-intake only runs on pull request, pull request review, or workflow dispatch events`)
    return
  }

  let eligiblePullRequests = 0
  for (let page = 1; ; page += 1) {
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner,
      repo: repoName,
      state: 'open',
      per_page: 100,
      page,
    })
    for (const pullRequest of pullRequests) {
      if (bypassForMembers && isMemberPullRequest(pullRequest)) continue
      if (pullRequest.labels.length !== 0) continue
      eligiblePullRequests += 1
      await processIntake(octokit, owner, repoName, pullRequest, intakeLabel, intakeComment, dryRun)
    }
    if (pullRequests.length < 100) break
  }
  core.notice(`${dryRun ? 'Dry run found' : 'Processed'} ${eligiblePullRequests} eligible intake pull request(s).`)
}

run().catch(core.setFailed)
