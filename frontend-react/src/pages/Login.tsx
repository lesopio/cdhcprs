/**
 * 登录页 —— 中性单色系统（docs/ui-spec-v3-monochrome.md §3「登录/首页」）：
 * 中性底 + 侧栏同族浅灰介绍栏 + 白卡 hairline + 衬线标题 + 近黑主按钮（hover #3D3D3A）。
 * 骨架零彩色：焦点环/强调文字一律近黑，彩色只留 danger 红（校验错误）与 logo 图片本身。
 * 加载态按规格 §2 用 thinking-dots（vercel 参考三点跳动 1.4s），不用无限旋转图标。
 * 用 react-hook-form + zod 替代手写校验，GSAP 入场动画保留等价。
 * 不套 AppShell（独立两栏布局）。颜色一律 var() 消费 tokens 槽位，规格关键值以
 * var(槽位, 规格hex) 兜底（同 shell.css 新问诊按钮先例），不新增硬编码品牌色。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { gsap } from 'gsap'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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

const DYNAMIC_WORDS = ['循证分诊', '连续档案', '可核验回答']
const WORD_INTERVAL_MS = 2800

export default function Login() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const userStore = useUserStore()
  const pageRoot = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(false)
  const [websiteName, setWebsiteName] = useState(t('common.appName'))
  const [activeWord, setActiveWord] = useState(0)
  // CF Turnstile：turnstileEnabled + siteKey 由 /api/public/settings 返回；
  // turnstileToken 是 widget 验证通过后的 token（提交时带给后端 siteverify）
  const [turnstileEnabled, setTurnstileEnabled] = useState(false)
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const turnstileWidgetId = useRef<string | null>(null)
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null)
  const ctxRef = useRef<gsap.Context | undefined>(undefined)

  const schema = z.object({
    username: z.string().min(1, t('auth.login.usernameRequired')),
    password: z.string().min(1, t('auth.login.passwordRequired')),
  })
  type FormValues = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  })

  /** 真正发起登录（turnstileToken 由 CF widget 回调填入；未启用时为空） */
  const doLogin = async (values: { username: string; password: string }, captchaToken?: string) => {
    setLoading(true)
    try {
      const { data: tokenData } = await authAPI.login(values.username, values.password, captchaToken)
      userStore.setToken(tokenData.access_token)
      const { data: user } = await authAPI.getCurrentUser()
      userStore.setUser(user)
      notify.success('登录成功')
      const redirect = searchParams.get('redirect') || '/chat'
      const safeRedirect = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/chat'
      const q = searchParams.get('q')
      const mode = searchParams.get('mode')
      const parts: string[] = []
      if (q) parts.push(`q=${encodeURIComponent(q)}`)
      if (mode) parts.push(`mode=${mode}`)
      navigate(parts.length ? `${safeRedirect}?${parts.join('&')}` : safeRedirect, { replace: true })
    } catch (error) {
      const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      notify.error(detail || '登录失败，请检查用户名和密码')
      // 登录失败后重置 Turnstile widget（token 已消费/过期）
      if (turnstileEnabled && turnstileWidgetId.current && window.turnstile) {
        window.turnstile.reset(turnstileWidgetId.current)
        setTurnstileToken('')
      }
    } finally {
      setLoading(false)
    }
  }

  /** 表单提交入口：Turnstile 已启用时必须先通过 widget 拿 token */
  const onSubmit = handleSubmit(async (values) => {
    if (turnstileEnabled && !turnstileToken) {
      notify.error('请先完成安全验证')
      return
    }
    await doLogin(values, turnstileToken || undefined)
  })

  // 加载 CF Turnstile 脚本（只在需要时动态注入，避免无验证码环境白加载）
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnstileEnabled, turnstileSiteKey])

  const renderTurnstile = useCallback(() => {
    if (!turnstileContainerRef.current || !window.turnstile || !turnstileSiteKey) return
    // 清掉旧 widget 再渲染（登录失败 reset 也走这条路）
    if (turnstileWidgetId.current) {
      try { window.turnstile.remove(turnstileWidgetId.current) } catch {}
    }
    turnstileWidgetId.current = window.turnstile.render(turnstileContainerRef.current, {
      sitekey: turnstileSiteKey,
      action: 'login',
      callback: (token: string) => setTurnstileToken(token),
      'expired-callback': () => setTurnstileToken(''),
      'error-callback': () => setTurnstileToken(''),
      theme: 'light',
    })
  }, [turnstileSiteKey])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/public/settings')
      .then(({ data }) => {
        if (cancelled) return
        if (data?.website_name) setWebsiteName(data.website_name)
        // CF Turnstile：后端配置了 site/secret key 时启用
        if (data?.turnstile_enabled && data?.turnstile_site_key) {
          setTurnstileEnabled(true)
          setTurnstileSiteKey(data.turnstile_site_key)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const root = pageRoot.current
    if (!root) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return

    const ctx = gsap.context(() => {
      gsap.from('.intro-badge, .auth-intro h1, .auth-intro > p, .intro-steps, .dynamic-copy', {
        y: 18,
        opacity: 0,
        duration: 0.72,
        ease: 'power2.out',
        stagger: 0.08,
      })
    }, root)
    ctxRef.current = ctx

    const timer = window.setInterval(() => {
      setActiveWord((i) => (i + 1) % DYNAMIC_WORDS.length)
    }, WORD_INTERVAL_MS)

    return () => {
      window.clearInterval(timer)
      ctx.revert()
    }
  }, [])

  return (
    <div ref={pageRoot} className="auth-page">
      <section className="auth-intro">
        <span className="intro-badge">{t('homeExtra.badge')}</span>
        <h1>{t('authExtra.heroTitle')}</h1>
        <p>{t('authExtra.heroSubtitle')}</p>
        <div className="intro-steps" aria-label="问诊流程">
          <span>
            <MaterialIcon name="clinical_notes" size={15} />
            {t('homeExtra.step1')}
          </span>
          <span>
            <MaterialIcon name="medical_information" size={15} />
            {t('homeExtra.step2')}
          </span>
          <span>
            <MaterialIcon name="auto_awesome" size={15} />
            {t('homeExtra.step3')}
          </span>
        </div>
        <div className="dynamic-copy" aria-live="polite">
          <span className="dynamic-kicker">问诊进行时</span>
          <strong key={activeWord} className="dynamic-word">
            {DYNAMIC_WORDS[activeWord]}
          </strong>
        </div>
      </section>

      <section className="auth-main">
        <div className="auth-card">
          <header className="card-head">
            <img className="card-logo" src="/logo.png" alt="橘泉智养" />
            <h2>{websiteName}</h2>
            <p>{t('auth.login.title')}</p>
          </header>
          <form onSubmit={onSubmit}>
            <label className="field">
              <span>{t('auth.login.username')}</span>
              <div className="input-wrap">
                <MaterialIcon name="person" size={18} />
                <input
                  type="text"
                  autoComplete="username"
                  placeholder={t('auth.login.username')}
                  {...register('username')}
                />
              </div>
              {errors.username && <small>{errors.username.message}</small>}
            </label>
            <label className="field">
              <span>{t('auth.login.password')}</span>
              <div className="input-wrap">
                <MaterialIcon name="lock" size={18} />
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder={t('auth.login.password')}
                  {...register('password')}
                />
              </div>
              {errors.password && <small>{errors.password.message}</small>}
            </label>
            {/* CF Turnstile widget：挂在密码框与提交按钮之间 */}
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
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {t('auth.login.submit')}
            </button>
          </form>
          <p className="auth-switch">
            还没有账号？<Link to="/register">注册</Link>
          </p>
        </div>
      </section>

      <style>{`
        /* 左栏 min 500→380：921-1000px 视口(含滚动条)两栏不再溢出；≥980 布局与断点均不变(1280 下 min 不参与分配，与现状逐像素一致) */
        .auth-page{min-height:100%;display:grid;grid-template-columns:minmax(380px,1.08fr) minmax(420px,.92fr);background:var(--color-bgPrimary,#FAFAFA);color:var(--color-textSecondary)}
        .auth-intro{height:100%;display:flex;flex-direction:column;justify-content:center;padding:58px clamp(48px,6vw,88px);background:var(--color-bgSecondary,#F7F7F7)}
        .intro-badge{display:inline-flex;align-self:flex-start;align-items:center;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:999px;background:var(--color-bgPrimary,#FAFAFA);padding:6px 13px;color:var(--color-textTertiary);font-size:12.5px;font-weight:600}
        .auth-intro h1{max-width:600px;margin:26px 0 0;font-family:var(--font-serif);font-size:clamp(30px,3.2vw,40px);line-height:1.25;font-weight:600;letter-spacing:.01em;color:var(--color-textPrimary,#1B1B1B)}
        .auth-intro p{max-width:520px;margin:16px 0 0;color:var(--color-textTertiary);font-size:16.5px;line-height:1.75}
        .intro-steps{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}
        .intro-steps span{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:999px;background:var(--color-bgPrimary,#FAFAFA);padding:9px 15px;color:var(--color-textTertiary);font-size:13px;font-weight:600}
        .intro-steps .material-symbol{color:var(--color-textTertiary)}
        .dynamic-copy{height:30px;display:flex;align-items:baseline;gap:12px;margin-top:30px;color:var(--muted-2,#8F8F8F)}
        .dynamic-kicker{font-size:12px;letter-spacing:.16em}
        .dynamic-copy strong{display:inline-block;min-width:104px;font-family:var(--font-serif);color:var(--color-foreground,#1B1B1B);font-size:20px;font-weight:600}
        .dynamic-word{animation:dynamic-word-in .24s ease}
        @keyframes dynamic-word-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
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
        @media(max-width:920px){.auth-page{grid-template-columns:1fr}.auth-intro{display:none}.auth-main{min-height:100%;padding:32px 20px}}
        /* ≤480 手机：卡片 padding 收窄、卡片标题降一档(22→20) */
        @media(max-width:480px){.auth-card{padding:24px 16px}.card-head h2{font-size:20px}}
        @media(prefers-reduced-motion:reduce){.dynamic-word,.login-dots i{animation:none}}
        .turnstile-wrap{margin-bottom:16px;display:flex;justify-content:center}
        .auth-switch{text-align:center;margin-top:18px;font-size:13.5px;color:var(--color-textTertiary)}
        .auth-switch a{color:var(--color-foreground,#1B1B1B);font-weight:600;text-decoration:none;margin-left:4px}
        .auth-switch a:hover{text-decoration:underline}
      `}</style>
    </div>
  )
}
