import { RedisStore } from '@cacheforge/redis'
import {
  revalidationUpdate,
  type CacheStore,
  type RevalidationDurations,
} from '@cacheforge/core'
import { ClusterClock } from './clock.js'
import { TagManifest, type Consistency } from './manifest.js'

export interface CacheForgeOptions {
  /** A Redis URL (`redis://…`), or a ready {@link CacheStore}. */
  store: string | CacheStore
  /** Key prefix; use one per app and per build you do not want to share. Default `cacheforge`. */
  prefix?: string
  /**
   * `eventual` (default): tag checks read a local view kept fresh by pub/sub, so a `revalidateTag`
   * on another instance is visible within milliseconds and reads never wait on Redis for tags.
   * `strong`: every read asks Redis, at the cost of one extra round trip.
   */
  consistency?: Consistency
  /** How often the local tag view is fully re-synced as a safety net. Default 5000. */
  syncIntervalMs?: number
  /** Called when the store fails during a read or write (which then degrade to cache misses). */
  onError?: (error: unknown, operation: string) => void
  /** Stamp entries with this clock instead of `Date.now` (tests). */
  localClock?: () => number
}

/** Everything one process shares between the cache handlers: store, clock, tag view. */
export class CacheForgeRuntime {
  readonly store: CacheStore
  readonly clock: ClusterClock
  readonly manifest: TagManifest
  private readonly reportError: (error: unknown, operation: string) => void
  private starting: Promise<void> | undefined

  constructor(options: CacheForgeOptions) {
    this.store =
      typeof options.store === 'string'
        ? new RedisStore({ connection: options.store, prefix: options.prefix ?? 'cacheforge' })
        : options.store
    this.clock = new ClusterClock(this.store, options.localClock)
    this.manifest = new TagManifest(this.store, {
      consistency: options.consistency ?? 'eventual',
      syncIntervalMs: options.syncIntervalMs ?? 5_000,
    })
    this.reportError = options.onError ?? defaultOnError()
  }

  /** Connect lazily, once. A store that is down at boot must not stop Next from booting. */
  ready(): Promise<void> {
    this.starting ??= (async () => {
      try {
        await this.clock.start()
        await this.manifest.start()
      } catch (error) {
        this.reportError(error, 'start')
        // Allow the next call to try again.
        this.starting = undefined
      }
    })()
    return this.starting
  }

  /**
   * Run a cache read/write; on a store failure report it and return `fallback` so the request is
   * served from the origin instead of failing.
   */
  async guard<T>(operation: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      await this.ready()
      return await run()
    } catch (error) {
      this.reportError(error, operation)
      return fallback
    }
  }

  /**
   * Invalidate tags for the whole cluster. Unlike reads this is allowed to throw: swallowing a
   * failed invalidation would leave stale content being served with no one the wiser.
   */
  async revalidate(tags: readonly string[], durations?: RevalidationDurations): Promise<void> {
    if (tags.length === 0) return
    await this.ready()
    const update = revalidationUpdate(this.clock.now(), durations)
    this.manifest.apply(tags, update)
    await this.store.markTags(tags, update)
    await this.store.publish({ type: 'tags', tags: [...tags], update })
  }

  async close(): Promise<void> {
    this.clock.stop()
    this.manifest.stop()
    await this.store.close()
  }
}

function defaultOnError(): (error: unknown, operation: string) => void {
  let last = 0
  return (error, operation) => {
    // One line per 10 s: an outage should be loud, not a log flood.
    if (Date.now() - last < 10_000) return
    last = Date.now()
    console.warn(`[cacheforge] ${operation} failed, falling back to the origin:`, error)
  }
}
