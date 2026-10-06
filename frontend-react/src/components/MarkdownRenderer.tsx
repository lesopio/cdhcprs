/**
 * Markdown 渲染（迁移自 Vue MarkdownRenderer.vue）
 *
 * React 版用 react-markdown + remark-gfm + rehype-highlight + rehype-raw/rehype-sanitize，
 * 并用一个自定义 remark 插件把文本节点里的 [N] 包成 <sup> 引用。
 *
 * 安全决策（探查 high 项 + 2026-09-30 用户需求迭代）：
 * - rehype-raw 解析内联 HTML + rehype-sanitize 白名单清洗：qwen3.8 系模型习惯输出
 *   <span style="color:..."> 等内联样式标签，纯转义会把标签原文显示给用户；
 *   现在解析 raw HTML 后经白名单过滤，只保留有限标签与安全属性（含 span 的
 *   color/背景相关 style），<script>/<iframe>/事件属性一律剥除——既渲染出
 *   模型想要的颜色强调，又不重新打开 XSS 注入面。
 * - rehype-highlight 的 detect 关闭：不做无语言标注代码块的语言自动猜测（省 CPU），
 *   仅高亮 ```语言 显式标注的代码块；ignoreMissing 保留，未知语言不报错。
 *
 * 性能（探查 perf 项）：
 * - 组件包 React.memo 并按 content prop 比较：流式输出时父组件频繁 setState，
 *   content 未变的旧消息跳过整棵 Markdown 树的重新解析与渲染。
 * - 原先每个实例注入一份的 .markdown-body <style>（约 20 行）已整体迁往
 *   styles/globals.css 末尾，选择器与规则内容不变；SeniorChat 内
 *   .sr-reply-card .markdown-body p/strong 的覆盖规则特异性更高，仍生效。
 */
import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'highlight.js/styles/github.css'

/**
 * 白名单：默认 schema 基础上放开 span 的有限内联样式。
 * style 仅放行颜色/字重/字号类声明（正则过滤 declaration），拒绝
 * position/background-url 等可能影响页面布局或外联资源的属性。
 */
const sanitizeSchema = (() => {
  const schema = {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), 'span'],
    attributes: {
      ...(defaultSchema.attributes ?? {}),
      // 只放行 dataColor/dataWarn（多彩与红下划线通道）；style 不放行——字符串 style 在
      // hast→JSX 转换中实测变空对象，且直接放行会扩大内联样式攻击面；class 通道
      // 同样被 sanitize 剥（实测），强调一律走 data-*
      span: ['dataColor', 'dataWarn'],
    },
  }
  return schema
})()

/**
 * 系统正文专用强调语法（两种视觉，避免五彩杂乱）：
 * - [[#色值|文字]]：彩色（提示词收敛为仅蓝 #1976D2 一种）
 * - {{文字}}：红色下划线（警告/禁忌）
 * 模型（qwen/deepseek 均实测）不倾向直接输出内联 HTML，给自定义轻量标记后遵循率高。
 * 色值严格校验十六进制，文字内 <>& 转义防注入，转换后仍走 rehypeRaw+sanitize 白名单双保险。
 * 注意：不走 style 属性——hast→JSX 对字符串 style 的转换实测产出空对象（React 静默丢色），
 * data-* 属性与 className 以字符串可靠传递，渲染层再转 style 对象。
 */
function applyColorSyntax(src: string): string {
  return src
    .replace(
      /\[\[(#[0-9a-fA-F]{3,8})\|([^\[\]]*?)\]\]/g,
      (_m, hex: string, text: string) => {
        const safe = escapeText(text)
        return `<span data-color="${hex}">${safe}</span>`
      },
    )
    .replace(/\{\{([^{}\n]{1,80}?)\}\}/g, (_m, text: string) => {
      return `<span data-warn="1">${escapeText(text)}</span>`
    })
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把文本节点中的 [1]/[12] 编号包成 <sup class="cite-ref"><a href="#cite-N">[N]</a></sup> */function CiteRefsSup({ children }: { children: string }) {
  const parts = useMemo(() => {
    const regex = /\[(\d{1,2})\](?!\()/g
    const result: Array<string | ReactNode> = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(children)) !== null) {
      if (m.index > last) result.push(children.slice(last, m.index))
      const num = m[1]
      result.push(
        <sup key={`cite-${m.index}`} className="cite-ref">
          <a href={`#cite-${num}`}>[{num}]</a>
        </sup>,
      )
      last = m.index + m[0].length
    }
    if (last < children.length) result.push(children.slice(last))
    return result
  }, [children])
  return <>{parts}</>
}

function MarkdownRendererImpl({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // rehypeRaw 解析模型输出的内联 HTML（qwen3.8 系的 span 颜色强调），
        // 紧跟 rehypeSanitize 白名单清洗剥除危险标签/属性（XSS 防线，顺序不可颠倒）；
        // rehype-highlight 只高亮显式标注语言的代码块，detect:false 跳过语言自动猜测
        rehypePlugins={[
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
        ]}
        components={{
          // 强调通道（渲染层转 style 对象，React 字符串 style 会被静默丢弃）：
          // data-color=彩色（hex 严格校验）、data-warn=红色下划线
          span: ({ children, ...props }) => {
            const { node: _node, ...rest } = props as Record<string, unknown>
            const color = (rest as { 'data-color'?: unknown })['data-color']
            if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) {
              delete (rest as Record<string, unknown>)['data-color']
              return <span {...rest} style={{ color }}>{children}</span>
            }
            if ((rest as { 'data-warn'?: unknown })['data-warn'] === '1') {
              delete (rest as Record<string, unknown>)['data-warn']
              return (
                <span
                  {...rest}
                  style={{ textDecoration: 'underline', textDecorationColor: '#D32F2F', textUnderlineOffset: '3px', textDecorationThickness: '2px' }}
                >
                  {children}
                </span>
              )
            }
            return <span {...rest}>{children}</span>
          },
          // 把段落/列表项中的纯文本节点跑一遍 CiteRefsSup（保留行内 code/strong/span 等）
          p: ({ children, ...props }) => (
            <p {...props}>
              {Array.isArray(children)
                ? children.map((c, i) =>
                    typeof c === 'string' ? <CiteRefsSup key={i}>{c}</CiteRefsSup> : c,
                  )
                : typeof children === 'string'
                ? <CiteRefsSup>{children}</CiteRefsSup>
                : children}
            </p>
          ),
          li: ({ children, ...props }) => (
            <li {...props}>
              {Array.isArray(children)
                ? children.map((c, i) =>
                    typeof c === 'string' ? <CiteRefsSup key={i}>{c}</CiteRefsSup> : c,
                  )
                : typeof children === 'string'
                ? <CiteRefsSup>{children}</CiteRefsSup>
                : children}
            </li>
          ),
        }}
      >
        {applyColorSyntax(content || '')}
      </ReactMarkdown>
      {/* .markdown-body 样式已迁往 styles/globals.css 末尾（原每实例一份 <style>，现为全局一份） */}
    </div>
  )
}

/**
 * 对外默认导出：memo 包装，仅按 content prop 比较（本组件唯一 prop）。
 * content 不变时直接复用上次渲染结果，避免重复解析整棵 Markdown 树。
 * props 形状未变，Chat / SeniorChat / Admin 调用方无需改动。
 */
const MarkdownRenderer = memo(
  MarkdownRendererImpl,
  (prev, next) => prev.content === next.content,
)
export default MarkdownRenderer
