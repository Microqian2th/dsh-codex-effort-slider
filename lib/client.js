/**
 * dsh-codex-effort-slider — 客户端半边
 *
 * 把 DSH 官方模型菜单里的**「推理等级」那一行**改造成 Codex 风格滑条：
 *   · 那一行加高上下内距、允许折行，滑条作为第二行铺满整行宽度
 *   · 拖到最高档时，轨道亮起紫色能量层（流向渐变 + 扫光 + 22 颗星尘粒子），整行描一圈紫边
 *   · 输入框工具行**不加任何东西**（原来的胶囊已撤掉）
 *
 * ── 官方那一行的确切形状（来自 app.asar 源码，本插件用到的锚点）──────────
 *
 *   席（官方 ModelSelect 的 trigger）：
 *     <button aria-haspopup="menu" aria-expanded={open} aria-controls={`${id}-menu`}>
 *   菜单（portal 到 body 的 MenuSurface）：
 *     <… role="menu" id={`${id}-menu`}>                       ← 用 aria-controls + id 定位，比 class 稳
 *       <button role="menuitem"> 模型 … </button>              ← 根面板**只有**两个 menuitem
 *       <button role="menuitem"> 推理等级 <span>High</span> <svg/> </button>   ← 目标行
 *   子面板（模型列表 / 等级列表）用的是 `menuitemradio`，所以
 *   `button[role="menuitem"]` 恰好唯一标识根面板那两行 —— 这是本插件的主锚点。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────
 *  1. **只动那一行**：只写 4 个内联样式（height/flex-wrap/padding-block）+ 往行里 append 一个容器；
 *     关菜单或卸载时逐个还原，不碰官方其它 DOM、不碰官方 class。
 *  2. **fail-open**：任何一步找不到（没有 aria-controls、菜单没有两个 menuitem、会话作用域没就绪…）
 *     就什么都不做 —— 官方菜单保持原样，绝不因为本插件而点不开。
 *  3. **绝不注入消息**：不监听 agent/pre-step、不 append 会话事件、不构造消息
 *     （同类插件在这里踩过 V4 会话准入的坑，本插件结构上不存在这条路）。
 */
window.__ModuleLoader__.load({
  id: "dsh-codex-effort-slider",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");

    var PACKAGE_ID = "dsh-codex-effort-slider";
    /** 仍然注册一个（不可见的）插槽条目：它是**每会话**拿到 sessionId 与 ctx 的立足点。 */
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ID = "codex-effort-slider";
    var ENTRY_ORDER = 40;
    /** 「加高那一栏的上下距离」。 */
    var ROW_PADDING_BLOCK = "10px";
    /** 官方那一行的中文/英文文案（形状锚点之一；认不出就按官方固定顺序取第 2 个 menuitem）。 */
    var EFFORT_ROW_LABELS = ["推理等级", "Effort"];
    /**
     * 思考档位的**强度序**（由弱到强，含「关闭思考」在最左）。
     *
     * 为什么需要：滑条的语义是「**位置 = 强度**」—— 越往右越强、右端点亮紫色星云。
     * 而目录下发的 `reasoning.efforts` 顺序**不保证**是强度序，实测两类反例：
     *   · Qoder CN 兜底表按目录原序下发：`高 → 最大 → 低 → 关闭思考`
     *     （`max` 在 `low` 左边、`关闭思考` 被追加到最右）；
     *   · 同类插件里还有 `light` / `extra_high` / `on` 这类私有 id。
     * 直接按原序铺轨道的话，会出现「越往右越弱」「关掉思考反而拉满能量」这种反直觉结果。
     *
     * 所以这里**自己排一遍**：按本表排名稳定排序（同排名保持原相对顺序）。
     * 未登记的 id 排到末尾（权重 `UNKNOWN_EFFORT_RANK`，大于表里任何一档），
     * 同样保持原相对顺序 —— 于是「全是未知 id」的模型排序结果与今天完全一致
     * （不引入行为变化）。
     *
     * ⚠️ 这张表必须与 `dsh-our-free-model` 的 `src/reasoning-ladder.ts`
     * `REASONING_EFFORT_RANK` 同源（那边是跨 provider 的权威表）。改一处要同步另一处。
     * 同排名（`off`/`none` 都是 0、`high`/`on` 都是 5）保持目录里的原相对顺序。
     */
    var REASONING_EFFORT_RANK = {
      off: 0, none: 0, minimal: 1, light: 2, low: 3, medium: 4,
      high: 5, on: 5, extra_high: 6, xhigh: 7, max: 8, ultra: 9,
    };
    /** 未登记档位 id 的排序权重：大于表里任何一档，使它们统一落到末尾。 */
    var UNKNOWN_EFFORT_RANK = 100;
    /** 拖动期间的写回降频窗口（毫秒）。松手一律立即落地。 */
    var COMMIT_THROTTLE_MS = 120;
    /** 提交后等宿主真实回报的上限；超时回滚并提示，不继续假装已生效。 */
    var COMMIT_DEADLINE_MS = 10000;
    /** 目录解析失败时的退避重试序列（毫秒，累计约 9 秒）。 */
    var RETRY_DELAYS = [60, 240, 540, 960, 1500, 3000, 3000];
    var STYLE_MARKER = PACKAGE_ID;

    /* ── 尺寸与速率常量：**必须声明在 CSS 数组之前**，因为样式表要插值它们 ──
       （踩过一次：CSS 数组先于常量求值，样式里写进去的是 `height:undefinedpx`，
       真机上轨道会塌成 0 高。测试里对轨道高/旋钮直径的断言就是为这个加的。） */
    /** 轨道高度（px）。旋钮直径与它相同 —— 一个"管子里的球"，圆永远是完整的圆。 */
    var TRACK_HEIGHT = 28;
    var KNOB_SIZE = TRACK_HEIGHT;
    /** 旋钮半径。圆心在两端各留出这个半径，圆圈才不会顶出轨道被菜单裁掉。 */
    var KNOB_RADIUS = KNOB_SIZE / 2;
    /** 全局速率倍数（用户要求：所有速度 ×4）。粒子时长 = 基准时长 ÷ (本值 × speedFor)。 */
    var BASE_SPEEDUP = 4;
    /**
     * 星空的**基准横穿时长**（秒，越大越慢）与各星时长浮动（± 这个比例）。
     * 基准对应"位置速率最快的那一档"（speedFor 的上限 `MAX_SPEED_FACTOR = 2`）：MAX 档 1.5s，
     * high 档（1×）3s，左端（0.35×）约 8.6s —— 速度随位置变化这条一直保留。
     * 浮动压到 ±8%（速度差 1.16×）：原来用 0.95~2.05s（速度差 2.16×）时快星会追上慢星成团。
     */
    var STARFIELD_DURATION_MEAN = 1.5;
    var STARFIELD_DURATION_SPREAD = 0.08;
    /** MAX 档星空的亮度/大小下限（1 = 现在的大小与亮度，即上限）。 */
    var STARFIELD_MIN = 0.5;
    /** 黄金比：把 22 颗星的高度与相位按低差异序列铺开（见 buildParticles / starDelayFor）。 */
    var GOLDEN_RATIO = 0.6180339887498949;
    /** 位置速率的上限（= speedFor 的封顶值），用来把"最快那一档"和基准时长对齐。 */
    var MAX_SPEED_FACTOR = 2;
    /** 系统开启「减少动态效果」时，星星时长乘这个倍数（放缓而不是冻住）。 */
    var REDUCED_MOTION_SLOWDOWN = 2.6;
    /** 相位相邻的两颗星，高度至少差这么多"槽"（1 槽 = 4% 轨道高）——防止并成一坨。 */
    var MIN_HEIGHT_SLOTS = 3;
    /** 能量段起点：第二档的刻度位置（4 档模型 → 1/3）。这一段以前是纯蓝，之后才渐入紫色。 */
    var ENERGY_START = 1 / 3;
    /** 颜色锚点：紫出现在这里（4 档模型 → high 档）。 */
    var ENERGY_END = 2 / 3;

    /** 蓝 → 紫 → 深紫（"第一档到第二档为蓝色，再往右逐渐变紫变深"）。 */
    var COLOR_BLUE = [77, 147, 248];
    var COLOR_VIOLET = [147, 51, 234];
    var COLOR_DEEP = [76, 29, 149];
    /**
     * 数值文字（"Max"）用的亮紫终点。
     * 文字不能像填充那样收到深紫（`COLOR_DEEP` 在深色底上几乎看不见），所以另给一个亮端；
     * 但也不能太亮 —— 实测 `#c084fc` 在**浅色主题**下对比度只有 2.6:1（发虚），
     * 所以取中档紫罗兰 `#8b5cf6`：对白底 ≈4.2:1、对深色底（#1b1c20）≈4.0:1，两种主题都读得清。
     */
    var COLOR_TEXT_VIOLET = [139, 92, 246];

    /* ════════════════════════════ 样式 ════════════════════════════ */

    /*
     * 颜色一律走 DSH 自己的设计令牌（`--dsw-*`），浅色/深色自动跟随。
     * 蓝色强调色用 `--dsw-alias-state-business-primary`（深色下 = deepseek-400 #7aaaff），
     * 回退到 blue-450 #4d93f8 —— 也就是参考图里那条轨道的蓝。
     */
    var FILL_RADIUS = "border-radius:" + KNOB_RADIUS + "px 0 0 " + KNOB_RADIUS + "px";
    var CSS = [
      /* 注入进官方那一行的容器：折行到第二行并铺满整行 */
      ".ces-inline{--ces-accent:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-450,#4d93f8));box-sizing:border-box;flex-basis:100%;width:100%;min-width:0}",
      ".ces-track{position:relative;box-sizing:border-box;height:" + TRACK_HEIGHT + "px;margin-top:2px;border-radius:999px;background:var(--dsw-alias-border-l1,rgba(15,17,21,.08));cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}",
      ".ces-track:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--ces-accent));outline-offset:2px}",
      ".ces-fill{position:absolute;top:0;bottom:0;left:0;" + FILL_RADIUS + ";pointer-events:none}",
      ".ces-tick{position:absolute;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;background:rgba(128,128,128,.30);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 26%,transparent);pointer-events:none}",
      ".ces-tick[data-on='1']{background:rgba(255,255,255,.5)}",
      /* 旋钮直径 = 轨道高度（"与滑条同宽"）：圆完整地填满管口，不会出现被裁出的平边。 */
      ".ces-knob{position:absolute;top:50%;width:" + KNOB_SIZE + "px;height:" + KNOB_SIZE + "px;margin:" + (-KNOB_RADIUS) + "px 0 0 " + (-KNOB_RADIUS) + "px;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.34),0 0 0 .5px rgba(0,0,0,.06);pointer-events:none}",
      ".ces-error{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#e5484d)}",
      /* ── 最高档能量层（纯视觉：紫色星云 + 星尘粒子 + 扫光）─────────────────
         强度由 `--ces-energy`(0..1) 一个变量驱动：外层只做 opacity/box-shadow，
         所以"渐入"是浏览器合成的颜色插值，不需要 JS 逐帧改样式。
         关掉时把粒子动画 `animation-play-state: paused`，不让 22 个隐形元素白烧 GPU。 */
      ".ces-inline[data-energy='1'] .ces-track{box-shadow:0 0 calc(var(--ces-energy,0) * 16px) rgba(168,85,247,.5)}",
      ".ces-inline[data-energy='0'] .ces-star,.ces-inline[data-energy='0'] .ces-energy__sweep{animation-play-state:paused}",
      /* 能量层只覆盖**已填充那一段**（宽度与填充相同）：档位右边没到的部分不显示能量条。
         左端从 0 起、宽度由内联样式给（= 到旋钮圆心），所以它跟着旋钮一起长。 */
      ".ces-energy{position:absolute;top:0;bottom:0;left:0;" + FILL_RADIUS + ";overflow:hidden;pointer-events:none;opacity:var(--ces-energy,0);transition:opacity .2s ease;background:linear-gradient(90deg,#3b1178 0%,#6d28d9 30%,#9333ea 62%,#c084fc 100%)}",
      /* 星星单独一层：**不跟着星云淡入**（否则 high 档会被星云的 0.5 透明度压得看不见）。
         几何与星云层相同（贴着已填充段、圆角裁切），透明度由内联样式给。 */
      ".ces-stars{position:absolute;top:0;bottom:0;left:0;" + FILL_RADIUS + ";overflow:hidden;pointer-events:none;transition:opacity .2s ease}",
      /* 星空（**所有出现粒子的档位都用这一套**）：外层是**整轨宽度**的轨道
         （它自己在做 -100% 的连续横穿），内层圆点的亮度/大小由 --ces-b 决定（越亮越大）。
         残影只在两端淡出，而那两端在可视区外，所以看起来粒子"从不消失"。

         ⚠️ 时长与相位**直接内联**写在元素上（见组件的 animationDuration / animationDelay），
         不走 CSS 变量：实测把 `animation-delay:var(--ces-delay)` 写在样式表里时，
         真宿主里负相位不生效 —— 结果是"一打开所有星星挤在起点，十几秒后才靠速度差散开"。
         `--ces-b`（亮度/大小）只是不参与动画计时的普通变量，留着没问题。 */
      ".ces-star{position:absolute;left:0;right:0;height:3px;margin-top:-1.5px;pointer-events:none;animation-name:ces-star-sweep;animation-timing-function:linear;animation-iteration-count:infinite}",
      ".ces-star__dot{position:absolute;left:100%;top:0;width:3px;height:3px;margin-left:-1.5px;border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(255,255,255,.85);opacity:var(--ces-b,1);transform:scale(var(--ces-b,1))}",
      "@keyframes ces-star-sweep{0%{transform:translate3d(0,0,0);opacity:0}6%{opacity:1}94%{opacity:1}100%{transform:translate3d(-100%,0,0);opacity:0}}",
      ".ces-energy__sweep{position:absolute;inset:0;background:linear-gradient(100deg,transparent 18%,rgba(255,255,255,.30) 50%,transparent 82%);transform:translateX(100%);animation:ces-sweep 2.4s linear infinite}",
      "@keyframes ces-sweep{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}",
      "body[data-ds-dark-theme] .ces-star__dot{background:#f5f3ff;box-shadow:0 0 5px rgba(216,180,254,.95)}",
      /* 系统要求「减少动态效果」时**放缓**而不是冻住：收起扫光。
         星星的放缓在 JS 里算（时长 × REDUCED_MOTION_SLOWDOWN）—— 不走 CSS 媒体查询，
         因为时长现在是内联的，也免得再引入"变量参与动画计时"这类坑。 */
      "@media (prefers-reduced-motion: reduce){.ces-energy{transition:none}.ces-energy__sweep{display:none}}",
      /* 设置面板（挂在 body 上，样式必须是全局的） */
      ".ces-set{position:fixed;z-index:2147483000;min-width:252px;max-width:340px;padding:10px 12px;border-radius:10px;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-pri,#1b1c20);border:1px solid rgba(127,127,127,.28);box-shadow:0 12px 32px rgba(0,0,0,.24);font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}",
      ".ces-set__title{font-weight:600;margin:0 0 6px 0}",
      ".ces-set__row{font-size:12px;opacity:.72;margin-bottom:8px}",
      ".ces-set__group{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}",
      ".ces-set__group label{display:flex;gap:6px;align-items:center;cursor:pointer}",
      ".ces-set__actions{display:flex;justify-content:space-between;gap:8px}",
      ".ces-set button{cursor:pointer;font:inherit;color:inherit;padding:4px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent}",
      ".ces-set button:hover{background:rgba(127,127,127,.14)}",
      "body[data-ds-dark-theme] .ces-set{background:var(--dsw-alias-bg-base,#24262c);color:var(--dsw-alias-label-pri,#e8e9ec)}",
      /* 「已到达档位的刻度点」：dim = 与未到达同色；hidden = 隐藏 */
      ".ces-inline[data-reached-ticks='dim'] .ces-tick[data-on='1']{background:rgba(128,128,128,.30);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 26%,transparent)}",
      ".ces-inline[data-reached-ticks='hidden'] .ces-tick[data-on='1']{display:none}",
    ].join("\n");

    /** 把样式挂进文档。加载器会把它认领为「本插件产出的 style」（HMR 卸载时一并清理）。 */
    function installStyles() {
      try {
        installSettingsUi();
        if (typeof document === "undefined" || !document.head) return null;
        var existing = document.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]');
        if (existing) return existing;
        var style = document.createElement("style");
        style.setAttribute("data-plugin-css", STYLE_MARKER);
        style.textContent = CSS;
        document.head.appendChild(style);
        return style;
      } catch (error) {
        /* 样式失败只影响观感，绝不影响功能 */
        return null;
      }
    }

    /* ════════════════ 设置（schema 驱动，加新设置只需加一行）════════════════ *
     *
     * 目标（用户明确要求）：
     *   1. 三种动画：「简洁动画」(quick)、「完整动画」(full)、「快速动画」(fast)
     *   2. **完全不受系统「减少动态效果」影响** —— 三种模式都由插件自己决定
     *   3. 简洁动画 = 我们之前的方案（MOTION_REDUCED 紧参数）
     *   4. 完整动画 = 作者原本的方案（MOTION 松参数）
     *   5. 快速动画 = 复刻 Codex 桌面版（不跟手 + 一档一格 + 约 70~85ms 吸附，见 MOTION_FAST）
     *
     * 设计要点：
     *   · 所有设置都在 SETTINGS_SCHEMA 里声明；面板按 schema 自动渲染/回填/校验
     *   · 加设置 = 加一行表项（若是新控件类型，再加一个 renderKind 分支）
     *
     * ⚠️ 这些函数会被预览生成器**原样抽取**到另一个作用域，所以模块级变量一律
     *    用 `typeof x === "undefined"` 兜底，绝不裸引用。
     */
    /** 诊断用：本模块被加载了几次、每个组件实例的编号（排查"两个实例互相搅乱拖动状态"）。 */
    var __cesInstanceSeq = 0;
    /** 本份模块加载的身份令牌（每次 load 一份新的）。 */
    var __cesOwnerToken = {};
    /** 本份加载是否"已判定过""是否是 owner"——只判定一次，保证实例的 Hook 数量恒定。 */
    var __cesDecided = false;
    var __cesIsOwner = false;

    /**
     * 档位列表的「抗瞬时为空」缓存（键 = 模型身份 `provider\0model`）。
     *
     * 为什么需要：宿主在**模型切换 / 目录刷新 / 模型版本更新**时会瞬时丢掉
     * `model.reasoning.efforts`。实测（2026-10-17，模型更新到 DeepSeek-V4.1-Flash-1017 之后）：
     *   松手那一刻 `levelCount` 变 0 → `release-abort` → 不写回 →
     *   显示交还旧档位 `eff` → 用户看到"点一下顿一下 / 跳一格"。
     * 档位列表是"同一模型的静态配置"，瞬时空一下不该改变用户意图，所以兜一份缓存。
     * 键不匹配（模型真的换了）就不复用缓存，避免拿旧模型的档位去写新模型。
     */
    var __levelsCache = { key: null, levels: [] };
    var __levelsCacheHit = false;
    var SETTINGS_KEY = "dsh-codex-effort-slider.settings";
    var SETTINGS_EVENT = "dsh-codex-effort-slider:settings";
    var SETTINGS_VERSION = 3;

    var SETTINGS_SCHEMA = [
      {
        key: "motion",
        kind: "radio",
        group: "动画效果",
        label: "动画效果",
        default: "full",
        options: [
          { value: "fast", label: "快速动画" },
          { value: "quick", label: "简洁动画" },
          { value: "full", label: "完整动画" },
        ],
      },
      {
        key: "reachedTicks",
        kind: "radio",
        group: "已到达档位的刻度点",
        label: "刻度点",
        default: "hidden",
        options: [
          { value: "highlight", label: "亮白显示" },
          { value: "dim", label: "与未到达同色" },
          { value: "hidden", label: "隐藏" },
        ],
      },
    ];

    function schemaDefaults() {
      var schema = (typeof SETTINGS_SCHEMA === "undefined") ? [] : SETTINGS_SCHEMA;
      var out = {};
      for (var i = 0; i < schema.length; i += 1) {
        var item = schema[i];
        if (item.default !== undefined) { out[item.key] = item.default; continue; }
        if (item.kind === "radio") out[item.key] = item.options[0].value;
        else if (item.kind === "switch") out[item.key] = true;
        else if (item.kind === "range") out[item.key] = (item.scale || 1);
        else out[item.key] = null;
      }
      return out;
    }

    /** schema 驱动的校验：非法/缺失值回退默认，永远返回完整设置。 */
    function normalizeSettings(raw) {
      var schema = (typeof SETTINGS_SCHEMA === "undefined") ? [] : SETTINGS_SCHEMA;
      var out = schemaDefaults();
      var source = (raw && typeof raw === "object") ? raw : {};
      for (var i = 0; i < schema.length; i += 1) {
        var item = schema[i];
        var value = source[item.key];
        if (value === undefined) continue;
        if (item.kind === "radio") {
          for (var j = 0; j < item.options.length; j += 1) {
            if (item.options[j].value === value) { out[item.key] = value; break; }
          }
        } else if (item.kind === "switch") {
          if (typeof value === "boolean") out[item.key] = value;
        } else if (item.kind === "range") {
          var n = typeof value === "number" ? value : parseFloat(value);
          var scale = item.scale || 1;
          if (isFinite(n)) {
            var lo = item.min / scale, hi = item.max / scale;
            out[item.key] = n < lo ? lo : (n > hi ? hi : n);
          }
        }
      }
      return out;
    }

    var settingsCache = null;
    var settingsUiState = {
      installed: false, panel: null, longPressTimer: null, longPressOrigin: null,
      anchorEl: null, cacheListenerInstalled: false,
    };

    function settingsKey() { return (typeof SETTINGS_KEY === "undefined") ? "dsh-codex-effort-slider.settings" : SETTINGS_KEY; }
    function settingsEventName() { return (typeof SETTINGS_EVENT === "undefined") ? "dsh-codex-effort-slider:settings" : SETTINGS_EVENT; }
    function cacheGet() { return (typeof settingsCache === "undefined") ? null : settingsCache; }
    function cacheSet(value) { if (typeof settingsCache !== "undefined") settingsCache = value; }

    function readSettings() {
      var cached = cacheGet();
      if (cached !== null) return cached;
      var raw = null;
      try {
        if (typeof localStorage !== "undefined" && localStorage) raw = localStorage.getItem(settingsKey());
      } catch (error) { /* 读不到用默认 */ }
      var parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (error) { parsed = null; }
      var expected = (typeof SETTINGS_VERSION === "undefined") ? 3 : SETTINGS_VERSION;
      // 版本不符 → **不丢弃值**，只按当前 schema 规范化（保留仍合法的项）并盖上版本号。
      var out = normalizeSettings(parsed);
      out.v = expected;
      if (parsed && typeof parsed === "object" && parsed.v !== expected) {
        try {
          if (typeof localStorage !== "undefined" && localStorage) localStorage.setItem(settingsKey(), JSON.stringify(out));
        } catch (error) { /* 写盘失败也无妨：值已保住 */ }
      }
      cacheSet(out);
      return out;
    }

    function writeSettings(patch) {
      var cur = readSettings();
      var merged = {};
      for (var k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) merged[k] = cur[k];
      if (patch && typeof patch === "object") {
        for (var k2 in patch) if (Object.prototype.hasOwnProperty.call(patch, k2)) merged[k2] = patch[k2];
      }
      var next = normalizeSettings(merged);
      next.v = (typeof SETTINGS_VERSION === "undefined") ? 3 : SETTINGS_VERSION;
      cacheSet(next);
      try {
        if (typeof localStorage !== "undefined" && localStorage) localStorage.setItem(settingsKey(), JSON.stringify(next));
      } catch (error) { /* 存不下只影响"下次还记不记得" */ }
      try {
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
          window.dispatchEvent(new CustomEvent(settingsEventName()));
        }
      } catch (error) { /* 广播失败无妨 */ }
      return next;
    }

    /** 当前动画模式：'quick' 简洁 / 'full' 完整 / 'fast' 快速（Codex 手感）。**与系统设置无关**。 */
    function motionMode() {
      var mode = readSettings().motion;
      return mode === "quick" || mode === "fast" ? mode : "full";
    }

    /** 当前模式对应的运动参数组（不读取任何系统偏好）。 */
    function motionParamsForMode() {
      var mode = motionMode();
      if (mode === "quick") return MOTION_REDUCED;
      if (mode === "fast") return MOTION_FAST;
      return MOTION;
    }

    /** 系统是否要求「减少动态效果」——**仅用于面板提示**，不影响任何行为。 */
    function systemReducedMotion() {
      try {
        return typeof window !== "undefined" && typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
      } catch (error) { return false; }
    }

    /* ───────────── 诊断记录（排查"松手抽搐"这类真机时序问题）───────────── *
     * 推理到极限时的办法：把每一帧的"显示值 / 已生效档位 / 草稿"记下来，
     * 复现后一键复制，就能直接看到**到底是哪一帧、哪个值跳了**。
     */
    var traceBuf = [];
    function tracePush(entry) {
      try {
        traceBuf.push(entry);
        if (traceBuf.length > 400) traceBuf.splice(0, traceBuf.length - 400);
      } catch (error) { /* 诊断失败绝不影响功能 */ }
    }
    function traceClear() {
      try { traceBuf.length = 0; } catch (error) { /* 忽略 */ }
    }
    /** 生成可直接粘贴的诊断文本：突出"单帧跳变"与"松手事件"。 */
    function dumpTrace() {
      try {
        var buf = traceBuf.slice();
        if (buf.length === 0) return "（还没有记录：请先在滑条上拖动/松手几次，再点这里）";
        var samples = buf.filter(function (e) { return e && e.k === "s"; });
        var jumps = [];
        for (var i = 1; i < samples.length; i += 1) {
          var d = Math.abs((samples[i].shown || 0) - (samples[i - 1].shown || 0));
          if (d > 0.02) jumps.push({ at: i, d: Math.round(d * 1000) / 10, from: samples[i - 1], to: samples[i] });
        }
        jumps.sort(function (a, b) { return b.d - a.d; });
        var lines = [];
        lines.push("=== 滑条诊断 " + new Date().toISOString() + " ===");
        lines.push("记录 " + buf.length + " 条（采样 " + samples.length + "）");
        lines.push("动画模式 = " + readSettings().motion + " ; 系统减少动态 = " + systemReducedMotion());
        lines.push("单帧跳变(>2%) 次数: " + jumps.length);
        for (var j = 0; j < Math.min(8, jumps.length); j += 1) {
          var x = jumps[j];
          lines.push("  跳 " + x.d + "%  " + JSON.stringify({ from: x.from, to: x.to }));
        }
        var rel = buf.filter(function (e) { return e && e.k === "release"; });
        lines.push("松手事件 " + rel.length + " 次，最后 3 次:");
        for (var r = Math.max(0, rel.length - 3); r < rel.length; r += 1) lines.push("  " + JSON.stringify(rel[r]));
        // 事件计数：一眼看出 endDrag / settle-clear / release 各发生了几次
        var evCounts = {};
        for (var ci = 0; ci < buf.length; ci += 1) { var kk = buf[ci] && buf[ci].k; if (kk) evCounts[kk] = (evCounts[kk] || 0) + 1; }
        lines.push("事件计数: " + JSON.stringify(evCounts));
        // 每个非采样事件的上下文（前 2 条 + 后 6 条）
        var marks = [];
        for (var mi = 0; mi < buf.length; mi += 1) { if (buf[mi] && buf[mi].k && buf[mi].k !== "s") marks.push(mi); }
        for (var mj = Math.max(0, marks.length - 5); mj < marks.length; mj += 1) {
          var mIdx = marks[mj];
          lines.push("=== 事件 " + JSON.stringify(buf[mIdx]));
          for (var mb = Math.max(0, mIdx - 2); mb < mIdx; mb += 1) lines.push("  前 " + JSON.stringify(buf[mb]));
          for (var ma = mIdx + 1; ma < Math.min(buf.length, mIdx + 7); ma += 1) lines.push("  后 " + JSON.stringify(buf[ma]));
        }
        lines.push("--- 最后 120 条原始记录 ---");
        var tail = buf.slice(-120);
        for (var k = 0; k < tail.length; k += 1) lines.push(JSON.stringify(tail[k]));
        return lines.join("\n");
      } catch (error) {
        return "诊断生成失败: " + String(error && error.message ? error.message : error);
      }
    }

    /* ───────────── 面板：全部由 SETTINGS_SCHEMA 生成 ───────────── */

    function renderKind(item, value, esc) {
      var key = item.key;
      if (item.kind === "radio") {
        var opts = "";
        for (var i = 0; i < item.options.length; i += 1) {
          var o = item.options[i];
          opts += '<label><input type="radio" name="ces-' + esc(key) + '" data-ces-key="' + esc(key) + '" value="' + esc(o.value) + '"' +
            (value === o.value ? " checked" : "") + '> ' + esc(o.label) + '</label>';
        }
        return '<div class="ces-set__group" role="radiogroup" aria-label="' + esc(item.group || item.label) + '">' +
          (item.group ? '<div class="ces-set__row">' + esc(item.group) + '</div>' : "") + opts + '</div>';
      }
      if (item.kind === "switch") {
        return '<div class="ces-set__group"><label><input type="checkbox" data-ces-key="' + esc(key) + '"' +
          (value === true ? " checked" : "") + '> ' + esc(item.label) + '</label></div>';
      }
      if (item.kind === "range") {
        var shown = Math.round((value || 0) * (item.scale || 1));
        return '<div class="ces-set__group"><label class="ces-set__range">' + esc(item.label) +
          ' <input type="range" data-ces-key="' + esc(key) + '" data-ces-scale="' + esc(item.scale || 1) + '"' +
          ' min="' + esc(item.min) + '" max="' + esc(item.max) + '" step="' + esc(item.step || 1) + '" value="' + esc(shown) + '">' +
          ' <span data-ces-val="' + esc(key) + '"></span></label></div>';
      }
      return "";   // 未知 kind：安静跳过（旧版本遇到新控件不崩）
    }

    function disposeSettingsPanel() {
      try {
        if (typeof document === "undefined") return;
        var stale = document.querySelectorAll(".ces-set");
        for (var i = 0; i < stale.length; i += 1) {
          if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
        }
      } catch (error) { /* 清理失败不致命 */ }
      settingsUiState.panel = null;
    }

    function buildSettingsPanel() {
      disposeSettingsPanel();   // 插件可能被加载多次：每次清掉旧面板再建，保证唯一且最新
      var esc = function (v) {
        return String(v === undefined || v === null ? "" : v)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      };
      var s = readSettings();
      var schema = (typeof SETTINGS_SCHEMA === "undefined") ? [] : SETTINGS_SCHEMA;
      var body = "";
      for (var i = 0; i < schema.length; i += 1) body += renderKind(schema[i], s[schema[i].key], esc);

      var panel = document.createElement("div");
      panel.className = "ces-set";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "推理等级滑条 · 设置");
      panel.setAttribute("tabindex", "-1");
      panel.style.display = "none";
      panel.innerHTML =
        '<div class="ces-set__title">滑条设置</div>' +
        '<div class="ces-set__row" data-ces-system></div>' +
        body +
        '<div class="ces-set__actions">' +
        '<button type="button" data-ces-trace>复制诊断</button>' +
        '<button type="button" data-ces-reset>恢复默认</button>' +
        '<button type="button" data-ces-close>关闭</button>' +
        '</div>';

      // 事件完全由 data-ces-key 驱动：加新设置不用改这里；只监听 input（挂 change 会写两次）
      var applyFromInput = function (input) {
        var key = input.getAttribute("data-ces-key");
        if (!key) return;
        var schema = (typeof SETTINGS_SCHEMA === "undefined") ? [] : SETTINGS_SCHEMA;
        var item = null;
        for (var i = 0; i < schema.length; i += 1) if (schema[i].key === key) { item = schema[i]; break; }
        if (item === null) return;
        var patch = {};
        if (item.kind === "switch") patch[key] = input.checked === true;
        else if (item.kind === "range") patch[key] = parseFloat(input.value) / (item.scale || 1);
        else patch[key] = input.value;
        writeSettings(patch);
        syncSettingsPanel();   // 任何改动都刷新：让依赖联动立刻生效
      };
      panel.addEventListener("input", function (event) { applyFromInput(event.target); });
      panel.addEventListener("click", function (event) {
        var el = event.target;
        if (!el || typeof el.hasAttribute !== "function") return;
        if (el.hasAttribute("data-ces-trace")) {
          var txt = dumpTrace();
          var btn = el;
          try {
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(txt);
              btn.textContent = "已复制 ✓";
            } else {
              btn.textContent = "无法复制";
            }
          } catch (error) { btn.textContent = "无法复制"; }
          setTimeout(function () { btn.textContent = "复制诊断"; }, 1500);
        }
        if (el.hasAttribute("data-ces-reset")) { writeSettings(schemaDefaults()); syncSettingsPanel(); }
        if (el.hasAttribute("data-ces-close")) closeSettingsPanel();
      });
      panel.addEventListener("mousedown", function (event) { event.stopPropagation(); });

      document.body.appendChild(panel);
      settingsUiState.panel = panel;
      return panel;
    }

    function syncSettingsPanel() {
      var panel = settingsUiState.panel;
      if (!panel) return;
      var s = readSettings();
      var schema = (typeof SETTINGS_SCHEMA === "undefined") ? [] : SETTINGS_SCHEMA;
      for (var i = 0; i < schema.length; i += 1) {
        var item = schema[i];
        var input = panel.querySelector('[data-ces-key="' + item.key + '"]');
        if (item.kind === "radio") {
          var radios = panel.querySelectorAll('[data-ces-key="' + item.key + '"]');
          for (var r = 0; r < radios.length; r += 1) radios[r].checked = (radios[r].value === s[item.key]);
        } else if (item.kind === "switch" && input) {
          input.checked = s[item.key] === true;
        } else if (item.kind === "range" && input) {
          var shown = String(Math.round((s[item.key] || 0) * (item.scale || 1)));
          if (input.value !== shown) input.value = shown;
          input.disabled = item.dependsOn ? (s[item.dependsOn] !== true) : false;
          var label = panel.querySelector('[data-ces-val="' + item.key + '"]');
          if (label) label.textContent = input.disabled ? "已关闭" : (shown + (item.unit || ""));
        }
      }
      var sys = panel.querySelector("[data-ces-system]");
      if (sys) sys.textContent = "三种动画都不受系统「减少动态效果」影响";
    }

    function closeSettingsPanel() {
      var panel = settingsUiState.panel;
      if (!panel || panel.style.display === "none") return;
      panel.style.display = "none";
      try {
        if (settingsUiState.anchorEl && typeof settingsUiState.anchorEl.focus === "function") settingsUiState.anchorEl.focus();
      } catch (error) { /* 忽略 */ }
    }

    function openSettingsPanel(rect, anchorEl) {
      try {
        if (typeof document === "undefined" || !document.body) return;
        var panel = buildSettingsPanel();
        syncSettingsPanel();
        panel.style.display = "block";
        settingsUiState.anchorEl = anchorEl || null;
        var width = panel.offsetWidth || 280;
        var height = panel.offsetHeight || 200;
        var x = rect ? rect.left : 40;
        var y = rect ? rect.bottom + 6 : 80;
        var maxX = (window.innerWidth || 1024) - width - 8;
        var maxY = (window.innerHeight || 768) - height - 8;
        panel.style.left = Math.max(8, Math.min(x, maxX)) + "px";
        panel.style.top = Math.max(8, Math.min(y, maxY)) + "px";
        try { panel.focus(); } catch (error) { /* 无所谓 */ }
      } catch (error) { /* 面板失败不影响滑条 */ }
    }

    function isOurSlider(node) {
      return !!(node && typeof node.closest === "function" && node.closest(".ces-inline"));
    }

    /** 安装全局交互。分两段：① 每个模块实例都要挂"清缓存"；② 全局交互只装一套。 */
    function installSettingsUi() {
      if (typeof document === "undefined" || !document.addEventListener) return;
      settingsUiState.installed = true;

      if (settingsUiState.cacheListenerInstalled !== true) {
        settingsUiState.cacheListenerInstalled = true;
        try {
          if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener(settingsEventName(), function () { cacheSet(null); });
          }
        } catch (error) { /* 忽略 */ }
      }
      if (document.__cesSettingsUiInstalled === true) return;
      document.__cesSettingsUiInstalled = true;

      // 1) 右键
      document.addEventListener("contextmenu", function (event) {
        if (!isOurSlider(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        var host = event.target.closest(".ces-inline");
        openSettingsPanel(host.getBoundingClientRect(), host);
      }, true);

      // 2) 长按 600ms（必须"按住不动"：拖动时指针一直在动，绝不能弹面板）
      document.addEventListener("pointerdown", function (event) {
        if (!isOurSlider(event.target)) return;
        var host = event.target.closest(".ces-inline");
        clearTimeout(settingsUiState.longPressTimer);
        settingsUiState.longPressOrigin = { x: event.clientX, y: event.clientY };
        settingsUiState.longPressTimer = setTimeout(function () {
          settingsUiState.longPressTimer = null;
          openSettingsPanel(host.getBoundingClientRect(), host);
        }, 600);
      }, true);
      var cancelLongPress = function () {
        if (!settingsUiState.longPressTimer) return;
        clearTimeout(settingsUiState.longPressTimer);
        settingsUiState.longPressTimer = null;
      };
      document.addEventListener("pointermove", function (event) {
        var origin = settingsUiState.longPressOrigin;
        if (!origin) return;
        if (Math.abs((event.clientX || 0) - origin.x) > 6 || Math.abs((event.clientY || 0) - origin.y) > 6) cancelLongPress();
      }, true);
      document.addEventListener("pointerup", cancelLongPress, true);
      document.addEventListener("pointercancel", cancelLongPress, true);

      // 3) 键盘等效键（右键是键盘用户够不到的）
      document.addEventListener("keydown", function (event) {
        var isMenuKey = (event.shiftKey && event.key === "F10") || event.key === "ContextMenu";
        if (!isMenuKey) return;
        var active = document.activeElement;
        if (!isOurSlider(active)) return;
        event.preventDefault();
        openSettingsPanel(active.getBoundingClientRect(), active);
      }, true);

      // 4) Esc / 点外部关闭
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") closeSettingsPanel();
      }, true);
      document.addEventListener("mousedown", function (event) {
        var panel = settingsUiState.panel;
        if (!panel || panel.style.display === "none") return;
        if (panel.contains(event.target)) return;
        if (isOurSlider(event.target)) return;   // 右键/长按紧接着会重新打开
        closeSettingsPanel();
      }, true);
    }

    /* ════════════════════════ 纯函数（可离线单测）════════════════════════ */

    var EMPTY_SNAPSHOT = Object.freeze({
      current: null,
      groups: [],
      failures: [],
      status: "idle",
      pending: null,
      error: null,
      retainedEffort: undefined,
    });

    /** 在目录快照里找到当前模型条目（groups[].models[]）。 */
    function modelOf(state) {
      var current = state && state.current;
      if (!current || typeof current.provider !== "string" || typeof current.model !== "string") return null;
      var groups = state && Array.isArray(state.groups) ? state.groups : [];
      for (var i = 0; i < groups.length; i += 1) {
        var group = groups[i];
        if (!group || group.id !== current.provider) continue;
        var models = Array.isArray(group.models) ? group.models : [];
        for (var j = 0; j < models.length; j += 1) {
          if (models[j] && models[j].id === current.model) return models[j];
        }
      }
      return null;
    }

    /**
     * 档位 id 的强度排名；未登记的返回 `UNKNOWN_EFFORT_RANK`
     * （= 排在所有已知档位之后，彼此仍按原相对顺序）。
     */
    function effortRankOf(id) {
      if (typeof id !== "string") return UNKNOWN_EFFORT_RANK;
      return Object.prototype.hasOwnProperty.call(REASONING_EFFORT_RANK, id) ? REASONING_EFFORT_RANK[id] : UNKNOWN_EFFORT_RANK;
    }

    /**
     * 把目录下发的档位按**强度序**稳定排序（纯函数，可离线单测）。
     *
     * 输入/输出都是 `{ id, name }` 数组。规则：
     *   1. 已登记的 id 按 `REASONING_EFFORT_RANK` 升序 —— 「关闭思考」自然落到最左；
     *   2. 同排名保持原相对顺序（`off`/`none`、`high`/`on` 两组会这样）；
     *   3. 未登记的 id 排在最后，也保持原相对顺序。
     * 于是「全部未登记」时输出与输入逐项相同 —— 对未知 provider 零行为变化。
     */
    function sortLevelsByStrength(levels) {
      if (!Array.isArray(levels)) return [];
      var decorated = [];
      for (var i = 0; i < levels.length; i += 1) {
        decorated.push({ level: levels[i], index: i, rank: effortRankOf(levels[i] && levels[i].id) });
      }
      decorated.sort(function (a, b) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.index - b.index;
      });
      var out = [];
      for (var j = 0; j < decorated.length; j += 1) out.push(decorated[j].level);
      return out;
    }

    /** 当前模型真实可用的档位列表（官方 id + 官方显示名，按**强度序**排列）。 */
    function levelsOf(state) {
      var model = modelOf(state);
      var efforts = model && model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
      var out = [];
      for (var i = 0; i < efforts.length; i += 1) {
        var effort = efforts[i];
        if (!effort || typeof effort.id !== "string" || effort.id.length === 0) continue;
        out.push({
          id: effort.id,
          name: typeof effort.name === "string" && effort.name.length > 0 ? effort.name : effort.id,
        });
      }
      return sortLevelsByStrength(out);
    }

    /**
     * 解析"本次渲染真正可用的档位列表"：
     *   活列表非空 → 更新缓存并返回它；
     *   活列表为空 → 若缓存属于同一模型（或身份未知），用缓存兜底；否则返回空。
     * 纯函数 + 显式传入缓存，便于单测（见 test/client.test.mjs 第 49 节）。
     */
    function resolveLevels(liveLevels, liveKey, cache) {
      if (liveLevels.length > 0) {
        cache.key = liveKey;
        cache.levels = liveLevels;
        return liveLevels;
      }
      var sameModel = liveKey === null || cache.key === null || liveKey === cache.key;
      if (cache.levels.length > 0 && sameModel) return cache.levels;
      return liveLevels;
    }

    /**
     * 当前**生效**的档位 id：显式设置优先；没设置过就是模型的默认档
     * （与官方 `syncInputs()` 的 `effort = intended.reasoningEffort ?? reasoning.defaultEffort` 同款）。
     */
    function effectiveEffortId(state) {
      var current = state && state.current;
      if (current && typeof current.reasoningEffort === "string" && current.reasoningEffort.length > 0) {
        return current.reasoningEffort;
      }
      var model = modelOf(state);
      var fallback = model && model.reasoning && model.reasoning.defaultEffort;
      return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
    }

    function indexOfLevel(levels, id) {
      if (typeof id !== "string") return -1;
      for (var i = 0; i < levels.length; i += 1) if (levels[i].id === id) return i;
      return -1;
    }

    function clamp01(value) {
      if (!(value > 0)) return 0; // 同时挡住 NaN
      return value > 1 ? 1 : value;
    }

    /** 百分比 → 最近档位下标（滑条连续，档位离散，所以必须吸附）。 */
    function indexFromPct(pct, count) {
      if (count <= 1) return 0;
      return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))));
    }

    /** 档位下标 → 该档位在轨道上的百分比（刻度点与旋钮永远对齐）。 */
    function pctFromIndex(index, count) {
      // ⚠️ 只有一档时**直接拉满**（issue #7）：那一档就是"最大"，不是"最左/off"。
      //    count === 0（档位还没就绪）仍返回 0 —— 否则空列表会把旋钮甩到最右。
      if (count <= 0) return 0;
      if (count === 1) return 1;
      var safe = Math.max(0, Math.min(count - 1, index));
      return safe / (count - 1);
    }

    /** 「一档一格」的判定阈值：向前只越过 1/3 档距，向后要退回 2/3（滞回，防抖）。 */
    var DETENT_THIRD = 1 / 3;

    /**
     * 快速动画（Codex 手感）的档位判定（纯函数，便于单测）：
     *   pos   —— 指针在「档位坐标」上的连续位置，0 … count-1（不是百分比）
     *   cur   —— 当前停在第几格
     *   count —— 档位数
     * 规则：pos ≥ cur + 1/3 才向上（拖得快可一次跨多格）；pos ≤ cur − 2/3 才向下；否则不动。
     */
    function detentTargetIndex(pos, cur, count, third) {
      if (count <= 1) return 0;
      var th = (typeof third === "number" && third > 0 && third < 0.5) ? third : 1 / 3;
      var lo = Math.max(0, Math.min(count - 1, typeof cur === "number" ? cur : 0));
      var p = Math.max(0, Math.min(count - 1, pos));
      if (p >= lo + th) return Math.min(count - 1, Math.max(lo + 1, Math.round(p)));
      if (p <= lo - (1 - th)) return Math.max(0, Math.min(lo - 1, Math.round(p)));
      return lo;
    }

    /* ══════════════ 连续运动引擎（刹车预测 + 速度跟踪）══════════════
     *
     * 核心不变量：**目标可以突变，运动状态（位置 x / 速度 v / 加速度 a）不可以。**
     * 用户操作（按下 / 拖动 / 松手 / 键盘）只改 `m.target`，**绝不碰 x / v / a**。
     *
     * 早先几版都在"时长 + 缓动曲线"里打转（200ms ease-in-out → 80ms ease-out →
     * 追赶窗口），怎么调都不对。根因是：CSS transition 在目标变化时**必然重播
     * 一条固定曲线**，做不到"只换目标、不换运动状态"，于是永远在"取消旧动画 →
     * 播新动画"之间切换，视觉上就是"本来在减速突然又开始加速"的割裂感。
     *
     * ── 运动律：两步 ──
     *
     *   第 1 步：**由位置误差算出"期望速度"**（两个映射取小）
     *       v期望 = sign(e) · min( K·|e| , √(2·A·|e|) , vmax )
     *
     *   第 2 步：**由速度差算出加速度**（连续跟踪，不是 bang-bang）
     *       a = clamp(k · (v期望 − v), ±amax)
     *       v = clamp(v + a·dt, ±vmax);   x = x + v·dt
     *
     * ⚠️ **必须同时有那两项，只留刹车曲线会抖振**（实测定论，别重犯）：
     *   `√(2A|e|)` 是 **bang-bang 的切换曲线**，含义是"在**恒力 A 减速**下还能
     *   刹停的速度上限"，它和 `a = ±A` 是**一对**。一旦力律换成连续的
     *   `a = k(v期望 − v)`，就丢掉了"力恒定为 A"这个前提：
     *     · v期望 自身随 e→0 而下降，v 永远追不上一条持续下降的曲线
     *     · 到目标时仍有残速 → 冲过去 → e 变号 → v期望 反向 → 又冲回来
     *   实测只留 `√(2Ae)` 当速度目标：目标 0.5 时 **v 符号翻转 973 次、永不收敛**。
     *
     *   所以 `K·|e|` 才是**为连续力律设计的**位置→速度映射；`√(2A|e|)` 降级为
     *   **上限**（"别快过刹得住的速度"）。两者取小后实测零抖振、全部精确落点。
     *
     * ── 参数（四个旋钮）──
     *   K    = 位置→速度映射增益（1/s）。决定"离目标多远时想跑多快"。
     *   A    = 刹车斜率，只作速度上限。同时决定反向滑行距离 ≈ v²/(2A)。
     *   k    = 速度跟踪增益（1/s）。越大越接近 bang-bang（力陡），越小越柔和。
     *   vmax = 速度上限。
     *
     * 实测标定（真实事件率 125Hz + 帧 60Hz，行程 = 1.0）—— K=20 A=120 k=40 vmax=6：
     *
     *     指标                        本版      弹簧阻尼版   纯 bang-bang
     *     小幅动 10px 后的"弹"        0.28px    7.11px      0.00px
     *     召唤到 1%                   ~200ms    333ms       217ms
     *     过冲（各距离）              ≤0.2px    0.00px      0.00px
     *     各距离精确落点              全部 ✓    全部 ✓      全部 ✓
     *     抖振（v 符号翻转）          0         0           需要 16 子步抑制
     *
     * ⚠️ 两个实测确认"别加"的东西：
     *   1) **不要加加加速度(jmax)限幅**：会拖慢力对"预测切换时机"的响应，
     *      反而把弹从小到大（在 bang-bang 版上实测 0.32 → 1.40px）。
     *   2) **不要加指针速度前馈**：本律只看 x 与 v；叠前馈会把拖动领先放大
     *      （在 bang-bang 版上实测 1.0 → 4.6px）。
     *
     * ⚠️ 边界处理：位置夹住时必须同时把朝外的速度停住，否则会在端点"顶住"抖动。
     */
    var MOTION = {
      K: 20,       // 位置→速度映射增益（1/s）
      A: 120,      // 刹车斜率（pct/s²）：只作速度上限；反向滑行 ≈ v²/(2A)
      k: 40,       // 速度跟踪增益（1/s）
      amax: 240,   // 加速度上限（pct/s²，安全阀）
      vmax: 6,     // 速度上限（pct/s）
      epsX: 0.0015, // 到位判定：位置误差阈值
      epsV: 0.02,   // 到位判定：速度阈值
    };
    /** 「简洁动画」：比完整更干脆，但**必须稳定**（见下方警告）。 */
    var MOTION_REDUCED = {
      K: 40, A: 300, k: 40, amax: 200, vmax: 7,
      epsX: 0.0015, epsV: 0.02,
    };
    /* ⚠️⚠️ 参数稳定性硬约束（issue #12 的真因，别再犯）：
     *
     *   旧参数 { K:120, A:600, k:200, amax:1200, vmax:20 } 会**自激振荡** ✗：
     *   `amax × 每帧时长 = 1200 ÷ 60 = 20`，**正好等于 vmax** →
     *   速度能在一帧内从 +20 翻到 -20 → 位置每帧摆动 ±20/60 = **±0.333** ✗
     *   → 实测就是 issue #12 里"33.6% 前后跳、215 次单帧跳变" ✓（eff 却恒为 0.5 ✗）。
     *
     *   判据：**`amax × (1/60) ≤ 0.5 × vmax`**（60fps 下速度一帧最多变半档），
     *   否则控制器退化成 bang-bang（全速正反打），小幅调整也会抖。
     *   下面三组都满足：
     *     MOTION        amax 240 / 60 = 4    ≤ 0.5 × 6  = 3   ≈ 临界（够用）
     *     MOTION_REDUCED amax 200 / 60 = 3.3 ≤ 0.5 × 7  = 3.5 ✓
     *     MOTION_FAST   amax 300 / 60 = 5    ≤ 0.5 × 10 = 5   ✓
     */
    /**
     * 「快速动画」(fast) —— 复刻 Codex 桌面版的手感（2026-10-17 从 60fps 录屏逐帧量得）：
     *   · **不跟手**：旋钮停在档位格上，不随指针连续移动（见 moveTo 的 fast 分支）；
     *   · 越过「当前格 + 1/3」才切下一格、越过「当前格 − 2/3」才回上一格（滞回，见 detentTargetIndex）；
     *   · 吸附**很快**：实测半条轨道约 67ms（≈4 帧 @60fps）；
     *   · **无回弹**：落点后只留极小残差（视频实测 ≈±1%）。
     * 参数是手算+测试校出来的：vmax 10 / A 500 的刹车距离刚好覆盖，k·amax 让速度一帧最多变 5，
     * 所以小幅移动（0.2→1/3）3 帧到位、半条轨道 4~5 帧到位，**都不过冲**。
     * ⚠️ 别再把 amax/k 调大：a·dt 会接近 vmax，变成 bang-bang → 小幅移动会来回振荡（实测过）。
     */
    var MOTION_FAST = {
      K: 60, A: 500, k: 60, amax: 300, vmax: 10,
      epsX: 0.0015, epsV: 0.02,
    };
    /** 松手落点外推时长（秒）：带着动量滑向它正要去的档位（"快滑跳过中间点"）。
     *  实测：这是指针速度的**连续函数**（v→0 时外推量→0），所以**不需要任何门槛**；
     *  1489 组样本中外推改变落点时 100% 顺着运动方向。速度抖动用 EMA 平滑即可。 */
    /** 松手外推时长（秒）。
     *  ⚠️ 实测诊断结论（两份 trace）：**任何非零外推都可能把落点推到另一档** ——
     *    指针可以停在档位区间内的任何位置（例如 31.3% 属于档位 1），
     *    而 0.04s × 最大指针速度(6/s) = 0.24，远大于"到区间边界的距离"，
     *    于是 releaseIndexFor 落到**档位 0**：滑条滑到 0% 后再跳回本体的 33.3% = 抽搐。
     *    预览页手感好，正是因为它的 vPtr 基本为 0（= 不外推）。
     *    故置 0（灵敏度关闭）；要重新启用惯性，必须先解决"外推不得跨档"。 */
    var RELEASE_PROJECT_S = 0;
    /** 指针速度 EMA 系数：防抖（松手瞬间鼠标微抖会让 vPtr 跳变）。非门槛。 */
    var POINTER_SPEED_EMA = 0.4;
    /**
     * 指针速度的"保鲜期"（秒）：超过这段时间没有新的 pointermove，就认为指针已停。
     * 2 帧 ≈ 33ms —— 足够容忍 60Hz 的 pointermove 间隔，又能及时判定"停住"。
     */
    var POINTER_STALE_S = 2 / 60;
    /** 指针速度陈旧后的衰减时间常数（秒）。30ms 实测：停住后偏移从 13.33% 降到 0.08%。 */
    var POINTER_SPEED_TAU = 0.03;
    /** 单帧 dt 上限（秒）：切标签/卡顿后回来时不要一帧跳一大段。 */
    var MAX_FRAME_DT = 0.05;

    function clampAbs(value, limit) {
      if (value > limit) return limit;
      return value < -limit ? -limit : value;
    }

    /**
     * 运动引擎单步演化（纯函数，原地修改 m，返回 m）。
     * 抽成纯函数是为了让测试能**注入固定 dt 精确断言**（零过冲/精确落点/收敛），
     * 不依赖真实时钟。
     *
     * @param m  { x, v, a, target } —— a 只是"本帧算出的加速度"，便于断言与调试
     * @param dt 秒
     * @param p  参数组（MOTION / MOTION_REDUCED）
     */
    function motionStep(m, dt, p) {
      // 1) 由**位置误差**算出「期望速度」——两个映射取小：
      //    · K·|e|        ：线性"位置→速度"映射，**这是为连续力律设计的**
      //    · √(2·A·|e|)   ：刹车预测上限（"以当前距离最多还能多快"）
      //    · vmax         ：硬上限
      var e = m.target - m.x;
      var vAbs = p.K * Math.abs(e);
      var brake = Math.sqrt(2 * p.A * Math.abs(e));
      if (brake < vAbs) vAbs = brake;
      if (vAbs > p.vmax) vAbs = p.vmax;
      var vDesired = e > 0 ? vAbs : (e < 0 ? -vAbs : 0);
      // 2) 由**速度差**算出加速度（连续跟踪）
      m.a = clampAbs(p.k * (vDesired - m.v), p.amax);
      // 3) 积分
      m.v = clampAbs(m.v + m.a * dt, p.vmax);
      // 3b) **防过冲**（issue #12 的另一半）：这一帧按速度要走出的位移如果已经 ≥ 剩余距离，
      //     说明目标就在这一帧之内 —— 直接精确落在目标上。
      //     否则帧量化会让人冲到目标外侧再弹回来（实测快速档回弹 3.33%，视频里只有 ±1%）。
      if (e !== 0 && Math.abs(m.v * dt) >= Math.abs(e)) {
        m.x = m.target;
        m.v = 0;
        m.a = 0;
        return m;
      }
      var xRaw = m.x + m.v * dt;
      var xClamped = xRaw < 0 ? 0 : (xRaw > 1 ? 1 : xRaw);
      // 4) 边界：位置夹住时**必须同时停住朝外的速度**，否则会在端点顶住抖动
      if (xClamped !== xRaw && ((xClamped === 0 && m.v < 0) || (xClamped === 1 && m.v > 0))) {
        m.v = 0;
        m.a = 0;
      }
      m.x = xClamped;
      // 5) 收口：到位时对齐目标（消除浮点残差，否则帧循环会为 1e-6 一直转）
      if (motionSettled(m, p)) { m.x = m.target; m.v = 0; m.a = 0; }
      return m;
    }

    /** 是否已到位（位置与速度都足够小）→ 可以停掉帧循环，不空转。 */
    function motionSettled(m, p) {
      return Math.abs(m.target - m.x) < p.epsX && Math.abs(m.v) < p.epsV;
    }

    /**
     * 指针速度的**陈旧衰减**（纯函数）。
     *
     * 为什么还需要它：`vPtr` 只在 `pointermove` 里更新，而**指针停下后不再有事件** ——
     * 它会永久冻结在最后一个速度值上。`vPtr` 现在**不参与运动演化**
     * （本版运动律只看 x 与 v，没有前馈项），但**松手落点外推**仍在用它：
     *
     *     落点 = 松手位置 + vPtr × 0.08s
     *
     * 若 vPtr 陈旧，指针明明已经停住，松手却会按旧速度多推一段（实测残留 vPtr=2
     * 会多推 16% 行程、vPtr=3 多推 24%）—— 4 档模型间距 33%，足以**落错档**。
     *
     * 修法：距上次 pointermove 超过 `staleS` 后按 `tau` 指数衰减到 0。
     *
     * ⚠️ 历史：在更早的"弹簧阻尼 + 前馈"版里，陈旧的 vPtr 危害**大得多** ——
     * 前馈项 `2ζω(vPtr − v)` 会变成一个**恒定的力**，把滑块永久推到鼠标一侧
     * （实测停在右侧 13.33%），而且让到位判定永不成立、帧循环空转烧 CPU
     * （实测 2 万帧仍未收敛）。本版运动律不含前馈项，那一整类问题从机理上消失。
     *
     * @param vPtr    上次算出的指针速度
     * @param sinceS  距上次 pointermove 的秒数
     */
    function decayPointerSpeed(vPtr, sinceS, staleS, tau) {
      if (!(sinceS > staleS)) return vPtr;
      return vPtr * Math.exp(-(sinceS - staleS) / tau);
    }

    /**
     * 松手落点：目标位置 + 指针速度 × 外推时长 → 最近档位。
     * 无门槛 —— 外推量随速度连续趋于 0，慢拖天然不受影响。
     */
    function releaseIndexFor(targetPct, vPtr, count) {
      return indexFromPct(clamp01(targetPct + vPtr * RELEASE_PROJECT_S), count);
    }

    /** rAF 适配：真机走 requestAnimationFrame；测试台/无 rAF 环境降级到 setTimeout。
     *  ⚠️ 降级**必须用裸 setTimeout**：实测测试台的 window 桩里没有 setTimeout
     *  （写 window.setTimeout 会 TypeError）；也不能写裸 requestAnimationFrame
     *  （Node 没有这个全局，直接 ReferenceError 让整包挂掉）。 */
    function scheduleFrame(cb) {
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        return { raf: true, id: window.requestAnimationFrame(cb) };
      }
      return { raf: false, id: setTimeout(function () { cb(nowMs()); }, 16) };
    }
    function cancelFrame(handle) {
      if (!handle) return;
      if (handle.raf) {
        if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(handle.id);
        }
      } else {
        clearTimeout(handle.id);
      }
    }
    /** 单调时钟（performance.now 在真机与测试台都可用；退回 Date.now）。 */
    function nowMs() {
      return (typeof performance !== "undefined" && typeof performance.now === "function")
        ? performance.now() : Date.now();
    }

    function errorText(error) {
      if (error === null || error === undefined) return "档位切换失败";
      if (typeof error === "string") return error;
      if (typeof error.message === "string" && error.message.length > 0) return error.message;
      if (typeof error.code === "string" && error.code.length > 0) return error.code;
      return String(error);
    }

    /* ─────────────────── 最高档能量层：参数与强度曲线 ─────────────────── */

    /**
     * 星尘粒子（星星）：**全部由下标算出，不用随机数** —— 每次渲染完全一致、可离线断言。
     *
     * 形态 = 3px 圆点；运动 = 横穿整条轨道（右 → 左），**不消失**、没有上下飘动。
     *
     * 高度与相位**必须用两条互不相关的分配**：
     *   · 相位 = 黄金比低差异序列（任意前缀都铺得开，拖动时逐渐加星也不会挤）；
     *   · 高度 = **随机排列**的等距槽位（哈希排序，确定性），并与相位排名解耦。
     * 早期版本这两者取自同一个数 `frac((i+1)×φ)`，结果"越靠右的星越高"，22 颗排成
     * 一条斜线（用户实测反馈"太规整，再随机一点"；相关系数实测 0.999）。
     * 再挑一个满足最小间隔的盐值：**相位相邻**（会在轨道上一直并排走）的两颗
     * 高度至少差 `MIN_HEIGHT_SLOTS` 槽，避免并成一坨。
     */
    var PARTICLES = (function buildParticles() {
      var count = 22;
      var out = [];
      var i;
      for (i = 0; i < count; i += 1) {
        out.push({ y: 0, phase: (i + 1) * GOLDEN_RATIO % 1 });
      }
      // 相位排名：黄金比序列里排名相邻 = 在轨道上位置相邻
      var byPhase = [];
      for (i = 0; i < count; i += 1) byPhase.push(i);
      byPhase.sort(function (a, b) {
        return out[a].phase - out[b].phase;
      });
      // 高度槽：找一个满足"相位相邻至少差 MIN_HEIGHT_SLOTS 槽"的确定性随机排列
      var slots = null;
      for (var salt = 71; salt < 4000 && slots === null; salt += 1) {
        var candidate = [];
        for (i = 0; i < count; i += 1) candidate.push(i);
        candidate.sort(function (a, b) {
          var ha = starHash01(a, salt);
          var hb = starHash01(b, salt);
          return ha === hb ? a - b : ha - hb;
        });
        var ok = true;
        for (var k = 1; k < count && ok; k += 1) {
          if (Math.abs(candidate[k] - candidate[k - 1]) < MIN_HEIGHT_SLOTS) ok = false;
        }
        if (ok) slots = candidate;
      }
      if (slots === null) {
        // 兜底：步长 5 与 22 互质 → 一定是排列，且相邻槽恒差 5（≥ MIN_HEIGHT_SLOTS）
        slots = [];
        for (i = 0; i < count; i += 1) slots.push(i * 5 % count);
      }
      for (var rank = 0; rank < count; rank += 1) {
        out[byPhase[rank]].y = 8 + (slots[rank] / (count - 1)) * 84;
      }
      return out;
    })();

    /* 颜色常量与 ENERGY_* 都声明在文件上部的「尺寸与速率常量」块里（供 CSS 插值用），
       这里只放纯函数 —— 不要再重复声明，否则会出现"改一处漏一处"的双份真相。 */

    function mixColor(from, to, t) {
      var k = clamp01(t);
      return [
        Math.round(from[0] + (to[0] - from[0]) * k),
        Math.round(from[1] + (to[1] - from[1]) * k),
        Math.round(from[2] + (to[2] - from[2]) * k),
      ];
    }

    function rgbOf(color) {
      return "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
    }

    /** 位置 → 填充色（当前点的颜色，也就是渐变右端的颜色）。 */
    function fillColorFor(pct) {
      var t = clamp01(pct);
      if (t <= ENERGY_START) return rgbOf(COLOR_BLUE);
      if (t <= ENERGY_END) return rgbOf(mixColor(COLOR_BLUE, COLOR_VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START)));
      return rgbOf(mixColor(COLOR_VIOLET, COLOR_DEEP, (t - ENERGY_END) / (1 - ENERGY_END)));
    }

    /**
     * 位置 → 填充层的背景：**左端恒为蓝，右端（旋钮处）是当前位置的颜色**。
     * 于是 high 档自然呈现"左蓝右紫"的渐变，越往右右端越深。
     */
    function fillBackgroundFor(pct) {
      return "linear-gradient(90deg, " + rgbOf(COLOR_BLUE) + ", " + fillColorFor(pct) + ")";
    }

    /**
     * 位置 → **官方那一行数值文字**（"Max"）的颜色。
     *
     * 与能量同源：蓝 → 紫罗兰，越往右越紫（用户要求"Max 的字体颜色能不能改变"）。
     * 刻意**不跟填充末尾的深紫走** —— `COLOR_DEEP` 当文字在深色底上几乎看不见；
     * 文字需要一个亮端，所以终点用 `COLOR_TEXT_VIOLET`。
     *
     * **Off 档返回空串**：不写内联色 = 官方原本的灰（用户要求"off 档两个界面都是灰的"）。
     * 调用方直接 `style.color = valueColorFor(...)`，空串在浏览器里就是"清掉内联色"。
     */
    function valueColorFor(pct, level) {
      if (isOffLevel(level)) return "";
      return rgbOf(mixColor(COLOR_BLUE, COLOR_TEXT_VIOLET, energyFor(pct)));
    }

    /**
     * 是不是"关闭推理"那一档。
     *
     * DeepSeek 的档位表是 id `off` / name `Off`（见 `dsh-llm-deepseek/lib/index.js` 的
     * `REASONING_EFFORTS`），但 id 是 provider 自己的字符串，所以 id 和 name 都认一遍，
     * 并额外接受几个同义写法。认不出就是普通档位（照常着色）。
     */
    function isOffLevel(level) {
      if (!level) return false;
      var candidates = [level.id, level.name];
      for (var i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] !== "string") continue;
        var flat = candidates[i].replace(/\s+/g, "").toLowerCase();
        if (flat === "off" || flat === "none" || flat === "关闭" || flat === "无") return true;
      }
      return false;
    }

    /**
     * 位置 → 能量强度 0..1（紫色星云 + 粒子的总强度）。
     * **纯位置驱动，与档位数无关**：第二档以前为 0（保持干净的蓝），之后线性渐入到最高档的 1。
     * 锚点：pct=1/3 → 0；pct=2/3（4 档模型的 high）→ 0.5；pct=1（max）→ 1。
     */
    function energyFor(pct) {
      return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START));
    }

    /**
     * 位置 → 粒子速率倍数。
     * 锚点来自实测反馈：**high 档（4 档模型的 2/3 处）= 1×（也就是现在这个速度刚刚好）**，
     * 最高档 = 2×。再往左按同一斜率降速，但设 0.35× 下限，免得左端变成静止。
     */
    function speedFor(pct) {
      return Math.min(2, Math.max(0.35, 3 * clamp01(pct) - 1));
    }

    /** 位置 → 可见粒子数（"粒子效果逐渐出现、变密集"）。 */
    function particleCountFor(pct) {
      return Math.round(energyFor(pct) * PARTICLES.length);
    }

    /* ── 星空：所有出现粒子的档位都用这一套（统一的动画）────────────────────

       运动模型：外层是一条**整轨宽度**的轨道，自己在做 `translate3d(-100%)` 的连续横穿；
       圆点在最右端出生、向左穿出，残影只在两端淡出（而那两端在可视区外）→ **从不消失**。
       每颗的亮度/大小由确定性伪随机给出（越亮越大，0.5~1），速率随**位置**变化（速度变化保留）。 */

    /** 确定性伪随机 [0,1)：不用 Math.random（可离线断言、重渲染不跳变），但看起来是随机的。 */
    function starHash01(index, salt) {
      var value = (index + 1) * salt * 2654435761 % 4294967296;
      return ((value >>> 8) % 1000) / 1000;
    }

    /** 第 index 颗粒子的亮度/大小系数，落在 [STARFIELD_MIN, 1]（越亮越大）。 */
    function starBrightnessFor(index) {
      return STARFIELD_MIN + (1 - STARFIELD_MIN) * starHash01(index, 61);
    }

    /**
     * 第 index 颗粒子横穿整条轨道的时长（s）。
     * **保留速度随位置变化**：以 speedFor 上限（MAX 档）对齐基准时长 ——
     * MAX 档 1.5s、high 档（1×）3s、左端（0.35×）约 8.6s；各星之间只差 ±8%（防追尾成团）。
     */
    function starDurationFor(index, speedFactor) {
      var speed = Math.min(MAX_SPEED_FACTOR, Math.max(0.35, typeof speedFactor === "number" ? speedFactor : MAX_SPEED_FACTOR));
      var spread = 1 - STARFIELD_DURATION_SPREAD + 2 * STARFIELD_DURATION_SPREAD * starHash01(index, 29);
      return STARFIELD_DURATION_MEAN * MAX_SPEED_FACTOR / speed * spread;
    }

    /**
     * 第 index 颗粒子的相位（负延迟，单位 s）。
     *
     * 相位用**黄金比低差异序列**铺开，而且**只跟 index 有关、跟当前显示几颗无关** ——
     * 这一点很关键：如果按 `i / 当前数量` 算，拖动过程中粒子数变化会让每颗已挂载动画的
     * `animation-delay` 被改写，按规范当前进度会按新起始时间重算，整片星空就会抖一下/重排一次。
     * 低差异序列还有个好处：**任意前缀**（前 N 颗）本身就是均匀铺开的。
     */
    function starDelayFor(index, duration) {
      var particle = PARTICLES[index];
      var phase = particle && typeof particle.phase === "number" ? particle.phase : 0;
      var jitter = starHash01(index, 53) * 0.03; // 一点点抖动，避免看起来像整齐的队列
      return -((phase + jitter) % 1) * duration;
    }

    /** 位置 → 可见星星数（"逐渐出现、变密集"）。 */
    function starCountFor(pct) {
      return particleCountFor(pct);
    }

    /**
     * 位置 → **星星层**的不透明度。
     *
     * 星星不能跟着星云一起淡入：星云层的透明度 = 能量强度，high 档只有 0.5，
     * 那么每颗星的实际不透明度会被压到 0.25~0.5，在紫色底上几乎看不见
     * （用户实测反馈："high 档一打开几乎没粒子"）。所以星星层单独给一个下限，
     * 只随能量轻微变化：high 档 0.8、MAX 档 1.0 —— "逐渐出现"交给**粒子数**去表达。
     */
    function starLayerOpacityFor(pct) {
      return 0.6 + 0.4 * energyFor(pct);
    }

    /**
     * 旋钮中心 / 填充终点 / 刻度的水平位置：`半径 + pct × (100% − 直径)`。
     * 这样 pct=0 时圆心正好落在左端圆角内、pct=1 时落在右端圆角内 —— 圆圈永远是完整的圆。
     */
    function knobOffsetOf(pct) {
      var t = Math.round(clamp01(pct) * 10000) / 10000;
      return "calc(" + KNOB_RADIUS + "px + " + t + " * (100% - " + KNOB_RADIUS * 2 + "px))";
    }

    /* ═════════════════ 官方目录访问（每会话一个，永不抛错）═════════════════ */

    /**
     * 每个会话一个访问器。它解决两件真实存在的事：
     *  1. `directoryFor(sessionId)` 在会话作用域/绑定尚未就绪时**按设计抛错**；
     *  2. 目录实例可能被重建（换模型代、连接重置），"抓一次揣着用"会变成永久坏的控件。
     * 所以每次读写都重新解析，解析失败就退避重试；订阅在一次成功解析后建立。
     */
    function createDirectoryAccess(ctx, sessionId, timers) {
      var listeners = new Set();
      var directory = null;
      var unsubscribe = null;
      var last = EMPTY_SNAPSHOT;
      var retryIndex = 0;
      var retryTimer = null;
      var closed = false;
      var lastLoadAt = 0;

      function notify() {
        var current = [];
        listeners.forEach(function (listener) { current.push(listener); });
        for (var i = 0; i < current.length; i += 1) {
          try { current[i](); } catch (error) { /* 单个订阅者抛错不影响其它订阅者 */ }
        }
      }

      function scheduleRetry() {
        if (closed || retryTimer !== null || retryIndex >= RETRY_DELAYS.length) return;
        var delay = RETRY_DELAYS[retryIndex];
        retryIndex += 1;
        retryTimer = timers.set(function () {
          retryTimer = null;
          // 解析成功后要主动通知一次：调用方（uSES）正等着 store 出现。
          if (resolve() !== null) {
            notify();
            return;
          }
          // 还没就绪就继续退避 —— 少了这一句，第一次重试失败后自愈链就永久断掉，
          // 控件会静默失效（这正是要防的那种"一次启动期抖动变成永久坏控件"）。
          scheduleRetry();
        }, delay);
      }

      /** 重新解析一次目录；实例变化时重挂订阅。返回当前目录（可能为 null）。 */
      function resolve() {
        if (closed) return null;
        var fresh = null;
        try {
          fresh = ctx.modelDirectories.directoryFor(sessionId);
        } catch (error) {
          fresh = null;
        }
        if (!fresh || !fresh.store || typeof fresh.store.getSnapshot !== "function") fresh = null;
        if (fresh === directory) return directory;
        if (unsubscribe !== null) {
          try { unsubscribe(); } catch (error) { /* 退订失败不影响新订阅 */ }
          unsubscribe = null;
        }
        directory = fresh;
        if (directory !== null) {
          retryIndex = 0;
          try {
            unsubscribe = typeof directory.store.subscribe === "function" ? directory.store.subscribe(notify) : null;
          } catch (error) {
            unsubscribe = null;
          }
          kickLoad();
        }
        return directory;
      }

      /** 主动拉一次目录（不 load 的话 store 停在 idle，档位列表是空的）。 */
      function kickLoad() {
        if (closed || directory === null || typeof directory.load !== "function") return;
        var now = Date.now();
        if (now - lastLoadAt < 400) return;
        lastLoadAt = now;
        var target = directory;
        try {
          Promise.resolve(target.load()).catch(function () { /* 失败原因由 store 的 error 字段呈现 */ });
        } catch (error) {
          /* load 同步抛：同样交给 store 状态 */
        }
      }

      return {
        getSnapshot: function () {
          if (closed) return EMPTY_SNAPSHOT;
          if (directory === null) {
            resolve();
            if (directory === null) scheduleRetry();
          }
          if (directory !== null) {
            try {
              var value = directory.store.getSnapshot();
              if (value && typeof value === "object") last = value;
            } catch (error) {
              /* 保留上一次快照，绝不把渲染打崩 */
            }
          }
          return last;
        },
        subscribe: function (listener) {
          if (closed) return function () {};
          listeners.add(listener);
          if (directory === null) {
            resolve();
            if (directory === null) scheduleRetry();
          }
          // StrictMode 会订阅/退订各跑一次；退订只清订阅，不永久关闭访问器。
          return function () {
            listeners.delete(listener);
          };
        },
        /** 取当前真正可写的目录（load/select 在调用时重新解析，避免用失效实例）。 */
        directory: function () {
          var fresh = resolve();
          return fresh !== null ? fresh : directory;
        },
        load: kickLoad,
        dispose: function () {
          closed = true;
          listeners.clear();
          if (retryTimer !== null) {
            try { timers.clear(retryTimer); } catch (error) { /* 忽略 */ }
            retryTimer = null;
          }
          if (unsubscribe !== null) {
            try { unsubscribe(); } catch (error) { /* 忽略 */ }
            unsubscribe = null;
          }
          directory = null;
        },
      };
    }

    /* ══════════ 官方菜单那一行的 DOM 桥（只动那一行，fail-open）══════════ */

    function firstSpanText(row) {
      try {
        var spans = row.querySelectorAll("span");
        for (var i = 0; i < spans.length; i += 1) {
          var text = spans[i].textContent;
          if (typeof text === "string" && text.length > 0) return text;
        }
      } catch (error) {
        /* 认不出就算了，调用方会退到结构判定 */
      }
      return "";
    }

    /**
     * 官方那一行右侧的**数值文字**（"Max" / "High"）—— 就是 `.cellValue` 那个 span。
     * 找不到 class 时退到结构：行内最后一个非空文字的 span（数值在标签之后、箭头之前）。
     * 只改它的颜色，文字内容一律不碰。
     */
    function findValueElement(row) {
      if (!row || typeof row.querySelectorAll !== "function") return null;
      try {
        var byClass = row.querySelectorAll("span[class*='cellValue']");
        if (byClass.length > 0) return byClass[byClass.length - 1];
        var spans = row.querySelectorAll("span");
        var found = null;
        for (var i = 0; i < spans.length; i += 1) {
          var text = spans[i].textContent;
          if (typeof text === "string" && text.replace(/\s+/g, "").length > 0) found = spans[i];
        }
        return found;
      } catch (error) {
        return null;
      }
    }

    /**
     * **收起的模型席按钮**（"DeepSeek-V41-Flash  High  ⌄"）里只显示档位名的那一小段文字。
     *
     * 官方渲染它用的是哈希 class（`wq12jW_triggerEffort`，前缀随构建变），靠 class 认迟早会失效，
     * 所以按**文字**认：官方 trigger 里的档位文字就是档位的 `name`，和我们从目录读到的是同一份数据。
     *
     * 传**全部档位名**（而不是只要当前那个）：档位刚切换、官方还没重渲染席按钮时，
     * 文字还是旧档位名 —— 只认当前名字会在那一瞬间"放手"，颜色闪一下。
     * 认不出任何已知档位名就返回 null（fail-open，绝不动别的文字）。
     */
    function findSeatEffort(doc, composer, expectedLabels) {
      if (!doc || !composer || typeof doc.querySelectorAll !== "function") return null;
      var list = typeof expectedLabels === "string" ? [expectedLabels] : expectedLabels;
      if (Object.prototype.toString.call(list) !== "[object Array]") return null;
      var wanted = [];
      for (var n = 0; n < list.length; n += 1) {
        var name = typeof list[n] === "string" ? list[n].replace(/\s+/g, "") : "";
        if (name.length > 0 && wanted.indexOf(name) < 0) wanted.push(name);
      }
      if (wanted.length === 0) return null;
      try {
        var seats = doc.querySelectorAll('button[aria-haspopup="menu"]');
        for (var i = 0; i < seats.length; i += 1) {
          if (!composer.contains(seats[i])) continue;
          var spans = seats[i].querySelectorAll("span");
          for (var j = 0; j < spans.length; j += 1) {
            var text = spans[j].textContent;
            if (typeof text === "string" && wanted.indexOf(text.replace(/\s+/g, "")) >= 0) return spans[j];
          }
        }
      } catch (error) {
        return null;
      }
      return null;
    }

    /**
     * 在自己所属的 composer 里，找到"打开的那颗官方模型席"对应的菜单，再找到推理等级那一行。
     * 全部用官方**语义属性**（aria-haspopup / aria-expanded / aria-controls / role）定位，
     * 不依赖哈希 class —— 官方改样式不会影响这里，改语义才会（那种改动会先在我的测试里炸掉）。
     */
    function findEffortRow(doc, composer) {
      if (!doc || !composer || typeof doc.querySelectorAll !== "function") return null;
      var seats = doc.querySelectorAll('button[aria-haspopup="menu"][aria-expanded="true"]');
      var seat = null;
      for (var i = 0; i < seats.length; i += 1) {
        if (composer.contains(seats[i])) { seat = seats[i]; break; }
      }
      if (seat === null) return null;

      var menuId = typeof seat.getAttribute === "function" ? seat.getAttribute("aria-controls") : null;
      var menu = menuId && typeof doc.getElementById === "function" ? doc.getElementById(menuId) : null;
      if (!menu) return null;

      var items = menu.querySelectorAll('button[role="menuitem"]');
      if (items.length !== 2) return null; // 根面板恰好两行；子面板用的是 menuitemradio
      for (var j = 0; j < items.length; j += 1) {
        var label = firstSpanText(items[j]);
        for (var k = 0; k < EFFORT_ROW_LABELS.length; k += 1) {
          if (label === EFFORT_ROW_LABELS[k]) return items[j];
        }
      }
      // 文案认不出（官方改了措辞/别的语言）就按官方固定顺序：第 2 个 menuitem 是推理等级。
      return items[1];
    }

    /**
     * 监听文档，把滑条容器挂进官方那一行。
     *
     * @param options.doc      宿主 document
     * @param options.win       宿主 window（派发 resize 让官方重测菜单位置）
     * @param options.anchor    () => 本会话在 composer 里的锚点元素（用来判定"哪颗席是我的"）
     * @param options.active    () => boolean，当前是否值得注入（没有档位就不注入，免得白加高）
     * @param options.onChange  (host | null) => void
     */
    function createMenuBridge(options) {
      var doc = options.doc;
      var win = options.win;
      var anchor = options.anchor;
      var active = options.active;
      var onChange = options.onChange;
      if (!doc || typeof doc.createElement !== "function") return null;

      var current = null;
      var seat = null; // 收起态那一行里的档位文字（菜单没打开时也要着色）
      var seatColor = ""; // 组件给的当前颜色：重新抓到元素时立刻补上，不必等下一次渲染
      var observer = null;
      var timer = null;
      var disposed = false;
      var seatLabels = options.seatLabels; // () => string[]，全部已知档位名

      /** 本会话的 composer 容器：从锚点往上找官方给 composer 卡片打的标记。 */
      function composerOf() {
        var node = anchor();
        if (!node) return null;
        var el = node;
        while (el && el.nodeType === 1) {
          if (typeof el.getAttribute === "function" && el.getAttribute("data-composer-card") !== null) return el;
          el = el.parentNode;
        }
        return null;
      }

      function detach() {
        if (current === null) return;
        var row = current.row;
        var container = current.container;
        try {
          if (container && container.parentNode) container.parentNode.removeChild(container);
        } catch (error) { /* 行可能已经被官方卸载 */ }
        try {
          var previous = current.previous;
          if (row && row.style) {
            row.style.height = previous.height;
            row.style.flexWrap = previous.flexWrap;
            row.style.paddingTop = previous.paddingTop;
            row.style.paddingBottom = previous.paddingBottom;
            row.style.boxShadow = previous.boxShadow;
          }
          // 数值文字（"Max"）的颜色也是我们改的，退出时一并还原
          if (current.value && current.value.style) current.value.style.color = previous.valueColor;
        } catch (error) { /* 还原失败不影响官方菜单自身 */ }
        current = null;
        onChange(null);
      }

      /** 收起的档位文字：还原本来的颜色并忘掉它。 */
      function releaseSeat() {
        if (seat === null) return;
        try {
          if (seat.el && seat.el.style) seat.el.style.color = seat.previousColor;
        } catch (error) { /* 元素可能已被官方卸载 */ }
        seat = null;
      }

      /**
       * 同步收起态的档位文字。
       * 只在**元素换了**（官方重渲染换了节点）或还没抓到时重新抓 —— 文字变了不换元素，
       * 所以档位切换不会造成"还原→再上色"的闪动。
       */
      function syncSeat() {
        var composer = composerOf();
        if (composer === null || active() !== true) { releaseSeat(); return; }
        if (seat !== null && seat.el && doc.documentElement && doc.documentElement.contains(seat.el)) {
          if (seatColor && seat.el.style) seat.el.style.color = seatColor; // 官方清过内联样式就补回来
          return;
        }
        releaseSeat();
        var wanted = typeof seatLabels === "function" ? seatLabels() : null;
        var el = findSeatEffort(doc, composer, wanted);
        if (el === null || !el.style) return;
        seat = { el: el, previousColor: el.style.color || "" };
        if (seatColor) el.style.color = seatColor;
      }

      function scan() {
        if (disposed) return;
        // 收起态的档位文字：跟菜单那一行互相独立，任一处失败都不该拖垮另一处
        try { syncSeat(); } catch (error) { /* 忽略 */ }
        try {
          var composer = composerOf();
          if (composer === null || active() !== true) { detach(); return; }
          // 已经挂好且那一行还在 → 什么都不做
          if (current !== null && current.row && doc.documentElement && doc.documentElement.contains(current.row)) return;

          var row = findEffortRow(doc, composer);
          if (row === null) { detach(); return; }
          detach();

          var value = findValueElement(row);
          var previous = {
            // 真实 DOM 里未设置的内联属性读作 ""，这里统一成同样的语义，还原时才不会写回
            // 字面量 "undefined"（那在浏览器里是无效值，会把我们的加高留在原地）。
            height: row.style.height || "",
            flexWrap: row.style.flexWrap || "",
            paddingTop: row.style.paddingTop || "",
            paddingBottom: row.style.paddingBottom || "",
            boxShadow: row.style.boxShadow || "",
            // 数值文字原来的内联颜色（通常没设过，读作 ""）
            valueColor: value && value.style ? value.style.color || "" : "",
          };
          // 「加高那一栏的上下距离」+ 允许折行，让滑条落到第二行并铺满整行宽度。
          row.style.height = "auto";
          row.style.flexWrap = "wrap";
          row.style.paddingTop = ROW_PADDING_BLOCK;
          row.style.paddingBottom = ROW_PADDING_BLOCK;

          var container = doc.createElement("div");
          container.className = "ces-inline";
          container.setAttribute("data-ces-part", "host");
          row.appendChild(container);

          current = { row: row, container: container, value: value, previous: previous };
          onChange(current);

          // 官方菜单是"测量后固定定位"的，加高后让它重测一次（官方自己在 resize 里重测并夹取）。
          try {
            win.dispatchEvent(new win.Event("resize"));
          } catch (error) { /* 宿主没有 Event 构造器就算了，官方也会在状态变化时重测 */ }
        } catch (error) {
          try { detach(); } catch (inner) { /* 兜到底 */ }
        }
      }

      function start() {
        scan();
        var MO = win && (win.MutationObserver || (typeof MutationObserver === "function" ? MutationObserver : null));
        if (typeof MO === "function") {
          try {
            observer = new MO(function () { scan(); });
            observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
            return;
          } catch (error) {
            observer = null;
          }
        }
        // 没有 MutationObserver 时退化成低频轮询；反正每轮都很便宜。
        if (win && typeof win.setInterval === "function") timer = win.setInterval(scan, 400);
      }

      return {
        scan: scan,
        start: start,
        /** 组件把当前该用的颜色给进来；桥负责在（重新）抓到元素时立刻应用。 */
        setSeatColor: function (color) {
          seatColor = typeof color === "string" ? color : "";
          if (seat !== null && seat.el && seat.el.style) {
            try { seat.el.style.color = seatColor; } catch (error) { /* 忽略 */ }
          }
        },
        dispose: function () {
          disposed = true;
          if (observer !== null) {
            try { observer.disconnect(); } catch (error) { /* 忽略 */ }
            observer = null;
          }
          if (timer !== null) {
            try { win.clearInterval(timer); } catch (error) { /* 忽略 */ }
            timer = null;
          }
          releaseSeat();
          detach();
        },
        host: function () { return current; },
      };
    }

    /* ════════════════════════════ 组件 ════════════════════════════ */

    /**
     * 单组件设计：锚点 + 桥 + 滑条（portal 进官方那一行）都在同一个函数里，
     * 所有 hook 都在同一个实例上，展开/收起不会改变 hook 顺序。
     */
    function CodexEffortSlider(props) {
      var sessionId = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId : null;
      var locked = props.locked === true;
      var ctx = props.__ctx;

      /* ⚠️⚠️ 本插件的三种动画**完全不受系统「减少动态效果」影响**（用户明确要求）。
         所以：reducedMotion 恒为 false —— 作者原本的"减少动态 → jumpTo"分支全部成为死代码；
         动画强度只由设置里的 motion 决定（quick = 简洁 / full = 完整 / fast = 快速·Codex 手感）。 */
      /* ⚠️⚠️ 唯一实例守卫 —— 实测这个插件会被**加载两次**（两份模块、两个滑条组件），
         两份引擎的 draft 会渲染进官方同一行、互相打架 → 视觉上"松手乱跳"，
         而且只在**重启**后出现（热重载时只有一份，所以手感正常）。
         只允许第一份活着的实例渲染；其余返回 null。
         ⚠️ Hooks 顺序：判定只做一次且永不改变（__cesDecided），所以每个实例的 Hook 数量恒定。 */
      var __slotWin = (typeof window !== "undefined") ? window : null;
      if (!__cesDecided && __slotWin) {
        __cesDecided = true;
        if (__slotWin.__cesActiveSliderOwner == null) {
          __slotWin.__cesActiveSliderOwner = __cesOwnerToken;
          __cesIsOwner = true;
        }
      } else if (!__slotWin) {
        __cesDecided = true;
        __cesIsOwner = true;
      }
      if (__cesIsOwner) {
        // 只有 owner 会调用这个 effect（非 owner 在下面直接 return null，不调用任何 Hook）
        React.useEffect(function () {
          return function () {
            if (typeof window !== "undefined" && window.__cesActiveSliderOwner === __cesOwnerToken) {
              window.__cesActiveSliderOwner = null;   // 释放，让后来的一份还能接管
            }
          };
        }, []);
      } else {
        return null;
      }

      /** 本组件实例的编号（诊断）。 */
      var __cesInstanceId = (window.__cesInstanceSeq = (window.__cesInstanceSeq || 0) + 1);
      var reducedMotion = false;
      /** 只用于观感（星尘放缓 / 提示文案 / data-motion），取值来自设置。 */
      var effectiveReducedMotion = motionMode() === "quick";

      var settingsTick = React.useState(0);
      React.useEffect(function () {
        installSettingsUi();
        var bump = function () { settingsTick[1](function (n) { return n + 1; }); };
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
          window.addEventListener(settingsEventName(), bump);
        }
        return function () {
          if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
            window.removeEventListener(settingsEventName(), bump);
          }
        };
      }, []);

      /** 拖动安全网用的按键状态（pointerup 只挂在轨道上，轨道外松开时会丢事件）。 */
      var buttonDownRef = React.useRef(false);
      /** 当前渲染下的"已生效档位"百分比（循环闭包要读最新值，不能用闭包变量）。 */
      var effectivePctRef = React.useRef(0);
      /** 吸附完成后为等提交追上而多持有显示的帧数（兜底上限）。 */
      var holdFramesRef = React.useRef(0);
      /** 上一次"已写回宿主"的档位下标：拖动时只在**跨过档位边界**的那一刻写一次。 */
      var lastCommittedIndexRef = React.useRef(-1);
      /** 松手提交重试的代次：每次按下拖动就 +1，旧重试立即作废（绝不能覆盖新操作）。 */
      var releaseGenRef = React.useRef(0);
      /** 最近一次**有效**档位下标：档位列表暂时为空时的显示兜底（绝不用 0）。 */
      var lastValidIndexRef = React.useRef(0);
      /** 本次渲染解析出的档位列表：`endDrag` 这类"长寿闭包"必须读 ref，不能读闭包变量。 */
      var levelsRef = React.useRef([]);
      /**
       * 最新一版的 `endDrag`。
       * 窗口级 pointerup 安全网只在**挂载时**绑定一次；如果它直接调用闭包里的 `endDrag`，
       * 用的就永远是**首次渲染**的那份闭包 —— 而首渲染时 `levelCount` 还是 0 ✗，
       * 于是每次松手都走 `release-abort` → 不写回 → 显示交还旧档位 = 用户说的"点一下顿一下"。
       * 诊断证据：`{"k":"endDrag-enter","inst":1,…}` 后面紧跟 `release-abort levelCount=0`。
       */
      var endDragRef = React.useRef(null);
      /** 快速动画的"当前停在第几格"（-1 = 还没对齐过）。 */
      var detentIndexRef = React.useRef(-1);
      React.useEffect(function () {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        var stopDrag = function () {
          buttonDownRef.current = false;
          // ⚠️ 必须调用**最新**的 endDrag：这个监听只绑定一次，闭包里的 endDrag 是首渲染的旧版本。
          if (draggingRef.current && typeof endDragRef.current === "function") endDragRef.current();
        };
        window.addEventListener("pointerup", stopDrag, true);
        window.addEventListener("pointercancel", stopDrag, true);
        return function () {
          window.removeEventListener("pointerup", stopDrag, true);
          window.removeEventListener("pointercancel", stopDrag, true);
        };
      }, []);

      var access = React.useMemo(
        function () {
          if (sessionId === null || !ctx) return null;
          return createDirectoryAccess(ctx, sessionId, {
            set: function (fn, delay) { return setTimeout(fn, delay); },
            clear: function (handle) { clearTimeout(handle); },
          });
        },
        [ctx, sessionId],
      );

      React.useEffect(function () {
        return function () {
          if (access !== null) access.dispose();
        };
      }, [access]);

      var subscribe = React.useCallback(
        function (onChange) { return access === null ? function () {} : access.subscribe(onChange); },
        [access],
      );
      var getSnapshot = React.useCallback(
        function () { return access === null ? EMPTY_SNAPSHOT : access.getSnapshot(); },
        [access],
      );
      var state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      var liveLevels = levelsOf(state);
      // 模型身份：缓存的有效性判断（provider + model 变了就不复用缓存）。
      var liveLevelKey = (state && state.current && typeof state.current.provider === "string" && typeof state.current.model === "string")
        ? state.current.provider + "\u0000" + state.current.model
        : null;
      var levels = resolveLevels(liveLevels, liveLevelKey, __levelsCache);
      // 只在"活列表为空、靠缓存兜底"时记一笔（正常渲染不刷屏）
      var levelsCacheUsed = liveLevels.length === 0 && levels.length > 0;
      if (levelsCacheUsed !== __levelsCacheHit) {
        __levelsCacheHit = levelsCacheUsed;
        tracePush({ k: "levels-cache", hit: levelsCacheUsed, n: levels.length, emptyLive: liveLevels.length === 0 });
      }
      var effectiveId = effectiveEffortId(state);
      var committedIndex = indexOfLevel(levels, effectiveId);
      var levelCount = levels.length;

      var draftState = React.useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var optimisticState = React.useState(null);
      var optimistic = optimisticState[0];
      var setOptimistic = optimisticState[1];
      var errorState = React.useState(null);
      var errorText_ = errorState[0];
      var setError = errorState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var hostState = React.useState(null);
      var host = hostState[0];
      var setHost = hostState[1];

      var anchorRef = React.useRef(null);
      var trackRef = React.useRef(null);
      var optimisticIdRef = React.useRef(null);
      /** 拖动的"最新位置"放 ref：React 会把同一 tick 的多次 setState 合并，
       *  松手那一帧若从 state 读位置，可能读到上一次渲染的旧值，从而写错档位。 */
      var draftRef = React.useRef(null);
      var commitRef = React.useRef({ timer: null, inFlight: false, queued: null, safetyTimer: null });
      var draggingRef = React.useRef(false);
      var levelCountRef = React.useRef(0);
      var seatNamesRef = React.useRef([]); // 全部已知档位名（认官方席按钮上的那段文字用）
      var bridgeRef = React.useRef(null);
      levelCountRef.current = levelCount;
      // 每次渲染都把"最新"的档位列表与 endDrag 放进 ref（供窗口安全网等长寿闭包读取）
      levelsRef.current = levels;
      endDragRef.current = endDrag;

      /* 桥：找到官方菜单那一行，把滑条容器挂进去 */
      React.useEffect(function () {
        if (sessionId === null || !ctx) return undefined;
        var bridge = createMenuBridge({
          doc: typeof document === "undefined" ? null : document,
          win: typeof window === "undefined" ? null : window,
          anchor: function () { return anchorRef.current; },
          active: function () { return levelCountRef.current > 0; },
          onChange: function (next) { setHost(next); },
          // 收起态那一行显示的档位名（官方 trigger 里的文字就是它）；给全部名字更抗"官方还没重渲染"
          seatLabels: function () { return seatNamesRef.current; },
        });
        if (bridge === null) return undefined;
        bridgeRef.current = bridge;
        bridge.start();
        return function () {
          bridgeRef.current = null;
          bridge.dispose();
        };
      }, [ctx, sessionId]);

      /**
       * 档位是**后到**的（目录 load 完才有 efforts）。那时 DOM 没有任何变化，
       * MutationObserver 不会响，所以这里在档位数变化时主动重扫一次 ——
       * 少了这一句，"目录晚到"会让滑条永远挂不上去（起步期抖动变永久失效）。
       */
      React.useEffect(function () {
        if (bridgeRef.current !== null) bridgeRef.current.scan();
      }, [levelCount]);

      // 乐观值：提交后先按用户选的那一档显示，直到宿主真实回报（或超时回滚）。
      var optimisticId = optimistic !== null && typeof optimistic.id === "string" ? optimistic.id : null;
      var optimisticIndex = optimisticId === null ? -1 : indexOfLevel(levels, optimisticId);

      // **已生效**的档位（乐观值优先，其次真实值）：收起态那一行显示的是它，不是拖动中的草稿。
      // ⚠️ 兜底**绝不能用 0**：档位列表暂时为空/未就绪时，用"最近一次有效档位"。
      //    用 0 会让显示瞬间跳到最左（实测就是"闪回最左边"那一下）。
      if (committedIndex >= 0) lastValidIndexRef.current = committedIndex;
      // 兜底优先级：①最近一次有效档位（且仍落在当前列表范围内）②当前档位数的正中（issue #6 的约定）。
      // 绝不默认 0（0 = 最左 / off，看起来就是"显示错档位"）。
      var midIndex = Math.max(0, Math.min(Math.max(0, levelCount - 1), Math.floor((levelCount - 1) / 2)));
      var lastIdx = lastValidIndexRef.current;
      var fallbackIndex = (typeof lastIdx === "number" && lastIdx >= 0 && lastIdx < levelCount) ? lastIdx : midIndex;
      var effectiveIndex = committedIndex >= 0 ? committedIndex : fallbackIndex;
      if (optimisticIndex >= 0) effectiveIndex = optimisticIndex;
      var effectivePct = pctFromIndex(effectiveIndex, levelCount);
      effectivePctRef.current = effectivePct;
      var effectiveLevel = levels[effectiveIndex] || null;
      // 席按钮上可能出现的是**任意一个档位名**（档位刚切换时官方还没重渲染）
      var seatNames = [];
      for (var n = 0; n < levels.length; n += 1) {
        if (levels[n] && typeof levels[n].name === "string" && levels[n].name.length > 0) seatNames.push(levels[n].name);
      }
      seatNamesRef.current = seatNames;

      // 显示用的档位：拖动中跟着草稿，否则就是已生效那一档。
      var shownIndex = draft !== null ? draft.index : effectiveIndex;
      var shownPct = draft !== null && typeof draft.pct === "number" ? draft.pct : effectivePct;
      // 诊断：万一出现"松手抽搐"，用它一眼看出哪一帧、哪个值跳了
      tracePush({ k: "s", inst: __cesInstanceId, t: (typeof performance !== "undefined" ? Math.round(performance.now()) : 0), shown: Math.round(shownPct * 10000) / 10000, eff: Math.round(effectivePct * 10000) / 10000, draft: draft === null ? null : Math.round(draft.pct * 10000) / 10000, mode: motionMode() });
      var shownLevel = levels[shownIndex] || null;

      // 三个由**位置**连续驱动的量：填充色（蓝→紫→深紫）、能量强度（星云+星星渐入）、位置速率。
      var energy = energyFor(shownPct);
      var energyOn = energy > 0;
      var fillBackground = fillBackgroundFor(shownPct);
      var knobOffset = knobOffsetOf(shownPct);

      // 官方那一行在最高档时描一圈紫边，强度跟着能量走（写内联样式，退出时由桥还原）。
      React.useEffect(function () {
        if (host === null || !host.row || !host.row.style) return;
        host.row.style.boxShadow = energyOn
          ? "inset 0 0 0 1px rgba(168,85,247," + (0.16 + 0.34 * energy).toFixed(2) + ")"
          : "";
      }, [host, energyOn, energy]);

      // 官方那一行的**数值文字**（"Max"）也跟着位置变色：蓝 → 亮紫（用户要求）。
      // 同样写内联、退出时由桥还原；**只改颜色，文字内容一个字都不碰**。
      React.useEffect(function () {
        if (host === null || !host.value || !host.value.style) return;
        host.value.style.color = valueColorFor(shownPct, shownLevel);
      }, [host, shownPct, shownLevel]);

      // **收起态**那一行的档位文字（模型席按钮上的 "High"，菜单没打开时就看得见）也跟着变色。
      // 颜色交给桥保管：官方重渲染换了节点时，桥会在重新抓到的那一刻补上，不必等 React。
      // 注意这里用**已生效**的档位（不是拖动中的草稿）—— 收起态显示的是真实档位。
      React.useEffect(function () {
        if (bridgeRef.current === null) return;
        bridgeRef.current.setSeatColor(valueColorFor(effectivePct, effectiveLevel));
      }, [levelCount, effectivePct, effectiveLevel]);

      // 宿主追上乐观值 → 撤掉乐观态（此后以真实目录为准）。
      React.useEffect(function () {
        if (optimisticId !== null && effectiveId === optimisticId) setOptimistic(null);
      }, [effectiveId, optimisticId]);

      // 超时兜底：宿主迟迟不回报就回滚并说明，不继续假装已生效。
      React.useEffect(function () {
        if (optimisticId === null) return undefined;
        var handle = setTimeout(function () {
          if (optimisticIdRef.current === optimisticId) {
            optimisticIdRef.current = null;
            setOptimistic(null);
            setError("档位切换超时，宿主未回报结果（已回滚显示）");
          }
        }, COMMIT_DEADLINE_MS);
        return function () { clearTimeout(handle); };
      }, [optimisticId]);

      // 组件卸载：清掉降频定时器（否则会在卸载后写一次宿主）。
      React.useEffect(function () {
        return function () {
          var pending = commitRef.current;
          if (pending.timer !== null) {
            clearTimeout(pending.timer);
            pending.timer = null;
          }
          pending.queued = null;
        };
      }, []);

      function currentState() {
        return access === null ? EMPTY_SNAPSHOT : access.getSnapshot();
      }

      function flush() {
        var pending = commitRef.current;
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        var levelId = pending.queued;
        pending.queued = null;
        if (pending.safetyTimer !== null) { clearTimeout(pending.safetyTimer); pending.safetyTimer = null; }
        tracePush({ k: "flush", id: levelId });
        if (levelId === null || levelId === undefined || access === null) return;

        var snapshot = currentState();
        var current = snapshot && snapshot.current;
        if (!current || typeof current.provider !== "string" || typeof current.model !== "string") {
          setError("模型目录尚未就绪，无法写入档位");
          return;
        }
        // 发送前再判一次：可能宿主已经把这个档位写好了（去重的第二道闸）。
        if (effectiveEffortId(snapshot) === levelId) { tracePush({ k: "flush-skip", id: levelId, why: "dedupe" }); return; }

        var directory = access.directory();
        if (directory === null || typeof directory.select !== "function") {
          setError("模型目录不可用，档位未写入");
          return;
        }

        pending.inFlight = true;
        optimisticIdRef.current = levelId;
        setOptimistic({ id: levelId });
        setError(null);
        setBusy(true);

        var result;
        try {
          result = directory.select({
            provider: current.provider,
            model: current.model,
            reasoningEffort: levelId,
          });
        } catch (error) {
          result = Promise.reject(error);
        }

        Promise.resolve(result).then(
          function (outcome) {
            pending.inFlight = false;
            tracePush({ k: outcome && outcome.ok === false ? "commit-fail" : "commit-ok" });
            if (outcome && outcome.ok === false) {
              optimisticIdRef.current = null;
              setOptimistic(null);
              setError(errorText(outcome.error));
            }
          },
          function (error) {
            pending.inFlight = false;
            optimisticIdRef.current = null;
            setOptimistic(null);
            setError(errorText(error));
          },
        ).then(function () {
          setBusy(false);
          // 在途合并：拖动期间攒下的最新值在这里补发。
          tracePush({ k: "commit-settle", inFlight: pending.inFlight, queued: pending.queued });
          if (pending.queued !== null) flush();
        });
      }

      /** 请求写回某一档：同档位去重 + 在途合并 + 降频；immediate 用于松手/键盘。 */
      function requestCommit(levelId, immediate) {
        if (levelId === null || levelId === undefined) return;
        var pending = commitRef.current;
        var snapshot = currentState();
        if (effectiveEffortId(snapshot) === levelId && pending.queued === null && !pending.inFlight) return;
        pending.queued = levelId;
        tracePush({ k: "req", id: levelId, imm: immediate === true, inFlight: pending.inFlight, queued: pending.queued });
        if (pending.inFlight) {
          // ⚠️ 不能直接 return：那次在途的收尾可能**已经**跑完了（微任务早于本次同步调用），
          //    排队值就会永远躺在 queued 里没人发 —— 实测 eff 长期不更新就是这么来的。
          //    这里加一个**有界轮询**，直到在途结束并把它发出去。
          if (pending.safetyTimer === null) {
            var armSafety = function () {
              pending.safetyTimer = setTimeout(function () {
                pending.safetyTimer = null;
                if (pending.queued === null) return;
                if (pending.inFlight) { armSafety(); return; }
                tracePush({ k: "safety-flush", id: pending.queued });
                flush();
              }, 50);
            };
            armSafety();
          }
          return;
        }
        if (immediate === true) {
          flush();
          return;
        }
        if (pending.timer !== null) return;
        pending.timer = setTimeout(function () {
          pending.timer = null;
          flush();
        }, COMMIT_THROTTLE_MS);
      }

      /*
       * ── 引擎接线 ──
       * 四个入口（按下 / 拖动 / 松手 / 键盘）**只改 m.target 与 m.vPtr**，
       * 绝不写 m.x / m.v / m.a —— 这是整套模型的命门：
       * 一旦谁重置了运动状态，就退化成"取消旧动画播新动画"，割裂感立刻回来。
       */
      var motionRef = React.useRef(null);
      var frameRef = React.useRef(null);
      var lastTsRef = React.useRef(0);
      var lastPtrPctRef = React.useRef(null);
      /**
       * **上次 pointermove 的时刻**。单独用一个 ref，不能复用 lastTsRef ——
       * 后者是"上一帧的时刻"（帧循环每帧都改它），拿它算指针速度会得到错的 dt；
       * 而衰减判定要的正是"距上次真实指针事件过了多久"。
       */
      var lastPointerAtRef = React.useRef(0);
      /** 松手后"决定的档位"：吸附过程中档位标签要冻结在它上面，不能跟着中间位置跳。 */
      var snapIndexRef = React.useRef(null);

      function motionParams() {
        // 只看设置：「quick」= 简洁动画（紧参数）/「full」= 完整动画（他的松参数）
        return motionParamsForMode();
      }

      /** 懒建引擎：以当前显示位置为起点（**不是**从 0 或从档位点）。 */
      function ensureMotion() {
        if (motionRef.current === null) {
          var x0 = (draftRef.current !== null && typeof draftRef.current.pct === "number")
            ? draftRef.current.pct : shownPct;
          motionRef.current = { x: x0, v: 0, a: 0, target: x0, vPtr: 0 };
        }
        return motionRef.current;
      }

      /** 吸附过程中：档位冻结在决定的那个；拖动中：档位跟着位置走。 */
      function draftIndexFor(m) {
        if (draggingRef.current) return indexFromPct(m.x, levelCount);
        return snapIndexRef.current !== null ? snapIndexRef.current : indexFromPct(m.x, levelCount);
      }

      /**
       * 把引擎当前位置交给引擎之外的一切（四层渲染、能量、刻度都读 draft）。
       *
       * ⚠️ **位置没变就不惊动 React**：拖动期间帧循环现在会常驻（见 startFrames 里
       * 那段"为什么必须继续排下一帧"），如果每帧都无条件 setDraft，就变成
       * "指针按住不动也 60 次/秒重渲染整条滑条"（四层 + 22 个星星节点）——
       * 那是拿一种卡顿换另一种卡顿。所以这里先比一下。
       */
      function publishMotion(m) {
        var next = { pct: m.x, index: draftIndexFor(m) };
        var prev = draftRef.current;
        if (prev !== null && prev.pct === next.pct && prev.index === next.index) return;
        draftRef.current = next;
        setDraft(next);
      }

      /**
       * ⚠️ **引擎必须跟随"已生效档位"的变化**（这是一个真实 bug 的修法）。
       *
       * 场景（用户报的"点一下跳到 max"）：
       *   官方模型菜单是 **pane 状态机**（`root` / `model` / `effort`，见
       *   ui-model-selection 的 ModelSelect.tsx）：点进"推理等级"后 `pane='effort'`，
       *   **root 那一整块被替换掉** —— 我们注入的那一行（含滑条）随之不渲染，
       *   用户在那期间**看不到滑条**，也不可能同时拖动。
       *   选完档位回到 root 时，显示的档位已经变了（`effectivePct` 变了）。
       *
       *   而引擎 `x` 只被"滑条自己的操作"更新 —— 它**不知道**官方改了档位。实测：
       *     1) 滑块拖到 max    → 显示 1.0，引擎 x = 1.0
       *     2) 官方菜单选 low  → 显示 1/3（走 effectivePct），**引擎 x 仍是 1.0**
       *     3) 在滑块里点 max  → target=1.0 而 x 已=1.0 → **一帧内 settled**
       *                          → 显示从 1/3 直接跳成 1.0（瞬移，实测跳变 66.67%）
       *   点"显示位置 low"更明显：引擎从错误的 1.0 起点动画，
       *   会**先瞬移回 max 再往下滑**。
       *
       * 修法：**只有在引擎空闲时**（既不在拖动、也不在吸附 → `draftRef.current === null`）
       * 才把引擎对齐到 `effectivePct`。这样：
       *   · 官方改档（引擎空闲）→ 对齐到新档位 → 不再瞬移
       *   · 用户拖动/吸附中 → `draftRef.current !== null` → **不碰引擎**（用户操作优先）
       *
       * ⚠️ 绝不能把这个对齐放进 `ensureMotion()`：`endDrag()` 里也调用 `ensureMotion()`，
       * 而"快速按下即松手"时 `draftRef.current` 还是 null，那时对齐会把
       * `m.target` 改写成当前档位 → 松手算出的落点变成"原地不动" → **写回丢失**
       * （实测：60 次拖动的写回从 ≥1 次变成 0 次）。对齐必须只在"档位真的变了"时发生。
       */
      React.useEffect(function () {
        var m = motionRef.current;
        if (m === null) return;
        if (draftRef.current !== null) return;   // 拖动/吸附中：用户优先
        m.x = effectivePct;
        m.v = 0;
        m.a = 0;
        m.target = effectivePct;
        m.vPtr = 0;
      }, [effectivePct]);

      /**
       * 启动帧循环（幂等：已在跑就直接返回）。
       * dt 用**真实帧间隔**并夹到 MAX_FRAME_DT，避免切标签回来时一帧跳一大段。
       */
      function startFrames() {
        if (frameRef.current !== null) return;
        lastTsRef.current = nowMs();
        var step = function (ts) {
          frameRef.current = null;   // 诊断：能走到这里通常是卸载/重挂载
          var m = motionRef.current;
          if (m === null) return;
          var p = motionParams();
          var dt = Math.min(MAX_FRAME_DT, Math.max(0.001, (ts - lastTsRef.current) / 1000));
          lastTsRef.current = ts;
          // ⚠️ 每帧先让**陈旧的指针速度**衰减（见 decayPointerSpeed 的注释）：
          // 指针停下后不再有 pointermove，vPtr 若不衰减就会冻结成一个恒定的力，
          // 而且让下面的到位判定永远不成立（循环空转）。
          // 注意这里用**距上次 pointermove 的实际时长**（不是帧间隔 dt）——
          // dt 每帧都被重置成 ~16ms，永远跨不过 33ms 的保鲜期，等于没衰减。
          var sincePointer = (ts - lastPointerAtRef.current) / 1000;
          m.vPtr = decayPointerSpeed(m.vPtr, sincePointer, POINTER_STALE_S, POINTER_SPEED_TAU);
          motionStep(m, dt, p);
          if (motionSettled(m, p)) {
            // 到位：精确落到目标（消除浮点残差）
            m.x = m.target;
            m.v = 0;
            m.a = 0;
            if (draggingRef.current) {
              // ⚠️ 拖动中"到位"只意味着**追上了指针**，不是结束：
              // 手指还在按着，位置必须停在指针处，**不能**清掉 draft
              // （清了就会回落到已生效档位，滑块"自己跳回去"）。
              //
              // ⚠️⚠️ 而且**必须继续排下一帧**，不能在这里 return！
              // 早先在这里 return（想省掉空转），造成"拖动时的瞬间卡顿"：
              //   · 指针移动慢/短暂停顿时，滑块很容易追平 → 循环停
              //   · 下一个 pointermove 再 startFrames() → 那里会重置
              //     `lastTsRef.current = nowMs()`，于是**重启后的第一帧
              //     dt ≈ 0**（被夹到 1ms 下限）→ 那一帧位移为 0
              //   · 实测：指针只挪 0.5% 后循环 7 帧就停；重启第 1 帧位移
              //     0.0000%、第 2 帧才 0.2100% —— 视觉上就是"卡一下再动"
              //   · 快速拖动时滑块一直在追、循环不停，所以**偏偏慢拖才卡**
              // 代价：拖动期间即使指针完全不动也保持 ~0.03ms/帧 的空转，
              //       相对 16.7ms 的帧预算可以忽略。
              publishMotion(m);
              frameRef.current = scheduleFrame(step);
              return;
            }
            // 吸附完成：**只有提交回写真正追上了**，才把控制权交回 effectivePct。
            // ⚠️ 无条件交还时，提交还在路上 → 显示瞬间跳回【旧档位】= 抽搐。
            //    预览页没有这套回写管道，所以它从不跳 —— 这里对齐预览页的效果。
            if (Math.abs(effectivePctRef.current - m.target) > 0.001 && holdFramesRef.current < 45) {
              holdFramesRef.current += 1;   // 仅统计用
              draftRef.current = { pct: m.target, index: snapIndexRef.current };
              publishMotion(m);
              frameRef.current = scheduleFrame(step);
              return;   // 继续持有显示，等提交追上（~0.75s 兜底）
            }
            holdFramesRef.current = 0;
            tracePush({ k: "settle-clear", inst: __cesInstanceId, dragging: draggingRef.current, mX: Math.round(m.x * 10000) / 10000, mTarget: Math.round(m.target * 10000) / 10000 });
            draftRef.current = null;
            snapIndexRef.current = null;
            setDraft(null);
            return; // 停循环，不空转（此时确实没事可做了）
          }
          publishMotion(m);
          frameRef.current = scheduleFrame(step);
        };
        frameRef.current = scheduleFrame(step);
      }

      /** 立即到位（「减少动态效果」下的按下 / 松手 / 键盘：不做补间）。 */
      function jumpTo(targetPct) {
        var m = ensureMotion();
        m.target = targetPct;
        m.x = targetPct;
        m.v = 0;
        m.a = 0;
        m.vPtr = 0;
      }

      function pctAt(clientX) {
        var track = trackRef.current;
        if (!track || typeof track.getBoundingClientRect !== "function") return null;
        var rect = track.getBoundingClientRect();
        // 与视觉几何一致：指针落点映射到"旋钮圆心能到的那一段"，所以拖到最左/最右必定命中端点档位。
        var usable = rect.width - KNOB_RADIUS * 2;
        if (!(usable > 0)) return null;
        return clamp01((clientX - rect.left - KNOB_RADIUS) / usable);
      }

      /** 吞掉事件：滑条在官方的 <button> 里，不能让拖动触发那一行的 onClick（会跳进等级列表）。 */
      function swallow(event) {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      }

      /** 拖动落点：只改 target（**不碰 x/v/a**），并按指针速度更新前馈。 */
      function moveTo(clientX) {
        if (levelCount === 0) return;
        var pct = pctAt(clientX);
        if (pct === null) return;
        var m = ensureMotion();
        // 指针速度（EMA 平滑防抖）：用于前馈 + 松手外推。
        // ⚠️ 时间基准必须用**上次 pointermove 的时刻**（lastPointerAtRef），
        // 不能用 lastTsRef —— 后者是帧循环的帧时刻，两次 pointermove 之间可能夹着
        // 若干帧，拿它算 dt 会把速度算错（实测偏低，导致前馈失效）。
        var now = nowMs();
        var dtPtr = (now - lastPointerAtRef.current) / 1000;
        if (lastPtrPctRef.current !== null && dtPtr > 0.001) {
          var raw = (pct - lastPtrPctRef.current) / dtPtr;
          m.vPtr = m.vPtr * (1 - POINTER_SPEED_EMA) + clampAbs(raw, MOTION.vmax) * POINTER_SPEED_EMA;
        }
        lastPtrPctRef.current = pct;
        lastPointerAtRef.current = now; // ← 记录真实事件时刻（衰减判定也用它）
        // 三种模式的分岔点：只有「快速动画」是**不跟手**的（复刻 Codex，实测如此）。
        var fastMode = motionMode() === "fast";
        if (fastMode) {
          // 不跟手：目标永远是"档位格"，指针只在**越过判定线**时才把档位推进一格
          // （前进 1/3、后退 2/3，滞回；见 detentTargetIndex）。
          // 于是观感 = 旋钮停在格子上，一格一格跳，与 Codex 录屏一致。
          var pos = pct * Math.max(1, levelCount - 1);
          var curDetent = detentIndexRef.current;
          if (!(curDetent >= 0)) curDetent = indexFromPct(m.target, levelCount);
          curDetent = detentTargetIndex(pos, curDetent, levelCount, DETENT_THIRD);
          detentIndexRef.current = curDetent;
          m.target = pctFromIndex(curDetent, levelCount);
        } else {
          m.target = pct; // ← 唯一被改的东西
        }
        // 拖动即切档（"拖到哪档就变成哪一档"）：**只在跨档时**写一次。
        if (levelCount > 0) {
          var nowIndex = fastMode ? detentIndexRef.current : indexFromPct(pct, levelCount);
          if (nowIndex >= 0 && nowIndex !== lastCommittedIndexRef.current) {
            lastCommittedIndexRef.current = nowIndex;
            requestCommit(levels[nowIndex].id, false);
          }
        }
        // ⚠️⚠️ 拖动期间**不写回宿主** —— 逐帧诊断得出的结论，也是唯一能根治"松手抽搐"的做法：
        //   · 拖动期写回会让「已生效档位」在拖动过程中不停变化，而引擎位置是**连续滞后**的，
        //     两者必然不同步；松手把显示交还给 effectivePct 时就会看到一次跳变（实测 10.6% / 66%）。
        //   · 参考实现（Bai-2008 的 1.3.10）把"连续拖动期间写回宿主"降到 **0 次**，原因相同。
        //   · 视觉不依赖写回：拖动中显示的是 draft（引擎位置），"会落到哪一档"由本地纯函数算。
        //   · 写回只发生在真正确定意图的时刻：**松手（endDrag）**、键盘、点击档位。
        // （原实现是 `requestCommit(levels[indexFromPct(pct, levelCount)].id, false)`，
        //   即"每秒约 8 次打宿主"——正是上述不同步的来源。要恢复旧行为把那行加回来即可。）
        if (reducedMotion) {
          // 减少动态：直接到位（仍不发散跳变，因为位置就是目标）
          jumpTo(m.target);
          draftRef.current = { pct: m.target, index: indexFromPct(m.target, levelCount) };
          setDraft(draftRef.current);
          return;
        }
        startFrames();
      }

      function endDrag() {
        tracePush({ k: "endDrag-enter", inst: __cesInstanceId, dragging: draggingRef.current, buttonDown: buttonDownRef.current });
        if (!draggingRef.current) return;
        draggingRef.current = false;
        var m = ensureMotion();
        // ⚠️ 这里**必须**读 ref，不能读闭包变量：
        //    窗口级 pointerup 安全网是"挂载时绑定一次"的长寿闭包，直接读闭包里的
        //    levelCount/levels 会永远停在**首次渲染**（那时 levelCount 还是 0）✗ → 每次松手都
        //    release-abort → 不写回 → 显示交还旧档位 = "点一下顿一下"。
        var levelCountNow = levelCountRef.current;
        var levelsNow = levelsRef.current;
        // 档位列表真的为空（从未就绪）时仍然不能落点：indexFromPct(pct, 0) 恒返回 0。
        if (!(levelCountNow > 0) || !levelsNow || levelsNow.length < levelCountNow) {
          tracePush({ k: "release-abort", why: "levelCount=0", mTarget: Math.round(m.target * 10000) / 10000 });
          return;
        }
        tracePush({ k: "pre-release", mTarget: Math.round(m.target * 10000) / 10000, mX: Math.round(m.x * 10000) / 10000, vPtr: Math.round(m.vPtr * 1000) / 1000, levelCount: levelCountNow, projS: (typeof RELEASE_PROJECT_S === "undefined" ? "undef" : RELEASE_PROJECT_S), idxNow: indexFromPct(m.target, levelCountNow) });
        // 落点决策**与动画无关**：一律按指针速度外推。
        // （曾经让 reduced 分支跳过外推 —— 那是错的：无障碍设置只该改"怎么动"，
        //   不该改"落在哪一档"，否则同一个拖动在两种设置下结果不同。）
        var idx;
        if (motionMode() === "fast") {
          // 快速动画：拖动中目标已经推到格子上，松手不再外推、也不再补一段吸附（与 Codex 一致）。
          idx = detentIndexRef.current >= 0 ? detentIndexRef.current : indexFromPct(m.target, levelCountNow);
          idx = Math.max(0, Math.min(levelCountNow - 1, idx));
          m.vPtr = 0;
          m.target = pctFromIndex(idx, levelCountNow);
        } else {
          idx = releaseIndexFor(m.target, m.vPtr, levelCountNow);
          m.vPtr = 0;
          if (reducedMotion) {
            jumpTo(pctFromIndex(idx, levelCountNow));
          } else {
            // 松手：目标改为档位点，但运动状态（速度）**继承**下来 ——
            // 这样从拖到吸也是连续的，不会重播一段吸附动画。
            m.target = pctFromIndex(idx, levelCountNow);
          }
        }
        snapIndexRef.current = idx;
        // 写回与视觉无关（档位已由指针决定），所以**松手瞬间就发**。
        if (idx >= 0 && idx < levelCountNow) requestCommit(levelsNow[idx].id, true);
        tracePush({ k: "release", idx: idx, x: Math.round(m.x * 10000) / 10000, target: Math.round(m.target * 10000) / 10000, eff: Math.round(effectivePctRef.current * 10000) / 10000, showIdx: snapIndexRef.current });
        if (reducedMotion) {
          draftRef.current = null;
          snapIndexRef.current = null;
          setDraft(null);
          return;
        }
        publishMotion(m);
        startFrames();
      }

      function onTrackPointerDown(event) {
        if (locked || levelCount === 0) return;
        swallow(event);
        draggingRef.current = true;
        buttonDownRef.current = true;
        // 起手时对齐"已写回档位"，避免刚按下就写一次无意义的档位
        lastCommittedIndexRef.current = -1;
        // 快速动画：按下即把"当前格"对齐到指针所在格（点击远处 = 直接跳到那一档）。
        detentIndexRef.current = -1;
        if (motionMode() === "fast") {
          var p0 = pctAt(event.clientX);
          if (p0 !== null && levelCount > 0) detentIndexRef.current = indexFromPct(p0, levelCount);
        }
        holdFramesRef.current = 0;
        releaseGenRef.current += 1;   // 新操作开始：上一次松手的提交重试立即作废
        snapIndexRef.current = null;
        try {
          if (event.currentTarget && typeof event.currentTarget.setPointerCapture === "function" && event.pointerId !== undefined) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        } catch (error) { /* 指针捕获失败不影响拖动 */ }
        // 按下 = **召唤**：目标改成指针位置，但 x/v/a 全部保留（不是"抓住滑块"，没有抓取偏移）。
        lastPtrPctRef.current = null;
        moveTo(event.clientX);
      }

      function onTrackPointerMove(event) {
        if (!draggingRef.current) return;
        // 没按着键 ⇒ 不是拖动（松手瞬间的合并事件 / pointerup 丢失的残留状态）。
        // 只忽略、不结束：在这里 endDrag() 会导致"先往左再回正"那种抽搐。
        if (event && event.buttons === 0 && buttonDownRef.current !== true) return;
        swallow(event);
        moveTo(event.clientX);
      }

      function onKeyDown(event) {
        if (locked || levelCount === 0) return;
        var key = event.key;
        var index = draftRef.current !== null ? draftRef.current.index : shownIndex;
        var next = null;
        if (key === "ArrowLeft" || key === "ArrowDown") next = Math.max(0, index - 1);
        else if (key === "ArrowRight" || key === "ArrowUp") next = Math.min(levelCount - 1, index + 1);
        else if (key === "Home") next = 0;
        else if (key === "End") next = levelCount - 1;
        else return; // Escape / Enter / Tab 交给官方菜单自己处理
        swallow(event);
        if (typeof event.preventDefault === "function") event.preventDefault();
        // 键盘改档：同样**只改目标**，运动状态延续（不瞬移）。
        var m = ensureMotion();
        var targetPct = pctFromIndex(next, levelCount);
        if (reducedMotion) {
          jumpTo(targetPct);
          snapIndexRef.current = null;
          draftRef.current = null;
          setDraft(null);
        } else {
          snapIndexRef.current = next;
          m.target = targetPct;
          m.vPtr = 0;
          publishMotion(m);
          startFrames();
        }
        requestCommit(levels[next].id, true);
      }

      // 卸载时必须停掉帧循环，否则组件销毁后还会 setDraft 到已卸载的组件
      // （官方菜单反复开关时就会发生）。
      React.useEffect(function () {
        return function () {
          cancelFrame(frameRef.current);
          frameRef.current = null;
        };
      }, []);

      var trackTitle = "推理等级" + (shownLevel !== null ? "：" + shownLevel.name : "");
      if (effectiveReducedMotion) trackTitle += "（简洁动画：粒子已放缓）";

      var tickNodes = [];
      for (var t = 0; t < levelCount; t += 1) {
        tickNodes.push(React.createElement("span", {
          key: "tick-" + levels[t].id,
          className: "ces-tick",
          "data-ces-part": "tick",
          "data-on": t <= shownIndex ? "1" : "0",
          style: { left: knobOffsetOf(pctFromIndex(t, levelCount)) },
        }));
      }

      // 星空：所有出现粒子的档位都用这一套动画（统一的横穿 + 不消失 + 亮度即大小）。
      // 速率随**位置**变化（速度变化保留）：MAX 档 1.5s 横穿，high 档 3s，左端约 8.6s。
      var positionSpeed = speedFor(shownPct);
      var starCount = starCountFor(shownPct);
      var starLayerOpacity = starLayerOpacityFor(shownPct);
      var particleNodes = [];
      for (var s = 0; s < starCount; s += 1) {
        var starBrightness = starBrightnessFor(s);
        // 「减少动态效果」的放缓在 JS 里算（时长是内联的，不走媒体查询覆盖）
        var starDuration = starDurationFor(s, positionSpeed) * (effectiveReducedMotion ? REDUCED_MOTION_SLOWDOWN : 1);
        particleNodes.push(React.createElement(
          "span",
          {
            key: "star-" + s,
            className: "ces-star",
            "data-ces-part": "star",
            style: {
              top: PARTICLES[s].y + "%",
              // ⚠️ 时长与**负相位**必须直接内联：写成 CSS 变量时真宿主里相位不生效，
              //    会出现"一打开星星全挤在起点"（见样式表里的注释）。
              animationDuration: starDuration.toFixed(3) + "s",
              animationDelay: starDelayFor(s, starDuration).toFixed(3) + "s",
            },
          },
          React.createElement("span", {
            className: "ces-star__dot",
            "data-ces-part": "particle",
            // 亮度即大小系数：越亮越大（同时也是不透明度）
            "data-brightness": starBrightness.toFixed(3),
            style: { "--ces-b": starBrightness.toFixed(3) },
          }),
        ));
      }

      var ui = null;
      if (host !== null && host.container && levelCount > 0) {
        ui = ReactDOM.createPortal(
          React.createElement(
            "div",
            {
              className: "ces-inline",
              "data-ces-part": "root",
              "data-energy": energyOn ? "1" : "0",
              "data-motion": effectiveReducedMotion ? "concise" : "full",
              "data-reached-ticks": readSettings().reachedTicks,
              "data-busy": busy ? "1" : "0",
              style: { "--ces-energy": String(energy) },
            },
            React.createElement(
              "div",
              {
                ref: trackRef,
                className: "ces-track",
                "data-ces-part": "track",
                role: "slider",
                tabIndex: locked ? -1 : 0,
                "aria-label": "推理等级",
                "aria-valuemin": 0,
                "aria-valuemax": Math.max(0, levelCount - 1),
                "aria-valuenow": shownIndex,
                "aria-valuetext": shownLevel !== null ? shownLevel.name : "",
                "aria-disabled": locked ? "true" : undefined,
                title: trackTitle,
                onPointerDown: onTrackPointerDown,
                onPointerMove: onTrackPointerMove,
                onPointerUp: endDrag,
                onPointerCancel: endDrag,
                onKeyDown: onKeyDown,
                onClick: swallow,
              },
              React.createElement("div", {
                className: "ces-fill",
                "data-ces-part": "fill",
                // 填充宽度 = 到旋钮圆心为止（不是整条轨道）；背景是"左蓝 → 当前位置颜色"的渐变。
                style: { width: knobOffset, background: fillBackground },
              }),
              // 能力层（星云 + 扫光）：透明度 = 能量强度，负责"通电"的渐入。
              React.createElement(
                "div",
                { className: "ces-energy", "data-ces-part": "energy", style: { width: knobOffset } },
                React.createElement("div", { className: "ces-energy__sweep", "data-ces-part": "sweep" }),
              ),
              // 星星单独一层：不跟星云淡入（否则 high 档星星被星云的 0.5 透明度压得看不见）。
              React.createElement(
                "div",
                {
                  className: "ces-stars",
                  "data-ces-part": "stars",
                  style: { width: knobOffset, opacity: starLayerOpacity.toFixed(3) },
                },
                particleNodes,
              ),
              tickNodes,
              React.createElement("div", {
                className: "ces-knob",
                "data-ces-part": "knob",
                style: { left: knobOffset },
              }),
            ),
            errorText_ !== null
              ? React.createElement("div", { className: "ces-error", "data-ces-part": "error", role: "status" }, errorText_)
              : null,
          ),
          host.container,
        );
      }

      // 锚点：不可见、不占位，只用来(1)拿住插槽给的 sessionId 上下文 (2)反查自己的 composer。
      return React.createElement("span", {
        ref: anchorRef,
        hidden: true,
        "data-ces-part": "anchor",
        "aria-hidden": "true",
      }, ui);
    }

    /* ════════════════════════════ 插件接线 ════════════════════════════ */

    /**
     * 三个服务都是官方客户端插件已经在用的（slots 不必说；sessions 与 modelDirectories
     * 是 client-ui-model-selection / client-ui-workspace 的既有注入面）。
     * 这里刻意**不**注入 locale / theme：多声明一个可能不存在的服务会让 fiber 停在
     * PENDING，代价远大于省下两行文案。
     *
     * ⚠️ 补充 `remote` / `remote.session`（参考实现的事故 #2）：
     *    接管官方那一席之后，本插件成了 `directoryFor()` 的**唯一调用方** —— Cordis 的服务访问
     *    跟着**调用方 ctx** 走，少声明这两个服务时，目录解析会在"会话作用域/绑定尚未就绪"时长期
     *    失败 → `modelDirectories.directoryFor(sessionId)` 拿不到目录 → **档位列表为空**
     *    （实测 `levelCount = 0`）→ 于是：拖动不开始 / 落点算成第 0 档 / 松手写回被放弃
     *    → 显示交还时跳一大截（用户看到的"松手抽搐 / 乱跳"就是这个）。
     *    诊断证据：`{"k":"release-abort","why":"levelCount=0"}` 出现 4 次。
     */
    var inject = ["slots", "sessions", "modelDirectories", "remote", "remote.session"];

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () { return "Reasoning effort"; },
              // 会话 id 的第二条来路（标准 props 一般已经带了；两条都走 props.sessionId）。
              inject: function (sessionId) { return { sessionId: sessionId }; },
            },
            function SlotComponent(props) {
              return React.createElement(CodexEffortSlider, Object.assign({}, props, { __ctx: ctx }));
            },
          );
        });
      } catch (error) {
        // 注册失败只意味着这块控件不出现，绝不能连累宿主输入区。
        try { console.error("[codex-effort-slider] 插槽注册失败，控件不会出现：", error); } catch (e) { /* 忽略 */ }
      }
    }

    installStyles();

    exports.apply = apply;
    exports.inject = inject;
    // 离线测试用的接缝（纯函数 + 桥 + 组件本身）。运行时无副作用。
    exports.__internals = {
      CSS: CSS,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ID: ENTRY_ID,
      PARTICLES: PARTICLES,
      ROW_PADDING_BLOCK: ROW_PADDING_BLOCK,
      EFFORT_ROW_LABELS: EFFORT_ROW_LABELS,
      CodexEffortSlider: CodexEffortSlider,
      createMenuBridge: createMenuBridge,
      findEffortRow: findEffortRow,
      firstSpanText: firstSpanText,
      levelsOf: levelsOf,
      sortLevelsByStrength: sortLevelsByStrength,
      effortRankOf: effortRankOf,
      REASONING_EFFORT_RANK: REASONING_EFFORT_RANK,
      UNKNOWN_EFFORT_RANK: UNKNOWN_EFFORT_RANK,
      resolveLevels: resolveLevels,
      modelOf: modelOf,
      effectiveEffortId: effectiveEffortId,
      indexOfLevel: indexOfLevel,
      indexFromPct: indexFromPct,
      pctFromIndex: pctFromIndex,
      detentTargetIndex: detentTargetIndex,
      DETENT_THIRD: DETENT_THIRD,
      energyFor: energyFor,
      speedFor: speedFor,
      particleCountFor: particleCountFor,
      starCountFor: starCountFor,
      starLayerOpacityFor: starLayerOpacityFor,
      starBrightnessFor: starBrightnessFor,
      starDurationFor: starDurationFor,
      starDelayFor: starDelayFor,
      starHash01: starHash01,
      STARFIELD_DURATION_MEAN: STARFIELD_DURATION_MEAN,
      STARFIELD_DURATION_SPREAD: STARFIELD_DURATION_SPREAD,
      STARFIELD_MIN: STARFIELD_MIN,
      GOLDEN_RATIO: GOLDEN_RATIO,
      MAX_SPEED_FACTOR: MAX_SPEED_FACTOR,
      REDUCED_MOTION_SLOWDOWN: REDUCED_MOTION_SLOWDOWN,
      readSettings: readSettings,
      writeSettings: writeSettings,
      normalizeSettings: normalizeSettings,
      schemaDefaults: schemaDefaults,
      motionMode: motionMode,
      motionParamsForMode: motionParamsForMode,
      tracePush: tracePush,
      dumpTrace: dumpTrace,
      traceClear: traceClear,
      installSettingsUi: installSettingsUi,
      openSettingsPanel: openSettingsPanel,
      SETTINGS_SCHEMA: SETTINGS_SCHEMA,
      SETTINGS_VERSION: SETTINGS_VERSION,
      SETTINGS_KEY: SETTINGS_KEY,
      SETTINGS_EVENT: SETTINGS_EVENT,
      MIN_HEIGHT_SLOTS: MIN_HEIGHT_SLOTS,
      fillColorFor: fillColorFor,
      fillBackgroundFor: fillBackgroundFor,
      valueColorFor: valueColorFor,
      isOffLevel: isOffLevel,
      findValueElement: findValueElement,
      findSeatEffort: findSeatEffort,
      knobOffsetOf: knobOffsetOf,
      KNOB_RADIUS: KNOB_RADIUS,
      KNOB_SIZE: KNOB_SIZE,
      TRACK_HEIGHT: TRACK_HEIGHT,
      BASE_SPEEDUP: BASE_SPEEDUP,
      ENERGY_START: ENERGY_START,
      ENERGY_END: ENERGY_END,
      clamp01: clamp01,
      installStyles: installStyles,
      // ── 连续运动引擎（导出是为了让测试能注入固定 dt 精确断言）──
      MOTION: MOTION,
      MOTION_REDUCED: MOTION_REDUCED,
      MOTION_FAST: MOTION_FAST,
      RELEASE_PROJECT_S: RELEASE_PROJECT_S,
      POINTER_SPEED_EMA: POINTER_SPEED_EMA,
      POINTER_STALE_S: POINTER_STALE_S,
      POINTER_SPEED_TAU: POINTER_SPEED_TAU,
      motionStep: motionStep,
      motionSettled: motionSettled,
      decayPointerSpeed: decayPointerSpeed,
      releaseIndexFor: releaseIndexFor,
      clampAbs: clampAbs,
    };

    return module.exports;
  },
});
