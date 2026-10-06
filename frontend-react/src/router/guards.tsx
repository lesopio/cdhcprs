import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { authAPI } from '@/api/auth'
import { useUserStore } from '@/stores/user'
import { notify } from '@/lib/toast'
import i18n from '@/i18n'

/**
 * 鉴权包裹组件 —— 对应 Vue 版 router/index.ts 的全局 beforeEach
 * - 无 token → 跳 /login
 * - 有 token 但 user 为空 → 调 getCurrentUser 注水；401 则 logout 跳登录；
 *   非 401 失败（网络抖动 / 5xx 等）显示错误 + 重试按钮，不再静默卡在「正在加载…」
 * - 注水期间显示占位
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const token = useUserStore((s) => s.token)
  const user = useUserStore((s) => s.user)
  const setUser = useUserStore((s) => s.setUser)
  const logout = useUserStore((s) => s.logout)
  const location = useLocation()
  const [hydrating, setHydrating] = useState(false)
  // 非 401 注水失败标记 + 重试代数（retryTick 变化重新触发注水 effect）
  const [hydrateError, setHydrateError] = useState(false)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!token || user) return
    let cancelled = false
    setHydrating(true)
    setHydrateError(false)
    authAPI.getCurrentUser()
      .then(({ data }) => {
        if (!cancelled) setUser(data)
      })
      .catch((err) => {
        if (cancelled) return
        if (err?.response?.status === 401) logout()
        else setHydrateError(true)
      })
      .finally(() => {
        // hydrating 必须无条件复位：setUser 会改变依赖触发 cleanup（cancelled=true），
        // 若在此跳过复位，页面将永久卡在「正在加载…」（实测竞态，见 2026-09-30 记录）
        setHydrating(false)
      })
    return () => { cancelled = true }
  }, [token, user, setUser, logout, retryTick])

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  // 注水失败且非 401：给出明确错误与重试入口（重试按钮通过 retryTick 重跑上面的 effect）
  if (hydrateError && !hydrating && !user) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', display: 'grid', gap: 14, justifyItems: 'center' }}>
          <span style={{ color: 'var(--color-textSecondary)' }}>登录状态加载失败，请检查网络后重试</span>
          <button
            type="button"
            onClick={() => setRetryTick((t) => t + 1)}
            style={{
              height: 38, padding: '0 20px', border: '1px solid var(--color-borderPrimary)',
              borderRadius: 10, background: 'var(--color-surface)', color: 'var(--color-textPrimary)',
              cursor: 'pointer', fontSize: 14,
            }}
          >
            重试
          </button>
        </div>
      </div>
    )
  }
  if (hydrating || !user) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
        正在加载…
      </div>
    )
  }
  return <>{children}</>
}

/** 管理员鉴权 —— 对应 Vue 版 meta.requiresAdmin。
 *  toast 副作用必须在 useEffect 里发（渲染期弹 toast 会在 StrictMode / 重渲染下重复触发） */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const isAdmin = useUserStore((s) => s.user?.role === 'admin')
  // StrictMode 下 effect 会跑两次，用 ref 保证只弹一次
  const warnedRef = useRef(false)
  useEffect(() => {
    if (!isAdmin && !warnedRef.current) {
      warnedRef.current = true
      notify.warning(i18n.t('messages.adminOnly'))
    }
  }, [isAdmin])
  if (!isAdmin) {
    return <Navigate to="/chat" replace />
  }
  return <>{children}</>
}
