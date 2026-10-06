/**
 * 登录滑块验证码组件（后端协议见 backend/routers/captcha.py，交互参考 AJ-Captcha 行为验证）。
 *
 * 为什么不用第三方库：校验全部在服务端（HMAC 签发题目 + 一次性票据），前端只负责
 * 画缺口、采集拖动轨迹，纯 CSS + pointer events 即可实现，保持零新依赖。
 *
 * 结构：上 320x60 预览条（按服务端 puzzle_x 画缺口 + 拖动碎片），下 320x44 滑轨
 * （44x44 手柄）。松手把归一化 x 与轨迹 [{t,dx}] POST /api/captcha/verify，
 * 通过后回调 onPass(token)；失败抖动动画 + 自动换题。
 *
 * 样式与登录页同族：中性单色、var(--color-*) 槽位 + 规格值兜底、hairline 边框；
 * 加载态用三点跳动（thinking-dots 同款节奏），不用旋转图标。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import MaterialIcon from '@/components/MaterialIcon'
import api from '@/api'

const TRACK_W = 320            // 滑轨/预览条宽度（px）
const PREVIEW_H = 60           // 预览条高度
const TRACK_H = 44             // 滑轨高度
const HANDLE = 44              // 手柄边长
const PIECE = 28               // 缺口/碎片边长
const MAX_DX = TRACK_W - HANDLE // 手柄可移动距离（归一化分母）

interface Challenge {
  challenge_id: string
  puzzle_x: number
  sig: string
  ttl: number
}

type Status = 'loading' | 'ready' | 'dragging' | 'verifying' | 'passed' | 'failed'

export default function SliderCaptcha({ onPass }: { onPass: (token: string) => void }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [dx, setDx] = useState(0)
  const [hint, setHint] = useState('')
  // 拖动会话状态放 ref：pointermove 高频触发，避免依赖 state 造成闭包取旧值
  const drag = useRef<{ startX: number; t0: number; dx: number; track: Array<{ t: number; dx: number }> } | null>(null)

  const loadChallenge = useCallback(async () => {
    setStatus('loading')
    setDx(0)
    setHint('')
    try {
      const { data } = await api.get<Challenge>('/api/captcha/challenge')
      setChallenge(data)
      setStatus('ready')
    } catch {
      setChallenge(null)
      setHint('验证码加载失败')
      setStatus('ready') // 允许直接点刷新重试
    }
  }, [])

  useEffect(() => {
    void loadChallenge()
  }, [loadChallenge])

  const verify = useCallback(
    async (normX: number, track: Array<{ t: number; dx: number }>) => {
      if (!challenge) return
      setStatus('verifying')
      try {
        const { data } = await api.post<{ token: string }>('/api/captcha/verify', {
          challenge_id: challenge.challenge_id,
          sig: challenge.sig,
          x: Number(normX.toFixed(4)),
          track,
        })
        // 手柄停在松手处，预览条碎片由 pieceLeft 对齐"落进"缺口
        setStatus('passed')
        onPass(data.token)
      } catch (error) {
        const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        setHint(detail || '验证失败，请重试')
        setStatus('failed')
        // 抖动动画结束后自动换题（旧题失败计数在后端累加，继续用大概率被作废）
        window.setTimeout(() => void loadChallenge(), 680)
      }
    },
    [challenge, onPass, loadChallenge],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (status !== 'ready' || !challenge) return
    // 捕获指针：拖出组件范围也能持续收到 move/up，移动端同时阻止页面滚动
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, t0: performance.now(), dx: 0, track: [{ t: 0, dx: 0 }] }
    setStatus('dragging')
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || status !== 'dragging') return
    const next = Math.max(0, Math.min(MAX_DX, e.clientX - d.startX))
    d.dx = next
    d.track.push({ t: Math.round(performance.now() - d.t0), dx: next })
    setDx(next)
  }

  const onPointerUp = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (status !== 'dragging') return
    if (d.dx < 6) {
      // 位移过小视为误触：回弹不校验，不浪费后端尝试次数
      setDx(0)
      setStatus('ready')
      return
    }
    void verify(d.dx / MAX_DX, d.track)
  }

  const ratio = dx / MAX_DX
  const notchLeft = (challenge?.puzzle_x ?? 0.5) * (TRACK_W - PIECE)
  const pieceLeft = status === 'passed' ? notchLeft : ratio * (TRACK_W - PIECE)

  return (
    <div className={`slider-captcha sc-${status}`}>
      <div className="sc-preview">
        {/* 缺口：半透明圆角块 + 虚线边，位置由服务端下发的 puzzle_x 决定 */}
        {challenge && status !== 'passed' && (
          <span className="sc-notch" style={{ left: notchLeft }} aria-hidden="true" />
        )}
        {/* 碎片：随拖动同步平移，通过后落进缺口 */}
        {challenge && status !== 'loading' && (
          <span className={`sc-piece${status === 'passed' ? ' sc-piece-ok' : ''}`} style={{ left: pieceLeft }} aria-hidden="true" />
        )}
        <button type="button" className="sc-refresh" aria-label="刷新验证码" disabled={status === 'loading' || status === 'passed'} onClick={() => void loadChallenge()}>
          <MaterialIcon name="refresh" size={15} />
        </button>
      </div>

      <div className="sc-track">
        <span className={`sc-label${status === 'failed' ? ' sc-label-error' : ''}`}>
          {status === 'loading' && (
            <span className="sc-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
          {status !== 'loading' &&
            (status === 'failed'
              ? hint || '验证失败，请重试'
              : status === 'verifying'
                ? '校验中…'
                : status === 'passed'
                  ? '验证通过'
                  : '按住滑块，拖动完成验证')}
        </span>
        {status !== 'passed' && (
          <div
            className="sc-handle"
            role="slider"
            aria-label="滑块验证"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            style={{ left: dx }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <MaterialIcon name={status === 'ready' && dx > 0 ? 'east' : 'drag_indicator'} size={18} />
          </div>
        )}
        {status === 'passed' && (
          <div className="sc-handle sc-handle-ok">
            <MaterialIcon name="check" size={18} />
          </div>
        )}
      </div>

      <style>{`
        .slider-captcha{width:${TRACK_W}px;max-width:100%;margin:0 auto 16px;user-select:none}
        .sc-preview{position:relative;height:${PREVIEW_H}px;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:10px;overflow:hidden;background:var(--color-bgSecondary,#F7F7F7) repeating-linear-gradient(-45deg,transparent 0 10px,rgba(0,0,0,.022) 10px 20px);margin-bottom:8px}
        .sc-notch{position:absolute;top:50%;width:${PIECE}px;height:${PIECE}px;transform:translateY(-50%);border:1.5px dashed var(--muted-2,#8F8F8F);border-radius:8px;background:rgba(0,0,0,.05)}
        .sc-piece{position:absolute;top:50%;width:${PIECE}px;height:${PIECE}px;transform:translateY(-50%);border-radius:8px;background:var(--color-foreground,#1B1B1B);opacity:.16;border:1px solid rgba(0,0,0,.14);transition:opacity .16s ease}
        .sc-piece-ok{opacity:.85;border-color:transparent}
        .sc-refresh{position:absolute;top:5px;right:5px;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:8px;background:var(--color-surface,#FFFFFF);color:var(--muted-2,#8F8F8F);cursor:pointer;transition:color .16s ease,border-color .16s ease}
        .sc-refresh:hover{color:var(--color-textPrimary,#1B1B1B);border-color:var(--color-foreground,#1B1B1B)}
        .sc-refresh:disabled{opacity:.45;cursor:not-allowed}
        .sc-track{position:relative;height:${TRACK_H}px;border:1px solid var(--color-borderPrimary,#E5E5E5);border-radius:10px;background:var(--color-surface,#FFFFFF);overflow:hidden}
        .sc-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--muted-2,#8F8F8F);font-size:12.5px;font-weight:600;letter-spacing:.02em;pointer-events:none}
        .sc-label-error{color:var(--color-danger)}
        .sc-handle{position:absolute;top:0;width:${HANDLE}px;height:${HANDLE}px;display:flex;align-items:center;justify-content:center;border-radius:9px;background:var(--color-foreground,#1B1B1B);color:var(--color-background,#FAFAFA);cursor:grab;touch-action:none;box-shadow:0 1px 2px rgba(0,0,0,.08)}
        .sc-handle:active{cursor:grabbing}
        .sc-handle-ok{left:${MAX_DX}px !important;background:var(--color-foreground,#1B1B1B);cursor:default}
        .sc-dots{display:inline-flex;align-items:center;gap:4px}
        .sc-dots i{width:5px;height:5px;border-radius:9999px;background:currentColor;animation:sc-dot-bounce 1.4s ease-in-out infinite}
        .sc-dots i:nth-child(2){animation-delay:.15s}
        .sc-dots i:nth-child(3){animation-delay:.3s}
        @keyframes sc-dot-bounce{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
        .sc-failed .sc-track{animation:sc-shake .5s ease;border-color:var(--color-danger)}
        @keyframes sc-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
        @media(prefers-reduced-motion:reduce){.sc-failed .sc-track,.sc-dots i{animation:none}}
      `}</style>
    </div>
  )
}
