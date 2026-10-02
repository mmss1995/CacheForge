import { mergeTagState } from './tags.js'
import type {
  CacheEvent,
  CacheStore,
  EntryInfo,
  SetOptions,
  StoredEntry,
  StoreStats,
  TagState,
} from './types.js'

interface Slot {
  entry: StoredEntry
  expiresAt: number | undefined
}

/**
 * In-process store. It is the reference implementation of {@link CacheStore}, what the tests and the
 * local dev server use, and what several handler instances share in a test to simulate a cluster.
 */
export class MemoryStore implements CacheStore {
  private readonly slots = new Map<string, Slot>()
  private readonly tags = new Map<string, TagState>()
  private readonly listeners = new Set<(event: CacheEvent) => void>()

  constructor(private readonly clock: () => number = Date.now) {}

  async get(key: string): Promise<StoredEntry | undefined> {
    const slot = this.slots.get(key)
    if (!slot) return undefined
    if (slot.expiresAt !== undefined && slot.expiresAt <= this.clock()) {
      this.slots.delete(key)
      return undefined
    }
    return slot.entry
  }

  async set(key: string, entry: StoredEntry, options?: SetOptions): Promise<void> {
    const expiresAt =
      options?.ttlSeconds === undefined ? undefined : this.clock() + options.ttlSeconds * 1000
    this.slots.set(key, { entry, expiresAt })
  }

  async delete(key: string): Promise<boolean> {
    return this.slots.delete(key)
  }

  async getTagStates(tags: readonly string[]): Promise<Map<string, TagState>> {
    const out = new Map<string, TagState>()
    for (const tag of tags) {
      const state = this.tags.get(tag)
      if (state) out.set(tag, { ...state })
    }
    return out
  }

  async getAllTagStates(): Promise<Map<string, TagState>> {
    return new Map([...this.tags].map(([tag, state]) => [tag, { ...state }]))
  }

  async markTags(tags: readonly string[], update: TagState): Promise<void> {
    for (const tag of tags) this.tags.set(tag, mergeTagState(this.tags.get(tag), update))
  }

  async subscribe(listener: (event: CacheEvent) => void): Promise<() => void> {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  async publish(event: CacheEvent): Promise<void> {
    // Real pub/sub is asynchronous; keep that so tests do not depend on synchronous delivery.
    queueMicrotask(() => {
      for (const listener of this.listeners) listener(event)
    })
  }

  async list(options?: { match?: string; limit?: number }): Promise<EntryInfo[]> {
    const out: EntryInfo[] = []
    const limit = options?.limit ?? Infinity
    for (const [key, slot] of this.slots) {
      if (out.length >= limit) break
      if (options?.match && !key.includes(options.match)) continue
      out.push({
        key,
        tags: slot.entry.tags,
        timestamp: slot.entry.timestamp,
        bytes: slot.entry.data.length,
      })
    }
    return out
  }

  async stats(): Promise<StoreStats> {
    let bytes = 0
    for (const slot of this.slots.values()) bytes += slot.entry.data.length
    return { entries: this.slots.size, bytes, tags: this.tags.size }
  }

  async time(): Promise<number> {
    return this.clock()
  }

  async flush(): Promise<void> {
    this.slots.clear()
    this.tags.clear()
  }

  async close(): Promise<void> {
    this.listeners.clear()
  }
}
