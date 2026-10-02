import type { TagState, Timestamp } from './types.js'

/** What `revalidateTag` / `updateTags` receive from Next as a second argument. */
export interface RevalidationDurations {
  /** Seconds the soft-invalidated tag keeps serving stale entries before they expire. */
  expire?: number
}

/**
 * The state change for a tag invalidation, mirroring Next's own tags manifest:
 * - no durations → hard expire right now
 * - durations → mark stale right now, and expire `expire` seconds from now if given
 */
export function revalidationUpdate(now: Timestamp, durations?: RevalidationDurations): TagState {
  if (!durations) return { expired: now }
  const update: TagState = { stale: now }
  if (durations.expire !== undefined) update.expired = now + durations.expire * 1000
  return update
}

/** Merge two states, keeping the later value of each field. */
export function mergeTagState(a: TagState | undefined, b: TagState): TagState {
  const out: TagState = { ...a }
  if (b.stale !== undefined) out.stale = Math.max(a?.stale ?? 0, b.stale)
  if (b.expired !== undefined) out.expired = Math.max(a?.expired ?? 0, b.expired)
  return out
}

/** True when any tag expired between the entry's creation and now. */
export function areTagsExpired(
  tags: readonly string[],
  entryTimestamp: Timestamp,
  states: ReadonlyMap<string, TagState>,
  now: Timestamp,
): boolean {
  for (const tag of tags) {
    const expired = states.get(tag)?.expired
    if (expired !== undefined && expired <= now && expired > entryTimestamp) return true
  }
  return false
}

/** True when any tag was marked stale after the entry's creation. */
export function areTagsStale(
  tags: readonly string[],
  entryTimestamp: Timestamp,
  states: ReadonlyMap<string, TagState>,
): boolean {
  for (const tag of tags) {
    const stale = states.get(tag)?.stale
    if (stale !== undefined && stale > entryTimestamp) return true
  }
  return false
}

/** Latest `expired` among the tags, or 0. This is what Next's `getExpiration` asks for. */
export function latestExpiration(
  tags: readonly string[],
  states: ReadonlyMap<string, TagState>,
): Timestamp {
  let latest = 0
  for (const tag of tags) latest = Math.max(latest, states.get(tag)?.expired ?? 0)
  return latest
}
