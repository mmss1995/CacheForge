import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

// Tests run against TypeScript sources, so nothing has to be built first.
export default defineConfig({
  resolve: {
    alias: {
      '@cacheforge/core': src('core'),
      '@cacheforge/redis': src('redis'),
      '@cacheforge/next': src('next'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
})
