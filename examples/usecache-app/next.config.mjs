import { fileURLToPath } from 'node:url'

const handler = fileURLToPath(new URL('./cache-handlers.mjs', import.meta.url))

// CACHEFORGE=off runs the same app on Next's built-in per-process cache, to compare behaviour.
const enabled = process.env.CACHEFORGE !== 'off'

export default {
  cacheComponents: true,
  // `default` serves plain `'use cache'`; `remote` serves `'use cache: remote'`. Both are shared.
  ...(enabled ? { cacheHandlers: { default: handler, remote: handler } } : {}),
}
