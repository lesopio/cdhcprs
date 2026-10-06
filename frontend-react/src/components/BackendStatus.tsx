/**
 * 后端健康状态指示器（迁移自 Vue BackendStatus.vue）
 *
 * 固定右下角的 pill：每 30s 拉 /api/health，绿点/红点 + 悬停展开文字。
 */
import { useEffect, useRef, useState } from 'react'
import api from '@/api'

const HEALTH_CHECK_INTERVAL = 30000

export default function BackendStatus() {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null)
  const [lastCheck, setLastCheck] = useState<Date | null>(null)
  const [expanded, setExpanded] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        await api.get('/api/health', { timeout: 5000 })
        if (!cancelled) setIsHealthy(true)
      } catch {
        if (!cancelled) setIsHealthy(false)
      } finally {
        if (!cancelled) setLastCheck(new Date())
      }
    }
    void check()
    timerRef.current = window.setInterval(check, HEALTH_CHECK_INTERVAL)
    return () => {
      cancelled = true
      window.clearInterval(timerRef.current)
    }
  }, [])

  const tooltip = isHealthy
    ? `后端正常 · 上次检查 ${lastCheck ? lastCheck.toLocaleTimeString() : '--'}`
    : `后端异常 · 上次检查 ${lastCheck ? lastCheck.toLocaleTimeString() : '--'}`

  return (
    <div
      className={`backend-status${expanded ? ' expanded' : ''}${isHealthy === false ? ' status-error' : ''}`}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      title={tooltip}
    >
      <span className={`status-dot ${isHealthy === false ? 'status-unhealthy' : 'status-healthy'}`} />
      {expanded && (
        <span className="status-text">
          {isHealthy === false ? '后端连接异常' : '后端正常'}
        </span>
      )}
      <style>{`
        .backend-status{position:fixed;right:24px;bottom:24px;z-index:1000;display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:var(--color-surface);border:1px solid var(--color-borderPrimary);box-shadow:var(--shadow-float);transition:all .2s}
        .backend-status.expanded{padding-right:16px}
        .status-dot{width:10px;height:10px;border-radius:50%;position:relative;flex:0 0 10px}
        .status-dot::before{content:'';position:absolute;inset:0;border-radius:inherit;animation:pulse 2s ease infinite}
        .status-healthy{background:var(--color-success)}
        .status-healthy::before{background:var(--color-success)}
        .status-unhealthy{background:var(--color-danger)}
        .status-unhealthy::before{background:var(--color-danger)}
        @keyframes pulse{0%{transform:scale(1);opacity:.7}70%{transform:scale(2.4);opacity:0}100%{opacity:0}}
        @media (prefers-reduced-motion:reduce){.status-dot::before{animation:none}}
        .status-text{font-size:12px;color:var(--color-textSecondary)}
        .status-error .status-text{color:var(--color-danger)}
        @media(max-width:768px){.backend-status{right:12px;bottom:12px}}
      `}</style>
    </div>
  )
}
