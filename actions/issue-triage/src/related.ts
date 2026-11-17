const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'bug', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'issue', 'no', 'not', 'of', 'on', 'or', 'request', 'the', 'to', 'with',
])

function terms(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word))
}

function identifiers(text: string): string[] {
  return [...new Set((text.match(/\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+){2,}\b/g) ?? []).map(value => value.toLowerCase()))].slice(0, 3)
}

export function relatedIssueQueries(title: string, body: string | null): string[] {
  const normalized = title.replace(/^\s*\[[^\]]+\]\s*:?\s*/, '').replace(/\s+/g, ' ').trim()
  const titleTerms = terms(normalized)
  const codeTerms = identifiers(`${title} ${body ?? ''}`)
  return [...new Set([
    normalized && `in:title "${normalized.replace(/"/g, '').slice(0, 128)}"`,
    ...codeTerms.map(term => `in:body "${term}"`),
    titleTerms.length >= 2 && `in:title ${titleTerms.slice(0, 2).join(' ')}`,
    titleTerms.length >= 3 && `in:title ${titleTerms.slice(0, 3).join(' ')}`,
  ].filter((query): query is string => Boolean(query)))]
}

type Candidate = { number: number, title: string, body?: string | null }

export function selectRelatedIssues<T extends Candidate>(searches: T[][], title: string, body: string | null, max: number, excluded: Set<number>): T[] {
  const unique = new Map<number, T>()
  for (const search of searches) for (const candidate of search) {
    if (!excluded.has(candidate.number) && !unique.has(candidate.number)) unique.set(candidate.number, candidate)
  }
  const titleTerms = new Set(terms(title))
  const codeTerms = identifiers(`${title} ${body ?? ''}`)
  const score = (candidate: T): number => {
    const candidateTitle = new Set(terms(candidate.title))
    const text = `${candidate.title} ${candidate.body ?? ''}`.toLowerCase()
    return [...titleTerms].filter(term => candidateTitle.has(term)).length + 4 * codeTerms.filter(term => text.includes(term)).length
  }
  return [...unique.values()].sort((a, b) => score(b) - score(a)).slice(0, max)
}

export function excludedRelatedNumbers(ignored: Set<number>, issueNumber: number, issueRepo: { owner: string, repo: string }, contextRepo: { owner: string, repo: string }): Set<number> {
  const excluded = new Set(ignored)
  if (issueRepo.owner.toLowerCase() === contextRepo.owner.toLowerCase() && issueRepo.repo.toLowerCase() === contextRepo.repo.toLowerCase()) excluded.add(issueNumber)
  return excluded
}

export function isIneligibleClosedIssue(issue: { state: string, closedBy?: { type?: string | null } | null }): boolean {
  return issue.state === 'closed' && (issue.closedBy === undefined || issue.closedBy?.type === 'Bot')
}

export function validateDuplicateTarget(result: { status: string, disposition: string, relatedIssueNumbers: number[] }, suppliedNumbers: Set<number>, allowDuplicateClose: boolean): void {
  if ((result.disposition === 'close-duplicate' && result.status !== 'duplicate') || (allowDuplicateClose && result.status === 'duplicate' && result.disposition !== 'close-duplicate')) {
    throw new Error('duplicate status and close-duplicate disposition must be used together when duplicate closure is allowed')
  }
  if (result.disposition === 'close-duplicate' && (result.relatedIssueNumbers.length !== 1 || !suppliedNumbers.has(result.relatedIssueNumbers[0]))) {
    throw new Error('close-duplicate requires exactly one supplied eligible canonical issue number')
  }
}
