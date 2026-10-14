/**
 * 注册页 —— 与登录页同族的单色两栏布局。
 * 字段：用户名（3-32 位字母/数字/下划线）、昵称（可选）、密码（≥12）、确认密码、注册码（必填）、CF Turnstile。
 * 注册成功直接返回 Token → setToken + getCurrentUser → 进入系统。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import MaterialIcon from '@/components/MaterialIcon'
import { notify } from '@/lib/toast'
import { authAPI } from '@/api/auth'
import { useUserStore } from '@/stores/user'
import api from '@/api'

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string
      remove: (widgetId: string) => void
      reset: (widgetId: string) => void
    }
  }
}

const schema = z.object({
  username: z.string()
    .min(3, '用户名至少 3 位')
    .max(32, '用户名最多 32 位')
    .regex(/^[A-Za-z0-9_]+$/, '仅允许字母、数字和下划线'),
  nickname: z.string().max(50).optional().or(z.literal('')),
  password: z.string()
    .min(12, '密码至少 12 位')
    .regex(/[a-z]/, '需含小写字母')
    .regex(/[A-Z]/, '需含大写字母')
    .regex(/[0-9]/, '需含数字')
    .regex(/[^A-Za-z0-9]/, '需含特殊字符'),
  confirmPassword: z.string().min(12, '密码至少 12 位'),
  registrationCode: z.string().min(1, '请输入注册码'),
}).refine((d) => d.password === d.confirmPassword, {
  message: '两次输入的密码不一致',
  path: ['confirmPassword'],
})

type FormValues = z.infer<typeof schema>

export default function Register() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const userStore = useUserStore()
  const [loading, setLoading] = useState(false)
  const [turnstileEnabled, setTurnstileEnabled] = useState(false)
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const turnstileWidgetId = useRef<string | null>(null)
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null)

  const {
    register: rhRegister,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', nickname: '', password: '', confirmPassword: '', registrationCode: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    if (turnstileEnabled && !turnstileToken) {
      notify.error('请先完成安全验证')
      return
    }
    setLoading(true)
    try {
      const { data: tokenData } = await authAPI.register({
        username: values.username,
        password: values.password,
        confirm_password: values.confirmPassword,
        registration_code: values.registrationCode.trim(),
        nickname: values.nickname?.trim() || undefined,
        captcha_token: turnstileToken || undefined,
      })
      userStore.setToken(tokenData.access_token)
      const { data: user } = await authAPI.getCurrentUser()
      userStore.setUser(user)
      notify.success('注册成功，欢迎加入')
      const redirect = searchParams.get('redirect') || '/chat'
      const safeRedirect = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/chat'
      navigate(safeRedirect, { replace: true })
    } catch (error) {
      const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      notify.error(detail || '注册失败，请检查输入')
      if (turnstileEnabled && turnstileWidgetId.current && window.turnstile) {
        window.turnstile.reset(turnstileWidgetId.current)
        setTurnstileToken('')
      }
    } finally {
      setLoading(false)
    }
  })

  // 加载 Turnstile 脚本
  const renderTurnstile = useCallback(() => {
    if (!turnstileContainerRef.current || !window.turnstile || !turnstileSiteKey) return
    if (turnstileWidgetId.current) {
      try { window.turnstile.remove(turnstileWidgetId.current) } catch {}
    }
    turnstileWidgetId.current = window.turnstile.render(turnstileContainerRef.current, {
      sitekey: turnstileSiteKey,
      action: 'register',
      callback: (token: string) => setTurnstileToken(token),
      'expired-callback': () => setTurnstileToken(''),
      'error-callback': () => setTurnstileToken(''),
      theme: 'light',
    })
  }, [turnstileSiteKey])

  useEffect(() => {
    if (!turnstileEnabled || !turnstileSiteKey) return
    const existing = document.getElementById('cf-turnstile-script')
    if (existing) { renderTurnstile(); return }
    const script = document.createElement('script')
    script.id = 'cf-turnstile-script'
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__cfTsReady&render=explicit'
    script.async = true
    script.defer = true
    ;(window as any).__cfTsReady = renderTurnstile
    document.head.appendChild(script)
  }, [turnstileEnabled, turnstileSiteKey, renderTurnstile])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/public/settings')
      .then(({ data }) => {
        if (cancelled) return
        if (data?.turnstile_enabled && data?.turnstile_site_key) {
          setTurnstileEnabled(true)
          setTurnstileSiteKey(data.turnstile_site_key)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <div className="auth-page">
      <section className="auth-intro">
        <span className="intro-badge">橘泉智养</span>
        <h1>注册账号</h1>
        <p>使用管理员提供的注册码创建您的账号，即刻开启智能问诊服务。</p>
        <div className="intro-steps" aria-label="注册流程">
          <span><MaterialIcon name="vpn_key" size={15} />获取注册码</span>
          <span><MaterialIcon name="person_add" size={15} />填写信息</span>
          <span><MaterialIcon name="check_circle" size={15} />开始使用</span>
        </div>
      </section>

      <section className="auth-main">
        <div className="auth-card">
          <header className="card-head">
            <img className="card-logo" src="/logo.png" alt="橘泉智养" />
            <h2>注册账号</h2>
            <p>填写以下信息完成注册</p>
          </header>
          <form onSubmit={onSubmit}>
            <label className="field">
              <span>用户名</span>
              <div className="input-wrap">
                <MaterialIcon name="person" size={18} />
                <input
                  type="text"
                  autoComplete="username"
                  placeholder="3-32 位字母、数字或下划线"
                  {...rhRegister('username')}
                />
              </div>
              {errors.username && <small>{errors.username.message}</small>}
            </label>

            <label className="field">
              <span>昵称（可选）</span>
              <div className="input-wrap">
                <MaterialIcon name="badge" size={18} />
                <input
                  type="text"
                  placeholder="昵称"
                  {...rhRegister('nickname')}
                />
              </div>
              {errors.nickname && <small>{errors.nickname.message}</small>}
            </label>

            <label className="field">
              <span>密码</span>
              <div className="input-wrap">
                <MaterialIcon name="lock" size={18} />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="至少 12 位"
                  {...rhRegister('password')}
                />
              </div>
              {errors.password && <small>{errors.password.message}</small>}
            </label>

            <label className="field">
              <span>确认密码</span>
              <div className="input-wrap">
                <MaterialIcon name="lock" size={18} />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="再次输入密码"
                  {...rhRegister('confirmPassword')}
                />
              </div>
              {errors.confirmPassword && <small>{errors.confirmPassword.message}</small>}
            </label>

            <label className="field">
              <span>注册码</span>
              <div className="input-wrap">
                <MaterialIcon name="confirmation_number" size={18} />
                <input
                  type="text"
                  placeholder="如 ML-XXXXXXXXXXXX"
                  {...rhRegister('registrationCode')}
                />
              </div>
              {errors.registrationCode && <small>{errors.registrationCode.message}</small>}
            </label>

            {turnstileEnabled && (
              <div className="turnstile-wrap" ref={turnstileContainerRef} />
            )}

            <button
              className="login-submit"
              type="submit"
              disabled={loading}
              aria-busy={loading}
            >
              {loading && (
                <span className="login-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
              )}
              注册
            </button>
          </form>
          <p className="auth-switch">
            已有账号？<Link to="/login">登录</Link>
          </p>
        </div>
      </section>

      <style>{`
        .auth-page{min-height:100%;display:grid;grid-template-columns:minmax(380px,1.08fr) minmax(420px,.92fr);background:var(--color-bgPrimary,#FAFAFA);color:var(--color-textSecondary)}
        .auth-intro{height:100%;display:flex;flex-direction:column;justify-content:center;padding:58px clamp(48px,6vw,88px);background:var(--color-bgSecondary,#F7F7F7)}
        .intro-badge{display:inline-flex;align-self:flex-start;align-items:center;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:999px;background:var(--color-bgPrimary,#FAFAFA);padding:6px 13px;color:var(--color-textTertiary);font-size:12.5px;font-weight:600}
        .auth-intro h1{max-width:600px;margin:26px 0 0;font-family:var(--font-serif);font-size:clamp(30px,3.2vw,40px);line-height:1.25;font-weight:600;letter-spacing:.01em;color:var(--color-textPrimary,#1B1B1B)}
        .auth-intro p{max-width:520px;margin:16px 0 0;color:var(--color-textTertiary);font-size:16.5px;line-height:1.75}
        .intro-steps{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}
        .intro-steps span{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:999px;background:var(--color-bgPrimary,#FAFAFA);padding:9px 15px;color:var(--color-textTertiary);font-size:13px;font-weight:600}
        .intro-steps .material-symbol{color:var(--color-textTertiary)}
        .auth-main{width:100%;display:flex;align-items:center;justify-content:center;padding:48px;background:var(--color-bgPrimary,#FAFAFA)}
        .auth-card{width:100%;max-width:420px;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:17px;background:var(--color-surface,#FFFFFF);padding:34px 32px;box-shadow:var(--shadow-card,0 1px 3px rgba(0,0,0,.05),0 1px 1px rgba(0,0,0,.03))}
        .card-head{text-align:center;margin-bottom:26px}
        .card-logo{width:52px;height:52px;object-fit:contain;display:block;margin:0 auto 12px}
        .card-head h2{margin:0;font-family:var(--font-serif);color:var(--color-textPrimary,#1B1B1B);font-size:22px;font-weight:600}
        .card-head p{margin:7px 0 0;color:var(--color-textTertiary);font-size:13.5px}
        .field{display:block;margin-bottom:16px}
        .field>span{display:block;margin-bottom:7px;color:var(--color-textTertiary);font-size:13px;font-weight:600}
        .input-wrap{height:44px;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:10px;display:flex;align-items:center;gap:9px;padding:0 13px;background:var(--color-surface,#FFFFFF);transition:border-color .16s ease,box-shadow .16s ease}
        .input-wrap:focus-within{border-color:var(--color-foreground,#1B1B1B);box-shadow:0 0 0 1px rgba(0,0,0,.06)}
        .input-wrap .material-symbol{color:var(--muted-2,#8F8F8F)}
        .input-wrap input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--color-textPrimary,#1B1B1B);font-size:14px;font-family:inherit}
        .input-wrap input::placeholder{color:var(--muted-2,#8F8F8F)}
        .field>small{display:block;color:var(--color-danger);margin-top:6px;font-size:11.5px}
        .login-submit{width:100%;height:46px;border:0;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:600;margin-top:22px;background:var(--color-foreground,#1B1B1B);color:var(--color-background,#FAFAFA);transition:background .16s ease}
        .login-submit:hover{background:var(--color-accentHover,#3D3D3A)}
        .login-submit:disabled{opacity:.55;cursor:not-allowed}
        .login-dots{display:inline-flex;align-items:center;gap:4px}
        .login-dots i{width:5px;height:5px;border-radius:9999px;background:currentColor;animation:thinking-dot 1.4s ease-in-out infinite}
        .login-dots i:nth-child(2){animation-delay:.15s}
        .login-dots i:nth-child(3){animation-delay:.3s}
        @keyframes thinking-dot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
        .auth-switch{text-align:center;margin-top:18px;font-size:13.5px;color:var(--color-textTertiary)}
        .auth-switch a{color:var(--color-foreground,#1B1B1B);font-weight:600;text-decoration:none;margin-left:4px}
        .auth-switch a:hover{text-decoration:underline}
        .turnstile-wrap{margin-bottom:16px;display:flex;justify-content:center}
        @media(max-width:920px){.auth-page{grid-template-columns:1fr}.auth-intro{display:none}.auth-main{min-height:100%;padding:32px 20px}}
        @media(max-width:480px){.auth-card{padding:24px 16px}.card-head h2{font-size:20px}}
      `}</style>
    </div>
  )
}
