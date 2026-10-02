import { RedisStore } from '@cacheforge/redis'
import {
  revalidationUpdate,
  type CacheStore,
  type RevalidationDurations,
} from '@cacheforge/core'
import { ClusterClock } from './clock.js'
import { TagManifest, type Consistency } from './manifest.js'
import { loadNextTagsManifest, mirrorIntoNext } from './next-bridge.js'

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
  /**
   * Give up on a cache read/write after this long and serve from the origin instead. A slow or
   * unreachable Redis must cost a request milliseconds, not hang it. Default 750.
   */
  timeoutMs?: number
  /**
   * After this many consecutive failures stop calling the store for `cooldownMs`, so an outage
   * adds no latency at all. One success closes the breaker again. Defaults: 3 and 5000.
   */
  breaker?: { failures?: number; cooldownMs?: number }
  /** Called when the store fails during a read or write (which then degrade to cache misses). */
  onError?: (error: unknown, operation: string) => void
  /**
   * Mirror tag invalidations into Next's own manifest so its stale-while-revalidate logic works
   * (see `next-bridge.ts`). Default `true`.
   */
  syncNextManifest?: boolean
  /** Stamp entries with this clock instead of `Date.now` (tests). */
  localClock?: () => number
}

/** Everything one process shares between the cache handlers: store, clock, tag view. */
export class CacheForgeRuntime {
  readonly store: CacheStore
  readonly clock: ClusterClock
  readonly manifest: TagManifest
  private readonly reportError: (error: unknown, operation: string) => void
  private readonly timeoutMs: number
  private readonly breakerFailures: number
  private readonly breakerCooldownMs: number
  private starting: Promise<void> | undefined
  private consecutiveFailures = 0
  private openUntil = 0

  constructor(options: CacheForgeOptions) {
    this.store =
      typeof options.store === 'string'
        ? new RedisStore({ connection: options.store, prefix: options.prefix ?? 'cacheforge' })
        : options.store
    this.clock = new ClusterClock(this.store, options.localClock)
    const nextManifest = options.syncNextManifest === false ? undefined : loadNextTagsManifest()
    this.manifest = new TagManifest(
      this.store,
      {
        consistency: options.consistency ?? 'eventual',
        syncIntervalMs: options.syncIntervalMs ?? 5_000,
      },
      nextManifest &&
        ((tag, state) => mirrorIntoNext(nextManifest, tag, state, (t) => this.clock.toLocal(t))),
    )
    this.reportError = options.onError ?? defaultOnError()
    this.timeoutMs = options.timeoutMs ?? 750
    this.breakerFailures = options.breaker?.failures ?? 3
    this.breakerCooldownMs = options.breaker?.cooldownMs ?? 5_000
  }

  /** True while the breaker is open, i.e. the store is being skipped. */
  get degraded(): boolean {
    return Date.now() < this.openUntil
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
   * Run a cache read/write; on a store failure or timeout report it and return `fallback` so the
   * request is served from the origin instead of failing or hanging.
   */
  async guard<T>(operation: string, fallback: T, run: () => Promise<T>): Promise<T> {
    if (this.degraded) return fallback
    try {
      await withTimeout(this.ready(), this.timeoutMs, 'connect')
      const result = await withTimeout(run(), this.timeoutMs, operation)
      this.consecutiveFailures = 0
      return result
    } catch (error) {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.breakerFailures) {
        this.openUntil = Date.now() + this.breakerCooldownMs
      }
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
    // Generous but bounded: a caller is waiting on this, and it must fail loudly rather than hang.
    const limit = Math.max(this.timeoutMs * 4, 2_000)
    await withTimeout(this.ready(), limit, 'connect')
    const update = revalidationUpdate(this.clock.now(), durations)
    this.manifest.apply(tags, update)
    await withTimeout(this.store.markTags(tags, update), limit, 'markTags')
    await withTimeout(this.store.publish({ type: 'tags', tags: [...tags], update }), limit, 'publish')
  }

  async close(): Promise<void> {
    this.clock.stop()
    this.manifest.stop()
    await this.store.close()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache store timed out after ${ms}ms (${what})`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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
