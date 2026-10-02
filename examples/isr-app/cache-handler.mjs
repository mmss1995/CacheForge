import { createCacheHandler } from '@cacheforge/next'

export default createCacheHandler({
  store: process.env.REDIS_URL ?? 'redis://127.0.0.1:6390',
  prefix: process.env.CACHE_PREFIX ?? 'cacheforge-example-isr',
  // Set CACHEFORGE_BRIDGE=off to see what soft revalidation does without the Next manifest bridge.
  syncNextManifest: process.env.CACHEFORGE_BRIDGE !== 'off',
})
