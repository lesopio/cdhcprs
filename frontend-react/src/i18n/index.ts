import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './zh-CN.json'
import enUS from './en-US.json'

export type AppLocale = 'zh-CN' | 'en-US'

const STORAGE_KEY = 'cdhcprs_locale'
const DEFAULT_LOCALE: AppLocale = 'zh-CN'

const getInitialLocale = (): AppLocale => {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  const stored = window.localStorage.getItem(STORAGE_KEY) as AppLocale | null
  return stored === 'zh-CN' || stored === 'en-US' ? stored : DEFAULT_LOCALE
}

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: getInitialLocale(),
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false },
})

export const availableLocales: Array<{ label: string; value: AppLocale }> = [
  { label: zhCN.language.zhCN, value: 'zh-CN' },
  { label: enUS.language.enUS, value: 'en-US' },
]

export const setLocale = (locale: AppLocale) => {
  i18n.changeLanguage(locale)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, locale)
  }
}

export const currentLocale = (): AppLocale => i18n.language as AppLocale

export default i18n
