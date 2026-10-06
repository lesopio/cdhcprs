import axios from 'axios'
import { toast } from 'sonner'
import i18n from '@/i18n'

/**
 * 云端部署使用相对路径（通过 nginx 代理）；
 * 本地开发可通过环境变量 VITE_API_BASE_URL 设置。
 */
const DEFAULT_API_BASE_URL = ''

const getBaseUrl = () => {
  const envUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
  const raw = envUrl.trim()
  const base = raw.length > 0 ? raw : DEFAULT_API_BASE_URL
  return base.replace(/\/$/, '')
}

export const API_BASE_URL = getBaseUrl()

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
}, (error) => Promise.reject(error))

api.interceptors.response.use((response) => response, (error) => {
  if (error.response) {
    // FastAPI 校验错误（422）的 detail 是数组（[{type,loc,msg,input}]），必须规范成字符串——
    // 对象直接进 toast 会被 React 当 child 渲染而崩溃（Objects are not valid as a React child）
    const detail = error.response.data?.detail
    const message = typeof detail === 'string'
      ? detail
      : Array.isArray(detail)
        ? detail.map((d: any) => d?.msg || String(d)).join('；')
        : i18n.t('messages.requestFailed')
    toast.error(message)
    if (error.response.status === 401) {
      localStorage.removeItem('token')
      // 避免在登录页再次跳转造成循环
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }
  } else {
    toast.error(i18n.t('messages.networkError'))
  }
  return Promise.reject(error)
})

export default api
