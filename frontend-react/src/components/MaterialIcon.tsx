import { type CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/**
 * 对应 Vue 版 components/MaterialSymbol.vue
 * 基于 @fontsource/material-symbols-outlined 字体（已在 fonts.css 引入本地 woff2）。
 *
 * 尺寸约定：默认 24px；可用 size prop 或 CSS `--ms-size` 覆盖。
 * `.material-symbol` 字体类已在 styles/fonts.css 定义，会自动读取 `--ms-size`。
 */
export interface MaterialIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  name: string
  /** 像素尺寸（同时设置宽高比无影响，字体本身按 font-size 渲染） */
  size?: number
  /** 自定义 class */
  className?: string
  style?: CSSProperties
}

export default function MaterialIcon({
  name, size, className, style, ...rest
}: MaterialIconProps) {
  const merged = size ? { ...style, '--ms-size': `${size}px` } : style
  return (
    <span
      className={cn('material-symbol', className)}
      style={merged}
      aria-hidden="true"
      {...rest}
    >
      {name}
    </span>
  )
}
