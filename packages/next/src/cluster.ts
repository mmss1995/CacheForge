import { MemoryStore } from '@cacheforge/core'
import { createCacheHandler } from './legacy.js'
import { createUseCacheHandler } from './use-cache.js'
import type { CacheForgeOptions } from './runtime.js'

/**
 * Test helper: N "instances" that share one store, each with its own (optionally skewed) clock.
 * Exported from the package so users can test their own invalidation flows without Redis.
 */
export function createTestCluster(
  size: number,
  options: { skewsMs?: number[]; shared?: MemoryStore } & Partial<CacheForgeOptions> = {},
) {
  const store = options.shared ?? new MemoryStore()
  const instance = (index: number) => {
    const skew = options.skewsMs?.[index] ?? 0
    const base: CacheForgeOptions = {
      ...options,
      store,
      localClock: () => Date.now() + skew,
      onError: options.onError ?? (() => {}),
    }
    return {
      legacy: createCacheHandler(base),
      useCache: createUseCacheHandler(base),
    }
  }
  return { store, instances: Array.from({ length: size }, (_, i) => instance(i)) }
}
