import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import api from '@/api/client'

/** 对应 Vue 版 App.vue 的浮动 .topbar：
 *  - 左：当前页面标题（TOPBAR_TITLES，由路由路径决定）
 *  - 右：服务健康状态 pill + 移动端汉堡按钮（仅在 680px 以下显示，派发 'alma:open-mobile-nav'
 *    由 AppSidebar 监听并打开左侧导航抽屉）
 *  桌面端折叠开关不在顶栏：AppShell 侧栏品牌行承担折叠、.side-expand 浮动钮展开（探查 ux 项：
 *  原 sidebarCollapsed/onToggleSidebar props 从未被传入（router/index.tsx 渲染 <Topbar /> 无 props），
 *  折叠按钮分支永不生效，已连同 props 一并删除）。 */

const TOPBAR_TITLES: Record<string, string> = {
  '/chat': '智能问诊',
  '/senior': '长辈模式',
  '/profile': '患者档案',
  '/records': '患者档案',
  '/settings': '设置',
  '/about': '关于',
  '/': '首页',
}

export default function Topbar() {
  const location = useLocation()
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 680px)').matches : false,
  )

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 680px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    let cancelled = false
    const check = () => {
      api.get('/api/health')
        .then(() => { if (!cancelled) setHealthOk(true) })
        .catch(() => { if (!cancelled) setHealthOk(false) })
    }
    check()
    const id = window.setInterval(check, 30_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  const title = TOPBAR_TITLES[location.pathname] ?? '橘泉智养'

  return (
    <div className="topbar">
      {/* 全局视觉放大（todo B）：shell.css 为 px 定值且不在本次改动范围，
          顶部栏按钮/图标/文字以内联样式按 1.25 倍同步放大（与 tokens.css 的 125% 口径
          一致，基准取 shell.css 原始 px 值），高度仍受 54px 栏高约束 */}
      <div className="top-left" style={{ gap: 7.5 }}>
        {/* 顶栏透明融入主底：页面标题为纯文本标签，不再是可点按钮 */}
        <div className="topbar-title" style={{ height: 40, padding: '0 12.5px', borderRadius: 10, fontSize: 14.5 }}>{title}</div>
      </div>
      <div className="top-right" style={{ gap: 7.5 }}>
        <span className={`status${healthOk === false ? ' bad' : ''}`} style={{ height: 36.5, padding: '0 12.5px', gap: 7.5, fontSize: 13 }}>
          <i style={{ width: 9, height: 9 }} />
          {healthOk === null ? '检查中' : healthOk ? '服务正常' : '服务异常'}
        </span>
        {isMobile && (
          <button
            type="button"
            className="icon-btn"
            aria-label="打开导航"
            style={{ width: 44, height: 44, borderRadius: 10 }} /* ≥44px 触控目标（仅 ≤680 移动端渲染，54px 栏高内垂直居中不受影响） */
            onClick={() => window.dispatchEvent(new CustomEvent('alma:open-mobile-nav'))}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
    </div>
  )
}
