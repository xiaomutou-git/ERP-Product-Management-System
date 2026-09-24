import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Vite 构建配置（函数级注释）
 * 功能：开发服务器端口 5173，/api 代理到后端 3001；@ 别名指向 src/；
 *      生产构建输出 dist/。
 * 依赖条件：Node 18+；后端服务地址可经环境变量 VITE_API_TARGET 覆盖。
 * 异常：代理目标不可达时前端请求将失败并走 axios 错误拦截提示。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
