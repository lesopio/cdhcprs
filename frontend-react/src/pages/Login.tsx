/**
 * 登录页 —— 中性单色系统（docs/ui-spec-v3-monochrome.md §3「登录/首页」）：
 * 中性底 + 侧栏同族浅灰介绍栏 + 白卡 hairline + 衬线标题 + 近黑主按钮（hover #3D3D3A）。
 * 骨架零彩色：焦点环/强调文字一律近黑，彩色只留 danger 红（校验错误）与 logo 图片本身。
 * 加载态按规格 §2 用 thinking-dots（vercel 参考三点跳动 1.4s），不用无限旋转图标。
 * 用 react-hook-form + zod 替代手写校验，GSAP 入场动画保留等价。
 * 不套 AppShell（独立两栏布局）。颜色一律 var() 消费 tokens 槽位，规格关键值以
 * var(槽位, 规格hex) 兜底（同 shell.css 新问诊按钮先例），不新增硬编码品牌色。
 */
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { gsap } from 'gsap'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/components/MaterialIcon'
import SliderCaptcha from '@/components/SliderCaptcha'
import { notify } from '@/lib/toast'
import { authAPI } from '@/api/auth'
import { useUserStore } from '@/stores/user'
import api from '@/api'

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
  // 滑块验证码：captchaEnabled 由 /api/public/settings.captcha_available 决定（管理端开关）；
  // captchaToken 是验证通过后的一次性票据；epoch 用于登录失败后强制重挂组件重新验证（票据已消耗）
  const [captchaEnabled, setCaptchaEnabled] = useState(false)
  // 滑块弹窗制：点登录 → 弹出独立滑块弹窗 → 拖动到位（服务端签发哈希票据）自动续登
  const [captchaOpen, setCaptchaOpen] = useState(false)
  const [captchaEpoch, setCaptchaEpoch] = useState(0)
  // 待验证的表单值（弹窗通过后用它真正发起登录）
  const pendingRef = useRef<{ username: string; password: string } | null>(null)
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

  /** 真正发起登录（滑块通过拿到一次性哈希票据后调用；未开验证码时直接进） */
  const doLogin = async (values: { username: string; password: string }, captchaToken?: string) => {
    setLoading(true)
    try {
      const { data: tokenData } = await authAPI.login(values.username, values.password, captchaToken)
      userStore.setToken(tokenData.access_token)
      const { data: user } = await authAPI.getCurrentUser()
      userStore.setUser(user)
      notify.success('登录成功')
      // 还原未登录前发起的问诊（Home 带 redirect/q/mode 过来），仅允许站内路径
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
      // 验证票据是一次性的（无论登录成败都作废）：清空并重挂滑块，让用户重新验证
      if (captchaEnabled) {
        setCaptchaOpen(false)
        setCaptchaEpoch((e) => e + 1)
      }
    } finally {
      setLoading(false)
    }
  }

  /** 表单提交入口：开启验证码时先弹滑块（通过后自动续登），未开启直接登录 */
  const onSubmit = handleSubmit(async (values) => {
    if (captchaEnabled) {
      pendingRef.current = values
      setCaptchaEpoch((e) => e + 1) // 每次打开弹窗都取新题（旧题/旧票据可能已过期或被消费）
      setCaptchaOpen(true)
      return
    }
    await doLogin(values)
  })

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/public/settings')
      .then(({ data }) => {
        if (cancelled) return
        if (data?.website_name) setWebsiteName(data.website_name)
        // 管理端开启滑块验证码时登录页才渲染验证组件（拉取失败按未开启处理，与 website_name 同口径）
        if (data?.captcha_available) setCaptchaEnabled(true)
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
            {/* 滑块验证码：挂在密码框与提交按钮之间；未通过时禁用提交（后端同样强校验，双保险） */}

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
        </div>
      </section>

      {/* 滑块验证独立弹窗：点登录后弹出，拖动到位（服务端签发一次性哈希票据）自动续登；
          取消/失败关闭后需重新走验证（票据一次性，用后即焚） */}
      {captchaOpen && (
        <div
          className="captcha-mask"
          role="dialog"
          aria-modal="true"
          aria-label="安全验证"
          onClick={(e) => { if (e.target === e.currentTarget) setCaptchaOpen(false) }}
        >
          <div className="captcha-modal">
            <div className="captcha-modal-head">
              <span className="captcha-modal-title">安全验证</span>
              <button type="button" className="captcha-modal-close" aria-label="关闭" onClick={() => setCaptchaOpen(false)}>
                ×
              </button>
            </div>
            <p className="captcha-modal-hint">请按住滑块拖动到缺口位置，完成拼图验证</p>
            <div className="captcha-scroll">
              <SliderCaptcha
                key={captchaEpoch}
                onPass={(token) => {
                  setCaptchaOpen(false)
                  const pending = pendingRef.current
                  if (pending) void doLogin(pending, token)
                }}
              />
            </div>
          </div>
        </div>
      )}

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
        /* ≤480 手机：卡片 padding 收窄、卡片标题降一档(22→20)；弹窗内滑块解除组件自身 max-width:100% 压缩，
           保持 320px 真实滑轨（组件 JS 按 320px 计算缺口/手柄），超宽由 .captcha-scroll 横向滚动兜底 */
        @media(max-width:480px){.auth-card{padding:24px 16px}.card-head h2{font-size:20px}.captcha-modal .captcha-scroll .slider-captcha{max-width:none}}
        @media(prefers-reduced-motion:reduce){.dynamic-word,.login-dots i{animation:none}}
              /* 滑块验证独立弹窗：遮罩 + 居中卡片，mono 风格同登录页 */
        .captcha-mask{position:fixed;inset:0;z-index:120;display:grid;place-items:center;background:color-mix(in srgb,var(--color-bgPrimary,#000) 45%,transparent);backdrop-filter:blur(3px)}
        .captcha-modal{width:min(92vw,380px);background:var(--color-surface,#fff);border:1px solid var(--mono-hairline,#E5E5E5);border-radius:16px;box-shadow:var(--mono-shadow-composer,0 12px 34px rgba(0,0,0,.14));padding:18px 18px 22px}
        .captcha-modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
        .captcha-modal-title{font-size:15px;font-weight:700;color:var(--color-textPrimary)}
        .captcha-modal-close{border:0;background:transparent;font-size:22px;line-height:1;color:var(--color-textTertiary);cursor:pointer;padding:2px 6px;border-radius:8px}
        .captcha-modal-close:hover{background:var(--mono-hover,#F0F0F0);color:var(--color-textPrimary)}
        .captcha-modal-hint{margin:0 0 12px;font-size:12.5px;color:var(--color-textTertiary)}
        /* 手机适配：.captcha-scroll 容器宽 100%，内容超宽（视口 <~387px 时弹窗内容 <320px）横向滚动兜底；
           滑块保持组件 320px 真实滑轨几何（后端按 320px 滑轨校验，容差 ±0.05），不压缩滑轨 */
        .captcha-modal .captcha-scroll{max-width:100%;overflow-x:auto}
        .captcha-modal .captcha-scroll .slider-captcha{margin:0 auto}
        /* ≤979 触控宽度：关闭按钮可点区域扩到 44x44；负 margin 抵消尺寸增长，行高与视觉位置不变 */
        @media(max-width:979px){.captcha-modal-close{min-width:44px;min-height:44px;box-sizing:border-box;padding:0;margin:-9px -9px;display:grid;place-items:center;position:relative;z-index:1}}
      `}</style>
    </div>
  )
}
