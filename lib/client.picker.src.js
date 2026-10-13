/**
 * better-dsh-codex-effort-slider — 自建「模型 + 推理等级」浮层（picker）
 *
 * ⚠️ 本文件是**源码**，不是发布产物：`node build/pack-picker.mjs` 会把它包成自注册的
 *    包内 chunk `lib/client.picker.js`（宿主的模块表要用那一个）。构建时会注入一个
 *    `platform = { window, document }` 参数 —— 这里直接用它，不要去 require 任何东西。
 *
 * 这一份把 **code.html** 参考实现（669 行、自建菜单的静态页）的界面落到真宿主里（1.3.0）：
 *
 *   收起态：一颗按钮 = `模型名 · 档位名 ⌄`（档位名按能量着色，Off 档保持灰）
 *   一级页：provider 行（右侧显示该 provider 当前选中的模型名）
 *   二级页：搜索框 + 分组模型列表（每行一颗档位徽标 `8 档 / 不支持`，按**新发布 → 旧发布**排）
 *   常驻：推理等级卡片（标题 + 当前档位名 + 滑条：轨道 / 填充 / 星云 / 星尘 / 刻度 / 旋钮）
 *   档位弹层：每行显示档位名 + 灰色原始 API 取值（`xhigh` 之类 —— 发送请求用的就是它）
 *   双页 carousel：page1 `0 → -100%`、page2 `+100% → 0` 同步位移
 *
 * ── 与参考实现的差异（都有意为之，逐条写在 MODIFICATIONS.md）──────────────────
 *   1. **颜色走 DSH 令牌**：参考实现是写死深色的 demo，这里是真插件，必须浅色/深色都跟随。
 *      写死的只有"能量色"这三个：`#3f8cff` → `#7c6cf6` → `#a855f7`（观感本体）。
 *   2. **能力清单是活数据**：读目录快照（`groups[].models[].reasoning.efforts`），
 *      不再内置一份 `OPENAI_DEFS` 式的静态清单。
 *   3. **写回走官方 `directory.select()`**，并保留 1.1.0 起就有的停顿去抖 + 同档去重 + 超时回滚。
 *   4. **接管官方那颗模型席按钮**（1.3.2 起）：触发器注册进 `conversation.input.model`
 *      这个 **single 槽**、用 `priority: -1` 遮蔽官方那条（同槽同优先级会抛错，换一个优先级就
 *      "最低者渲染"）；浮层仍挂 `conversation.input.overlay`（官方插槽目录原话：Floating entries
 *      rendered inside the resident composer card）。拿不到那个槽就退回 `conversation.input.right`
 *      （与官方那颗并排，老样子）。代价：官方菜单（模型列表/档位列表/键盘导航）没有入口了，
 *      `/model` 命令那条路不受影响。
 *      随之要接过来的两条 owner 语义：`locked`（输入区被锁 → 按钮不可点）与紧凑态的两个
 *      `--dsh-composer-model-*` 变量（窄行里切成纯图标）。
 *
 * ── 两条硬纪律（1.2.0 的教训）──────────────────────────────────────────────
 *   · **hook 数量恒定**：hook 全部在早返回之前，且条件渲染的子组件不额外持有 hook。
 *     真机上"点开按钮完全没反应"就是这条踩出来的（React error #310）。
 *   · **fail-open**：目录没就绪 / 模型没有档位 / 拿不到 sessionId…… 就渲染成"没有可用档位"，
 *     绝不抛错波及输入区。
 */

/** 面板宽度（参考实现 `.panel{width:272px}`）。 */
const PANEL_W = 272;
/** 面板与触发器之间的间距。 */
const PANEL_GAP = 8;
/** 视口边缘留白（参考实现 `clamp(...,8,...)`）。 */
const EDGE = 8;
/** 轨道高 / 旋钮直径 / 端头半径（参考实现 `:root{--track:20px;--knob:28px;--tr:10px}`）。 */
const TRACK_H = 20;
const KNOB = 28;
const TR = TRACK_H / 2;
/** 拖动判定：越过"当前档 ± 1/3 档距"才换档。 */
const THIRD = 1 / 3;
/** 快慢两档滑动 + 迟滞判据（1.1.0 的用户指定手感）。 */
const SLIDE_FAST = ".16s cubic-bezier(.2,.9,.3,1)";
const SLIDE_SLOW = ".34s cubic-bezier(.45,.05,.35,1)";
const SLOW_ENTER_MS = 320;
const SLOW_EXIT_MS = 200;
/** 翻页时长（参考实现 `--page:.3s cubic-bezier(.32,.72,.28,1)`）。 */
const PAGE_EASE = ".3s cubic-bezier(.32,.72,.28,1)";
/** 星空参数：颗数 / 黄金比 / 基准时长 / 时长浮动 / 亮度下限 / 播速上限。 */
const STAR_N = 22;
const GOLD = 0.6180339887498949;
const STAR_BASE_S = 1.5;
const STAR_SPREAD = 0.08;
const STAR_MIN = 0.5;
const MAX_SPEED = 2;
/** 能量段：位置 1/3 起通电，最右端满能量（4 档模型的 high 正好半能量）。 */
const ENERGY_START = 1 / 3;
/**
 * 星尘的底色 —— **写死的浅色，不跟主题令牌走**（1.3.4 的用户实测反馈：
 * "浅色模式的星尘颜色不对，深浅主题下星尘都要是浅色"）。
 *
 * 为什么必须写死：星尘永远飘在**填充层**上（蓝→紫，见 `fillBackgroundFor`，那套颜色本身就是
 * 写死的、不随主题变），而 `--dsw-alias-label-primary` 在**浅色主题下是近黑色** ——
 * 于是浅色模式下星尘变成深色小点，糊在紫底上几乎看不见。
 */
const STAR_COLOR = "#eaf0ff";
/** 星尘的一圈微光（同样是固定色，浅色主题下也保证"是亮的"）。 */
const STAR_GLOW = "rgba(234,240,255,.7)";

/**
 * 面板的**毛玻璃 + 阴影**（1.3.9，用户实测反馈："浅色主题时面板跟背景颜色相似，
 * 周围加一层阴影吧，官方的毛玻璃（微微透）的效果也要"）。
 *
 * 三件事都照官方口径来，不自己发明：
 *
 * 1. **模糊**：官方菜单材料用的是 `--dsw-menu-backdrop-filter: blur(40px) saturate(150%)`
 *    （定义在 `body` 上；自定义属性会**继承**，所以我们的面板直接取得到）。
 *    字面值原样写进兜底 —— 万一哪天令牌改名，观感也是官方那套。
 *    `-webkit-` 前缀：Electron/Chromium 认标准属性，但带上更保险（老 WebKit 只认前缀）。
 * 2. **半透明底**：模糊只有在"底是半透明的"时才看得见。所以不能用官方的
 *    `--dsw-alias-bg-layer-1`（那是不透明色）。官方的菜单填充令牌是
 *    `--dsw-menu-surface-fill`：浅色 `#f8f9fa94`（≈58% 透）、深色 `#43454a73`（≈45% 透）。
 *    ⚠️ 1.3.10 起我们**比官方再透一档**（用户实测："再透一点"）：**保留官方色相、只降 alpha**
 *    —— 浅色 `#f8f9fa` → `.46`、深色 `#43454a` → `.40`。
 *    为什么不用 `color-mix()` 去"把官方令牌调淡"：那需要 `color-mix` 支持，
 *    老引擎上整条声明会失效、面板直接变成**没有底色** ✗；写死同色相的 rgba 则永远成立。
 * 3. **阴影**：官方的 `--dsw-elevation-prominent` 是
 *    `stroke + 0 3px 8px #0000000a + 0 0 20px #0000000d` —— alpha 只有 4%~5%，
 *    在浅色页面上几乎看不见（用户看到的就是"面板跟背景一个颜色"）。
 *    所以叠上官方的 `--dsw-shadow-lv3`（`0 12px 32px #00000014`）再补一层更实的落地阴影；
 *    深色主题另给一套（黑得更实，因为浅色那套在深底上没有存在感）。
 */
const GLASS_VARS = [
  "--cxp-glass:rgba(248,249,250,.46)",
  "--cxp-shadow:var(--dsw-elevation-stroke,0 0 0 .5px rgba(0,0,0,.14)),var(--dsw-shadow-lv3,0 12px 32px 0 rgba(0,0,0,.08)),0 6px 18px rgba(15,18,28,.10)",
].join(";");
const GLASS_VARS_DARK = [
  "--cxp-glass:rgba(67,69,74,.4)",
  // 卡片的"提亮"在深色下换成一层薄白（原来用的是不透明的 bg-layer-2，会把毛玻璃盖住）
  "--cxp-panel-2:rgba(255,255,255,.06)",
  "--cxp-shadow:0 0 0 .5px rgba(255,255,255,.09),0 12px 32px rgba(0,0,0,.55),0 6px 18px rgba(0,0,0,.45)",
].join(";");
/** 写入去抖（沿用 1.1.0 的实测值）。 */
const COMMIT_SETTLE_MS = 260;
/** 滑条量不到宽度时的兜底（假 DOM / 首帧），只用来算星尘横穿距离。 */
const FALLBACK_SLIDER_W = 248;

/**
 * 面板视口高度算式用的**实算行高**（都是 `padding + font-size × line-height 1.5`）。
 *
 * 这些数字必须与 CSS 同步，改样式就要回来改这里 —— 第 30 节有一条"算式与 CSS 实算一致"
 * 的断言盯着这个同步关系。之前 `rowH` 是拍出来的 38（真实 41），每行少 3px，
 * 一级页最后一行被 `overflow:hidden` 裁掉且滚不到。
 */
const SEC_H = 30;    // .cxp-sec   ：4+8 + 12×1.5
const ROW_H = 41;    // .cxp-row   ：10+10 + 14×1.5
const HEAD_H = 36;   // .cxp-head  ：2+8 + 26（返回按钮高）
const SEARCH_H = 40; // .cxp-search：7+7 + 13×1.5 + 6（底部 margin）
const MODEL_H = 39;  // .cxp-model ：9+9 + 14×1.5
/** 列表可视高上限 —— 与 `.cxp-list` 的 `max-height` **共用同一个常量**（拼进 CSS，不会再脱节）。 */
const LIST_MAX_H = 252;
/** `.cxp-list` 的底部内边距（算式里要算进去）。 */
const LIST_PAD_B = 4;
/**
 * 空目录 / 失败清单的高度 —— 视口高度必须**装得下它们**。
 *
 * ⚠️ 这两个常量是 1.3.3 补的，起因是**真机上的一次事故**：空目录（一个 provider 都没列出来）时
 * `viewportHeightFor` 只给了 `max(44, 30 + 0×41) = 44px`，而"没有可用的 provider / 正在读取…"
 * 那句提示要 48px —— 于是被 `.cxp-viewport` 的 `overflow:hidden` **整句裁掉**：
 * 用户看到的是"面板一片空白 + 档位 `—` + 滑条灰掉"，**连失败原因都读不到**。
 */
const EMPTY_H = 48;   // .cxp-empty  ：padding 14+14 + 13×1.5 ≈ 47.5
const FAILURE_H = 30; // .cxp-failure：padding 4+4 + 12×1.6 ≈ 27.2
/** 失败清单最多列几条（再多也只是同一类原因重复，面板不该被撑爆）。 */
const FAILURE_MAX_ROWS = 4;

/* ════════════════════════════ 样式 ════════════════════════════ */

/**
 * 规则全部以 `.cxp-` 前缀 + 全部限定在 `.cxp` 根内：不碰官方 class，也不与 1.2.0 那半边
 * （`.ces-`）互相影响。圆角照旧显式写 `corner-shape:round` —— DSH 主题给 `*` 设了全局
 * 超椭圆，不写的话球会被渲染成"圆角矩形"。
 */
const CSS = [
  ".cxp{--cxp-panel:var(--dsw-alias-bg-layer-1,#232329);--cxp-panel-2:rgba(255,255,255,.55);--cxp-line:var(--dsw-alias-border-l1,#2e2e35);--cxp-line-2:var(--dsw-alias-border-l2,#35353c);--cxp-txt:var(--dsw-alias-label-primary,#e7e9ee);--cxp-txt-2:var(--dsw-alias-label-tertiary,#9aa0ab);--cxp-txt-3:var(--dsw-alias-label-caption,#7c8290);--cxp-hover:var(--dsw-alias-interactive-bg-hover,#2b2b32);--cxp-slide:" + SLIDE_FAST + ";" + GLASS_VARS + ";font-size:13px;line-height:1.5;color:var(--cxp-txt)}",
  /* 深色主题下换一套毛玻璃底与阴影（浅色那套在浅背景上太"糊"）。
     主题属性挂在 `body` 上（官方主题包就是这么写的：`body[data-ds-dark-theme]`），
     我们的面板 portal 到 body，所以这个选择器命中得到。 */
  "body[data-ds-dark-theme] .cxp{" + GLASS_VARS_DARK + "}",
  /* `.cxp` 只承载设计令牌与字号：trigger（流内）与 panel（portal 到 body）都带这个类，
     各自为政，不再有"零尺寸绝对外壳"这种把两者捆在一个容器里的东西。 */
  ".cxp,.cxp *{box-sizing:border-box}",
  /* 快/慢两档：拖得慢 → 过渡也慢。`data-slide` 由 `noteStep()` 的迟滞判据切换。
     少了这条规则，`slideSlow` / `SLOW_ENTER_MS` / `SLOW_EXIT_MS` / `SLIDE_SLOW` 那一整套
     只是白白触发重渲染 —— 用户要的"拖得慢动画也慢"在自建面板里从未生效（真机复现：全仓库
     只有 `.ces-`（默认关闭的那半边）有对应规则）。 */
  ".cxp[data-slide='slow']{--cxp-slide:" + SLIDE_SLOW + "}",
  ".cxp-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:230px;padding:0 10px;border:1px solid var(--cxp-line-2);border-radius:999px;corner-shape:round;background:transparent;color:var(--cxp-txt);font:inherit;font-size:13px;cursor:pointer}",
  ".cxp-trigger:hover{background:var(--cxp-hover)}",
  ".cxp-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d93f8))}",
  /* 接管官方那颗席按钮之后，输入行给的**紧凑态**约定要跟着接过来：行放不下时它把
     `--dsh-composer-model-text-display` 设成 none、`--dsh-composer-model-icon-display` 设成 block，
     官方那颗席按钮就是靠这两个变量切成"纯图标"的（见官方 ModelSelect 的 CSS）。
     变量缺席时就是原来的样子：文字显示、图标不显示。 */
  ".cxp-trigger__icon{display:var(--dsh-composer-model-icon-display,none);flex:none;color:var(--cxp-txt-2)}",
  ".cxp-trigger__name{display:var(--dsh-composer-model-text-display,block);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".cxp-trigger__effort{display:var(--dsh-composer-model-text-display,block);font-weight:600;flex:none}",
  /* owner 的 `locked`（输入区被锁）→ 与官方席同样的灰化 + 不可点 */
  ".cxp-trigger[data-locked='1']{color:var(--cxp-txt-3);cursor:default}",
  ".cxp-trigger[data-locked='1']:hover{background:transparent}",
  ".cxp-chev{width:10px;height:10px;flex:none;color:var(--cxp-txt-2);transition:transform .12s}",
  ".cxp-chev[data-open='1']{transform:rotate(180deg)}",
  /* 定位靠 bottom（底边锚定，见 computePanelPos）：底边冻结在触发器上方，内容变高向上长。
     `overflow:auto` 是极矮窗口的安全网 —— 面板顶到视口上沿之后改为内部滚动，不会顶出屏幕。
     这里**不会**裁掉档位弹层：`.cxp-pop` 是 fixed，而本元素没有 transform/will-change，
     不构成它的包含块。 */
  /* 定位壳：**不能带 `overflow`**（那会把面板的 box-shadow 裁成矩形 —— 1.3.10 的真机反馈
     "阴影好像被一个框限制了"）。矮窗口的滚动安全网在 `.cxp-panel` 上，见那里的注释。 */
  ".cxp-root{position:fixed;z-index:1100;width:" + PANEL_W + "px;overflow:visible}",
  /* `transform-origin` 跟锚定边一致：缩放从**贴着触发器那一角**长出来，而不是从上方远处。 */
  /* 面板本体：官方"菜单材料"那套 = **半透明底 + 毛玻璃 + 阴影**（见 `GLASS_VARS` 的长注释）。
     `overflow:auto` 是矮窗口的安全网（`max-height` 由行内样式给，见渲染处的注释）——
     放在**自己这一层**，所以不裁自己的阴影。`-webkit-backdrop-filter` 与标准属性都写。 */
  ".cxp-panel{width:" + PANEL_W + "px;overflow:auto;background:var(--cxp-glass,var(--cxp-panel));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));border:1px solid var(--cxp-line);border-radius:14px;corner-shape:round;padding:10px;box-shadow:var(--cxp-shadow,var(--dsw-elevation-prominent,0 18px 50px rgba(0,0,0,.5)));animation:cxp-pop .16s ease;transform-origin:bottom right}",
  "@keyframes cxp-pop{from{opacity:0;transform:scale(.96) translateY(-4px)}}",
  ".cxp-viewport{position:relative;overflow:hidden;transition:height " + PAGE_EASE + "}",
  ".cxp-page{position:absolute;top:0;left:0;width:100%;transition:transform " + PAGE_EASE + "}",
  ".cxp-page[data-slot='1']{transform:translateX(0)}",
  ".cxp-page[data-slot='2']{transform:translateX(100%)}",
  ".cxp-viewport[data-view='2'] .cxp-page[data-slot='1']{transform:translateX(-100%)}",
  ".cxp-viewport[data-view='2'] .cxp-page[data-slot='2']{transform:translateX(0)}",
  ".cxp-sec{font-size:12px;color:var(--cxp-txt-2);padding:4px 8px 8px}",
  ".cxp-row{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;background:transparent;border:none;color:var(--cxp-txt);font:inherit;font-size:14px;padding:10px;border-radius:10px;corner-shape:round;cursor:pointer;user-select:none;-webkit-user-select:none;text-align:left}",
  ".cxp-row:hover,.cxp-row:focus-visible{background:var(--cxp-hover);outline:none}",
  ".cxp-row__cur{flex:1;min-width:0;max-width:110px;font-size:11px;color:var(--cxp-txt-3);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".cxp-head{display:flex;align-items:center;gap:6px;padding:2px 4px 8px}",
  ".cxp-back{width:26px;height:26px;flex:none;display:grid;place-items:center;background:transparent;border:none;border-radius:8px;corner-shape:round;color:var(--cxp-txt-2);cursor:pointer}",
  ".cxp-back:hover{background:var(--cxp-hover);color:var(--cxp-txt)}",
  ".cxp-back svg{width:12px;height:12px}",
  ".cxp-title{font-size:14px;font-weight:600}",
  ".cxp-search{display:flex;align-items:center;gap:8px;margin:0 4px 6px;padding:7px 10px;background:var(--dsw-alias-bg-layer-3,var(--cxp-hover));border-radius:10px;corner-shape:round}",
  ".cxp-search svg{width:13px;height:13px;flex:none;color:var(--cxp-txt-3)}",
  ".cxp-search input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--cxp-txt);font:inherit;font-size:13px}",
  ".cxp-list{overflow-y:auto;max-height:" + LIST_MAX_H + "px;overscroll-behavior:contain;padding:0 2px " + LIST_PAD_B + "px}",
  ".cxp-group{font-size:12px;color:var(--cxp-txt-2);padding:8px 8px 4px}",
  ".cxp-model{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;background:transparent;border:none;color:var(--cxp-txt);font:inherit;font-size:14px;padding:9px 10px;border-radius:9px;corner-shape:round;cursor:pointer;text-align:left;user-select:none;-webkit-user-select:none}",
  ".cxp-model:hover,.cxp-model:focus-visible{background:var(--cxp-hover);outline:none}",
  ".cxp-model__name{display:flex;align-items:center;gap:6px;min-width:0}",
  ".cxp-model__name>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".cxp-model[data-na='1'] .cxp-model__name>span:first-child{color:var(--cxp-txt-2)}",
  ".cxp-cnt{flex:none;font-size:10.5px;color:var(--cxp-txt-3);background:var(--cxp-hover);border-radius:6px;corner-shape:round;padding:1px 6px}",
  ".cxp-model[data-na='1'] .cxp-cnt{color:var(--dsw-alias-state-warn-label,#6b5b4a)}",
  ".cxp-ck{width:15px;height:15px;flex:none;color:var(--cxp-txt);opacity:0}",
  ".cxp-model[data-sel='1'] .cxp-ck{opacity:1}",
  ".cxp-empty{color:var(--cxp-txt-2);font-size:13px;padding:14px 10px;text-align:center}",
  /* 失败行：照官方 ModelSelect 的 warning 口径（危险底色 + 错误色文字），只是不用它的哈希 class */
  ".cxp-failure{border-radius:8px;corner-shape:round;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12));color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:1.6;padding:4px 8px;margin:0 2px 3px;word-break:break-word}",
  ".cxp-card{margin-top:8px;background:var(--cxp-panel-2);border:1px solid var(--cxp-line);border-radius:14px;corner-shape:round;padding:12px 14px 14px;transition:border-color .3s}",
  ".cxp-card__head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}",
  ".cxp-card__title{font-size:14px}",
  ".cxp-more{display:flex;align-items:center;gap:4px;background:transparent;border:none;color:var(--cxp-txt);font:inherit;font-size:14px;font-weight:600;cursor:pointer;padding:0}",
  ".cxp-more:disabled{opacity:.4;cursor:default}",
  ".cxp-slider{position:relative;height:" + KNOB + "px;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}",
  ".cxp[data-disabled='1'] .cxp-slider{pointer-events:none}",
  ".cxp[data-disabled='1'] .cxp-card{opacity:.45}",
  ".cxp-track{position:absolute;left:0;right:0;top:50%;height:" + TRACK_H + "px;transform:translateY(-50%);background:var(--dsw-alias-border-l1,#303036);border-radius:" + TR + "px;corner-shape:round}",
  ".cxp-fill{position:absolute;left:0;top:50%;transform:translateY(-50%);height:" + TRACK_H + "px;border-radius:" + TR + "px;corner-shape:round;overflow:hidden;transition:width var(--cxp-slide)}",
  ".cxp[data-off='1'] .cxp-fill{opacity:0}",
  ".cxp-nebula{position:absolute;inset:0;border-radius:inherit;background:linear-gradient(90deg,#3f8cff 0%,#7c6cf6 55%,#a855f7 100%);opacity:var(--energy,0);transition:opacity var(--cxp-slide)}",
  ".cxp-stars{position:absolute;inset:0 auto 0 0;height:100%;border-radius:" + TR + "px;corner-shape:round;overflow:hidden;pointer-events:none;transition:width var(--cxp-slide)}",
  ".cxp-star{position:absolute;left:100%;border-radius:50%;corner-shape:round;background:" + STAR_COLOR + ";box-shadow:0 0 2px " + STAR_GLOW + ";opacity:0;display:none;animation:cxp-drift var(--cxp-d,7s) linear infinite}",
  ".cxp-star[data-on='1']{display:block}",
  "@keyframes cxp-drift{0%{transform:translateX(4px);opacity:0}12%{opacity:var(--cxp-o,.8)}82%{opacity:var(--cxp-o,.8)}100%{transform:translateX(calc(-1 * var(--cxp-travel,220px) - 8px));opacity:0}}",
  ".cxp-ticks{position:absolute;inset:0;pointer-events:none}",
  ".cxp-tick{position:absolute;top:50%;width:4px;height:4px;border-radius:50%;corner-shape:round;transform:translate(-50%,-50%);background:var(--dsw-alias-label-tertiary,#5a5f6a);transition:opacity var(--cxp-slide),background .2s}",
  ".cxp-tick[data-hit='1']{background:var(--dsw-alias-label-primary,#d7dce6)}",
  ".cxp[data-off='1'] .cxp-tick{background:var(--dsw-alias-label-tertiary,#5a5f6a)}",
  ".cxp[data-solo='1'] .cxp-tick:not([data-cur='1']){opacity:0}",
  /* 旋钮**固定白色**，不跟主题令牌走：浅色与深色都该是同一颗白球（与 1.2.0 的 `.ces-knob` 一致，
     它写的就是 `background:#fff`）。原来这里是 `var(--dsw-alias-bg-layer-1,#fff)`，
     而该令牌**在深色主题下就是深色**（兜底值 `#232329` 正说明它的意图）——
     于是深色模式下旋钮变成一颗深色球，与深色轨道糊在一起、几乎看不见。 */
  ".cxp-knob{position:absolute;top:50%;width:" + KNOB + "px;height:" + KNOB + "px;border-radius:50%;corner-shape:round;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.32);pointer-events:none;transform:translate(-50%,-50%);transition:left var(--cxp-slide)}",
  /* 档位弹层：与面板同一种材料（官方菜单都这么做）。它叠在面板之上，双层模糊观感一致。 */
  ".cxp-pop{position:fixed;z-index:1200;min-width:150px;background:var(--cxp-glass,var(--cxp-panel));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));border:1px solid var(--cxp-line);border-radius:12px;corner-shape:round;padding:5px;box-shadow:var(--cxp-shadow,var(--dsw-elevation-prominent,0 14px 40px rgba(0,0,0,.5)));animation:cxp-pop .14s ease}",
  ".cxp-pop__row{width:100%;display:flex;justify-content:space-between;align-items:center;gap:14px;background:transparent;border:none;color:var(--cxp-txt);font:inherit;font-size:13.5px;padding:8px 10px;border-radius:8px;corner-shape:round;cursor:pointer}",
  ".cxp-pop__row:hover,.cxp-pop__row:focus-visible{background:var(--cxp-hover);outline:none}",
  ".cxp-pop__api{font-size:11px;color:var(--cxp-txt-2)}",
  ".cxp-pop__ck{width:14px;height:14px;flex:none;color:var(--cxp-txt)}",
  ".cxp-err{margin-top:8px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#e5484d)}",
  ".cxp[data-motion='reduced'] .cxp-star{animation-duration:calc(var(--cxp-d,7s) * 2.6)}",
  "@media (prefers-reduced-motion:reduce){.cxp-star{animation-duration:calc(var(--cxp-d,7s) * 2.6)}.cxp-page,.cxp-viewport{transition-duration:.01s}}",
].join("\n");

/* ════════════════════════════ 纯函数（可离线断言）════════════════════════════ */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 位置 → 能量：位置 1/3 起通电，最右端满能量（4 档的 high = 位置 2/3 → 正好 0.5）。 */
function energyFor(pct) {
  const p = clamp(Number(pct) || 0, 0, 1);
  return clamp((p - ENERGY_START) / (1 - ENERGY_START), 0, 1);
}

/** 位置 → 播速（0.35× ~ 2×）。 */
function speedFor(pct) {
  return 0.35 + energyFor(pct) * (MAX_SPEED - 0.35);
}

function mixColor(from, to, t) {
  const f = clamp(t, 0, 1);
  const out = [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * f));
  return "rgb(" + out.join(",") + ")";
}

const COLOR_BLUE = [63, 140, 255];
const COLOR_VIOLET = [168, 85, 247];
const COLOR_DEEP = [124, 108, 246];

/** 填充层背景 = 左端恒蓝 → 右端"当前位置的颜色"（蓝 → 靛 → 紫）。 */
function fillBackgroundFor(pct) {
  const p = clamp(Number(pct) || 0, 0, 1);
  const end = p <= 0.5
    ? mixColor(COLOR_BLUE, COLOR_DEEP, p / 0.5)
    : mixColor(COLOR_DEEP, COLOR_VIOLET, (p - 0.5) / 0.5);
  return "linear-gradient(90deg," + mixColor(COLOR_BLUE, COLOR_VIOLET, 0) + " 0%," + end + " 100%)";
}

/** 档位名（"Max"）的颜色：Off 档返回空串 = 交还主题颜色（参考实现同款语义）。 */
function valueColorFor(pct, level) {
  if (isOffLevel(level)) return "";
  const p = clamp(Number(pct) || 0, 0, 1);
  return p <= 0.5
    ? mixColor(COLOR_BLUE, COLOR_VIOLET, p / 0.5)
    : mixColor(COLOR_VIOLET, COLOR_DEEP, (p - 0.5) / 0.5);
}

/** Off 档判定：`off` / `none` / `关闭` / `无` 都算（大小写与空白不敏感）。 */
function isOffLevel(level) {
  if (!level) return false;
  const id = typeof level.id === "string" ? level.id.replace(/\s+/g, "").toLowerCase() : "";
  const name = typeof level.name === "string" ? level.name.replace(/\s+/g, "").toLowerCase() : "";
  const offIds = ["off", "none", "关闭", "无"];
  return offIds.indexOf(id) >= 0 || offIds.indexOf(name) >= 0;
}

/** 档位下标 → 位置（0 ~ 1）。 */
function pctFromIndex(index, count) {
  if (!(count > 1)) return 0;
  return clamp(index, 0, count - 1) / (count - 1);
}

/** 位置 → 旋钮/填充/刻度的水平位置（端头半径内缩，两端圆心正好落在端头圆心上）。 */
function leftFor(pct) {
  const t = Math.round(clamp(Number(pct) || 0, 0, 1) * 10000) / 10000;
  return "calc(" + TR + "px + " + t + " * (100% - " + TR * 2 + "px))";
}

/** 位置 → 可见星尘数（0 ~ 22）。 */
function starCountFor(pct) {
  return Math.round(energyFor(pct) * STAR_N);
}

/** 星尘的确定性伪随机（同一颗星每帧都要一样，所以不用 Math.random）。 */
function hash01(index, salt) {
  let x = Math.imul(index + 1, salt) ^ Math.imul(salt, 2654435761);
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** 第 i 颗星的高度（参考实现用 8 条固定泳道，这里同一手法）。 */
function starTopFor(index) {
  const slot = Math.floor(hash01(index, 0x51ab) * 8) % 8;
  return 15 + slot * 10;
}

/** 第 i 颗星的直径（1.2 ~ 2.8px）。 */
function starSizeFor(index) {
  return Number((1.2 + hash01(index, 0x99) * 1.6).toFixed(2));
}

/** 第 i 颗星的亮度（0.5 ~ 1，亮度即大小）。 */
function starBrightnessFor(index) {
  return Number((STAR_MIN + hash01(index, 0xaa) * (1 - STAR_MIN)).toFixed(2));
}

/** 第 i 颗星的横穿时长：位置越快越短，各星只差 ±8%（避免快星追上慢星排成一队）。 */
function starDurationFor(index, speedFactor) {
  const base = STAR_BASE_S * (1 + (hash01(index, 0x77) - 0.5) * 2 * STAR_SPREAD);
  return base * (MAX_SPEED / Math.max(0.01, Number(speedFactor) || MAX_SPEED));
}

/** 第 i 颗星的相位（黄金比低差异序列 + 一点抖动），用负延迟中途起播。 */
function starDelayFor(index, duration) {
  const jitter = hash01(index, 53) * 0.03;
  return -((((index * GOLD) % 1) + jitter) % 1) * duration;
}

/* ═══════════════ 二级页模型列表的排序：新发布 → 旧发布 ═══════════════ */

/**
 * **宿主目录里没有发布日期字段** —— 这不是猜的：`session/modelCatalog` 的产物 schema
 * （`dsh-api-session-controller/lib/typert.host.js`）里，模型条目只有
 * `{ id, name, description?, reasoning? }`，没有 `releasedAt` / `createdAt` / `version` 之类。
 * 所以"新 → 旧"只能从**名字里本来就有的两个信号**算：
 *
 *   1. **版本号**：第一个数字串（`gpt-6-astra` → `6`、`gpt-5.6-sol` → `5.6`、
 *      `deepseek-v41-flash` → `41`、`gpt-4o` → `4`）
 *   2. **日期**：`2026-01-13` / `20260113` / `2026-01` 这类片段（只有"钉住的快照版"才有）
 *
 * 规则（确定性，且**稳定**：键完全相同的保持宿主原顺序）：
 *   1. 版本号大的在前（`6` > `5.6` > `4`；逐段比大小，短的一方缺位按 0 算）
 *   2. 同版本：**别名在前、它的快照版在后** —— `gpt-6-astra` 指向最新，
 *      `gpt-6-astra-2026-01-13` 是钉死的旧版（快照版按 `<别的模型 id 或 name>-<日期>` 认出来）
 *   3. 同为快照：日期新的在前
 *   4. 认不出任何版本号的（`plain-model` 这种）：排在所有有版本号的后面，内部保持宿主原顺序
 *
 * 为什么要专门有一条"别名 vs 快照"：只按日期排会把 `…-2026-01-13` 顶到别名前面，
 * 而那恰好排反了 —— 别名永远是"当前最新"，带日期的那个是它的历史版本。
 */

/** 去掉文本里的日期片段，剩下的才拿去解析版本号（否则 `2026` 会被当成版本）。 */
function withoutDates(text) {
  return String(text || "")
    /* 两处都带**数字边界**：不然 `123456789`（9 位）会被切掉前 8 位、给出版本 `9` 这种假信号。
       （`(^|\D)` 是为了不放宽"前面不能是数字"这条，收进来的字符原样写回。） */
    .replace(/(^|\D)\d{4}-\d{1,2}(?:-\d{1,2})?(?!\d)/g, "$1 ")
    .replace(/(^|\D)\d{8}(?!\d)/g, "$1 ");
}

/**
 * 文本里的日期 → 可比较的数字 `YYYYMMDD`（没有日期返回 0）。
 * 认三种写法：`2026-01-13`、`2026-01`、`20260113`；月份/日期越界的一律不算（脏数据不猜）。
 */
function dateRankOf(text) {
  const s = String(text || "");
  let best = 0;
  const take = (year, month, day) => {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day === undefined ? 0 : day);
    if (!(y >= 1900 && y <= 2999)) return;
    if (!(m >= 1 && m <= 12)) return;
    if (!(d >= 0 && d <= 31)) return;
    const value = y * 10000 + m * 100 + d;
    if (value > best) best = value;
  };
  let match;
  const dashed = /(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/g;
  while ((match = dashed.exec(s)) !== null) take(match[1], match[2], match[3]);
  const compact = /(\d{4})(\d{2})(\d{2})/g;
  while ((match = compact.exec(s)) !== null) {
    const before = match.index > 0 ? s.charAt(match.index - 1) : "";
    const after = match.index + 8 < s.length ? s.charAt(match.index + 8) : "";
    // 前后还连着数字的说明它不是一段独立的 8 位日期（比如更长的数字串）
    if (/\d/.test(before) || /\d/.test(after)) continue;
    take(match[1], match[2], match[3]);
  }
  return best;
}

/** 文本里的版本号 → `[6]` / `[5, 6]` / `[41]`；认不出返回 `null`。 */
function versionRankOf(text) {
  const match = /(\d+(?:\.\d+)*)/.exec(withoutDates(text));
  if (match === null) return null;
  return match[1].split(".").map((part) => Number(part));
}

/** 版本号降序比较（`null` = 认不出 → 永远排在最后）。 */
function compareVersionRank(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = i < left.length ? left[i] : 0;
    const b = i < right.length ? right[i] : 0;
    if (a !== b) return b - a;
  }
  return 0;
}

/** `<别的模型>-<日期>` 这类 id/name → 它属于哪个模型（快照版判定）；不是快照返回 null。 */
function pinOwnerOf(entry, byKey) {
  if (!entry || byKey.size === 0) return null;
  for (const candidate of [entry.id, entry.name]) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const match = /^(.*?)-(\d{4}-\d{1,2}(?:-\d{1,2})?|\d{8})$/.exec(candidate);
    if (match === null) continue;
    const owner = byKey.get(match[1]);
    if (owner !== undefined && owner !== entry) return owner;
  }
  return null;
}

/**
 * 模型列表 → **新发布在前**的新数组（不改动入参）。
 * 排序键依次是：版本号 ↓ → 快照版靠后 → 日期 ↓ → 宿主原顺序 ↑。
 */
function sortModelsNewestFirst(models) {
  if (!Array.isArray(models)) return [];
  if (models.length < 2) return models.slice();
  const byKey = new Map();
  for (const entry of models) {
    if (!entry) continue;
    if (typeof entry.id === "string" && entry.id.length > 0) byKey.set(entry.id, entry);
    if (typeof entry.name === "string" && entry.name.length > 0) byKey.set(entry.name, entry);
  }
  const items = models.map((entry, index) => {
    const id = entry && typeof entry.id === "string" ? entry.id : "";
    const name = entry && typeof entry.name === "string" ? entry.name : "";
    /*
     * 版本号**先看 id、id 认不出才看 name**，不把两者拼起来看：
     * 拼起来会让 id 里任何无关的数字（`snapshot-1`、`model-2` 这种下标）抢在真正的版本号前面。
     * 日期则两边都看（取大的那个）：id 带日期的快照版不少，日期只写在显示名里的也有。
     */
    const idVersion = versionRankOf(id);
    return {
      entry: entry,
      index: index,
      version: idVersion !== null ? idVersion : versionRankOf(name),
      pinned: pinOwnerOf(entry, byKey) !== null,
      date: Math.max(dateRankOf(id), dateRankOf(name)),
    };
  });
  items.sort((a, b) => compareVersionRank(a.version, b.version)
    || (a.pinned === b.pinned ? 0 : a.pinned ? 1 : -1)
    || (b.date - a.date)
    || (a.index - b.index));
  return items.map((item) => item.entry);
}

/* ════════════════════════ 目录快照 → 面板要的那几个量 ════════════════════════ */

/**
 * 把目录快照折成面板需要的形状。**纯函数**：读不懂的条目一律按"不支持"处理，
 * 绝不抛错（一条脏数据最多让那颗徽标显示"不支持"，不影响其余模型与滑条）。
 *
 * 每个 provider 的 `models` 在这里就按**新发布 → 旧发布**排好（见 `sortModelsNewestFirst`），
 * 于是二级页、搜索过滤结果、以及将来任何读这份目录的人都拿到同一个顺序 —— 只有一处真相。
 */
/**
 * **默认档位的下标：取正中；总档数为偶数时取"中间的下一个"**（用户指定的规则）。
 *
 * 0 基下标 = `floor(n / 2)`，逐一对照：
 *
 * | 总档数 | 下标 | 第几档（1 基） | 说明 |
 * | --- | --- | --- | --- |
 * | 1 | 0 | 第 1 档 | 唯一那档 |
 * | 2 | 1 | 第 2 档 | 中点在 1/2 之间 → 下一档 |
 * | 3 | 1 | 第 2 档 | 正中 |
 * | **4** | **2** | **第 3 档** | **用户给的例子（双数 → 中间的下一个）** |
 * | 5 | 2 | 第 3 档 | 正中 |
 * | 6 | 3 | 第 4 档 | 中点在 3/4 之间 → 下一档 |
 *
 * 两处用它：① **点击模型换模型时**写回宿主的档位（`switchModel`）；
 * ② 目录里"当前模型没有明确档位"时滑条停在哪一档（`readCatalog`）。
 * 以前这两处都是"最后一档（Max）"，所以换模型后总落在最高档 —— 这条规则把它改成中间。
 *
 * ⚠️ 宿主声明的 `reasoning.defaultEffort`（`def`）**不再参与定位**：用户明确要求
 * "点击使用时默认中间的档位"，两者冲突时以用户规则为准（`def` 仍留在目录数据里）。
 */
function defaultLevelIndex(levels) {
  const count = Array.isArray(levels) ? levels.length : 0;
  return count === 0 ? -1 : Math.floor(count / 2);
}

function readCatalog(snapshot) {  const groups = snapshot && Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const providers = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (!group || typeof group.id !== "string" || !Array.isArray(group.models)) continue;
    const models = [];
    for (let j = 0; j < group.models.length; j += 1) {
      const model = group.models[j];
      if (!model || typeof model.id !== "string" || model.id.length === 0) continue;
      const efforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
      const levels = [];
      for (let k = 0; k < efforts.length; k += 1) {
        const effort = efforts[k];
        if (!effort || typeof effort.id !== "string" || effort.id.length === 0) continue;
        levels.push({
          id: effort.id,
          name: typeof effort.name === "string" && effort.name.length > 0 ? effort.name : effort.id,
        });
      }
      models.push({
        id: model.id,
        name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
        levels: levels,
        def: model.reasoning && typeof model.reasoning.defaultEffort === "string" ? model.reasoning.defaultEffort : null,
      });
    }
    providers.push({
      id: group.id,
      name: typeof group.name === "string" && group.name.length > 0 ? group.name : group.id,
      models: sortModelsNewestFirst(models),
    });
  }

  const current = snapshot && snapshot.current && typeof snapshot.current === "object" ? snapshot.current : null;
  const providerId = current && typeof current.provider === "string" ? current.provider : null;
  const modelId = current && typeof current.model === "string" ? current.model : null;

  let provider = null;
  let model = null;
  for (let i = 0; i < providers.length && provider === null; i += 1) {
    if (providerId !== null && providers[i].id !== providerId) continue;
    for (let j = 0; j < providers[i].models.length; j += 1) {
      if (providers[i].models[j].id === modelId) { provider = providers[i]; model = providers[i].models[j]; break; }
    }
  }

  const explicit = current && typeof current.reasoningEffort === "string" ? current.reasoningEffort : null;
  let index = -1;
  if (model !== null) {
    // ① 会话里**明确存着**的档位优先（那是宿主真实的当前状态，不能拿默认值盖掉它）
    for (let i = 0; i < model.levels.length; i += 1) if (model.levels[i].id === explicit) index = i;
    // ② 没有明确档位 → 停在**正中**（偶数档取中间的下一个），与"点击模型时写哪一档"同一条规则
    if (index < 0) index = defaultLevelIndex(model.levels);
  }

  const failures = [];
  const rawFailures = snapshot && Array.isArray(snapshot.failures) ? snapshot.failures : [];
  for (let i = 0; i < rawFailures.length; i += 1) {
    const failure = rawFailures[i];
    if (!failure || typeof failure !== "object") continue;
    const name = typeof failure.name === "string" && failure.name.length > 0
      ? failure.name
      : typeof failure.id === "string" ? failure.id : "";
    const message = typeof failure.message === "string" ? failure.message : "";
    if (name.length === 0 && message.length === 0) continue;
    failures.push({ name: name, message: message });
  }

  return {
    providers: providers,
    providerId: providerId,
    providerName: provider === null ? providerId : provider.name,
    model: model,
    modelId: modelId,
    levelIndex: index,
    level: model !== null && index >= 0 ? model.levels[index] : null,
    unsupported: model === null || model.levels.length === 0,
    status: snapshot && typeof snapshot.status === "string" ? snapshot.status : "idle",
    error: snapshot && typeof snapshot.error === "string" ? snapshot.error : null,
    /**
     * 宿主**逐 provider** 的加载失败（`groups` 里没有它们，`failures` 里有原因）。
     * 官方那颗席按钮的菜单会把这些列出来（"{name} 加载失败：{message}"）；
     * 1.3.2 接管那一格之后，**这份责任就归我们了** —— 不显示的话用户只会看到"一片空白"。
     */
    failures: failures,
  };
}

/** 某个 provider 当前选中的模型名（一级页右侧那段灰字）。 */
function currentModelName(providers, providerId, modelId) {
  for (let i = 0; i < providers.length; i += 1) {
    if (providers[i].id !== providerId) continue;
    for (let j = 0; j < providers[i].models.length; j += 1) {
      if (providers[i].models[j].id === modelId) return providers[i].models[j].name;
    }
  }
  return modelId || "";
}

/** 二级页标题：优先用目录给的名字，查不到就退回 id。 */
function providerTitle(catalog, providerId) {
  if (providerId === null) return "";
  for (let i = 0; i < catalog.providers.length; i += 1) {
    if (catalog.providers[i].id === providerId) return catalog.providers[i].name;
  }
  return providerId;
}

/**
 * 一级页"提示块"的高度：失败清单优先（有几条列几条，封顶 `FAILURE_MAX_ROWS`），
 * 没有失败、又没有 provider 时才是一句"没有可用的 provider / 正在读取…"。
 *
 * 有 provider 时也可能有失败（部分 provider 挂了）—— 那时这些行是**追加**在列表下面的，
 * 所以这里返回的高度会加到 provider 行高之上。
 */
function noticeHeightFor(catalog) {
  const failures = catalog && Array.isArray(catalog.failures) ? catalog.failures : [];
  const rows = Math.min(failures.length, FAILURE_MAX_ROWS);
  if (rows > 0) return rows * FAILURE_H + (catalog.providers.length === 0 ? 8 : 4);
  return catalog.providers.length === 0 ? EMPTY_H : 0;
}

/**
 * 视口高度 = 当前这一页的高度（`.cxp-page` 是 absolute，不撑父级）。
 * 用**算式**而不是 DOM 测量：离线测试台没有布局引擎，测量会得到 0，
 * 高度永远是 0 面板就看不见了（参考实现用 `offsetHeight` 是因为它跑在真浏览器里）。
 *
 * ⚠️ 行高常量（`SEC_H` / `ROW_H` / …）**必须与 CSS 同步**，改样式要回来改常量：
 * 之前这里用的是拍出来的 38，比真实 `.cxp-row` 的 41 每行少 3px —— 一级页最后一行
 * 被 `.cxp-viewport` 的 `overflow:hidden` 裁掉，而且一级页没有滚动容器、**滚不回来**
 * （真机复现：2 个 provider 给 106px，实际需要 112px）。
 */
function viewportHeightFor(catalog, view, query, subProvider) {
  if (view !== 2 || subProvider === null) {
    // 空目录时 `noticeHeightFor` 兜住"提示句/失败清单"的高度（1.3.3 的真机事故就出在这里）
    return Math.max(44, SEC_H + catalog.providers.length * ROW_H + noticeHeightFor(catalog));
  }
  let models = 0;
  const needle = String(query || "").trim().toLowerCase();
  for (let i = 0; i < catalog.providers.length; i += 1) {
    if (catalog.providers[i].id !== subProvider) continue;
    const list = catalog.providers[i].models;
    for (let j = 0; j < list.length; j += 1) {
      if (needle.length === 0 || list[j].name.toLowerCase().indexOf(needle) >= 0) models += 1;
    }
    break;
  }
  // 一条都没匹配上时，列表里那句"无匹配模型"同样要放得下
  if (models === 0) return Math.max(44, HEAD_H + SEARCH_H + EMPTY_H + LIST_PAD_B);
  // `.cxp-list` 有 `max-height`：装不下就在列表内部滚动，页面高度到此为止
  const listH = Math.min(models * MODEL_H + LIST_PAD_B, LIST_MAX_H);
  return Math.max(44, HEAD_H + SEARCH_H + listH);
}

/* ════════════════════════════ 图标（内联，无外部资源）════════════════════════════ */

const ICON_CHEV_DOWN = "M3 4.5l3 3 3-3";
const ICON_CHEV_RIGHT = "M4.5 3l3 3-3 3";
const ICON_BACK = "M7.5 3L4 6.5l3.5 3.5";
const ICON_SEARCH = "M7 2.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM10.5 10.5L13.5 13.5";
const ICON_CHECK = "M3.5 8.5l3 3 6-7";
/**
 * 紧凑态那颗图标（自绘的"层叠"shape）：输入行放不下整颗席按钮时，行上会把两个
 * `--dsh-composer-model-*` 变量切换成"只显示图标"，见 `createPickerTrigger` 里的注释。
 */
const ICON_MODEL = "M6 1.6L10.4 3.9L6 6.2L1.6 3.9Z M2.2 6.4L6 8.4L9.8 6.4 M2.2 8.6L6 10.6L9.8 8.6";

function icon(React, path, extra) {
  const options = extra || {};
  return React.createElement("svg", {
    className: options.className || "cxp-chev",
    viewBox: options.viewBox || "0 0 12 12",
    width: options.size || 12,
    height: options.size || 12,
    fill: "none",
    "aria-hidden": "true",
    "data-open": options["data-open"],
    // 调用方可以给图标打 `data-ces-part`（触发器那颗紧凑态图标要靠它被断言/定位）
    "data-ces-part": options["data-ces-part"],
  }, React.createElement("path", {
    d: path,
    stroke: "currentColor",
    "stroke-width": options.width || 1.4,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }));
}

/* ════════════════════════════ 开合状态（模块级 mini-store）════════════════════════════ */

/**
 * trigger（`conversation.input.model` —— 接管官方那颗席按钮那一格；拿不到就退回
 * `conversation.input.right`）与 surface（`conversation.input.overlay`）是**两个独立插槽条目**，
 * 没有共同的 React 父级，开合状态只能放模块级。面板本体 portal 到 `document.body`，
 * 插槽只提供生命周期 —— 于是 `.cxp-root` / `.cxp-pop` 的 `position:fixed` 回到 body 直下，
 * 不再被 composer 卡片的 `transform` / `will-change` 动画劫持（那是"面板乱飘"的一半来源）。
 *
 * **开合状态按会话归属**：`owner` 记着面板属于哪个 `sessionId`。这是宿主插槽系统的正常契约
 * ——每个会话各有一颗按钮（官方的模型席按钮就是这么工作的），谁的面板只属于谁。
 * 这里**没有全局幂等守卫**：1.3.0 中途加过 `PICKER_*_LIVE` 两个全局布尔，那是**误诊** ——
 * 当时"两颗按钮"的真因是 `ENTRY_ID`（order 40）与 trigger（order 30）**两条条目都挂在
 * `conversation.input.right`**，关掉前者（`ENABLE_OFFICIAL_MENU_SLIDER = false`）就已根治。
 * 守卫防的是一个不存在的幽灵，代价却是实打实的：claim 是**渲染阶段**拿的，跨会话切换时会被
 * 旧实例占住 → 新会话固化 `claimed = false` → 按钮/面板随机缺失（新建对话**必然**没有）。
 */
const pickerStore = (() => {
  let open = false;
  let pos = null;
  let triggerEl = null;
  /** 面板归属的会话（`null` 表示没有归属，例如插槽没给 sessionId）。 */
  let owner = null;
  const listeners = new Set();
  function emit() { for (const fn of [...listeners]) { try { fn(); } catch (e) { /* 单个订阅者抛错不影响其它 */ } } }
  return {
    isOpen: () => open,
    /** 面板归属的 sessionId。 */
    owner: () => owner,
    /**
     * 面板是不是**这个会话**开着的。
     *
     * 用 `open && owner === sessionId` 而不是先判 `owner !== null`：插槽没给 sessionId 时
     * `owner` 也是 null，两边同为 null 应当算"是这个会话的"；而面板整体关着时 `open` 为 false，
     * 谁都不匹配。
     */
    isOpenFor: (sessionId) => open && owner === sessionId,
    position: () => pos,
    trigger: () => triggerEl,
    /**
     * 记下触发器节点。**传 null 一律忽略**：卸载中的实例会拿 null 进来，
     * 照单全收就会把还活着的那个实例的引用清掉（外点判定随之失效）。
     */
    setTrigger(el) { if (el) triggerEl = el; },
    /** 打开**某个会话**的面板：owner 一并换过去（B 的面板打开时 A 的自动收起）。 */
    openAt(rect, sessionId, composerRect) {
      open = true;
      owner = sessionId === undefined ? null : sessionId;
      pos = computePanelPos(rect, composerRect === undefined ? null : composerRect);
      emit();
    },
    /**
     * **按当前几何重算位置**（滚动 / 视口尺寸变化时调）。
     *
     * 1.3.4 之前这两个事件是**直接关面板**的，理由是"重定位正是面板乱飘的来源"。
     * 真机反馈推翻了它：助手流式输出时聊天区**一直在自动滚动**，scroll 在 capture 阶段
     * 到达 document → 面板被自己的策略关掉（用户原话："对话还没结束的时候，对话一刷新，
     * 面板就没了"）。而"乱飘"的顾虑其实不成立：面板是 `fixed` + **底边锚在触发器顶边**，
     * 聊天区滚动根本不动 composer；真动了（输入框长高、窗口缩放）也该跟着走而不是消失。
     *
     * 触发器不可见（宿主 `hidden` 了那一行）或几何拿不到 → **保持原位**（不动，也不关）。
     */
    reposition() {
      if (!open) return false;
      const rect = liveRectOf(triggerEl);
      if (rect === null) return false;
      const next = computePanelPos(rect, liveRectOf(composerCardOf(triggerEl)));
      if (pos !== null && pos.left === next.left && pos.bottom === next.bottom && pos.maxH === next.maxH) return false;
      pos = next;
      emit();
      return true;
    },
    close() { if (open) { open = false; pos = null; owner = null; emit(); } },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
})();

/**
 * 面板位置：**底边锚定**，只在打开时算一次。
 *
 * 为什么锚**底边**而不是顶边 —— 面板高度由内容决定（一级页 ≈216px、二级页最多 ≈446px），
 * 所以顶边锚定必须先知道高度才能定落点，只能**估算**，而估算的结果两头都是错的：
 *   · 估大了（360/460）：一级页实际才 216 → 底边悬空一两百 px，**不紧贴触发器**
 *   · 内容变高（切进二级页）：`top` 冻结不动 → 面板朝**下**长，正长错方向，越切越长
 *
 * 底边锚定把这两件事一起根治：底边永远贴在触发器顶边上方 `PANEL_GAP` 处，内容变高时朝**上**
 * 延伸、底边纹丝不动 —— 这正是 `position:fixed` + `bottom` 的原生行为，**根本不需要知道面板多高**。
 *
 * 代价：不再跟 `code.html` 的 `openMenu` 一样"落在下方"（它是顶边锚定 + 实时量高）。
 * 两害相权取"不悬空、不朝下长"，观感上也更贴近触发器。
 */
/**
 * 取一个节点**当前**的几何；拿不到、或者宿主把那一行 `hidden` 掉了（助手在跑时
 * composer 会把控件行藏起来，那时 rect 全是 0）→ 返回 `null`。
 * 用零尺寸的 rect 去定位会把面板甩到莫名其妙的地方 —— 宁可不重定位。
 */
function liveRectOf(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  try {
    const rect = node.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return rect;
  } catch (error) {
    return null;
  }
}

/** 触发器所在的那张 **composer 卡片**（面板右缘与它对齐）。认不出返回 null。 */
function composerCardOf(node) {
  let el = node;
  while (el && el.nodeType === 1) {
    if (typeof el.getAttribute === "function" && el.getAttribute("data-composer-card") !== null) return el;
    el = el.parentNode;
  }
  return null;
}

/** 一个 rect 的右缘；`right` 缺失时用 `left + width` 兜（离线桩件的 rect 可能不带 right）。 */
function rectRightOf(rect) {
  if (!rect) return null;
  if (typeof rect.right === "number" && isFinite(rect.right)) return rect.right;
  if (typeof rect.left === "number" && typeof rect.width === "number") return rect.left + rect.width;
  return null;
}

function computePanelPos(rect, composerRect) {
  const win = platform && platform.window ? platform.window : null;
  const vw = win && win.innerWidth ? win.innerWidth : 1280;
  const vh = win && win.innerHeight ? win.innerHeight : 800;
  /**
   * **右缘对齐输入框**（1.3.4 的用户要求）：面板右缘贴 composer 卡片的右缘，
   * 而不是左缘贴触发器 —— 后者会让面板相对输入框"往右伸出半截"、看着错位。
   * 三级回退：卡片右缘 → 触发器右缘 → 触发器左缘 + 面板宽；结果照旧夹进视口留白内。
   */
  const cardRight = rectRightOf(composerRect);
  const triggerRight = rectRightOf(rect);
  const anchorRight = cardRight !== null ? cardRight : triggerRight !== null ? triggerRight : rect.left + PANEL_W;
  const left = clamp(anchorRight - PANEL_W, EDGE, Math.max(EDGE, vw - PANEL_W - EDGE));
  /** 底边距视口底的距离：让面板底边正好落在触发器**顶边上方** `PANEL_GAP` 处。 */
  const bottom = Math.max(EDGE, vh - rect.top + PANEL_GAP);
  /** 极矮窗口的安全网：面板最大高度 = 底边到视口顶再减一圈留白；超出时面板内部滚动。 */
  const maxH = Math.max(200, vh - bottom - EDGE);
  return { left: left, bottom: bottom, maxH: maxH };
}

/* ══════════════ 触发器（接管 conversation.input.model 那颗官方模型席）══════════════ */

function createPickerTrigger(React) {
  function PickerTrigger(props) {
    const access = props && props.access ? props.access : null;
    /** 本实例属于哪个会话 —— 按钮与面板的"归属"判据。 */
    const sessionId = props && props.sessionId !== undefined ? props.sessionId : null;
    /**
     * `locked` 是那个槽的 **owner prop**（官方席按钮就吃它）。接管之后这条语义得跟着接过来：
     * 输入区被锁住时（`renderSlot("conversation.input.model", { locked })`），我们这颗也必须不可点。
     */
    const phase = props && typeof props.phase === "string" ? props.phase : "";
    /** 还没就绪时宿主的原话（`directoryFor` 抛的那句）—— 放进悬浮说明。 */
    const reason = props && typeof props.reason === "string" ? props.reason : "";
    const locked = props && props.locked === true;

    const [catalog, setCatalog] = React.useState(() => readCatalog(null));
    /** 只认"**我这个会话**的面板开着"。 */
    const [open, setOpen] = React.useState(() => pickerStore.isOpenFor(sessionId));
    const triggerNodeRef = React.useRef(null);

    React.useEffect(() => {
      if (access === null) return undefined;
      const sync = () => {
        let snapshot = null;
        try { snapshot = access.getSnapshot(); } catch (e) { snapshot = null; }
        setCatalog(readCatalog(snapshot));
      };
      sync();
      let off = null;
      try { off = access.subscribe(sync); } catch (e) { off = null; }
      return () => { if (typeof off === "function") { try { off(); } catch (e) { /* 忽略 */ } } };
    }, [access]);

    React.useEffect(
      () => pickerStore.subscribe(() => setOpen(pickerStore.isOpenFor(sessionId))),
      [sessionId],
    );

    const triggerRef = React.useCallback((node) => {
      triggerNodeRef.current = node;
      pickerStore.setTrigger(node);
    }, []);

    const model = catalog.model;
    const shownLevel = catalog.level;
    const shownPct = pctFromIndex(Math.max(0, catalog.levelIndex), Math.max(1, model ? model.levels.length : 0));
    /**
     * 目录还没到的时候如实说"正在加载"（官方那颗席按钮的文案就是 `trigger.loading` = 正在加载模型…）。
     * 以前这里一律写"模型"，于是"还在加载"和"目录空/失败"在界面上长得一模一样 —— 真机排查时
     * 用户只能看到"用不了了"（1.3.3 就是这么发现那次事故的）。
     *
     * 1.3.5 起再分一层：**"我们还没拿到目录"（unresolved）** 与 **"宿主就是没列 provider"（empty）**
     * 必须能分开 —— 前者是我们的问题、后者是宿主的问题，而它们的界面在旧版里一模一样。
     * 短语只放在悬浮说明里（按钮只有一行宽，塞不下诊断信息）。
     */
    const loading = model === null && (catalog.status === "loading" || phase === "loading");
    const hint = model !== null ? ""
      : phase === "no-session" ? "（还没有会话）"
        : phase === "unresolved" ? (reason !== "" ? "（" + (reason.length > 60 ? reason.slice(0, 60) + "…" : reason) + "）" : "（会话目录未就绪，正在重试）")
          : phase === "empty" ? "（宿主没有列出任何 provider）" : "";
    const title = (model
      ? model.name + " · " + (shownLevel ? shownLevel.name : "无可用档位")
      : loading ? "正在加载模型…" : "模型与推理等级") + hint + (locked ? "（当前不可切换）" : "");

    return React.createElement("button", {
      ref: triggerRef,
      type: "button",
      className: "cxp cxp-trigger",
      "data-ces-part": "picker-trigger",
      "data-locked": locked ? "1" : "0",
      disabled: locked,
      "aria-haspopup": "menu",
      "aria-expanded": open ? "true" : "false",
      "aria-disabled": locked ? "true" : undefined,
      "aria-label": "模型与推理等级",
      title: title,
      onClick: () => {
        if (locked) return;
        // 只有**自己的**面板开着才收起；否则一律打开自己的（会把 owner 抢过来，A 的面板随之收起）。
        // 旧写法是 `if (isOpen()) close()` —— 那会让"点 B 的按钮"变成"只是把 A 的面板关掉"。
        if (pickerStore.isOpenFor(sessionId)) { pickerStore.close(); return; }
        const node = triggerNodeRef.current;
        if (!node || typeof node.getBoundingClientRect !== "function") return;
        // **带上自己的 sessionId**：面板归属由此确定（少了它 owner 会是 undefined，
        // 于是谁都不匹配、面板根本不出现）。
        // 第三个参数是 composer 卡片：面板**右缘与输入框右缘对齐**（1.3.4 的用户要求）。
        pickerStore.openAt(node.getBoundingClientRect(), sessionId, liveRectOf(composerCardOf(node)));
      },
    },
      /*
       * 紧凑态：官方的席按钮在"一行放不下"时会被行上的两个 CSS 变量切成纯图标
       * （`--dsh-composer-model-text-display: none` + `--dsh-composer-model-icon-display: block`，
       * 见 `conversation.input.model` 的槽位说明）。接管那颗按钮就得跟着这套约定走，
       * 否则窄输入行里我们这颗会硬撑着显示文字、把提交键挤出去。
       * 两个变量都由 `.cxp-trigger__*` 的 CSS 读，这里只负责把图标节点放进去。
       */
      icon(React, ICON_MODEL, { className: "cxp-trigger__icon", size: 12, "data-ces-part": "picker-trigger-icon" }),
      React.createElement("span", { className: "cxp-trigger__name" }, model ? model.name : loading ? "正在加载模型…" : "模型"),
      shownLevel
        ? React.createElement("span", {
          className: "cxp-trigger__effort",
          style: { color: valueColorFor(shownPct, shownLevel) || undefined },
        }, shownLevel.name)
        : null,
      icon(React, ICON_CHEV_DOWN, { className: "cxp-chev", size: 10, "data-open": open ? "1" : "0" }),
    );
  }
  return PickerTrigger;
}

/* ════════════════════════════ 面板（surface，portal 到 body）════════════════════════════ */

function createPickerSurface(React, ReactDOM) {
  function PickerSurface(props) {
    const access = props && props.access ? props.access : null;
    const write = props && typeof props.write === "function" ? props.write : null;
    const doc = platform && platform.document ? platform.document : null;
    const win = platform && platform.window ? platform.window : null;
    /** 本实例属于哪个会话 —— 面板只显示**自己会话**的那一份。 */
    const sessionId = props && props.sessionId !== undefined ? props.sessionId : null;
    /** 目录"走到哪一步"（访问器给，见 client.js 的 `phaseOf`）—— 决定空态那句话怎么说。 */
    const phase = props && typeof props.phase === "string" ? props.phase : "";
    /** 还没就绪时宿主的原话（`directoryFor` 抛的那句），直接摆给用户看 —— 排查全靠它。 */
    const reason = props && typeof props.reason === "string" ? props.reason : "";

    const [catalog, setCatalog] = React.useState(() => readCatalog(null));
    /** 只认"**我这个会话**的面板开着"。 */
    const [open, setOpen] = React.useState(() => pickerStore.isOpenFor(sessionId));
    /**
     * 面板位置**放 state**，不放"渲染时现读"。
     *
     * 1.3.4 踩的坑：位置以前是渲染时 `pickerStore.position()` 现读的，而重定位只改 store、
     * 不改任何 state —— 订阅回调里 `setOpen(sameBoolean)` 被 React **bail out**，
     * 于是**一次渲染都不会发生**，面板看起来"纹丝不动"（滚动跟着走的期望落空）。
     * 现在把位置也订阅进 state：`reposition()` 换的是**新对象** → 引用变了 → 老老实实重渲；
     * 位置没变时 store 原样返回旧对象 → `setPos` bail out → 也不会有多余渲染。
     */
    const [pos, setPos] = React.useState(() => pickerStore.position());
    const [view, setViewRaw] = React.useState(1);
    const [subProvider, setSubProvider] = React.useState(null);
    const [query, setQuery] = React.useState("");
    const [draftIndex, setDraftIndex] = React.useState(-1);
    const [popOpen, setPopOpen] = React.useState(false);
    const [slideSlow, setSlideSlow] = React.useState(false);
    const [popPos, setPopPos] = React.useState(null);
    const [sliderWidth, setSliderWidth] = React.useState(0);

    const rootRef = React.useRef(null);
    const viewportRef = React.useRef(null);
    const sliderRef = React.useRef(null);
    const moreRef = React.useRef(null);
    const searchRef = React.useRef(null);
    const dragRef = React.useRef({ active: false, index: 0, lastStep: 0, armed: undefined, u0: 0 });
    const commitRef = React.useRef({ timer: null, queued: null, optimisticId: null });
    const scrollRef = React.useRef(0);
    const viewRef = React.useRef(1);

    /**
     * 开合状态来自模块级 store（trigger 在另一棵树里点开的），**但只认自己会话那一份**。
     *
     * 「A 开着面板切到 B」的语义：面板随 A 消失、B 不显示；**切回 A 时面板还在**。
     * 这是有意选择（不是"卸载即 close"）：`open` 的归属是 store 里的 owner，
     * 组件卸载/重挂不改变它，于是会话来回切换时面板状态跟着会话走、不丢。
     */
    React.useEffect(
      () => pickerStore.subscribe(() => {
        setOpen(pickerStore.isOpenFor(sessionId));
        // 位置一起订阅（见 `pos` state 的注释）：重定位换的是**新对象** → 引用变了 → 重渲；
        // 位置没变时 store 原样返回旧对象 → `setPos` 被 bail out，不会有多余渲染。
        setPos(pickerStore.position());
      }),
      [sessionId],
    );

    /** 订阅目录：档位、provider、当前选择都从这一份快照来 */
    React.useEffect(() => {
      if (access === null) return undefined;
      const sync = () => {
        let snapshot = null;
        try { snapshot = access.getSnapshot(); } catch (e) { snapshot = null; }
        setCatalog(readCatalog(snapshot));
      };
      sync();
      let off = null;
      try { off = access.subscribe(sync); } catch (e) { off = null; }
      return () => { if (typeof off === "function") { try { off(); } catch (e) { /* 忽略 */ } } };
    }, [access]);

    /**
     * 面板一打开就**复查一次目录实例**。
     *
     * 宿主会重建该会话的 `ModelDirectory`（父子会话换 binding、作用域重建等），而**旧实例
     * 已经 dispose、再也不会推送** —— 只靠 store 订阅客户端永远不知道要换，界面就静默冻在
     * 旧档位表上。打开面板是用户真正要看数据的时刻，也是唯一确定的"该读新实例了"的信号
     * （`access` 侧另有低频心跳兜底，见 `createDirectoryAccess` 的 `scheduleHeartbeat`）。
     */
    React.useEffect(() => {
      if (!open || access === null || typeof access.refresh !== "function") return;
      try { access.refresh(); } catch (error) { /* 复查失败不影响渲染 */ }
    }, [open, access]);

    /* 视口高度（page 是 absolute，必须自己撑） */
    const viewportHeight = React.useMemo(
      () => viewportHeightFor(catalog, view, query, subProvider),
      [catalog, view, query, subProvider],
    );
    React.useEffect(() => {
      const node = viewportRef.current;
      if (!node || !node.style) return;
      node.style.height = viewportHeight + "px";
    }, [viewportHeight]);

    /* 进二级页 → 焦点给搜索框（preventScroll：否则浏览器滚一下、翻页动画被吃掉） */
    React.useEffect(() => {
      if (!open || view !== 2) return;
      const search = searchRef.current;
      if (search && typeof search.focus === "function") search.focus({ preventScroll: true });
    }, [open, view, subProvider]);

    /* 换内容那一帧稳住滚动位置：只恢复用户自己的位置，不粗暴归零 */
    React.useEffect(() => {
      if (!open) return;
      const node = rootRef.current;
      const list = node && typeof node.querySelector === "function" ? node.querySelector(".cxp-list") : null;
      if (!list) return;
      if (viewRef.current !== view) {
        viewRef.current = view;
        scrollRef.current = 0;
        list.scrollTop = 0;
        return;
      }
      if (typeof list.scrollTop === "number" && list.scrollTop < scrollRef.current) list.scrollTop = scrollRef.current;
    }, [open, view, query, subProvider, catalog]);

    /* Esc / 外点：从里到外退避（档位弹层 → 二级页 → 面板）。滚动 → 关闭，不重定位。 */
    React.useEffect(() => {
      if (!open || !doc) return undefined;
      const onKeyDown = (event) => {
        if (!event || event.key !== "Escape") return;
        if (popOpen) {
          setPopOpen(false);
          if (event.stopPropagation) event.stopPropagation();
          return;
        }
        if (viewRef.current === 2) {
          setViewRaw(1);
          setSubProvider(null);
          setQuery("");
          if (event.stopPropagation) event.stopPropagation();
          return;
        }
        pickerStore.close();
      };
      const onPointerDown = (event) => {
        const node = rootRef.current;
        const target = event ? event.target : null;
        const triggerEl = pickerStore.trigger();
        if (node && target && typeof node.contains === "function" && node.contains(target)) return;
        if (triggerEl && target && typeof triggerEl.contains === "function" && triggerEl.contains(target)) return;
        setPopOpen(false);
        pickerStore.close();
      };
      /**
       * 滚动 / 视口尺寸变化 → **重定位，不关面板**（1.3.4）。
       *
       * 真机反馈：助手流式输出时聊天区一直在自动滚动，而 scroll 在 capture 阶段同样会到达
       * document —— 旧策略"页面在滚就关闭"于是把面板关掉了（"对话还没结束，对话一刷新，
       * 面板就没了"）。滚动本身不该让面板消失，它只是需要跟着锚点走一步。
       *
       * **仍然必须排除面板内部的滚动源**（模型列表 `.cxp-list`、二级页）：那是"滚列表"，
       * 不是"滚页面"，更不该引起重定位。
       */
      const onScroll = (event) => {
        const node = rootRef.current;
        const target = event ? event.target : null;
        if (node && target && typeof node.contains === "function" && node.contains(target)) return;
        try { pickerStore.reposition(); } catch (error) { /* 重定位失败不影响面板 */ }
      };
      /** 视口尺寸变了 → 与滚动同一条策略：重定位（面板留着）。 */
      const onResize = () => {
        try { pickerStore.reposition(); } catch (error) { /* 忽略 */ }
      };
      doc.addEventListener("keydown", onKeyDown, true);
      doc.addEventListener("pointerdown", onPointerDown, true);
      doc.addEventListener("scroll", onScroll, true);
      if (win && typeof win.addEventListener === "function") win.addEventListener("resize", onResize);
      return () => {
        doc.removeEventListener("keydown", onKeyDown, true);
        doc.removeEventListener("pointerdown", onPointerDown, true);
        doc.removeEventListener("scroll", onScroll, true);
        if (win && typeof win.removeEventListener === "function") win.removeEventListener("resize", onResize);
      };
    }, [open, popOpen]);

    /* 卸载：清掉去抖定时器（否则会在卸载后写一次宿主） */
    React.useEffect(() => () => {
      const pending = commitRef.current;
      if (pending.timer !== null && typeof clearTimeout === "function") clearTimeout(pending.timer);
      pending.timer = null;
      pending.queued = null;
    }, []);

    /* 滑条宽度：星尘靠它算横穿距离 */
    React.useEffect(() => {
      if (!open) return;
      const node = sliderRef.current;
      if (!node) return;
      const width = node.clientWidth || node.offsetWidth || 0;
      setSliderWidth(width);
    }, [open, catalog, view]);

    /* 宿主追上乐观值 → 撤掉草稿下标 */
    const snapshotLevelId = catalog.level ? catalog.level.id : null;
    React.useEffect(() => {
      const pending = commitRef.current;
      if (pending.optimisticId !== null && snapshotLevelId === pending.optimisticId) {
        pending.optimisticId = null;
        setDraftIndex(-1);
      }
    }, [snapshotLevelId]);

    /* 换了模型（或目录换了代）→ 清掉草稿与去抖队列 */
    const modelKey = String(catalog.providerId) + "/" + String(catalog.modelId) + "@" + String(catalog.levelIndex);
    React.useEffect(() => {
      const pending = commitRef.current;
      if (pending.timer !== null && typeof clearTimeout === "function") clearTimeout(pending.timer);
      pending.timer = null;
      pending.queued = null;
      pending.optimisticId = null;
      setDraftIndex(-1);
    }, [modelKey]);

    /* ── 派生量 ───────────────────────────────────────────────────────── */
    const model = catalog.model;
    const levels = model ? model.levels : [];
    const levelCount = levels.length;
    const disabled = levelCount === 0;
    const baseIndex = catalog.levelIndex >= 0 ? catalog.levelIndex : 0;
    const shownIndex = draftIndex >= 0 && draftIndex < levelCount ? draftIndex : baseIndex;
    const shownPct = pctFromIndex(shownIndex, Math.max(1, levelCount));
    const shownLevel = levels[shownIndex] || null;
    const energy = energyFor(shownPct);
    const off = isOffLevel(shownLevel);
    const solo = !off && levelCount > 0 && shownIndex === levelCount - 1;

    /* ── 写回：停顿去抖 + 同档去重（与官方菜单那条控件同款）────────────── */
    function flush() {
      const pending = commitRef.current;
      const levelId = pending.queued;
      pending.queued = null;
      if (levelId === null || levelId === undefined) return;
      if (!catalog.providerId || !catalog.modelId || write === null) return;
      if (snapshotLevelId === levelId) return;
      pending.optimisticId = levelId;
      write(catalog.providerId, catalog.modelId, levelId);
    }

    function scheduleWrite(levelId, immediate) {
      const pending = commitRef.current;
      if (pending.timer !== null && typeof clearTimeout === "function") clearTimeout(pending.timer);
      pending.timer = null;
      pending.queued = levelId;
      if (immediate === true || typeof setTimeout !== "function") { flush(); return; }
      pending.timer = setTimeout(() => { pending.timer = null; flush(); }, COMMIT_SETTLE_MS);
    }

    function setLevel(nextIndex, immediate) {
      if (levelCount === 0) return;
      const next = clamp(nextIndex, 0, levelCount - 1);
      setDraftIndex(next);
      const level = levels[next];
      if (level) scheduleWrite(level.id, immediate === true);
    }

    /* ── 指针数学（1/3 判定线 + 按下取最近档 + 快慢两档）────────────────── */
    function unitAt(clientX) {
      const node = sliderRef.current;
      if (!node || typeof node.getBoundingClientRect !== "function") return null;
      const rect = node.getBoundingClientRect();
      const usable = rect.width - TR * 2;
      if (!(usable > 0)) return null;
      const pct = clamp((clientX - rect.left - TR) / usable, 0, 1);
      return pct * (levelCount - 1);
    }

    function noteStep() {
      const drag = dragRef.current;
      const now = Date.now();
      const gap = drag.lastStep === 0 ? SLOW_ENTER_MS + 1 : now - drag.lastStep;
      drag.lastStep = now;
      const next = slideSlow ? gap >= SLOW_EXIT_MS : gap > SLOW_ENTER_MS;
      if (next !== slideSlow) setSlideSlow(next);
    }

    function onPointerDown(event) {
      if (disabled) return;
      if (event && event.preventDefault) event.preventDefault();
      const drag = dragRef.current;
      drag.active = true;
      drag.lastStep = 0;
      try {
        if (event && event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      } catch (error) { /* 合成事件没有真指针 */ }
      const u = unitAt(event ? event.clientX : 0);
      if (u === null) return;
      const nearest = clamp(Math.round(u), 0, levelCount - 1);
      drag.index = nearest;
      /** 记下**按下点**：死区解锁要靠"离按下点够远"，见 `onPointerMove`。 */
      drag.u0 = u;
      drag.armed = clamp(Math.floor(u - THIRD) + 1, 0, levelCount - 1) === nearest;
      drag.lastStep = Date.now();
      setLevel(nearest, false);
    }

    function onPointerMove(event) {
      const drag = dragRef.current;
      if (!drag.active) return;
      const u = unitAt(event ? event.clientX : 0);
      if (u === null) return;
      if (drag.armed !== true) {
        const judged = clamp(Math.floor(u - THIRD) + 1, 0, levelCount - 1);
        /**
         * 死区解锁：**判据是"离按下点够远"，不是"回到了按下那一格"**。
         *
         * 只判 `judged === drag.index` 是错的：按下点落在"冲突带"
         * （`u ∈ (n+1/3, n+1/2)`，占整条轨道约 1/6）时 `round(u)=n` 而 `judged=n+1`，
         * 于是 `armed=false`；而 `judged` 随 `u` **单调递增**，向右拖永远回不到 `n` ——
         * 整段右拖失效，松手还把旧档位写回宿主（真机复现：按 u=0.40 → 右拖到 u=2.40 仍停在 Off）。
         *
         * 位移判据取自 1.2.0 那半边（`client.js` 的 `onPointerMove`：
         * `mapped === press.index || Math.abs(u - press.u) >= DETENT_THIRD`）。
         */
        if (judged !== drag.index && Math.abs(u - drag.u0) < THIRD) return;
        drag.armed = true;
      }
      let next = drag.index;
      while (next < levelCount - 1 && u >= next + THIRD) next += 1;
      while (next > 0 && u <= next - (1 - THIRD)) next -= 1;
      if (next === drag.index) return;
      drag.index = next;
      noteStep();
      setLevel(next, false);
    }

    function endDrag() {
      const drag = dragRef.current;
      if (!drag.active) return;
      drag.active = false;
      drag.armed = undefined;
      const pending = commitRef.current;
      if (pending.queued !== null) scheduleWrite(pending.queued, true);
    }

    /* ── 翻页与交互 ─────────────────────────────────────────────────────── */
    function enterProvider(providerId) {
      if (view === 2 && subProvider === providerId) { goBack(); return; }
      setSubProvider(providerId);
      setQuery("");
      setViewRaw(2);
      const search = searchRef.current;
      if (search && typeof search.focus === "function") search.focus({ preventScroll: true });
    }

    function goBack() {
      setViewRaw(1);
      setSubProvider(null);
      setQuery("");
    }

    /**
     * 点模型：**不关面板、不收起二级**（滑条立刻跟到新模型）。
     *
     * 选模型与配档位是**解耦**的：无档位模型同样可以选中，只是那次写入不带 `reasoningEffort`。
     * 契约来自官方产物（`dsh-client-ui-model-selection/lib/client.js` 的 `select()`）：
     * 无档位时是**条件构造** payload，`reasoningEffort` **键整个不出现**（不是传 null）——
     * 缺席 = "对档位没有意见"，显式 null = "显式清除"，宿主侧是两回事。
     */
    function pickModel(providerId, entry) {
      if (!entry || write === null) return;
      const pending = commitRef.current;
      /**
       * 换模型前先清掉**这个模型的待落地档位写入**，否则它的去抖窗口会在切换**之后**才落地，
       * 把刚换上的新模型写回旧档位。
       *
       * 三个字段都要清，`optimisticId` 尤其不能漏：乐观值的机制是"写了某档位、等宿主追上后
       * 撤草稿"，而切到无档位模型后 `catalog.level` 变 null、`snapshotLevelId` 也跟着变 null，
       * 旧乐观值**永远等不到被追上**那一刻 —— 不清就是一次悬挂状态。
       * （`modelKey` effect 覆盖了大多数时序，但这里必须自己清干净。）
       */
      if (pending.timer !== null && typeof clearTimeout === "function") clearTimeout(pending.timer);
      pending.timer = null;
      pending.queued = null;
      pending.optimisticId = null;

      if (entry.levels.length === 0) {
        // 无档位模型：只切模型。`null` 一路传到 createPickerWrite，那里会构造只含
        // provider/model 的 payload（键不出现）。
        write(providerId, entry.id, null);
        return;
      }
      /**
       * 换模型时写哪一档 = **正中**（偶数档取中间的下一个，例如 4 档写第三档）。
       *
       * 以前这里写的是"最后一档（Max）"，用户明确要求改成中间；`entry.def`（宿主声明的
       * `reasoningEffort` 默认值）**不再参与** —— 与用户规则冲突时以用户规则为准。
       * 规则本身在 `defaultLevelIndex` 里，与滑条默认停靠位置共用同一条，不会两处跑偏。
       */
      const levelId = entry.levels[defaultLevelIndex(entry.levels)].id;
      pending.optimisticId = levelId;
      write(providerId, entry.id, levelId);
    }

    function chooseLevel(levelId) {
      setPopOpen(false);
      if (levelCount === 0) return;
      for (let i = 0; i < levelCount; i += 1) {
        if (levels[i].id === levelId) { noteStep(); setLevel(i, true); return; }
      }
    }

    function togglePop() {
      if (disabled) return;
      const next = !popOpen;
      setPopOpen(next);
      if (!next) return;
      const rect = moreRef.current && typeof moreRef.current.getBoundingClientRect === "function"
        ? moreRef.current.getBoundingClientRect()
        : null;
      if (rect === null) return;
      const width = 150;
      const vw = win && win.innerWidth ? win.innerWidth : 1280;
      const vh = win && win.innerHeight ? win.innerHeight : 800;
      const height = levelCount * 34 + 10;
      setPopPos({
        left: clamp(rect.right - width, EDGE, Math.max(EDGE, vw - width - EDGE)),
        top: rect.bottom + 6 + height > vh - EDGE ? Math.max(EDGE, rect.top - height - 6) : rect.bottom + 6,
      });
    }

    /* ── 渲染 ─────────────────────────────────────────────────────────── */
    // 位置来自 state（见 `pos` 的注释）：重定位要能触发重渲，否则面板"纹丝不动"

    const providerNodes = catalog.providers.map((provider) => React.createElement("button", {
      key: "p-" + provider.id,
      type: "button",
      className: "cxp-row",
      "data-ces-part": "picker-provider",
      "data-pid": provider.id,
      "aria-expanded": view === 2 && subProvider === provider.id ? "true" : "false",
      onClick: () => enterProvider(provider.id),
    },
      React.createElement("span", null, provider.name),
      React.createElement("span", { className: "cxp-row__cur" },
        provider.id === catalog.providerId ? currentModelName(catalog.providers, catalog.providerId, catalog.modelId) : ""),
      icon(React, ICON_CHEV_RIGHT, { className: "cxp-chev", size: 11 }),
    ));

    /**
     * 一级页的"提示块"（1.3.3 补）：**接管官方那颗席按钮之后，官方菜单里那份失败提示也归我们了**。
     *
     * 官方 ModelSelect 的菜单会把 `failures` 逐条列出来（"{name} 加载失败：{message}"），
     * 我们以前只画 provider 行、把这些丢掉了 —— 于是"某个 provider 挂了"在自建面板里
     * 表现为**一片空白**（再加上当时高度算少了、提示句被裁掉，连"没有可用的 provider"都看不见）。
     * 现在：有 provider 就列 provider，失败原因追加在下面；一个 provider 都没有就只剩提示块。
     */
    const noticeNodes = [];
    if (catalog.failures.length > 0) {
      for (let i = 0; i < catalog.failures.length && i < FAILURE_MAX_ROWS; i += 1) {
        const failure = catalog.failures[i];
        noticeNodes.push(React.createElement("div", {
          key: "f-" + i,
          className: "cxp-failure",
          "data-ces-part": "picker-failure",
          title: failure.message,
        }, failure.name + " 加载失败：" + failure.message));
      }
    } else if (catalog.providers.length === 0) {
      /**
       * 空态要**说清楚是谁的问题**（1.3.5）：
       *   · `unresolved` —— 我们这边还没解析出目录（`directoryFor` 抛 / 会话作用域没就绪），会自动重试；
       *   · `empty` —— 宿主明确就绪、却一个 provider 都没列出来。这不是渲染问题：
       *     宿主 `buildModelCatalog()` 只列**当前注册的 provider**，而像 `llm-deepseek-account`
       *     那种账号 provider 在拿不到令牌时会**静默返回空模型列表**（`discoverModels` 里
       *     `ACCOUNT_SIGN_IN_REQUIRED → return []`），于是目录"就绪但空"、连 failures 都是空的。
       *     这时官方菜单同样是空的 —— 该去查 DSH 的模型/账号设置，而不是查这个插件。
       */
      const emptyText = catalog.status === "loading" || phase === "loading" ? "正在读取模型目录…"
        : phase === "no-session" ? "还没有会话 —— 发一条消息后就能选模型"
          : phase === "unresolved" ? "会话目录未就绪，正在重试…"
            : phase === "empty" ? "宿主没有列出任何 provider" : "没有可用的 provider";
      const emptyHint = phase === "empty" ? "检查 DSH 的模型 / 账号设置（官方菜单此时也是空的）" : undefined;
      noticeNodes.push(React.createElement("div", {
        key: "empty",
        className: "cxp-empty",
        "data-ces-part": "picker-empty",
        "data-phase": phase === "" ? "unknown" : phase,
        title: emptyHint,
      }, emptyText));
      /*
       * 还没就绪时**把宿主的原话摆出来**（1.3.6）。
       *
       * 上一轮排查卡住的正是这里：面板只说"未就绪"，而真实原因是 `directoryFor()` 抛的
       * `resolved no scope / no binding`（甚至能看出是哪个 id）—— 那句话一直被我们静默吞掉，
       * 只能靠猜。现在它直接出现在面板上（并同步进控制台）。
       */
      if (phase === "unresolved" && reason !== "") {
        noticeNodes.push(React.createElement("div", {
          key: "reason",
          className: "cxp-failure",
          "data-ces-part": "picker-reason",
          title: reason,
        }, reason.length > 96 ? reason.slice(0, 96) + "…" : reason));
      }
    }

    const modelNodes = [];
    let matched = 0;
    if (subProvider !== null) {
      const needle = query.trim().toLowerCase();
      for (let i = 0; i < catalog.providers.length; i += 1) {
        if (catalog.providers[i].id !== subProvider) continue;
        const list = catalog.providers[i].models;
        for (let j = 0; j < list.length; j += 1) {
          const entry = list[j];
          if (needle.length > 0 && entry.name.toLowerCase().indexOf(needle) < 0) continue;
          matched += 1;
          const supported = entry.levels.length > 0;
          modelNodes.push(React.createElement("button", {
            key: "m-" + entry.id,
            type: "button",
            className: "cxp-model",
            "data-ces-part": "picker-model",
            "data-na": supported ? "0" : "1",
            "data-sel": catalog.providerId === subProvider && catalog.modelId === entry.id ? "1" : "0",
            title: supported
              ? entry.levels.length + " 档：" + entry.levels.map((level) => level.name).join(" / ")
              : "该模型不支持推理等级",
            onClick: () => pickModel(subProvider, entry),
          },
            React.createElement("span", { className: "cxp-model__name" },
              React.createElement("span", null, entry.name),
              React.createElement("span", { className: "cxp-cnt" }, supported ? entry.levels.length + " 档" : "不支持"),
            ),
            icon(React, ICON_CHECK, { className: "cxp-ck", size: 15, viewBox: "0 0 16 16", width: 1.6 }),
          ));
        }
        break;
      }
      if (matched === 0) modelNodes.push(React.createElement("div", { key: "empty", className: "cxp-empty" }, "无匹配模型"));
    }

    const knobLeft = leftFor(shownPct);
    const starCount = starCountFor(shownPct);
    const speedFactor = speedFor(shownPct);
    const measured = sliderWidth > 0 ? sliderWidth : FALLBACK_SLIDER_W;
    const travel = Math.round(TR + shownPct * Math.max(0, measured - TR * 2) + 16);

    const tickNodes = [];
    for (let i = 0; i < levelCount; i += 1) {
      tickNodes.push(React.createElement("span", {
        key: "t-" + levels[i].id,
        className: "cxp-tick",
        "data-ces-part": "picker-tick",
        "data-cur": i === shownIndex ? "1" : "0",
        "data-hit": !off && i <= shownIndex ? "1" : "0",
        style: { left: leftFor(pctFromIndex(i, levelCount)) },
      }));
    }

    const starNodes = [];
    for (let i = 0; i < STAR_N; i += 1) {
      const duration = starDurationFor(i, speedFactor);
      starNodes.push(React.createElement("span", {
        key: "s-" + i,
        className: "cxp-star",
        "data-ces-part": "picker-star",
        "data-on": i < starCount ? "1" : "0",
        style: {
          top: starTopFor(i) + "%",
          width: starSizeFor(i) + "px",
          height: starSizeFor(i) + "px",
          "--cxp-o": String(starBrightnessFor(i)),
          "--cxp-d": duration.toFixed(3) + "s",
          "--cxp-travel": travel + "px",
          animationDelay: starDelayFor(i, duration).toFixed(3) + "s",
        },
      }));
    }

    const cardBorder = !shownLevel || off
      ? "var(--cxp-line)"
      : "rgba(139,92,246," + (0.18 + 0.34 * energy).toFixed(2) + ")";

    const effortCard = React.createElement("div", {
      className: "cxp-card",
      "data-ces-part": "picker-card",
      style: { borderColor: cardBorder },
    },
      React.createElement("div", { className: "cxp-card__head" },
        React.createElement("span", { className: "cxp-card__title" }, "推理等级"),
        React.createElement("button", {
          ref: moreRef,
          type: "button",
          className: "cxp-more",
          "data-ces-part": "picker-more",
          disabled: disabled,
          "aria-haspopup": "menu",
          "aria-expanded": popOpen ? "true" : "false",
          title: disabled ? "当前模型没有可用档位" : "展开档位列表（显示原始 API 取值）",
          onClick: togglePop,
        },
          React.createElement("span", {
            "data-ces-part": "picker-effort-value",
            style: shownLevel ? { color: valueColorFor(shownPct, shownLevel) || undefined } : undefined,
          }, shownLevel ? shownLevel.name : "—"),
          icon(React, ICON_CHEV_DOWN, { className: "cxp-chev", size: 10 }),
        ),
      ),
      React.createElement("div", {
        ref: sliderRef,
        className: "cxp-slider",
        "data-ces-part": "picker-slider",
        role: "slider",
        "aria-label": "推理等级",
        "aria-valuemin": 0,
        "aria-valuemax": Math.max(0, levelCount - 1),
        "aria-valuenow": shownIndex,
        "aria-valuetext": shownLevel ? shownLevel.name : "",
        "aria-disabled": disabled ? "true" : undefined,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); },
      },
        React.createElement("div", { className: "cxp-track", "data-ces-part": "picker-track" }),
        React.createElement("div", {
          className: "cxp-fill",
          "data-ces-part": "picker-fill",
          style: { width: knobLeft, background: fillBackgroundFor(shownPct) },
        },
          React.createElement("div", {
            className: "cxp-nebula",
            "data-ces-part": "picker-nebula",
            style: { "--energy": String(energy) },
          }),
        ),
        React.createElement("div", {
          className: "cxp-stars",
          "data-ces-part": "picker-stars",
          /**
           * 星空层必须**自己撑出宽度**。
           *
           * CSS 是 `position:absolute; inset:0 auto 0 0; overflow:hidden`（`right:auto`），
           * 而子节点全是 `position:absolute; left:100%` → shrink-to-fit 宽度 = **0**，
           * `overflow:hidden` 于是把 22 颗星**全部裁掉**（真机复现：`style = {}`，一颗都看不见）。
           * 宽度跟填充层一致，星尘才是"从当前档位点向右横穿"（1.2.0 那半边就是这么写的：
           * `style: { width: knobOffset }`）。
           */
          style: { width: knobLeft },
        }, starNodes),
        React.createElement("div", { className: "cxp-ticks", "data-ces-part": "picker-ticks" }, tickNodes),
        React.createElement("div", { className: "cxp-knob", "data-ces-part": "picker-knob", style: { left: knobLeft } }),
      ),
    );

    const viewport = React.createElement("div", {
      ref: viewportRef,
      className: "cxp-viewport",
      "data-ces-part": "picker-viewport",
      "data-view": String(view),
      style: { height: viewportHeight + "px" },
    },
      React.createElement("div", { className: "cxp-page", "data-slot": "1", "data-ces-part": "picker-page" },
        React.createElement("div", { className: "cxp-sec" }, "模型"),
        // 有 provider 就列 provider，失败原因（若有）追加在下面；一个都没有时只剩提示块
        providerNodes.concat(noticeNodes),
      ),
      React.createElement("div", {
        className: "cxp-page",
        "data-slot": "2",
        "data-ces-part": "picker-page",
        "aria-hidden": view === 2 ? "false" : "true",
      },
        React.createElement("div", { className: "cxp-head" },
          React.createElement("button", {
            type: "button",
            className: "cxp-back",
            "data-ces-part": "picker-back",
            "aria-label": "返回",
            onClick: goBack,
          }, icon(React, ICON_BACK, { size: 12 })),
          React.createElement("span", { className: "cxp-title" }, providerTitle(catalog, subProvider)),
        ),
        React.createElement("label", { className: "cxp-search" },
          icon(React, ICON_SEARCH, { size: 13 }),
          React.createElement("input", {
            ref: searchRef,
            type: "text",
            placeholder: "搜索模型…",
            value: query,
            "data-ces-part": "picker-search",
            onChange: (event) => setQuery(event && event.target && typeof event.target.value === "string" ? event.target.value : ""),
          }),
        ),
        React.createElement("div", {
          className: "cxp-list",
          "data-ces-part": "picker-list",
          onScroll: (event) => {
            const node = event && event.currentTarget ? event.currentTarget : null;
            if (node && typeof node.scrollTop === "number") scrollRef.current = node.scrollTop;
          },
        }, modelNodes),
      ),
    );

    const popup = popOpen && popPos !== null
      ? React.createElement("div", {
        className: "cxp-pop",
        "data-ces-part": "picker-pop",
        role: "menu",
        style: { left: popPos.left + "px", top: popPos.top + "px" },
      }, levels.map((level) => React.createElement("button", {
        key: "l-" + level.id,
        type: "button",
        className: "cxp-pop__row",
        "data-ces-part": "picker-pop-row",
        role: "menuitemradio",
        "aria-checked": level.id === snapshotLevelId ? "true" : "false",
        title: "API: " + level.id,
        onClick: () => chooseLevel(level.id),
      },
        React.createElement("span", null, level.name),
        React.createElement("span", { className: "cxp-pop__api", "data-ces-part": "picker-api", title: "API: " + level.id }, level.id),
        level.id === snapshotLevelId
          ? icon(React, ICON_CHECK, { className: "cxp-pop__ck", size: 14, viewBox: "0 0 16 16", width: 1.6 })
          : null,
      )))
      : null;

    /*
     * 渲染门槛：面板只属于**打开它的那个会话**。
     * 这里再查一次 `owner`（而不是只信 `open` state）是防御性的：`open` 是订阅来的快照，
     * 而 owner 可能在两次渲染之间被别的会话抢走 —— 少查这一次就会出现"B 的面板显示 A 的内容"。
     */
    if (!open || !pickerStore.isOpenFor(sessionId) || pos === null) return null;

    /*
     * 矮窗口的安全网从 `.cxp-root` **挪到 `.cxp-panel`**（1.3.10，用户实测："阴影好像被一个框限制了"）。
     *
     * 原因：`.cxp-root` 是 `position:fixed` 的定位壳，为了"顶到视口上沿就内部滚动"它带
     * `overflow:auto` —— 而 `overflow` 会**裁掉后代的 box-shadow**。阴影画在 `.cxp-panel` 上，
     * 于是被裁成矩形（圆角面板外面套一圈**方角**光晕，正是截图里那个"框"）。
     * 元素**自己**的 box-shadow 不受自身 `overflow` 影响，所以把滚动与阴影放在同一层就没事：
     * 壳层 `overflow:visible` + 面板 `overflow:auto`，并把同一个 `pos.maxH` 也写给面板
     * （行内 px，不依赖父级高度是否确定）。
     */
    const panelStyle = { maxHeight: pos.maxH + "px" };
    const surface = React.createElement("div", {
      ref: rootRef,
      className: "cxp cxp-root",
      "data-ces-part": "picker-panel-root",
      "data-ces-picker": "1",
      "data-disabled": disabled ? "1" : "0",
      "data-off": off ? "1" : "0",
      "data-solo": solo ? "1" : "0",
      "data-motion": props && props.reducedMotion === true ? "reduced" : "full",
      "data-slide": slideSlow ? "slow" : "fast",
      style: {
        left: pos.left + "px",
        bottom: pos.bottom + "px",
        maxHeight: pos.maxH + "px",
      },
    },
      React.createElement("div", { className: "cxp-panel", "data-ces-part": "picker-panel", style: panelStyle },
        viewport,
        effortCard,
        catalog.error
          ? React.createElement("div", { className: "cxp-err", "data-ces-part": "picker-error" }, "模型目录报告：" + catalog.error)
          : null,
      ),
      popup,
    );

    if (ReactDOM && typeof ReactDOM.createPortal === "function" && doc && doc.body) {
      return ReactDOM.createPortal(surface, doc.body);
    }
    return surface;
  }
  return PickerSurface;
}

export {
  CSS as PICKER_CSS,
  createPickerTrigger,
  createPickerSurface,
  pickerStore,
  computePanelPos,
  readCatalog,
  defaultLevelIndex,
  sortModelsNewestFirst,
  versionRankOf,
  dateRankOf,
  currentModelName,
  providerTitle,
  viewportHeightFor,
  energyFor,
  speedFor,
  fillBackgroundFor,
  valueColorFor,
  isOffLevel,
  pctFromIndex,
  leftFor,
  starCountFor,
  starTopFor,
  starSizeFor,
  starBrightnessFor,
  starDurationFor,
  starDelayFor,
  PANEL_W,
  TRACK_H,
  KNOB,
  TR,
  THIRD,
  SLIDE_FAST,
  SLIDE_SLOW,
  SLOW_ENTER_MS,
  SLOW_EXIT_MS,
  ENERGY_START,
  COMMIT_SETTLE_MS,
  STAR_N,
};
