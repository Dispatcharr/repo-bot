const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const filename = resolve('actions/issue-triage/src/related.ts')
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = module.paths
loaded._compile(compiled, filename)
const { excludedRelatedNumbers, isIneligibleClosedIssue, relatedIssueQueries, selectRelatedIssues, validateDuplicateTarget } = loaded.exports

const title = '[Bug]: VOD refresh deletes all movie or series sources when the provider returns an empty list'
const body = 'cleanup_orphaned_vod_content deletes sources after get_vod_streams returns an empty list.'
const canonical = { number: 968, title: 'VOD cleanup ignores Stale Stream Retention setting, series wiped on empty API response', body: 'cleanup_orphaned_vod_content deletes series when get_series is empty. Movies may also be deleted.' }
const differentFailure = { number: 1956, title: 'VOD refresh drops a whole batch of movies', body: 'An overlong value makes bulk_create roll back a movie batch.' }

test('searches distinctive code identifiers and bounds the query count', () => {
  const queries = relatedIssueQueries(title, body)
  assert.ok(queries.includes('in:body "cleanup_orphaned_vod_content"'))
  assert.ok(queries.length <= 6)
  assert.ok(queries.every(query => !query.includes('[Bug]')))
})

test('ranks a shared failure above title noise and filters before the cap', () => {
  const self = { number: 1970, title, body }
  const noise = { number: 10, title: 'VOD refresh deletes unrelated configuration', body: '' }
  const result = selectRelatedIssues([[self, noise, differentFailure], [canonical, noise]], title, body, 1, new Set([1970]))
  assert.deepEqual(result.map(issue => issue.number), [968])
  assert.deepEqual(selectRelatedIssues([[self, canonical]], title, body, 2, new Set([1970, 968])), [])
  const excluded = excludedRelatedNumbers(new Set(), 1970, { owner: 'Owner', repo: 'Repo' }, { owner: 'owner', repo: 'repo' })
  assert.ok(excluded.has(1970))
  assert.ok(!excludedRelatedNumbers(new Set(), 1970, { owner: 'owner', repo: 'repo' }, { owner: 'owner', repo: 'other' }).has(1970))
})

test('excludes bot-closed or unverifiable closed candidates but permits human-closed and open candidates', () => {
  assert.equal(isIneligibleClosedIssue({ state: 'closed', closedBy: { type: 'Bot' } }), true)
  assert.equal(isIneligibleClosedIssue({ state: 'closed' }), true)
  assert.equal(isIneligibleClosedIssue({ state: 'closed', closedBy: { type: 'User' } }), false)
  assert.equal(isIneligibleClosedIssue({ state: 'open' }), false)
})

test('duplicate closure requires one supplied target and matching status', () => {
  const valid = { status: 'duplicate', disposition: 'close-duplicate', relatedIssueNumbers: [968] }
  assert.doesNotThrow(() => validateDuplicateTarget(valid, new Set([968]), true))
  assert.throws(() => validateDuplicateTarget(valid, new Set([1970]), true), /supplied eligible/)
  assert.throws(() => validateDuplicateTarget({ ...valid, relatedIssueNumbers: [968, 10] }, new Set([968, 10]), true), /exactly one/)
  assert.throws(() => validateDuplicateTarget({ ...valid, status: 'related' }, new Set([968]), true), /used together/)
  assert.throws(() => validateDuplicateTarget({ ...valid, disposition: 'keep-open' }, new Set([968]), true), /used together/)
  assert.doesNotThrow(() => validateDuplicateTarget({ ...valid, disposition: 'keep-open' }, new Set([968]), false))
})
