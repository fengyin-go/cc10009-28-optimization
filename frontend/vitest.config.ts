import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// 复用 Vite 的 @ 别名；测试在 node 环境运行，localStorage 缺失时数据层自动回落内存/种子数据。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
