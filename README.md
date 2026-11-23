# dsh-plugin-compat

Compatibility layer for legacy third-party DSH Web plugins.

Version `0.2.3-alpha.2` tracks the DSH release it is built against. Whenever a
DSH breaking update removes or changes a plugin-facing API, this package is
updated and released with the matching version.

Some third-party plugins register a `ctx.webServer` route and enforce their own
`Host`/`Origin` loopback check inside the handler. The DSH session cookie is
bound to the public authority, so changing `Host` at nginx or before DSH's
authorization step breaks authentication. This plugin keeps DSH's authorization
step untouched and rewrites the request headers only while an
already-authorized handler runs.

## Scope

By default every non-anonymous `WebRoute` handler registered on `ctx.webServer`
is covered, whether it was registered before or after this plugin loaded. There
is no route list to maintain. Anonymous handshake routes and resource routes are
skipped because their request contract is part of DSH itself.

`includeAnonymous: true` can be set only when a third-party plugin deliberately
marks its own route anonymous and still needs the loopback compatibility view.

`loopbackAuthority` defaults to the DSH listener origin; it can be set
explicitly when the listener is not on `127.0.0.1:13080`.

The plugin also installs a compatibility alias for
`connection.requestRejection`, which DSH 0.2.3 removed in favor of
`connection.admit`. Plugins compiled against 0.2.2 can keep using the old
method without patching each plugin. The alias authenticates against the
request headers captured before the handler rewrite, preserving the DSH
session-cookie authority.

## Security boundary

DSH's normal session authentication still runs first for every route; this
plugin does not make a route anonymous and does not bypass DSH's `/api` trust
fence. It only changes the headers seen inside an already-authorized handler
and restores them when that handler returns.

## Install

From DSH: **Plugins → Add plugin**, then choose this directory. The bundle
manifest is `dsh.bundle.patch` in `package.json`.

## Verify

The plugin is host-only and has no runtime dependencies. Its wrapper can be
tested with Node's test runner without mounting DSH:

```sh
node --test test.mjs
```
