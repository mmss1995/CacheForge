import type {
  CacheEvent,
  CacheStore,
  EntryInfo,
  SetOptions,
  StoredEntry,
  StoreStats,
  TagState,
} from '@cacheforge/core'
import { Redis, type RedisOptions } from 'ioredis'

export interface RedisStoreOptions {
  /** `redis://…` URL, or an options object for ioredis. */
  connection: string | RedisOptions
  /** Key prefix. Give each app (or each build you do not want to share) its own. */
  prefix?: string
  /** Applied to entries stored without their own TTL, so a forgotten cache cannot grow forever. */
  defaultTtlSeconds?: number
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30

// Monotonic write: only move a tag's timestamp forward. Concurrent invalidations from several
// instances therefore can never roll each other back.
const MAX_SET = `
local changed = 0
for i = 2, #ARGV do
  local current = tonumber(redis.call('HGET', KEYS[1], ARGV[i]))
  if not current or current < tonumber(ARGV[1]) then
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[1])
    changed = changed + 1
  end
end
return changed
`

/** Redis-backed {@link CacheStore}. Every instance pointing at the same prefix shares one cache. */
export class RedisStore implements CacheStore {
  private readonly redis: Redis
  private readonly prefix: string
  private readonly defaultTtl: number
  private subscriber: Redis | undefined
  private readonly listeners = new Set<(event: CacheEvent) => void>()
  private subscribing: Promise<void> | undefined

  constructor(options: RedisStoreOptions) {
    // Fail fast and reconnect with a capped backoff: the cache must never be what hangs a request.
    const resilient: RedisOptions = {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    }
    this.redis =
      typeof options.connection === 'string'
        ? new Redis(options.connection, resilient)
        : new Redis({ ...resilient, ...options.connection })
    this.prefix = options.prefix ?? 'cacheforge'
    this.defaultTtl = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS
    this.redis.defineCommand('cfMaxSet', { numberOfKeys: 1, lua: MAX_SET })
    // Without a listener ioredis would crash the process on a connection error.
    this.redis.on('error', () => {})
  }

  private entryKey(key: string): string {
    return `${this.prefix}:e:${key}`
  }
  private get staleKey(): string {
    return `${this.prefix}:tag:stale`
  }
  private get expiredKey(): string {
    return `${this.prefix}:tag:expired`
  }
  private get channel(): string {
    return `${this.prefix}:events`
  }

  async get(key: string): Promise<StoredEntry | undefined> {
    const raw = await this.redis.get(this.entryKey(key))
    return raw ? (JSON.parse(raw) as StoredEntry) : undefined
  }

  async set(key: string, entry: StoredEntry, options?: SetOptions): Promise<void> {
    const ttl = Math.max(1, Math.ceil(options?.ttlSeconds ?? this.defaultTtl))
    await this.redis.set(this.entryKey(key), JSON.stringify(entry), 'EX', ttl)
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.del(this.entryKey(key))) > 0
  }

  async getTagStates(tags: readonly string[]): Promise<Map<string, TagState>> {
    const out = new Map<string, TagState>()
    if (tags.length === 0) return out
    const unique = [...new Set(tags)]
    const [stale, expired] = await Promise.all([
      this.redis.hmget(this.staleKey, ...unique),
      this.redis.hmget(this.expiredKey, ...unique),
    ])
    unique.forEach((tag, i) => {
      const state = toState(stale[i], expired[i])
      if (state) out.set(tag, state)
    })
    return out
  }

  async getAllTagStates(): Promise<Map<string, TagState>> {
    const [stale, expired] = await Promise.all([
      this.redis.hgetall(this.staleKey),
      this.redis.hgetall(this.expiredKey),
    ])
    const out = new Map<string, TagState>()
    for (const tag of new Set([...Object.keys(stale), ...Object.keys(expired)])) {
      const state = toState(stale[tag], expired[tag])
      if (state) out.set(tag, state)
    }
    return out
  }

  async markTags(tags: readonly string[], update: TagState): Promise<void> {
    if (tags.length === 0) return
    const unique = [...new Set(tags)]
    const run = this.redis as unknown as {
      cfMaxSet(key: string, ...args: (string | number)[]): Promise<number>
    }
    const writes: Promise<number>[] = []
    if (update.stale !== undefined) writes.push(run.cfMaxSet(this.staleKey, update.stale, ...unique))
    if (update.expired !== undefined) {
      writes.push(run.cfMaxSet(this.expiredKey, update.expired, ...unique))
    }
    await Promise.all(writes)
  }

  async subscribe(listener: (event: CacheEvent) => void): Promise<() => void> {
    this.listeners.add(listener)
    this.subscribing ??= this.startSubscriber()
    await this.subscribing
    return () => void this.listeners.delete(listener)
  }

  private async startSubscriber(): Promise<void> {
    const subscriber = this.redis.duplicate()
    subscriber.on('error', () => {})
    subscriber.on('message', (_channel, message) => {
      let event: CacheEvent
      try {
        event = JSON.parse(message) as CacheEvent
      } catch {
        return
      }
      for (const listener of this.listeners) listener(event)
    })
    this.subscriber = subscriber
    await subscriber.subscribe(this.channel)
  }

  async publish(event: CacheEvent): Promise<void> {
    await this.redis.publish(this.channel, JSON.stringify(event))
  }

  async list(options?: { match?: string; limit?: number }): Promise<EntryInfo[]> {
    const limit = options?.limit ?? 100
    const pattern = `${this.entryKey('')}*${options?.match ?? ''}*`
    const out: EntryInfo[] = []
    for await (const keys of this.redis.scanStream({ match: pattern, count: 200 })) {
      for (const redisKey of keys as string[]) {
        if (out.length >= limit) return out
        const raw = await this.redis.get(redisKey)
        if (!raw) continue
        const entry = JSON.parse(raw) as StoredEntry
        out.push({
          key: redisKey.slice(this.entryKey('').length),
          tags: entry.tags,
          timestamp: entry.timestamp,
          bytes: Buffer.byteLength(raw),
        })
      }
    }
    return out
  }

  async stats(): Promise<StoreStats> {
    let entries = 0
    let bytes = 0
    for await (const keys of this.redis.scanStream({ match: `${this.entryKey('')}*`, count: 500 })) {
      for (const redisKey of keys as string[]) {
        entries++
        bytes += (await this.redis.strlen(redisKey)) || 0
      }
    }
    const tags = new Set([
      ...(await this.redis.hkeys(this.staleKey)),
      ...(await this.redis.hkeys(this.expiredKey)),
    ])
    return { entries, bytes, tags: tags.size }
  }

  async time(): Promise<number> {
    const [seconds, micros] = await this.redis.time()
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)
  }

  async flush(): Promise<void> {
    const keys: string[] = [this.staleKey, this.expiredKey]
    for await (const batch of this.redis.scanStream({ match: `${this.entryKey('')}*`, count: 500 })) {
      keys.push(...(batch as string[]))
    }
    for (let i = 0; i < keys.length; i += 500) await this.redis.del(...keys.slice(i, i + 500))
  }

  async close(): Promise<void> {
    this.listeners.clear()
    this.subscriber?.disconnect()
    this.redis.disconnect()
  }
}

function toState(stale: string | null | undefined, expired: string | null | undefined) {
  if (stale == null && expired == null) return undefined
  const state: TagState = {}
  if (stale != null) state.stale = Number(stale)
  if (expired != null) state.expired = Number(expired)
  return state
}
