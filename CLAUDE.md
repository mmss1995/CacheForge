# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shared cache handlers for self-hosted Next.js, backed by Redis. npm workspaces monorepo, TypeScript.
`packages/{core,redis,next,cli}` plus two Next 16 example apps in `examples/`.

## Commands

```bash
npm install                 # if ~/.npmrc has an unreachable proxy, use NPM_CONFIG_USERCONFIG=<clean npmrc>
docker run -d --name cacheforge-redis -p 6390:6379 redis:7-alpine   # tests and examples expect :6390
npm test                    # vitest on TypeScript sources (aliases in vitest.config.ts); Redis tests skip if :6390 is down
npm run build               # esbuild bundles: packages/next/dist and packages/cli/dist (the examples import dist)
(cd examples/isr-app && npx next build) && (cd examples/usecache-app && npx next build)   # before e2e
npm run test:e2e            # spawns real `next start` processes on ports 32xx; needs builds + Redis
npm run typecheck && npm run lint
npm run cacheforge -- ls    # the CLI from source (CACHEFORGE_REDIS, CACHEFORGE_PREFIX)
docker compose up --build   # demo: Redis + 2 instances + nginx (GATEWAY_PORT, EXAMPLE, CACHE_PREFIX)
```

## Architecture

- `core` is pure rules. `tags.ts` mirrors Next's own tags manifest (`expired` only counts once it is in the
  past and after the entry's timestamp; `stale` means serve and refresh). Keep it in sync with Next when it changes.
- Every timestamp is **cluster time** (store time plus a measured offset, `next/src/clock.ts`). Convert with
  `toCluster`/`toLocal` at the Next boundary: Next compares against its own local clock.
- `RedisStore.markTags` is a Lua max-set so concurrent invalidations are monotonic. Do not replace it with HSET.
- `CacheForgeRuntime.guard()` wraps every read/write with a timeout and a circuit breaker, and falls back to a miss.
  `revalidate()` deliberately does not swallow errors.
- `TagManifest` is the local tag view (pub/sub + periodic sync). `next-bridge.ts` copies invalidations into Next's
  process-global manifest; without it, soft `revalidateTag` never lands on legacy ISR pages (see the e2e test).
- Examples read `@cacheforge/next` from `dist`, so rebuild after changing handler code before running e2e.
- Test gotcha: an invalidation in the same millisecond as a write does not expire it (Next's rule). Tests call
  `tick()` between a write and the invalidation.
