import api from './client'

/** 对应 Vue 版 api/auth.ts —— 所有方法签名与返回结构保持一致（返回 AxiosResponse） */
export const authAPI = {
  /** 注册（需注册码 + Turnstile），成功返回 Token（直接登录） */
  register: (data: {
    username: string
    password: string
    confirm_password: string
    registration_code: string
    nickname?: string
    captcha_token?: string
  }) => api.post<{ access_token: string; token_type: string }>('/api/auth/register', data),

  login: (username: string, password: string, captchaToken?: string) => {
    const params = new URLSearchParams()
    params.set('username', username)
    params.set('password', password)
    if (captchaToken) params.set('captcha_token', captchaToken)
    return api.post('/api/auth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  },

  getCurrentUser: () => api.get('/api/auth/users/me'),

  updatePassword: (password: string) =>
    api.put('/api/auth/users/me/password', { password }),
}
