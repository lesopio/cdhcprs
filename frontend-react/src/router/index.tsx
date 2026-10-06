import { lazy, Suspense, useState } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { RequireAuth, RequireAdmin } from './guards'
import AppSidebar from '@/components/shell/AppSidebar'
import Topbar from '@/components/shell/Topbar'

const Login = lazy(() => import('@/pages/Login'))
const Chat = lazy(() => import('@/pages/Chat'))
const SeniorChat = lazy(() => import('@/pages/SeniorChat'))
const Profile = lazy(() => import('@/pages/Profile'))
const Admin = lazy(() => import('@/pages/Admin'))
const About = lazy(() => import('@/pages/About'))
const Settings = lazy(() => import('@/pages/Settings'))

const PageFallback = () => (
  <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
    正在加载…
  </div>
)

/** 应用外壳：侧栏 + 内容区；登录页不套外壳。
 *  桌面端顶栏已按用户要求移除（折叠开关移入侧栏品牌行，折叠时由 .side-expand 浮动钮展开）；
 *  Topbar 仅在移动端（≤680px）保留，承担汉堡导航与健康状态。 */
function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const toggleSidebar = () => setSidebarCollapsed((v) => !v)
  return (
    <div className={`app${sidebarCollapsed ? ' side-collapsed' : ''}`}>
      <AppSidebar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      <main className="main">
        <Topbar />
        {sidebarCollapsed && (
          <button
            type="button"
            className="side-expand"
            aria-label="展开侧栏"
            onClick={toggleSidebar}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.55" /><path d="M9.5 4.5v15" stroke="currentColor" strokeWidth="1.55" /></svg>
          </button>
        )}
        <div className="main-content">
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      {/* 登录页不套外壳 */}
      <Route path="/login" element={<Suspense fallback={<PageFallback />}><Login /></Suspense>} />

      {/* 管理平台：独立全屏页，不套侧栏外壳（用户需求） */}
      <Route path="/admin" element={<RequireAuth><RequireAdmin><Suspense fallback={<PageFallback />}><Admin /></Suspense></RequireAdmin></RequireAuth>} />

      {/* 其它页面统一套 AppShell（侧栏） */}
      <Route element={<AppShell />}>
        {/* 首页与问诊合并（用户需求）：/ 直接落到问诊页，大输入框欢迎墙即首页布局 */}
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/about" element={<About />} />
        <Route path="/chat" element={<RequireAuth><Chat /></RequireAuth>} />
        <Route path="/senior" element={<RequireAuth><SeniorChat /></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><Profile /></RequireAuth>} />
        <Route path="/records" element={<RequireAuth><Profile /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
