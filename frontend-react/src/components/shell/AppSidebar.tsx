import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom'
import api from '@/api'
import { authAPI } from '@/api/auth'
import { chatAPI } from '@/api/chat'
import { confirmDialog, notify } from '@/lib/toast'
import { useUserStore } from '@/stores/user'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import MaterialIcon from '@/components/MaterialIcon'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

/** 侧栏壳层（视觉规则在 styles/shell.css：中性灰底、无竖向分隔线、近黑实底新问诊胶囊） */

/* ===== 全局视觉放大（todo B）：本轮放大基准不动，侧栏各元素仍以内联样式
 * 按 1.25 倍同步（与 tokens.css 的 125% 口径一致，基准取 shell.css 原始 px 值），
 * 图标尺寸与 padding/高度一起调，保持对齐与密度 ===== */
const SIDE_BTN = { height: 49, borderRadius: 11.5, gap: 12.5, padding: '0 12.5px', fontSize: 15.5 } as const
const SIDE_ICON = { width: 22.5, height: 22.5, flex: '0 0 22.5px' } as const
const AVATAR = { width: 37.5, height: 37.5, flex: '0 0 37.5px', fontSize: 14 } as const
/* 新问诊近黑实底胶囊：规格高约 44px（×1.25 放大基准 = 55px），rounded-full；
 * 底/字/hover 色由 shell.css 的 .new-btn 系列规则接管（--color-foreground 近黑 + hover #3D3D3A 档） */
const NEW_BTN = { height: 55, borderRadius: 9999, gap: 12.5, padding: '0 14px', fontSize: 15.5 } as const
const GROUP_TITLE = { padding: '9px 12.5px 6.5px', fontSize: 13.75, fontWeight: 600, color: 'var(--muted-2)' } as const
const RECENT_TITLE = { fontSize: 16.25 } as const /* 会话行 13px（规格 §3）× 1.25 放大基准 */

interface RecentConv {
  id: number
  title?: string
  created_at?: string
  updated_at?: string
}

function BrandMark({ alt }: { alt: string }) {
  return (
    <img
      className="brand-mark"
      src="/logo.png"
      alt={alt}
      style={{ width: 30, height: 30, flex: '0 0 30px', borderRadius: 7.5 }}
    />
  )
}

/* 会话按时间分组（今天/昨天/更早）：数据来自接口，分组只在渲染层做 */
type RecentGroup = { label: string; items: RecentConv[] }

function groupByDay(list: RecentConv[]): RecentGroup[] {
  const now = new Date()
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  const buckets: Record<string, RecentConv[]> = { 今天: [], 昨天: [], 更早: [] }
  for (const c of list) {
    const raw = c.updated_at || c.created_at
    const d = raw ? new Date(raw) : null
    if (!d || Number.isNaN(d.getTime())) { buckets['更早'].push(c); continue }
    if (d.toDateString() === now.toDateString()) buckets['今天'].push(c)
    else if (d.toDateString() === yest.toDateString()) buckets['昨天'].push(c)
    else buckets['更早'].push(c)
  }
  return (['今天', '昨天', '更早'] as const)
    .map((label) => ({ label, items: buckets[label] }))
    .filter((g) => g.items.length > 0)
}

export default function AppSidebar({ sidebarCollapsed = false, onToggleSidebar }: { sidebarCollapsed?: boolean; onToggleSidebar?: () => void } = {}) {
  const user = useUserStore((s) => s.user)
  const token = useUserStore((s) => s.token)
  const setUser = useUserStore((s) => s.setUser)
  const setToken = useUserStore((s) => s.setToken)
  const logout = useUserStore((s) => s.logout)
  const isAdmin = user?.role === 'admin'
  const isAuthenticated = !!token && !!user

  const [recents, setRecents] = useState<RecentConv[]>([])
  // 头像弹出菜单（Kimi 式，替代原侧栏抽屉）
  const [menuOpen, setMenuOpen] = useState(false)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  // 移动端导航抽屉：≤680px 时 .sidebar 被 display:none，Topbar 汉堡派发
  // 'alma:open-mobile-nav' 唤起这里的左侧 Sheet，保证全局导航可达
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // 站点名：挂载时读 /api/public/settings 的 website_name（管理平台可配），
  // 失败或为空回退「橘泉智养」；About/Login 页同款请求模式
  const [siteName, setSiteName] = useState('橘泉智养')
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    api.get('/api/public/settings')
      .then(({ data }) => { if (!cancelled && data?.website_name) setSiteName(data.website_name) })
      .catch(() => { /* 接口不可用 → 保持回退名 */ })
    return () => { cancelled = true }
  }, [])

  // 弹出菜单：外部点击与 Esc 关闭
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => { setMenuOpen(false) }, [location.pathname])

  const loadRecent = useCallback(async () => {
    if (!token) { setRecents([]); return }
    try {
      const { data } = await chatAPI.getConversations()
      const list: any[] = Array.isArray(data) ? data : (data?.items ?? [])
      // 历史分离按页面区分：长辈模式页只显示 senior 会话，普通页面只显示普通会话
      const onSenior = location.pathname.startsWith('/senior')
      const filtered = list.filter((c) => (onSenior ? c.consultation_mode === 'senior' : c.consultation_mode !== 'senior'))
      setRecents(filtered.slice(0, 12))
    } catch {
      setRecents([])
    }
  }, [token, location.pathname])

  const hydrate = useCallback(async () => {
    const stored = localStorage.getItem('token')
    if (!stored) {
      if (token || user) logout()
      return
    }
    if (token !== stored) setToken(stored)
    if (user) return
    try {
      const { data } = await authAPI.getCurrentUser()
      setUser(data)
    } catch (err: any) {
      if (err?.response?.status === 401) logout()
    }
  }, [token, user, setToken, setUser, logout])

  useEffect(() => {
    void hydrate()
    void loadRecent()
    const onStorage = (e: StorageEvent) => { if (e.key === 'token') { void hydrate(); void loadRecent() } }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [hydrate, loadRecent])

  // 路由变化时刷新最近会话（切换会话后侧栏同步）
  useEffect(() => { void loadRecent() }, [location.pathname, location.search, loadRecent])

  // Topbar 移动端汉堡按钮 → 打开移动导航抽屉
  useEffect(() => {
    const openMobileNav = () => setMobileNavOpen(true)
    window.addEventListener('alma:open-mobile-nav', openMobileNav)
    return () => window.removeEventListener('alma:open-mobile-nav', openMobileNav)
  }, [])

  const handleLogout = useCallback(async () => {
    if (!(await confirmDialog('确定退出当前账号吗？', '退出登录'))) return
    logout()
    setMenuOpen(false)
    navigate('/login')
  }, [logout, navigate])

  const sideBtnClass = ({ isActive }: { isActive: boolean }) => `side-btn${isActive ? ' active' : ''}`
  const currentConvId = new URLSearchParams(location.search).get('c')
  /* 打开会话（?c=）时抑制「智能问诊」导航的浅灰填充：侧栏只保留会话行一处激活填充，
     避免双高亮（规格 §4.3） */
  const chatBtnClass = ({ isActive }: { isActive: boolean }) =>
    `side-btn${isActive && !currentConvId ? ' active' : ''}`
  const recentClass = (id: number) => `recent${currentConvId === String(id) ? ' active' : ''}`
  const groups = groupByDay(recents)

  /* ===== 会话行操作（与 Chat.tsx 的 onConversationCommand 同口径）：
     hover 显现的 改名/删除 钮，走既有 chatAPI，成功后刷新侧栏列表 ===== */
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameDoneRef = useRef(false) /* Enter/失焦双触发去重 */

  const startRename = (c: RecentConv) => {
    renameDoneRef.current = false
    setRenamingId(c.id)
    setRenameValue(c.title || '')
  }
  const cancelRename = () => {
    renameDoneRef.current = true
    setRenamingId(null)
    setRenameValue('')
  }
  const submitRename = async () => {
    if (renameDoneRef.current) return
    renameDoneRef.current = true
    const id = renamingId
    const title = renameValue.trim()
    setRenamingId(null)
    setRenameValue('')
    if (id == null || !title) return
    try {
      await chatAPI.updateConversationTitle(id, title)
      await loadRecent()
    } catch { /* 拦截器已提示 */ }
  }
  const handleDeleteConversation = async (conv: RecentConv) => {
    if (!(await confirmDialog(`确定删除会话「${conv.title || '未命名会话'}」吗？`, '删除会话'))) return
    try {
      await chatAPI.deleteConversation(conv.id)
      /* 删除的是当前打开的会话 → 回到新问诊（Chat 的 ?new=1 路由 watcher 负责重置） */
      if (currentConvId === String(conv.id)) navigate('/chat?new=1')
      await loadRecent()
      notify.success('会话已删除')
    } catch { /* 拦截器已提示 */ }
  }

  /* 会话行：标题 Link + hover 显现的改名/删除钮（桌面侧栏与移动端抽屉共用） */
  const renderRecentRow = (c: RecentConv, onClose?: () => void) => (
    <div key={c.id} className={`recent-row${renamingId === c.id ? ' editing' : ''}`}>
      {renamingId === c.id ? (
        <input
          className="recent-rename"
          style={RECENT_TITLE}
          value={renameValue}
          autoFocus
          aria-label="重命名会话"
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void submitRename() }
            else if (e.key === 'Escape') cancelRename()
          }}
          onBlur={() => void submitRename()}
        />
      ) : (
        <Link
          to={`/chat?c=${c.id}`}
          className={recentClass(c.id)}
          style={{ padding: '10px 12.5px', borderRadius: 10 }}
          onClick={onClose}
        >
          <div className="recent-title" style={RECENT_TITLE}>{c.title || '未命名会话'}</div>
        </Link>
      )}
      <div className="recent-actions">
        <button type="button" className="recent-action" aria-label="重命名会话" title="重命名" onClick={() => startRename(c)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 20h4.5L19 9.5a2.12 2.12 0 0 0-3-3L5.5 17 4 20Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" /><path d="M13.6 6.4l3 3" stroke="currentColor" strokeWidth="1.55" /></svg>
        </button>
        <button type="button" className="recent-action danger" aria-label="删除会话" title="删除" onClick={() => void handleDeleteConversation(c)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4.5 6.5h15M9.5 6.2V4.6h5v1.6M6.6 6.5l.75 12.9a1.6 1.6 0 0 0 1.6 1.5h6.1a1.6 1.6 0 0 0 1.6-1.5l.75-12.9M10 10.5v6.2M14 10.5v6.2" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>
  )

  return (
    <>
      <aside className="sidebar">
        <div className="brand" style={{ height: 56.5, gap: 11.5, padding: '0 12.5px 6.5px', fontSize: 21.5 }}>
          <BrandMark alt={siteName} />{siteName}
          {/* 折叠开关（原顶栏迁入）：与 logo/名称同行靠右；移动端整个侧栏被 CSS 隐藏，无需区分 */}
          {onToggleSidebar && (
            <button
              type="button"
              className="icon-btn side-collapse"
              aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
              style={{ marginLeft: 'auto', width: 34, height: 34, borderRadius: 9 }}
              onClick={onToggleSidebar}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.55" /><path d="M9.5 4.5v15" stroke="currentColor" strokeWidth="1.55" /></svg>
            </button>
          )}
        </div>

        {isAuthenticated && (
          <Link to="/chat?new=1" className="side-btn new-btn" style={NEW_BTN} onClick={() => setMenuOpen(false)}>
            <span className="side-icon" style={SIDE_ICON}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
            </span>
            新问诊
          </Link>
        )}

        {isAuthenticated && (
          <NavLink to="/chat" className={chatBtnClass} style={SIDE_BTN}>
            <span className="side-icon" style={SIDE_ICON}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M5 18.5h9.5a4.5 4.5 0 0 0 0-9H8A4 4 0 0 0 4 13.5V21l3.1-2.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            问诊
          </NavLink>
        )}

        {isAuthenticated && (
          <NavLink to="/records" className={sideBtnClass} style={SIDE_BTN}>
            <span className="side-icon" style={SIDE_ICON}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" strokeWidth="1.55" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" /></svg>
            </span>
            患者档案
          </NavLink>
        )}

        {/* 长辈模式：适老化问诊入口，患者档案之后 */}
        {isAuthenticated && (
          <NavLink to="/senior" className={sideBtnClass} style={SIDE_BTN}>
            <span className="side-icon" style={SIDE_ICON}>
              <MaterialIcon name="elderly" size={19} />
            </span>
            长辈模式
          </NavLink>
        )}

        {/* 设置（v4 规格 §2）：主题/字号/语言，放在患者档案之后 */}
        {isAuthenticated && (
          <NavLink to="/settings" className={sideBtnClass} style={SIDE_BTN}>
            <span className="side-icon" style={SIDE_ICON}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.55" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" stroke="currentColor" strokeWidth="1.55" /></svg>
            </span>
            设置
          </NavLink>
        )}

        <div className="recents">
          {groups.map((g) => (
            <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="side-heading" style={GROUP_TITLE}>{g.label}</div>
              {g.items.map((c) => renderRecentRow(c))}
            </div>
          ))}
          {!isAuthenticated && (
            <div className="recent-meta" style={{ padding: '10px 12.5px', fontSize: 12.5 }}>登录后查看会话历史</div>
          )}
        </div>

        {isAuthenticated ? (
          <div className="profile-wrap" ref={menuWrapRef}>
            <div className="profile-row">
              {/* 高亮只覆盖头像+用户名（fit-content），与上方导航项左缘对齐 */}
              <button
                type="button"
                className="profile"
                aria-label="打开用户菜单"
                aria-expanded={menuOpen}
                style={{ padding: '10px 9px', gap: 11.5, borderRadius: 10 }}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span className="avatar" style={{ ...AVATAR, color: 'var(--color-white)', display: 'grid', placeItems: 'center' }}>
                  <MaterialIcon name="person" size={24} />
                </span>
                <span className="profile-title" style={{ fontSize: 14.5, minWidth: 0, textAlign: 'left' }}>{user?.username || '用户'}</span>
              </button>
              {/* 手机图标（占位钮：圆角长方+底部小点，无音量键；暂无独立动作） */}
              <button type="button" className="profile-phone" aria-label="手机客户端（暂未开放）" title="手机客户端（暂未开放）">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.55" />
                  <path d="M11 18.6h2" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Kimi 式头像弹出菜单（非侧栏）：管理平台(管理员) / 设置 / 语言 / 退出登录 */}
            {menuOpen && (
              <div className="user-menu" role="menu">
                {isAdmin && (
                  <button type="button" className="user-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); navigate('/admin') }}>
                    <MaterialIcon name="admin_panel_settings" size={18} />
                    管理平台
                  </button>
                )}
                <button type="button" className="user-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); navigate('/settings') }}>
                  <MaterialIcon name="face" size={18} />
                  设置
                </button>
                <div className="user-menu-row">
                  <span className="user-menu-label"><MaterialIcon name="translate" size={18} />语言</span>
                  <LanguageSwitcher />
                </div>
                <div className="user-menu-sep" />
                <button type="button" className="user-menu-item danger" role="menuitem" onClick={handleLogout}>
                  <MaterialIcon name="logout" size={18} />
                  退出登录
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="profile" style={{ padding: '12.5px 9px 1px', gap: 11.5 }}>
            <div className="avatar" style={{ ...AVATAR, background: 'var(--muted)', color: 'var(--color-textSecondary)', display: 'grid', placeItems: 'center' }}>
              <MaterialIcon name="person" size={22} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <Link to="/login" className="profile-title" style={{ color: 'var(--accent)', fontSize: 14.5 }}>登录</Link>
              <div className="profile-sub" style={{ fontSize: 12 }}>未关联档案</div>
            </div>
          </div>
        )}
      </aside>



      {/* 移动端导航抽屉（≤680px 侧栏 display:none 后的全局导航入口，
          由 Topbar 汉堡派发的 'alma:open-mobile-nav' 唤起）：
          条目与桌面侧栏一致，复用 .side-btn/.side-heading/.recent 样式 */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" style={{ width: 'min(300px, 86vw)', maxWidth: 'none', padding: 0 }}>
          <SheetTitle style={{ display: 'none' }}>导航菜单</SheetTitle>
          <div
            style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              gap: 4, padding: '14px 12px 12px', background: 'var(--paper-2)', overflow: 'hidden auto',
            }}
          >
            <div className="brand" style={{ height: 56.5, gap: 11.5, padding: '0 12.5px 6.5px', fontSize: 21.5 }}><BrandMark alt={siteName} />{siteName}</div>

            {isAuthenticated && (
              <Link to="/chat?new=1" className="side-btn new-btn" style={NEW_BTN} onClick={() => setMobileNavOpen(false)}>
                <span className="side-icon" style={SIDE_ICON}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                </span>
                新问诊
              </Link>
            )}

            {isAuthenticated && (
              <NavLink to="/chat" className={chatBtnClass} style={SIDE_BTN} onClick={() => setMobileNavOpen(false)}>
                <span className="side-icon" style={SIDE_ICON}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M5 18.5h9.5a4.5 4.5 0 0 0 0-9H8A4 4 0 0 0 4 13.5V21l3.1-2.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                问诊
              </NavLink>
            )}

            {isAuthenticated && (
              <NavLink to="/records" className={sideBtnClass} style={SIDE_BTN} onClick={() => setMobileNavOpen(false)}>
                <span className="side-icon" style={SIDE_ICON}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" strokeWidth="1.55" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" /></svg>
                </span>
                患者档案
              </NavLink>
            )}

            {/* 长辈模式：与桌面侧栏一致，跟在患者档案之后 */}
            {isAuthenticated && (
              <NavLink to="/senior" className={sideBtnClass} style={SIDE_BTN} onClick={() => setMobileNavOpen(false)}>
                <span className="side-icon" style={SIDE_ICON}>
                  <MaterialIcon name="elderly" size={19} />
                </span>
                长辈模式
              </NavLink>
            )}

            {/* 设置：与桌面侧栏一致，跟在患者档案之后 */}
            {isAuthenticated && (
              <NavLink to="/settings" className={sideBtnClass} style={SIDE_BTN} onClick={() => setMobileNavOpen(false)}>
                <span className="side-icon" style={SIDE_ICON}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.55" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" stroke="currentColor" strokeWidth="1.55" /></svg>
                </span>
                设置
              </NavLink>
            )}

            {!isAuthenticated && (
              <Link to="/login" className={sideBtnClass({ isActive: false })} style={SIDE_BTN} onClick={() => setMobileNavOpen(false)}>
                <span className="side-icon" style={SIDE_ICON}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h10" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                登录
              </Link>
            )}

            {isAuthenticated && (
              <div className="recents" style={{ marginTop: 6 }}>
                {groups.map((g) => (
                  <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div className="side-heading" style={GROUP_TITLE}>{g.label}</div>
                    {g.items.map((c) => renderRecentRow(c, () => setMobileNavOpen(false)))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
