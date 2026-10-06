import { AppRoutes } from '@/router'

/**
 * 应用根组件 —— 路由树入口。
 * Shell（侧栏 + 顶栏）已经在 router/index.tsx 的 <AppShell/> 里组装好了，
 * 这里只负责把整套路由挂上来；全局 Provider（Router/i18n/Toaster/ConfirmDialog）
 * 在 main.tsx 里编排。
 */
export default function App() {
  return <AppRoutes />
}
