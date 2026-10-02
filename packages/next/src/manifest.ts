import {
  mergeTagState,
  type CacheEvent,
  type CacheStore,
  type TagState,
} from '@cacheforge/core'

export type Consistency = 'eventual' | 'strong'

/**
 * This process's view of the tags. Local invalidations apply immediately (read-your-writes), other
 * instances' invalidations arrive over pub/sub within milliseconds, and a periodic full sync heals
 * anything a dropped pub/sub message left behind.
 */
export class TagManifest {
  private readonly states = new Map<string, TagState>()
  private lastSync = 0
  private unsubscribe: (() => void) | undefined
  private syncing: Promise<void> | undefined

  constructor(
    private readonly store: CacheStore,
    private readonly options: { consistency: Consistency; syncIntervalMs: number },
    /** Called whenever a tag's state changes locally, e.g. to mirror it into Next's own manifest. */
    private readonly onChange?: (tag: string, state: TagState) => void,
  ) {}

  async start(): Promise<void> {
    if (this.options.consistency === 'strong') return
    this.unsubscribe = await this.store.subscribe((event) => this.onEvent(event))
    await this.sync()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private onEvent(event: CacheEvent): void {
    if (event.type === 'tags') this.apply(event.tags, event.update)
    else if (event.type === 'flush') this.states.clear()
  }

  apply(tags: readonly string[], update: TagState): void {
    for (const tag of tags) this.merge(tag, update)
  }

  private merge(tag: string, update: TagState): void {
    this.states.set(tag, mergeTagState(this.states.get(tag), update))
    this.onChange?.(tag, update)
  }

  private async sync(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        const all = await this.store.getAllTagStates()
        for (const [tag, state] of all) this.merge(tag, state)
        this.lastSync = Date.now()
      } finally {
        this.syncing = undefined
      }
    })()
    return this.syncing
  }

  /** Bring the local view up to date if it has not been synced lately. */
  async refresh(): Promise<void> {
    if (this.options.consistency === 'strong') return
    if (Date.now() - this.lastSync >= this.options.syncIntervalMs) await this.sync()
  }

  async statesFor(tags: readonly string[]): Promise<Map<string, TagState>> {
    if (tags.length === 0) return new Map()
    if (this.options.consistency === 'strong') return this.store.getTagStates(tags)
    const out = new Map<string, TagState>()
    for (const tag of tags) {
      const state = this.states.get(tag)
      if (state) out.set(tag, state)
    }
    return out
  }
}
