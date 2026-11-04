import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['sim/**/*.test.ts'],
    testTimeout: 10 * 60_000,
    hookTimeout: 2 * 60_000,
    // それぞれが自分のサーバーを立てて時間も測るので、ファイルは1つずつ順に流す
    fileParallelism: false,
  },
});
