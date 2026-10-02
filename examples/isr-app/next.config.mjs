import { fileURLToPath } from 'node:url'

// CACHEFORGE=off runs the same app on Next's built-in per-process cache, to compare behaviour.
const enabled = process.env.CACHEFORGE !== 'off'

export default enabled
  ? {
      // Next loads this module and instantiates its default export for the ISR / fetch / route cache.
      cacheHandler: fileURLToPath(new URL('./cache-handler.mjs', import.meta.url)),
      // No per-process copy of the cache: every read goes through the shared handler.
      cacheMaxMemorySize: 0,
    }
  : {}
