import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@opencut/ai-core/services/prompt-compiler': fileURLToPath(new URL('./src/packages/ai-core/services/prompt-compiler.ts', import.meta.url)),
      '@opencut/ai-core/api/task-poller': fileURLToPath(new URL('./src/packages/ai-core/api/task-poller.ts', import.meta.url)),
      '@opencut/ai-core/protocol': fileURLToPath(new URL('./src/packages/ai-core/protocol/index.ts', import.meta.url)),
      '@opencut/ai-core': fileURLToPath(new URL('./src/packages/ai-core/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts', 'scripts/**/*.test.ts'],
    restoreMocks: true,
    maxWorkers: 2,
  },
});
