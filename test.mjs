import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from './index.js'

function makeServer() {
  const exact = new Map()
  const prefixes = new Map()
  const server = {
    exact,
    prefixes,
    getOrigin: () => 'http://127.0.0.1:13080',
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
  }
  return server
}

function request(headers = {}) {
  return { url: '/', headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com', ...headers } }
}

test('wraps an already registered non-anonymous route', () => {
  const server = makeServer()
  let seen
  server.exact.set('/third-party/catalog', {
    kind: 'exact',
    path: '/third-party/catalog',
    handler: (req) => {
      seen = { ...req.headers }
      return 'ok'
    },
  })

  apply({ webServer: server })
  const req = request()
  const result = server.exact.get('/third-party/catalog').handler(req, {})

  assert.equal(result, 'ok')
  assert.equal(seen.host, '127.0.0.1:13080')
  assert.equal(seen.origin, 'http://127.0.0.1:13080')
  assert.equal(req.headers.host, 'dsh.example.com')
  assert.equal(req.headers.origin, 'https://dsh.example.com')
})

test('wraps routes registered after the shim is applied', () => {
  const server = makeServer()
  apply({ webServer: server }, { loopbackAuthority: '127.0.0.1:13080' })
  let seen
  server.register({
    kind: 'prefix',
    path: '/another-plugin',
    handler: (req) => {
      seen = { ...req.headers }
    },
  })
  server.prefixes.get('/another-plugin').handler(request(), {})

  assert.equal(seen.host, '127.0.0.1:13080')
})

test('does not wrap anonymous handshake routes by default', () => {
  const server = makeServer()
  let seen
  server.exact.set('/connect', {
    kind: 'exact',
    path: '/connect',
    auth: 'anonymous',
    handler: (req) => {
      seen = { ...req.headers }
    },
  })

  apply({ webServer: server })
  server.exact.get('/connect').handler(request(), {})

  assert.equal(seen.host, 'dsh.example.com')
})

test('does not wrap resource routes', () => {
  const server = makeServer()
  let seen
  server.prefixes.set('/assets', {
    kind: 'prefix',
    path: '/assets',
    auth: 'anonymous',
    resource: (req) => {
      seen = req.headers.host
      return new Response('ok')
    },
  })

  apply({ webServer: server })
  server.prefixes.get('/assets').resource({ headers: { host: 'dsh.example.com' } })

  assert.equal(seen, 'dsh.example.com')
})

test('keeps async handlers wrapped until they settle', async () => {
  const server = makeServer()
  let seen
  server.exact.set('/async-plugin/status', {
    kind: 'exact',
    path: '/async-plugin/status',
    handler: async (req) => {
      seen = { ...req.headers }
      await Promise.resolve()
    },
  })

  apply({ webServer: server })
  await server.exact.get('/async-plugin/status').handler(request(), {})

  assert.equal(seen.host, '127.0.0.1:13080')
})

test('fills the removed connection.requestRejection compatibility alias', () => {
  const server = makeServer()
  const connection = {
    admit: (req) => req.rejected ? { rejection: 403 } : { peer: {} },
  }

  apply({ webServer: server, connection })
  assert.equal(connection.requestRejection({}), undefined)
  assert.equal(connection.requestRejection({ rejected: true }), 403)
})
