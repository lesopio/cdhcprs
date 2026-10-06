import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/components/MaterialIcon'
import {
  useSettingsStore,
  THEME_META,
  type FontSizeMode,
} from '@/stores/settings'
import { useUserStore } from '@/stores/user'
import { setLocale, type AppLocale } from '@/i18n'

/**
 * 设置页（v4 规格 §2，参考 lobe 设置结构 + vercel 克制）：
 * 居中 720px 单栏；外观（四主题画廊 2×2）/ 字号（三档分段）/ 语言（双语分段）。
 * 全部偏好即时生效（无保存钮），主题写 html[data-theme] + localStorage，刷新保持。
 * 页面自身颜色一律 var(--color-*)（四主题下都成立）；主题卡内的色票/迷你示意
 * 画的是「目标主题」，使用 THEME_META 的固定字面值（见 settings.ts 注释）。
 */

const FONT_MODES: Array<{ value: FontSizeMode; label: string }> = [
  { value: 'normal', label: '标准' },
  { value: 'large', label: '大' },
  { value: 'extra-large', label: '特大' },
]

const LOCALES: Array<{ value: AppLocale; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' },
]

/** 分段控件：#EDEDED 轨道（var(--color-bgTertiary)，石墨下即规格 #EDEDED）+ 白色滑块（var(--color-white)） */
function Segmented<T extends string>({
  value, options, onChange, ariaLabel,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="set-segmented">
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`set-segment${active ? ' active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function Settings() {
  const user = useUserStore((s) => s.user)
  const themeMode = useSettingsStore((s) => s.themeMode)
  const setThemeMode = useSettingsStore((s) => s.setThemeMode)
  const fontSizeMode = useSettingsStore((s) => s.fontSizeMode)
  const setFontSizeMode = useSettingsStore((s) => s.setFontSizeMode)
  const { i18n } = useTranslation()
  const locale = i18n.language as AppLocale

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1>设置</h1>
        <p>外观、字号与语言改动即时生效，偏好保存在本机。</p>
      </header>

      {/* ===== 头像：当前头像预览（账户头像设置入口落点） ===== */}
      <section className="set-section">
        <h2 className="set-section-title">头像</h2>
        <div className="set-card set-row">
          <div className="set-avatar" aria-hidden="true">
            <MaterialIcon name="person" size={30} />
          </div>
          <div className="set-row-copy">
            <strong>{user?.username || '用户'}</strong>
            <small>当前使用账户默认头像（人物图标）。</small>
          </div>
        </div>
      </section>

      {/* ===== 外观：四主题画廊 2×2（点卡即切换） ===== */}
      <section className="set-section">
        <h2 className="set-section-title">外观</h2>
        <div className="set-card">
          <div role="radiogroup" aria-label="选择主题" className="set-theme-grid">
            {THEME_META.map((t) => {
              const active = themeMode === t.value
              return (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`set-theme-card${active ? ' active' : ''}`}
                  onClick={() => setThemeMode(t.value)}
                >
                  <span className="set-theme-check" aria-hidden="true">
                    <MaterialIcon name="check" size={13} />
                  </span>
                  {/* 迷你布局示意：CSS 画的小窗块（侧栏 + 正文行 + 用户气泡 + 主钮） */}
                  <span className="set-mock" style={{ background: t.bg }}>
                    <span className="set-mock-side" style={{ background: t.side }} />
                    <span className="set-mock-main">
                      <span className="set-mock-line" style={{ background: t.primary, opacity: 0.55 }} />
                      <span className="set-mock-bubble" style={{ background: t.bubble }}>
                        <span className="set-mock-bubble-line" style={{ background: t.primary, opacity: 0.35 }} />
                      </span>
                      <span className="set-mock-pill" style={{ background: t.primary }} />
                    </span>
                  </span>
                  <span className="set-theme-name">
                    {t.name}
                    <small>{t.desc}</small>
                  </span>
                  {/* 三格色票：主底 / 气泡 / 主钮 */}
                  <span className="set-swatches" aria-hidden="true">
                    <i style={{ background: t.bg }} title="主底" />
                    <i style={{ background: t.bubble }} title="气泡" />
                    <i style={{ background: t.primary }} title="主钮" />
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {/* ===== 字号：三档分段控件（沿用 setFontSizeMode，随档位整页缩放） ===== */}
      <section className="set-section">
        <h2 className="set-section-title">字号</h2>
        <div className="set-card set-row">
          <div className="set-row-copy">
            <strong>界面字号</strong>
            <small>以 125% 为基准放大，三档即时切换。</small>
          </div>
          <Segmented
            value={fontSizeMode}
            options={FONT_MODES}
            onChange={setFontSizeMode}
            ariaLabel="字号模式"
          />
        </div>
      </section>

      {/* ===== 语言：中文 / English 分段控件（沿用 i18n，刷新保持） ===== */}
      <section className="set-section">
        <h2 className="set-section-title">语言</h2>
        <div className="set-card set-row">
          <div className="set-row-copy">
            <strong>界面语言</strong>
            <small>切换后全站文案即时更新。</small>
          </div>
          <Segmented
            value={locale}
            options={LOCALES}
            onChange={(v) => setLocale(v)}
            ariaLabel="界面语言"
          />
        </div>
      </section>

      <style>{`
        .settings-page{height:100%;overflow-y:auto;background:var(--color-bgPrimary);color:var(--color-textPrimary);
          padding:34px clamp(20px,5vw,70px) 64px}
        .settings-header,.set-section{max-width:720px;margin:0 auto}
        .settings-header h1{margin:0 0 6px;font-size:var(--font-size-2xl);line-height:1.25;
          font-family:var(--font-family-serif);font-weight:650;color:var(--color-textPrimary)}
        .settings-header p{margin:0 0 26px;font-size:var(--font-size-xs);color:var(--color-textTertiary)}
        .set-section{margin-bottom:26px}
        .set-section-title{margin:0 0 9px;font-size:var(--font-size-xs);font-weight:600;
          color:var(--color-textTertiary);letter-spacing:.02em}
        .set-card{background:var(--color-surface);border:1px solid var(--color-borderPrimary);
          border-radius:var(--border-radius-lg);box-shadow:var(--shadow-card);padding:18px}

        /* ===== 头像 ===== */
        .set-avatar{width:60px;height:60px;border-radius:9999px;flex:0 0 60px;
          background:var(--color-primary);color:var(--color-primary-foreground);
          display:grid;place-items:center}

        /* ===== 主题画廊 2×2 ===== */
        .set-theme-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
        .set-theme-card{position:relative;display:flex;flex-direction:column;gap:10px;text-align:left;
          background:var(--color-bgPrimary);border:1px solid var(--color-borderPrimary);
          border-radius:var(--border-radius-md);padding:12px;cursor:pointer;
          transition:border-color var(--transition-fast),box-shadow var(--transition-fast),transform var(--transition-fast)}
        .set-theme-card:hover{border-color:var(--color-borderSecondary);box-shadow:var(--shadow-sm);
          transform:translateY(-1px)}
        .set-theme-card.active{border-color:var(--color-primary);
          box-shadow:0 0 0 1px var(--color-primary),var(--shadow-sm)}
        .set-theme-card:focus-visible,.set-segment:focus-visible{outline:2px solid var(--color-primary);
          outline-offset:2px}
        .set-theme-check{position:absolute;top:9px;right:9px;width:21px;height:21px;border-radius:999px;
          display:grid;place-items:center;background:var(--color-primary);color:var(--color-surface);
          opacity:0;transform:scale(.6);transition:opacity var(--transition-fast),transform var(--transition-fast)}
        .set-theme-card.active .set-theme-check{opacity:1;transform:scale(1)}

        /* 迷你布局示意：色值为目标主题字面值（THEME_META），描边用其主色低透明度 */
        .set-mock{display:flex;height:64px;border-radius:9px;overflow:hidden;flex:none;
          border:1px solid rgba(0,0,0,.06)}
        .set-mock-side{width:24%;flex:none}
        .set-mock-main{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;
          gap:5px;padding:8px 9px}
        .set-mock-line{display:block;height:4px;width:62%;border-radius:2px}
        .set-mock-bubble{display:block;align-self:flex-end;width:74%;border-radius:8px 8px 2px 8px;
          padding:5px 6px}
        .set-mock-bubble-line{display:block;height:3px;width:82%;border-radius:2px}
        .set-mock-pill{display:block;align-self:flex-end;width:42%;height:11px;border-radius:999px;margin-top:1px}

        .set-theme-name{display:flex;flex-direction:column;gap:1px;font-size:var(--font-size-sm);
          font-weight:650;color:var(--color-textPrimary);line-height:1.3}
        .set-theme-name small{font-size:var(--font-size-xs);font-weight:400;color:var(--color-textTertiary)}
        /* 三格色票：主底/气泡/主钮；固定 8% 黑 hairline 描出浅色票边缘（色票为目标主题字面值） */
        .set-swatches{display:flex;gap:6px}
        .set-swatches i{width:22px;height:22px;border-radius:6px;
          box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}

        /* ===== 分段控件：#EDEDED 轨道（var(--color-bgTertiary)）+ 白色滑块（var(--color-white)）
           滑块底为四主题恒值纯白，字色恒配纯黑（var(--color-black)）——
           不随 --color-textPrimary（night 为 #E8E8E8，白底上不可读） ===== */
        .set-segmented{display:inline-flex;gap:2px;padding:3px;border-radius:999px;flex:none;
          background:var(--color-bgTertiary)}
        .set-segment{border:0;background:transparent;border-radius:999px;min-width:64px;
          padding:6px 18px;font-size:var(--font-size-xs);font-weight:400;cursor:pointer;
          color:var(--color-textSecondary);
          transition:background var(--transition-fast),color var(--transition-fast),box-shadow var(--transition-fast)}
        .set-segment:hover{color:var(--color-textPrimary)}
        .set-segment.active{background:var(--color-white);color:var(--color-black);
          font-weight:650;box-shadow:0 1px 3px rgba(0,0,0,.08)}

        /* 字号/语言行：左说明右分段，移动端纵排 */
        .set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
        .set-row-copy{min-width:0}
        .set-row-copy strong{display:block;font-size:var(--font-size-sm);font-weight:650;
          color:var(--color-textPrimary)}
        .set-row-copy small{display:block;margin-top:2px;font-size:var(--font-size-xs);
          color:var(--color-textTertiary)}

        /* 移动端：单列纵排（画廊仍 2×2，行块纵向堆叠、分段控件撑满） */
        @media (max-width:680px){
          .settings-page{padding:22px 14px 44px}
          .set-theme-grid{gap:9px}
          .set-mock{height:56px}
          .set-row{flex-direction:column;align-items:stretch}
          .set-segmented{display:flex;width:100%}
          .set-segment{flex:1;min-width:0;padding:7px 10px}
        }
        @media (max-width:420px){
          .set-theme-grid{grid-template-columns:1fr}
          .set-mock{height:64px}
        }
        @media (prefers-reduced-motion:reduce){
          .set-theme-card,.set-theme-check,.set-segment{transition:none}
        }
        /* 打印：解除页内滚动锁定（壳层 print 规则负责隐藏侧栏/顶栏） */
        @media print{
          .settings-page{height:auto;overflow:visible;background:#fff;padding:0 0 20px}
        }
      `}</style>
    </div>
  )
}
