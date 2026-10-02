import { parseArgs } from 'node:util'
import { revalidationUpdate, type CacheStore, decodeValue } from '@cacheforge/core'
import { RedisStore } from '@cacheforge/redis'

const HELP = `cacheforge — inspect and invalidate a shared Next.js cache

Usage: cacheforge <command> [options]

Commands:
  stats                       entry count, bytes and tag count
  ls [--match <text>]         list cached entries (newest first)
  tags                        list tags that have been invalidated
  show <key>                  print one entry's metadata and a preview of its value
  revalidate <tag...>         invalidate tags for every instance
      --expire <seconds>        soft invalidation: keep serving stale for this long
  rm <key>                    delete one entry
  flush --yes                 delete everything under the prefix

Options:
  --redis <url>               Redis URL (default $CACHEFORGE_REDIS or redis://127.0.0.1:6379)
  --prefix <prefix>           key prefix (default $CACHEFORGE_PREFIX or "cacheforge")
  --limit <n>                 rows for ls (default 50)
  --json                      machine-readable output
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    redis: { type: 'string' },
    prefix: { type: 'string' },
    match: { type: 'string' },
    limit: { type: 'string' },
    expire: { type: 'string' },
    json: { type: 'boolean' },
    yes: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [command, ...args] = positionals

function out(data: unknown, human: () => string): void {
  console.log(values.json ? JSON.stringify(data, null, 2) : human())
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

async function run(store: CacheStore): Promise<void> {
  switch (command) {
    case 'stats': {
      const stats = await store.stats()
      return out(stats, () => `entries: ${stats.entries}\nbytes:   ${stats.bytes}\ntags:    ${stats.tags}`)
    }
    case 'ls': {
      const limit = Number(values.limit ?? 50)
      const rows = (await store.list({ match: values.match, limit })).sort(
        (a, b) => b.timestamp - a.timestamp,
      )
      return out(rows, () =>
        rows.length === 0
          ? '(no entries)'
          : rows
              .map((r) => `${ago(r.timestamp).padEnd(9)} ${String(r.bytes).padStart(8)}B  ${r.key}  [${r.tags.join(', ')}]`)
              .join('\n'),
      )
    }
    case 'tags': {
      const states = [...(await store.getAllTagStates())].sort((a, b) => a[0].localeCompare(b[0]))
      return out(Object.fromEntries(states), () =>
        states.length === 0
          ? '(no invalidated tags)'
          : states
              .map(([tag, s]) => {
                const parts = []
                if (s.stale) parts.push(`stale ${ago(s.stale)}`)
                if (s.expired) parts.push(s.expired > Date.now() ? 'expires soon' : `expired ${ago(s.expired)}`)
                return `${tag.padEnd(32)} ${parts.join(', ')}`
              })
              .join('\n'),
      )
    }
    case 'show': {
      const key = args[0]
      if (!key) throw new Error('show needs a key')
      const entry = await store.get(key)
      if (!entry) throw new Error(`no entry for "${key}"`)
      let preview = entry.data.slice(0, 200)
      try {
        preview = JSON.stringify(decodeValue(entry.data)).slice(0, 200)
      } catch {
        // `use cache` payloads are base64 bytes, not JSON; the raw slice is fine.
      }
      return out({ key, ...entry, data: preview }, () =>
        [`key:       ${key}`, `tags:      ${entry.tags.join(', ') || '(none)'}`, `written:   ${ago(entry.timestamp)}`, `size:      ${entry.data.length}B`, `preview:   ${preview}${entry.data.length > 200 ? '…' : ''}`].join('\n'),
      )
    }
    case 'revalidate': {
      if (args.length === 0) throw new Error('revalidate needs at least one tag')
      const durations = values.expire === undefined ? undefined : { expire: Number(values.expire) }
      const update = revalidationUpdate(await store.time(), durations)
      await store.markTags(args, update)
      await store.publish({ type: 'tags', tags: args, update })
      return out({ tags: args, update }, () => `revalidated ${args.join(', ')}${durations ? ' (soft)' : ''}`)
    }
    case 'rm': {
      const key = args[0]
      if (!key) throw new Error('rm needs a key')
      const removed = await store.delete(key)
      if (removed) await store.publish({ type: 'delete', key })
      return out({ removed }, () => (removed ? `deleted ${key}` : `no entry for ${key}`))
    }
    case 'flush': {
      if (!values.yes) throw new Error('flush deletes the whole cache; pass --yes to confirm')
      await store.flush()
      await store.publish({ type: 'flush' })
      return out({ flushed: true }, () => 'flushed')
    }
    default:
      console.log(HELP)
      if (command) process.exitCode = 1
  }
}

if (values.help || !command) {
  console.log(HELP)
} else {
  const store = new RedisStore({
    connection: values.redis ?? process.env.CACHEFORGE_REDIS ?? 'redis://127.0.0.1:6379',
    prefix: values.prefix ?? process.env.CACHEFORGE_PREFIX ?? 'cacheforge',
  })
  try {
    await run(store)
  } catch (error) {
    console.error(`cacheforge: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  } finally {
    await store.close()
  }
}
