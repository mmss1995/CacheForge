import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RedisStore } from '@cacheforge/redis'
import { eventually, freshStore, read, revalidate, startInstance, type Instance } from './harness.js'

const prefix = `cf-e2e-uc-${process.pid}`

describe("two Next.js instances sharing one cache ('use cache' cacheHandlers)", () => {
  let store: RedisStore
  let a: Instance
  let b: Instance

  beforeAll(async () => {
    store = await freshStore(prefix)
    ;[a, b] = await Promise.all([
      startInstance('usecache-app', 'instance-a', 3211, prefix),
      startInstance('usecache-app', 'instance-b', 3212, prefix),
    ])
  })
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
    await store?.flush()
    await store?.close()
  })

  it("shares a 'use cache: remote' result between instances", async () => {
    const first = await read(a, '/products')
    const second = await read(b, '/products')
    expect(second.generatedBy).toBe(first.generatedBy)
    expect(second.generation).toBe(first.generation)
  })

  it('hard revalidation on one instance reaches the other', async () => {
    const before = await read(a, '/products')
    await revalidate(b, 'products', true)
    const after = await eventually('instance A to regenerate', async () => {
      const page = await read(a, '/products')
      return page.generatedAt !== before.generatedAt ? page : undefined
    })
    expect((await read(b, '/products')).generatedAt).toBe(after.generatedAt)
  })
})

describe("control: the same app on Next's built-in per-process cache", () => {
  let a: Instance
  let b: Instance

  beforeAll(async () => {
    const env = { CACHEFORGE: 'off' }
    ;[a, b] = await Promise.all([
      startInstance('usecache-app', 'plain-a', 3213, `${prefix}-off`, env),
      startInstance('usecache-app', 'plain-b', 3214, `${prefix}-off`, env),
    ])
  })
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
  })

  it("shows the problem: 'use cache' results are per instance and invalidation stays local", async () => {
    const pageA = await read(a, '/products')
    const pageB = await read(b, '/products')
    expect(pageA.generatedBy).toBe('plain-a')
    expect(pageB.generatedBy).toBe('plain-b')
    await revalidate(a, 'products', true)
    await eventually('A to regenerate', async () => {
      const page = await read(a, '/products')
      return page.generatedAt !== pageA.generatedAt ? page : undefined
    })
    expect((await read(b, '/products')).generatedAt).toBe(pageB.generatedAt)
  })
})
