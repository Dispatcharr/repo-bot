# repo-bot

Org-internal GitHub Actions for the Dispatcharr project.

## Actions

### template-enforcer

Enforces issue templates and directs non-compliant items to the template chooser.

```
uses: Dispatcharr/repo-bot/actions/template-enforcer@v1
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | yes | | Installation token for the bot GitHub App |
| `event-type` | no | `any` | Limit this job to one event type: `issue`, `pull_request`, or `any` |
| `required-markers` | no | `''` | Comma-separated strings that must all appear in the body. Case-sensitive and matched exactly, so values must appear in the body exactly as written here. |
| `required-labels` | no | `''` | Comma-separated label names that must all be present |
| `required-type` | no | `''` | Comma-separated type names; item type must match one of them |
| `match` | no | `all` | How to combine checks: `all` (every configured check must pass) or `any` (at least one must pass) |
| `enforcement` | no | `close` | What to do with non-compliant items: `close`, `lock`, `close-and-lock`, `comment-only` |
| `lock-reason` | no | `off-topic` | Lock reason when enforcement includes `lock`: `off-topic`, `too heated`, `resolved`, `spam` |
| `close-comment` | no | built-in message | Comment posted on non-compliant items; `{new-issue-url}` is replaced with the repo's template chooser URL |
| `compliance-marker` | no | `''` | Hidden marker appended to a non-compliance comment. Configure the same marker in `pr-freshness` to make unresolved compliance a freshness condition. |
| `bypass-for-members` | no | `false` | If `true`, skip enforcement when the item author is a repository collaborator |

#### Usage

Two jobs in one workflow, each gated to its event type:

```yaml
on:
  issues:
    types: [opened, reopened]
  pull_request:
    types: [opened, reopened]

jobs:
  enforce-issues:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - uses: Dispatcharr/repo-bot/actions/template-enforcer@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          event-type: issue
          required-markers: "### Describe the bug,### Steps to Reproduce"
          enforcement: close-and-lock

  enforce-prs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - uses: Dispatcharr/repo-bot/actions/template-enforcer@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          event-type: pull_request
          required-markers: "### Description,### Testing"
          enforcement: comment-only
          compliance-marker: repo-bot:pr-compliance
```

When a PR event fires, `enforce-issues` exits immediately (wrong event type) and vice versa. `required-markers` should match section headings from your templates.

When `compliance-marker` is configured, the action appends it as an HTML comment whenever an item fails its configured checks. Pair it with `pr-freshness` to close inactive PRs whose compliance remains unresolved. The marker is action-owned and is not part of the consumer's visible `close-comment` text.

To override the default comment, use the `close-comment` input. `{new-issue-url}` is replaced with a link to the template chooser:

```yaml
      - uses: Dispatcharr/repo-bot/actions/template-enforcer@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          event-type: issue
          required-markers: "### Describe the bug"
          enforcement: close
          close-comment: |
            Please open a new issue using one of the [available templates]({new-issue-url}).
            Issues opened without a template are closed automatically.
```

---

### comment-collapse

Minimizes (collapses) bot comments on an issue or PR. Useful as a first step in workflows that re-post updated status comments.

```
uses: Dispatcharr/repo-bot/actions/comment-collapse@v1
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | yes | | Bot installation token with Issues read/write permission |
| `mode` | no | `minimize` | What to do with matched comments: `minimize` or `delete` |
| `reason` | no | `OUTDATED` | Minimize classifier (only used when `mode` is `minimize`): `OUTDATED`, `RESOLVED`, `DUPLICATE`, `OFF_TOPIC`, `SPAM`, `ABUSE` |
| `filter-login` | no | `''` | Only collapse comments by this login. If blank, collapses all comments where `user.type` is `Bot`. |
| `bypass-for-members` | no | `false` | If `true`, skip collapsing when the item author is a repository collaborator |

#### Usage

```yaml
steps:
  - uses: actions/create-github-app-token@v1
    id: app-token
    with:
      app-id: ${{ secrets.BOT_APP_ID }}
      private-key: ${{ secrets.BOT_PRIVATE_KEY }}

  - uses: Dispatcharr/repo-bot/actions/comment-collapse@v1
    with:
      github-token: ${{ steps.app-token.outputs.token }}
      reason: OUTDATED

  # ... post a fresh comment after collapsing old ones
```

---

### branch-guard

Checks that a PR targets an allowed branch. Supports `*` (single path segment) and `**` (multi-segment) wildcards in branch patterns.

```
uses: Dispatcharr/repo-bot/actions/branch-guard@v1
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | yes | | Bot installation token with Pull requests read/write permission |
| `allowed-targets` | yes | | Comma-separated allowed target branch patterns (e.g. `main,release/*`) |
| `enforcement` | no | `comment-only` | What to do when the check fails: `close`, `lock`, `close-and-lock`, `comment-only` |
| `lock-reason` | no | `off-topic` | Lock reason when enforcement includes `lock`: `off-topic`, `too heated`, `resolved`, `spam` |
| `comment` | no | built-in message | Comment to post on failure; `{target-branch}` is replaced with the actual base branch name |
| `bypass-for-members` | no | `false` | If `true`, skip enforcement when the PR author is a repository collaborator |

#### Usage

```yaml
on:
  pull_request:
    types: [opened, reopened]

jobs:
  branch-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
      - uses: Dispatcharr/repo-bot/actions/branch-guard@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          allowed-targets: "main,release/*"
          enforcement: close
          comment: |
            PRs must target `main` or a `release/*` branch.
            This PR targets `{target-branch}` and has been closed.
```

---

### pr-freshness

Warns on and enforces a configured policy for pull requests with no recent author activity. A PR is eligible when a merge conflict has persisted for the configured duration, an effective changes-requested review has gone unanswered for that duration, or a repository collaborator's comment or review has gone unanswered for that duration. This avoids closing contributions that maintainers have not yet triaged.

```
uses: Dispatcharr/repo-bot/actions/pr-freshness@v1
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | yes | | Bot installation token with Pull requests and Issues read/write permission |
| `days-before-stale` | yes | | Whole days of author inactivity before the warning |
| `days-before-close` | yes | | Whole days after the warning before enforcement |
| `stale-label` | no | `stale` | Label applied while waiting for author activity |
| `check-conflicts` | no | `true` | Treat merge conflicts as an eligibility reason |
| `check-changes-requested` | no | `true` | Treat an effective `CHANGES_REQUESTED` review as an eligibility reason |
| `check-maintainer-responded-stale` | no | `true` | Allow generic inactivity only after a collaborator review or comment |
| `check-compliance` | no | `false` | Treat a matching unresolved `template-enforcer` compliance marker as an eligibility reason |
| `compliance-marker` | when `check-compliance` is true | `''` | Hidden marker emitted by `template-enforcer` for unresolved compliance |
| `enforcement` | no | `close` | `close`, `lock`, `close-and-lock`, or `comment-only` |
| `lock-reason` | no | `resolved` | Lock reason when enforcement includes lock |
| `bypass-for-members` | no | `false` | Skip PRs opened by repository collaborators |
| `stale-message` | no | built-in message | Warning comment; supports `{pr-number}`, `{reasons}`, `{days-before-close}`, and `{inactive-days}` |
| `close-message` | no | built-in message | Enforcement comment; supports `{pr-number}` and `{reasons}` |
| `dry-run` | no | `false` | Log intended changes without modifying GitHub state |

The action tracks warnings with its own label and hidden comment marker. It only recognizes, deletes, or uses markers on comments authored by the authenticated bot account. It also uses a hidden comment marker to measure how long a merge conflict has persisted, beginning when the action first observes the conflict and deleting the marker once resolved. A comment, commit, edit, or reopen by the PR author removes the warning label and comment. Author activity after a changes-requested review clears that review condition until a maintainer requests changes again. Maintainer activity does not. It never deletes source branches. Closed PRs can be reopened.

When `check-compliance` is enabled, a matching bot-authored marker emitted by `template-enforcer` is another eligibility reason. It remains active until the compliance comment is removed or replaced without the marker. Author activity after the marker resets its inactivity timer without resolving the compliance condition.

#### Usage

Run this from the consuming repository's default branch. A daily schedule gives the most precise timing. A weekly schedule is also valid, but warnings and enforcement can occur up to a week after the configured threshold.

```yaml
name: PR freshness

on:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

jobs:
  freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v2
        id: app-token
        with:
          app-id: ${{ secrets.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}

      - uses: Dispatcharr/repo-bot/actions/pr-freshness@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          days-before-stale: 14
          days-before-close: 7
          check-compliance: true
          compliance-marker: repo-bot:pr-compliance
          enforcement: close
          bypass-for-members: true
```

For a safe first run, set `dry-run: true`, inspect the logs, then remove it. The GitHub App needs Metadata read plus Pull requests and Issues read/write permissions. The action only inspects API metadata and never checks out PR code.

---

## Versioning

Actions are referenced by git tag. `@v1` is a floating tag that points to the latest `v1.x` release; `@v1.0.0` pins to a specific version. All actions in this repo share the same tag.

**To cut a release:**

```bash
# 1. Build all actions
yarn build

# 2. Stage and commit the built files
git add actions/*/dist/index.js actions/*/dist/licenses.txt
git commit -m "build: v1.0.0"
git push origin main

# 3. Tag the specific version
git tag v1.0.0
git push origin v1.0.0

# 4. Move the floating major tag
git tag -f v1
git push -f origin v1
```

Consumers on `@v1` pick up the update automatically. Consumers pinned to `@v1.0.0` stay frozen until they opt in.

## Setup

This repo is org-internal. In the `repo-bot` repository settings, set **Actions access** to "Accessible from repositories in the Dispatcharr organization."

Consuming repos need these secrets for minting a bot token:

| Secret | Purpose |
|--------|---------|
| `BOT_APP_ID` | GitHub App ID |
| `BOT_PRIVATE_KEY` | GitHub App private key |
