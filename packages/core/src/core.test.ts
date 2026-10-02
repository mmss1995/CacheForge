import { describe, expect, it } from 'vitest'
import {
  areTagsExpired,
  areTagsStale,
  decodeValue,
  encodeValue,
  latestExpiration,
  MemoryStore,
  mergeTagState,
  readStream,
  revalidationUpdate,
  streamFrom,
  type TagState,
} from './index.js'

const states = (o: Record<string, TagState>) => new Map(Object.entries(o))

describe('revalidationUpdate', () => {
  it('hard-expires immediately without durations', () => {
    expect(revalidationUpdate(100)).toEqual({ expired: 100 })
  })
  it('marks stale now and expires later with durations', () => {
    expect(revalidationUpdate(100, { expire: 60 })).toEqual({ stale: 100, expired: 60_100 })
    expect(revalidationUpdate(100, {})).toEqual({ stale: 100 })
  })
})

describe('tag rules', () => {
  it('expires entries created before the expiry, only once it has passed', () => {
    const s = states({ a: { expired: 500 } })
    expect(areTagsExpired(['a'], 400, s, 600)).toBe(true)
    expect(areTagsExpired(['a'], 500, s, 600)).toBe(false) // created at the same instant: fresh
    expect(areTagsExpired(['a'], 700, s, 800)).toBe(false) // created after: fresh
    expect(areTagsExpired(['a'], 400, s, 450)).toBe(false) // expiry still in the future
    expect(areTagsExpired(['other'], 400, s, 600)).toBe(false)
  })
  it('flags stale entries', () => {
    const s = states({ a: { stale: 500 } })
    expect(areTagsStale(['a'], 400, s)).toBe(true)
    expect(areTagsStale(['a'], 600, s)).toBe(false)
  })
  it('reports the latest expiration', () => {
    const s = states({ a: { expired: 5 }, b: { expired: 9 }, c: { stale: 99 } })
    expect(latestExpiration(['a', 'b', 'c', 'd'], s)).toBe(9)
    expect(latestExpiration(['d'], s)).toBe(0)
  })
  it('merges monotonically', () => {
    expect(mergeTagState({ stale: 5, expired: 10 }, { stale: 3, expired: 20 })).toEqual({
      stale: 5,
      expired: 20,
    })
    expect(mergeTagState(undefined, { stale: 1 })).toEqual({ stale: 1 })
  })
})

describe('codec', () => {
  it('round-trips Buffers, Maps and nesting', () => {
    const value = {
      kind: 'APP_PAGE',
      html: '<p>ü</p>',
      rscData: Buffer.from([0, 1, 2, 255]),
      segmentData: new Map([['/a', Buffer.from('seg')]]),
      headers: { 'x-next-cache-tags': 'a,b' },
      status: undefined,
    }
    const back = decodeValue<typeof value>(encodeValue(value))
    expect(Buffer.isBuffer(back.rscData)).toBe(true)
    expect(back.rscData).toEqual(value.rscData)
    expect(back.segmentData).toBeInstanceOf(Map)
    expect(back.segmentData.get('/a')?.toString()).toBe('seg')
    expect(back.headers).toEqual(value.headers)
  })
  it('round-trips streams', async () => {
    const bytes = await readStream(streamFrom(new Uint8Array([1, 2, 3])))
    expect([...bytes]).toEqual([1, 2, 3])
  })
})

describe('MemoryStore', () => {
  it('expires entries by TTL using its clock', async () => {
    let now = 0
    const store = new MemoryStore(() => now)
    await store.set('k', { tags: [], timestamp: 0, data: 'x' }, { ttlSeconds: 10 })
    now = 9_999
    expect(await store.get('k')).toBeDefined()
    now = 10_000
    expect(await store.get('k')).toBeUndefined()
  })
  it('keeps tag states monotonic and delivers events asynchronously', async () => {
    const store = new MemoryStore()
    await store.markTags(['t'], { expired: 9 })
    await store.markTags(['t'], { expired: 4 })
    expect((await store.getTagStates(['t'])).get('t')).toEqual({ expired: 9 })

    const seen: unknown[] = []
    await store.subscribe((e) => seen.push(e))
    const published = store.publish({ type: 'flush' })
    expect(seen).toEqual([]) // not delivered synchronously, like a real broker
    await published
    expect(seen).toEqual([{ type: 'flush' }])
  })
})
