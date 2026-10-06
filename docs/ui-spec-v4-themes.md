# UI 规格 v4：多主题系统 + 设置页（基于 v3 单色系统之上）

> 前提：v3（docs/ui-spec-v3-monochrome.md）已把骨架换成无彩中性系统——它成为四套主题中的默认「石墨」。
> 需求：四套主题在设置页可切换；设置页本身按参考级质感重做。
> 参考源码（高星）：`ui-references/vercel-chatbot`（21k★）、`ui-references/chatbot-ui`（33k★）、`ui-references/lobe-global.ts`（lobehub 83k★ 的全局样式节选）。
> 红线不变：图标真实图形；功能不丢；不新增 npm 依赖；125% 字号基准与三档字号模式不动。

## 1. 主题架构

- 变量分层：`tokens.css` 里结构性 token（圆角/阴影/缓动/字体）留在 `:root`；**颜色 token 全部下沉到 `[data-theme='…']` 选择器**。现有消费方式（组件里 var(--color-*)）不变，切主题 = 换 `html[data-theme]`。
- `stores/settings.ts`：`ThemeMode` 扩为 `'graphite' | 'paper' | 'spring' | 'night'`；`applyThemeAndFont()` 照旧写 `html.dataset.theme` + localStorage（key 不变）；**旧值迁移**：存了 `modern` → 映射 `graphite`，`tcm` → 映射 `spring`（读出时归一化并回写）。
- 四套主题的完整槽位（每套都要给齐 tokens.css 里现有全部颜色变量，缺一个主题下就会漏色）：

### graphite 石墨（默认，= v3 产出）
主底 #FAFAFA / 侧栏 #F7F7F7 / 卡 #FFFFFF / 墨 #1B1B1B / 主钮近黑白字 / hover 黑 5% / 描边 #E5E5E5 / 用户气泡 #EDEDED / 链接 #2F6FA8 / 状态 #3D8A5F / 危险 #C0392B。

### paper 暖纸（Claude 式暖色，克制版）
主底 #FAF9F5 / 侧栏 #F0EEE6 / 卡 #FFFFFF / 墨 #1F1E1D / 次级 #525252→#57534E / 弱化 #8A857C / 描边 #E7E4DB / hover 黑 5% / 激活 #ECE9E1 / 用户气泡 #F0EEE6 / 主钮 #1F1E1D 近黑（保持克制）或 #B26D5D 檀色二选一：**主钮用近黑，檀色只作品牌 symbol 与选中描边** / 链接 #9A6B54 暖调 / 状态 #629A90 / 危险 #C0392B。

### spring 春分（品牌色，克制版）
主底 #FFFFFF / 侧栏 #F4F6F1（皦玉淡化） / 卡 #FFFFFF / 墨 #12264F 骐驶 / 次级 #445B62 / 弱化 #7A8B85 / 描边 #E0E0D0 韶粉 / hover 黑 5% / 激活 #EBEEE8 / 用户气泡 #EBEEE8 / 主钮 #12264F 近黑蓝（品牌墨色当按钮，彩而不腻） / 品牌辅助色只进小件：进度/选中描边可用青雘 #007175、链接青冥 #3271AE、状态青雘、危险朱磦 #C83C3C、品牌 symbol 檀色 #B26D5D。

### night 夜阑（暗色，参考 vercel dark + lobe）
主底 #262626 / 侧栏 #1F1F1F / 卡 #303030 / 墨 #E8E8E8 / 次级 #A3A3A3 / 弱化 #737373 / 描边 #3D3D3D / hover 白 6% / 激活 #3D3D3D / 用户气泡 #3D3D3D / 主钮 #E8E8E8 底 #262626 字（反白）/ 链接 #7CA9D6 / 状态 #5FA97C / 危险 #E07B6C / composer 白改卡色。对比度全部 ≥ 4.5:1。

## 2. 设置页（新建 /settings，参考 lobe 设置的结构与 vercel 的克制）

- 路由 `/settings`（RequireAuth 同其他页）；侧栏导航新增「设置」项（icon: settings，放在患者档案之后）；账户抽屉里的 ThemeSwitcher 保留为快捷循环入口（点一下切到下一套主题，tooltip 说明）。
- 页面结构：居中单栏 max-w 720px；页头衬线标题「设置」；分节（节标题 13px 弱化 + 内容卡）：
  1. **外观**：主题画廊 2×2 卡片——每张卡 = 主题名 + 三格色票（主底/气泡/主钮）+ 迷你布局示意（CSS 画的小窗块），激活卡近黑描边 + 对勾；点卡即切换（立即生效，无需保存钮）。
  2. **字号**：三档（标准/大/特大）沿用现有 setFontSizeMode，呈现为分段控件（segmented）。
  3. **语言**：中文/English 沿用 i18n，分段控件。
- 质感：白卡 hairline 描边 + card 阴影；分段控件用 #EDEDED 轨道 + 白色滑块；全部走现有 ui 组件风格。
- 移动端：单列纵排。

## 3. 落地与验收

- 暗色隐患清理：组件内联样式里的硬编码色（hex/rgb）逐个改为 var()（否则切主题漏色）。重点排查 Chat.tsx / TriageFlow / IntakeStepCard / shell.css / ui/* / MarkdownRenderer / CitationList / ActivityTrace / PatientRail / Login / Home / Admin（Admin 不在本轮范围可豁免但记录）。
- 验收口径：
  1. 设置页四主题卡可点、即时生效、刷新后保持（localStorage）。
  2. 四主题逐一切换后：欢迎墙 / 对话流 / 侧栏 / composer / 弹层 无漏色、无低对比不可读（抽查 text/bg 组合）。
  3. 旧值迁移正确（modern→graphite、tcm→spring）。
  4. build + lint 通过；既有功能不回退。
