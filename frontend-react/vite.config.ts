import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 与 Vue 工程一致：envDir 指向项目根（/root/cdhcprs），读取根级 .env
  const env = loadEnv(mode, '..', '')
  const port = Number(env.FRONTEND_REACT_PORT || env.FRONTEND_PORT || 5174)
  return {
    envDir: '..',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
      // 关键：本工程位于 pnpm workspace 下，@radix-ui 等包会从 workspace 根解析出
      // 另一份 react 实例（两份 React → hooks 调度器为 null → 整页白屏）。
      // dedupe 强制全图收敛到同一份 react/react-dom。
      dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
    },
    server: {
      port,
      host: true,
      open: false,
      // 本工作区路径含中文，Windows 下默认文件监听会漏事件（服务过期模块导致白屏/旧页面），
      // 改用轮询监听保证 HMR 与模块服务始终最新
      watch: { usePolling: true, interval: 300 },
      // 本地开发代理：云端由 nginx 把 /api 转给后端，开发环境由 vite 承担同一职责，
      // 保持前端相对路径 API_BASE_URL 不变，也避开跨域（后端 CORS 白名单为空）
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${Number(env.BACKEND_PORT || 8001)}`,
          changeOrigin: false,
        },
      },
    },
    preview: {
      port: 4173,
      host: true,
      // 生产构建预览同样走 /api 代理，便于发布前真实流程验收
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${Number(env.BACKEND_PORT || 8001)}`,
          changeOrigin: false,
        },
      },
    },
  }
})
