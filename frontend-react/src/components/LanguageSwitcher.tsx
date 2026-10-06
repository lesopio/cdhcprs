import { useTranslation } from 'react-i18next'
import { availableLocales, setLocale, type AppLocale } from '@/i18n'

/** 对应 Vue 版 components/LanguageSwitcher.vue */
export default function LanguageSwitcher() {
  const { i18n: i18nInstance } = useTranslation()
  const current = i18nInstance.language as AppLocale

  return (
    <select
      value={current}
      onChange={(e) => setLocale(e.target.value as AppLocale)}
      aria-label="切换语言"
      style={{
        height: 32,
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: 'var(--paper)',
        color: 'var(--ink-strong)',
        fontSize: 12,
        padding: '0 8px',
        cursor: 'pointer',
      }}
    >
      {availableLocales.map((l) => (
        <option key={l.value} value={l.value}>{l.label}</option>
      ))}
    </select>
  )
}
