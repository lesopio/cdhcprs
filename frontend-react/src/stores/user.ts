import { create } from 'zustand'

export interface User {
  id: number
  username: string
  role: string
  is_banned: boolean
  created_at: string
}

interface UserState {
  user: User | null
  /** token 同时持久化到 localStorage['token']（与 Vue 版 + axios 拦截器约定一致） */
  token: string | null
  setUser: (u: User) => void
  setToken: (t: string) => void
  logout: () => void
  isAdmin: () => boolean
  isAuthenticated: () => boolean
}

/**
 * 对应 Vue 版 stores/user.ts（Pinia setup store）
 * token 持久化是手写 localStorage 逻辑：setToken 写入、logout 移除（存储 key 'token'，
 * axios 拦截器读取同名 key），初始 token 也从 localStorage['token'] 读出；
 * user 不持久化，每次启动通过 getCurrentUser 注水（与 Vue 版行为一致）。
 * 注：原实现的 zustand persist 中间件是 no-op 摆设（storage 三方法全为空、
 * partialize 结果无人消费），已于本轮清理移除，行为不变。
 */
export const useUserStore = create<UserState>((set, get) => ({
  user: null,
  token: localStorage.getItem('token'),
  setUser: (u) => set({ user: u }),
  setToken: (t) => {
    localStorage.setItem('token', t)
    set({ token: t })
  },
  logout: () => {
    localStorage.removeItem('token')
    set({ user: null, token: null })
  },
  isAdmin: () => get().user?.role === 'admin',
  isAuthenticated: () => !!get().token && !!get().user,
}))
