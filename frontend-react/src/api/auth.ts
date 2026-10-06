import api from './client'

/** 对应 Vue 版 api/auth.ts —— 所有方法签名与返回结构保持一致（返回 AxiosResponse） */
export const authAPI = {
  register: (username: string, password: string) =>
    api.post('/api/auth/register', { username, password }),

  login: (username: string, password: string, captchaToken?: string) => {
    const params = new URLSearchParams()
    params.set('username', username)
    params.set('password', password)
    // 滑块验证码一次性票据：管理端开启验证码时必传；未开启不发送，保持旧接口行为不变
    if (captchaToken) params.set('captcha_token', captchaToken)
    return api.post('/api/auth/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  },

  getCurrentUser: () => api.get('/api/auth/users/me'),

  updatePassword: (password: string) =>
    api.put('/api/auth/users/me/password', { password }),
}
