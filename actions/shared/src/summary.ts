import * as actions from '@actions/core'

export * from '@actions/core'

const entries: string[] = []
let omitted = 0
let characters = 0
let failed = false
let dryRun = false
const MAX_ENTRIES = 500
const MAX_ENTRY_LENGTH = 2000
const MAX_CHARACTERS = 80000

function record(message: string): void {
  const entry = message.length > MAX_ENTRY_LENGTH ? `${message.slice(0, MAX_ENTRY_LENGTH)}… (truncated)` : message
  if (entries.length >= MAX_ENTRIES || characters + entry.length > MAX_CHARACTERS) {
    omitted += 1
    return
  }
  entries.push(entry)
  characters += entry.length
}

export function info(message: string): void {
  actions.info(message)
  // The dry-run report contains the full generated issue comment, which is
  // already represented by the assessment table.
  if (message.startsWith('[dry-run] Would post comment:') || message.startsWith('[dry-run] Would comment on PR #')) {
    record('Dry run: a comment would be posted.')
  } else record(message)
}

export function setDryRun(enabled: boolean): void {
  dryRun = enabled
  if (enabled) record('Dry run: proposed changes were not applied.')
}

export function warning(message: string | Error): void {
  actions.warning(message)
  record(`Warning: ${message instanceof Error ? message.message : message}`)
}

export function notice(message: string | Error): void {
  actions.notice(message)
  record(message instanceof Error ? message.message : message)
}

export function setFailed(message: string | Error): void {
  failed = true
  actions.setFailed(message)
  record(`Failed: ${message instanceof Error ? message.message : message}`)
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export async function runWithSummary(title: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    setFailed(error instanceof Error ? error : String(error))
  } finally {
    try {
      const lines = entries.map(entry => `<li>${escapeHtml(entry)}</li>`).join('\n')
      const overflow = omitted ? `<p>${omitted} additional entries omitted.</p>` : ''
      await actions.summary
        .addHeading(escapeHtml(title))
        .addRaw(`<p>Outcome: ${failed ? 'Failed' : 'Completed'}</p>\n`)
        .addRaw(dryRun ? '<p>Dry run: operations described below are simulated unless otherwise noted.</p>\n' : '')
        .addRaw(lines ? `<ul>\n${lines}\n</ul>\n` : '<p>No decisions or operations were recorded.</p>\n')
        .addRaw(overflow)
        .write()
    } catch (error) {
      actions.warning(`Could not write workflow summary: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
