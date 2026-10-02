import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, readStream, streamFrom } from '@cacheforge/core'
import { createTestCluster } from './cluster.js'
import type { UseCacheEntry } from './use-cache.js'

const settle = () => new Promise((r) => setTimeout(r, 10))
// Next's rule is `expired > entry.timestamp`: an invalidation in the same millisecond as the write
// does not count, so tests that invalidate right after a write step the clock first.
const tick = () => new Promise((r) => setTimeout(r, 3))
const text = async (stream: ReadableStream<Uint8Array>) =>
  new TextDecoder().decode(await readStream(stream))

const page = (html: string, tags = 'posts,post:1') => ({
  kind: 'APP_PAGE',
  html,
  rscData: Buffer.from('rsc:' + html),
  segmentData: new Map([['/', Buffer.from('seg')]]),
  headers: { 'x-next-cache-tags': tags },
  status: 200,
  postponed: undefined,
})
const fetchValue = (body: string, tags: string[]) => ({
  kind: 'FETCH',
  data: { headers: {}, body, url: 'https://api/x', status: 200 },
  tags,
  revalidate: 60,
})

afterEach(() => vi.useRealTimers())

describe('legacy cacheHandler (ISR pages, fetch cache)', () => {
  it('shares pages between instances, with Buffers and Maps intact', async () => {
    const { instances } = createTestCluster(2)
    const [a, b] = instances.map((i) => new i.legacy({ revalidatedTags: [] }))
    await a!.set('/posts', page('<h1>v1</h1>'), {})

    const hit = await b!.get('/posts', { kind: 'APP_PAGE' })
    expect(hit?.value).toMatchObject({ kind: 'APP_PAGE', html: '<h1>v1</h1>' })
    const value = hit!.value!
    expect(Buffer.isBuffer(value.rscData)).toBe(true)
    expect((value.segmentData as Map<string, Buffer>).get('/')?.toString()).toBe('seg')
    expect(await b!.get('/missing', { kind: 'APP_PAGE' })).toBeNull()
  })

  it('revalidateTag on one instance expires pages on the others', async () => {
    const { instances } = createTestCluster(2)
    const [a, b] = instances.map((i) => new i.legacy({ revalidatedTags: [] }))
    await a!.set('/posts', page('v1'), {})
    await a!.set('/about', page('about', 'about'), {})
    await settle()

    await b!.revalidateTag('posts')
    expect(await a!.get('/posts', { kind: 'APP_PAGE' })).toBeNull()
    expect(await b!.get('/posts', { kind: 'APP_PAGE' })).toBeNull()
    expect(await a!.get('/about', { kind: 'APP_PAGE' })).not.toBeNull()
  })

  it('serves a page regenerated after the invalidation', async () => {
    const { instances } = createTestCluster(2)
    const [a, b] = instances.map((i) => new i.legacy({ revalidatedTags: [] }))
    await a!.set('/posts', page('v1'), {})
    await b!.revalidateTag('posts')
    await new Promise((r) => setTimeout(r, 5))
    await a!.set('/posts', page('v2'), {})
    expect((await b!.get('/posts', { kind: 'APP_PAGE' }))?.value).toMatchObject({ html: 'v2' })
  })

  it('invalidates fetch entries through the tags of the call, soft tags included', async () => {
    const { instances } = createTestCluster(2)
    const [a, b] = instances.map((i) => new i.legacy({ revalidatedTags: [] }))
    await a!.set('f1', fetchValue('{}', ['user:7']), { fetchCache: true, tags: ['user:7'] })
    expect(await b!.get('f1', { kind: 'FETCH', tags: ['user:7'] })).not.toBeNull()

    await tick()
    await a!.revalidateTag(['_N_T_/dashboard'])
    expect(await b!.get('f1', { kind: 'FETCH', tags: ['user:7'], softTags: ['_N_T_/dashboard'] })).toBeNull()
    expect(await b!.get('f1', { kind: 'FETCH', tags: ['user:7'] })).not.toBeNull()
  })

  it('does not serve a tag revalidated earlier in the same request', async () => {
    const { instances } = createTestCluster(1)
    const handler = new instances[0]!.legacy({ revalidatedTags: ['user:7'] })
    await handler.set('f1', fetchValue('{}', ['user:7']), { fetchCache: true, tags: ['user:7'] })
    expect(await handler.get('f1', { kind: 'FETCH', tags: ['user:7'] })).toBeNull()
  })

  it('treats a null value as deletion', async () => {
    const { instances } = createTestCluster(1)
    const h = new instances[0]!.legacy({})
    await h.set('/p', page('x'), {})
    await h.set('/p', null, {})
    expect(await h.get('/p', { kind: 'APP_PAGE' })).toBeNull()
  })

  it('is not fooled by hosts whose clocks disagree', async () => {
    // B's clock runs 30 s ahead of A's. With raw Date.now() stamps, A's invalidation would look
    // older than B's page and be ignored.
    const { instances } = createTestCluster(2, { skewsMs: [0, 30_000] })
    const [a, b] = instances.map((i) => new i.legacy({ revalidatedTags: [] }))
    await a!.get('warmup', { kind: 'APP_PAGE' }) // starts A's clock sync
    await b!.get('warmup', { kind: 'APP_PAGE' })
    await b!.set('/posts', page('from-b'), {})
    await settle()
    await a!.revalidateTag('posts')
    expect(await b!.get('/posts', { kind: 'APP_PAGE' })).toBeNull()
  })

  it('degrades to misses when the store is down, but refuses to hide a failed invalidation', async () => {
    const store = new MemoryStore()
    const onError = vi.fn()
    const { instances } = createTestCluster(1, { shared: store, onError })
    const h = new instances[0]!.legacy({})
    await h.set('/p', page('x'), {})

    vi.spyOn(store, 'get').mockRejectedValue(new Error('ECONNRESET'))
    expect(await h.get('/p', { kind: 'APP_PAGE' })).toBeNull()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'get')

    vi.spyOn(store, 'markTags').mockRejectedValue(new Error('ECONNRESET'))
    await expect(h.revalidateTag('posts')).rejects.toThrow('ECONNRESET')
  })

  it('in strong mode sees invalidations that never arrived over pub/sub', async () => {
    const store = new MemoryStore()
    const { instances } = createTestCluster(2, { shared: store, consistency: 'strong' })
    const [a, b] = instances.map((i) => new i.legacy({}))
    await a!.set('/p', page('v1'), {})
    await store.markTags(['posts'], { expired: Date.now() + 1 }) // written behind the handlers' backs
    await new Promise((r) => setTimeout(r, 5))
    expect(await b!.get('/p', { kind: 'APP_PAGE' })).toBeNull()
  })
})

describe("'use cache' cacheHandlers", () => {
  const entry = (body: string, over: Partial<UseCacheEntry> = {}): UseCacheEntry => ({
    value: streamFrom(new TextEncoder().encode(body)),
    tags: ['products'],
    stale: 30,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 600,
    ...over,
  })

  it('shares entries between instances and leaves the producer a readable stream', async () => {
    const { instances } = createTestCluster(2)
    const [a, b] = instances.map((i) => i.useCache)
    const mine = entry('hello')
    await a!.set('k', Promise.resolve(mine))
    expect(await text(mine.value)).toBe('hello')

    const hit = await b!.get('k', [])
    expect(hit && (await text(hit.value))).toBe('hello')
    expect(hit).toMatchObject({ tags: ['products'], stale: 30, expire: 3600, revalidate: 600 })
  })

  it('makes a get wait for the set that is still producing its entry', async () => {
    const { instances } = createTestCluster(1)
    const h = instances[0]!.useCache
    let release!: (e: UseCacheEntry) => void
    const set = h.set('k', new Promise<UseCacheEntry>((r) => (release = r)))
    const get = h.get('k', [])
    release(entry('late'))
    await set
    const hit = await get
    expect(hit && (await text(hit.value))).toBe('late')
  })

  it('hard revalidation drops entries on every instance, via getExpiration and get', async () => {
    const { instances } = createTestCluster(2)
    const [a, b] = instances.map((i) => i.useCache)
    await a!.set('k', Promise.resolve(entry('v1')))
    expect(await b!.getExpiration(['products'])).toBe(0)

    await tick()
    await b!.updateTags(['products'])
    await settle()
    expect(await a!.get('k', [])).toBeUndefined()
    expect(await a!.getExpiration(['products'])).toBeGreaterThan(0)
  })

  it('soft revalidation keeps serving but asks Next to refresh (revalidate -1)', async () => {
    const { instances } = createTestCluster(2)
    const [a, b] = instances.map((i) => i.useCache)
    await a!.set('k', Promise.resolve(entry('v1')))
    await tick()
    await b!.updateTags(['products'], { expire: 300 })
    await settle()
    const hit = await a!.get('k', [])
    expect(hit?.revalidate).toBe(-1)
    expect(hit && (await text(hit.value))).toBe('v1')
  })

  it('does not store dynamic (expire 0) entries', async () => {
    const { instances, store } = createTestCluster(1)
    await instances[0]!.useCache.set('k', Promise.resolve(entry('x', { expire: 0 })))
    expect((await store.stats()).entries).toBe(0)
  })

  it('stops serving an entry once its revalidate time has passed', async () => {
    const { instances } = createTestCluster(1)
    const h = instances[0]!.useCache
    await h.set('k', Promise.resolve(entry('x', { revalidate: 1, timestamp: Date.now() - 5_000 })))
    expect(await h.get('k', [])).toBeUndefined()
  })

  it('reports expirations in the local clock of a skewed host', async () => {
    const { instances } = createTestCluster(2, { skewsMs: [0, 20_000] })
    const [a, b] = instances.map((i) => i.useCache)
    await a!.getExpiration([]) // start clocks
    await b!.getExpiration([])
    await a!.updateTags(['products'])
    await settle()
    // b's local clock is ~20 s ahead, so the same moment is ~20 s later on its timeline.
    const onA = await a!.getExpiration(['products'])
    const onB = await b!.getExpiration(['products'])
    expect(onB - onA).toBeGreaterThan(19_000)
    expect(onB - onA).toBeLessThan(21_000)
  })
})

describe('a slow or dead store', () => {
  const hangs = () => new Promise<never>(() => {})

  it('costs a read at most the timeout, then the breaker skips the store entirely', async () => {
    const store = new MemoryStore()
    const onError = vi.fn()
    const { instances } = createTestCluster(1, {
      shared: store,
      onError,
      timeoutMs: 20,
      breaker: { failures: 2, cooldownMs: 80 },
    })
    const h = new instances[0]!.legacy({})
    const get = vi.spyOn(store, 'get').mockImplementation(hangs)

    const started = Date.now()
    expect(await h.get('/p', { kind: 'APP_PAGE' })).toBeNull()
    expect(await h.get('/p', { kind: 'APP_PAGE' })).toBeNull()
    expect(Date.now() - started).toBeLessThan(500)
    expect(get).toHaveBeenCalledTimes(2)
    expect(instances[0]!.legacy.runtime.degraded).toBe(true)

    // Breaker open: instant misses, the store is not touched.
    const t = Date.now()
    expect(await h.get('/p', { kind: 'APP_PAGE' })).toBeNull()
    expect(Date.now() - t).toBeLessThan(10)
    expect(get).toHaveBeenCalledTimes(2)

    // After the cooldown one successful call closes it again.
    await new Promise((r) => setTimeout(r, 100))
    get.mockRestore()
    await h.set('/p', page('x'), {})
    expect(await h.get('/p', { kind: 'APP_PAGE' })).not.toBeNull()
    expect(instances[0]!.legacy.runtime.degraded).toBe(false)
  })

  it('still lets an invalidation fail loudly instead of hanging', async () => {
    const store = new MemoryStore()
    const { instances } = createTestCluster(1, { shared: store, timeoutMs: 20 })
    vi.spyOn(store, 'markTags').mockImplementation(hangs)
    await expect(instances[0]!.useCache.updateTags(['t'])).rejects.toThrow(/timed out/)
  }, 10_000)
})
