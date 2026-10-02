import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RedisStore } from '@cacheforge/redis'

export const REDIS_URL = process.env.CACHEFORGE_TEST_REDIS ?? 'redis://127.0.0.1:6390'
export const REDIS_PORT = Number(new URL(REDIS_URL).port || 6379)
const root = fileURLToPath(new URL('..', import.meta.url))

export interface Instance {
  name: string
  url: string
  stop(): Promise<void>
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const value = await probe()
      if (value !== undefined) return value
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Start `next start` for an already built example. */
export async function startInstance(
  example: 'isr-app' | 'usecache-app',
  name: string,
  port: number,
  prefix: string,
  extraEnv: Record<string, string> = {},
): Promise<Instance> {
  const cwd = `${root}examples/${example}`
  const child: ChildProcess = spawn(
    process.execPath,
    [`${root}node_modules/next/dist/bin/next`, 'start', '-p', String(port)],
    {
      cwd,
      env: { ...process.env, INSTANCE_ID: name, REDIS_URL, CACHE_PREFIX: prefix, NODE_ENV: 'production', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  child.stdout?.on('data', (d) => (log += d))
  child.stderr?.on('data', (d) => (log += d))
  const url = `http://127.0.0.1:${port}`
  try {
    await waitFor(`${name} to listen`, async () => ((await fetch(url)).ok ? true : undefined))
  } catch (error) {
    child.kill()
    throw new Error(`${(error as Error).message}\n${log}`)
  }
  return {
    name,
    url,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    },
  }
}

export async function freshStore(prefix: string): Promise<RedisStore> {
  const store = new RedisStore({ connection: REDIS_URL, prefix })
  await store.flush()
  return store
}

export interface Rendered {
  generatedBy: string
  generation: number
  generatedAt: string
}

export async function read(instance: Instance, path: string): Promise<Rendered> {
  const html = await (await fetch(instance.url + path)).text()
  const pick = (id: string) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]
  const generatedBy = pick('generated-by')
  const generation = pick('generation')
  const generatedAt = pick('generated-at')
  if (!generatedBy || !generation || !generatedAt) throw new Error(`unexpected page from ${instance.name}:\n${html.slice(0, 600)}`)
  return { generatedBy, generation: Number(generation), generatedAt }
}

export async function revalidate(instance: Instance, tag: string, hard: boolean): Promise<void> {
  const res = await fetch(`${instance.url}/api/revalidate?tag=${tag}${hard ? '&hard=true' : ''}`, { method: 'POST' })
  if (!res.ok) throw new Error(`revalidate failed: ${res.status}`)
}

/** Poll until `probe` returns something other than `undefined`. */
export const eventually = waitFor

/** A TCP proxy in front of Redis that can be cut and restored, to simulate an outage. */
export async function createProxy(targetPort: number, listenPort: number) {
  const { createServer, connect } = await import('node:net')
  const sockets = new Set<import('node:net').Socket>()
  let server: import('node:net').Server | undefined

  const listen = () =>
    new Promise<void>((resolve) => {
      server = createServer((client) => {
        const upstream = connect(targetPort, '127.0.0.1')
        for (const s of [client, upstream]) {
          sockets.add(s)
          s.on('close', () => sockets.delete(s))
          s.on('error', () => s.destroy())
        }
        client.pipe(upstream)
        upstream.pipe(client)
      })
      server.listen(listenPort, '127.0.0.1', resolve)
    })
  await listen()
  return {
    url: `redis://127.0.0.1:${listenPort}`,
    /** Drop every connection and refuse new ones. */
    async cut() {
      // Destroy first: server.close() waits for open connections to end.
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    },
    async restore() {
      await listen()
    },
    async stop() {
      await this.cut()
    },
  }
}
