/**
 * Runnable self-check for the two things that must never be wrong: which
 * directory a session id is allowed to name, and that the Client bundle
 * registers itself under the package's own name (a mismatch crashes web boot).
 *
 *   node check.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { isSessionLog, validateSessionDirectory } from './index.js'

// The module loader registers one lazy factory per package; its id must be the
// package name, and the bundle patch must load that same name.
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const moduleId = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)
assert.ok(moduleId !== null, 'client.js must declare a __ModuleLoader__ id')
assert.equal(moduleId[1], manifest.name, 'the Client module id must equal the package name')
const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
assert.ok(patch.includes(manifest.name), 'cordis.patch.yml must load the package by its own name')

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
