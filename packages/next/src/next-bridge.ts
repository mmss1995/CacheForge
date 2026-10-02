import { createRequire } from 'node:module'
import type { TagState } from '@cacheforge/core'

type NextTagsManifest = Map<string, { stale?: number; expired?: number }>

/**
 * Next's `IncrementalCache.get` re-checks tags itself, against a process-global manifest that only
 * its built-in handlers fill. A custom handler has to fill it too, or soft invalidations
 * (`revalidateTag(tag, 'max')`, i.e. stale-while-revalidate) never take effect on ISR pages and
 * `fetch`/`unstable_cache` data. This module is internal to Next and not public API, so the bridge
 * is best effort: if it cannot be loaded, the handlers still enforce hard expiry themselves.
 */
export function loadNextTagsManifest(): NextTagsManifest | undefined {
  const specifier = 'next/dist/server/lib/incremental-cache/tags-manifest.external'
  for (const from of [import.meta.url, `file://${process.cwd()}/package.json`]) {
    try {
      const manifest = createRequire(from)(specifier).tagsManifest as unknown
      if (manifest instanceof Map) return manifest as NextTagsManifest
    } catch {
      // try the next resolution root
    }
  }
  return undefined
}

/** Write a tag state into Next's manifest, never moving a timestamp backwards. */
export function mirrorIntoNext(
  manifest: NextTagsManifest,
  tag: string,
  state: TagState,
  toLocal: (clusterTime: number) => number,
): void {
  const existing = manifest.get(tag) ?? {}
  const next = { ...existing }
  if (state.stale !== undefined) next.stale = Math.max(existing.stale ?? 0, toLocal(state.stale))
  if (state.expired !== undefined) next.expired = Math.max(existing.expired ?? 0, toLocal(state.expired))
  manifest.set(tag, next)
}
