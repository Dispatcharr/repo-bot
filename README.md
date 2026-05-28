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
| `required-markers` | no | `''` | Comma-separated strings that must all appear in the body |
| `required-labels` | no | `''` | Comma-separated label names that must all be present |
| `required-type` | no | `''` | Comma-separated type names; item type must match one of them |
| `match` | no | `all` | How to combine checks: `all` (every configured check must pass) or `any` (at least one must pass) |
| `enforcement` | no | `close` | What to do with non-compliant items: `close`, `lock`, `close-and-lock`, `comment-only` |
| `lock-reason` | no | `off-topic` | Lock reason when enforcement includes `lock`: `off-topic`, `too heated`, `resolved`, `spam` |
| `close-comment` | no | built-in message | Comment posted on non-compliant items; `{new-issue-url}` is replaced with the repo's template chooser URL |

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
```

When a PR event fires, `enforce-issues` exits immediately (wrong event type) and vice versa. `required-markers` should match section headings from your templates.

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

## Versioning

Actions are referenced by git tag. `@v1` is a floating tag that points to the latest `v1.x` release; `@v1.0.0` pins to a specific version.

Run `yarn build` and commit `dist/` before tagging a release. To move the floating tag after a new release:

```bash
git tag -f v1 && git push -f origin v1
```

## Setup

This repo is org-internal. In the `repo-bot` repository settings, set **Actions access** to "Accessible from repositories in the Dispatcharr organization."

Consuming repos need these secrets for minting a bot token:

| Secret | Purpose |
|--------|---------|
| `BOT_APP_ID` | GitHub App ID |
| `BOT_PRIVATE_KEY` | GitHub App private key |
