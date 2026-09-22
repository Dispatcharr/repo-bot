import * as core from '@actions/core'
import * as github from '@actions/github'

const VALID_ENFORCEMENTS = ['close', 'lock', 'close-and-lock', 'comment-only'] as const
const VALID_LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const
const WARNING_MARKER = '<!-- repo-bot:pr-freshness:warning -->'
const ENFORCED_MARKER = '<!-- repo-bot:pr-freshness:enforced -->'
const CONFLICT_MARKER = '<!-- repo-bot:pr-freshness:conflict-observed -->'
const DAY_MS = 24 * 60 * 60 * 1000

type Enforcement = typeof VALID_ENFORCEMENTS[number]
type LockReason = typeof VALID_LOCK_REASONS[number]
type Octokit = ReturnType<typeof github.getOctokit>
type EligibilityReason = {
  message: string
  eligibleSince: Date
}

const DEFAULT_STALE_MESSAGE =
  'This pull request has had no activity from its author for {inactive-days} days ({reasons}). ' +
  'Please update it within {days-before-close} days or it will be closed. You may reopen it later if needed.'
const DEFAULT_CLOSE_MESSAGE =
  'This pull request was closed after the freshness grace period elapsed without author activity ({reasons}). ' +
  'It can be reopened when it is ready to continue.'

function parseDays(input: string, name: string): number {
  const value = Number(input.trim())
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of days`)
  }
  return value
}

function hasLabel(labels: Array<{ name?: string }>, label: string): boolean {
  return labels.some(item => item.name === label)
}

function isOwnedMarkerComment(
  comment: { body?: string | null, user?: { login?: string | null } | null },
  marker: string,
  markerAuthor: string,
): boolean {
  return comment.user?.login === markerAuthor && comment.body?.includes(marker) === true
}

function daysSince(date: string | Date, now: Date): number {
  return Math.floor((now.getTime() - new Date(date).getTime()) / DAY_MS)
}

function isAfter(date: string | null | undefined, after: Date): boolean {
  return !!date && new Date(date).getTime() > after.getTime()
}

function format(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replace(new RegExp(`\\{${key}\\}`, 'g'), value),
    template,
  )
}

async function isCollaborator(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(username)
  if (cached !== undefined) return cached

  try {
    await octokit.rest.repos.checkCollaborator({ owner, repo, username })
    cache.set(username, true)
    return true
  } catch {
    cache.set(username, false)
    return false
  }
}

async function latestAuthorActivity(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  author: string,
  since: Date,
): Promise<Date | null> {
  const [comments, events, commits] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 }),
    octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: prNumber, per_page: 100 }),
  ])

  const activityDates = [
    ...comments
      .filter(comment => comment.user?.login === author && isAfter(comment.created_at, since))
      .map(comment => new Date(comment.created_at!)),
    ...events
      .map(event => {
        if (!('actor' in event) || !('created_at' in event) || event.actor?.login !== author) return null
        return isAfter(event.created_at, since) ? new Date(event.created_at!) : null
      })
      .filter((date): date is Date => date !== null),
    ...commits
      .filter(commit =>
        (commit.author?.login === author || commit.committer?.login === author) &&
        isAfter(commit.commit.author?.date ?? commit.commit.committer?.date, since),
      )
      .map(commit => new Date(commit.commit.author?.date ?? commit.commit.committer?.date!)),
  ]

  if (activityDates.length === 0) return null
  return activityDates.reduce((latest, date) => date.getTime() > latest.getTime() ? date : latest)
}

async function latestMaintainerResponse(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  author: string,
  after: Date,
  cache: Map<string, boolean>,
): Promise<Date | null> {
  const [comments, reviews] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 }),
    octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }),
  ])

  const responders = [
    ...comments
      .filter(comment =>
        comment.user?.type !== 'Bot' && comment.user?.login !== author && isAfter(comment.created_at, after),
      )
      .map(comment => ({ login: comment.user?.login, date: new Date(comment.created_at!) })),
    ...reviews
      .filter(review =>
        review.user?.type !== 'Bot' && review.user?.login !== author && isAfter(review.submitted_at, after),
      )
      .map(review => ({ login: review.user?.login, date: new Date(review.submitted_at!) })),
  ].filter((response): response is { login: string, date: Date } => !!response.login)

  const maintainerResponseDates: Date[] = []
  for (const response of responders) {
    if (await isCollaborator(octokit, owner, repo, response.login, cache)) {
      maintainerResponseDates.push(response.date)
    }
  }
  if (maintainerResponseDates.length === 0) return null
  return maintainerResponseDates.reduce((latest, date) => date.getTime() > latest.getTime() ? date : latest)
}

async function latestChangesRequested(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  author: string,
  cache: Map<string, boolean>,
): Promise<Date | null> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })
  const latestByReviewer = new Map<string, typeof reviews[number]>()

  for (const review of reviews) {
    const reviewer = review.user?.login
    if (!reviewer || !review.submitted_at) continue
    const previous = latestByReviewer.get(reviewer)
    if (!previous || new Date(review.submitted_at).getTime() > new Date(previous.submitted_at!).getTime()) {
      latestByReviewer.set(reviewer, review)
    }
  }

  const changesRequestedDates: Date[] = []
  for (const review of latestByReviewer.values()) {
    const reviewer = review.user?.login
    if (
      review.state === 'CHANGES_REQUESTED' && reviewer && reviewer !== author &&
      await isCollaborator(octokit, owner, repo, reviewer, cache)
    ) {
      changesRequestedDates.push(new Date(review.submitted_at!))
    }
  }
  if (changesRequestedDates.length === 0) return null
  return changesRequestedDates.reduce((latest, date) => date.getTime() > latest.getTime() ? date : latest)
}

async function createComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    core.info(`[dry-run] Would comment on PR #${prNumber}: ${body}`)
    return
  }
  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })
}

async function deleteComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    core.info(`[dry-run] Would delete conflict state comment ${commentId}`)
    return
  }
  await octokit.rest.issues.deleteComment({ owner, repo, comment_id: commentId })
}

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const markerAuthor = core.getInput('marker-author', { required: true })
  const staleLabel = core.getInput('stale-label') || 'stale'
  const staleMessage = core.getInput('stale-message') || DEFAULT_STALE_MESSAGE
  const closeMessage = core.getInput('close-message') || DEFAULT_CLOSE_MESSAGE
  const enforcement = (core.getInput('enforcement') || 'close') as Enforcement
  const lockReason = (core.getInput('lock-reason') || 'resolved') as LockReason
  const checkConflicts = core.getBooleanInput('check-conflicts')
  const checkChangesRequested = core.getBooleanInput('check-changes-requested')
  const checkMaintainerRespondedStale = core.getBooleanInput('check-maintainer-responded-stale')
  const checkCompliance = core.getBooleanInput('check-compliance')
  const complianceMarker = core.getInput('compliance-marker').trim()
  const bypassForMembers = core.getBooleanInput('bypass-for-members')
  const dryRun = core.getBooleanInput('dry-run')

  let daysBeforeStale: number
  let daysBeforeClose: number
  try {
    daysBeforeStale = parseDays(core.getInput('days-before-stale', { required: true }), 'days-before-stale')
    daysBeforeClose = parseDays(core.getInput('days-before-close', { required: true }), 'days-before-close')
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
  if (!checkConflicts && !checkChangesRequested && !checkMaintainerRespondedStale && !checkCompliance) {
    core.setFailed('Enable at least one eligibility check')
    return
  }
  if (checkCompliance && !complianceMarker) {
    core.setFailed('compliance-marker is required when check-compliance is true')
    return
  }

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const now = new Date()
  const collaboratorCache = new Map<string, boolean>()
  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  })

  for (const listedPr of pullRequests) {
    const prNumber = listedPr.number
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    const author = pr.user?.login
    if (!author) {
      core.warning(`Skipping PR #${prNumber}: author is unavailable`)
      continue
    }
    if (bypassForMembers && await isCollaborator(octokit, owner, repo, author, collaboratorCache)) {
      core.info(`Skipping PR #${prNumber}: ${author} is a repository collaborator`)
      continue
    }
    const lastAuthorActivity = await latestAuthorActivity(
      octokit,
      owner,
      repo,
      prNumber,
      author,
      new Date(pr.created_at),
    )
    const inactiveSince = lastAuthorActivity ?? new Date(pr.created_at)

    const conflicted = checkConflicts && (pr.mergeable === false || pr.mergeable_state === 'dirty')
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    })
    const conflictMarker = [...comments].reverse().find(comment =>
      isOwnedMarkerComment(comment, CONFLICT_MARKER, markerAuthor),
    )
    const complianceComment = checkCompliance
      ? [...comments].reverse().find(comment => isOwnedMarkerComment(comment, complianceMarker, markerAuthor))
      : undefined
    let conflictObservedAt = conflictMarker?.created_at ? new Date(conflictMarker.created_at) : null
    if (conflicted && !conflictObservedAt) {
      await createComment(octokit, owner, repo, prNumber, CONFLICT_MARKER, dryRun)
      conflictObservedAt = now
      core.info(`Started conflict timer for PR #${prNumber}`)
    } else if (!conflicted && conflictMarker) {
      await deleteComment(octokit, owner, repo, conflictMarker.id, dryRun)
      core.info(`Cleared conflict timer for PR #${prNumber}`)
    }

    const [changesRequestedAt, maintainerResponseAt] = await Promise.all([
      checkChangesRequested ? latestChangesRequested(octokit, owner, repo, prNumber, author, collaboratorCache) : null,
      checkMaintainerRespondedStale
        ? latestMaintainerResponse(octokit, owner, repo, prNumber, author, inactiveSince, collaboratorCache)
        : null,
    ])
    const eligibilityReasons: EligibilityReason[] = [
      ...(conflictObservedAt ? [{
        message: 'merge conflicts',
        // Author activity resets a warning, so begin a fresh conflict interval.
        eligibleSince: lastAuthorActivity && lastAuthorActivity.getTime() > conflictObservedAt.getTime()
          ? lastAuthorActivity
          : conflictObservedAt,
      }] : []),
      ...(changesRequestedAt && (!lastAuthorActivity || lastAuthorActivity.getTime() <= changesRequestedAt.getTime()) ? [{
        message: 'changes requested',
        eligibleSince: changesRequestedAt,
      }] : []),
      ...(maintainerResponseAt ? [{
        message: 'maintainer response without author follow-up',
        eligibleSince: maintainerResponseAt,
      }] : []),
      ...(complianceComment?.created_at ? [{
        message: 'unresolved PR compliance',
        eligibleSince: lastAuthorActivity && lastAuthorActivity.getTime() > new Date(complianceComment.created_at).getTime()
          ? lastAuthorActivity
          : new Date(complianceComment.created_at),
      }] : []),
    ]
    const reasons = eligibilityReasons
      .filter(reason => daysSince(reason.eligibleSince, now) >= daysBeforeStale)
      .map(reason => reason.message)
    const inactiveDays = reasons.length === 0 ? 0 : Math.max(...eligibilityReasons
      .filter(reason => reasons.includes(reason.message))
      .map(reason => daysSince(reason.eligibleSince, now)))
    const stale = hasLabel(pr.labels, staleLabel)
    const warning = [...comments].reverse().find(comment =>
      isOwnedMarkerComment(comment, WARNING_MARKER, markerAuthor),
    )

    if (stale) {
      if (!warning?.created_at) {
        if (reasons.length === 0) {
          core.info(`PR #${prNumber} has ${staleLabel} but no active freshness eligibility reason`)
          continue
        }
        const body = `${format(staleMessage, {
          'pr-number': String(prNumber),
          reasons: reasons.join(', '),
          'days-before-close': String(daysBeforeClose),
          'inactive-days': String(inactiveDays),
        })}\n\n${WARNING_MARKER}`
        core.warning(`PR #${prNumber} has ${staleLabel} but no freshness warning marker; posting a new warning`)
        await createComment(octokit, owner, repo, prNumber, body, dryRun)
        continue
      }
      const warnedAt = new Date(warning.created_at)
      const authorActivity = await latestAuthorActivity(octokit, owner, repo, prNumber, author, warnedAt)
      const authorActive = authorActivity !== null
      if (authorActive || reasons.length === 0) {
        if (dryRun) {
          core.info(`[dry-run] Would remove ${staleLabel} from PR #${prNumber}`)
        } else {
          await octokit.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name: staleLabel })
        }
        await deleteComment(octokit, owner, repo, warning.id, dryRun)
        core.info(`Recovered PR #${prNumber}: ${authorActive ? 'author activity' : 'no eligibility reason remains'}`)
        continue
      }
      if (daysSince(warning.created_at, now) < daysBeforeClose) {
        core.info(`PR #${prNumber} is waiting for its freshness grace period (${reasons.join(', ')})`)
        continue
      }
      const alreadyEnforced = comments.some(comment =>
        isOwnedMarkerComment(comment, ENFORCED_MARKER, markerAuthor) && isAfter(comment.created_at, warnedAt),
      )
      if (alreadyEnforced) {
        core.info(`PR #${prNumber} was already enforced for its current warning`)
        continue
      }

      const body = `${format(closeMessage, { 'pr-number': String(prNumber), reasons: reasons.join(', ') })}\n\n${ENFORCED_MARKER}`
      await createComment(octokit, owner, repo, prNumber, body, dryRun)
      if (enforcement === 'close' || enforcement === 'close-and-lock') {
        if (dryRun) core.info(`[dry-run] Would close PR #${prNumber}`)
        else await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' })
      }
      if (enforcement === 'lock' || enforcement === 'close-and-lock') {
        if (dryRun) core.info(`[dry-run] Would lock PR #${prNumber}`)
        else await octokit.rest.issues.lock({ owner, repo, issue_number: prNumber, lock_reason: lockReason })
      }
      core.info(`Enforced freshness policy on PR #${prNumber}: ${enforcement}`)
      continue
    }

    if (reasons.length === 0) {
      core.info(`PR #${prNumber} has no freshness eligibility reason old enough`)
      continue
    }

    const body = `${format(staleMessage, {
      'pr-number': String(prNumber),
      reasons: reasons.join(', '),
      'days-before-close': String(daysBeforeClose),
      'inactive-days': String(inactiveDays),
    })}\n\n${WARNING_MARKER}`
    if (dryRun) {
      core.info(`[dry-run] Would add ${staleLabel} to PR #${prNumber}`)
    } else {
      await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [staleLabel] })
    }
    await createComment(octokit, owner, repo, prNumber, body, dryRun)
    core.info(`Warned PR #${prNumber}: ${reasons.join(', ')}`)
  }
}

run().catch(core.setFailed)
