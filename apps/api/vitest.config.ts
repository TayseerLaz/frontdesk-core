import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false, // shared DB; keep it sequential
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Applied to process.env before the env module loads, so the voice gateway
    // (X-Voice-Gateway-Secret) is configured for the phone-integration tests.
    env: {
      VOICE_GATEWAY_SECRET: 'test-voice-gateway-secret',
    },
  },
});
