/**
 * Host half of the Session Remover bundle.
 *
 * DeepSeek Harness has no session-deletion API, so this plugin performs one
 * confirmed, validated removal of a stored session: it closes the live agent
 * (the only way to release the writer lease), removes the session's own
 * directory inside the JSONL store, then drops the derived records that would
 * otherwise keep the conversation on disk.
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'session-remover'
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'agents', 'workspaceRegistry']

const ROUTE = '/plugins/session-remover/delete'
const CONFIRMATION_HEADER = 'x-session-remover-confirmation'
const CONFIRMATION = 'delete-session'
const MAX_BODY_BYTES = 8 * 1024
const DETACH_TIMEOUT_MS = 5000
/** Session ids are `session-<uuid>`; anything else is rejected before it can name a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** `session.jsonl`, `session.v4.jsonl`, `session.v4.jsonl.zstd`. */
const SESSION_LOG = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/

export function isSessionLog(name) {
  return typeof name === 'string' && SESSION_LOG.test(name)
}

/**
 * Accept a directory only when it is exactly `<root>/<one project segment>/<session id>`.
 * Returns the resolved directory, or undefined for anything else.
 */
export function validateSessionDirectory(root, sessionId, directory) {
  if (typeof root !== 'string' || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined
  if (typeof directory !== 'string' || directory.length === 0) return undefined
  const rootPath = resolve(root)
  const target = resolve(directory)
  const path = relative(rootPath, target)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined
  const segments = path.split(sep)
  if (segments.length !== 2 || segments[1] !== sessionId) return undefined
  if (basename(target) !== sessionId) return undefined
  return target
}

export function apply(ctx) {
  const persistence = ctx.sessionPersistence
  const root = persistenceRoot(persistence)
  if (root === undefined) {
    throw new Error('dsh-session-remover requires the per-session JSONL session store')
  }

  const tracker = installAgentTracker(ctx.agents)
  ctx.effect(() => () => tracker.release(), 'dsh-session-remover: agent handle tracking')

  const deleting = new Set()
  const deleteSession = (sessionId) => removeSession({ ctx, root, tracker, deleting }, sessionId)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (request, response) => serveDeleteRequest({ ctx, deleteSession }, request, response),
  }), 'dsh-session-remover: confirmed deletion route')
}

function persistenceRoot(persistence) {
  const configured = typeof persistence?.root === 'string' ? persistence.root : persistence?.config?.root
  return typeof configured === 'string' && configured.length > 0 ? resolve(configured) : undefined
}

/** Follow Cordis's `original` unwrap to the shared service instance. */
function originalService(service) {
  const symbol = Symbol.for('cordis.original')
  let target = service
  for (let depth = 0; depth < 4; depth += 1) {
    const next = target?.[symbol]
    if (next === undefined || next === target) break
    target = next
  }
  return target
}

/**
 * Keep the AgentHandle that `agents.create`/`resume` return: the handle owns the
 * ordered teardown (cancel, drain, close the writer, detach), and the registry
 * exposes no equivalent for a plugin that did not create the agent.
 *
 * Cordis hands each context a traceable proxy, so the patch must land on the
 * shared instance behind it; the `original` symbol is the documented unwrap and
 * it is followed more than once in case the proxy is layered.
 */
function installAgentTracker(agents) {
  const service = originalService(agents)
  const original = Symbol('session-remover.original')
  const handles = new Map()

  const wrap = (method) => {
    const wrapped = async function (...args) {
      const handle = await Reflect.apply(method, this, args)
      const id = handle?.agent?.id
      if (typeof id === 'string') handles.set(id, handle)
      return handle
    }
    Object.defineProperty(wrapped, original, { value: method })
    return wrapped
  }

  const wrappedCreate = wrap(service.create)
  const wrappedResume = wrap(service.resume)
  service.create = wrappedCreate
  service.resume = wrappedResume

  return {
    async dispose(sessionId) {
      const handle = handles.get(sessionId)
      if (handle === undefined) return false
      try {
        await handle.dispose()
        return true
      } finally {
        handles.delete(sessionId)
      }
    },
    release() {
      if (service.create === wrappedCreate) service.create = wrappedCreate[original]
      if (service.resume === wrappedResume) service.resume = wrappedResume[original]
      handles.clear()
    },
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

const failure = (code, message) => ({ ok: false, error: { code, message } })

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request-too-large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Prefer the Host's own request fence: it also admits the desktop app's
 * forwarded requests, which carry no Origin header.
 */
function isTrustedRequest(ctx, request) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (typeof connection?.requestRejection === 'function') {
    return connection.requestRejection(request) === undefined
  }
  const host = request.headers.host
  return typeof host === 'string'
    && (request.headers.origin === `http://${host}` || request.headers.origin === `https://${host}`)
}

async function serveDeleteRequest({ ctx, deleteSession }, request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, failure('method-not-allowed', 'Only POST can delete a session.'))
    return
  }
  if (!isTrustedRequest(ctx, request) || request.headers[CONFIRMATION_HEADER] !== CONFIRMATION) {
    sendJson(response, 403, failure('forbidden', 'The delete request did not pass the origin and confirmation checks.'))
    return
  }
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    sendJson(response, 415, failure('unsupported-media-type', 'The delete request must be JSON.'))
    return
  }

  let body
  try {
    body = await readJsonBody(request)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'request-too-large'
    sendJson(response, tooLarge ? 413 : 400, failure(
      tooLarge ? 'request-too-large' : 'invalid-json',
      tooLarge ? 'The delete request is too large.' : 'The delete request is not valid JSON.',
    ))
    return
  }

  if (typeof body?.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) {
    sendJson(response, 400, failure('invalid-session-id', 'The session id is not valid.'))
    return
  }

  try {
    const result = await deleteSession(body.sessionId)
    sendJson(response, result.ok ? 200 : 409, result)
  } catch (error) {
    ctx.logger?.warn?.(`session-remover: deleting "${body.sessionId}" failed unexpectedly: ${String(error)}`)
    sendJson(response, 500, failure('internal', 'The session could not be deleted; nothing was confirmed as removed.'))
  }
}

async function removeSession({ ctx, root, tracker, deleting }, sessionId) {
  if (deleting.has(sessionId)) {
    return failure('deletion-in-progress', 'This session is already being deleted.')
  }
  deleting.add(sessionId)
  try {
    return await performDeletion({ ctx, root, tracker }, sessionId)
  } finally {
    deleting.delete(sessionId)
  }
}

async function performDeletion({ ctx, root, tracker }, sessionId) {
  const snapshot = await readSession(ctx.sessionPersistence, sessionId)

  if (ctx.agents.get(sessionId) !== undefined) {
    let closed
    try {
      closed = await tracker.dispose(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`session-remover: could not close live session "${sessionId}": ${String(error)}`)
      return failure('session-busy', 'This session could not be stopped; nothing was deleted.')
    }
    if (closed === false) {
      return failure('session-busy', 'This session was opened before Session Remover was loaded, so it cannot be closed from here. Restart DeepSeek Harness and try again; nothing was deleted.')
    }
    if (!await waitForDetach(ctx, sessionId)) {
      return failure('session-busy', 'DeepSeek Harness did not finish closing this session; nothing was deleted.')
    }
  }

  const directories = await locateDirectories(ctx.sessionPersistence, root, sessionId, snapshot?.header)
  if (directories.length > 1) {
    return failure('unsafe-location', 'This session matches more than one storage directory; nothing was deleted.')
  }
  const directory = directories[0]

  if (directory === undefined) {
    await dropReferences(ctx, sessionId)
    await dropProjectionCache(ctx, root, sessionId)
    return { ok: true, value: { deleted: false, alreadyAbsent: true } }
  }

  const info = await lstat(directory).catch(() => undefined)
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
    return failure('unsafe-location', 'The session directory changed; nothing was deleted.')
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined || !entries.some((entry) => entry.isFile() && !entry.isSymbolicLink() && isSessionLog(entry.name))) {
    return failure('unsafe-location', 'The session directory does not contain a session log; nothing was deleted.')
  }
  if (ctx.agents.get(sessionId) !== undefined || ctx.sessions.get(sessionId) !== undefined) {
    return failure('session-reopened', 'This session was reopened during deletion; nothing was deleted.')
  }

  await dropReferences(ctx, sessionId)

  try {
    await removeDirectory(directory)
  } catch (error) {
    return failure('storage-error', `The session files could not be removed (${errorCode(error)}); nothing was confirmed as deleted.`)
  }

  await dropProjectionCache(ctx, root, sessionId)
  reconcileSearchIndex(ctx)
  return { ok: true, value: { deleted: true } }
}

async function readSession(persistence, sessionId) {
  if (typeof persistence?.stat !== 'function') return undefined
  try {
    return await persistence.stat(sessionId)
  } catch {
    // A corrupt or unreadable log must still be deletable; the directory checks decide.
    return undefined
  }
}

async function locateDirectories(persistence, root, sessionId, header) {
  const candidates = new Set()

  if (header !== undefined && typeof persistence.locate === 'function') {
    try {
      const located = persistence.locate(header)
      if (typeof located === 'string' && isAbsolute(located)) {
        const validated = validateSessionDirectory(root, sessionId, dirname(resolve(located)))
        if (validated !== undefined) candidates.add(validated)
      }
    } catch {
      // Fall back to scanning the configured root.
    }
  }

  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const candidate = join(root, project.name, sessionId)
    if (candidates.has(candidate)) continue
    const info = await lstat(candidate).catch(() => undefined)
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) continue
    const validated = validateSessionDirectory(root, sessionId, candidate)
    if (validated !== undefined) candidates.add(validated)
  }
  return [...candidates]
}

async function waitForDetach(ctx, sessionId) {
  const deadline = Date.now() + DETACH_TIMEOUT_MS
  for (;;) {
    if (ctx.agents.get(sessionId) === undefined && ctx.sessions.get(sessionId) === undefined) return true
    if (Date.now() >= deadline) return false
    await delay(50)
  }
}

async function dropReferences(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`session-remover: could not detach "${sessionId}" from its workspace: ${String(error)}`)
    }
  }
  try {
    await registry.unpinSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-remover: could not unpin "${sessionId}": ${String(error)}`)
  }
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`session-remover: could not unarchive "${sessionId}": ${String(error)}`)
  }
}

/**
 * The projection cache keeps a per-session record with conversation-derived
 * values and never prunes it. Drop the record through its own table when that
 * API is reachable, otherwise remove the record file directly.
 */
async function dropProjectionCache(ctx, root, sessionId) {
  const cache = typeof ctx.get === 'function' ? ctx.get('sessionProjectionCache') : undefined
  if (typeof cache?.table?.delete === 'function') {
    try {
      await cache.table.delete(sessionId)
      return
    } catch {
      // Fall through to the record file.
    }
  }
  const record = join(dirname(root), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  await rm(record, { force: true }).catch(() => undefined)
}

/**
 * ponytail: best-effort. The SQLite search index only drops rows for removed
 * sessions during its own reconcile pass, which runs on the first search, so
 * one cheap search clears the deleted session's stored text now. If it is
 * unavailable or disabled, the next real search does the same work.
 */
function reconcileSearchIndex(ctx) {
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (typeof query?.searchSessions !== 'function') return
  query.searchSessions({ query: 'session-remover', limit: 1 }).catch(() => undefined)
}

async function removeDirectory(directory) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(directory, { recursive: true })
      return
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      lastError = error
      const info = await lstat(directory).catch(() => undefined)
      if (info === undefined) return
      await delay(120)
    }
  }
  throw lastError
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : String(error)
}
