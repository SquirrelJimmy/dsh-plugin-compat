/**
 * Generic compatibility layer for legacy DSH Web plugins.
 *
 * DSH authenticates a WebServer route before calling its handler. Some
 * third-party plugins perform their own loopback-only same-origin check inside
 * that handler. Rewriting the request before DSH's authorize step would break
 * the session cookie authority, so this plugin rewrites the request only while
 * an already-authorized handler is running.
 */

export const inject = ['webServer']

const ORIGINAL_HEADERS = Symbol.for('dsh-plugin-compat.original-headers')

export function apply(ctx, config = {}) {
  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') return

  installConnectionCompatibility(ctx)

  const includeAnonymous = config.includeAnonymous === true
  const loopbackAuthority = config.loopbackAuthority ?? detectLoopbackAuthority(server)
  const loopbackOrigin = `http://${loopbackAuthority}`
  const wrappedHandlers = new WeakSet()

  // A WebRoute handler runs only after DSH has authenticated the request. The
  // shim deliberately skips anonymous handshake routes, whose Host is part of
  // DSH's own login flow, and resource routes, which receive an immutable
  // Request rather than the mutable handler signature.
  const shouldWrap = (route) => Boolean(
    route
    && typeof route.handler === 'function'
    && route.resource === undefined
    && (includeAnonymous || route.auth !== 'anonymous'),
  )

  const wrapHandler = (handler) => {
    if (typeof handler !== 'function' || wrappedHandlers.has(handler)) return handler
    const wrapped = function (request, response, peer) {
      return withLoopbackHeaders(request, response, loopbackOrigin, () => (
        handler.call(this, request, response, peer)
      ))
    }
    wrappedHandlers.add(wrapped)
    return wrapped
  }

  const wrapRoute = (route) => {
    if (!shouldWrap(route)) return route
    const handler = wrapHandler(route.handler)
    if (handler === route.handler) return route
    return { ...route, handler }
  }

  const wrapTable = (table) => {
    if (!(table instanceof Map)) return
    for (const [key, route] of table) {
      const wrapped = wrapRoute(route)
      if (wrapped !== route) table.set(key, wrapped)
    }
  }

  const originalRegister = server.register
  const patchedRegister = function (route) {
    return originalRegister.call(this, wrapRoute(route))
  }

  const installed = replaceMethod(server, 'register', patchedRegister)
    || replaceMethod(Object.getPrototypeOf(server), 'register', patchedRegister)
  if (!installed) return

  // Cover plugins loaded before this shim. Plugins loaded later use the patched
  // register method above.
  wrapTable(server.exact)
  wrapTable(server.prefixes)

  ctx.effect?.(() => () => {
    if (server.register === patchedRegister) {
      replaceMethod(server, 'register', originalRegister)
        || replaceMethod(Object.getPrototypeOf(server), 'register', originalRegister)
    }
  })
}

function replaceMethod(target, name, replacement) {
  if (!target) return false
  try {
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: replacement,
    })
  } catch {
    try {
      target[name] = replacement
    } catch {
      // Try the next target.
    }
  }
  return target[name] === replacement
}

function detectLoopbackAuthority(server) {
  try {
    const origin = server.getOrigin?.()
    if (origin) return new URL(origin).host
  } catch {
    // getOrigin() can throw before the listener binds.
  }
  return '127.0.0.1:13080'
}

function installConnectionCompatibility(ctx) {
  const patch = (connection) => {
    if (!connection) return false
    // Cordis service accessors return a traceable proxy; calling a service
    // method through it loses the owning context. Patch and call the original
    // service instance instead.
    const original = connection[Symbol.for('cordis.original')] ?? connection
    if (typeof original.requestRejection === 'function') return true
    if (typeof original.admit !== 'function') return false
    const requestRejection = (request) => original.admit({
      ...request,
      headers: request?.[ORIGINAL_HEADERS] ?? request?.headers,
    }).rejection
    for (const target of [original, Object.getPrototypeOf(original)]) {
      if (!target) continue
      try {
        Object.defineProperty(target, 'requestRejection', {
          configurable: true,
          writable: true,
          value: requestRejection,
        })
      } catch {
        try {
          target.requestRejection = requestRejection
        } catch {
          // Keep trying the prototype / later service instance.
        }
      }
      if (typeof original.requestRejection === 'function') return true
    }
    return false
  }

  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  } catch {
    // The service may not be visible before its async host init.
  }
  if (patch(connection)) return
  // HostConnectionService is constructed asynchronously behind BrowserAuth.
  // Do not make webServer wait for it; install the alias when it appears.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (child) => patch(child.connection))
  }
}

function withLoopbackHeaders(request, response, loopbackOrigin, run) {
  const headers = request.headers ?? (request.headers = {})
  const previousHost = headers.host
  const previousOrigin = headers.origin
  const previousFetchSite = headers['sec-fetch-site']
  request[ORIGINAL_HEADERS] = { ...headers }
  let restored = false

  const restore = () => {
    if (restored) return
    restored = true
    if (previousHost === undefined) delete headers.host
    else headers.host = previousHost
    if (previousOrigin === undefined) delete headers.origin
    else headers.origin = previousOrigin
    if (previousFetchSite === undefined) delete headers['sec-fetch-site']
    else headers['sec-fetch-site'] = previousFetchSite
    delete request[ORIGINAL_HEADERS]
  }

  headers.host = new URL(loopbackOrigin).host
  if (previousOrigin !== undefined) headers.origin = loopbackOrigin
  if (previousFetchSite === 'cross-site') headers['sec-fetch-site'] = 'same-origin'

  if (response && typeof response.once === 'function') {
    response.once('finish', restore)
    response.once('close', restore)
  }

  try {
    const result = run()
    if (result && typeof result.then === 'function') {
      result.then(restore, restore)
    } else if (!response || typeof response.once !== 'function') {
      restore()
    }
    return result
  } catch (error) {
    restore()
    throw error
  }
}
