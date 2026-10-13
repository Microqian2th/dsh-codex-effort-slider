/**
 * better-dsh-codex-effort-slider — 客户端半边
 *
 * 把 DSH 官方模型菜单里的**「推理等级」那一行**改造成 Codex 风格滑条：
 *   · 那一行加高上下内距、允许折行，滑条作为第二行铺满整行宽度
 *   · 拖到最高档时，轨道亮起紫色能量层（流向渐变 + 扫光 + 22 颗星尘粒子），整行描一圈紫边
 *   · 输入框工具行**不加任何东西**（原来的胶囊已撤掉）
 *
 * 1.2.0 起还往官方菜单里加三处**只读注记**（全部只 append，不改官方任何文字与结构）：
 *   · 模型列表每一行右侧一颗档位徽标（`8 档` / `不支持`）
 *   · 根面板"模型"那一行右侧一个 provider 归属标签（一级页就能看出切换生效）
 *   · 档位列表每一行右侧它的**原始 API 取值**（`xhigh` 之类，发送请求用的就是它）
 * 另加两条来自参考实现的工程纪律：禁用态 = 渲染函数的**完整投影**（每帧重算，不做增量 patch）、
 * 以及翻页那一帧的滚动稳定化（官方 `.focus()` 不带 preventScroll + 我们加高那一行触发的
 * scroll anchoring，会在换内容时多出一次位移）。
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
 *   模型行还带 `id={id}-model-{index}`（index 与目录 `groups[].models[]` 展平后的序号一致），
 *   档位行没有 id —— 徽标与 API 值就靠这两条区分（见 decorateMenu）。
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
  id: "better-dsh-codex-effort-slider",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");

    /* ── 自建浮层（code.html 那套界面的落地版）在**包内动态 chunk** 里 ──────────────
       客户端的模块表（@deepseek-ai/dsh-client-modules）是**按包名**建表的：同步 `require`
       只认「平台种子词 / 引导图里的包 / 已注册的工厂」，写 `require("包名/picker")` 会直接抛
       "missed the module table"。正规做法是它同一段代码里给的包内 chunk：
         · 文件名必须是 `client.<name>.js`（`CLIENT_CHUNK` 规则），与 client.js 同级
         · 用 `require.async("./client.picker.js")` 取，宿主按
           `/plugins/<包名>/client.picker.js?rev=…` 路由 serve（还带 revision 与 HMR 失效）
       取不到时**只有自建浮层消失**，官方菜单那一行那条控件照常工作。 */
    var pickerModule = null;
    var pickerWatchers = [];
    var pickerLoading = false;

    function loadPickerModule() {
      if (pickerModule !== null || pickerLoading) return;
      pickerLoading = true;
      var async = typeof require.async === "function" ? require.async : null;
      if (async === null) { pickerLoading = false; return; }
      Promise.resolve(async("./client.picker.js")).then(function (loaded) {
        pickerModule = loaded || null;
        pickerLoading = false;
        if (pickerModule === null) return;
        if (pickerModule.PICKER_CSS) installStyles(pickerModule.PICKER_CSS, PICKER_STYLE_MARKER);
        // 模块是后到的：通知所有已经挂上的条目重渲一次（此前它们渲染 null）
        var waiting = pickerWatchers;
        pickerWatchers = [];
        for (var i = 0; i < waiting.length; i += 1) {
          try { waiting[i](); } catch (error) { /* 单个订阅者抛错不影响其它 */ }
        }
      }).catch(function (error) {
        pickerLoading = false;
        try { console.warn("[" + PACKAGE_ID + "] 自建浮层加载失败（官方菜单那条控件不受影响）：", error); } catch (e) { /* 忽略 */ }
      });
    }

    /** 组件侧：模块还没到时订阅一次；到了就重渲（返回取消订阅函数）。 */
    function watchPickerModule(onLoad) {
      if (pickerModule !== null) { onLoad(); return function () {}; }
      pickerWatchers.push(onLoad);
      loadPickerModule();
      return function () {
        var index = pickerWatchers.indexOf(onLoad);
        if (index >= 0) pickerWatchers.splice(index, 1);
      };
    }

    /**
     * 包名 —— **必须排在最前**：下面好几个常量都由它拼出来。
     *
     * 踩过的坑：`PACKAGE_ID` 原本声明在 `PICKER_STYLE_MARKER` **之后**，同为 `var`（hoisting 后
     * 是 `undefined`），于是那个标记实际是 `"undefined/picker"`（真机复现，`<style>` 上就是它）。
     * 当时不炸（仍是稳定且唯一的字符串，去重照常），但把包命名空间弄丢了：
     * 万一有第二张 `data-plugin-css="undefined/picker"` 的样式表（同类插件抄这个写法就会），
     * `installStyles` 会**复用它**，`.cxp-*` 整套规则就再也注入不进去。
     */
    var PACKAGE_ID = "better-dsh-codex-effort-slider";

    var PICKER_CHUNK = "./client.picker.js";
    /** 自建浮层那套样式表自己的标记（与官方菜单那条控件的样式分开去重）。 */
    var PICKER_STYLE_MARKER = PACKAGE_ID + "/picker";

    /** 仍然注册一个（不可见的）插槽条目：它是**每会话**拿到 sessionId 与 ctx 的立足点。 */
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ID = "codex-effort-slider";
    var ENTRY_ORDER = 40;
    /**
     * 官方菜单那条控件（1.2.0 的 `.ces-` 注入路径）的**总开关**，默认 `false`。
     *
     * 关掉的道理：主入口已经是自建浮层（`codex-picker-trigger` / `codex-picker-panel`），
     * 而这条路会**另外**给官方菜单那一行插一条滑条、再给官方那颗席按钮上色 —— 两套 UI 同时在
     * 同一个输入区里互相干扰（一行里两条滑条）。
     *
     * 想回到"改造官方菜单"那条路，把它改成 `true` 即可：组件、纯函数、离线断言（第 2–26 节）
     * 全部照旧保留，改一行就恢复。
     */
    var ENABLE_OFFICIAL_MENU_SLIDER = false;
    /**
     * 自建浮层的两个落点：
     *   · **触发器接管官方那颗模型席**：`conversation.input.model` 是一个 **single 槽**，
     *     官方 model-selection 插件自己也注册在那里（**不写 priority → 默认 0**）。
     *     槽位内核 `dsh-client-ui-slots` 对 single 槽的规则是"**同 priority 撞了会抛错，
     *     换一个 priority 就遮蔽它（`lowest renders`）**"，所以这里用 `-1` 抢在官方前面 ——
     *     官方那颗席按钮**整个不渲染**，输入行里只剩我们这一颗（1.3.2 之前是并排两颗）。
     *     这不是钻空子：官方槽位目录给这个槽标的 `replaceRisk` 就是 `shadows-shipped-ui`。
     *     ⚠️ 代价是**官方菜单（模型列表/档位列表/键盘导航）再也打不开**（那颗按钮就是它的唯一入口）；
     *     `/model` 命令那条路不受影响（它是另一套 popupSelect UI）。
     *   · 拿不到那个槽（官方改版 / 不再是 single / 注册抛错）就**退回** `conversation.input.right`
     *     —— 最差也只是回到"两颗按钮并排"的老样子，绝不会两边都没有。
     *   · 面板放在 `conversation.input.overlay`（官方插槽目录原话：Floating entries rendered inside
     *     the resident composer card）—— 那里**不会被 composer 卡片裁掉**。
     */
    var PICKER_TRIGGER_SLOT = "conversation.input.model";
    /** 遮蔽官方席用的优先级：官方是 0，比它小就赢（单槽只渲染优先级最低的那个）。 */
    var PICKER_TRIGGER_PRIORITY = -1;
    /** 拿不到 `conversation.input.model` 时的退路（老位置，与官方那颗并存）。 */
    var PICKER_TRIGGER_FALLBACK_SLOT = "conversation.input.right";
    var PICKER_TRIGGER_ID = "codex-picker-trigger";
    var PICKER_TRIGGER_ORDER = 30;
    var PICKER_PANEL_SLOT = "conversation.input.overlay";
    var PICKER_PANEL_ID = "codex-picker-panel";
    var PICKER_PANEL_ORDER = 20;
    /** 「加高那一栏的上下距离」。 */
    var ROW_PADDING_BLOCK = "10px";
    /** 官方那一行的中文/英文文案（形状锚点之一；认不出就按官方固定顺序取第 2 个 menuitem）。 */
    var EFFORT_ROW_LABELS = ["推理等级", "Effort"];
    /**
     * 拖动期间写回宿主的"停顿判定"（毫秒）—— 注意是**去抖**，不是节流。
     * 连续拖动时一次都不写回；指针停住这么久才落地；松手一律立即落地。
     *
     * 为什么必须去抖：每次写回都会让 DSH 改这个会话的推理档位（落盘 + 重渲染），
     * 原先按 120ms 节流，连续拖动相当于每秒打宿主 8 次，实测就是"拖动有点卡"。
     * 去抖之后连续拖动是 0 次，只在停手与松手各一次。
     */
    var COMMIT_SETTLE_MS = 260;
    /** 提交后等宿主真实回报的上限；超时回滚并提示，不继续假装已生效。 */
    var COMMIT_DEADLINE_MS = 10000;
    /** 目录解析失败时的退避重试序列（毫秒，累计约 9 秒）。 */
    var RETRY_DELAYS = [60, 240, 540, 960, 1500, 3000, 3000];
    /**
     * 目录实例的**主动复查**周期（毫秒）。
     *
     * 为什么必须要有一个主动信号：宿主重建该会话的 `ModelDirectory` 时（父子会话换 binding、
     * 会话作用域重建等），**旧实例已经被 dispose、再也不会推送** —— 只靠 store 订阅，客户端
     * 永远不知道要换，界面就静默冻在旧档位表上，而写路径却进了新实例。
     * 复查在实例没变时是**空操作**（`resolve()` 里 `fresh === directory` 直接返回、也不 notify），
     * 所以它不会引起无谓重渲染。
     */
    var DIRECTORY_HEARTBEAT_MS = 1500;
    /**
     * 「目录就绪但**空**」时主动刷全局目录的冷却与次数上限。
     *
     * 场景：宿主 `buildModelCatalog()` 只列**当前已注册的 LLM provider**，DSH 刚起来时 provider
     * 可能还没注册完 → 返回一个合法的空目录，而它**会被缓存**（`status === "ready"` 之后
     * `load()` 直接短路）。官方那边靠远端事件 `llm/adapters-updated` 调 `refresh()` 治，
     * 那些事件不一定在启动后再来；1.3.2 接管官方席之后我们又是唯一的读取方。
     * 所以自己刷一下 —— 但**必须限量**：8 秒一次、最多 3 次，绝不会变成 RPC 风暴。
     */
    var CATALOG_REFRESH_COOLDOWN_MS = 8000;
    var CATALOG_REFRESH_MAX = 3;
    var STYLE_MARKER = PACKAGE_ID;

    /* ── 尺寸与速率常量：**必须声明在 CSS 数组之前**，因为样式表要插值它们 ──
       （踩过一次：CSS 数组先于常量求值，样式里写进去的是 `height:undefinedpx`，
       真机上轨道会塌成 0 高。测试里对轨道高/旋钮直径的断言就是为这个加的。） */
    /**
     * 尺寸：**球比轨道大**（对齐 GPT 客户端的观感）—— 球浮在轨道之上，并压过轨道两端。
     * 比例取自 GPT 客户端实测：球直径 110px 对轨道高 80px ≈ 1.375，这里 28 / 20 = 1.4。
     */
    var KNOB_SIZE = 28;
    var TRACK_HEIGHT = 20;
    /** 球半径（同时是球的 margin 偏移量，用来把球心对准计算出的 left/top）。 */
    var KNOB_RADIUS = KNOB_SIZE / 2;
    /**
     * 轨道端头的圆角半径 = 轨道高度的一半。
     * 圆心在两端各留出**这个**半径（不是球半径）：最左/最右档时球心正好落在端头圆心上，
     * 球于是压过轨道端头（GPT 客户端就是这个样子），同时又能把填充层那个半径为
     * TRACK_RADIUS 的左端半圆**完整盖住** —— off 档不会从球旁边漏出一丝颜色。
     */
    var TRACK_RADIUS = TRACK_HEIGHT / 2;
    /**
     * 换档判定：指针从**当前档位**朝相邻档位越过两端间距的这个比例，才切到那一档。
     * 1/3 是用户指定的手感（不是取中点）——旋钮因此停在档位点上一格一格走，而不是跟手。
     */
    var DETENT_THIRD = 1 / 3;
    /**
     * 换档时"滑过去"的过渡，**快慢两档**（用户要求）：
     *   · 快档：拖得快时用，快起步短尾巴，脆、跟手；
     *   · 慢档：拖得慢时用，球不至于"啪"一下窜过去、把手感扯断。
     * 四层（球 left、填充/能量/星空 width）共用 CSS 变量 `--ces-slide`，保证一起动、不撕开；
     * 跨多档时也是一段滑到位，不逐档连滑。
     */
    var SLIDE_EASE = ".16s cubic-bezier(.2,.9,.3,1)";
    /**
     * 慢档缓动换成与参考实现同一根曲线（`.34s cubic-bezier(.45,.05,.35,1)`）：
     * 两头慢、中段快，球"起步—滑到位—收住"的节奏比 `ease-in-out` 更像客户端。
     * 只改这一条曲线：快慢两档的**判据**与四层共用的 `--ces-slide` 机制都没动。
     */
    var SLIDE_EASE_SLOW = ".34s cubic-bezier(.45,.05,.35,1)";
    /**
     * 快慢判据 = **离上一次换档过了多久**（毫秒）：隔得久说明手在慢慢挪，就用慢档。
     * 两个阈值构成 120ms 迟滞，免得速度刚好卡在阈值上时快慢来回跳。
     */
    var SLOW_DRAG_ENTER_MS = 320;
    var SLOW_DRAG_EXIT_MS = 200;
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

    /* ── 档位字典与徽标（移植自参考实现的数据层形状）────────────────────────── */

    /**
     * **档位字典**：官方档位 id → 官方默认显示名的本地副本。
     *
     * 与参考实现同一形状（9 个键：off/none/minimal/low/medium/high/xhigh/max/ultra），
     * 但**只当兜底**：真宿主的档位名来自官方目录（`model.reasoning.efforts[].name`），
     * 目录给了名字就用目录的。这份表有两个用处：
     *   1. `tiers()` 用它**校验**目录来的 id —— 对不上就是脏数据，按"不支持"处理；
     *   2. 目录条目**只给了 id、没给 name** 时用它补一个可读的名字。
     * 参考实现那份静态能力清单（`OPENAI_DEFS`）在真宿主里是**目录的活数据**，不在这里重建。
     */
    var LV = {
      off: { id: "off", name: "关闭" },
      none: { id: "none", name: "None" },
      minimal: { id: "minimal", name: "Minimal" },
      low: { id: "low", name: "Low" },
      medium: { id: "medium", name: "Medium" },
      high: { id: "high", name: "High" },
      xhigh: { id: "xhigh", name: "X-High" },
      max: { id: "max", name: "Max" },
      ultra: { id: "ultra", name: "Ultra" },
    };

    /**
     * 档位 id → 字典条目。**两条兼容规则**：先把 id 折叠成小写、去掉空格与下划线
     * （`x-high`/`X_High`/`XHigh` 都认），再容忍 `reasoning_effort` 这类前缀。
     * 认不出返回 null（= 脏数据）。
     */
    function normalizeTierId(id) {
      if (typeof id !== "string") return null;
      var flat = id.replace(/[\s_-]+/g, "").toLowerCase();
      if (flat.length === 0) return null;
      if (Object.prototype.hasOwnProperty.call(LV, flat)) return LV[flat];
      for (var key in LV) {
        if (!Object.prototype.hasOwnProperty.call(LV, key)) continue;
        if (flat.length > key.length && flat.slice(-key.length) === key) return LV[key];
      }
      return null;
    }

    /**
     * 档位列表 → `{ count, names }`；**任何一项认不出就返回 null**（调用方按不支持处理）。
     *
     * 参考实现里 `tiers()` 对未知档位名**直接抛错**，而那份数据是它自己写的常量，
     * 抛错只会暴露自己的笔误；真宿主的档位表是**运行时下发**的，这条纪律就变成
     * 工程约束里写的那句"一条脏数据最多禁用滑条，不能瘫痪整个 UI"：
     * 所以这里不抛，用 null 表达"这份数据我读不懂"。
     */
    function tiers(list) {
      if (!Array.isArray(list) || list.length === 0) return null;
      var names = [];
      for (var i = 0; i < list.length; i += 1) {
        var entry = list[i];
        if (!entry || typeof entry.id !== "string" || entry.id.length === 0) return null;
        var known = normalizeTierId(entry.id);
        if (known === null) return null;
        var name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : known.name;
        names.push(name);
      }
      return { count: names.length, names: names };
    }

    /* ── 模型徽标（官方模型列表每一行的"几档 / 不支持"）─────────────────── */

    /**
     * 契约里那张**真正的能力清单**（真实产物的 `dsh-client-ui-model-selection/lib/client.js`，
     * 逐字对照过）—— 只用来生成悬浮说明，并给「目录里查不到、也没有档位字段」的模型一个明示的
     * 「不支持」而不是一声不吭。目录一旦给出 `reasoning`，**目录优先**，这张表不参与判定。
     */
    var OPENAI_DEFS = [
      { id: "gpt-6-astra", count: 8 },
      { id: "gpt-6-sol", count: 8 },
      { id: "gpt-6-luna", count: 7 },
      { id: "gpt-6-spark", count: 5 },
      { id: "gpt-5.6-sol", count: 8 },
      { id: "gpt-5.6-terra", count: 8 },
      { id: "gpt-5.6-luna", count: 7 },
      { id: "gpt-5.6-spark", count: 5 },
      { id: "gpt-6-astra-2026-01-13" },
      { id: "gpt-4o", levels: null },
    ];
    /** 徽标上"不支持"用的替代名（目录条目是别的 provider / 快照 id 时，名字不一定等于 id）。 */
    var DEF_ALIASES = { "gpt-6-astra-2026-01-13": "gpt-6-astra" };

    /**
     * 三级检测（移植自参考实现的 `resolveModel`，只保留"目录查不到时"用的那一半）：
     *   1. 精确命中，且**显式声明了档位**（`count>0` 是有档位、`levels:null` 是已知不支持）
     *      → 就是它；
     *   2. 精确命中但没声明档位（快照 id，如 `gpt-6-astra-2026-01-13`）→ 顺着 `DEF_ALIASES`
     *      落到家族条目（最多跳一次，**不递归** —— 参考实现那句
     *      `resolveModel(DEF_ALIASES[id] || id)` 在别名表没命中时会拿同一个 id 再进来一次，
     *      自环到爆栈；这里显式挡掉）；
     *   3. 最长前缀（分隔符 `-` 或 `@`）→ 快照/变体 id 继承家族档位；
     *   4. 都没有 → null（未知 → 不判定，交给目录）。
     */
    function resolveModel(id) {
      if (typeof id !== "string" || id.length === 0) return null;
      var byId = {};
      var i;
      for (i = 0; i < OPENAI_DEFS.length; i += 1) byId[OPENAI_DEFS[i].id] = OPENAI_DEFS[i];

      var exact = byId[id];
      if (exact !== undefined && (exact.levels !== undefined || exact.count > 0)) return exact;
      if (exact !== undefined) {
        var alias = DEF_ALIASES[id];
        var target = typeof alias === "string" ? byId[alias] : undefined;
        return target === undefined ? exact : target;
      }

      var best = null;
      for (i = 0; i < OPENAI_DEFS.length; i += 1) {
        var def = OPENAI_DEFS[i];
        if (!def.count) continue;
        var isFamily = id.indexOf(def.id + "-") === 0 || id.indexOf(def.id + "@") === 0;
        if (isFamily && (best === null || def.id.length > best.id.length)) best = def;
      }
      return best;
    }

    /**
     * 从**目录快照**建一张"provider → 模型 id → 档位"的能力索引。
     *
     * 这一张就是参考实现里 `OPENAI_DEFS` 的位置 —— 只不过在真宿主里它是**活数据**
     * （`state.groups[].models[].reasoning.efforts`），而不是客户端写死的能力清单。
     *
     * 读不懂的条目**不抛错、不中断**：整条 `models` 扫描包在 try/catch 里，
     * 某一行坏了只影响那一行的徽标（`tiers()` 返回 null → 按"不支持"灰显）。
     */
    function buildCatalogIndex(state) {
      var groups = state && Array.isArray(state.groups) ? state.groups : [];
      var index = { byProvider: {}, models: [] };
      for (var i = 0; i < groups.length; i += 1) {
        var group = groups[i];
        if (!group || typeof group.id !== "string") continue;
        var models = Array.isArray(group.models) ? group.models : [];
        if (!index.byProvider[group.id]) index.byProvider[group.id] = {};
        var bucket = index.byProvider[group.id];
        for (var j = 0; j < models.length; j += 1) {
          try {
            var model = models[j];
            if (!model || typeof model.id !== "string" || model.id.length === 0) continue;
            var reasoning = model.reasoning;
            var entry = {
              id: model.id,
              name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
              provider: group.id,
              // reasoning 缺席 = 该模型没有推理档位；档位本身认不出也是 null
              tiers: reasoning === null || reasoning === undefined ? null : tiers(reasoning.efforts),
              defaultTier: reasoning && typeof reasoning.defaultEffort === "string" ? reasoning.defaultEffort : null,
            };
            bucket[model.id] = entry;
            index.models.push(entry);
          } catch (error) {
            /* 一条脏数据最多让这一行的徽标消失，绝不瘫痪整个界面 */
          }
        }
      }
      return index;
    }

    /** 目录优先、静态清单兜底：某个模型的档位信息。 */
    function tiersForModel(index, modelId) {
      if (index && index.models) {
        for (var i = 0; i < index.models.length; i += 1) if (index.models[i].id === modelId) return index.models[i];
      }
      var def = resolveModel(modelId);
      if (def === null) return null;
      return {
        id: modelId,
        name: def.name || (DEF_ALIASES[modelId] ? DEF_ALIASES[modelId] : modelId),
        provider: null,
        tiers: def.levels === null ? null : def.count > 0 ? { count: def.count, names: [] } : null,
        defaultTier: def.def || null,
      };
    }

    /** 徽标文案：`8 档` / `不支持`。 */
    function tierCountLabel(tier) {
      return tier === null || !tier.tiers ? "不支持" : tier.tiers.count + " 档";
    }

    /**
     * 菜单内的 focus 统一入口（移植参考实现的 `focusNoScroll`）。
     *
     * 官方换内容时会 `.focus()` 一行，而**不带 preventScroll** 的 focus 会让浏览器把
     * 最近的可滚动祖先滚到那一行 —— 结果就是"翻页那一下动画被 scroll-into-view 吃掉"。
     * 官方自己的那句我们改不了（在它自己的 bundle 里），所以这里做两件事：
     *   1. 我们自己的 focus 一律走这个包装（将来要聚焦什么都不必再想这件事）；
     *   2. 官方那次聚焦的后果由桥在 mutation 回调里**同步**清掉（早于绘制，见 stabilizeScroll）。
     * `if (el)` 的保护是必须的：调用点常常来自可能为 null 的查询结果。
     */
    function focusNoScroll(el) {
      try {
        if (el && typeof el.focus === "function") el.focus({ preventScroll: true });
      } catch (error) {
        /* 聚焦失败只影响键盘可达性，绝不影响注入与拖动 */
      }
    }
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
    var CSS = [
      /* ⚠️ 本插件所有圆角都必须显式写 `corner-shape:round`。
         DSH 主题（@deepseek-ai/dsh-client-ui-theme）全局做了：
             @supports (corner-shape:superellipse(1.5)){
               :root{--dsw-corner-shape:superellipse(1.5)}
               *,:before,:after{corner-shape:var(--dsw-corner-shape)}
             }
         于是**每个元素**的 border-radius 都按超椭圆渲染：`border-radius:50%` 画出来是
         "圆角矩形"（squircle），不是正圆 —— 球看着像方块就是这个原因。
         DSH 自己的 Switch 同样处理（"capsule track and circular thumb opt out of the
         global superellipse"），所以这里照做：要圆就写 round。
         `*` 的特异度是 (0,0,0)，我们每条规则是 (0,1,0)，直接声明即可覆盖，无需 !important。 */
      /* 注入进官方那一行的容器：折行到第二行并铺满整行。
         `--ces-slide` 是**换档滑动**的过渡（快慢两档）：默认快档，拖慢了就换成慢档（见下面的
         data-slide 规则）。四层都读这个变量，所以切换档位时它们必然同步。 */
      ".ces-inline{--ces-accent:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-450,#4d93f8));--ces-slide:" + SLIDE_EASE + ";box-sizing:border-box;flex-basis:100%;width:100%;min-width:0}",
      /* 拖得慢 →（用户要求）动画也慢。只换变量值，不碰各层自己的 transition 声明，
         这样「减少动态效果」那条 transition:none 仍然压得住（同类选择器、源序在后）。 */
      ".ces-inline[data-slide='slow']{--ces-slide:" + SLIDE_EASE_SLOW + "}",
      ".ces-track{position:relative;box-sizing:border-box;height:" + TRACK_HEIGHT + "px;margin-top:2px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l1,rgba(15,17,21,.08));cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}",
      /* 填充层：**左端圆角 = 轨道端头半径**（轨道高度的一半），右端留直角。
         左端必须与轨道自身的端头圆角同心等径：写成 999px 的话，在窄填充上（off 档宽度
         只有一个半径）CSS 会把四角一起收缩，填充轮廓就从球里鼓出去，在球左侧漏出一弯
         蓝色月牙。右端永远是直角，且永远躲在球内 —— 填充终点 = 球心，而球在其圆心那一
         列占满 2×KNOB_RADIUS（≥ 轨道高度）。 */
      ".ces-fill{position:absolute;top:0;bottom:0;left:0;border-radius:" + TRACK_RADIUS + "px 0 0 " + TRACK_RADIUS + "px;corner-shape:round;transition:width var(--ces-slide);pointer-events:none}",
      ".ces-tick{position:absolute;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;corner-shape:round;background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 26%,transparent);pointer-events:none;transition:opacity .18s ease}",
      ".ces-tick[data-on='1']{background:rgba(255,255,255,.5)}",
      /* Max 档：只保留**当前位置**那一个定位点（它本来就被旋钮完整盖住），其余档位的点淡出。
         这一档轨道已经变成紫色星云，灰/白小点压在上面只剩噪点。
         只改透明度、不移除节点：拖动时不会增删 DOM，也就不会打断拖拽与动画。 */
      ".ces-inline[data-max='1'] .ces-tick[data-current='0']{opacity:0}",
      /* 旋钮 = 球：比轨道高，上下各浮出 TRACK_RADIUS-(TRACK_HEIGHT/2) 的一半。
         描边刻意很淡（GPT 客户端实测只有 ~6% 的压暗、约 5px 的软光晕），
         球压在轨道上时靠它把轮廓分出来，压在卡片上时也不脏。 */
      ".ces-knob{position:absolute;top:50%;width:" + KNOB_SIZE + "px;height:" + KNOB_SIZE + "px;margin:" + (-KNOB_RADIUS) + "px 0 0 " + (-KNOB_RADIUS) + "px;border-radius:50%;corner-shape:round;transition:left var(--ces-slide);background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.16),0 0 0 1px rgba(0,0,0,.05);pointer-events:none}",
      ".ces-error{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#e5484d)}",
      /* ── 最高档能量层（纯视觉：紫色星云 + 星尘粒子 + 扫光）─────────────────
         强度由 `--ces-energy`(0..1) 一个变量驱动：外层只做 opacity/box-shadow，
         所以"渐入"是浏览器合成的颜色插值，不需要 JS 逐帧改样式。
         关掉时把粒子动画 `animation-play-state: paused`，不让 22 个隐形元素白烧 GPU。 */
      ".ces-inline[data-energy='1'] .ces-track{box-shadow:0 0 calc(var(--ces-energy,0) * 16px) rgba(168,85,247,.5)}",
      ".ces-inline[data-energy='0'] .ces-star,.ces-inline[data-energy='0'] .ces-energy__sweep{animation-play-state:paused}",
      /* 能量层只覆盖**已填充那一段**（宽度与填充相同）：档位右边没到的部分不显示能量条。
         左端从 0 起、宽度由内联样式给（= 到旋钮圆心），所以它跟着旋钮一起长。 */
      ".ces-energy{position:absolute;top:0;bottom:0;left:0;border-radius:" + TRACK_RADIUS + "px 0 0 " + TRACK_RADIUS + "px;corner-shape:round;overflow:hidden;pointer-events:none;opacity:var(--ces-energy,0);transition:opacity .2s ease,width var(--ces-slide);background:linear-gradient(90deg,#3b1178 0%,#6d28d9 30%,#9333ea 62%,#c084fc 100%)}",
      /* 星星单独一层：**不跟着星云淡入**（否则 high 档会被星云的 0.5 透明度压得看不见）。
         几何与星云层相同（贴着已填充段、圆角裁切），透明度由内联样式给。 */
      ".ces-stars{position:absolute;top:0;bottom:0;left:0;border-radius:" + TRACK_RADIUS + "px 0 0 " + TRACK_RADIUS + "px;corner-shape:round;overflow:hidden;pointer-events:none;transition:opacity .2s ease,width var(--ces-slide)}",
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
      "@media (prefers-reduced-motion: reduce){.ces-energy{transition:none}.ces-tick{transition:none}.ces-knob{transition:none}.ces-fill{transition:none}.ces-stars{transition:none}.ces-energy__sweep{display:none}}",
      /* ── 禁用态：**渲染函数的完整投影**（移植自参考实现）──────────────────
         参考实现用 `classList.toggle("disabled", unsupported)` —— 第二参数每帧同时负责
         "加"与"移除"，所以禁用态永远等于"此刻算出来的状态"，不可能残留。
         这里照做，只是把类换成属性选择器（`data-disabled`），因为滑条根的类名与
         官方菜单的类名空间容易混：`[data-disabled="1"]` 是 (0,1,0)，与其它规则同权重。 */
      ".ces-inline[data-disabled='1']{opacity:.45;pointer-events:none}",
      ".ces-inline[data-disabled='1'] .ces-track{cursor:default}",      /* ── 官方菜单里注入的三处小注记（徽标 / 归属 / API 值）───────────────
         全部用 DSH 设计令牌，浅深主题自动跟随；字体比官方的 13px 小一档，
         并且都 `flex:none` + 单行省略 —— 加进去只改观感，不改官方任何布局机制。 */
      ".ces-menu-badge{flex:none;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:6px;corner-shape:round;color:var(--dsw-alias-label-tertiary,#8a8f98);background:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.06));white-space:nowrap}",
      ".ces-menu-badge[data-off='1']{color:var(--dsw-alias-label-caption,#9aa0ab);opacity:.75}",
      ".ces-menu-provider{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#9aa0ab);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:96px}",
      ".ces-menu-api{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#9aa0ab)}",
      /* ── 翻页（carousel）稳定化：**只压掉布局/滚动的二次位移，不碰官方动画** ──
         官方菜单是同一个面板里换内容（没有双页位移），翻页时的"接缝/闪一下"来自两件事：
           1. 官方 effect 里 `.focus()` 没带 preventScroll → 浏览器会把滚动容器滚到刚聚焦的那一行，
              换内容那一帧就多一次位移（那个容器就是下面这条 `.scrollable`）；
           2. 我们的滑条把"推理等级"那一行加高了 ~48px，浏览器为了不跳内容会**追加滚动**
              （scroll anchoring）。
         下面两条都是纯 CSS 的抑制：`overflow-anchor:none` 关掉 2，滚动位置的重置在
         JS 里（见桥的 `stabilizeScroll`，在换内容那一帧的 mutation 回调里同步做，早于绘制）。
         官方自己的可视结构、间距、圆角、阴影一个都没动，官方 class 一个都没被改写。 */
      ".ces-menu-stable{overflow-anchor:none}",
      ".ces-menu-stable .scrollable{overflow-anchor:none}",
    ].join("\n");

    /**
     * 把样式挂进文档。加载器会把它认领为「本插件产出的 style」（HMR 卸载时一并清理）。
     *
     * @param text   要注入的 CSS；省略 = 本文件那份 `CSS`（官方菜单那条控件）
     * @param marker `data-plugin-css` 的值，用来去重；省略 = 本文件的 STYLE_MARKER
     *
     * ⚠️ 这里踩过一个**真机才暴露**的坑：1.3.0 第一版把自建浮层的样式表当参数传进来
     * （`installStyles(pickerModule.PICKER_CSS)`），可当时这个函数**不收参数** ——
     * 参数被静静丢掉，`.cxp-*` 整套规则从未注入。表现是：入口按钮在（chunk 加载好了），
     * 但面板**没有任何样式**、`position:fixed` 也没生效，于是内容摊进了页面流。
     * 教训：注入类函数的"参数被忽略"是静默失败，必须有断言盯着**文档里真的有那段 CSS**。
     */
    function installStyles(text, marker) {
      try {
        if (typeof document === "undefined" || !document.head) return null;
        var css = typeof text === "string" && text.length > 0 ? text : CSS;
        var tag = typeof marker === "string" && marker.length > 0 ? marker : STYLE_MARKER;
        var existing = document.querySelector('style[data-plugin-css="' + tag + '"]');
        if (existing) return existing;
        var style = document.createElement("style");
        style.setAttribute("data-plugin-css", tag);
        style.textContent = css;
        document.head.appendChild(style);
        return style;
      } catch (error) {
        /* 样式失败只影响观感，绝不影响功能 */
        return null;
      }
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
     * 当前模型真实可用的档位列表（官方 id + 官方显示名，按目录顺序）。
     *
     * 名字只有两种情况会用到 LV 字典：目录条目**没给 name**，或 name 是空白串。
     * 目录给什么就用什么 —— 官方菜单里那一行显示的就是 `efforts[].name`，
     * 插件盖掉它只会让"菜单说 High、滑条说 X-High"。
     */
    function levelsOf(state) {
      var model = modelOf(state);
      var efforts = model && model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
      var out = [];
      for (var i = 0; i < efforts.length; i += 1) {
        var effort = efforts[i];
        if (!effort || typeof effort.id !== "string" || effort.id.length === 0) continue;
        var fallback = normalizeTierId(effort.id);
        out.push({
          id: effort.id,
          name: typeof effort.name === "string" && effort.name.length > 0 ? effort.name : fallback !== null ? fallback.name : effort.id,
        });
      }
      return out;
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

    /** 档位下标 → 该档位在轨道上的百分比（刻度点与旋钮永远对齐）。 */
    function pctFromIndex(index, count) {
      if (count <= 1) return 0;
      var safe = Math.max(0, Math.min(count - 1, index));
      return safe / (count - 1);
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
     * 球心 / 填充终点 / 刻度的水平位置：`轨道端头半径 + pct × (100% − 端头直径)`。
     * 用**轨道**端头半径而不是球半径：pct=0/1 时球心正好落在轨道端头的圆心上，
     * 球于是压过轨道两端（GPT 客户端的观感），同时把填充层的左端半圆完整盖住。
     */
    function knobOffsetOf(pct) {
      var t = Math.round(clamp01(pct) * 10000) / 10000;
      return "calc(" + TRACK_RADIUS + "px + " + t + " * (100% - " + TRACK_RADIUS * 2 + "px))";
    }

    /* ═════════════════ 官方目录访问（每会话一个，永不抛错）═════════════════ */

    /**
     * 每个会话一个访问器。它解决两件真实存在的事：
     *  1. `directoryFor(sessionId)` 在会话作用域/绑定尚未就绪时**按设计抛错**；
     *  2. 目录实例可能被重建（换模型代、连接重置），"抓一次揣着用"会变成永久坏的控件。
     * 所以每次读写都重新解析，解析失败就退避重试；订阅在一次成功解析后建立。
     */
    function createDirectoryAccess(ctx, sessionIds, timers) {
      var listeners = new Set();
      /**
       * **候选会话 id（按可信度排序）**。
       *
       * 为什么是一串而不是一个（真机事故，1.3.6）：渲染器给条目拼 props 的顺序是
       * `{...标准 kit, ...inject 的返回, ...槽注入, ...owner}` —— 而 `inject` 拿到的是
       * **`binding.key`**，它**不一定**等于 kit 里那个 `sessionId`。我们以前 `inject` 返回
       * `{sessionId}`，等于把 kit 里那个正确的值**盖掉**；一旦 `binding.key` 不是本会话的 id，
       * `directoryFor()` 就抛 "resolved no scope / no binding"，界面上只会显示"会话目录未就绪"，
       * 而官方的 `/model` 却一切正常（它用的是命令自己的会话 id）—— 那次排查就是这么绕进去的。
       *
       * 现在：kit 的值优先、inject 的值兜底，谁成功就钉住谁（失败时自动轮换）。
       */
      var candidates = [];
      (Array.isArray(sessionIds) ? sessionIds : [sessionIds]).forEach(function (id) {
        if (typeof id === "string" && id.length > 0 && candidates.indexOf(id) < 0) candidates.push(id);
      });
      /** 上一次成功的候选下标（下次从它开始试）。 */
      var activeIndex = 0;
      /** 最近一次解析失败的原因（给界面用：把"为什么没就绪"说清楚）。 */
      var lastReason = "";
      var lastWarned = "";
      var directory = null;
      var unsubscribe = null;
      var last = EMPTY_SNAPSHOT;
      var retryIndex = 0;
      var retryTimer = null;
      var closed = false;
      var lastLoadAt = 0;
      var heartbeatTimer = null;
      /** load 失败后的退避重试（与"解析目录实例"的退避分开：这两件事失败的原因不同）。 */
      var loadRetryIndex = 0;
      var loadRetryTimer = null;
      /** 主动刷新**全局目录**的次数与时间戳（见 refreshCatalogIfEmpty）。 */
      var catalogRefreshes = 0;
      var lastCatalogRefreshAt = 0;

      function notify() {
        var current = [];
        listeners.forEach(function (listener) { current.push(listener); });
        for (var i = 0; i < current.length; i += 1) {
          try { current[i](); } catch (error) { /* 单个订阅者抛错不影响其它订阅者 */ }
        }
      }

      /**
       * 目录快照是不是"能拿来看"的：有 provider 组，或者宿主明确说已就绪。
       *
       * ⚠️ 为什么不能用 `status === "ready"` 一条判据：宿主那边 `buildModelCatalog()` 是把
       * **当前已注册的 LLM provider** 列出来（`ctx.llm.listProviders()`），启动期 provider 还没
       * 注册完时它会返回一个**合法的空目录**（`groups: []`、`failures: []`、status 照样是 ready）。
       * 那种"就绪但空"最坑：界面是"模型 + 没有 provider"，而且**再 load 也不会重新拉**
       * （`ModelCatalogDirectory.load()` 见到 status=ready 就短路返回缓存值）。
       */
      function snapshotUsable(snapshot) {
        if (!snapshot || typeof snapshot !== "object") return false;
        if (Array.isArray(snapshot.groups) && snapshot.groups.length > 0) return true;
        return snapshot.status === "ready" && Array.isArray(snapshot.failures) && snapshot.failures.length > 0;
      }

      /** 当前目录的 store 快照（拿不到就 null）。 */
      function currentSnapshot() {
        if (directory === null) return null;
        try {
          return directory.store.getSnapshot();
        } catch (error) {
          return null;
        }
      }

      /** 当前目录的 store 快照是不是"能用"（拿不到实例 = 不能用）。 */
      function storeUsable() {
        return snapshotUsable(currentSnapshot());
      }

      /**
       * 还要不要继续退避重拉？
       *
       * **只治"目录根本没到"**（idle / loading / error）—— 这三种 `load()` 有希望改变现状。
       * "就绪但空"必须**排除**：那种情况下 `load()` 会成功返回、store 却依然空，
       * 退避计数器被重置 → 就变成 60ms 一轮的**活锁**（离线测试直接跑不完，真机上则是白打宿主）。
       * 它交给 `refreshCatalogIfEmpty`（有 8 秒冷却 + 3 次上限）去治。
       */
      function needsLoadRetry(snapshot) {
        if (!snapshot || typeof snapshot !== "object") return true;
        return snapshot.status !== "ready" && snapshot.status !== "selecting";
      }

      /**
       * 顺手**主动刷一次全局目录**：只在"就绪但空"时做（启动期 provider 还没注册的典型形态），
       * 而且有冷却与次数上限（不许变成 RPC 风暴）。
       *
       * 为什么需要它：那个空结果是**被缓存的** —— `ModelCatalogDirectory.load()` 见到
       * `status === "ready"` 就短路，所以光 `load()` 不会重新问宿主；官方那边靠
       * `llm/adapters-updated` 这类远端事件调 `refresh()` 来治，而**那些事件不一定在启动后再来**。
       * 1.3.2 之前有官方那颗席按钮跟我们一起渲染，它至少是另一个"再拉一次"的入口；
       * 接管之后我们是**唯一**的读取方，就得自己会治这一下。
       *
       * `catalog` 是官方 resolver 上的实例字段（不是 Service 方法）—— 属于**借用内部**：
       * 所以全程 typeof/try 兜住，官方哪天改了就静默退回"只显示空目录"，绝不抛给渲染层。
       */
      function refreshCatalogIfEmpty(snapshot) {
        if (closed || catalogRefreshes >= CATALOG_REFRESH_MAX) return;
        if (!snapshot || typeof snapshot !== "object") return;
        if (!Array.isArray(snapshot.groups) || snapshot.groups.length > 0) return;
        if (snapshot.status !== "ready") return;
        var now = Date.now();
        if (now - lastCatalogRefreshAt < CATALOG_REFRESH_COOLDOWN_MS) return;
        var models = ctx && ctx.modelDirectories ? ctx.modelDirectories : null;
        var catalog = models && models.catalog ? models.catalog : null;
        if (catalog === null || typeof catalog.refresh !== "function") return;
        lastCatalogRefreshAt = now;
        catalogRefreshes += 1;
        try {
          catalog.refresh();
        } catch (error) {
          /* 借用的内部：失败就当没这回事（界面照旧显示"没有可用的 provider"） */
        }
      }

      /** load 失败（或 load 完 store 还不可用）→ 按退避再来，直到心跳接手。 */
      function scheduleLoadRetry() {
        if (closed || loadRetryTimer !== null || directory === null) return;
        if (loadRetryIndex >= RETRY_DELAYS.length) return;
        var delay = RETRY_DELAYS[loadRetryIndex];
        loadRetryIndex += 1;
        loadRetryTimer = timers.set(function () {
          loadRetryTimer = null;
          if (closed) return;
          var snapshot = currentSnapshot();
          if (snapshotUsable(snapshot) || !needsLoadRetry(snapshot)) return;
          kickLoad(true);
          if (!storeUsable()) scheduleLoadRetry();
        }, delay);
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
        if (candidates.length === 0) {
          noteReason("拿不到会话 id（标准 props 与 binding.key 都是空的）");
          return directory;
        }
        /*
         * 逐个候选试：`directoryFor(id)` 按设计会对"解析不出 scope/binding 的会话 id"**抛错**，
         * 所以"错的 id"在这里表现为异常，而不是 null —— 抛了就换下一个候选（见上面的长注释）。
         */
        for (var i = 0; i < candidates.length && fresh === null; i += 1) {
          var index = (activeIndex + i) % candidates.length;
          var id = candidates[index];
          try {
            var hit = ctx.modelDirectories.directoryFor(id);
            if (hit && hit.store && typeof hit.store.getSnapshot === "function") {
              fresh = hit;
              activeIndex = index;
              lastReason = "";
            } else {
              noteReason('directoryFor("' + id + '") 没有返回可用的目录');
            }
          } catch (error) {
            noteReason(error && error.message ? String(error.message) : String(error));
          }
        }
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

      /**
       * 记下失败原因：**每换一条新原因往控制台报一次**（同一条不重复刷屏）。
       *
       * 以前这里是静默 catch —— 结果真机上"拿不到目录"只表现为面板上一句"未就绪"，
       * 具体是 no scope 还是 no binding、是哪个 id，全都看不见，只能靠猜。
       */
      function noteReason(message) {
        lastReason = message;
        if (message === lastWarned) return;
        lastWarned = message;
        try {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[" + PACKAGE_ID + "] 会话目录还没就绪：" + message);
          }
        } catch (error) { /* 控制台不可用就算了 */ }
      }

      /**
       * 主动复查 + 兜底重拉：心跳与"面板打开"都会走到这里。
       *
       * 返回是否换了目录实例。
       */
      function recheck() {
        if (closed) return false;
        var before = directory;
        var after = resolve();
        notifyLoadFallbacks();
        if (after !== null && after !== before) {
          notify();
          return true;
        }
        return false;
      }

      /**
       * 目录"没到能用"时统一在这里补两件事：
       *   1. **就绪但空** → 主动刷一次全局目录（有冷却/上限）；
       *   2. **还没就绪 / 上一轮 load 失败或卡住** → 再拉一次（`kickLoad` 自带 400ms 节流）。
       * 心跳会周期性地走到这里，所以启动期的一次抖动不会再变成"永久空目录"。
       */
      function notifyLoadFallbacks() {
        if (closed || directory === null) return;
        var snapshot = currentSnapshot();
        if (snapshotUsable(snapshot)) return;
        refreshCatalogIfEmpty(snapshot);
        if (needsLoadRetry(snapshot)) kickLoad();
      }

      /**
       * 心跳定时器**不该阻止进程退出**。
       *
       * 它是永久重复的（只要还有订阅者就一直排下一轮），在 Node 下会让事件循环永远不空 ——
       * 离线测试跑完 726 项断言后进程却退不出去，就是这条踩出来的。
       * 浏览器里 `setTimeout` 返回数字、没有 `unref`，这里自动跳过（对宿主零影响）。
       */
      function unrefTimer(handle) {
        if (handle && typeof handle.unref === "function") {
          try { handle.unref(); } catch (error) { /* 忽略 */ }
        }
      }

      /** 低频心跳：只有存在订阅者时才跑，dispose 时清掉。 */
      function scheduleHeartbeat() {
        if (closed || heartbeatTimer !== null) return;
        heartbeatTimer = timers.set(function () {
          heartbeatTimer = null;
          if (closed) return;
          recheck();
          /*
           * recheck() 里已经带了"不可用就重拉"的兜底，但它只在**目录实例存在**时才动手；
           * 这里再走一次是给"解析失败/刚被换掉"兜底 —— 两处都幂等，重复调用无副作用。
           */
          notifyLoadFallbacks();
          scheduleHeartbeat();
        }, DIRECTORY_HEARTBEAT_MS);
        unrefTimer(heartbeatTimer);
      }

      function stopHeartbeat() {
        if (heartbeatTimer === null) return;
        try { timers.clear(heartbeatTimer); } catch (error) { /* 忽略 */ }
        heartbeatTimer = null;
      }

      /**
       * 主动拉一次目录（不 load 的话 store 停在 idle，档位列表是空的）。
       *
       * @param force `true` = 绕过 400ms 节流（退避定时器与心跳自己在控制节奏）。
       */
      function kickLoad(force) {
        if (closed || directory === null || typeof directory.load !== "function") return;
        var now = Date.now();
        if (force !== true && now - lastLoadAt < 400) return;
        lastLoadAt = now;
        var target = directory;
        var attempt = null;
        try {
          attempt = Promise.resolve(target.load());
        } catch (error) {
          attempt = Promise.reject(error);
        }
        attempt.then(function () {
          if (closed) return;
          var snapshot = currentSnapshot();
          if (snapshotUsable(snapshot)) {
            loadRetryIndex = 0;
            return;
          }
          // load 成功但目录还是空 → 主动刷全局目录（有冷却/上限）；只有"根本没到"才继续退避
          refreshCatalogIfEmpty(snapshot);
          if (needsLoadRetry(snapshot)) scheduleLoadRetry();
        }, function () {
          if (closed) return;
          // 失败原因由 store 的 error 字段呈现（面板会显示），这里只负责继续自愈
          scheduleLoadRetry();
        });
      }

      return {
        getSnapshot: function () {
          if (closed) return EMPTY_SNAPSHOT;
          /**
           * **每次都复查目录实例**（不只是 `directory === null` 时）。
           *
           * 宿主会重建该会话的 `ModelDirectory`（父子会话换 binding、会话作用域重建等），
           * 而 `resolve()` 自带短路（`fresh === directory` 就直接返回），复查的代价只是一次
           * 同步查表。少了这一步，读路径会永久停在**已 dispose 的旧实例**上：界面静默冻在旧
           * 档位表（旧 store 再不更新、`select()` 走 disposed 分支），而写路径（`directory()`）
           * 却进了新实例 —— 正是下面 `directory()` 那句注释想避免的事。
           */
          resolve();
          // 顺手把"还没就绪/就绪但空"的兜底也走一遍（两处都有节流，渲染期调用是安全的）。
          notifyLoadFallbacks();
          if (directory === null) scheduleRetry();
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
          // 同上：订阅时也复查一次 —— 实例换了就在这里顺手把订阅重挂到新 store 上
          resolve();
          if (directory === null) scheduleRetry();
          scheduleHeartbeat(); // 有订阅者了，开始主动复查（宿主换实例时旧实例不会再通知我们）
          // StrictMode 会订阅/退订各跑一次；退订只清订阅，不永久关闭访问器。
          return function () {
            listeners.delete(listener);
          };
        },
        /** 显式复查（面板打开时调一次：那是用户真正要看数据的时刻）。 */
        refresh: function () {
          recheck();
          kickLoad();
        },
        /** 取当前真正可写的目录（load/select 在调用时重新解析，避免用失效实例）。 */
        directory: function () {
          var fresh = resolve();
          return fresh !== null ? fresh : directory;
        },
        /**
         * 目录走到哪一步了（界面照着说人话，见 `phaseOf`）。
         *
         * - `unresolved`：`directoryFor(sessionId)` 一直抛（会话作用域/绑定还没就绪）或还没拿到 store —— **我们这边**的事；
         * - `loading`：拿到了 store，但宿主目录还没就绪（idle/loading）；
         * - `empty`：宿主**就绪了但一个 provider 都没列出来** —— 宿主那边的事（例如账号 provider 拿不到令牌时
         *   它会**静默返回空模型列表**，`llm-deepseek-account` 的 `discoverModels` 就是这个行为）；
         * - `ready`：有 provider；
         * - `error`：目录报了错（原因由快照的 error 字段给出）。
         */
        phase: function () {
          if (closed) return "closed";
          /*
           * **一个会话 id 都没有**：这说明这个位置还没有会话（DSH 的输入区在"新会话"空白壳里
           * 也会渲染，那时 `conversation.composer.bar` 所在的作用域是 session-maybe，
           * `binding.key` 是 undefined）。这时说"正在重试"是误导 —— 没有会话可重试，
           * 发一条消息、或打开一个已有会话，会话一出现组件就重挂并拿到真正的 id。
           */
          if (candidates.length === 0) return "no-session";
          if (directory === null) return "unresolved";
          var snapshot = currentSnapshot();
          if (!snapshot || typeof snapshot !== "object") return "unresolved";
          if (Array.isArray(snapshot.groups) && snapshot.groups.length > 0) return "ready";
          if (snapshot.status === "error") return "error";
          if (snapshot.status === "ready" || snapshot.status === "selecting") return "empty";
          return "loading";
        },
        /**
         * "为什么还没就绪"的原话（宿主抛的异常信息 / 我们自己的判定），给界面与排查用。
         * 空串 = 当前没有失败原因（就绪了，或者还没试过）。
         */
        reason: function () { return lastReason; },
        /** 试过的候选会话 id（离线断言与排查用）。 */
        sessionIds: function () { return candidates.slice(); },
        load: kickLoad,
        dispose: function () {
          closed = true;
          listeners.clear();
          if (retryTimer !== null) {
            try { timers.clear(retryTimer); } catch (error) { /* 忽略 */ }
            retryTimer = null;
          }
          if (loadRetryTimer !== null) {
            try { timers.clear(loadRetryTimer); } catch (error) { /* 忽略 */ }
            loadRetryTimer = null;
          }
          stopHeartbeat();
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
     *
     * 返回 `{ row, menu }`：行是注入目标，菜单是"这一屏内容是不是我的"的判据
     * （徽标 / 归属标签 / API 值三处注记都只往这颗菜单里写）。认不出就返回 null。
     */
    function findEffortRow(doc, composer) {
      var menu = findOpenMenu(doc, composer);
      if (menu === null) return null;
      // 判据已经由 findOpenMenu 保证，这里可以直接取（items 恰好两个）
      var items = menu.querySelectorAll('button[role="menuitem"]');
      for (var j = 0; j < items.length; j += 1) {
        var label = firstSpanText(items[j]);
        for (var k = 0; k < EFFORT_ROW_LABELS.length; k += 1) {
          if (label === EFFORT_ROW_LABELS[k]) return { row: items[j], menu: menu };
        }
      }
      // 文案认不出（官方改了措辞/别的语言）就按官方固定顺序：第 2 个 menuitem 是推理等级。
      return { row: items[1], menu: menu };
    }

    /* ── 官方菜单里的三处小注记（徽标 / 归属 / API 值）──────────────────────
       官方二级页的 DOM 形状（逐字对照真产物 `dsh-client-ui-model-selection/lib/client.js`）：
         · 模型行      `button[role="menuitemradio"][id="${id}-model-${index}"]`，内部
                       `.optionCopy > .modelName` + `.check`
         · 档位行      `button[role="menuitemradio"]`（没有 id 的那种），内部同上，
                       但名字是档位的**显示名**、`aria-checked` 按当前档位
         · 根面板两行  `button[role="menuitem"]` → `.cellLabel` / `.cellValue` / `.cellChevron`
       三处注记**只 append**，不改官方任何文字、不碰 hover/focus 机制。 */

    /** 官方菜单里那个滚动容器（`wq12jW_groups` 上带 `scrollable` 这个**稳定的字面量 class**）。 */
    function findScrollContainer(menu) {
      try {
        var found = menu.querySelectorAll(".scrollable");
        return found.length > 0 ? found[0] : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * 一个模型行显示的**模型名**（官方是 `.optionCopy > .modelName` 里的文字）。
     * 认不出就退到整行文字（徽标文案要的只是名字，认不准就交给静态清单的 id 判定）。
     */
    function modelNameOf(row) {
      try {
        var name = row.querySelectorAll('[class*="modelName"]');
        if (name.length > 0) return String(name[0].textContent);
        var copy = row.querySelectorAll('[class*="optionCopy"]');
        if (copy.length > 0) return String(copy[0].textContent);
      } catch (error) {
        /* 认不出就算了 */
      }
      return "";
    }

    /** 把菜单里所有"当前档位的候选行"按文档顺序翻出来（官方的 pane 结构里只有档位页有它们）。 */
    function findEffortOptionRows(menu) {
      try {
        var all = menu.querySelectorAll("button");
        var out = [];
        for (var i = 0; i < all.length; i += 1) {
          var node = all[i];
          if (typeof node.getAttribute !== "function") continue;
          if (node.getAttribute("role") !== "menuitemradio") continue;
          var id = node.getAttribute("id");
          if (id !== null && /(^|-)model-\d+$/.test(id)) continue; // 模型行（官方给它们编了号）
          out.push(node);
        }
        return out;
      } catch (error) {
        return [];
      }
    }

    /**
     * 只找"打开的那颗席对应的菜单"，**不要求它是根面板**。
     *
     * 与 `findEffortRow` 分开是必要的：模型列表/档位列表里没有 `role="menuitem"`，
     * 而三处注记恰恰要在那两屏里生效；反过来，滑条只在根面板那一行存在时才注入。
     * 判据仍然是官方的语义锚点：`aria-haspopup="menu"` + `aria-expanded="true"` +
     * `aria-controls` → `getElementById`，再加上"最后两段必须是 `menuitem`"这条结构约束
     * （与 `findEffortRow` 完全一致 —— 结构变了就一起停手，不会出现"徽标在、滑条不在"的半截状态）。
     */
    function findOpenMenu(doc, composer) {
      if (!doc || !composer || typeof doc.querySelectorAll !== "function") return null;
      try {
        var seats = doc.querySelectorAll('button[aria-haspopup="menu"][aria-expanded="true"]');
        var seat = null;
        for (var i = 0; i < seats.length; i += 1) {
          if (!composer.contains(seats[i])) continue;
          /*
           * 1.3.2 起**自建浮层的触发器也长这样**（`aria-haspopup="menu"` + 展开时 `aria-expanded="true"`），
           * 而且它和官方席同在 `conversation.input.model` 那一格（接管成功时官方那颗不渲染，
           * 退回工具行时两颗并存）。所以这里不能"抓到第一颗就收手"：
           * 没有 `aria-controls` 的按钮**不是官方的席**（官方那颗一定带 `${id}-menu`），
           * 跳过它继续找 —— 否则自建面板一打开，官方菜单那条路（默认关闭）会整帧停手。
           */
          if (typeof seats[i].getAttribute === "function" && !seats[i].getAttribute("aria-controls")) continue;
          seat = seats[i];
          break;
        }
        if (seat === null) return null;
        var menuId = typeof seat.getAttribute === "function" ? seat.getAttribute("aria-controls") : null;
        var menu = menuId && typeof doc.getElementById === "function" ? doc.getElementById(menuId) : null;
        if (!menu) return null;
        if (menu.querySelectorAll('button[role="menuitem"]').length !== 2) return null;
        return menu;
      } catch (error) {
        return null;
      }
    }

    /**
     * 按**模型名**查目录条目（官方列表上显示的就是 `model.name`，不一定等于 `model.id`，
     * 例如 id `deepseek-v41-flash` / 显示名 `DeepSeek-V41-Flash`）。先精确、再归一化，
     * 都命中不了就返回 null —— 这样跨 provider 的模型行也能拿到自己那一份档位信息。
     */
    function entryByName(index, name) {
      if (!index || !index.models || typeof name !== "string" || name.length === 0) return null;
      var flat = normalizeModelKey(name);
      var i;
      for (i = 0; i < index.models.length; i += 1) if (index.models[i].name === name) return index.models[i];
      for (i = 0; i < index.models.length; i += 1) if (normalizeModelKey(index.models[i].name) === flat) return index.models[i];
      for (i = 0; i < index.models.length; i += 1) if (normalizeModelKey(index.models[i].id) === flat) return index.models[i];
      return null;
    }

    /** 模型名/ id 的比较键：小写、去掉一切非字母数字（`DeepSeek-V41-Flash` ↔ `deepseek-v41-flash`）。 */
    function normalizeModelKey(value) {
      return typeof value === "string" ? value.replace(/[^a-z0-9]+/gi, "").toLowerCase() : "";
    }

    /**
     * 一个模型行的**档位信息**：目录命中就用目录的；目录里没有这一行（可见模型集变了、
     * 或者目录这一代还没列到它）才退到静态清单；两条都没有就是 null（不写徽标）。
     */
    function describeModelTier(index, modelName, modelId) {
      var entry = entryByName(index, modelName);
      if (entry !== null) return { tiers: entry.tiers, name: entry.name, model: entry };
      var def = resolveModel(modelId);
      if (def === null) return null;
      return {
        id: modelId,
        name: def.name || (DEF_ALIASES[modelId] ? DEF_ALIASES[modelId] : modelId),
        provider: null,
        tiers: def.levels === null ? null : def.count > 0 ? { count: def.count, names: [] } : null,
        defaultTier: def.def || null,
      };
    }

    /** 徽标节点：`8 档` / `不支持`。文字与 title 都从这份 tier 描述里算，一处真相。 */
    function buildModelBadge(doc, tier) {
      var badge = doc.createElement("span");
      badge.className = "ces-menu-badge";
      badge.setAttribute("data-ces-part", "model-badge");
      var supported = tier !== null && tier.tiers !== null;
      badge.setAttribute("data-off", supported ? "0" : "1");
      badge.textContent = tierCountLabel(tier);
      var names = supported && tier.tiers.names && tier.tiers.names.length > 0 ? tier.tiers.names.join(" / ") : "";
      var title = supported
        ? tier.tiers.count + " 档" + (names.length > 0 ? "：" + names : "")
        : "该模型不支持推理等级";
      badge.setAttribute("title", title);
      return badge;
    }

    /** 档位行右侧那枚灰色原始取值（`xhigh` 之类）—— 发送请求时用的就是它。 */
    function buildApiValue(doc, effortId) {
      var api = doc.createElement("span");
      api.className = "ces-menu-api";
      api.setAttribute("data-ces-part", "api-value");
      api.textContent = effortId;
      api.setAttribute("title", "API: " + effortId);
      return api;
    }

    /** 根面板那一行的归属标签：当前模型属于哪个 provider（一级页就能看出切换生效）。 */
    function buildProviderTag(doc, provider) {
      var tag = doc.createElement("span");
      tag.className = "ces-menu-provider";
      tag.setAttribute("data-ces-part", "provider-tag");
      tag.textContent = provider;
      tag.setAttribute("title", provider);
      return tag;
    }

    /**
     * 把三处注记写进当前这一屏的官方菜单。**每次扫描重算**（不做缓存、不增量 patch）——
     * 这正是参考实现那条"禁用态 = 渲染函数的完整投影"的同一条纪律：官方重渲染换掉节点、
     * 翻页换了内容、目录换了代，这里都会在下一次 mutation 里重新算成正确的样子，
     * 绝不会残留上一次的附件。代价是每个 mutation 帧十几次选择器查询（可忽略）。
     */
    function decorateMenu(options) {
      var doc = options.doc;
      var menu = options.menu;
      var index = options.index || { byProvider: {}, models: [] };
      var provider = typeof options.provider === "string" ? options.provider : "";
      var efforts = Array.isArray(options.efforts) ? options.efforts : [];
      try {
        // 1）每颗模型行一个档位徽标
        var rows = menu.querySelectorAll('button[role="menuitemradio"]');
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i];
          if (typeof row.getAttribute !== "function") continue;
          // 官方**只给模型行编了 id**（`${id}-model-${index}`），档位行没有 —— 用它区分两页。
          // **不能**用 id 里的序号去索引目录：那个序号是"筛选后"的位置，而 `index.models`
          // 是按 provider 分组展平的全量，跨 provider/搜索时对不上。所以位置只做过滤，
          // 真正的身份取自行上显示的名字（官方显示的就是模型名，和目录 name 同一份数据）。
          var id = row.getAttribute("id");
          if (typeof id !== "string" || !/(^|-)model-\d+$/.test(id)) continue;
          var name = modelNameOf(row);
          var tier = describeModelTier(index, name, name);
          if (tier === null) continue; // 目录与静态清单都不认识 → 不写（不瞎标）
          if (row.querySelectorAll(".ces-menu-badge").length > 0) continue; // 已经标过
          var copy = row.querySelectorAll('[class*="optionCopy"]');
          var host = copy.length > 0 ? copy[0] : row;
          host.appendChild(buildModelBadge(doc, tier));
        }

        // 2）档位页：每一行右侧的原始 API 值
        var effortRows = findEffortOptionRows(menu);
        for (var j = 0; j < effortRows.length; j += 1) {
          var effortRow = effortRows[j];
          if (effortRow.querySelectorAll(".ces-menu-api").length > 0) continue;
          var effort = efforts[j];
          if (!effort || typeof effort.id !== "string" || effort.id.length === 0) continue;
          effortRow.appendChild(buildApiValue(doc, effort.id));
        }

        // 3）根面板：模型那一行的归属标签（provider 名）
        if (provider.length > 0) {
          var cells = menu.querySelectorAll('button[role="menuitem"]');
          if (cells.length > 0) {
            var cell = cells[0];
            if (cell.querySelectorAll(".ces-menu-provider").length === 0) {
              var tag = buildProviderTag(doc, provider);
              // 挂在**最后**：官方那一行是 `.cellLabel`(flex:none) + `.cellValue`(flex:auto)
              // + `.cellChevron`(flex:none)，所以追加到末尾只会在箭头右侧多一小段灰字，
              // 不会改变官方三个节点的顺序，也不动它们的任何样式。
              // 用 `insertBefore(tag, null)` 是为了让假 DOM 与真 DOM 走同一条插入路径。
              if (typeof cell.insertBefore === "function") cell.insertBefore(tag, null);
              else cell.appendChild(tag);
            }
          }
        }
      } catch (error) {
        /* 注记失败只影响观感，绝不拖垮注入与拖动 */
      }
    }

    /**
     * 监听文档，把滑条容器挂进官方那一行。
     *
     * @param options.doc      宿主 document
     * @param options.win       宿主 window（派发 resize 让官方重测菜单位置）
     * @param options.anchor    () => 本会话在 composer 里的锚点元素（用来判定"哪颗席是我的"）
     * @param options.active    () => boolean，当前是否值得注入（没有档位就不注入，免得白加高）
     * @param options.onChange  (host | null) => void
     * @param options.decorate  () => ({ index, provider, efforts } | null)，当前这一屏的注记数据
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
      /**
       * 组件交给桥的"当前这一屏该怎么注记"。**每帧现读**（见 decorateMenu 的注释）：
       * 读到什么就画什么，读不到就什么都不加。
       */
      var decorateSource = typeof options.decorate === "function" ? options.decorate : null;

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

      /**
       * 翻页/换内容那一帧的滚动稳定化（移植参考实现的 `setView` 里那两句防御性清零）。
       *
       * 官方换内容时会重新 `.focus()` 一行（**没有带 preventScroll**），浏览器于是把
       * 滚动容器滚到那一行；加上我们给"推理等级"那一行加的 ~48px 高度触发的 scroll
       * anchoring，翻页时就会多出一次位移 —— 看起来就是"进二级页那一下动画没了/接缝闪一下"。
       * 这里在 mutation 回调里**同步**把滚动位置清回去：mutation 回调是微任务，早于绘制，
       * 所以这一帧不会把位移画出来。
       *
       * 只在"确实滚过"时才写（写 0 到已经是 0 的属性是空操作，但省掉它对键盘导航更保险）。
       */
      function stabilizeScroll(menu, container) {
        try {
          if (container && container.scrollTop > 0) container.scrollTop = 0;
          if (menu && menu.scrollTop > 0) menu.scrollTop = 0;
          if (container && container.scrollLeft > 0) container.scrollLeft = 0;
        } catch (error) { /* 只影响观感 */ }
      }

      /**
       * 把官方的滚动容器标成"不再为内容变化追加滚动"（`overflow-anchor:none`），
       * 并挂上我们自己的稳定化类。只加 class，不改官方既有 class。
       */
      function tagMenu(menu) {
        try {
          if (menu && menu.classList && typeof menu.classList.add === "function") menu.classList.add("ces-menu-stable");
          var container = findScrollContainer(menu);
          if (container && container.classList && typeof container.classList.add === "function") {
            container.classList.add("ces-menu-stable");
          }
          return container;
        } catch (error) {
          return null;
        }
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
          /*
           * 一条链、两层判据：
           *   · `menu`   —— 打开的是**我这一屏**的官方菜单吗（语义锚点 + 结构约束）
           *   · `found`  —— 这一屏是不是根面板、且那一行认得出（只有这时才注入/加高）
           * 三处注记只需要前者（模型列表/档位列表里根本没有 menuitem），
           * 滑条两者都要 —— 所以"该不该动手"由组件给的 `active()` 决定，这里只管形状。
           */
          var menu = findOpenMenu(doc, composer);
          var found = menu === null ? null : findEffortRow(doc, composer);
          var container = menu === null ? null : tagMenu(menu);
          // 翻页是"同一个菜单换内容"，所以稳定化必须**每帧**做，而不能只在首次注入时做
          if (menu !== null) stabilizeScroll(menu, container);
          if (decorateSource !== null && menu !== null) {
            var spec = null;
            try { spec = decorateSource(); } catch (error) { spec = null; }
            if (spec !== null && spec !== undefined) {
              decorateMenu({
                doc: doc,
                menu: menu,
                index: spec.index,
                provider: spec.provider,
                efforts: spec.efforts,
              });
            }
          }

          // 已经挂好且那一行还在 → 什么都不做
          if (current !== null && current.row && doc.documentElement && doc.documentElement.contains(current.row)) return;
          // 不再是根面板、或那一行认不出 → 撤掉容器（但那三处注记仍按上面那样保留）
          if (found === null) { detach(); return; }

          var row = found.row;
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

          var box = doc.createElement("div");
          box.className = "ces-inline";
          box.setAttribute("data-ces-part", "host");
          row.appendChild(box);

          current = { row: row, container: box, value: value, previous: previous, menu: menu };
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
      // kit 的值优先；`inject` 拿到的 `binding.key` 只做兜底（它不一定等于本会话的 id，见 `usePickerAccess`）
      var sessionId = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId
        : (typeof props.__sessionKey === "string" && props.__sessionKey.length > 0 ? props.__sessionKey : null);
      var locked = props.locked === true;
      var ctx = props.__ctx;

      /** 系统的「减少动态效果」只影响**特效强度**，不影响功能（放缓而不是冻住）。 */
      var reducedMotion = false;
      try {
        reducedMotion = typeof window !== "undefined"
          && typeof window.matchMedia === "function"
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
      } catch (error) {
        reducedMotion = false;
      }

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

      var levels = levelsOf(state);
      var effectiveId = effectiveEffortId(state);
      var committedIndex = indexOfLevel(levels, effectiveId);
      var levelCount = levels.length;
      /**
       * 目录快照建出来的"provider → 模型 → 档位"能力索引（每个档位/模型集变化时重建一次）。
       * 它是**参考实现里那张静态能力清单的位置**，只不过填充它的是宿主下发的活数据。
       */
      var catalogIndex = React.useMemo(function () { return buildCatalogIndex(state); }, [state]);
      /** 当前模型所属的 provider（根面板归属标签用）。 */
      var providerId = state && state.current && typeof state.current.provider === "string" ? state.current.provider : "";

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
      var commitRef = React.useRef({ timer: null, inFlight: false, queued: null });
      var draggingRef = React.useRef(false);
      /**
       * 按下锚点：指针位置（档位单位）、落到了哪一档、以及"判定线是否与落点冲突"。
       * 只有冲突时才需要死区；不冲突时判定线直接说话 —— 起拖不能有额外延迟。
       */
      var pressRef = React.useRef({ u: 0, index: 0, conflict: false, active: false });
      /** 上一次换档的时刻（毫秒）：用来分辨"手在慢慢挪"还是"在快拖"。 */
      var lastStepAtRef = React.useRef(0);
      /** 当前是否走慢档动画：state 用来渲染 data-slide，ref 供事件处理里同步读写。 */
      var slideSlowState = React.useState(false);
      var slideSlow = slideSlowState[0];
      var setSlideSlow = slideSlowState[1];
      var slideSlowRef = React.useRef(false);
      var levelCountRef = React.useRef(0);
      var seatNamesRef = React.useRef([]); // 全部已知档位名（认官方席按钮上的那段文字用）
      var bridgeRef = React.useRef(null);
      /**
       * 桥的"这一刻该不该动手 / 该注记什么"的唯一数据源。
       * 用 ref 而不是 state：桥的回调（MutationObserver）拿不到渲染期的闭包值，
       * 而这个 ref 每次渲染都被刷成最新的一份，读到的永远是"此刻真实的样子"。
       */
      var decorateRef = React.useRef({ index: { byProvider: {}, models: [] }, provider: "", efforts: [], modelCount: 0 });
      decorateRef.current = {
        index: catalogIndex,
        provider: providerId,
        efforts: levels,
        modelCount: catalogIndex.models.length,
      };
      levelCountRef.current = levelCount;

      /* 桥：找到官方菜单那一行，把滑条容器挂进去 */
      React.useEffect(function () {
        if (sessionId === null || !ctx) return undefined;
        var bridge = createMenuBridge({
          doc: typeof document === "undefined" ? null : document,
          win: typeof window === "undefined" ? null : window,
          anchor: function () { return anchorRef.current; },
          // 目录里**一个模型都没有**、或当前模型一个档位都没有时不动手：
          // 前者是起步期/目录失败（没什么可注记，也不必加高），后者官方根本不会渲染那一行。
          active: function () {
            var now = decorateRef.current;
            return now.modelCount > 0 && now.efforts.length > 0;
          },
          onChange: function (next) { setHost(next); },
          // 收起态那一行显示的档位名（官方 trigger 里的文字就是它）；给全部名字更抗"官方还没重渲染"
          seatLabels: function () { return seatNamesRef.current; },
          // 官方菜单三处注记的数据（徽标 / 归属 / API 值）：每帧现读 ref，见 decorateRef 注释
          decorate: function () { return decorateRef.current; },
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
       *
       * 依赖里再加一个 `catalogIndex.models.length`：档位数没变、但**模型集**刚到时
       * （例如目录先只列了当前模型），徽标那一批注记也要补上，而这时同样没有 DOM 变化。
       */
      React.useEffect(function () {
        if (bridgeRef.current !== null) bridgeRef.current.scan();
      }, [levelCount, catalogIndex.models.length]);

      // 乐观值：提交后先按用户选的那一档显示，直到宿主真实回报（或超时回滚）。
      var optimisticId = optimistic !== null && typeof optimistic.id === "string" ? optimistic.id : null;
      var optimisticIndex = optimisticId === null ? -1 : indexOfLevel(levels, optimisticId);

      // **已生效**的档位（乐观值优先，其次真实值）：收起态那一行显示的是它，不是拖动中的草稿。
      var effectiveIndex = committedIndex >= 0 ? committedIndex : 0;
      if (optimisticIndex >= 0) effectiveIndex = optimisticIndex;
      var effectivePct = pctFromIndex(effectiveIndex, levelCount);
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
      var shownLevel = levels[shownIndex] || null;

      // 三个由**位置**连续驱动的量：填充色（蓝→紫→深紫）、能量强度（星云+星星渐入）、位置速率。
      var energy = energyFor(shownPct);
      var energyOn = energy > 0;
      // Max 档 = 最高那一档（位置在最右端）。这一档不再显示其他档位的定位点（见样式表 data-max 规则）。
      var atMax = levelCount > 0 && shownIndex >= levelCount - 1;
      var fillBackground = fillBackgroundFor(shownPct);
      var knobOffset = knobOffsetOf(shownPct);

      /**
       * 「禁用态 = 渲染函数的完整投影」（参考实现那条工程纪律的移植）。
       *
       * 参考实现用 `classList.toggle("disabled", unsupported)` —— 布尔第二参数**每帧同时负责
       * 加与移除**，所以禁用态永远等于"此刻算出来的状态"，不可能残留。这里就是那一条：
       * `unsupported` 每一帧从最新快照重算，**不经过任何可能僵住的 state**；
       * 渲染时再把它投影到 `data-disabled` 上（CSS 里 `.ces-inline[data-disabled='1']` 负责灰化）。
       *
       * **为什么门在"4 档模型"上**：宿主下发的档位表是权威的，但它**不是同一个语义的字段**：
       * 模型没有推理能力时 `reasoning` 整个缺席。这时官方菜单**根本不会渲染"推理等级"那一行**，
       * 滑条也就无处可挂 —— 所以"禁用"在真宿主里首先表现为"这一栏不存在"。
       * 真正会读到这个禁用态的是两种时序：目录这一代列了模型却给不出可读档位（脏数据），
       * 或者档位表被清空的那一瞬。那时给一个灰掉、不可拖的控件，比给一个"拖了没反应"的控件诚实。
       */
      var disabled = levelCount === 0 || shownLevel === null;
      /** 状态与渲染必须同源：把禁用态写进无障碍树，而不是只灰一层。 */
      React.useEffect(function () {
        if (host === null || !host.container || typeof host.container.setAttribute !== "function") return;
        host.container.setAttribute("data-disabled", disabled ? "1" : "0");
      }, [host, disabled]);

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
        if (levelId === null || levelId === undefined || access === null) return;

        var snapshot = currentState();
        var current = snapshot && snapshot.current;
        if (!current || typeof current.provider !== "string" || typeof current.model !== "string") {
          setError("模型目录尚未就绪，无法写入档位");
          return;
        }
        // 发送前再判一次：可能宿主已经把这个档位写好了（去重的第二道闸）。
        if (effectiveEffortId(snapshot) === levelId) return;

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
          if (pending.queued !== null) flush();
        });
      }

      /** 请求写回某一档：同档位去重 + 在途合并 + 停顿去抖；immediate 用于松手。 */
      function requestCommit(levelId, immediate) {
        if (levelId === null || levelId === undefined) return;
        var pending = commitRef.current;
        var snapshot = currentState();
        if (effectiveEffortId(snapshot) === levelId && pending.queued === null && !pending.inFlight) return;
        pending.queued = levelId;
        if (pending.inFlight) return;
        if (immediate === true) {
          flush();
          return;
        }
        // 去抖：每次请求都重置计时器 —— 指针还在动就永远不落地（见 COMMIT_SETTLE_MS）。
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.timer = setTimeout(function () {
          pending.timer = null;
          flush();
        }, COMMIT_SETTLE_MS);
      }

      function pctAt(clientX) {
        var track = trackRef.current;
        if (!track || typeof track.getBoundingClientRect !== "function") return null;
        var rect = track.getBoundingClientRect();
        // 与视觉几何一致：指针落点映射到"球心能到的那一段"（两端各内缩一个**轨道端头**半径），
        // 所以拖到最左/最右必定命中端点档位。
        var usable = rect.width - TRACK_RADIUS * 2;
        if (!(usable > 0)) return null;
        return clamp01((clientX - rect.left - TRACK_RADIUS) / usable);
      }

      /** 吞掉事件：滑条在官方的 <button> 里，不能让拖动触发那一行的 onClick（会跳进等级列表）。 */
      function swallow(event) {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      }

      /** 指针位置 → "档位单位"（0 = 最低档，levelCount-1 = 最高档）；拿不到轨道几何时返回 null。 */
      function unitAt(clientX) {
        var pct = pctAt(clientX);
        if (pct === null || levelCount === 0) return null;
        return pct * (levelCount - 1);
      }

      /**
       * 指针位置 → 目标档位（用户指定的手感）。
       *
       * 判定线固定在**每一档 + 1/3 档距**处：指针越过它就切到下一档。指针停在档位点上时旋钮
       * 不动（不跟手），只在一格一格地滑。
       *
       * ⚠️ 这条线是同一条，所以前进只需走 1/3 档距、后退要退到 1/3 线以下（= 2/3 档距）。
       *    这是"1/3 阈值"本身的必然结果 —— 若做成对称的 ±1/3 迟滞带，状态机会自相矛盾
       *    （越过 1/3 切上去、而新档位的下界又在 2/3，下一步就会自己切回来，来回抖）。
       *    想要对称手感就把 DETENT_THIRD 改成 1/2（判定线落在中点 = 原来的取最近）。
       */
      /** 指针（档位单位）→ 判定线给出的档位：每一档 +1/3 档距处就是分界线。 */
      function mappingOf(u) {
        var last = levelCount - 1;
        return Math.max(0, Math.min(last, Math.floor(u - DETENT_THIRD) + 1));
      }

      /**
       * 指针位置 → 目标档位。判定线见 mappingOf：指针停着旋钮就不动，换档由 CSS 过渡滑过去。
       *
       * 按下死区**只在真正需要时才生效**：按下是"点哪去哪"（取最近档），若落点已经站到判定线
       * 外侧（两者最多差 1/6 档距），不拦一下就会在指针刚动时立刻多跳一档。这种情况让指针先退回
       * 判定线以内、或明确拖满 1/3 档距，就认账。
       * **没有冲突时判定线直接生效 —— 起拖不额外加任何延迟**（早先那版无论冲突与否都要求先空拖
       * 1/3 档距，那正是"拖动延迟高"的来源）。
       */
      function resolveTarget(u) {
        var mapped = mappingOf(u);
        var press = pressRef.current;
        if (press.active) {
          if (!press.conflict || mapped === press.index || Math.abs(u - press.u) >= DETENT_THIRD) {
            press.active = false;
          } else {
            return press.index;
          }
        }
        return mapped;
      }

      /** 切快/慢档：只在真的变了才写 state，避免白渲染。 */
      function applySlideSlow(next) {
        if (slideSlowRef.current === next) return;
        slideSlowRef.current = next;
        setSlideSlow(next);
      }

      /**
       * 换档计时 + 快慢判定（用户要求：拖得慢，动画也慢）。
       * 判据是与**上一次换档**的间隔：隔得久说明手在慢慢挪 → 慢档；一直在动 → 快档。
       * 两个阈值构成 120ms 迟滞，速度刚好卡在阈值上时不会快慢来回跳。
       */
      function noteStepTiming() {
        var now = Date.now();
        var gap = now - lastStepAtRef.current;
        lastStepAtRef.current = now;
        // 当前是慢档：只有"手又快了"（间隔掉到退出阈值以下）才回快档，其余保持慢档。
        if (slideSlowRef.current) applySlideSlow(gap >= SLOW_DRAG_EXIT_MS);
        // 当前是快档：只有"手明显慢了"（间隔超过进入阈值）才换慢档。
        else applySlideSlow(gap > SLOW_DRAG_ENTER_MS);
      }

      /** 落档：位置变化交给 CSS 过渡去"滑"；没换档就什么都不做（不重放动画、不重复写回）。 */
      function applyTarget(index, immediate) {
        if (levelCount === 0) return;
        var currentIndex = draftRef.current !== null ? draftRef.current.index : shownIndex;
        var changed = currentIndex !== index;
        if (changed) {
          var next = { index: index, pct: pctFromIndex(index, levelCount) };
          draftRef.current = next;
          setDraft(next);
          noteStepTiming();
        }
        // 只在这两种情况下碰宿主：真的换档了，或需要立即落地（松手）。
        // 指针每动一下都去读一次会话状态本身也是白烧 —— 连续拖动里那是每秒几十次。
        if (changed || immediate === true) requestCommit(levels[index].id, immediate === true);
      }

      function endDrag() {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        var latest = draftRef.current;
        if (latest !== null && levelCount > 0) requestCommit(levels[latest.index].id, true);
        draftRef.current = null;
        setDraft(null);
      }

      function onTrackPointerDown(event) {
        if (locked || disabled || levelCount === 0) return;
        swallow(event);
        draggingRef.current = true;
        try {
          if (event.currentTarget && typeof event.currentTarget.setPointerCapture === "function" && event.pointerId !== undefined) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        } catch (error) { /* 指针捕获失败不影响拖动 */ }
        var u = unitAt(event.clientX);
        if (u === null) return;
        // 按下 = 点哪去哪：落到离指针**最近**的那一档（不是 1/3 判定）。
        var nearest = Math.max(0, Math.min(levelCount - 1, Math.round(u)));
        lastStepAtRef.current = Date.now(); // 第一次换档的间隔从"按下"算起
        pressRef.current = { u: u, index: nearest, conflict: mappingOf(u) !== nearest, active: true };
        applyTarget(nearest, false);
      }

      function onTrackPointerMove(event) {
        if (!draggingRef.current) return;
        swallow(event);
        var u = unitAt(event.clientX);
        if (u === null) return;
        applyTarget(resolveTarget(u), false);
      }

      /* 刻意不实现键盘操作（用户要求）：滑条不抢焦点、不吞方向键，官方菜单的键盘导航原样保留。 */

      var trackTitle = "推理等级" + (shownLevel !== null ? "：" + shownLevel.name : "（当前模型没有可用档位）");
      if (disabled) trackTitle += "（当前不可拖动：这一代目录没有给出可用的档位表）";
      if (reducedMotion) trackTitle += "（系统「减少动态效果」已开启：粒子已放缓）";

      var tickNodes = [];
      for (var t = 0; t < levelCount; t += 1) {
        tickNodes.push(React.createElement("span", {
          key: "tick-" + levels[t].id,
          className: "ces-tick",
          "data-ces-part": "tick",
          "data-on": t <= shownIndex ? "1" : "0",
          // 当前位置那一个：Max 档时靠它把自己留下、其余点隐藏（见样式表 data-max 规则）
          "data-current": t === shownIndex ? "1" : "0",
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
        var starDuration = starDurationFor(s, positionSpeed) * (reducedMotion ? REDUCED_MOTION_SLOWDOWN : 1);
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
              "data-motion": reducedMotion ? "reduced" : "full",
              "data-busy": busy ? "1" : "0",
              "data-max": atMax ? "1" : "0",
              "data-slide": slideSlow ? "slow" : "fast",
              "data-disabled": disabled ? "1" : "0",
              style: { "--ces-energy": String(energy) },
            },
            React.createElement(
              "div",
              {
                ref: trackRef,
                className: "ces-track",
                "data-ces-part": "track",
                role: "slider",
                "aria-label": "推理等级",
                "aria-valuemin": 0,
                "aria-valuemax": Math.max(0, levelCount - 1),
                "aria-valuenow": shownIndex,
                "aria-valuetext": shownLevel !== null ? shownLevel.name : "",
                // 禁用态与锁定态进无障碍树：不是"没反应"，是"当前不可用"
                "aria-disabled": locked || disabled ? "true" : undefined,
                title: trackTitle,
                onPointerDown: onTrackPointerDown,
                onPointerMove: onTrackPointerMove,
                onPointerUp: endDrag,
                onPointerCancel: endDrag,
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
     * 五个服务都是官方客户端插件已经在用的（slots 不必说；sessions 与 modelDirectories
     * 是 client-ui-model-selection / client-ui-workspace 的既有注入面）。
     *
     * ⚠️ **`remote` / `remote.session` 是必须的，别删**（1.3.7 的真机事故就出在这里）：
     * Cordis 的服务访问是**跟着调用方 ctx** 的 —— `models.directoryFor(sessionId)` 内部要
     * `new ModelDirectory(this.ctx.remote.session, …)`，访问 `this.ctx.remote.session` 时**要求
     * 调用方**声明过它，否则抛 `cannot get property "remote.session" without inject`。
     * 官方插件的插件级 inject 就是
     * `["commandUi","locale","sessions","slots","remote","remote.session"]`（逐字核对过）。
     *
     * 为什么"以前能用、接管之后才坏"：Resolver 对每个 binding **缓存**目录实例
     * （`live.directories.get(binding)` 命中就直接返回，**根本不碰 `remote.session`**）。
     * 从前官方那颗席按钮也在渲染 —— 它先调一次 `directoryFor()` 把实例建出来，我们后来只是命中缓存；
     * 1.3.2 接管那一格之后**官方组件不再渲染**，我们就成了第一个（也是唯一的）调用方，
     * 于是必须自己建实例、于是必须自己声明这两个服务。启动顺序还会让它"时好时坏"。
     *
     * 这里刻意**不**注入 locale / theme：多声明一个可能不存在的服务会让 fiber 停在 PENDING；
     * 而 remote / remote.session 是**必然存在**的（`modelDirectories` 自己就静态依赖它们）。
     */
    var inject = ["slots", "sessions", "remote", "remote.session", "modelDirectories"];

    /* ── 自建浮层（code.html 那套界面）──────────────────────────────────── */

    /** 样式表跟着 chunk 一起到（`loadPickerModule` 里挂），这里只负责把 chunk 拉起来。 */
    loadPickerModule();

    /**
     * 面板写档位：与官方菜单那条控件走**同一个** `directory.select()`，
     * 唯一区别是这里没有桥、没有超时回滚的 UI 出口，所以失败与超时只记在控制台
     * （不改状态显示 —— 面板显示的是目录的真实值，写失败时它自己就停在旧档位上）。
     */
    function createPickerWrite() {
      var optimisticId = null;
      var timer = null;
      function flushTimeout() {
        if (timer !== null) { clearTimeout(timer); timer = null; }
      }
      return {
        write: function (directory, provider, model, levelId) {
          if (directory === null || typeof directory.select !== "function") return false;
          /**
           * `levelId` 为空（无档位模型）→ payload **只带 provider / model**，
           * `reasoningEffort` 键**整个不出现**。
           *
           * 为什么不能写成 `reasoningEffort: undefined`：`JSON.stringify` 确实会丢掉它，
           * 但宿主拿到的是**对象本身**，缺席与显式 undefined 在宿主侧是两种东西
           * （缺席 = 对档位没有意见；显式 = 显式清除）。
           * 官方产物就是这么构造的（`dsh-client-ui-model-selection/lib/client.js` 的 `select()`：
           * `...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }`），
           * 第 12 节的产物对照断言钉住了这个形状。
           */
          var hasLevel = typeof levelId === "string" && levelId.length > 0;
          var payload = hasLevel
            ? { provider: provider, model: model, reasoningEffort: levelId }
            : { provider: provider, model: model };
          // 乐观值只在**有效档位**时设置：无档位写入没有"等宿主追上哪一档"这回事，
          // 设了会永远悬着（目录里没有对应 level 可追）。
          if (hasLevel) optimisticId = levelId;
          flushTimeout();
          timer = setTimeout(function () {
            timer = null;
            optimisticId = null;
          }, 10000);
          try {
            Promise.resolve(directory.select(payload))
              .then(function () { flushTimeout(); optimisticId = null; })
              .catch(function (error) {
                flushTimeout();
                optimisticId = null;
                try { console.warn("[" + PACKAGE_ID + "] 档位写入失败：", error); } catch (e) { /* 忽略 */ }
              });
          } catch (error) {
            flushTimeout();
            optimisticId = null;
            try { console.warn("[" + PACKAGE_ID + "] 档位写入抛错：", error); } catch (e) { /* 忽略 */ }
          }
          return true;
        },
        optimistic: function () { return optimisticId; },
        dispose: flushTimeout,
      };
    }

    /**
     * 自建浮层拆成**两条插槽条目**，各自挂自己的插槽（诊断确认的"半途而废"那步，现在补完）：
     *   · trigger → `conversation.input.right`（流内，提交键前，官方席按钮旁边）
     *   · surface → `conversation.input.overlay`（只提供生命周期，面板本体 portal 到 body）
     * 两者没有共同 React 父级，开合状态走 picker 模块里的模块级 `pickerStore`。
     *
     * 组件类型**只建一次**（模块级缓存）：`createPickerTrigger`/`createPickerSurface` 每次调用
     * 都返回一个新函数，若在渲染里现取，组件类型一变 React 就把子树卸载重挂，状态全丢。
     */
    var PickerTriggerComponent = null;
    var PickerSurfaceComponent = null;
    function ensurePickerComponents() {
      if (pickerModule === null) return false;
      if (PickerTriggerComponent === null) {
        PickerTriggerComponent = pickerModule.createPickerTrigger(React);
        PickerSurfaceComponent = pickerModule.createPickerSurface(React, ReactDOM);
      }
      return true;
    }

    /** 每个会话的目录访问（trigger 与 surface 各建一份；只读/订阅，写到哪交给 surface）。 */
    function usePickerAccess(ctx, sessionId, injectedKey) {
      return React.useMemo(function () {
        if (!ctx) return null;
        /*
         * 两个候选**按可信度排序**：标准 kit 的 `sessionId` 在前（官方那颗席按钮用的就是它），
         * `inject` 拿到的 `binding.key` 在后兜底。以前我们只信后者、还会把前者盖掉 ——
         * 真机上 `binding.key` 一旦不是本会话的 id，整个面板就永久停在"会话目录未就绪"（1.3.6 修）。
         */
        var ids = [];
        if (typeof sessionId === "string" && sessionId.length > 0) ids.push(sessionId);
        if (typeof injectedKey === "string" && injectedKey.length > 0 && ids.indexOf(injectedKey) < 0) ids.push(injectedKey);
        /*
         * 空候选也要给一个访问器（而不是 null）：它会把 `phase()` 报成 `no-session`，
         * 界面于是能说"还没有会话（发消息后即可选模型）"，而不是含糊的"未就绪"。
         */
        return createDirectoryAccess(ctx, ids, {
          set: function (fn, delay) { return setTimeout(fn, delay); },
          clear: function (handle) { clearTimeout(handle); },
        });
      }, [ctx, sessionId, injectedKey]);
    }

    /** chunk 是异步到的：到货后置一次 state 触发重渲。 */
    function usePickerLoaded() {
      var loadedPair = React.useState(pickerModule !== null);
      var loaded = loadedPair[0];
      var setLoaded = loadedPair[1];
      React.useEffect(function () {
        if (loaded) return undefined;
        return watchPickerModule(function () { setLoaded(true); });
      }, [loaded]);
      return loaded;
    }

    /**
     * 目录"走到哪一步了" —— 给界面用的一句话状态。
     *
     * 为什么要这个（1.3.5）：真机上"**我们还没拿到目录**"和"**宿主就是没有 provider**"
     * 在面板上**长得一模一样**（都是"没有可用的 provider"），于是排查只能靠猜。
     * 访问器自己最清楚这两者的区别（`directoryFor` 抛没抛、store 的 status 是什么），
     * 所以由它给答案，界面照着说人话。
     */
    function phaseOf(access) {
      if (access === null || typeof access.phase !== "function") return "unresolved";
      try {
        return access.phase();
      } catch (error) {
        return "unresolved";
      }
    }

    /** "为什么还没就绪"的原话（空串 = 没有失败原因）。 */
    function reasonOf(access) {
      if (access === null || typeof access.reason !== "function") return "";
      try {
        return String(access.reason() || "");
      } catch (error) {
        return "";
      }
    }

    function PickerTriggerSlot(props) {
      var sessionId = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId : null;
      /** `inject` 拿到的 `binding.key`（第二候选，见 `usePickerAccess`）。 */
      var injectedKey = typeof props.__sessionKey === "string" && props.__sessionKey.length > 0 ? props.__sessionKey : null;
      var ctx = props.__ctx;
      /**
       * `locked` 是 `conversation.input.model` 的 **owner prop**（官方席按钮就吃它：
       * `renderSlot("conversation.input.model", { locked: modelSeatLocked })`）。
       * 接管那颗按钮之后这条语义得跟着接过来 —— 否则输入区被锁住时我们这颗还能点开。
       */
      var locked = props.locked === true;
      usePickerLoaded();
      var access = usePickerAccess(ctx, sessionId, injectedKey);
      React.useEffect(function () {
        return function () { if (access !== null) access.dispose(); };
      }, [access]);
      if (pickerModule === null || !ensurePickerComponents()) return null;
      return React.createElement(PickerTriggerComponent, {
        sessionId: sessionId, access: access, locked: locked,
        phase: phaseOf(access), reason: reasonOf(access),
      });
    }

    function PickerSurfaceSlot(props) {
      var sessionId = typeof props.sessionId === "string" && props.sessionId.length > 0 ? props.sessionId : null;
      /** `inject` 拿到的 `binding.key`（第二候选，见 `usePickerAccess`）。 */
      var injectedKey = typeof props.__sessionKey === "string" && props.__sessionKey.length > 0 ? props.__sessionKey : null;
      var ctx = props.__ctx;
      var reducedPair = React.useState(false);
      var reducedMotion = reducedPair[0];
      var setReducedMotion = reducedPair[1];
      usePickerLoaded();
      var access = usePickerAccess(ctx, sessionId, injectedKey);
      var writer = React.useMemo(function () { return createPickerWrite(); }, []);

      React.useEffect(function () {
        try {
          if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
          var query = window.matchMedia("(prefers-reduced-motion: reduce)");
          var sync = function () { setReducedMotion(query.matches === true); };
          sync();
          if (typeof query.addEventListener === "function") {
            query.addEventListener("change", sync);
            return function () { query.removeEventListener("change", sync); };
          }
          return undefined;
        } catch (error) {
          return undefined;
        }
      }, []);

      React.useEffect(function () {
        return function () {
          writer.dispose();
          if (access !== null) access.dispose();
        };
      }, [access, writer]);

      if (pickerModule === null || !ensurePickerComponents()) return null;
      return React.createElement(PickerSurfaceComponent, {
        sessionId: sessionId,
        access: access,
        // 写档位：目录实例在**写入那一刻**现取（目录被重建过时不会用到失效实例）
        write: function (provider, model, levelId) {
          var directory = access !== null && typeof access.directory === "function" ? access.directory() : null;
          writer.write(directory, provider, model, levelId);
        },
        reducedMotion: reducedMotion,
        phase: phaseOf(access),
        reason: reasonOf(access),
      });
    }

    /**
     * 插件接线：两条路**二选一**。
     *   · 默认：自建浮层（接管官方模型席 + 自建面板）
     *   · `ENABLE_OFFICIAL_MENU_SLIDER = true`：回到"改造官方菜单"那条路（滑条注入官方那一行）
     *
     * 为什么必须二选一（1.3.2 起）：接管官方席 = 拿掉官方菜单**唯一的入口**。
     * 要是同时把开关打开，官方菜单就永远打不开了 —— 那条路的滑条长在菜单里，等于没入口。
     */
    function apply(ctx) {
      installStyles();
      if (ENABLE_OFFICIAL_MENU_SLIDER) {
        try {
          ctx.slots.inject(SLOT_NAME, function () {
            return ctx.slots.register(
              {
                name: SLOT_NAME,
                id: ENTRY_ID,
                order: ENTRY_ORDER,
                label: function () { return "Reasoning effort"; },
                // ⚠️ 用私有键名当"第二候选"，**不要**返回 `{sessionId}` —— 那会盖掉 kit 里正确的会话 id
                //（1.3.6 的真机事故：`binding.key` 与 kit 的 `sessionId` 不是同一个值时，目录永久解析不出来）。
                inject: function (sessionId) { return { __sessionKey: sessionId }; },
              },
              function SlotComponent(props) {
                return React.createElement(CodexEffortSlider, Object.assign({}, props, { __ctx: ctx }));
              },
            );
          });
        } catch (error) {
          // 注册失败只意味着这块控件不出现，绝不能连累宿主输入区。
          try { console.error("[" + PACKAGE_ID + "] 插槽注册失败，控件不会出现：", error); } catch (e) { /* 忽略 */ }
        }
        return;
      }
      registerPicker(ctx);
    }

    /**
     * 触发器当前的占用状态。
     *
     * 为什么要这么绕：`ctx.slots.inject` 的语义是"**等**那个槽被声明"，没声明就永远不回调
     * （不是抛错）。所以"接管官方席"这件事必须容下三种时序：
     *   1. 模型席先声明 → 直接接管（正常情况，两个槽都由同一条父条目一起声明）；
     *   2. 工具行先声明 → 先按老样子挂上去，模型席随后声明时**撤掉工具行那条**再接管
     *      （两个回调在同一批同步执行，没有绘制发生在中间，所以看不到"闪一下"）；
     *   3. 模型席**始终没有** / 注册抛错 → 工具行那条就是最终落点（老行为，fail-open）。
     */
    var triggerPlacement = { claimed: false, modelDispose: null, fallbackDispose: null };

    /** 调一个注册句柄：真宿主返回的是 disposer **函数**（`ctx.effect` 那条），桩件返回 `{dispose}`。 */
    function disposeHandle(handle) {
      try {
        if (typeof handle === "function") handle();
        else if (handle && typeof handle.dispose === "function") handle.dispose();
      } catch (error) { /* 撤不掉也不影响别的 */ }
    }

    /**
     * 注册自建浮层 —— **两条条目**：
     *   · trigger → `conversation.input.model`（**priority −1 遮蔽官方那颗席按钮**；
     *     拿不到就退回 `conversation.input.right`，见 `triggerPlacement` 的注释）
     *   · surface → `conversation.input.overlay`（`PICKER_PANEL_*`，order 20）
     */
    function registerPicker(ctx) {
      if (pickerModule === null) loadPickerModule();
      // 1) 官方模型席那一格：优先接管
      try {
        ctx.slots.inject(PICKER_TRIGGER_SLOT, function () {
          if (claimModelSeat(ctx)) return;
          registerTriggerFallback(ctx);
        });
      } catch (error) {
        // inject 自己抛（槽位目录里没有这个键之类）→ 直接走退路：入口不能因为一次失败就消失
        try { console.warn("[" + PACKAGE_ID + "] 等官方模型席时出错，退回工具行：", error); } catch (e) { /* 忽略 */ }
        registerTriggerFallback(ctx);
      }
      // 2) 退路：只有"还没接管成功"时才真的注册（同一个槽被声明两次不会重复挂）
      try {
        ctx.slots.inject(PICKER_TRIGGER_FALLBACK_SLOT, function () {
          if (!triggerPlacement.claimed) registerTriggerFallback(ctx);
        });
      } catch (error) {
        try { console.warn("[" + PACKAGE_ID + "] 工具行槽不可用：", error); } catch (e) { /* 忽略 */ }
      }
      // 3) 面板（overlay）：与触发器无关，单独一条
      try {
        ctx.slots.inject(PICKER_PANEL_SLOT, function () {
          return ctx.slots.register(
            {
              name: PICKER_PANEL_SLOT,
              id: PICKER_PANEL_ID,
              order: PICKER_PANEL_ORDER,
              label: function () { return "Model picker panel"; },
              // 同上：私有键名（第二候选），绝不盖掉 kit 的 `sessionId`
              inject: function (sessionId) { return { __sessionKey: sessionId }; },
            },
            function SurfaceEntry(innerProps) {
              return React.createElement(PickerSurfaceSlot, Object.assign({}, innerProps, { __ctx: ctx }));
            },
          );
        });
      } catch (error) {
        try { console.error("[" + PACKAGE_ID + "] 浮层面板注册失败，自建面板不会出现：", error); } catch (e) { /* 忽略 */ }
      }
    }

    /**
     * 接管官方模型席那一格：注册成功返回 `true`，并顺手撤掉可能已经挂上的退路那条。
     *
     * 为什么要接住抛错：这条吃的是"single 槽 + priority 更低者胜"的机制，官方哪天把它改成
     * list 槽（要求 id 唯一）、或规定 single 槽不许第三方注册，这里就会抛 —— 抛了必须**立刻
     * 退回老位置**，否则用户看到的是"入口整颗消失"。
     */
    function claimModelSeat(ctx) {
      if (triggerPlacement.claimed) return true;
      var handle = registerTrigger(ctx, PICKER_TRIGGER_SLOT, { priority: PICKER_TRIGGER_PRIORITY });
      if (handle === null) return false;
      triggerPlacement.claimed = true;
      triggerPlacement.modelDispose = handle;
      if (triggerPlacement.fallbackDispose !== null) {
        disposeHandle(triggerPlacement.fallbackDispose);
        triggerPlacement.fallbackDispose = null;
      }
      return true;
    }

    /** 退路：注册到 `conversation.input.right`（与官方那颗席按钮**并排**，不遮蔽任何东西）。 */
    function registerTriggerFallback(ctx) {
      if (triggerPlacement.claimed || triggerPlacement.fallbackDispose !== null) return;
      try {
        ctx.slots.inject(PICKER_TRIGGER_FALLBACK_SLOT, function () {
          if (triggerPlacement.claimed || triggerPlacement.fallbackDispose !== null) return;
          var handle = registerTrigger(ctx, PICKER_TRIGGER_FALLBACK_SLOT, { order: PICKER_TRIGGER_ORDER });
          if (handle !== null) triggerPlacement.fallbackDispose = handle;
        });
      } catch (error) {
        try { console.error("[" + PACKAGE_ID + "] 触发器注册失败，自建面板入口不会出现：", error); } catch (e) { /* 忽略 */ }
      }
    }

    /** 把触发器注册到指定槽；返回注册句柄（失败返回 `null`，调用方据此走退路）。 */
    function registerTrigger(ctx, slot, options) {
      try {
        return ctx.slots.register(
          {
            name: slot,
            id: PICKER_TRIGGER_ID,
            priority: options.priority,
            order: PICKER_TRIGGER_ORDER,
            label: function () { return "Model picker trigger"; },
            /*
             * ⚠️ **不要把会话 id 直接叫 `sessionId` 返回**（1.3.6 的真机事故）：
             * 渲染器拼 props 的顺序是 `{...标准 kit, ...inject 的返回, …}`，返回 `{sessionId}`
             * 等于用 `binding.key` **盖掉** kit 里那个正确的会话 id。一旦两者不是同一个值
             * （真机上就发生了），`directoryFor()` 会抛 "resolved no scope / no binding"，
             * 界面永久停在"会话目录未就绪"，而官方 `/model` 一切正常 —— 极难查。
             * 所以换私有键名当**第二候选**，让 kit 的值活下来（见 `usePickerAccess`）。
             */
            inject: function (sessionId) { return { __sessionKey: sessionId }; },
          },
          function TriggerEntry(innerProps) {
            return React.createElement(PickerTriggerSlot, Object.assign({}, innerProps, { __ctx: ctx }));
          },
        );
      } catch (error) {
        try { console.warn("[" + PACKAGE_ID + "] 触发器在 " + slot + " 注册失败：", error); } catch (e) { /* 忽略 */ }
        return null;
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
      /** 目录访问器工厂（离线用例直接建一个来断言候选会话 id 的顺序 / phase / reason）。 */
      createDirectoryAccess: createDirectoryAccess,
      createMenuBridge: createMenuBridge,
      findEffortRow: findEffortRow,
      findOpenMenu: findOpenMenu,
      firstSpanText: firstSpanText,
      levelsOf: levelsOf,
      modelOf: modelOf,
      effectiveEffortId: effectiveEffortId,
      indexOfLevel: indexOfLevel,
      pctFromIndex: pctFromIndex,
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
      TRACK_RADIUS: TRACK_RADIUS,
      DETENT_THIRD: DETENT_THIRD,
      SLIDE_EASE: SLIDE_EASE,
      SLIDE_EASE_SLOW: SLIDE_EASE_SLOW,
      SLOW_DRAG_ENTER_MS: SLOW_DRAG_ENTER_MS,
      SLOW_DRAG_EXIT_MS: SLOW_DRAG_EXIT_MS,
      BASE_SPEEDUP: BASE_SPEEDUP,
      ENERGY_START: ENERGY_START,
      ENERGY_END: ENERGY_END,
      clamp01: clamp01,
      installStyles: installStyles,
      /* ── 自建浮层（1.3.0）：面板模块 + 它的样式表 ──
         注意这两个是 **getter**：面板本体是**包内动态 chunk**，异步到货。
         写成取值会在 chunk 到达前就把 null 固定下来，测试与调试都看不到它。 */
      get picker() { return pickerModule; },
      get PICKER_CSS() { return pickerModule !== null && pickerModule.PICKER_CSS ? pickerModule.PICKER_CSS : ""; },
      PICKER_STYLE_MARKER: PICKER_STYLE_MARKER,
      PICKER_PANEL_SLOT: PICKER_PANEL_SLOT,
      PICKER_PANEL_ID: PICKER_PANEL_ID,
      PICKER_TRIGGER_SLOT: PICKER_TRIGGER_SLOT,
      PICKER_TRIGGER_PRIORITY: PICKER_TRIGGER_PRIORITY,
      PICKER_TRIGGER_FALLBACK_SLOT: PICKER_TRIGGER_FALLBACK_SLOT,
      PICKER_TRIGGER_ID: PICKER_TRIGGER_ID,
      PICKER_TRIGGER_ORDER: PICKER_TRIGGER_ORDER,
      PICKER_PANEL_ORDER: PICKER_PANEL_ORDER,
      PickerTriggerSlot: PickerTriggerSlot,
      PickerSurfaceSlot: PickerSurfaceSlot,
      PICKER_CHUNK: PICKER_CHUNK,
      /** 官方菜单那条控件的总开关（默认 false）—— 离线断言盯住默认值，防止误开。 */
      ENABLE_OFFICIAL_MENU_SLIDER: ENABLE_OFFICIAL_MENU_SLIDER,
      /* ── 档位字典 / 徽标 / 目录索引（1.2.0 新增，供离线断言）── */
      LV: LV,
      normalizeTierId: normalizeTierId,
      tiers: tiers,
      OPENAI_DEFS: OPENAI_DEFS,
      DEF_ALIASES: DEF_ALIASES,
      resolveModel: resolveModel,
      buildCatalogIndex: buildCatalogIndex,
      tiersForModel: tiersForModel,
      entryByName: entryByName,
      normalizeModelKey: normalizeModelKey,
      focusNoScroll: focusNoScroll,
      tierCountLabel: tierCountLabel,
      describeModelTier: describeModelTier,
      decorateMenu: decorateMenu,
      buildModelBadge: buildModelBadge,
      buildApiValue: buildApiValue,
      buildProviderTag: buildProviderTag,
      findScrollContainer: findScrollContainer,
      findEffortOptionRows: findEffortOptionRows,
    };

    return module.exports;
  },
});
