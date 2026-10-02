import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createProxy,
  eventually,
  freshStore,
  read,
  REDIS_PORT,
  startInstance,
  type Instance,
} from './harness.js'

const prefix = `cf-e2e-outage-${process.pid}`

describe('when Redis goes away', () => {
  let proxy: Awaited<ReturnType<typeof createProxy>>
  let a: Instance
  let b: Instance

  beforeAll(async () => {
    await (await freshStore(prefix)).close()
    proxy = await createProxy(REDIS_PORT, 6391)
    const env = { REDIS_URL: proxy.url }
    ;[a, b] = await Promise.all([
      startInstance('isr-app', 'outage-a', 3271, prefix, env),
      startInstance('isr-app', 'outage-b', 3272, prefix, env),
    ])
  })
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
    await proxy?.stop()
    const store = await freshStore(prefix)
    await store.close()
  })

  it('keeps serving pages from the origin, quickly, and recovers sharing afterwards', async () => {
    const shared = await read(a, '/posts')
    expect((await read(b, '/posts')).generatedAt).toBe(shared.generatedAt)

    await proxy.cut()
    // Every request still succeeds, and none of them waits on the dead store for long.
    for (let i = 0; i < 6; i++) {
      const started = Date.now()
      const page = await read(i % 2 ? a : b, '/posts')
      expect(page.generatedAt).toBeTruthy()
      expect(Date.now() - started).toBeLessThan(3_000)
    }

    await proxy.restore()
    // The breaker closes after its cooldown, and the instances agree through Redis again.
    await eventually(
      'instances to share the cache again',
      async () => {
        const [pa, pb] = [await read(a, '/posts'), await read(b, '/posts')]
        return pa.generatedAt === pb.generatedAt ? pa : undefined
      },
      40_000,
    )
  })
})

describe('when Redis is already down at boot', () => {
  let app: Instance

  beforeAll(async () => {
    app = await startInstance('isr-app', 'orphan', 3273, `${prefix}-boot`, { REDIS_URL: 'redis://127.0.0.1:6399' })
  })
  afterAll(() => app?.stop())

  it('still answers every request promptly', async () => {
    for (let i = 0; i < 4; i++) {
      const started = Date.now()
      expect((await read(app, '/posts')).generatedBy).toBe('orphan')
      expect(Date.now() - started).toBeLessThan(3_000)
    }
  })
})
