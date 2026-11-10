/**
 * 放大阅读（dsh-read-zoom）— DSH 插件（浏览器半）。
 *
 * 解决：会话里助手回答的正文字号偏小，长时间阅读眼睛累。
 * 做法：不碰 React 组件树、不改 app.asar，只做 DOM 增强——
 *   1) 【主入口】每条回答底部那排操作图标（复制 / 点赞 / 分支 / 用量 / 时间）里，
 *      在「用量」图标左边常驻一个「放大阅读」按钮（位置固定，不随鼠标漂移）；
 *   2) 浮层内容 = 这条消息 DOM 的克隆（公式 / 表格 / 代码 / 图片的渲染结果原样保留，
 *      包括 KaTeX），再用 CSS `zoom` 整体等比放大；
 *   3) 浮层顶栏 A− / 百分比（点击重置）/ A+ / 复制文字 / 关闭，Esc、点蒙层也能关；
 *   4) 键盘 Alt+Z / Alt+E 直接放大「离视口最近的那条回答」；右下角常驻一个 Aa 小按钮
 *      （固定位置，同样是放大最近一条回答），保证功能可发现。
 *
 * v0.2.1 起移除了「鼠标悬停时浮出药丸」的行为：药丸会跟着消息/滚动漂移，
 * 干扰阅读；入口改为操作行里的常驻按钮。
 * v0.2.2 修「切换会话后放大面板显示上一个会话的回答」：定位回答不再按整页文档顺序，
 * 而是先锁定当前会话容器（data-conversation-session），再按轮次（data-chat-turn）匹配。
 * v0.3.0 面板改成双栏：
 *   - 左栏是本会话的「轮次列表」（每轮一条，带提问摘要），点一下就切换到那一轮的提问+回答；
 *     底部还有一个输入框，可以把想法先写好，点「填入输入框」写回 DSH 的真实输入框（不自动发送）；
 *   - 右栏是放大后的正文，长公式会自动等比缩小到放得下，渲染失败的公式降级成可读的原始写法；
 *   - 顶栏多一个「公式规约」按钮，一键复制数学/化学输出规约（可粘进 AGENTS.md）。
 *
 * 放大倍数记在 localStorage（键 dsh-read-zoom:zoom），默认 140%。
 * v0.3.3 加了两件事：
 *   - 打开 / 关闭不再「啪」地出现：遮罩淡入淡出、面板轻微上浮（只动 opacity/transform，
 *     由合成器处理，不触发布局与重绘；系统开启「减少动态效果」时自动跳过动画）；
 *   - 快捷键补一个更好记的 Alt+E（与 Alt+Z 等价，打开/关闭最近一条回答）。
 * 纯 DOM 实现，因此 DSH 前端升级后只要消息里仍带 data-text-interaction-source 就有效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-read-zoom',
  factory: () => {
    const STYLE_ID = 'dsh-read-zoom/style.css'
    const LS_KEY = 'dsh-read-zoom:zoom'
    const DEFAULT_ZOOM = 1.4
    const MIN_ZOOM = 0.8
    const MAX_ZOOM = 3
    const STEP = 0.1
    const HOST_ATTR = 'data-text-interaction-source'
    const GUARD = 'dsh-read-zoom'
    // v0.3.2：操作行按钮的同步函数（安装时赋值），浮层关闭后用它补一次，避免依赖整页 MutationObserver。
    let actionSync = null
    // 版本号：DOM 上会写进 data-dshzr-version，便于在真实 DSH 里确认加载的是哪一版。
    const VERSION = '0.4.0'
    // 每轮回答底部的操作行所在容器（DSH chat 的 TurnTailNodeView 带这个属性）。
    const TAIL_ATTR = 'data-turn-tail'
    // 16px 对角双箭头（放大/展开），药丸与操作行按钮共用；stroke 用 currentColor 跟随主题。
    const EXPAND_ICON =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9.9 2.4h3.7v3.7M13.3 2.7 9.2 6.8M6.1 13.6H2.4V9.9M2.7 13.3l4.1-4.1"/></svg>'

    /**
     * 数学 / 化学输出规约（随插件分发，点顶栏「公式规约」可一键复制）。
     * DSH 前端是 micromark + KaTeX 0.18.7，解析层有几个已知坑，写公式时按这份清单来就不会出红字或吞字。
     */
    const MATH_RULES = [
      '## 数学/公式输出规约（DSH 前端渲染兼容）',
      '',
      '1. 行内公式用 `$...$` 或 `\\(...\\)`；不要在句子中间写 `\\[...\\]`（行内没有 tokenizer，反斜杠会被吞成字面 `[x]`）。',
      '2. 独立公式块用 `$$`：`$$` 必须独占一行开头、独占一行结尾；同一行不要写两个 `$$…$$`（闭合要求接行尾，否则整行被贪婪并成一个公式）。',
      '3. 不要用 `latex` / `tex` 代码围栏装公式；需要隔离时用 math 围栏（三个反引号 + `math`）。',
      '4. 只用 KaTeX 子集：多行对齐用 `aligned`（不是 `align`），矩阵用 `pmatrix`/`bmatrix`；不要用 `\\label`/`\\ref`；`\\tag` 只能用在 display 公式里。',
      '5. 金额里的 `$` 写成 `\\$`（正文里两个未转义的 `$` 会被配成行内公式，把中间文字吞进数学环境）。',
      '6. 表格里的公式含竖线时用 `\\lvert … \\rvert`，不要用裸 `|`（会被 GFM 当单元格分隔符）。',
      '7. 超长公式优先拆成 `aligned` 多行（DSH 里 display 公式只横滚不换行）。',
      '8. 生成过程中公式先显示 TeX 源码、结束后才渲染，这是流式设计，不是错误。',
      '9. 化学式与反应式：DSH 没有 mhchem，`\\ce{}`/`\\pu{}`/`\\SI{}`/`\\qty{}`/`\\unit{}` 必红。',
      '   化学式写成 `\\mathrm{H_2O}`、`\\mathrm{SO_4^{2-}}`、`\\mathrm{CuSO_4 \\cdot 5H_2O}`；',
      '   反应式用 `\\rightarrow` / `\\rightleftharpoons`，条件写成 `\\mathrm{CaCO_3 \\xrightarrow{\\text{高温}} CaO + CO_2}`；',
      '   沉淀/气体写 `\\downarrow` / `\\uparrow`；纯文本段落直接写 Unicode 下标与箭头（H₂O、CO₂ + H₂O → H₂CO₃、SO₄²⁻）最稳。',
    ].join('\n')

    // 轻量调试日志：window.__DSHZR_LOG__ 保留最近 200 条，装到真实 DSH 后排查选择器/事件问题用。
    const LOG = (window.__DSHZR_LOG__ = window.__DSHZR_LOG__ || [])
    function dbg(...parts) {
      try {
        LOG.push(parts.join(' '))
        if (LOG.length > 200) LOG.splice(0, LOG.length - 200)
      } catch (error) {
        /* 调试日志失败不影响功能 */
      }
    }

    /* ── 样式 ──────────────────────────────────────────────────────────── */
    const CSS = [
      /* 回答底部操作行里的「放大阅读」按钮：外观沿用 DSH 原生图标按钮的 class，
         这里只补几条兜底规则，避免 DSH 改版后完全没样式。 */
      '.dshzr-tail-btn{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8a91);',
      'background:0 0;border:none;cursor:pointer;display:inline-flex;align-items:center;',
      'justify-content:center;padding:6px;border-radius:var(--dsw-radius-sm,6px)}',
      '.dshzr-tail-btn svg{width:15px;height:15px;display:block}',
      '.dshzr-tail-btn:hover{color:var(--dsw-alias-label-primary,#191919);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',

      /* 右下角常驻的 Aa 小按钮 */
      '.dshzr-fab{position:fixed;right:16px;bottom:18px;z-index:2147481900;',
      'box-sizing:border-box;width:34px;height:34px;border-radius:50%;cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;padding:0;',
      'font:600 13px/1 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'letter-spacing:-.5px;color:var(--dsw-alias-label-secondary,#6b6b71);',
      'background:var(--dsw-alias-bg-layer-3,#ffffff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'box-shadow:0 2px 10px rgba(0,0,0,.10);opacity:.72;',
      'transition:opacity .15s ease,transform .15s ease,background-color .15s ease}',
      '.dshzr-fab:hover{opacity:1;transform:translateY(-1px);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshzr-fab:focus-visible,.dshzr-pill:focus-visible,.dshzr-btn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary,#8a8a91);outline-offset:2px}',

      /* 全屏阅读浮层 */
      /* v0.3.2：去掉 backdrop-filter:blur()。整屏模糊会让 Chromium 在每次重绘（滚动/输入/打字）
         都重新采样并模糊背后的大段聊天 DOM，是「一卡一卡」的主要来源；纯半透明遮罩几乎零成本。 */
      '.dshzr-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
      'justify-content:center;padding:3vh 3vw;box-sizing:border-box;',
      'background:var(--dsw-alias-bg-mask-1,rgba(16,18,22,.55));',
      /* v0.3.3：进出场过渡只改 opacity/transform（合成器处理，不触发布局与重绘） */
      'opacity:0;transition:opacity .16s ease-out}',
      '.dshzr-backdrop[data-shown]{opacity:1}',
      '.dshzr-panel{display:flex;flex-direction:column;width:min(1280px,96vw);height:min(92vh,940px);',
      'max-height:94vh;contain:layout paint;',
      'box-sizing:border-box;overflow:hidden;',
      'border-radius:var(--dsw-radius-panel,16px);',
      'background:var(--dsw-alias-bg-layer-2,#ffffff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));',
      'box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(0,0,0,.28));',
      'opacity:.65;transform:translateY(10px) scale(.988);',
      'transition:opacity .17s ease-out,transform .2s cubic-bezier(.22,.85,.3,1)}',
      '.dshzr-backdrop[data-shown] .dshzr-panel{opacity:1;transform:none}',
      '@media (prefers-reduced-motion: reduce){',
      '.dshzr-backdrop{transition:none}',
      '.dshzr-panel{transition:none;transform:none;opacity:1}}',
      '.dshzr-main{display:flex;flex:1 1 auto;min-height:0;overflow:hidden}',

      /* 左栏：轮次列表 + 输入框 */
      '.dshzr-turns{width:268px;flex:0 0 268px;display:flex;flex-direction:column;min-height:0;',
      'border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      'background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.dshzr-turns-head{flex:none;padding:10px 12px 6px;',
      'font:500 12px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-turns-list{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 8px 8px}',
      '.dshzr-turn{display:flex;gap:8px;width:100%;box-sizing:border-box;text-align:left;cursor:pointer;',
      'padding:8px 9px;margin:2px 0;border:1px solid transparent;border-radius:10px;background:transparent;',
      'font:400 12.5px/1.45 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-secondary,#6b6b71)}',
      '.dshzr-turn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));',
      'color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-turn[data-active]{background:var(--dsw-alias-bg-layer-3,#ffffff);',
      'border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.10));color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-turn-no{flex:none;min-width:16px;text-align:right;font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-turn-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshzr-compose{flex:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding:8px 10px 10px}',
      '.dshzr-compose textarea{display:block;width:100%;box-sizing:border-box;min-height:64px;max-height:180px;',
      'resize:vertical;padding:7px 9px;border-radius:8px;outline:none;',
      'font:400 12.5px/1.5 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-primary,#191919);background:var(--dsw-alias-bg-layer-2,#fff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}',
      '.dshzr-compose textarea:focus{border-color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-compose-row{display:flex;gap:6px;margin-top:6px}',
      '.dshzr-compose-row .dshzr-btn{height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:var(--dsw-alias-bg-layer-2,#fff)}',
      '.dshzr-compose-row .dshzr-btn[data-primary]{background:var(--dsw-alias-label-primary,#191919);',
      'border-color:transparent;color:var(--dsw-alias-bg-layer-2,#fff)}',
      '.dshzr-compose-note{flex:1 1 auto;align-self:center;text-align:right;',
      'font:400 11px/1.4 var(--dsw-font-family,-apple-system,sans-serif);color:var(--dsw-alias-label-tertiary,#8a8a91)}',

      /* 右栏：正文 */
      '.dshzr-item{position:relative;padding-left:14px}',
      '.dshzr-item[data-kind="user"]{margin-bottom:18px}',
      '.dshzr-item-tag{display:block;margin:0 0 6px;',
      'font:500 11px/1.4 var(--dsw-font-family,-apple-system,sans-serif);letter-spacing:.04em;',
      'color:var(--dsw-alias-label-tertiary,#8a8a91)}',
      '.dshzr-item-body>:first-child{margin-top:0}',
      '.dshzr-item-body>:last-child{margin-bottom:0}',
      '.dshzr-note{margin:6px 0;padding:10px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,#f7f7f8);color:var(--dsw-alias-label-secondary,#6b6b71);',
      'font:400 13px/1.6 var(--dsw-font-family,-apple-system,sans-serif)}',
      '.dshzr-note button{margin-left:10px;height:26px;padding:0 10px;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;',
      'color:var(--dsw-alias-label-primary,#191919);font:500 12px/1 var(--dsw-font-family,-apple-system,sans-serif)}',
      '.dshzr-truncated{display:flex;gap:8px;align-items:flex-start;margin:4px 0 0;padding:12px 14px;',
      'border-radius:10px;border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.2));',
      'background:var(--dsw-alias-bg-layer-1,#fbfbfc);color:var(--dsw-alias-label-secondary,#6b6b71);',
      'font:400 13px/1.7 var(--dsw-font-family,-apple-system,sans-serif)}',
      '.dshzr-truncated .dshzr-truncated-icon{flex:none;font-size:13px;line-height:1.7}',
      '.dshzr-truncated b{display:block;font-weight:600;color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-turn[data-unloaded] .dshzr-turn-text{opacity:.72}',
      '.dshzr-head{display:flex;align-items:center;gap:6px;flex:none;padding:10px 12px 10px 16px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.dshzr-title{font:600 14px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-primary,#191919);flex:none}',
      '.dshzr-hint{font:400 12px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-tertiary,#8a8a91);margin-left:8px;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis}',
      '.dshzr-spacer{flex:1 1 auto;min-width:8px}',
      '.dshzr-btn{box-sizing:border-box;height:28px;min-width:28px;padding:0 9px;border-radius:8px;cursor:pointer;',
      'font:500 12px/1 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-secondary,#6b6b71);background:transparent;border:none;',
      'display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}',
      '.dshzr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-zoom{min-width:52px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#191919)}',
      '.dshzr-close{margin-left:4px}',
      '.dshzr-scroller{flex:1 1 auto;min-width:0;overflow:auto;overscroll-behavior:contain;',
      'contain:layout paint;will-change:scroll-position;',
      'padding:20px 28px 40px;box-sizing:border-box}',
      /* v0.3.2：单轮内容整体做布局/绘制隔离，减少滚动时的重排范围 */
      '.dshzr-content .dshzr-item{contain:layout paint}',
      '.dshzr-content{zoom:1.4;transform-origin:top left;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary)}',
      /* v0.3.7：克隆进来的回答可能背着宿主的入场动画（opacity:0 起步）或折叠态，
         一旦动画不跑就永远停在透明状态——这正是「有字数、看不见」的常见原因。
         阅读区不需要动画，直接强制可见。 */
      '.dshzr-content *{animation:none!important;transition:none!important;opacity:1!important;visibility:visible!important}',
      '.dshzr-content .katex-display{overflow-x:auto;overflow-y:hidden;max-width:100%;padding:2px 0}',
      '.dshzr-content .katex-display > .katex{display:inline-block;transform-origin:left center}',
      '.dshzr-content .katex-error{color:var(--dsw-alias-label-secondary,#6b6b71)!important;',
      'background:var(--dsw-alias-bg-layer-1,#f4f4f6);border-radius:5px;padding:1px 5px;',
      'font:400 .92em/1.5 var(--dsw-font-markdown-code,ui-monospace,SFMono-Regular,Consolas,monospace)!important;',
      'white-space:pre-wrap;word-break:break-word}',
      '.dshzr-content table{max-width:100%}',
      '.dshzr-content button,.dshzr-content [role="button"]{display:none!important}',
      '.dshzr-content p,.dshzr-content li,.dshzr-content h1,.dshzr-content h2,.dshzr-content h3,',
      '.dshzr-content h4,.dshzr-content pre,.dshzr-content blockquote,.dshzr-content table,',
      '.dshzr-content img,.dshzr-content video,.dshzr-content .katex-display{max-width:100%;box-sizing:border-box}',
      '.dshzr-content [class*="actions"]{display:none!important}',
      '.dshzr-content img,.dshzr-content video{height:auto}',
      '.dshzr-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483500;',
      'padding:8px 14px;border-radius:999px;font:500 12px/1.4 var(--dsw-font-family,-apple-system,sans-serif);',
      'color:var(--dsw-alias-label-primary,#191919);background:var(--dsw-alias-toast-bg,rgba(24,26,30,.92));',
      'color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.22);opacity:0;transition:opacity .18s ease}',
      '.dshzr-toast[data-on]{opacity:1}',
      'body.dshzr-noscroll{overflow:hidden!important}',
      '@media (prefers-reduced-motion:reduce){.dshzr-pill,.dshzr-fab,.dshzr-toast{transition:none}}',
    ].join('')

    function installStyle() {
      let tag = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = GUARD
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      return () => {
        if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /* ── 小工具 ────────────────────────────────────────────────────────── */
    function clampZoom(value) {
      const rounded = Math.round(value * 10) / 10
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded))
    }

    function readZoom() {
      try {
        const raw = window.localStorage.getItem(LS_KEY)
        const parsed = raw === null ? NaN : Number.parseFloat(raw)
        if (Number.isFinite(parsed)) return clampZoom(parsed)
      } catch (error) {
        /* localStorage 不可用时用默认值 */
      }
      return DEFAULT_ZOOM
    }

    function writeZoom(value) {
      try {
        window.localStorage.setItem(LS_KEY, String(value))
      } catch (error) {
        /* 忽略：只是记不住偏好 */
      }
    }

    function makeButton(label, title) {
      const node = document.createElement('button')
      node.type = 'button'
      node.className = 'dshzr-btn'
      node.textContent = label
      node.title = title
      node.setAttribute('aria-label', title)
      return node
    }

    function textOf(node) {
      const text = node && typeof node.innerText === 'string' ? node.innerText : node ? node.textContent : ''
      return (text || '').replace(/\n{3,}/g, '\n\n').trim()
    }

    /* ── 找到「一条助手消息」 ──────────────────────────────────────────── */
    // DSH 的消息结构（2026-11 UI）：<div class="xMeOpW_root"><div class="xMeOpW_body"> …块… </div></div>
    // 类名里的 hash 前缀会随构建变化，所以用「_body 的父级是 _root」+ 内部含已收敛 markdown 来识别，
    // 不绑定具体 hash。
    const isBodyToken = (token) => /^[A-Za-z0-9_-]{2,20}_body$/.test(token)
    const isRootToken = (token) => /^[A-Za-z0-9_-]{2,20}_root$/.test(token)

    function tokensOf(node) {
      if (!node || node.nodeType !== 1 || !node.classList) return []
      return Array.prototype.slice.call(node.classList)
    }

    function asMessage(node) {
      if (!node || node.nodeType !== 1) return null
      if (!tokensOf(node).some(isBodyToken)) return null
      const parent = node.parentElement
      if (!parent || !tokensOf(parent).some(isRootToken)) return null
      // 只认「已收敛、含 markdown 的助手回答」；用户气泡、思考块、命令卡都不会命中。
      const hasMarkdown = node.querySelector('[' + HOST_ATTR + '][class*="markdown"]')
      if (!hasMarkdown) return null
      return { root: parent, body: node }
    }

    function messageFor(node) {
      let current = node instanceof Element ? node : null
      for (let depth = 0; current && depth < 12; depth += 1) {
        const found = asMessage(current)
        if (found) return found
        current = current.parentElement
      }
      return null
    }

    /**
     * 收集容器内所有「已收敛的助手回答」。
     * 传 scope 时只在那一块 DOM 里找（一次只看一个会话），不传就是整页。
     */
    function settledMessages(scope) {
      const root = scope && typeof scope.querySelectorAll === 'function' ? scope : document
      const blocks = root.querySelectorAll('[' + HOST_ATTR + '][class*="markdown"]')
      const result = []
      for (const block of blocks) {
        const message = messageFor(block)
        if (message === null) continue
        if (root !== document && !root.contains(message.root)) continue
        if (result.indexOf(message) === -1) result.push(message)
      }
      return result
    }

    /**
     * 当前正在看的那个会话容器。
     * 切换会话时旧会话的 DOM 可能还没卸载，靠「可见 + 可见面积最大」挑出真正在看的那一个。
     */
    function activeScope() {
      const scopes = document.querySelectorAll('[' + SESSION_ATTR + ']')
      let best = null
      let bestArea = 0
      for (const scope of scopes) {
        const rect = scope.getBoundingClientRect()
        if (rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) continue
        const area = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)) * rect.width
        if (area > bestArea) {
          best = scope
          bestArea = area
        }
      }
      return best === null ? document : best
    }

    function isVisible(rect) {
      return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
    }

    /** 视口里最靠下的一条已完成回答；都不在视口里就取当前会话里最后一条。 */
    function nearestMessage() {
      const all = settledMessages(activeScope())
      if (all.length === 0) return null
      for (let index = all.length - 1; index >= 0; index -= 1) {
        const message = all[index]
        if (isVisible(message.root.getBoundingClientRect())) return message
      }
      return all[all.length - 1]
    }

    /* ── 回答底部操作行：在「用量」左边常驻一个放大按钮 ──────────────────── */
    function isBefore(node, reference) {
      if (node === reference) return false
      return (node.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    }

    /* ── 会话 / 轮次归属 ────────────────────────────────────────────────
     * 聊天时间线里每个渲染项都带 data-chat-turn（轮次号），整个会话视图带
     * data-conversation-session（会话 id）。切换会话时旧会话的 DOM 可能还留在文档里，
     * 所以绝不能按「整页文档顺序」取上一条回答 —— 必须在「同一个会话容器 + 同一轮次」里找，
     * 否则就会把上一个会话的回答放大出来。
     */
    const SESSION_ATTR = 'data-conversation-session'
    const TURN_ATTR = 'data-chat-turn'
    const FLOW_KIND_ATTR = 'data-chat-flow-kind'

    function scopeOf(node) {
      const scope = node.closest ? node.closest('[' + SESSION_ATTR + ']') : null
      return scope === null ? document : scope
    }

    function itemOf(node) {
      return node.closest ? node.closest('[' + TURN_ATTR + ']') : null
    }

    /** 一个时间线渲染项里承载的回答（先找已收敛的，流式中没有再放宽）。 */
    function messageIn(item) {
      if (!item || typeof item.querySelector !== 'function') return null
      const block =
        item.querySelector('[' + HOST_ATTR + '][class*="markdown"]') || item.querySelector('[class*="markdown"]')
      return block === null ? null : messageFor(block)
    }

    /**
     * 操作行属于哪一条回答：
     * 0) 操作行已不属于当前正在看的会话（切换会话瞬间的残留行）→ 取当前会话最后一条；
     * 1) 按轮次号，在同一会话容器里找同轮次、位于操作行之前的最后一条回答；
     * 2) 拿不到轮次信息时，退化为「同一会话容器内、文档顺序上最近的一条回答」。
     */
    function messageForTail(tail) {
      const item = itemOf(tail)
      const turn = item === null ? null : item.getAttribute(TURN_ATTR)
      const scope = scopeOf(tail)
      const active = activeScope()
      if (active !== document && scope !== active) {
        const messages = settledMessages(active)
        return messages.length === 0 ? null : messages[messages.length - 1]
      }
      if (turn !== null) {
        let found = null
        for (const candidate of scope.querySelectorAll('[' + TURN_ATTR + ']')) {
          if (candidate === item) continue
          if (candidate.getAttribute(TURN_ATTR) !== turn) continue
          if (candidate.getAttribute(FLOW_KIND_ATTR) === 'turn-tail') continue
          if (!isBefore(candidate, tail)) continue
          const message = messageIn(candidate)
          if (message !== null) found = message
        }
        if (found !== null) return found
        // 这一轮在 DOM 里没有可定位的回答节点（典型：输出被截断/已停止，只剩提问）。
        // 交给调用方按轮次打开，避免回退到「上一轮的回答」而张冠李戴。
        return null
      }
      let fallback = null
      for (const message of settledMessages(scope)) {
        if (isBefore(message.root, tail)) fallback = message
        else break
      }
      return fallback
    }

    /** 操作行结构：<div class="…_actions"><button…/>…<span class="…_endInfo">{用量}{时间}</span></div> */
    function findRow(tail) {
      const row = tail.querySelector('div[class*="_actions"]')
      if (row === null) return null
      const endInfo = row.querySelector('[class*="_endInfo"]')
      return { row, endInfo }
    }

    function createTailButton(row) {
      // 复用原生图标按钮的 class：尺寸、悬停底色、深色主题全部跟宿主一致。
      const sample = row.querySelector('button[class*="_action"]')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = (sample === null ? '' : sample.className + ' ') + 'dshzr-tail-btn'
      button.title = '放大阅读这条回答（v' + VERSION + '，Alt+Z / Alt+E）'
      button.setAttribute('aria-label', '放大阅读这条回答')
      button.setAttribute('data-dshzr-tail', '')
      button.setAttribute('data-dshzr-version', VERSION)
      button.innerHTML = EXPAND_ICON
      return button
    }

    /**
     * 轮流插入按钮，并盯着 DOM 变化（流式输出 / 切换会话时会整块重渲染）。
     * 幂等：已经在本行的按钮不会重复插入。
     * 优先插在 _endInfo 的首个子节点前（=「用量」左边）；拿不到 _endInfo 时退化为行尾。
     */
    function installActionButtons(openFor, openTurnFor) {
      const buttons = new Set()

      function ensure() {
        let added = 0
        for (const tail of document.querySelectorAll('[' + TAIL_ATTR + ']')) {
          const found = findRow(tail)
          if (found === null) continue
          const endInfo = found.endInfo === null ? found.row : found.endInfo
          let alive = null
          for (const button of buttons) {
            if (button.isConnected && button.parentElement === endInfo) {
              alive = button
              break
            }
          }
          if (alive === null) {
            const button = createTailButton(found.row)
            button.addEventListener('click', (event) => {
              event.preventDefault()
              event.stopPropagation()
              const item = itemOf(tail)
              const turn = item === null ? null : item.getAttribute(TURN_ATTR)
              const message = messageForTail(tail)
              dbg('tailClick', 'open', 'turn=' + (turn === null ? '?' : turn), 'message=' + (message === null ? 'none' : 'found'))
              if (message !== null) {
                openFor(message)
                return
              }
              // 这一轮只有提问（输出被截断/已停止），没有可定位的回答节点：
              // 直接按轮次打开，面板里会给出「输出被截断，无回答」的说明。
              if (turn !== null && typeof openTurnFor === 'function') openTurnFor(scopeOf(tail), turn)
            })
            if (found.endInfo === null) endInfo.appendChild(button)
            else endInfo.insertBefore(button, endInfo.firstElementChild)
            buttons.add(button)
            added += 1
          } else if (endInfo.firstElementChild !== alive) {
            endInfo.insertBefore(alive, endInfo.firstElementChild)
          }
        }
        for (const button of Array.from(buttons)) {
          if (!button.isConnected) buttons.delete(button)
        }
        if (added > 0) dbg('tailButtons', 'added=' + added)
      }

      ensure()
      actionSync = ensure
      // v0.3.2：之前对整页 body 的 childList 变化做 80ms 去抖重扫，流式输出 / 虚拟滚动 / 打字都会
      // 触发密集回调，每次回调还要遍历所有 [data-turn-tail]，这是「一卡一卡」的直接原因之一。
      // 现在三重降噪：① 浮层打开时完全不扫（按钮在浮层后面，扫了也看不见）；② 页面不可见时跳过；
      // ③ 用 requestIdleCallback 排进空闲时段（最长 600ms 兜底），不再和输入抢主线程。
      let timer = 0
      let timerIdle = false
      const schedule = () => {
        if (timer !== 0) return
        const run = () => {
          timer = 0
          timerIdle = false
          if (document.hidden) return
          ensure()
        }
        if (typeof window.requestIdleCallback === 'function') {
          timer = window.requestIdleCallback(run, { timeout: 600 })
          timerIdle = true
        } else {
          timer = window.setTimeout(run, 260)
        }
      }
      const observer = new MutationObserver(() => {
        if (document.querySelector('.dshzr-backdrop') !== null) return
        schedule()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        if (timer !== 0) {
          if (timerIdle && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(timer)
          window.clearTimeout(timer)
        }
        if (actionSync === ensure) actionSync = null
        for (const button of buttons) button.remove()
        buttons.clear()
      }
    }

    /* ── 轮次：用 DSH 原生「轮次导航」拿全量轮次，再从 DOM 取该轮内容 ── */
    function summarise(text, limit) {
      const flat = (text || '').replace(/\s+/g, ' ').trim()
      if (flat.length <= limit) return flat
      return flat.slice(0, limit - 1) + '…'
    }

    function sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms))
    }

    /** DSH 原生轮次导航条（TurnNavigator）：nav 里每个按钮代表一轮。 */
    function findRail(scope) {
      const roots = []
      if (scope && typeof scope.querySelector === 'function') roots.push(scope)
      roots.push(document)
      for (const root of roots) {
        for (const nav of root.querySelectorAll('nav')) {
          if (nav.querySelector('button[class*="mark"]') === null) continue
          if (root === document && scope && typeof scope.contains === 'function') {
            const holder = nav.closest('[' + SESSION_ATTR + ']')
            const session = scope.getAttribute(SESSION_ATTR)
            if (holder !== null && session !== null) {
              if (holder.getAttribute(SESSION_ATTR) !== session) continue
            }
          }
          return nav
        }
      }
      return null
    }

    function railScroller(nav) {
      const candidate = nav.querySelector('[class*="scroller"]')
      return candidate === null ? nav : candidate
    }

    function turnFromLabel(label) {
      if (typeof label !== 'string') return null
      const match = label.match(/(\d+)/)
      if (match === null) return null
      const turn = Number(match[1])
      return Number.isSafeInteger(turn) && turn >= 0 ? String(turn) : null
    }

    function marksOf(nav) {
      const marks = []
      for (const button of nav.querySelectorAll('button[class*="mark"]')) {
        const turn = turnFromLabel(button.getAttribute('aria-label'))
        if (turn === null) continue
        marks.push({
          turn,
          button,
          unloaded: String(button.className).indexOf('markUnloaded') !== -1,
          prompt: '',
        })
      }
      return marks
    }

    /** 轮次导航条本身也是虚拟滚动的：上下滚一遍，把每一轮的坐标收齐。 */
    async function railTurns(scope) {
      const nav = findRail(scope)
      if (nav === null) return { nav: null, turns: [] }
      const found = new Map()
      const collect = () => {
        for (const mark of marksOf(nav)) {
          const previous = found.get(mark.turn)
          if (previous === undefined) {
            found.set(mark.turn, mark)
            continue
          }
          previous.button = mark.button
          previous.unloaded = previous.unloaded || mark.unloaded
        }
      }
      collect()
      const scroller = railScroller(nav)
      if (scroller.scrollHeight > scroller.clientHeight + 4) {
        const original = scroller.scrollTop
        const step = Math.max(30, Math.floor(scroller.clientHeight / 2))
        const stops = []
        for (let top = 0; top <= scroller.scrollHeight; top += step) stops.push(top)
        stops.push(scroller.scrollHeight)
        for (const top of stops) {
          scroller.scrollTop = top
          await sleep(16)
          collect()
        }
        for (let index = stops.length - 1; index >= 0; index -= 1) {
          scroller.scrollTop = stops[index]
          await sleep(16)
          collect()
        }
        scroller.scrollTop = original
      }
      const turns = Array.from(found.values()).sort((left, right) => Number(left.turn) - Number(right.turn))
      return { nav, turns }
    }

    /**
     * 一轮实际渲染出来的行。
     * 真实 DSH 里回答可能被包在一个同样带 data-chat-turn 的容器里（组行套内容行），
     * 只取「最内层」的那些行，避免外层包裹把内容行当成 nested 全部丢掉，也避免内容重复。
     */
    function turnRows(scope, turn) {
      const found = []
      if (scope === null || typeof scope.querySelectorAll !== 'function') return found
      for (const node of scope.querySelectorAll('[' + TURN_ATTR + '="' + turn + '"]')) {
        if (node.getAttribute(FLOW_KIND_ATTR) === 'turn-tail') continue
        if (node.hasAttribute('hidden') || node.hasAttribute('data-turn-process-hidden')) continue
        found.push(node)
      }
      const rows = found.filter((node) => !found.some((other) => other !== node && node.contains(other)))
      if (rows.length === 0) return found
      return rows
    }

    /**
     * 一行里真正承载回答正文的容器（DSH 的 <div class="…_root"><div class="…_body">…</div></div>）。
     * 克隆整行时，行内的图标/操作条/虚拟定位都会一起搬进浮层；只取正文容器更稳，
     * 也不会因为行被折叠/裁剪而把正文一起丢掉。
     */
    function bodiesOf(row) {
      const bodies = []
      const all = [row].concat(Array.prototype.slice.call(row.querySelectorAll('div[class]')))
      for (const node of all) {
        if (node === row && !tokensOf(node).some(isBodyToken)) continue
        if (!tokensOf(node).some(isBodyToken)) continue
        const parent = node.parentElement
        if (parent !== null && tokensOf(parent).some(isRootToken)) {
          bodies.push(parent)
          continue
        }
        bodies.push(node)
      }
      // 去掉「已经被另一个 body 包住」的重复项
      return bodies.filter((node) => !bodies.some((other) => other !== node && other.contains(node)))
    }

    /** 一轮的「提问」「回答」片段（已清理、已剔除空行）。 */
    /**
     * 被中断的轮次在真实 DOM 里可能只是「已停止」一行小字，
     * class 名里不一定带 stop 字样 —— 所以除了看标记，还要看这行是不是只有一句「已停止」。
     */
    function isStoppedRow(row) {
      if (row.querySelector('[class*="stop"],[data-stopped],[aria-label*="停止"]') !== null) return true
      const text = textOf(row).replace(/\s+/g, '')
      return text !== '' && text.length <= 12 && /^(已停止|已中断|已终止|stopped)/i.test(text)
    }

    function sectionsFor(scope, turn) {
      const prompts = []
      const answers = []
      let stopped = false
      let failure = ''
      for (const row of turnRows(scope, turn)) {
        const kind = row.getAttribute(FLOW_KIND_ATTR) || ''
        // DSH 对被中断/截断的回答会渲染一个 .xMeOpW_stopped（已停止）状态块；
        // 这一块本身不是正文，去掉并在缺正文时给出明确提示。
        const stoppedRow = isStoppedRow(row)
        if (stoppedRow) stopped = true
        if (kind === 'turn-error' || kind.indexOf('error') >= 0) {
          const errorText = textOf(row).trim()
          if (errorText !== '') failure = errorText
        }
        const isPrompt = kind.indexOf('user') === 0 || kind === 'steering'
        const targets = isPrompt ? [row] : (bodiesOf(row).length > 0 ? bodiesOf(row) : [row])
        // 只有「已停止」状态、没有正文的行不算回答，交给截断提示去说明。
        if (stoppedRow && !isPrompt) continue
        for (const target of targets) {
          const clone = target.cloneNode(true)
          for (const extra of clone.querySelectorAll('[data-dshzr-tail],.dshzr-tail-btn,[class*="_stopped"]')) {
            extra.remove()
          }
          const clean = sanitizeClone(clone)
          const text = textOf(clean).trim()
          const media = clean.querySelector('.katex,img,svg,table,video,canvas') !== null
          if (text === '' && !media) continue
          if (isPrompt) prompts.push(clean)
          else answers.push(clean)
        }
      }
      return { prompts, answers, stopped, failure }
    }

    /**
     * 结构诊断：只统计数量与长度，不搬运正文内容。
     * 目的：真实 DSH 里如果「有提问没回答」，把 DOM 结构暴露出来定位，而不是靠猜。
     */
    function probeTurn(scope, turn) {
      const info = { turn: String(turn), rows: 0, kinds: [], bodies: 0, mdHosts: 0, prompts: 0, answers: 0, answerChars: 0, stopped: false, hiddenInAnswers: 0 }
      try {
        const rows = turnRows(scope, turn)
        const sections = sectionsFor(scope, turn)
        info.rows = rows.length
        info.kinds = rows.map((row) => row.getAttribute(FLOW_KIND_ATTR) || '?').slice(0, 10)
        info.bodies = rows.reduce((sum, row) => sum + bodiesOf(row).length, 0)
        if (scope !== null && typeof scope.querySelectorAll === 'function') {
          info.mdHosts = scope.querySelectorAll('[' + TURN_ATTR + '="' + String(turn) + '"] [' + HOST_ATTR + ']').length
        }
        info.prompts = sections.prompts.length
        info.answers = sections.answers.length
        info.answerChars = sections.answers.reduce((sum, node) => sum + textOf(node).length, 0)
        info.hiddenInAnswers = sections.answers.reduce((sum, node) => sum + node.querySelectorAll('[hidden],[style*="display:none"],[style*="display: none"]').length, 0)
        info.stopped = sections.stopped
      } catch (error) {
        info.error = String(error && error.message ? error.message : error)
      }
      return info
    }

    /** 渲染现场：把当前面板里「回答」块的 HTML 片段与几何信息带出来（只 POST 到本机）。 */
    function probeRender() {
      const out = { items: [], answer: null }
      for (const item of Array.prototype.slice.call(document.querySelectorAll('.dshzr-item'))) {
        const body = item.querySelector('.dshzr-item-body')
        const rect = item.getBoundingClientRect()
        const first = body === null ? null : body.firstElementChild
        const style = first === null ? null : getComputedStyle(first)
        out.items.push({
          kind: item.getAttribute('data-kind'),
          h: Math.round(rect.height),
          textLen: item.textContent.length,
          firstTag: first === null ? '' : first.tagName + '.' + String(first.className).slice(0, 40),
          firstH: first === null ? 0 : Math.round(first.getBoundingClientRect().height),
          display: style === null ? '' : style.display,
          visibility: style === null ? '' : style.visibility,
          opacity: style === null ? '' : style.opacity,
          color: style === null ? '' : style.color,
          hidden: body === null ? 0 : body.querySelectorAll('[hidden]').length,
        })
      }
      const answer = document.querySelector('.dshzr-item[data-kind="answer"] .dshzr-item-body')
      if (answer !== null && answer.firstElementChild !== null) {
        const html = String(answer.firstElementChild.outerHTML || '')
        out.answer = { htmlLen: html.length, html: html.slice(0, 6000) }
      }
      return out
    }

    /** 把诊断信息 POST 到本地 harness（没启动就静默失败，不影响使用）。 */
    function reportProbe(scope, turn) {
      try {
        const rows = scope === null || typeof scope.querySelectorAll !== 'function' ? [] : Array.prototype.slice.call(scope.querySelectorAll('[' + TURN_ATTR + ']'))
        const census = rows.slice(0, 80).map((row) => [
          row.getAttribute(TURN_ATTR),
          row.getAttribute(FLOW_KIND_ATTR) || '?',
          row.hasAttribute('hidden') ? 'h' : '',
          row.hasAttribute('data-turn-process-hidden') ? 'p' : '',
          textOf(row).length,
          row.querySelectorAll('[' + HOST_ATTR + ']').length,
          bodiesOf(row).length,
        ])
        const payload = {
          version: VERSION,
          turn: String(turn),
          scopeTurns: rows.length,
          probe: probeTurn(scope, turn),
          render: probeRender(),
          rows: census,
        }
        const request = fetch('http://127.0.0.1:8791/diag', {
          method: 'POST',
          mode: 'cors',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify(payload),
        })
        if (request && typeof request.catch === 'function') request.catch(() => {})
      } catch (error) {
        /* 诊断通道不可用不影响插件 */
      }
    }

    /** DOM 里已经渲染出来的轮次（打开面板时先用它，异步再补全）。 */
    function turnsIn(scope) {
      const list = []
      const byTurn = new Map()
      if (scope === null || typeof scope.querySelectorAll !== 'function') return list
      for (const item of scope.querySelectorAll('[' + TURN_ATTR + ']')) {
        const turn = item.getAttribute(TURN_ATTR)
        if (turn === null || turn === '') continue
        const kind = item.getAttribute(FLOW_KIND_ATTR) || ''
        if (kind === 'turn-tail') continue
        let entry = byTurn.get(turn)
        if (entry === undefined) {
          entry = { turn, prompt: '', unloaded: false }
          byTurn.set(turn, entry)
          list.push(entry)
        }
        if (kind.indexOf('user') === 0) {
          const text = summarise(textOf(item), 120)
          if (text !== '') entry.prompt = text
        }
      }
      const numeric = list.every((entry) => /^\d+$/.test(entry.turn))
      if (numeric) list.sort((left, right) => Number(left.turn) - Number(right.turn))
      return list
    }

    /** 一条回答属于哪一轮（拿不到时返回 null）。 */
    function turnOfMessage(message) {
      if (message === null || !message.root) return null
      const item = itemOf(message.root)
      return item === null ? null : item.getAttribute(TURN_ATTR)
    }

    /* ── DSH 输入框：把左栏写好的文字填进去（不自动发送）────────────────── */
    function findComposerEditor() {
      const scopes = [activeScope(), document]
      for (const scope of scopes) {
        const seat = scope.querySelector ? scope.querySelector('[data-composer-seat]') : null
        const host = seat === null ? scope : seat
        if (!host || !host.querySelector) continue
        const editor =
          host.querySelector('[contenteditable="true"]') ||
          host.querySelector('textarea') ||
          host.querySelector('[role="textbox"]')
        if (editor !== null) return editor
      }
      return null
    }

    function fillComposer(text) {
      const editor = findComposerEditor()
      if (editor === null) return { ok: false, reason: 'no-composer' }
      const tag = editor.tagName
      const wanted = text.replace(/\s+/g, ' ').trim()
      try {
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          const prototype = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
          setter.call(editor, text)
          editor.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          const scrollX = window.scrollX
          const scrollY = window.scrollY
          editor.focus({ preventScroll: true })
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(editor)
          if (selection !== null) {
            selection.removeAllRanges()
            selection.addRange(range)
          }
          let inserted = false
          try {
            inserted = document.execCommand('insertText', false, text)
          } catch (error) {
            inserted = false
          }
          if (!inserted) {
            editor.textContent = text
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
          }
          // 有些浏览器/宿主仍会把页面滚到输入框，这里还原滚动位置，避免浮层看起来「跑掉」
          if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY)
        }
      } catch (error) {
        dbg('fillComposer', 'error', String(error && error.message))
        return { ok: false, reason: 'write-failed' }
      }
      const readback = String((tag === 'TEXTAREA' || tag === 'INPUT' ? editor.value : editor.innerText) || '')
        .replace(/\s+/g, ' ')
        .trim()
      const head = wanted.slice(0, 16)
      if (head !== '' && readback.indexOf(head) !== -1) return { ok: true }
      dbg('fillComposer', 'echo-mismatch', summarise(readback, 40))
      return { ok: false, reason: 'echo-mismatch' }
    }

    /** 超宽公式等比缩小到放得下（DSH 原生 display 公式只横滚不换行）。
     *  v0.3.2：改成「一次清样式 → 一次批量量宽度 → 一次批量写样式」，避免逐个公式读写交替
     *  触发几十次重排（打开浮层时的主要卡顿来源之一）。 */
    function fitFormulas(scroller, content) {
      if (!scroller || !content) return
      const displays = content.querySelectorAll('.katex-display')
      if (displays.length === 0) return
      const available = scroller.clientWidth - 56
      if (available <= 0) return
      const targets = []
      for (const display of displays) {
        const katex = display.firstElementChild
        if (katex === null || katex.classList.contains('katex') === false) continue
        if (katex.style.fontSize !== '') katex.style.fontSize = ''
        targets.push(katex)
      }
      if (targets.length === 0) return
      const widths = targets.map((katex) => katex.getBoundingClientRect().width)
      targets.forEach((katex, index) => {
        const width = widths[index]
        if (width <= available) return
        const ratio = Math.max(0.45, available / width)
        katex.style.fontSize = ratio.toFixed(3) + 'em'
      })
    }

    /* ── 全屏阅读浮层 ──────────────────────────────────────────────────── */
    /** 宿主用 hidden / display:none 折叠的内容，在浮层里一律展开——否则就会出现「有字数、看不见」。 */
    function revealHidden(node) {
      node.querySelectorAll('[hidden]').forEach((child) => child.removeAttribute('hidden'))
      node.querySelectorAll('[style]').forEach((child) => {
        const style = child.getAttribute('style') || ''
        if (/display\s*:\s*none/i.test(style)) child.style.removeProperty('display')
        if (/visibility\s*:\s*hidden/i.test(style)) child.style.removeProperty('visibility')
      })
      if (node.hasAttribute('hidden')) node.removeAttribute('hidden')
    }

    /**
     * 去掉宿主的布局类（形如 xMeOpW_root / V4vHZW_flowItem / _1KfHza_actions），
     * 只留 markdown 与 KaTeX 的类：这两套才是排版需要的，其余在浮层里只会带来
     * max-height / overflow / 折叠之类的副作用。
     */
    function stripHostClasses(node) {
      const isHostToken = (token) =>
        (/^[A-Za-z0-9]{2,12}_[A-Za-z]/.test(token) || /^_[A-Za-z0-9]{5,8}_/.test(token)) &&
        token.indexOf('markdown') < 0 &&
        token.indexOf('katex') < 0
      const targets = [node].concat(Array.prototype.slice.call(node.querySelectorAll('[class]')))
      for (const element of targets) {
        const tokens = tokensOf(element)
        if (tokens.length === 0) continue
        const kept = tokens.filter((token) => !isHostToken(token))
        if (kept.length === tokens.length) continue
        if (kept.length === 0) {
          element.removeAttribute('class')
          // 纯宿主包裹层：连内联样式一起去掉（display:none / opacity:0 / 固定高度
          // 这类折叠样式正是回答「有字数、看不见」的来源）。
          element.removeAttribute('style')
        } else {
          element.setAttribute('class', kept.join(' '))
        }
      }
    }

    function sanitizeClone(node) {
      node.querySelectorAll('script,style,link,iframe,object,embed,noscript').forEach((child) => child.remove())
      // v0.3.2：每个公式都有 MathML（给读屏/复制用）与 HTML 两份；浮层里只保留可视的 HTML 那份，
      // 公式节点的数量直接减半，打开与滚动都更轻。
      node.querySelectorAll('.katex-mathml').forEach((child) => child.remove())
      node.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'))
      node.querySelectorAll('[' + HOST_ATTR + ']').forEach((child) => child.removeAttribute(HOST_ATTR))
      node.querySelectorAll('[contenteditable]').forEach((child) => child.setAttribute('contenteditable', 'false'))
      node.querySelectorAll('[tabindex]').forEach((child) => child.setAttribute('tabindex', '-1'))
      // v0.3.7：真实 DSH 里回答被宿主的布局类/隐藏标记包着，克隆进浮层后会出现
      // 「节点在、字数在、但看不见」（默认视口折叠、max-height、hidden 等）。
      // 浮层不需要宿主的布局，只保留 markdown / KaTeX 两套样式类。
      revealHidden(node)
      stripHostClasses(node)
      if (node.hasAttribute('id')) node.removeAttribute('id')
      return node
    }

    function installZoomOverlay() {
      const state = {
        open: false,
        backdrop: null,
        content: null,
        scroller: null,
        zoomLabel: null,
        zoom: readZoom(),
        prevFocus: null,
        disposeKey: null,
        scope: null,
        rail: null,
        turns: [],
        entries: new Map(),
        currentTurn: null,
        turnList: null,
        turnsHead: null,
        composeArea: null,
        savedScrollTop: null,
        selectSeq: 0,
        enrichSeq: 0,
      }

      function conversationScroller() {
        const scope = state.scope
        if (scope === null || typeof scope.querySelector !== 'function') return null
        return scope.querySelector('[data-conversation-scroll]')
      }

      function applyZoom() {
        if (state.content) state.content.style.zoom = String(state.zoom)
        if (state.zoomLabel) state.zoomLabel.textContent = Math.round(state.zoom * 100) + '%'
        fitFormulas(state.scroller, state.content)
      }

      function setZoom(next) {
        state.zoom = clampZoom(next)
        writeZoom(state.zoom)
        applyZoom()
      }

      let toastTimer = 0
      function toast(text) {
        let node = document.querySelector('.dshzr-toast')
        if (node === null) {
          node = document.createElement('div')
          node.className = 'dshzr-toast'
          node.setAttribute('role', 'status')
          document.body.appendChild(node)
        }
        node.textContent = text
        node.setAttribute('data-on', '')
        window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => {
          node.removeAttribute('data-on')
        }, 1400)
      }

      function diagnosticText() {
        let stateText = '未知'
        try {
          stateText = JSON.stringify(window.__DSH_READ_ZOOM__.peek())
        } catch (error) {
          stateText = '未知（' + String(error && error.message) + '）'
        }
        let dshVersion = '未知'
        try {
          const boot = window.__DSH_BOOT__
          dshVersion = (boot && (boot.version || (boot.manifest && boot.manifest.version))) || '未知'
        } catch (error) {
          dshVersion = '未知'
        }
        return [
          '### 现象',
          '',
          '（描述发生了什么，和你的预期差在哪；截图可以直接拖进来）',
          '',
          '### 复现步骤',
          '',
          '1. ',
          '',
          '### 环境（自动填充，可删改）',
          '',
          '- 插件版本：v' + VERSION,
          '- DSH 版本：' + dshVersion,
          '- 运行环境：' + (navigator.userAgent || '未知'),
          '- 面板状态：' + stateText,
        ].join('\n')
      }

      function close(options) {
        if (!state.open) return
        state.open = false
        const immediate = options && options.immediate === true
        state.selectSeq += 1
        state.enrichSeq += 1
        const savedScrollTop = state.savedScrollTop
        const chatScroller = conversationScroller()
        state.savedScrollTop = null
        const backdrop = state.backdrop
        state.backdrop = null
        state.content = null
        state.zoomLabel = null
        state.scroller = null
        state.turnList = null
        state.turnsHead = null
        state.composeArea = null
        state.rail = null
        state.turns = []
        state.entries = new Map()
        state.currentTurn = null
        if (chatScroller !== null && savedScrollTop !== null) {
          try {
            chatScroller.scrollTop = savedScrollTop
          } catch (error) {
            /* 还原滚动位置失败不影响关闭 */
          }
        }
        state.scope = null
        if (state.disposeKey) state.disposeKey()
        state.disposeKey = null
        document.body.classList.remove('dshzr-noscroll')
        if (backdrop !== null) {
          const removeBackdrop = () => {
            if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop)
          }
          const reduced =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
          if (immediate || reduced) {
            removeBackdrop()
          } else {
            // 退出过渡：先撤 data-shown 让 opacity/transform 归位，动画跑完再摘节点
            backdrop.removeAttribute('data-shown')
            window.setTimeout(removeBackdrop, 170)
          }
        }
        // 浮层期间为了不抢主线程，操作行按钮的同步被跳过了；关闭后补一次（等 React 落完这一帧）
        if (typeof actionSync === 'function') {
          window.setTimeout(() => {
            if (typeof actionSync === 'function') actionSync()
          }, 160)
        }
        const previous = state.prevFocus
        state.prevFocus = null
        if (previous && previous.isConnected && typeof previous.focus === 'function') {
          try {
            previous.focus({ preventScroll: true })
          } catch (error) {
            /* 焦点恢复失败不影响关闭 */
          }
        }
      }

      function copyText(text, okMessage) {
        const done = () => toast(okMessage)
        const fallback = () => {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          let ok = false
          try {
            ok = document.execCommand('copy')
          } catch (error) {
            ok = false
          }
          area.remove()
          if (ok) done()
          else toast('复制失败：浏览器拒绝了剪贴板写入')
        }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(done, fallback)
          return
        }
        fallback()
      }

      function highlightTurn() {
        if (state.turnList === null) return
        for (const button of state.turnList.querySelectorAll('.dshzr-turn')) {
          if (button.getAttribute('data-turn') === state.currentTurn) {
            button.setAttribute('data-active', '')
            if (typeof button.scrollIntoView === 'function') button.scrollIntoView({ block: 'nearest' })
          } else {
            button.removeAttribute('data-active')
          }
        }
      }

      function turnLabel(entry) {
        const index = state.turns.indexOf(entry)
        const order = index < 0 ? entry.turn : String(index + 1)
        return entry.prompt === '' ? '第 ' + order + ' 轮' : entry.prompt
      }

      function updateTurnLabel(entry) {
        if (state.turnList === null) return
        const button = state.turnList.querySelector('.dshzr-turn[data-turn="' + entry.turn + '"]')
        if (button === null) return
        const label = turnLabel(entry)
        const text = button.querySelector('.dshzr-turn-text')
        if (text !== null) text.textContent = label
        button.title = label
      }

      function updateTurnsHead() {
        if (state.turnsHead !== null) state.turnsHead.textContent = '本会话 · ' + state.turns.length + ' 轮'
      }

      /** 右栏的提示块（载入中 / 没内容 / 失败重试）。 */
      function renderNote(text, retryTurn) {
        const content = state.content
        if (content === null) return
        content.innerHTML = ''
        const note = document.createElement('div')
        note.className = 'dshzr-note'
        note.textContent = text
        if (retryTurn !== undefined && retryTurn !== null) {
          const retry = document.createElement('button')
          retry.type = 'button'
          retry.textContent = '重试'
          retry.addEventListener('click', () => {
            void selectTurn(retryTurn)
          })
          note.appendChild(retry)
        }
        content.appendChild(note)
        applyZoom()
      }

      /** 把某一轮的「提问 + 回答」渲染到右栏（同一段只出一个标签）。 */
      function renderSections(sections) {
        const content = state.content
        if (content === null) return
        content.innerHTML = ''
        const add = (tag, kind, nodes) => {
          if (nodes.length === 0) return
          const wrapper = document.createElement('div')
          wrapper.className = 'dshzr-item'
          wrapper.setAttribute('data-kind', kind)
          const label = document.createElement('span')
          label.className = 'dshzr-item-tag'
          label.textContent = tag
          const body = document.createElement('div')
          body.className = 'dshzr-item-body'
          for (const node of nodes) body.appendChild(node)
          wrapper.appendChild(label)
          wrapper.appendChild(body)
          content.appendChild(wrapper)
        }
        add('提问', 'user', sections.prompts)
        add('回答', 'answer', sections.answers)
        if (sections.answers.length === 0 && sections.prompts.length > 0) {
          // 只留下提问的轮次：多半是输出被截断（用户点了停止 / 进程中断），
          // 明确写出来，避免误以为是插件少抓了内容。
          const box = document.createElement('div')
          box.className = 'dshzr-truncated'
          box.setAttribute('data-dshzr-truncated', sections.stopped ? 'stopped' : 'empty')
          const icon = document.createElement('span')
          icon.className = 'dshzr-truncated-icon'
          icon.textContent = '⚠'
          const text = document.createElement('div')
          const head = document.createElement('b')
          head.textContent = sections.stopped ? '输出被截断，无回答' : '这一轮没有回答内容'
          text.appendChild(head)
          const detail = document.createElement('span')
          detail.textContent = sections.stopped
            ? 'DSH 里这一轮只有提问——回答在生成过程中被中断（界面显示「已停止」），所以没有正文可放大。'
            : sections.failure !== ''
              ? summarise(sections.failure, 160)
              : 'DSH 里这一轮只渲染出提问，没有可显示的回答正文（可能输出被截断或回答为空）。'
          text.appendChild(detail)
          box.appendChild(icon)
          box.appendChild(text)
          content.appendChild(box)
        }
        if (state.scroller !== null) state.scroller.scrollTop = 0
        applyZoom()
      }

      /** 这一轮还没进 DOM 时，点原生轮次条让 DSH 去加载历史，等它出现。 */
      async function ensureTurnLoaded(turn) {
        if (turnRows(state.scope, turn).length > 0) return true
        const nav = state.rail === null ? findRail(state.scope) : state.rail
        if (nav === null) return false
        const mark = marksOf(nav).find((candidate) => candidate.turn === turn)
        if (mark === undefined) return false
        if (state.savedScrollTop === null) {
          const chatScroller = conversationScroller()
          state.savedScrollTop = chatScroller === null ? 0 : chatScroller.scrollTop
        }
        try {
          mark.button.click()
        } catch (error) {
          return false
        }
        const deadline = Date.now() + 6000
        while (Date.now() < deadline) {
          if (turnRows(state.scope, turn).length > 0) return true
          if (!state.open) return false
          await sleep(90)
        }
        return false
      }

      async function selectTurn(turn) {
        if (state.content === null || turn === null) return
        const seq = state.selectSeq + 1
        state.selectSeq = seq
        state.currentTurn = turn
        highlightTurn()
        const immediate = sectionsFor(state.scope, turn)
        if (immediate.prompts.length > 0 || immediate.answers.length > 0) {
          renderSections(immediate)
          return
        }
        const entry = state.turns.find((candidate) => candidate.turn === turn)
        const order = entry === undefined ? turn : String(state.turns.indexOf(entry) + 1)
        renderNote('正在载入第 ' + order + ' 轮…')
        const loaded = await ensureTurnLoaded(turn)
        if (seq !== state.selectSeq || !state.open) return
        const late = sectionsFor(state.scope, turn)
        if (late.prompts.length === 0 && late.answers.length === 0) {
          renderNote(loaded ? '这一轮没有可显示的内容' : '这一轮还没载入出来', loaded ? null : turn)
          return
        }
        renderSections(late)
      }

      function renderTurnList() {
        if (state.turnList === null) return
        state.turnList.innerHTML = ''
        state.turns.forEach((entry, index) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dshzr-turn'
          button.setAttribute('data-turn', entry.turn)
          if (entry.unloaded) button.setAttribute('data-unloaded', '')
          const number = document.createElement('span')
          number.className = 'dshzr-turn-no'
          number.textContent = String(index + 1)
          const text = document.createElement('span')
          text.className = 'dshzr-turn-text'
          const label = turnLabel(entry)
          text.textContent = label
          button.title = label
          button.appendChild(number)
          button.appendChild(text)
          button.addEventListener('click', () => {
            void selectTurn(entry.turn)
          })
          state.turnList.appendChild(button)
        })
        highlightTurn()
        updateTurnsHead()
      }

      /** 异步补齐：用原生轮次条拿全量轮次，再借悬停预览补提问摘要。 */
      async function refreshRail() {
        const scope = state.scope
        if (scope === null) return
        const known = new Map(state.turns.map((entry) => [entry.turn, entry.prompt]))
        const result = await railTurns(scope)
        if (!state.open) return
        state.rail = result.nav
        if (result.turns.length === 0) return
        for (const item of result.turns) {
          const prompt = known.get(item.turn)
          if (item.prompt === '' && typeof prompt === 'string' && prompt !== '') item.prompt = prompt
        }
        state.turns = result.turns
        renderTurnList()
        void enrichVisible()
      }

      /** 只给「左栏里正显示着」的轮次补提问摘要。
       *  悬停预览要靠派发 pointermove 让 DSH 渲染预览，一次性对全部轮次做会在打开时占满主线程
       *  （v0.3.1 打开卡顿的来源之一）。v0.3.2 改成滚到哪补到哪，每次最多 6 条。 */
      let enrichBusy = false
      async function enrichVisible() {
        const nav = state.rail
        const list = state.turnList
        if (nav === null || list === null || enrichBusy) return
        enrichBusy = true
        try {
          const box = list.getBoundingClientRect()
          let budget = 6
          for (const entry of state.turns) {
            if (budget <= 0) break
            if (!state.open) return
            if (entry.prompt !== '') continue
            const button = list.querySelector('.dshzr-turn[data-turn="' + entry.turn + '"]')
            if (button === null) continue
            const rect = button.getBoundingClientRect()
            if (rect.bottom < box.top - 24 || rect.top > box.bottom + 24) continue
            const mark = marksOf(nav).find((candidate) => candidate.turn === entry.turn)
            if (mark === undefined) continue
            budget -= 1
            try {
              mark.button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
            } catch (error) {
              return
            }
            await sleep(40)
            const promptNode = nav.querySelector('[class*="previewPrompt"]')
            if (promptNode === null) continue
            const text = summarise(promptNode.textContent, 120)
            if (text === '') continue
            entry.prompt = text
            updateTurnLabel(entry)
          }
        } finally {
          enrichBusy = false
        }
        try {
          nav.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
        } catch (error) {
          /* 清不掉预览也不影响使用 */
        }
      }

      /** 左栏底部：先写好，再一键填入 DSH 的真实输入框（不自动发送）。 */
      function buildCompose() {
        const box = document.createElement('div')
        box.className = 'dshzr-compose'
        const area = document.createElement('textarea')
        area.rows = 3
        area.placeholder = '写下一句要问的话……（只填入 DSH 输入框，不自动发送）'
        area.setAttribute('aria-label', '输入要填入 DSH 输入框的文字')
        const row = document.createElement('div')
        row.className = 'dshzr-compose-row'
        const fill = makeButton('填入输入框', '把这里的文字写入 DSH 的输入框（不会自动发送）')
        fill.setAttribute('data-primary', '')
        const copy = makeButton('复制', '复制这里的文字')
        const note = document.createElement('span')
        note.className = 'dshzr-compose-note'
        note.textContent = 'Ctrl+Enter 填入'

        const submit = () => {
          const text = area.value
          if (text.trim() === '') {
            toast('先写点内容再填入')
            area.focus()
            return
          }
          const result = fillComposer(text)
          if (result.ok) {
            toast('已填入 DSH 输入框（不会自动发送）')
            area.value = ''
            return
          }
          if (result.reason === 'no-composer') toast('没找到 DSH 输入框：内容留在左栏，可点「复制」手动粘贴')
          else if (result.reason === 'write-failed') toast('写入失败：请点「复制」再粘进 DSH 输入框')
          else toast('填入后没读到回显：请检查 DSH 输入框，或点「复制」手动粘贴')
          area.focus()
        }
        fill.addEventListener('click', submit)
        copy.addEventListener('click', () => {
          if (area.value.trim() === '') {
            toast('输入框是空的')
            return
          }
          copyText(area.value, '已复制输入框内容')
        })
        area.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            submit()
          }
        })
        row.appendChild(fill)
        row.appendChild(copy)
        row.appendChild(note)
        box.appendChild(area)
        box.appendChild(row)
        state.composeArea = area
        return box
      }

      function open(message, options) {
        const opt = options === undefined || options === null ? {} : options
        const usable = message !== undefined && message !== null && message.body !== undefined && message.body !== null && message.body.isConnected === true
        if (!usable && opt.turn === undefined) return false
        const scopeHint = opt.scope !== undefined ? opt.scope : usable ? scopeOf(message.body) : null
        if (scopeHint === null) return false
        if (state.open) close()
        // 若上一个浮层还在跑退出动画，直接摘掉，避免两层遮罩叠着闪一下
        document.querySelectorAll('.dshzr-backdrop').forEach((node) => node.remove())
        state.prevFocus = document.activeElement
        state.zoom = readZoom()
        state.selectSeq = 0
        state.enrichSeq = 0
        state.savedScrollTop = null
        const scope = scopeHint
        state.scope = scope
        state.rail = findRail(scope)
        const domTurns = turnsIn(scope)
        state.entries = new Map(domTurns.map((entry) => [entry.turn, entry.prompt]))
        state.turns = domTurns.map((entry) => ({
          turn: entry.turn,
          prompt: entry.prompt,
          unloaded: false,
          button: null,
        }))

        const backdrop = document.createElement('div')
        backdrop.className = 'dshzr-backdrop'

        const panel = document.createElement('div')
        panel.className = 'dshzr-panel'
        panel.setAttribute('role', 'dialog')
        panel.setAttribute('aria-modal', 'true')
        panel.setAttribute('aria-label', '放大阅读')

        const head = document.createElement('div')
        head.className = 'dshzr-head'

        const title = document.createElement('div')
        title.className = 'dshzr-title'
        title.textContent = '放大阅读'

        const hint = document.createElement('div')
        hint.className = 'dshzr-hint'
        hint.textContent = 'Alt+Z / Alt+E 关闭 · ↑↓ 换轮 · Ctrl+滚轮缩放 · Esc 关闭'

        const spacer = document.createElement('div')
        spacer.className = 'dshzr-spacer'

        const minus = makeButton('A−', '减小字号')
        const zoomLabel = makeButton('', '恢复到 140%')
        zoomLabel.className = 'dshzr-btn dshzr-zoom'
        const plus = makeButton('A+', '增大字号')
        const copy = makeButton('复制文字', '复制这一轮的纯文本')
        const rules = makeButton('公式规约', '复制数学/化学输出规约（可粘进 AGENTS.md）')
        const feedback = makeButton('反馈', '在 GitHub 上提一条反馈（自动带上版本与诊断信息）')
        const closeButton = makeButton('关闭', '关闭放大阅读（Esc）')
        closeButton.className = 'dshzr-btn dshzr-close'

        minus.addEventListener('click', () => setZoom(state.zoom - STEP))
        plus.addEventListener('click', () => setZoom(state.zoom + STEP))
        zoomLabel.addEventListener('click', () => setZoom(DEFAULT_ZOOM))
        closeButton.addEventListener('click', () => close())
        copy.addEventListener('click', () => {
          const source = state.content === null ? (usable ? message.body : null) : state.content
          const text = source === null ? '' : textOf(source)
          if (text === '') {
            toast('这一轮没有可复制的文字')
            return
          }
          copyText(text, '已复制这一轮的纯文本')
        })
        rules.addEventListener('click', () => copyText(MATH_RULES, '已复制数学/化学输出规约（可粘进 AGENTS.md）'))
        feedback.addEventListener('click', () => {
          const info = diagnosticText()
          const url =
            'https://github.com/liuyifeng-code/dsh-read-zoom/issues/new?template=bug_report.yml' +
            '&title=' + encodeURIComponent('[bug] ') +
            '&body=' + encodeURIComponent(info)
          window.open(url, '_blank', 'noopener')
          toast('已在浏览器打开反馈页（内容已预填）')
        })

        const main = document.createElement('div')
        main.className = 'dshzr-main'

        const aside = document.createElement('div')
        aside.className = 'dshzr-turns'
        const asideHead = document.createElement('div')
        asideHead.className = 'dshzr-turns-head'
        asideHead.textContent = '本会话 · ' + state.turns.length + ' 轮'
        const turnList = document.createElement('div')
        turnList.className = 'dshzr-turns-list'
        state.turnList = turnList
        state.turnsHead = asideHead
        // 列表滚动时只补「当前看得见」的摘要，避免打开时对每一轮都派发 pointermove 去借预览
        let listTimer = 0
        turnList.addEventListener(
          'scroll',
          () => {
            if (listTimer !== 0) return
            listTimer = window.setTimeout(() => {
              listTimer = 0
              void enrichVisible()
            }, 90)
          },
          { passive: true },
        )
        aside.appendChild(asideHead)
        aside.appendChild(turnList)
        aside.appendChild(buildCompose())

        const scroller = document.createElement('div')
        scroller.className = 'dshzr-scroller'
        const content = document.createElement('div')
        content.className = 'dshzr-content'
        scroller.appendChild(content)

        main.appendChild(aside)
        main.appendChild(scroller)

        head.appendChild(title)
        head.appendChild(hint)
        head.appendChild(spacer)
        head.appendChild(minus)
        head.appendChild(zoomLabel)
        head.appendChild(plus)
        head.appendChild(copy)
        head.appendChild(rules)
        head.appendChild(feedback)
        head.appendChild(closeButton)
        panel.appendChild(head)
        panel.appendChild(main)
        backdrop.appendChild(panel)
        document.body.appendChild(backdrop)
        // 先以初始态插入一帧，再加 data-shown 触发过渡（用 setTimeout 而不是 rAF：
        // 后台窗口/无头环境下 rAF 可能不触发，会导致浮层停在半透明初始态）
        window.setTimeout(() => {
          if (backdrop.isConnected) backdrop.setAttribute('data-shown', '')
        }, 16)

        state.open = true
        state.backdrop = backdrop
        state.content = content
        state.scroller = scroller
        state.zoomLabel = zoomLabel
        document.body.classList.add('dshzr-noscroll')

        renderTurnList()
        const initial = usable ? turnOfMessage(message) : opt.turn === undefined ? null : String(opt.turn)
        if (initial !== null) void selectTurn(initial)
        else if (state.turns.length > 0) void selectTurn(state.turns[state.turns.length - 1].turn)
        else if (usable) {
          // 连轮次都取不到（DOM 变体）时退化成只渲染这一条回答
          content.appendChild(sanitizeClone(message.body.cloneNode(true)))
          applyZoom()
        }
        window.setTimeout(() => {
          void refreshRail()
        }, 30)
        // 结构诊断（只统计数量/长度，不含正文），本地 harness 没开就静默失败。
        window.setTimeout(() => reportProbe(state.scope, state.currentTurn), 500)

        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) close()
        })
        scroller.addEventListener(
          'wheel',
          (event) => {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            setZoom(state.zoom + (event.deltaY < 0 ? STEP : -STEP))
          },
          { passive: false },
        )

        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
            return
          }
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          const target = event.target
          if (target instanceof Element && target.closest('textarea,input,[contenteditable="true"]')) return
          if (state.turns.length === 0) return
          const index = state.turns.findIndex((entry) => entry.turn === state.currentTurn)
          const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1
          if (nextIndex < 0 || nextIndex >= state.turns.length) return
          event.preventDefault()
          void selectTurn(state.turns[nextIndex].turn)
        }
        document.addEventListener('keydown', onKeyDown, true)
        state.disposeKey = () => document.removeEventListener('keydown', onKeyDown, true)

        window.setTimeout(() => {
          try {
            closeButton.focus({ preventScroll: true })
          } catch (error) {
            /* 聚焦失败不影响使用 */
          }
        }, 0)
        return true
      }

      return {
        open,
        openTurn: (scope, turn) => open(null, { scope, turn }),
        close,
        isOpen: () => state.open,
      }
    }


    /* ── 安装 ──────────────────────────────────────────────────────────── */
    function start() {
      dbg('start', document.body ? 'body-ok' : 'no-body', 'v' + VERSION)
      const disposers = []

      const overlay = installZoomOverlay()

      function openFor(message) {
        if (!message) return
        overlay.open(message)
      }

      function openForTurn(scope, turn) {
        overlay.openTurn(scope === null ? activeScope() : scope, turn)
      }

      // 主入口：回答底部操作行里、紧挨「用量」左边的放大按钮（位置固定）
      disposers.push(installActionButtons(openFor, openForTurn))

      // 右下角常驻按钮（固定位置，不随鼠标漂移）+ Alt+Z
      const fab = document.createElement('button')
      fab.type = 'button'
      fab.className = 'dshzr-fab'
      fab.textContent = 'Aa'
      fab.dataset.dshzrVersion = VERSION
      fab.title = '放大阅读最近一条回答（v' + VERSION + '，Alt+Z / Alt+E）'
      fab.setAttribute('aria-label', '放大阅读最近一条回答（Alt+Z 或 Alt+E）')
      fab.addEventListener('click', () => openFor(nearestMessage()))
      document.body.appendChild(fab)
      disposers.push(() => fab.remove())

      function onKeyDown(event) {
        if (event.repeat) return
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        // 用 event.code 兜底：中文输入法/非英文键盘布局下 event.key 可能不是字母。
        // 也不要因为 defaultPrevented 或「焦点在输入框里」就退出——DSH 的输入框是
        // contenteditable，几乎总是有焦点，上一版正是被这两条挡住，Alt+Z 完全没反应。
        const code = event.code || ''
        const shortcut =
          code === 'KeyZ' || code === 'KeyE' ||
          event.key === 'z' || event.key === 'Z' || event.key === 'e' || event.key === 'E'
        if (!shortcut) return
        event.preventDefault()
        event.stopPropagation()
        if (overlay.isOpen()) {
          overlay.close()
          return
        }
        openFor(nearestMessage())
      }
      // capture 阶段先取事件，避免被宿主的快捷键处理吃掉
      window.addEventListener('keydown', onKeyDown, true)
      disposers.push(() => window.removeEventListener('keydown', onKeyDown, true))

      // 调试 / 自检入口
      window.__DSH_READ_ZOOM__ = {
        version: VERSION,
        openLast: () => openFor(nearestMessage()),
        close: () => overlay.close(),
        messages: settledMessages,
        peek: () => ({
          version: VERSION,
          overlayOpen: overlay.isOpen(),
          tailButtons: document.querySelectorAll('[data-dshzr-tail]').length,
          fab: document.querySelector('.dshzr-fab') !== null,
          panelTurns: document.querySelectorAll('.dshzr-turn').length,
          railMarks: document.querySelectorAll('nav button[class*="mark"]').length,
          activeTurn: (() => {
            const active = document.querySelector('.dshzr-turn[data-active]')
            return active === null ? null : active.getAttribute('data-turn')
          })(),
          compose: document.querySelector('.dshzr-compose textarea') !== null,
        }),
        // 手动自检：__DSH_READ_ZOOM__.diagnose(轮次号) 返回该轮的结构统计
        diagnose: (turn) => {
          const scope = activeScope()
          const target = turn === undefined ? (document.querySelector('.dshzr-turn[data-active]') || {}).getAttribute?.('data-turn') : turn
          return probeTurn(scope, target === undefined || target === null ? '' : target)
        },
        report: () => {
          const active = document.querySelector('.dshzr-turn[data-active]')
          reportProbe(activeScope(), active === null ? '' : active.getAttribute('data-turn'))
          return 'sent'
        },
      }

      return () => {
        overlay.close()
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            /* 清理时忽略单个失败 */
          }
        }
        delete window.__DSH_READ_ZOOM__
      }
    }

    let installed = false

    function apply(ctx) {
      if (installed) return
      installed = true
      const cleanup = () => {
        installed = false
      }
      const run = () => {
        const disposeStyle = installStyle()
        const disposeDom = start()
        return () => {
          disposeDom()
          disposeStyle()
          cleanup()
        }
      }
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => (document.body ? run() : waitForBody(run)), 'read-zoom: 悬停放大按钮与阅读浮层')
      } else {
        const dispose = document.body ? run() : waitForBody(run)
        void dispose
      }
    }

    function waitForBody(run) {
      const onReady = () => {
        document.removeEventListener('DOMContentLoaded', onReady)
        run()
      }
      document.addEventListener('DOMContentLoaded', onReady)
      return () => document.removeEventListener('DOMContentLoaded', onReady)
    }

    return { inject: [], apply }
  },
})
