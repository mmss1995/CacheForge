import { createUseCacheHandler } from '@cacheforge/next'

export default createUseCacheHandler({
  store: process.env.REDIS_URL ?? 'redis://127.0.0.1:6390',
  prefix: process.env.CACHE_PREFIX ?? 'cacheforge-example-use-cache',
})
