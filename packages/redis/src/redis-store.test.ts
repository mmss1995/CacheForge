import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { StoredEntry } from '@cacheforge/core'
import { RedisStore } from './redis-store.js'

// Needs a real Redis: `docker run -d -p 6390:6379 redis:7-alpine`, or set CACHEFORGE_TEST_REDIS.
const url = process.env.CACHEFORGE_TEST_REDIS ?? 'redis://127.0.0.1:6390'

async function reachable(): Promise<boolean> {
  const probe = new RedisStore({ connection: { host: '127.0.0.1', port: 6390, lazyConnect: true } })
  try {
    await probe.stats()
    return true
  } catch {
    return false
  } finally {
    await probe.close()
  }
}

const available = process.env.CACHEFORGE_TEST_REDIS ? true : await reachable()

const entry = (data = 'x'): StoredEntry => ({ tags: ['a'], timestamp: 1_000, data })

describe.skipIf(!available)('RedisStore', () => {
  const prefix = `cf-test-${process.pid}`
  const store = new RedisStore({ connection: url, prefix })
  const other = new RedisStore({ connection: url, prefix })

  beforeAll(() => store.flush())
  beforeEach(() => store.flush())
  afterAll(async () => {
    await store.flush()
    await store.close()
    await other.close()
  })

  it('round-trips entries across two clients', async () => {
    await store.set('k', entry('hello'))
    expect(await other.get('k')).toEqual(entry('hello'))
    expect(await store.get('missing')).toBeUndefined()
  })

  it('honours the per-entry TTL', async () => {
    await store.set('k', entry(), { ttlSeconds: 1 })
    expect(await store.get('k')).toBeDefined()
    await new Promise((r) => setTimeout(r, 1200))
    expect(await store.get('k')).toBeUndefined()
  })

  it('deletes', async () => {
    await store.set('k', entry())
    expect(await store.delete('k')).toBe(true)
    expect(await store.delete('k')).toBe(false)
  })

  it('keeps tag timestamps monotonic', async () => {
    await store.markTags(['t'], { expired: 500 })
    await store.markTags(['t'], { expired: 300 })
    await store.markTags(['t'], { stale: 400 })
    expect((await other.getTagStates(['t', 'untouched'])).get('t')).toEqual({
      stale: 400,
      expired: 500,
    })
    expect((await other.getTagStates(['untouched'])).size).toBe(0)
  })

  it('lists everything with getAllTagStates', async () => {
    await store.markTags(['a', 'b'], { expired: 10 })
    await store.markTags(['b'], { stale: 20 })
    const all = await other.getAllTagStates()
    expect(all.get('a')).toEqual({ expired: 10 })
    expect(all.get('b')).toEqual({ stale: 20, expired: 10 })
  })

  it('delivers events to subscribers on other clients', async () => {
    const received: unknown[] = []
    const off = await other.subscribe((event) => received.push(event))
    await store.publish({ type: 'tags', tags: ['a'], update: { expired: 5 } })
    await new Promise((r) => setTimeout(r, 100))
    off()
    expect(received).toEqual([{ type: 'tags', tags: ['a'], update: { expired: 5 } }])
  })

  it('reports the server clock', async () => {
    expect(Math.abs((await store.time()) - Date.now())).toBeLessThan(5_000)
  })

  it('lists and counts entries, and flushes them', async () => {
    await store.set('page:/a', entry('1'))
    await store.set('page:/b', entry('22'))
    expect((await store.list({ match: '/a' })).map((e) => e.key)).toEqual(['page:/a'])
    expect((await store.stats()).entries).toBe(2)
    await store.flush()
    expect((await store.stats()).entries).toBe(0)
  })
})
