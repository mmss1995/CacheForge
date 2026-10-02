import type { CacheStore, Timestamp } from '@cacheforge/core'

const RESYNC_MS = 30_000

/**
 * Maps this process's clock onto the store's. Entries and invalidations are all stamped in "cluster
 * time" (store time), so two hosts whose clocks disagree by a second still agree on what came first.
 */
export class ClusterClock {
  private offset = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly store: CacheStore,
    private readonly local: () => number = Date.now,
  ) {}

  /** Measure the offset now and keep re-measuring. Falls back to the local clock if the store is down. */
  async start(): Promise<void> {
    await this.sync()
    this.timer = setInterval(() => void this.sync(), RESYNC_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async sync(): Promise<void> {
    try {
      const before = this.local()
      const remote = await this.store.time()
      const after = this.local()
      // Assume the reply was produced halfway through the round trip.
      this.offset = remote - (before + after) / 2
    } catch {
      // Keep the previous offset.
    }
  }

  /** Cluster time now. */
  now(): Timestamp {
    return Math.round(this.local() + this.offset)
  }

  toCluster(localTime: Timestamp): Timestamp {
    return Math.round(localTime + this.offset)
  }

  toLocal(clusterTime: Timestamp): Timestamp {
    return Math.round(clusterTime - this.offset)
  }
}
