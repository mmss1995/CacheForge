/** Millisecond epoch timestamp. */
export type Timestamp = number

/**
 * What the cache knows about one tag. Both fields are monotonic: they only ever move forward.
 * - `stale`: entries created before this are served once more while a refresh runs.
 * - `expired`: entries created before this (once it is in the past) are gone.
 */
export interface TagState {
  stale?: Timestamp
  expired?: Timestamp
}

/** A cached value as stored. `data` is opaque to the store (the handlers encode it). */
export interface StoredEntry {
  tags: string[]
  /** When the entry was produced. Tag invalidations are compared against this. */
  timestamp: Timestamp
  /** Seconds until the entry needs a refresh. */
  revalidate?: number
  /** Seconds until the entry must not be served at all. */
  expire?: number
  /** Seconds the client may keep using it (`use cache` only). */
  stale?: number
  data: string
}

export type CacheEvent =
  | { type: 'tags'; tags: string[]; update: TagState }
  | { type: 'delete'; key: string }
  | { type: 'flush' }

export interface SetOptions {
  /** Drop the entry from the store after this many seconds. */
  ttlSeconds?: number
}

export interface EntryInfo {
  key: string
  tags: string[]
  timestamp: Timestamp
  bytes: number
}

export interface StoreStats {
  entries: number
  bytes: number
  tags: number
}

/**
 * Everything CacheForge needs from a backend. Implementations must make `markTags` monotonic
 * (a tag's `stale`/`expired` never go back) because several instances call it concurrently.
 */
export interface CacheStore {
  get(key: string): Promise<StoredEntry | undefined>
  set(key: string, entry: StoredEntry, options?: SetOptions): Promise<void>
  delete(key: string): Promise<boolean>
  /** Tag states for the given tags. Tags nobody ever invalidated are absent. */
  getTagStates(tags: readonly string[]): Promise<Map<string, TagState>>
  getAllTagStates(): Promise<Map<string, TagState>>
  markTags(tags: readonly string[], update: TagState): Promise<void>
  /** Receive events published by any instance (including this one). Returns an unsubscribe. */
  subscribe(listener: (event: CacheEvent) => void): Promise<() => void>
  publish(event: CacheEvent): Promise<void>
  /** Inspection, used by the CLI. */
  list(options?: { match?: string; limit?: number }): Promise<EntryInfo[]>
  stats(): Promise<StoreStats>
  /**
   * The store's clock. Instances stamp entries and invalidations with this (plus an offset) instead
   * of their own `Date.now()`, so a skewed host clock cannot make an invalidation miss an entry.
   */
  time(): Promise<Timestamp>
  /** Remove every entry and tag. */
  flush(): Promise<void>
  close(): Promise<void>
}
