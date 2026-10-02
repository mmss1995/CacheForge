// Bundles a publishable package into dist/. Workspace packages are inlined; real dependencies stay external.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = {
  next: { entry: 'packages/next/src/index.ts', out: 'packages/next/dist/index.js', external: ['ioredis', 'next'] },
  cli: {
    entry: 'packages/cli/src/bin.ts',
    out: 'packages/cli/dist/bin.js',
    external: ['ioredis'],
    banner: '#!/usr/bin/env node',
  },
}

const name = process.argv[2]
const target = targets[name]
if (!target) throw new Error(`unknown target "${name}" (expected: ${Object.keys(targets).join(', ')})`)

await build({
  entryPoints: [resolve(root, target.entry)],
  outfile: resolve(root, target.out),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: target.external,
  banner: target.banner ? { js: target.banner } : undefined,
  sourcemap: true,
  logLevel: 'info',
  // ioredis is CommonJS; make `require` available to anything bundled that needs it.
})
