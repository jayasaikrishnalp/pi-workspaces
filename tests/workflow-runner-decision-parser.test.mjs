/**
 * Pure tests for parseDecisionToken.
 *
 * Spec:
 *   - Returns the matched token, lowercased
 *   - Walks output backwards: multiple DECISION lines → last wins
 *   - Whitespace inside the token is rejected (returns null)
 *   - Empty string / no DECISION line → null
 *   - DECISION token alone (no value) → null
 *   - Token must start with [a-z0-9]; continues with [a-z0-9_-]
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseDecisionToken } from '../src/server/workflow-runner.ts'

test('parseDecisionToken: matches last DECISION line, lowercased', () => {
  const text = 'analysis complete\n\nDECISION: APPROVED'
  assert.equal(parseDecisionToken(text), 'approved')
})

test('parseDecisionToken: multiple DECISION lines → last wins', () => {
  const text = 'DECISION: a\nsome chatter\nDECISION: b'
  assert.equal(parseDecisionToken(text), 'b')
})

test('parseDecisionToken: token with hyphen / underscore allowed', () => {
  assert.equal(parseDecisionToken('DECISION: no-approve'), 'no-approve')
  assert.equal(parseDecisionToken('DECISION: needs_review'), 'needs_review')
})

test('parseDecisionToken: whitespace inside token → null', () => {
  assert.equal(parseDecisionToken('DECISION: foo bar'), null)
})

test('parseDecisionToken: trailing whitespace tolerated', () => {
  assert.equal(parseDecisionToken('DECISION: ok   '), 'ok')
})

test('parseDecisionToken: empty / null / no DECISION → null', () => {
  assert.equal(parseDecisionToken(''), null)
  assert.equal(parseDecisionToken('hello world'), null)
  assert.equal(parseDecisionToken('decision: lowercase prefix?'), null) // matches case-insensitive — passes
})

test('parseDecisionToken: case-insensitive DECISION prefix', () => {
  assert.equal(parseDecisionToken('decision: ok'), 'ok')
  assert.equal(parseDecisionToken('Decision: ok'), 'ok')
})

test('parseDecisionToken: token must start with [a-z0-9]', () => {
  assert.equal(parseDecisionToken('DECISION: -leading-hyphen'), null)
  assert.equal(parseDecisionToken('DECISION: _leading-underscore'), null)
})
