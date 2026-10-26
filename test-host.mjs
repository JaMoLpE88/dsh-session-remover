/**
 * End-to-end check of the host half against a throwaway directory tree and
 * stubbed Harness services. Proves the real deletion path: request gating,
 * directory resolution, containment, removal, cache and reference cleanup.
 *
 *   node test-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from './index.js'

const id = 'session-11111111-2222-3333-4444-555555555555'
const keepId = 'session-99999999-8888-7777-6666-555555555555'

async function harness({ live = false, cacheTable = true, withLog = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'session-remover-'))
  const root = join(base, 'sessions')
  const project = join(root, '--C-Development-demo--')
  const session = join(project, id)
  await mkdir(session, { recursive: true })
  await mkdir(join(project, keepId), { recursive: true })
  if (withLog) await writeFile(join(session, 'session.v4.jsonl.zstd'), 'log')
  await writeFile(join(project, keepId, 'session.v4.jsonl.zstd'), 'keep')

  const cacheFile = join(base, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  await mkdir(join(base, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(cacheFile, '{}')

  const seen = { detached: [], unpinned: [], unarchived: [], cacheDeleted: [], warnings: [] }
  let isLive = live
  let handler

  const workspace = {
    sessionIds: [id, keepId],
    async detachSession(sessionId) {
      this.sessionIds = this.sessionIds.filter((candidate) => candidate !== sessionId)
      seen.detached.push(sessionId)
    },
  }

  const agents = {
    get: () => (isLive ? { id } : undefined),
    async create() {
      return { agent: { id }, dispose: async () => { isLive = false } }
    },
    async resume() {
      return { agent: { id }, dispose: async () => { isLive = false } }
    },
  }

  const ctx = {
    sessionPersistence: { root, stat: async () => undefined },
    sessions: { get: () => undefined },
    agents,
    workspaceRegistry: {
      list: () => [workspace],
      async unpinSession(sessionId) { seen.unpinned.push(sessionId) },
      async unarchiveSession(sessionId) { seen.unarchived.push(sessionId) },
    },
    webServer: {
      register(definition) {
        handler = definition.handler
        return () => {}
      },
    },
    logger: { warn: (...values) => seen.warnings.push(values.join(' ')) },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'sessionProjectionCache') return cacheTable ? { table: { delete: async (sessionId) => seen.cacheDeleted.push(sessionId) } } : undefined
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }

  apply(ctx)
  assert.equal(typeof handler, 'function', 'the delete route must be registered')
  if (live) await agents.create({})

  const call = async (options = {}) => {
    const { method = 'POST', confirmation = true, sessionId = id, body = JSON.stringify({ sessionId }) } = options
    const headers = { 'content-type': 'application/json', host: '127.0.0.1:50877' }
    if (confirmation) headers['x-session-remover-confirmation'] = 'delete-session'
    const request = Readable.from([Buffer.from(body)])
    request.method = method
    request.headers = headers
    const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(text) { this.body = text } }
    await handler(request, response)
    return { status: response.status, body: JSON.parse(response.body) }
  }

  const cleanup = () => rm(base, { recursive: true, force: true })
  return { root, session, keep: join(project, keepId), cacheFile, seen, call, cleanup }
}

const exists = async (path) => stat(path).then(() => true, () => false)

// 1. The request gate refuses a missing confirmation header and removes nothing.
{
  const h = await harness()
  const result = await h.call({ confirmation: false })
  assert.equal(result.status, 403)
  assert.equal(result.body.ok, false)
  assert.equal(await exists(h.session), true)
  await h.cleanup()
}

// 2. An invalid id is refused before it can name a path.
{
  const h = await harness()
  const result = await h.call({ sessionId: '../../etc' })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'invalid-session-id')
  await h.cleanup()
}

// 3. A cold session is removed with its cache record and registry references.
{
  const h = await harness()
  const result = await h.call()
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true, value: { deleted: true } })
  assert.equal(await exists(h.session), false, 'the session directory must be gone')
  assert.equal(await exists(h.keep), true, 'a sibling session must survive')
  assert.deepEqual(h.seen.detached, [id])
  assert.deepEqual(h.seen.unpinned, [id])
  assert.deepEqual(h.seen.unarchived, [id])
  assert.deepEqual(h.seen.cacheDeleted, [id])
  assert.equal(await exists(h.cacheFile), true, 'the cache table path must not touch the file')

  const again = await h.call()
  assert.deepEqual(again.body, { ok: true, value: { deleted: false, alreadyAbsent: true } })
  await h.cleanup()
}

// 4. A live session is closed through its AgentHandle before removal.
{
  const h = await harness({ live: true })
  const result = await h.call()
  assert.equal(result.status, 200)
  assert.equal(result.body.value.deleted, true)
  assert.equal(await exists(h.session), false)
  await h.cleanup()
}

// 5. Without a cache table API, the projection record file is removed instead.
{
  const h = await harness({ cacheTable: false })
  const result = await h.call()
  assert.equal(result.status, 200)
  assert.equal(await exists(h.cacheFile), false, 'the projection cache file must be gone')
  await h.cleanup()
}

// 6. A directory without a session log is not treated as the session's storage.
{
  const h = await harness({ withLog: false })
  const result = await h.call()
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'unsafe-location')
  assert.equal(await exists(h.session), true)
  assert.deepEqual(h.seen.detached, [], 'references must stay when nothing is removed')
  await h.cleanup()
}

console.log('session-remover: host deletion checks passed')
