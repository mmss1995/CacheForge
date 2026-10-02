import {
  areTagsExpired,
  areTagsStale,
  base64ToBytes,
  bytesToBase64,
  latestExpiration,
  readStream,
  streamFrom,
  type RevalidationDurations,
  type StoredEntry,
} from '@cacheforge/core'
import { CacheForgeRuntime, type CacheForgeOptions } from './runtime.js'

/** Mirror of Next's `CacheEntry` for the `use cache` handlers. */
export interface UseCacheEntry {
  value: ReadableStream<Uint8Array>
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

/** Mirror of Next's `CacheHandler` interface for `cacheHandlers`. */
export interface UseCacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined>
  set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>
  refreshTags(): Promise<void>
  getExpiration(tags: string[]): Promise<number>
  updateTags(tags: string[], durations?: RevalidationDurations): Promise<void>
  /** The shared runtime, for tests and for shutting down. */
  readonly runtime: CacheForgeRuntime
}

/**
 * Build a handler for Next's `cacheHandlers` option (`'use cache'`). Use it for `default`, and for
 * `remote` too if you want `'use cache: remote'` shared across the cluster.
 */
export function createUseCacheHandler(options: CacheForgeOptions): UseCacheHandler {
  const runtime = new CacheForgeRuntime(options)
  // Next requires a get() issued while a set() for the same key is in flight to wait for it.
  const pendingSets = new Map<string, Promise<void>>()

  return {
    runtime,

    async get(cacheKey, _softTags) {
      // Soft tags are checked by Next itself through getExpiration(), so they are ignored here.
      await pendingSets.get(cacheKey)
      return runtime.guard<UseCacheEntry | undefined>('get', undefined, async () => {
        const stored = await runtime.store.get(cacheKey)
        if (!stored) return undefined
        const revalidate = stored.revalidate ?? 0
        const expire = stored.expire ?? 0
        const now = runtime.clock.now()
        if (expire < 0) return undefined
        if (now > stored.timestamp + revalidate * 1000) return undefined

        await runtime.manifest.refresh()
        const states = await runtime.manifest.statesFor(stored.tags)
        if (areTagsExpired(stored.tags, stored.timestamp, states, now)) return undefined

        return {
          value: streamFrom(base64ToBytes(stored.data)),
          tags: stored.tags,
          stale: stored.stale ?? 0,
          timestamp: runtime.clock.toLocal(stored.timestamp),
          expire,
          // A soft-invalidated tag keeps serving the entry but tells Next to refresh it.
          revalidate: areTagsStale(stored.tags, stored.timestamp, states) ? -1 : revalidate,
        }
      })
    },

    async set(cacheKey, pendingEntry) {
      let done!: () => void
      const pending = new Promise<void>((resolve) => (done = resolve))
      pendingSets.set(cacheKey, pending)
      try {
        const entry = await pendingEntry
        // An expire of 0 means "dynamic": Next regenerates it on every read, so storing is waste.
        if (entry.expire === 0) return
        const [forStore, forNext] = entry.value.tee()
        entry.value = forNext
        const bytes = await readStream(forStore)
        await runtime.guard('set', undefined, async () => {
          const stored: StoredEntry = {
            tags: entry.tags,
            timestamp: runtime.clock.toCluster(entry.timestamp),
            revalidate: entry.revalidate,
            expire: entry.expire,
            stale: entry.stale,
            data: bytesToBase64(bytes),
          }
          await runtime.store.set(cacheKey, stored, {
            ttlSeconds: entry.revalidate > 0 ? entry.revalidate : undefined,
          })
        })
      } catch {
        // The entry's stream failed partway. Next will simply regenerate it.
      } finally {
        done()
        pendingSets.delete(cacheKey)
      }
    },

    async refreshTags() {
      await runtime.guard('refreshTags', undefined, async () => runtime.manifest.refresh())
    },

    async getExpiration(tags) {
      return runtime.guard('getExpiration', 0, async () => {
        const states = await runtime.manifest.statesFor(tags)
        const latest = latestExpiration(tags, states)
        return latest === 0 ? 0 : runtime.clock.toLocal(latest)
      })
    },

    async updateTags(tags, durations) {
      await runtime.revalidate(tags, durations)
    },
  }
}
