import * as core from '@actions/core'
import * as github from '@actions/github'

const MEMBER_ASSOCIATIONS = new Set(['COLLABORATOR', 'MEMBER', 'OWNER'])
const DEFAULT_INTAKE_COMMENT =
  'Thanks for contributing. Your pull request has been received and will be triaged by maintainers.'

type PullRequest = {
  number: number
  title: string
  author_association?: string
  labels: Array<unknown>
}

function isMemberPullRequest(pullRequest: PullRequest): boolean {
  return MEMBER_ASSOCIATIONS.has(pullRequest.author_association ?? '')
}

async function processPullRequest(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullRequest: PullRequest,
  intakeLabel: string,
  intakeComment: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    core.notice(`[dry-run] #${pullRequest.number}: ${pullRequest.title}`)
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
  core.info(`Processed PR #${pullRequest.number}`)
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const intakeLabel = core.getInput('intake-label') || 'Triage'
  const intakeComment = core.getInput('intake-comment') || DEFAULT_INTAKE_COMMENT
  const bypassForMembers = core.getBooleanInput('bypass-for-members')
  const dryRun = core.getBooleanInput('dry-run')
  const { eventName, payload, repo } = github.context
  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    if (payload.action !== 'opened') {
      core.info(`Action is "${payload.action}", skipping`)
      return
    }
    const pullRequest = payload.pull_request as PullRequest | undefined
    if (!pullRequest) {
      core.setFailed('Pull request event payload is missing pull_request')
      return
    }
    if (bypassForMembers && isMemberPullRequest(pullRequest)) {
      core.info(`Skipping PR #${pullRequest.number}: author is a repository member`)
      return
    }
    await processPullRequest(octokit, owner, repoName, pullRequest, intakeLabel, intakeComment, dryRun)
    return
  }

  if (eventName !== 'workflow_dispatch') {
    core.info(`Event is "${eventName}", pr-intake only runs on pull request or workflow_dispatch events`)
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
      await processPullRequest(octokit, owner, repoName, pullRequest, intakeLabel, intakeComment, dryRun)
    }
    if (pullRequests.length < 100) break
  }
  core.notice(`${dryRun ? 'Dry run found' : 'Processed'} ${eligiblePullRequests} eligible pull request(s).`)
}

run().catch(core.setFailed)
