/**
 * Runnable self-check for the one piece of the host half that must never be
 * wrong: which directory a session id is allowed to name.
 *
 *   node check.mjs
 */
import assert from 'node:assert/strict'
import { resolve, sep } from 'node:path'
import { isSessionLog, validateSessionDirectory } from './index.js'

const root = process.platform === 'win32' ? 'C:\\sessions' : '/sessions'
const id = 'session-0123abcd-1111-2222-3333-444455556666'
const project = resolve(root, '--C-Development-demo--')

assert.equal(isSessionLog('session.v4.jsonl.zstd'), true)
assert.equal(isSessionLog('session.jsonl'), true)
assert.equal(isSessionLog('session.v12.jsonl'), true)
assert.equal(isSessionLog('notes.txt'), false)
assert.equal(isSessionLog('session.lock'), false)

assert.equal(validateSessionDirectory(root, id, resolve(project, id)), resolve(project, id))

// Not the session id's own directory.
assert.equal(validateSessionDirectory(root, id, resolve(project, 'other-session')), undefined)
// Outside the configured root.
assert.equal(validateSessionDirectory(root, id, resolve(root, '..', 'elsewhere', id)), undefined)
// The root itself, a project directory, or one level too shallow.
assert.equal(validateSessionDirectory(root, id, resolve(root, id)), undefined)
assert.equal(validateSessionDirectory(root, id, root), undefined)
// One level too deep.
assert.equal(validateSessionDirectory(root, id, resolve(project, id, 'nested')), undefined)
// An id that could escape or name another path.
assert.equal(validateSessionDirectory(root, '../' + id, resolve(project, id)), undefined)
assert.equal(validateSessionDirectory(root, `..${sep}` + id, resolve(project, id)), undefined)
assert.equal(validateSessionDirectory(root, '..', resolve(root, '..')), undefined)
assert.equal(validateSessionDirectory(root, '', resolve(project, '')), undefined)

console.log('session-remover: path validation checks passed')
