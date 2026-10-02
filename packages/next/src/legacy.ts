import {
  areTagsExpired,
  decodeValue,
  encodeValue,
  type RevalidationDurations,
  type StoredEntry,
} from '@cacheforge/core'
import { CacheForgeRuntime, type CacheForgeOptions } from './runtime.js'

/** Header Next puts a page's tags in (comma separated). */
export const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags'

// Structural stand-ins for Next's internal types, so this package builds without importing them
// (they are not public API and move between releases).
interface HandlerContext {
  revalidatedTags?: string[]
}
interface GetContext {
  kind?: string
  tags?: string[]
  softTags?: string[]
}
interface SetContext {
  fetchCache?: boolean
  tags?: string[]
}
interface CacheValue {
  kind: string
  tags?: string[]
  headers?: Record<string, unknown>
  [field: string]: unknown
}
export interface LegacyEntry {
  lastModified: number
  value: CacheValue | null
}

/** The class Next instantiates for `cacheHandler`. */
export interface LegacyCacheHandlerClass {
  new (context: HandlerContext): {
    get(key: string, context: GetContext): Promise<LegacyEntry | null>
    set(key: string, data: CacheValue | null, context: SetContext): Promise<void>
    revalidateTag(tags: string | string[], durations?: RevalidationDurations): Promise<void>
    resetRequestCache(): void
  }
  /** The shared runtime, for tests and for shutting down. */
  readonly runtime: CacheForgeRuntime
}

function tagsOf(data: CacheValue, context: SetContext): string[] {
  if (data.kind === 'FETCH') return data.tags ?? context.tags ?? []
  const header = data.headers?.[NEXT_CACHE_TAGS_HEADER]
  return typeof header === 'string' && header ? header.split(',') : []
}

/**
 * Build the class for Next's `cacheHandler` option (ISR pages, route handlers, `fetch` data cache).
 * Next creates many instances of the class; they all share one runtime per process.
 */
export function createCacheHandler(options: CacheForgeOptions): LegacyCacheHandlerClass {
  const runtime = new CacheForgeRuntime(options)

  return class CacheForgeHandler {
    static readonly runtime = runtime
    private readonly revalidatedTags: string[]

    constructor(context: HandlerContext) {
      this.revalidatedTags = context.revalidatedTags ?? []
    }

    async get(key: string, context: GetContext): Promise<LegacyEntry | null> {
      return runtime.guard('get', null, async () => {
        const stored = await runtime.store.get(key)
        if (!stored) return null
        const lastModified = stored.timestamp

        // Pages carry their tags with them; fetches are checked against the tags of this call too.
        const tags =
          context.kind === 'FETCH'
            ? [...(context.tags ?? []), ...(context.softTags ?? [])]
            : stored.tags
        // A tag revalidated earlier in this very request must not serve the old entry back.
        if (context.kind === 'FETCH' && tags.some((tag) => this.revalidatedTags.includes(tag))) {
          return null
        }
        await runtime.manifest.refresh()
        const states = await runtime.manifest.statesFor(tags)
        if (areTagsExpired(tags, lastModified, states, runtime.clock.now())) return null

        const { value } = decodeValue<{ value: CacheValue | null }>(stored.data)
        return { lastModified: runtime.clock.toLocal(lastModified), value }
      })
    }

    async set(key: string, data: CacheValue | null, context: SetContext): Promise<void> {
      await runtime.guard('set', undefined, async () => {
        if (!data) {
          await runtime.store.delete(key)
          return
        }
        const entry: StoredEntry = {
          tags: tagsOf(data, context),
          timestamp: runtime.clock.now(),
          data: encodeValue({ value: data }),
        }
        await runtime.store.set(key, entry)
      })
    }

    async revalidateTag(tags: string | string[], durations?: RevalidationDurations): Promise<void> {
      await runtime.revalidate(typeof tags === 'string' ? [tags] : tags, durations)
    }

    resetRequestCache(): void {}
  }
}
