import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { missingMarkers } from './markers'

test('matches markers regardless of case and extra whitespace', () => {
  assert.deepEqual(missingMarkers('## Checklist\r\n\r\n- [X]  I agree\tto the CLA', [
    '## checklist', '- [x] I agree to the CLA',
  ]), [])
})

test('normalizes unicode and removes ANSI escape sequences on both sides', () => {
  assert.deepEqual(missingMarkers('\u001b[31mCAFÉ\u001b[0m ✓ agreement', ['cafe agreement ✓']), [])
})

test('reports genuinely missing markers using the original marker', () => {
  assert.deepEqual(missingMarkers('## Checklist', ['## Checklist', '## Testing']), ['## Testing'])
})

test('does not match a marker that normalizes to an empty string', () => {
  assert.deepEqual(missingMarkers('anything', ['✓']), ['✓'])
})
