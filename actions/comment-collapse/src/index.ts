import * as core from '@actions/core'
import * as github from '@actions/github'

const VALID_MODES = ['minimize', 'delete'] as const
const VALID_REASONS = ['OUTDATED', 'RESOLVED', 'DUPLICATE', 'OFF_TOPIC', 'SPAM', 'ABUSE'] as const

type Mode = typeof VALID_MODES[number]
type Reason = typeof VALID_REASONS[number]

const MINIMIZE_MUTATION = `
  mutation MinimizeComment($id: ID!, $classifier: ReportedContentClassifiers!) {
    minimizeComment(input: { subjectId: $id, classifier: $classifier }) {
      minimizedComment {
        isMinimized
      }
    }
  }
`

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

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const modeInput = (core.getInput('mode') || 'minimize') as Mode
  const reasonInput = (core.getInput('reason') || 'OUTDATED').toUpperCase() as Reason
  const filterLogin = core.getInput('filter-login')
  const bypassForMembers = core.getBooleanInput('bypass-for-members')

  if (!VALID_MODES.includes(modeInput)) {
    core.setFailed(`Invalid mode: "${modeInput}". Must be one of: ${VALID_MODES.join(', ')}`)
    return
  }
  if (modeInput === 'minimize' && !VALID_REASONS.includes(reasonInput)) {
    core.setFailed(`Invalid reason: "${reasonInput}". Must be one of: ${VALID_REASONS.join(', ')}`)
    return
  }

  const { payload, repo } = github.context
  const number = payload.issue?.number ?? payload.pull_request?.number

  if (!number) {
    core.info('No issue or PR number in context, skipping')
    return
  }

  const octokit = github.getOctokit(token)
  const { owner, repo: repoName } = repo

  if (bypassForMembers) {
    const author = (payload.issue?.user?.login ?? payload.pull_request?.user?.login) as string | undefined
    if (author && await isCollaborator(octokit, owner, repoName, author)) {
      core.info(`Bypassing collapse: ${author} is a repository collaborator`)
      return
    }
  }

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo: repoName,
    issue_number: number,
    per_page: 100,
  })

  const targets = comments.filter(c => {
    if (filterLogin) return c.user?.login === filterLogin
    return c.user?.type === 'Bot'
  })

  if (targets.length === 0) {
    core.info('No matching comments to collapse')
    return
  }

  core.info(`${modeInput === 'delete' ? 'Deleting' : 'Collapsing'} ${targets.length} comment(s)`)

  for (const comment of targets) {
    try {
      if (modeInput === 'delete') {
        await octokit.rest.issues.deleteComment({
          owner,
          repo: repoName,
          comment_id: comment.id,
        })
        core.info(`Deleted comment ${comment.id}`)
      } else {
        await octokit.graphql(MINIMIZE_MUTATION, {
          id: comment.node_id,
          classifier: reasonInput,
        })
        core.info(`Minimized comment ${comment.id}`)
      }
    } catch (err) {
      core.warning(`Failed to process comment ${comment.id}: ${(err as Error).message}`)
    }
  }
}

run().catch(core.setFailed)
