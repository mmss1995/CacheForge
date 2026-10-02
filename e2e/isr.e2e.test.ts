import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RedisStore } from '@cacheforge/redis'
import { eventually, freshStore, read, revalidate, startInstance, type Instance } from './harness.js'

const prefix = `cf-e2e-isr-${process.pid}`

describe('two Next.js instances sharing one cache (legacy cacheHandler: ISR + unstable_cache)', () => {
  let store: RedisStore
  let a: Instance
  let b: Instance

  beforeAll(async () => {
    store = await freshStore(prefix)
    ;[a, b] = await Promise.all([
      startInstance('isr-app', 'instance-a', 3201, prefix),
      startInstance('isr-app', 'instance-b', 3202, prefix),
    ])
  })
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
    await store?.flush()
    await store?.close()
  })

  it('serves what one instance rendered from the other, without regenerating', async () => {
    const first = await read(a, '/posts')
    const second = await read(b, '/posts')
    // Rendered at runtime by one of the two (not the build's copy), and the other reused it.
    expect(['instance-a', 'instance-b']).toContain(first.generatedBy)
    expect(second.generatedBy).toBe(first.generatedBy)
    expect(second.generatedAt).toBe(first.generatedAt)
    expect((await store.stats()).entries).toBeGreaterThan(0)
  })

  it('hard revalidation on one instance is visible on the other', async () => {
    const before = await read(b, '/posts')
    await revalidate(a, 'posts', true)
    const after = await eventually('instance B to serve fresh content', async () => {
      const page = await read(b, '/posts')
      return page.generatedAt !== before.generatedAt ? page : undefined
    })
    expect(after.generatedAt > before.generatedAt).toBe(true)
    // Both instances agree again.
    expect((await read(a, '/posts')).generatedAt).toBe(after.generatedAt)
  })

  it('soft revalidation (stale-while-revalidate) converges on fresh content everywhere', async () => {
    const before = await read(a, '/posts')
    await revalidate(b, 'posts', false)
    const after = await eventually('instance A to serve refreshed content', async () => {
      const page = await read(a, '/posts')
      return page.generatedAt !== before.generatedAt ? page : undefined
    })
    expect((await read(b, '/posts')).generatedAt).toBe(after.generatedAt)
  })
})

describe("control: the same app on Next's built-in per-process cache", () => {
  let a: Instance
  let b: Instance

  beforeAll(async () => {
    const env = { CACHEFORGE: 'off' }
    ;[a, b] = await Promise.all([
      startInstance('isr-app', 'plain-a', 3203, `${prefix}-off`, env),
      startInstance('isr-app', 'plain-b', 3204, `${prefix}-off`, env),
    ])
  })
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
  })

  // Both processes here read the same .next directory, which flatters Next: on separate hosts or
  // containers they would also disagree about what is cached in the first place.
  it('shows the problem CacheForge fixes: an invalidation stays on the instance that got it', async () => {
    const seenByB = await read(b, '/posts')
    await revalidate(a, 'posts', true)
    const regenerated = await eventually('A to regenerate', async () => {
      const page = await read(a, '/posts')
      return page.generatedAt !== seenByB.generatedAt ? page : undefined
    })
    expect(regenerated.generatedAt > seenByB.generatedAt).toBe(true)
    // B was never told: it keeps serving the pre-invalidation page.
    expect((await read(b, '/posts')).generatedAt).toBe(seenByB.generatedAt)
  })
})

describe("why the Next manifest bridge exists (CACHEFORGE_BRIDGE=off)", () => {
  let a: Instance
  let b: Instance

  beforeAll(async () => {
    const env = { CACHEFORGE_BRIDGE: 'off' }
    ;[a, b] = await Promise.all([
      startInstance('isr-app', 'nobridge-a', 3205, `${prefix}-nobridge`, env),
      startInstance('isr-app', 'nobridge-b', 3206, `${prefix}-nobridge`, env),
    ])
  })
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
    const store = await freshStore(`${prefix}-nobridge`)
    await store.close()
  })

  it('soft revalidation never lands, because Next never learns the tag went stale', async () => {
    const before = await read(a, '/posts')
    await new Promise((r) => setTimeout(r, 20))
    await revalidate(b, 'posts', false)
    await new Promise((r) => setTimeout(r, 1500))
    expect((await read(a, '/posts')).generatedAt).toBe(before.generatedAt)
    expect((await read(b, '/posts')).generatedAt).toBe(before.generatedAt)
  })
})
