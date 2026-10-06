import { create } from 'zustand'

const LARGE_FONT_MODE_KEY = 'cdhcprs_font_size_mode'
const THEME_MODE_KEY = 'cdhcprs_theme'

/** 四主题（v4 规格 §1）：graphite 石墨（默认，= v3 单色产出）/ paper 暖纸 / spring 春分 / night 夜阑 */
export type ThemeMode = 'graphite' | 'paper' | 'spring' | 'night'
export type FontSizeMode = 'normal' | 'large' | 'extra-large'

/** 主题固定顺序：设置页画廊与 ThemeSwitcher 循环都按此序 */
export const THEME_MODE_ORDER: readonly ThemeMode[] = ['graphite', 'paper', 'spring', 'night']

/** 主题展示元信息（v4 规格 §1/§2）：名称、快捷钮图标、设置页画廊色票与迷你布局示意用色。
 * 色值为各主题 tokens 的「目标值」（规格 §1 字面值）——画廊/示意画的是将切换到的主题，
 * 固定字面值是刻意为之，不随当前主题变化；页面其余颜色一律走 var(--color-*)。 */
export interface ThemeMeta {
  value: ThemeMode
  name: string
  desc: string
  icon: string
  /** 主底 / 侧栏 / 用户气泡 / 主钮（三格色票取 主底·气泡·主钮，示意窗另用侧栏） */
  bg: string
  side: string
  bubble: string
  primary: string
}

export const THEME_META: readonly ThemeMeta[] = [
  { value: 'graphite', name: '石墨', desc: '无彩中性 · 默认', icon: 'contrast',
    bg: '#FAFAFA', side: '#F7F7F7', bubble: '#EDEDED', primary: '#1B1B1B' },
  { value: 'paper', name: '暖纸', desc: '米白暖调 · 克制', icon: 'texture',
    bg: '#FAF9F5', side: '#F0EEE6', bubble: '#F0EEE6', primary: '#1F1E1D' },
  { value: 'spring', name: '春分', desc: '品牌皦玉 · 清雅', icon: 'eco',
    bg: '#FFFFFF', side: '#F4F6F1', bubble: '#EBEEE8', primary: '#12264F' },
  { value: 'night', name: '夜阑', desc: '深色 · 护眼', icon: 'dark_mode',
    bg: '#262626', side: '#1F1F1F', bubble: '#3D3D3D', primary: '#E8E8E8' },
]

const isThemeMode = (v: unknown): v is ThemeMode =>
  v === 'graphite' || v === 'paper' || v === 'spring' || v === 'night'

/** 旧值迁移（v4 规格 §1）：localStorage 里的 modern → graphite、tcm → spring；读出归一化并回写 */
const THEME_LEGACY_MAP: Record<string, ThemeMode> = {
  modern: 'graphite',
  tcm: 'spring',
}

const getInitialThemeMode = (): ThemeMode => {
  const stored = localStorage.getItem(THEME_MODE_KEY)
  if (isThemeMode(stored)) return stored
  // 旧值（modern/tcm）或无效值 → 归一化为四主题之一并回写，保证下次读到的已是新值
  const normalized: ThemeMode = (stored && THEME_LEGACY_MAP[stored]) || 'graphite'
  localStorage.setItem(THEME_MODE_KEY, normalized)
  return normalized
}

const getInitialFontSizeMode = (): FontSizeMode => {
  const stored = localStorage.getItem(LARGE_FONT_MODE_KEY)
  return stored === 'large' || stored === 'extra-large' ? stored : 'normal'
}

interface SettingsState {
  fontSizeMode: FontSizeMode
  themeMode: ThemeMode
  setFontSizeMode: (m: FontSizeMode) => void
  setThemeMode: (m: ThemeMode) => void
  toggleThemeMode: () => void
}

/** 对应 Vue 版 stores/settings.ts（Pinia setup store）
 * 副作用（写 localStorage、改 <html> dataset/class）放在单独的 applyThemeAndFont()
 * 由一个根级 <ThemeAndFontSync /> 组件订阅 store 后在 useEffect 中执行。 */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  fontSizeMode: getInitialFontSizeMode(),
  themeMode: getInitialThemeMode(),

  setFontSizeMode: (m) => set({ fontSizeMode: m }),
  setThemeMode: (m) => set({ themeMode: isThemeMode(m) ? m : get().themeMode }),
  /** 四主题循环（ThemeSwitcher 快捷钮）：graphite → paper → spring → night → graphite */
  toggleThemeMode: () => {
    const order = THEME_MODE_ORDER
    const next = order[(order.indexOf(get().themeMode) + 1) % order.length]
    set({ themeMode: next })
  },
}))

/** 把 store 状态同步到 documentElement（替代 Vue 版的 watch immediate）
 * 由根级 <ThemeAndFontSync /> 组件调用 */
export function applyThemeAndFont() {
  const s = useSettingsStore.getState()
  const html = document.documentElement
  html.dataset.theme = s.themeMode
  localStorage.setItem(THEME_MODE_KEY, s.themeMode)
  localStorage.setItem(LARGE_FONT_MODE_KEY, s.fontSizeMode)
  html.classList.remove('large-font-mode', 'extra-large-font-mode')
  if (s.fontSizeMode === 'large') html.classList.add('large-font-mode')
  if (s.fontSizeMode === 'extra-large') html.classList.add('extra-large-font-mode')
}
