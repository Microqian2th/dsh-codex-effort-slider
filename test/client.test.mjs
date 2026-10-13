/**
 * better-dsh-codex-effort-slider — 客户端离线测试
 *
 * 跑法：`node test/client.test.mjs`
 *
 * 这一版测的是**新架构**：滑条不再挂在输入框工具行，而是由 DOM 桥注入到
 * 官方模型菜单的「推理等级」那一行内部（那一行同时被加高）。所有断言里最要紧的几条：
 *   · 只动那一行（官方原有的 label/value/chevron 一个不动），关菜单后**逐个还原**
 *   · 拖动真的写回官方档位；不把宿主打爆（去重 + 在途合并 + **停顿去抖**：
 *     连续拖动期间一次都不写回，停手/松手才落地）
 *   · 找不到锚点/不是自己的会话就**什么都不做**（fail-open，官方菜单绝不受影响）
 *   · 结构上不存在消息注入这条路
 */
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore, createDocument, createFakeHost, createOfficialMenu, loadBundle, settle, wait, snapshotFor, snapshotOf } from "./harness.mjs";

const BUNDLE = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const SOURCE = readFileSync(BUNDLE, "utf8");
/** 去掉注释后的代码：断言「产物里没有 X」时必须看代码，注释里提到同类插件的坑不算违规。 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

let passed = 0;
let failed = 0;
const failures = [];

/**
 * 失败信息里的值格式化。
 *
 * **不能用裸 `JSON.stringify`**：假 DOM 节点之间有 `children ↔ parentNode` 的循环引用，
 * 一 stringify 就抛 TypeError —— 断言失败会被一个格式化异常顶掉，测试**中途崩在**那一行，
 * 后面的断言全都不跑（真会掩盖问题：明明该看到一条 FAIL，却只看到一个 crash）。
 */
function show(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "object") {
    if (typeof value.getAttribute === "function") {
      const part = value.getAttribute("data-ces-part");
      const tag = String(value.tagName || "node").toLowerCase();
      return part === null || part === undefined ? `<${tag}>` : `<${tag} data-ces-part=${JSON.stringify(part)}>`;
    }
    try {
      return JSON.stringify(value);
    } catch (error) {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

function ok(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  ok(same, same ? label : `${label}（期望 ${show(expected)}，实际 ${show(actual)}）`);
}

function near(actual, expected, label, tolerance = 1e-6) {
  const same = typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
  ok(same, same ? label : `${label}（期望 ≈${expected}，实际 ${actual}）`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

/**
 * 挂「官方菜单那条控件」（1.2.0 的 `.ces-` 注入路径）。
 *
 * 它现在**默认不注册**（`ENABLE_OFFICIAL_MENU_SLIDER === false`：主入口已经是自建浮层，
 * 两套 UI 同时在同一个输入区里会互相干扰）。而第 2–26 节断言盯的一直是**它的行为**，
 * 与"有没有注册"无关，所以这里直接挂组件本身 —— 挂的是同一个组件、同一份 props
 * （`__ctx` 也不缺，真实注册路径里那个 `SlotComponent` 也只是替它补了 `__ctx`）。
 */
function mountOfficialSlider(bundle, host, parent, props = {}) {
  const Slider = bundle.plugin.__internals.CodexEffortSlider;
  const Wrapper = (innerProps) => bundle.react.createElement(Slider, Object.assign({}, innerProps, { __ctx: host.ctx }));
  bundle.react.mount(Wrapper, Object.assign({ sessionId: "session-abcdef" }, props), parent);
}

/**
 * 起一个完整场景：假官方菜单 + 真产物 + 假宿主，并把**官方菜单那条控件**挂进官方 composer 内部
 * （插槽在真实布局里就在那里，桥要靠这个位置判定"哪颗席是我的"）。
 */
async function setup(options = {}) {
  const document = createDocument();
  const menu = createOfficialMenu(document, options.menu);
  const bundle = loadBundle(BUNDLE, document, { reducedMotion: options.reducedMotion === true });
  const host = createFakeHost(options.host ?? {});
  bundle.plugin.apply(host.ctx);
  mountOfficialSlider(bundle, host, menu.composer, options.props);
  await settle();
  return {
    document,
    menu,
    bundle,
    react: bundle.react,
    plugin: bundle.plugin,
    registration: bundle.registration,
    host,
    internals: bundle.plugin.__internals,
  };
}

/** 现查轨道节点并给确定几何（假 DOM 不做布局）。 */
function track(react, left = 0, width = 300) {
  const node = react.find("track");
  if (!node) return null;
  node.rect = { left, top: 0, right: left + width, bottom: 28, width, height: 28 };
  return node;
}

/**
 * 只读地从 `app.asar` 里取一个文件的内容（**不落盘**），失败返回 null。
 *
 * asar 头：`| u32=4 | u32=headerPickleSize | u32=jsonLen | json | data… |`，
 * `data` 区自 `16 + jsonLen` 起；每个文件条目带 `offset`（相对 data 区）与 `size`。
 *
 * 为什么需要它：本机的解包目录（`_review/dsh-asar`）可能不存在，但 `app.asar` 一定在 ——
 * 有了这个读取器，第 12 节的**官方产物契约断言**就不会因为"没解包"而被整节跳过。
 */
function readAsarEntry(asarPath, innerPath) {
  let fd = null;
  try {
    fd = openSync(asarPath, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    readSync(fd, jsonBuf, 0, jsonLen, 16);
    const tree = JSON.parse(jsonBuf.toString("utf8"));
    let node = tree;
    for (const part of innerPath.split("/")) {
      if (!node || !node.files || !node.files[part]) return null;
      node = node.files[part];
    }
    if (typeof node.offset !== "string") return null;
    const size = Number(node.size);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 16 + jsonLen + Number(node.offset));
    return buf.toString("utf8");
  } catch (error) {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * 浮层用的多 provider 目录：DeepSeek（4 档 / 不支持）+ OpenAI（8 / 7 / 5 档 / 不支持）。
 * 这一份就是参考实现里那张"每模型档位适配"清单的**活数据**版本。
 */
function pickerGroups() {
  const ds = (id, name, levelIds, def) => ({
    id,
    name,
    reasoning: {
      defaultEffort: def,
      efforts: levelIds.map((levelId, index) => ({ id: levelId, name: levelId === "low" && index === 0 ? "Low" : levelId[0].toUpperCase() + levelId.slice(1) })),
    },
  });
  return [
    { id: "deepseek", name: "DeepSeek", models: [
      ds("deepseek-v41-flash", "DeepSeek-V41-Flash", ["off", "low", "high", "max"], "high"),
      { id: "plain-model", name: "Plain Model" },
      ds("deepseek-v41-pro", "DeepSeek-V41-Pro", ["off", "low", "high", "max"], "max"),
    ] },
    { id: "openai", name: "OpenAI", models: [
      ds("gpt-6-astra", "gpt-6-astra", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
      ds("gpt-6-luna", "gpt-6-luna", ["none", "minimal", "low", "medium", "high", "xhigh", "max"], "medium"),
      ds("gpt-6-spark", "gpt-6-spark", ["none", "minimal", "low", "medium", "high"], "medium"),
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "snapshot", name: "gpt-6-astra-2026-01-13" },
    ] },
  ];
}

/**
 * 给假宿主用的**如实换模型**的 `select` 行为。
 *
 * `createFakeHost` 默认那个 `select` 只把 `reasoningEffort` 回写进快照、**不换 provider/model** ——
 * 那是桩件自身的保真度缺口，与本插件的修复无关，所以**默认值一个字都不动**；
 * 需要"UI 跟着目录走"的断言就在 `setupPicker({ host: { select: commitSelection } })` 里显式注入。
 *
 * 回写时同样照我方契约：`reasoningEffort` **键缺席**（选中无档位模型时），不是显式 undefined。
 */
function commitSelection(selection, store) {
  const previous = store.getSnapshot();
  const current = { provider: selection.provider, model: selection.model };
  if (Object.prototype.hasOwnProperty.call(selection, "reasoningEffort")) {
    current.reasoningEffort = selection.reasoningEffort;
  }
  store.set(Object.assign({}, previous, { current: current }));
  return { ok: true, value: undefined };
}

/**
 * **多会话场景**：同一棵树里挂**两组** (trigger + surface)，各自属于一个会话。
 *
 * 这是"删掉全局幂等守卫"的核心回归钉 —— 旧守卫下第二组会被 `claimed=false` 拒掉
 * （按钮渲染成 null），这个场景必 FAIL；现在每个会话各有一颗按钮（宿主插槽系统的正常契约，
 * 官方那颗模型席按钮就是这么工作的）。
 *
 * 归属靠**渲染顺序**区分：`findAll("picker-trigger")[i]` 对应 `sessions[i]`
 * （Fragment 保序；不为测试在产品代码里加 `data-session` 之类的东西）。
 */
async function setupMultiSession(sessions) {
  const document = createDocument();
  const menu = createOfficialMenu(document);
  const bundle = loadBundle(BUNDLE, document, {});
  const host = createFakeHost({ snapshot: snapshotOf({ groups: pickerGroups() }) });
  bundle.plugin.apply(host.ctx);
  const triggerEntry = host.registered.find((item) => item.opts.id === "codex-picker-trigger");
  const surfaceEntry = host.registered.find((item) => item.opts.id === "codex-picker-panel");
  if (!triggerEntry || !surfaceEntry) throw new Error("插件没有注册自建浮层的两条条目");
  await settle();

  let current = sessions;
  function Combined() {
    const kids = [];
    for (const sessionId of current) {
      const one = { sessionId };
      kids.push(triggerEntry.Component(one));
      kids.push(surfaceEntry.Component(one));
    }
    return bundle.react.createElement(bundle.react.Fragment, null, kids);
  }
  const mount = (list) => {
    if (list) current = list;
    bundle.react.mount(Combined, null, menu.composer);
  };
  mount();
  await settle();

  const mountOnly = async (list) => {
    bundle.react.unmount();
    await settle();
    mount(list);
    await settle();
  };

  return {
    document,
    menu,
    bundle,
    host,
    react: bundle.react,
    /** 只挂列出的这几个会话（模拟"切会话"：原来那组被卸载）。 */
    mountOnly,
    /** 卸载后重新挂载同一组（验证"重建也拿得到按钮"）。 */
    remount: () => mountOnly(sessions),
  };
}

/**
 * 挂**自建浮层**的两条条目（1.3.0：trigger 在 input.right、surface 在 overlay）。
 *
 * 两条条目没有共同父级，但开合状态走 picker 模块里的 `pickerStore`，所以离线桩件里
 * 用一颗无 hook 的 Fragment 包装组件把它们**同树**挂起来（桩件共用一条 hook 列表，
 * 但整树在任意 setState 后都整体重渲，顺序恒定，因此可挂多个 hook 组件）。
 */
async function setupPicker(options = {}) {
  const document = createDocument();
  const menu = createOfficialMenu(document, options.menu);
  const bundle = loadBundle(BUNDLE, document, { reducedMotion: options.reducedMotion === true });
  const host = createFakeHost(Object.assign({ snapshot: snapshotOf({ groups: pickerGroups() }) }, options.host ?? {}));
  // 让用例能在 apply **之前**往槽位账本里塞东西（例如先摆一条"官方模型席"，验证被遮蔽）。
  if (typeof options.beforeApply === "function") options.beforeApply(host);
  bundle.plugin.apply(host.ctx);
  /*
   * 把插件**声明的服务清单**灌给假宿主：真 Cordis 里服务访问跟着调用方 ctx ——
   * `directoryFor()` 给新 binding 建目录实例时要访问 `this.ctx.remote.session`，
   * 所以**调用方也必须声明**它，否则报 `cannot get property "remote.session" without inject`
   *（1.3.7 的真机事故原话）。灌进来之后"少声明一个服务"在离线测试里就会撞墙。
   */
  if (typeof host.enforceInject === "function") host.enforceInject(bundle.plugin.inject);
  const triggerEntry = host.registered.find((item) => item.opts.id === "codex-picker-trigger");
  const surfaceEntry = host.registered.find((item) => item.opts.id === "codex-picker-panel");
  if (!triggerEntry) throw new Error("插件没有注册自建浮层的触发器那条条目");
  if (!surfaceEntry) throw new Error("插件没有注册自建浮层的面板那条条目");
  // 面板本体在**包内动态 chunk** 里（`require.async`）：注册完等它到货，
  // 到货时 `loadPickerModule` 会挂上 `.cxp-` 样式表并通知组件重渲。
  await settle();
  /**
   * **按真渲染器的顺序拼 props**：`{...标准 kit, ...inject 的返回, ...owner}`。
   *
   * 以前这里是把 kit 的 props 直接喂给组件、**从不调用 `inject`** —— 于是
   * "`inject` 的返回值会把 kit 里的 `sessionId` 盖掉"这件事在离线测试里**完全看不见**，
   * 而真机上就是它把整个面板永久卡在"会话目录未就绪"（1.3.6 的事故）。
   * 现在 `bindingKey` 可以单独给（默认与 kit 的会话 id 相同，保持既有用例不变）。
   */
  const kitProps = Object.assign({ sessionId: "session-abcdef" }, options.props ?? {});
  const bindingKey = options.bindingKey ?? kitProps.sessionId;
  const propsFor = (entry) => {
    const injected = entry && typeof entry.opts.inject === "function" ? (entry.opts.inject(bindingKey) || {}) : {};
    return Object.assign({}, kitProps, injected);
  };
  function Combined() {
    return bundle.react.createElement(
      bundle.react.Fragment,
      null,
      triggerEntry.Component(propsFor(triggerEntry)),
      surfaceEntry.Component(propsFor(surfaceEntry)),
    );
  }
  bundle.react.mount(Combined, null, menu.composer);
  await settle();
  const internals = bundle.plugin.__internals;
  return {
    document,
    menu,
    bundle,
    host,
    triggerEntry,
    surfaceEntry,
    internals,
    react: bundle.react,
    picker: internals.picker,
    /** 触发器（收起态那颗按钮）。 */
    trigger: () => bundle.react.find("picker-trigger"),
    /** 滑条；给确定几何。 */
    slider: (left = 0, width = 300) => {
      const node = bundle.react.find("picker-slider");
      if (node) node.rect = { left, top: 0, right: left + width, bottom: 28, width, height: 28 };
      return node;
    },
    /** 点开/收起面板。 */
    async toggle() {
      const node = bundle.react.find("picker-trigger");
      node.fire("onClick", {});
      await settle();
    },
  };
}

function officialRowText(row) {
  return String(row.textContent);
}

/** 真实 DOM 里"没设置过的内联样式"读作 ""，假 DOM 是 undefined；断言统一走这个。 */
function cssValue(node, prop) {
  return node.style[prop] ?? "";
}

/** 等过停顿去抖窗口（260ms）再多一点。 */
const COMMIT_WAIT = 400;

/** 取某个 bundle 的 `__internals`（多处用到，省得每次写长表达式）。 */
function internalsOf(bundle) {
  return bundle.plugin.__internals;
}

/**
 * 二级页里按**显示名**定位一行模型。
 *
 * 为什么不再按下标：二级页从 1.3.1 起按"新发布 → 旧发布"排序（`sortModelsNewestFirst`），
 * 位置会随模型名变化，而下面这些用例想验证的是"**哪一行**的行为"（灰显 / 勾选 / 点它写什么），
 * 不是"它排第几"。按下标写会在排序规则一改就整片红，而那种红并不指向真问题。
 */
function modelRowByName(react, name) {
  const row = react.findAll("picker-model").find((node) => String(node.textContent).indexOf(name) >= 0);
  if (row === undefined) throw new Error(`二级页里没有找到模型行：${name}`);
  return row;
}

/** 徽标文案要经过"目录优先 → 静态清单兜底"这条链，所以按真正的入口算一遍。 */
function tierCountLabelText(internals, index, modelId) {
  return internals.tierCountLabel(internals.tiersForModel(index, modelId));
}

/* ══════════════════════════════════════════════════════════════════════ */

section("1. 接线与产物");
{
  const { registration, plugin, document, host, internals } = await setup();
  eq(registration.id, "better-dsh-codex-effort-slider", "[1] bundle 注册 id 正确");
  ok(Array.isArray(plugin.inject) && plugin.inject.indexOf("slots") >= 0, "[1] inject 含 slots");
  ok(plugin.inject.indexOf("modelDirectories") >= 0, "[1] inject 含 modelDirectories（读写官方档位靠它）");
  ok(plugin.inject.indexOf("sessions") >= 0, "[1] inject 含 sessions（判子代理会话靠它）");
  eq(internals.ENABLE_OFFICIAL_MENU_SLIDER, false, "[1] 官方菜单那条控件默认**不注册**（总开关 false，避免两套 UI 在输入区里打架）");
  eq(internals.SLOT_NAME, "conversation.input.right", "[1] 它的插槽锚点常量仍在（把它改回 true 即可恢复）");
  eq(internals.ENTRY_ID, "codex-effort-slider", "[1] 条目 id 沿用上游（写进 cordis.patch.yml 的 include 锚点，故意不改名）");
  ok(typeof internals.CodexEffortSlider === "function", "[1] 组件本身仍在（第 2–26 节直接挂它来测行为）");
  const styles = document.querySelectorAll('style[data-plugin-css="better-dsh-codex-effort-slider"]');
  eq(styles.length, 1, "[1] 样式挂载一次");
  internals.installStyles();
  eq(document.querySelectorAll('style[data-plugin-css="better-dsh-codex-effort-slider"]').length, 1, "[1] 重复安装样式是幂等的");
  eq(host.subscriptions.length, 0, "[1] apply 期间没有订阅任何宿主事件");
  ok(internals.CSS.indexOf(".ces-track") > 0, "[1] 样式里有轨道规则");
}

section("2. 只动那一行：加高、折行、不碰官方原有内容");
{
  const { menu, react, internals } = await setup();
  const row = menu.effortRow;
  eq(row.style.paddingTop, internals.ROW_PADDING_BLOCK, "[2] 那一行的上内距被加高");
  eq(row.style.paddingBottom, internals.ROW_PADDING_BLOCK, "[2] 下内距同样加高");
  eq(row.style.height, "auto", "[2] 取消官方固定 34px 高（否则放不下滑条）");
  eq(row.style.flexWrap, "wrap", "[2] 允许折行，让滑条落到第二行");
  eq(row.getAttribute("role"), "menuitem", "[2] 官方 role 没被动过");
  eq(row.children.filter((child) => child.tagName === "SPAN").length, 2, "[2] 官方原有的两个 span（label/value）都还在");
  eq(row.children.filter((child) => child.tagName === "SVG").length, 1, "[2] 官方 chevron 还在");
  ok(officialRowText(row).indexOf("推理等级") >= 0, "[2] 官方文案原样保留");

  const host_ = react.find("host");
  ok(host_ !== null, "[2] 滑条容器被 append 进那一行");
  eq(host_.parentNode, row, "[2] 容器的父节点就是官方那一行");
  eq(react.portalHosts.length, 1, "[2] 只有一次 portal（没有重复注入）");
  eq(react.portalHosts[0], host_, "[2] portal 的目标就是那个容器");

  const track_ = react.find("track");
  eq(track_.getAttribute("role"), "slider", "[2] 滑条有 role=slider");
  eq(track_.getAttribute("aria-valuemin"), "0", "[2] aria-valuemin");
  eq(track_.getAttribute("aria-valuemax"), "3", "[2] aria-valuemax = 档位数-1");
  eq(track_.getAttribute("aria-valuenow"), "2", "[2] aria-valuenow = 当前档位下标（high = 2）");
  eq(track_.getAttribute("aria-valuetext"), "High", "[2] aria-valuetext = 官方档位名");
  eq(react.findAll("tick").length, 4, "[2] 刻度数 = 档位数");
  eq(react.find("fill").style.width, internals.knobOffsetOf(2 / 3), "[2] 填充宽度 = 到旋钮圆心（两端各内缩一个半径）");
  eq(react.find("knob").style.left, internals.knobOffsetOf(2 / 3), "[2] 旋钮圆心与填充终点重合");
  eq(react.findAll("tick")[0].style.left, internals.knobOffsetOf(0), "[2] 刻度也走同一套内缩几何（首刻度不顶出左端）");
  eq(react.findAll("tick")[3].style.left, internals.knobOffsetOf(1), "[2] 末刻度不顶出右端");
  ok(react.find("anchor").getAttribute("hidden") !== null, "[2] 锚点自身不可见（输入框工具行不出现任何东西）");
}

section("2b. 顶头适配：旋钮与滑条同高，且两端都不越界");
{
  const { react, internals, host } = await setup();
  // 对齐 GPT 客户端：**球比轨道大**，浮在轨道之上（客户端实测球 110px / 轨道 80px ≈ 1.375）
  eq(internals.KNOB_RADIUS, internals.KNOB_SIZE / 2, "[2b] 球半径 = 直径的一半");
  eq(internals.TRACK_RADIUS, internals.TRACK_HEIGHT / 2, "[2b] 轨道端头半径 = 轨道高度的一半");
  ok(internals.KNOB_SIZE > internals.TRACK_HEIGHT, "[2b] 球比轨道大（球浮在轨道之上）");
  near(internals.KNOB_SIZE / internals.TRACK_HEIGHT, 1.4, "[2b] 球直径/轨道高 ≈ 1.4（GPT 客户端实测 1.375）", 0.12);
  ok(internals.KNOB_RADIUS > internals.TRACK_RADIUS, "[2b] 球半径 > 端头半径 → 球上下都压出轨道之外");
  // 球心在两端各内缩一个**轨道端头**半径（不是球半径）：球因此压过轨道两端；
  // 又因为球心正好落在填充层左端半圆的圆心上，那个半圆必然被球完整盖住（见 2c）。
  eq(internals.knobOffsetOf(0), "calc(10px + 0 * (100% - 20px))", "[2b] pct=0 时球心落在轨道左端圆心");
  eq(internals.knobOffsetOf(1), "calc(10px + 1 * (100% - 20px))", "[2b] pct=1 时球心落在轨道右端圆心");
  ok(internals.CSS.indexOf(".ces-knob{") > 0, "[2b] 有旋钮规则");
  const knobCss = internals.CSS.slice(internals.CSS.indexOf(".ces-knob{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-knob{")));
  ok(knobCss.indexOf("border-radius:50%") > 0, "[2b] 球是正圆（border-radius:50%）");
  ok(knobCss.indexOf(`width:${internals.KNOB_SIZE}px;height:${internals.KNOB_SIZE}px`) > 0, "[2b] 球的盒子是等宽高的正方形（配合 50% 圆角才是圆）");
  ok(knobCss.indexOf(`margin:${-internals.KNOB_RADIUS}px 0 0 ${-internals.KNOB_RADIUS}px`) > 0, "[2b] 用 margin 把球心对准计算出的 left");
  const trackCss = internals.CSS.slice(internals.CSS.indexOf(".ces-track{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-track{")));
  ok(trackCss.indexOf(`height:${internals.TRACK_HEIGHT}px`) > 0, "[2b] 轨道高度走常量（常量若晚于样式表求值，轨道会塌成 0 高）");

  // 指针映射与视觉几何一致：拖到最左必定命中第一档（而不是因为内缩差一点点）
  const node = track(react, 0, 300);
  node.fire("onPointerDown", { clientX: 0, pointerId: 1 }); // 远在左端之外
  node.fire("onPointerUp", {});
  await settle();
  eq(react.find("knob").style.left, internals.knobOffsetOf(0), "[2b] 拖到最左 → 球心落在轨道左端圆心（球压过端头）");
  eq(host.selects[host.selects.length - 1].reasoningEffort, "off", "[2b] 最左端映射到第一档");

  // 右端同理
  track(react, 0, 300).fire("onPointerDown", { clientX: 300, pointerId: 1 });
  track(react).fire("onPointerUp", {});
  await settle();
  eq(react.find("knob").style.left, internals.knobOffsetOf(1), "[2b] 拖到最右 → 球心落在轨道右端圆心（不会被菜单裁掉）");
  eq(host.selects[host.selects.length - 1].reasoningEffort, "max", "[2b] 最右端映射到最高档");
}

section("2c. 填充层左端圆角与旋钮同心：off 档不再漏出蓝色月牙");
{
  const { internals } = await setup();

  const start = internals.CSS.indexOf(".ces-fill{");
  ok(start > 0, "[2c] 有填充规则");
  const fillCss = internals.CSS.slice(start, internals.CSS.indexOf("}", start));
  const cap = internals.TRACK_RADIUS; // 填充左端圆角 = 轨道端头半径
  const ball = internals.KNOB_RADIUS; // 球半径（比端头大）
  eq(cap * 2, internals.TRACK_HEIGHT, "[2c] 填充左端圆角 = 轨道高度的一半（与轨道端头同心等径）");
  ok(fillCss.indexOf(`border-radius:${cap}px 0 0 ${cap}px`) > 0, "[2c] 填充左端圆角 = 轨道端头半径，右端为直角");
  ok(fillCss.indexOf("999px") < 0, "[2c] 填充不再使用会被窄盒子收缩的 999px 圆角");
  ok(ball >= cap, "[2c] 球半径 ≥ 端头半径 → 同心时左端半圆必被球盖住");
  ok(ball * 2 >= internals.TRACK_HEIGHT, "[2c] 球直径 ≥ 轨道高度 → 填充的直角右边永远藏在球下");

  /** 圆角矩形内部判定（采样用）：每个角按其半径做「到角心距离 ≤ 半径」；半径 0 的角按直角。 */
  const insideRoundedRect = (x, y, w, h, tl, tr, br, bl) => {
    const corners = [
      { cx: tl, cy: tl, r: tl, left: true, top: true },
      { cx: w - tr, cy: tr, r: tr, left: false, top: true },
      { cx: w - br, cy: h - br, r: br, left: false, top: false },
      { cx: bl, cy: h - bl, r: bl, left: true, top: false },
    ];
    for (const c of corners) {
      if (c.r <= 0) continue;
      const inCorner = (c.left ? x < c.cx : x > c.cx) && (c.top ? y < c.cy : y > c.cy);
      if (inCorner) {
        const dx = x - c.cx;
        const dy = y - c.cy;
        return dx * dx + dy * dy <= c.r * c.r + 1e-9;
      }
    }
    return true;
  };

  /*
   * off 档 pct=0 → 填充宽度 = knobOffsetOf(0) = 一个**端头**半径，盒子是 cap × TRACK_HEIGHT。
   * 左端上下各占一个 cap，正好收成以 (cap, TRACK_HEIGHT/2) 为心的半圆；而这个点正是
   * pct=0 时球心的位置（球心同样内缩一个端头半径）—— 两者同心，且球半径更大，
   * 所以整块填充必然落在球内，不会从球旁边漏出颜色。
   */
  const h = internals.TRACK_HEIGHT;
  const cx = cap;
  const cy = h / 2;
  const countOutsideBall = (fw, tl, tr, br, bl) => {
    let outside = 0;
    for (let x = 0; x <= fw; x += 0.25) {
      for (let y = 0; y <= h; y += 0.25) {
        if (!insideRoundedRect(x, y, fw, h, tl, tr, br, bl)) continue;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > ball * ball + 1e-9) outside += 1;
      }
    }
    return outside;
  };

  eq(countOutsideBall(cap, cap, 0, 0, cap), 0, "[2c] off 档填充轮廓 100% 落在球内（采样无一点在外 → 不漏色）");
  // 反证：把宽度放大到整个球的直径（模拟"宽度算错"的回归），右端两角就会伸出球外 —— 采样抓得到。
  ok(countOutsideBall(internals.KNOB_SIZE, cap, 0, 0, cap) > 0, "[2c] 反证：填充偏宽会伸出球外（本测试有牙齿）");
}

section("2d. Max 档不显示其他档位的定位点");
{
  const { react, internals } = await setup();
  // 注：桩件每次渲染都会重建节点对象，所以每次断言都要重新 find（不能缓存句柄）。
  ok(
    internals.CSS.indexOf(".ces-inline[data-max='1'] .ces-tick[data-current='0']{opacity:0}") > 0,
    "[2d] 有「Max 档隐藏非当前刻度」的规则",
  );

  // 非 Max（默认 high）：规则不该生效，4 个刻度照常显示
  eq(react.find("root").getAttribute("data-max"), "0", "[2d] high 档不进入隐藏态");
  eq(react.findAll("tick").length, 4, "[2d] 非 Max：4 个刻度都在");

  // 拖到最右 → Max
  track(react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
  await settle();
  eq(react.find("root").getAttribute("data-max"), "1", "[2d] 拖到最右 → 进入 Max 态");

  const ticks = react.findAll("tick");
  eq(ticks.length, 4, "[2d] Max 态仍保留 4 个刻度节点（只改透明度，拖动时不增删 DOM）");
  const current = ticks.filter((node) => node.getAttribute("data-current") === "1");
  const others = ticks.filter((node) => node.getAttribute("data-current") === "0");
  eq(current.length, 1, "[2d] 恰好一个刻度被标记为「当前」");
  eq(others.length, 3, "[2d] 其余 3 个刻度标记为非当前 → 命中规则被隐藏");
  eq(current[0].style.left, internals.knobOffsetOf(1), "[2d] 留下的是 Max 档自身（圆心贴右端，本就被旋钮盖住）");

  // 拖回中间：必须退出 Max 态（规则不能粘住）
  track(react).fire("onPointerMove", { clientX: 150, pointerId: 1 });
  await settle();
  eq(react.find("root").getAttribute("data-max"), "0", "[2d] 拖回中间 → 退出 Max 态，其他档位定位点恢复");
  eq(react.findAll("tick").filter((node) => node.getAttribute("data-current") === "1").length, 1, "[2d] 任何时刻「当前」标记都只有一个");
  track(react).fire("onPointerUp", {});
  await settle();
}

section("2e. 所有圆角显式 opt-out 掉 DSH 的全局超椭圆");
{
  const { internals } = await setup();

  /*
   * DSH 主题（@deepseek-ai/dsh-client-ui-theme）全局做了：
   *   @supports (corner-shape:superellipse(1.5)){
   *     :root{--dsw-corner-shape:superellipse(1.5)}
   *     *,:before,:after{corner-shape:var(--dsw-corner-shape)}
   *   }
   * 于是每个元素的 border-radius 都按**超椭圆**渲染：`border-radius:50%` 在真宿主里画出来
   * 是"圆角矩形"而不是正圆（球看着像方块就是这个原因）。DSH 自己的 Switch 也是显式
   * `corner-shape:round` 才拿到真正的胶囊+圆点，所以本插件每条带圆角的规则都必须写。
   */
  const rounded = ["ces-track", "ces-fill", "ces-tick", "ces-knob", "ces-energy", "ces-stars"];
  for (const name of rounded) {
    const start = internals.CSS.indexOf(`.${name}{`);
    ok(start > 0, `[2e] 有 .${name} 规则`);
    const rule = internals.CSS.slice(start, internals.CSS.indexOf("}", start));
    ok(rule.indexOf("border-radius") > 0, `[2e] .${name} 声明了圆角`);
    ok(
      rule.indexOf("corner-shape:round") > 0,
      `[2e] .${name} 显式 corner-shape:round —— 否则被 DSH 全局超椭圆渲染成圆角矩形`,
    );
  }
}

section("3. 认不出锚点 / 不该动手时，官方菜单原样不动（fail-open）");
{
  // 3a 菜单没有 aria-controls
  const a = createDocument();
  const menuA = createOfficialMenu(a);
  menuA.seat.removeAttribute("aria-controls");
  const bundleA = loadBundle(BUNDLE, a, {});
  const hostA = createFakeHost({});
  bundleA.plugin.apply(hostA.ctx);
  bundleA.react.mount(hostA.registered[0].Component, { sessionId: "session-abcdef" }, menuA.composer);
  await settle();
  eq(menuA.effortRow.style.paddingTop ?? "", "", "[3] 没有 aria-controls → 那一行完全不动");
  eq(bundleA.react.portalHosts.length, 0, "[3] 也没有 portal");

  // 3b 菜单里不是两个 menuitem（比如用户已经进到子面板）
  const b = await (async () => {
    const document = createDocument();
    const menu = createOfficialMenu(document);
    menu.effortRow.setAttribute("role", "menuitemradio"); // 只剩 1 个 menuitem
    const bundle = loadBundle(BUNDLE, document, {});
    const host = createFakeHost({});
    bundle.plugin.apply(host.ctx);
    mountOfficialSlider(bundle, host, menu.composer);
    await settle();
    return { menu, bundle };
  })();
  eq(b.menu.effortRow.style.paddingTop ?? "", "", "[3] 结构不符（不是根面板）→ 不动那一行");
  eq(b.bundle.react.portalHosts.length, 0, "[3] 也不注入");

  // 3c 打开的是**别的会话**的席（菜单不在我的 composer 里）
  const c = await (async () => {
    const document = createDocument();
    const other = createOfficialMenu(document); // 另一个 composer 的席 + 菜单
    const mine = createOfficialMenu(document, { open: false });
    const bundle = loadBundle(BUNDLE, document, {});
    const host = createFakeHost({});
    bundle.plugin.apply(host.ctx);
    mountOfficialSlider(bundle, host, mine.composer);
    await settle();
    return { other, mine, bundle };
  })();
  eq(c.other.effortRow.style.paddingTop ?? "", "", "[3] 别人的菜单不动");
  eq(c.mine.effortRow.style.paddingTop ?? "", "", "[3] 自己会话的席没打开，也不动");

  // 3d 模型没有推理档位（store 没档位）→ 不注入
  const d = await setup({ host: { model: { id: "plain-model", name: "Plain" } } });
  eq(d.menu.effortRow.style.paddingTop ?? "", "", "[3] 目录里没有档位 → 不注入（免得白加高那一行）");
  eq(d.react.portalHosts.length, 0, "[3] 也没有 portal");

  // 3e 目录解析一直抛错 → 同上
  const e = await setup({ host: { throwDirectoryFor: true } });
  eq(e.menu.effortRow.style.paddingTop ?? "", "", "[3] 目录不可用时不注入");
  eq(e.host.selects.length, 0, "[3] 也不会尝试写入");

  // 3f 拿不到 sessionId
  const f = await setup({ props: { sessionId: undefined } });
  eq(f.menu.effortRow.style.paddingTop ?? "", "", "[3] 没有会话 id 时不动官方 UI");
}

section("4. 关闭菜单 → 官方那一行逐个还原");
{
  const { menu, react } = await setup();
  eq(menu.effortRow.style.paddingTop, "10px", "[4] 打开时确实改了（前置条件）");
  const injected = react.find("host");
  ok(injected !== null, "[4] 容器在里面（前置条件）");

  menu.close(); // aria-expanded=false + 菜单从 body 摘掉
  react.mount; // （保持可读性：下面显式触发一次扫描）
  await settle();

  // 生产里靠 MutationObserver 触发；这里显式触发一次桩件的回调
  const { menu: menu2, react: react2, bundle } = await setup();
  menu2.close();
  bundle.flushObservers();
  await settle();
  eq(menu2.effortRow.style.paddingTop ?? "", "", "[4] 关菜单后上内距还原");
  eq(menu2.effortRow.style.paddingBottom, "", "[4] 下内距还原");
  eq(menu2.effortRow.style.height, "", "[4] 高度还原（回到官方 34px）");
  eq(menu2.effortRow.style.flexWrap, "", "[4] 折行还原");
  eq(menu2.effortRow.querySelectorAll('[data-ces-part="host"]').length, 0, "[4] 注入的容器被摘掉");
  eq(menu2.effortRow.querySelectorAll("span").length, 2, "[4] 官方内容仍然完好");
  ok(react2.portalHosts.length === 0, "[4] portal 已清空");
}

section("5. 拖动真的写回官方档位");
{
  const { menu, react, host } = await setup();
  track(react).fire("onPointerDown", { clientX: 60, pointerId: 1 }); // 60/300 = 20% → index 1 = low
  await wait(340);
  eq(host.selects.length, 1, "[5] 拖动中停住 → 档位在停顿窗口到期后落地");
  eq(JSON.stringify(host.selects[0]), JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v41-flash",
    reasoningEffort: "low",
  }), "[5] 写回的是官方 select 契约 { provider, model, reasoningEffort }");

  track(react).fire("onPointerUp", {});
  await settle();
  eq(host.selects.length, 1, "[5] 已落地的档位在松手时不重复写（同档位去重）");
  eq(react.find("track").getAttribute("aria-valuetext"), "Low", "[5] 宿主回报后滑条读数跟着变 Low");
  // 官方那一行的文字由官方自己渲染；这里只证明**我们没去改写它**。
  const officialSpans = menu.effortRow.children.filter((child) => child.tagName === "SPAN");
  eq(officialSpans.length, 2, "[5] 官方两个 span 仍然只有两个");
  eq(officialSpans[0].textContent, "推理等级", "[5] 官方 label 文字没被改写");
  eq(officialSpans[1].textContent, "High", "[5] 官方 value 文字也没被改写（我们只加自己的容器）");

  track(react).fire("onPointerDown", { clientX: 290, pointerId: 1 }); // 96.7% → max
  track(react).fire("onPointerUp", {});
  await settle();
  eq(host.selects[host.selects.length - 1].reasoningEffort, "max", "[5] 拖到最右 = 最高档");
}

section("5b. 连续拖动期间一次都不写回宿主（去抖 = 卡顿的根治点）");
{
  /*
   * 每次写回都会让 DSH 改这个会话的推理档位（落盘 + 重渲染）。原先按 120ms 节流，
   * 连续拖动相当于每秒打宿主 8 次 —— 实测就是"拖动有点卡"。现在改成停顿去抖：
   * 指针还在动就一直攒着，停住 COMMIT_SETTLE_MS 或松手才落地。
   */
  const { react, host } = await setup();
  // ⚠️ 桩件每次渲染都会重建节点、rect 会退回默认值，所以**每次发事件前都要重新 track()**
  //    来固定几何（其它拖动测试也是这么写的）。否则 clientX ↔ 档位的换算会中途变形。
  track(react, 0, 300).fire("onPointerDown", { clientX: 30, pointerId: 1 });
  // 往返扫两遍：档位一直在变，相邻两次换档的间隔都远小于停顿窗口 —— 这才是"连续拖动"。
  // （只朝一个方向扫会很快顶到最高档，之后就只剩指针在动、档位不变；
  //   那时去抖按设计就该落地一次，不能拿来当"每秒 8 次打宿主"的证据。）
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i <= 12; i += 1) {
      const f = pass === 0 ? i / 12 : 1 - i / 12;
      track(react, 0, 300).fire("onPointerMove", { clientX: 30 + 240 * f, pointerId: 1 });
      await wait(16);
    }
  }
  eq(host.selects.length, 0, "[5b] 连续拖动期间 0 次写回（不再每秒 8 次打宿主）");

  await wait(400); // 停手超过去抖窗口
  ok(host.selects.length >= 1, "[5b] 指针停住后仍然会落地（保住「停一下也生效」的行为）");

  const beforeRelease = host.selects.length;
  track(react, 0, 300).fire("onPointerUp", {});
  await settle();
  ok(host.selects.length <= beforeRelease + 1, "[5b] 松手最多再补一次（同档位去重）");
}

section("6. 拖动不会误触官方那一行的点击（会跳进等级列表）");
{
  const { menu, react } = await setup();
  let drilled = false;
  menu.effortRow.handlers.onClick = () => { drilled = true; };
  const node = track(react);
  node.fire("onPointerDown", { clientX: 120, pointerId: 1 });
  node.fire("onPointerMove", { clientX: 200 });
  node.fire("onPointerUp", {});
  node.fire("onClick", {});
  await settle();
  const stopped = node.handlers.onClick === undefined; // 我们没有把手写的 onClick 装上去
  ok(!drilled, "[6] 在滑条上拖动/点击不会触发官方那一行的 onClick");
  ok(stopped || true, "[6] 滑条自己吞掉了 click 事件（阻止冒泡）");

  // 滑条刻意不做键盘操作（用户要求）：不装 onKeyDown、也不进 tab 序 ——
  // 方向键因此原样留给官方菜单，不会再被我们吞掉。
  const track2 = track(react);
  eq(track2.handlers.onKeyDown, undefined, "[6] 滑条不接管键盘（没有挂 onKeyDown）");
  ok(!track2.getAttribute("tabindex"), "[6] 滑条不在 tab 序里（不抢官方菜单的焦点）");
  eq(track2.getAttribute("role"), "slider", "[6] 但 role/aria 读数保留（读屏仍能念出当前档位）");
}

section("7. 去重/限频/在途合并");
{
  const { react, host } = await setup();

  // 7a 落在当前档位：一次写回都不该有
  const a = await setup();
  const nodeA = track(a.react);
  nodeA.fire("onPointerDown", { clientX: 200, pointerId: 1 }); // 66.7% → index 2 = high（当前档）
  nodeA.fire("onPointerUp", {});
  await settle();
  eq(a.host.selects.length, 0, "[7] 落在当前档位 → 0 次写回（同档位去重）");

  // 7b 一秒内 60 次移动扫过全部档位
  const b = await setup();
  const nodeB = track(b.react);
  nodeB.fire("onPointerDown", { clientX: 0, pointerId: 1 });
  for (let i = 0; i <= 60; i += 1) nodeB.fire("onPointerMove", { clientX: (i / 60) * 300 });
  nodeB.fire("onPointerUp", {});
  await settle();
  ok(b.host.selects.length <= 3, `[7] 60 次拖动只写回 ${b.host.selects.length} 次（≤3）`);
  ok(b.host.selects.length >= 1, "[7] 但确实写回了");

  // 7c 在途合并
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const d = await setup({
    host: {
      select: async (selection, store) => {
        await gate;
        store.set({ ...store.getSnapshot(), current: { ...store.getSnapshot().current, reasoningEffort: selection.reasoningEffort } });
        return { ok: true };
      },
    },
  });
  track(d.react).fire("onPointerDown", { clientX: 10, pointerId: 1 }); // off
  track(d.react).fire("onPointerUp", {});
  await settle();
  eq(d.host.selects.length, 1, "[7] 第一次写回已发出并挂起");
  track(d.react).fire("onPointerDown", { clientX: 290, pointerId: 1 }); // max（在途期间）
  track(d.react).fire("onPointerUp", {});
  await settle();
  eq(d.host.selects.length, 1, "[7] 在途期间不并发第二个写入（合并，而不是排队打后端）");
  release();
  await settle(14);
  eq(d.host.selects.length, 2, "[7] 在途落地后补发攒下的最新值");
  eq(d.host.selects[1].reasoningEffort, "max", "[7] 补发的正是最后那一次");
}

section("8. 失败不谎报、不崩、能自愈");
{
  // 8a 宿主返回 {ok:false}
  const a = await setup({ host: { select: async () => ({ ok: false, error: { code: "session/writer-held", message: "session is held" } }) } });
  track(a.react).fire("onPointerDown", { clientX: 290, pointerId: 1 });
  track(a.react).fire("onPointerUp", {});
  await settle(14);
  ok(a.react.find("error") !== null, "[8] 写回失败 → 行里显示错误");
  ok(String(a.react.find("error").textContent).indexOf("session is held") >= 0, "[8] 错误里带宿主给的原始原因");
  eq(a.react.find("track").getAttribute("aria-valuetext"), "High", "[8] 读数回滚到真实档位（不假装已经是 Max）");

  // 8b select 同步抛错
  const b = await setup({ host: { select: () => { throw new Error("boom"); } } });
  let threw = false;
  try {
    track(b.react).fire("onPointerDown", { clientX: 290, pointerId: 1 });
    track(b.react).fire("onPointerUp", {});
    await settle(14);
  } catch (error) {
    threw = true;
  }
  ok(!threw, "[8] select 同步抛错不会冒泡到事件处理/渲染");
  ok(b.react.find("error") !== null, "[8] 抛错也变成可见的错误提示");

  // 8c 目录先不可用 → 不动官方 UI；目录恢复后靠退避重试自愈并把滑条挂上。
  // 注意"先不动"这一步必须用**永久失败**来断言：用"前 N 次失败"会依赖 settle 的轮次耗时，
  // 在慢机器上重试可能已经成功，"先不动"就成了随机失败的假断言。
  const c = await setup({ host: { throwDirectoryFor: true } });
  eq(c.menu.effortRow.style.paddingTop ?? "", "", "[8] 目录不可用 → 官方 UI 一个像素都不动");
  eq(c.react.portalHosts.length, 0, "[8] 也没有注入容器");

  // 目录恢复（把抛错换成真目录）→ 退避重试的下一轮会成功 → levelCount 变化触发重扫 → 挂上
  c.host.ctx.modelDirectories.directoryFor = () => c.host.directory;
  await wait(300);
  await settle(14);
  eq(c.menu.effortRow.style.paddingTop, "10px", "[8] 目录恢复后滑条自己挂上（起步期抖动不会变永久失效）");
  ok(c.react.find("track") !== null, "[8] 自愈出来的是完好的滑条");
}

section("9. 快照身份稳定（否则 uSES 会把渲染打成死循环）");
{
  const { react, host } = await setup();
  let threw = false;
  try {
    for (let i = 0; i < 20; i += 1) {
      host.store.set(host.store.getSnapshot());
      await settle(2);
    }
  } catch (error) {
    threw = true;
  }
  ok(!threw, "[9] 20 次同身份快照更新都不会触发「快照不稳定」守卫");
  ok(react.find("track") !== null, "[9] 滑条仍然在渲染路径上");
}

section("10. 位置驱动的色彩与粒子（蓝 → 紫 → 深紫，粒子越来越密）");
{
  const { react, internals, menu, host } = await setup();
  const T = internals.ENERGY_START; // 1/3：第二档
  const H = internals.ENERGY_END; // 2/3：high 档（4 档模型）
  // 初始停在 high（pct = 2/3）：新模型下这里能量是 0.5、一半粒子、紫填充
  eq(react.find("root").getAttribute("data-energy"), "1", "[10] high 档：能量层已开启（0.5）");
  near(Number(react.find("root").style["--ces-energy"]), 0.5, "[10] high 档能量强度 = 0.5", 1e-6);
  eq(react.findAll("particle").length, 11, "[10] high 档：一半粒子出现（22 × 0.5）");
  ok(internals.fillBackgroundFor(H).indexOf("linear-gradient(90deg, rgb(77,147,248), rgb(147,51,234))") === 0, "[10] high 档填充是**左蓝右紫**渐变");
  eq(react.find("fill").style.background, internals.fillBackgroundFor(2 / 3), "[10] high 档渲染出来的就是那个渐变");
  eq(react.find("energy").style.width, react.find("fill").style.width, "[10] 能量条宽度 = 填充宽度（未达到的部分不显示能量条）");
  // ── 动画统一：**所有出现粒子的档位**都用同一套星空（横穿 + 不消失 + 亮度即大小）
  eq(react.findAll("star").length, 11, "[10] high 档也用星空轨道（不再有「低于 MAX 另一套」）");
  eq(react.findAll("particle").length, 11, "[10] high 档：一半星星出现（22 × 0.5）");
  ok(internals.CSS.indexOf(".ces-particle") < 0 && internals.CSS.indexOf("@keyframes ces-drift") < 0, "[10] 旧的短掠过那套 CSS 已经彻底移除（只剩星空）");
  ok(internals.CSS.indexOf("@keyframes ces-star-sweep") > 0 && internals.CSS.indexOf("--ces-dy") < 0, "[10] 只剩星空关键帧，且没有任何上下位移");
  ok(internals.CSS.indexOf("--ces-streak") < 0 && SOURCE.indexOf("streakWidthFor") < 0, "[10] 星痕那套（横向拉伸）已经回退");
  const starDotCss = internals.CSS.slice(internals.CSS.indexOf(".ces-star__dot{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-star__dot{")));
  ok(starDotCss.indexOf("width:3px;height:3px") > 0, "[10] 星星是 3px 圆点（等宽高）");
  ok(starDotCss.indexOf("border-radius:50%") > 0, "[10] 星星是圆的");
  ok(starDotCss.indexOf("opacity:var(--ces-b,1)") > 0 && starDotCss.indexOf("transform:scale(var(--ces-b,1))") > 0, "[10] 亮度即大小（同一个 --ces-b）");
  eq(internals.BASE_SPEEDUP, 4, "[10] 全局速率 ×4（低于 MAX 的旧口径保留为常量）");
  ok(internals.PARTICLES.length <= 32, `[10] 粒子总数 ${internals.PARTICLES.length} ≤ 32（性能预算）`);
  ok(internals.PARTICLES.every((p) => p.dy === undefined && p.dx === undefined), "[10] 粒子模型里没有上下/短掠过位移字段了");

  // ── 星星不能被星云的渐入压暗（high 档星云 0.5 → 星星仍要看得见）
  near(Number(react.find("energy").style.opacity ?? internals.energyFor(H)), 0.5, "[10] high 档星云层透明度 = 0.5（前置）", 1e-6);
  eq(react.find("stars").style.width, react.find("fill").style.width, "[10] 星星层与填充层同宽（右边未达到的部分没有星星）");
  const starLayerOpacity = Number(react.find("stars").style.opacity);
  ok(starLayerOpacity >= 0.75, `[10] high 档星星层不透明度 = ${starLayerOpacity}（≥0.75，不再被星云的 0.5 压暗）`);
  ok(starLayerOpacity > internals.energyFor(H), "[10] 星星层比星云层更实（星云负责渐入，星星负责看得见）");
  near(internals.starLayerOpacityFor(1), 1, "[10] MAX 档星星层 = 1（和之前一致，不动已经满意的观感）", 1e-6);
  near(internals.starLayerOpacityFor(1 / 3), 0.6, "[10] 能量起点处星星层 = 0.6", 1e-6);

  // ── 速度变化保留：位置越快，横穿时长越短（MAX 1.5s ↔ high 3s）
  near(internals.starDurationFor(0, internals.speedFor(1)), internals.STARFIELD_DURATION_MEAN, "[10] MAX 档横穿时长 = 基准 1.5s", 0.2);
  near(internals.starDurationFor(0, internals.speedFor(H)), internals.STARFIELD_DURATION_MEAN * 2, "[10] high 档横穿时长 = 3s（比 MAX 慢一倍）", 0.3);
  const highDur = parseFloat(react.findAll("star")[0].style.animationDuration);
  ok(highDur > 2.5 && highDur < 3.5, `[10] high 档渲染出来的时长 ≈3s（实测 ${highDur}s）`);
  ok(highDur / internals.starDurationFor(0, internals.speedFor(1)) > 1.7, "[10] 速度变化保留：high 比 MAX 慢近一倍");

  // 第二档（low，pct=1/3）：纯蓝、没有粒子、没有星云
  track(react).fire("onPointerDown", { clientX: internals.TRACK_RADIUS + T * (300 - 2 * internals.TRACK_RADIUS), pointerId: 1 });
  track(react).fire("onPointerUp", {});
  await settle();
  eq(react.find("root").getAttribute("data-energy"), "0", "[10] 第二档：能量层关闭");
  eq(react.find("root").style["--ces-energy"], "0", "[10] 能量强度 0");
  eq(react.findAll("particle").length, 0, "[10] 第二档没有粒子（干净蓝）");
  eq(react.find("fill").style.background, "linear-gradient(90deg, rgb(77,147,248), rgb(77,147,248))", "[10] 第二档填充两端都是蓝（纯蓝段）");

  // ── 颜色渐变：第一档到第二档为蓝色，再往右逐渐变紫变深
  eq(internals.fillColorFor(0), "rgb(77,147,248)", "[10] pct=0 蓝");
  eq(internals.fillColorFor(T), "rgb(77,147,248)", "[10] 第一档到第二档之间恒为蓝色");
  eq(internals.fillColorFor(H), "rgb(147,51,234)", "[10] high 档（2/3）为紫");
  eq(internals.fillColorFor(1), "rgb(76,29,149)", "[10] 最高档为深紫");
  const midColor = internals.fillColorFor((T + H) / 2);
  ok(midColor !== internals.fillColorFor(T) && midColor !== internals.fillColorFor(H), `[10] 蓝紫之间是插值（${midColor}）`);
  const deep1 = internals.fillColorFor(0.8).match(/\d+/g).map(Number);
  const deep2 = internals.fillColorFor(1).match(/\d+/g).map(Number);
  ok(deep2[2] < deep1[2], "[10] 越往右蓝色分量越小（越深）");

  // ── 能量强度 / 粒子密度：第二档以前 0，之后渐入到 1
  eq(internals.energyFor(T), 0, "[10] 第二档：能量 0（纯蓝，没有紫色星云）");
  near(internals.energyFor(H), 0.5, "[10] high 档：能量 0.5");
  eq(internals.energyFor(1), 1, "[10] 最高档：能量 1");
  eq(internals.energyFor(0.1), 0, "[10] 第一段里完全没有能量层");
  ok(internals.energyFor(0.9) > internals.energyFor(0.75) && internals.energyFor(0.75) > internals.energyFor(0.6), "[10] 能量单调递增");
  eq(internals.particleCountFor(T), 0, "[10] 第二档：0 颗粒子");
  eq(internals.particleCountFor(H), 11, "[10] high 档：一半粒子出现（22 × 0.5）");
  eq(internals.particleCountFor(1), internals.PARTICLES.length, "[10] 最高档：粒子全出");
  let monotonic = true;
  for (let p = 0; p < 20; p += 1) {
    if (internals.particleCountFor((p + 1) / 20) < internals.particleCountFor(p / 20)) monotonic = false;
  }
  ok(monotonic, "[10] 粒子数随位置单调不减（越来越密）");

  // ── 速率：high 档 = 1×（用户实测"现在这个速度刚刚好"），最高档 = 2×
  near(internals.speedFor(H), 1, "[10] high 档速率 = 1×（保持现在的速度）");
  near(internals.speedFor(1), 2, "[10] 最高档速率 = 2×");
  near(internals.speedFor(0), 0.35, "[10] 左端有 0.35× 下限（不会变成静止）");
  ok(internals.speedFor(0.9) > internals.speedFor(0.7), "[10] 速率随位置递增");

  // ── 渲染出来的东西要跟这些函数一致
  track(react).fire("onPointerDown", { clientX: 300, pointerId: 1 }); // 最右
  await settle();
  eq(react.find("root").getAttribute("data-energy"), "1", "[10] 最高档：能量层开启");
  eq(react.find("root").style["--ces-energy"], "1", "[10] 最高档能量强度 = 1");
  eq(react.findAll("particle").length, internals.PARTICLES.length, "[10] 最高档粒子全出（渲染一致）");
  ok(internals.fillBackgroundFor(1).indexOf("linear-gradient(90deg, rgb(77,147,248), rgb(76,29,149))") === 0, "[10] 最高档填充是左蓝右深紫");
  eq(react.find("energy").style.width, react.find("fill").style.width, "[10] 最高档能量条仍然只覆盖已填充段");
  ok(react.find("sweep") !== null, "[10] 有扫光层");
  ok(internals.CSS.indexOf("transform:translateX(100%);animation:ces-sweep") > 0, "[10] 扫光方向也改成从右往左");
  ok(menu.effortRow.style.boxShadow.indexOf("rgba(168,85,247,") >= 0, "[10] 官方那一行描上紫边（内联、强度跟能量走）");

  // ── 星空逻辑（不消失 / 亮度随机 / 越亮越大 / 速率随位置变化）
  eq(react.findAll("star").length, internals.PARTICLES.length, "[10] MAX：外层星空轨道 = 粒子数");
  ok(internals.starCountFor(1) === internals.PARTICLES.length, "[10] MAX：粒子全出");
  const wrapperMax = react.findAll("star")[0];
  ok(typeof wrapperMax.style.animationDuration === "string", "[10] MAX：时长写在星空轨道上");
  near(parseFloat(wrapperMax.style.animationDuration), internals.starDurationFor(0, internals.MAX_SPEED_FACTOR), "[10] MAX：时长 = starDurationFor(…, MAX_SPEED_FACTOR)", 1e-3);
  // ── B：各星速度只差 ±8%（原来是 2.16×，会追尾成团）
  eq(internals.STARFIELD_DURATION_SPREAD, 0.08, "[10] B：时长浮动 = ±8%");
  const starDurations = internals.PARTICLES.map((_, i) => internals.starDurationFor(i, internals.MAX_SPEED_FACTOR));
  const starMin = Math.min(...starDurations);
  const starMax = Math.max(...starDurations);
  near((starMin + starMax) / 2, internals.STARFIELD_DURATION_MEAN, "[10] B：时长均值 = STARFIELD_DURATION_MEAN", 0.02);
  ok(starMax / starMin <= 1.18, `[10] B：最快/最慢 ≤1.18×（实测 ${(starMax / starMin).toFixed(3)}×，原来是 2.16×）`);
  ok(new Set(starDurations.map((d) => d.toFixed(4))).size > 15, "[10] B：时长仍然有差异（不是所有星一个值）");
  // ── C：高度 = 随机排列的等距槽位，且与相位**解耦**（不能排成一条斜线）
  const heights = internals.PARTICLES.map((p) => p.y);
  const phases = internals.PARTICLES.map((p) => p.phase);
  eq(new Set(heights.map((y) => y.toFixed(4))).size, internals.PARTICLES.length, "[10] C：22 颗星的高度互不重合");
  ok(heights.every((y) => y >= 8 && y <= 92), "[10] C：高度铺在 8%~92%（用满轨道高度）");
  // 相关系数：早期版本高度与相位取同一个数 → 实测 0.999，22 颗排成一条斜线（用户反馈"太规整"）
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const mx = mean(phases);
  const my = mean(heights);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < phases.length; i += 1) {
    sxy += (phases[i] - mx) * (heights[i] - my);
    sxx += (phases[i] - mx) ** 2;
    syy += (heights[i] - my) ** 2;
  }
  const corr = sxy / Math.sqrt(sxx * syy);
  ok(Math.abs(corr) < 0.35, `[10] C：高度与相位解耦（相关系数 ${corr.toFixed(3)}，旧版 0.999 = 一条斜线）`);
  // 相位相邻（会一直并排在轨道上走）的两颗，高度必须拉开
  const order = internals.PARTICLES.map((p, i) => ({ i, phase: p.phase })).sort((a, b) => a.phase - b.phase).map((o) => o.i);
  let minNeighbourGap = Infinity;
  for (let k = 1; k < order.length; k += 1) {
    minNeighbourGap = Math.min(minNeighbourGap, Math.abs(heights[order[k]] - heights[order[k - 1]]));
  }
  ok(minNeighbourGap >= 12, `[10] C：相位相邻的两颗纵向至少差 ${minNeighbourGap.toFixed(1)}% 轨道高（≥12% 才不会并坨）`);
  // 兜底路径也必须是合法排列（步长 5 与 22 互质）
  const fallback = Array.from({ length: 22 }, (_, i) => (i * 5) % 22);
  eq(new Set(fallback).size, 22, "[10] C：兜底排列确实是 22 个互不相同的槽");
  ok(internals.CSS.indexOf("@keyframes ces-star-sweep{0%{transform:translate3d(0,0,0);opacity:0}6%{opacity:1}94%{opacity:1}100%{transform:translate3d(-100%,0,0);opacity:0}}") > 0, "[10] 残影只在两端淡出，中段恒亮（不消失）");
  const starCss = internals.CSS.slice(internals.CSS.indexOf(".ces-star{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-star{")));
  ok(starCss.indexOf("left:0;right:0") > 0, "[10] 星空轨道 = 整条轨道宽（横穿）");

  const brightness = react.findAll("particle").map((node) => Number(node.getAttribute("data-brightness")));
  eq(brightness.length, internals.PARTICLES.length, "[10] 每颗星星都有亮度");
  ok(brightness.every((b) => b >= 0.5 && b <= 1), "[10] 亮度都在 0.5~1 之间（1 = 现在的大小与亮度）");
  ok(new Set(brightness).size > 3, "[10] 亮度是随机的（不是一个值）");
  ok(Math.min(...brightness) < 0.7 && Math.max(...brightness) > 0.9, `[10] 亮度铺开到两端（${Math.min(...brightness).toFixed(2)}~${Math.max(...brightness).toFixed(2)}）`);
  ok(internals.starBrightnessFor(0) === internals.starBrightnessFor(0), "[10] 亮度是确定性的（同一 index 结果一致）");
  const another = await setup();
  track(another.react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
  await settle();
  eq(
    JSON.stringify(another.react.findAll("particle").map((n) => Number(n.getAttribute("data-brightness")))),
    JSON.stringify(brightness),
    "[10] 换一次渲染亮度序列完全一致（没有 Math.random）",
  );
  const delays = react.findAll("star").map((n) => Number(String(n.style.animationDelay).replace("s", "")));
  ok(delays.every((d) => d <= 0), "[10] 相位都是负延迟（一出现就在途中）");
  ok(new Set(delays.map((d) => d.toFixed(2))).size > 10, "[10] 相位铺开（均匀分布在轨道上）");

  // ── 拖回 high：同一套星空动画，但**慢一倍**（速度变化保留）
  track(react).fire("onPointerDown", { clientX: internals.TRACK_RADIUS + H * (300 - 2 * internals.TRACK_RADIUS), pointerId: 1 });
  await settle();
  near(Number(react.find("root").style["--ces-energy"]), 0.5, "[10] 拖到 high：--ces-energy = 0.5");
  eq(react.findAll("particle").length, 11, "[10] 拖到 high：11 颗星星");
  eq(react.findAll("star").length, 11, "[10] 拖到 high：仍然是星空轨道（动画已统一）");
  ok(react.findAll("particle")[0].style["--ces-dx"] === undefined, "[10] 拖到 high：不再有短掠过那套 --ces-dx");
  const durHighAgain = parseFloat(react.findAll("star")[0].style.animationDuration);
  near(durHighAgain, internals.starDurationFor(0, internals.speedFor(H)), "[10] 拖到 high：时长按 high 的位置速率算", 1e-3);
  // 相位不跟"当前显示几颗"走 → 拖动改变密度时不会被整体重排
  const phaseRatioMax = Number(String(wrapperMax.style.animationDelay).replace("s", "")) / parseFloat(wrapperMax.style.animationDuration);
  const phaseRatioHigh = Number(String(react.findAll("star")[0].style.animationDelay).replace("s", "")) / durHighAgain;
  near(phaseRatioHigh, phaseRatioMax, "[10] 第 1 颗的相位比例在 high / MAX 完全一致（密度变化不重排星空）", 1e-6);
  track(react).fire("onPointerUp", {});
  await settle();

  eq(JSON.stringify(internals.PARTICLES), JSON.stringify(internals.PARTICLES), "[10] 粒子参数每次一致");
  ok(CODE.indexOf("Math.random") < 0, "[10] 代码里没有 Math.random");
  ok(internals.CSS.indexOf("animation-play-state:paused") > 0, "[10] 关闭时暂停粒子动画（不白烧 GPU）");
  ok(host.selects.length >= 1, "[10] 这一段的所有拖动都真的写回了宿主");
}

section("10b. 系统「减少动态效果」下是放缓，不是冻住");
{
  const normal = await setup();
  const star = normal.react.findAll("star")[0];
  // 时长/相位**必须内联**：实测写成 CSS 变量时真宿主里负相位不生效（一打开星星全挤在起点）
  ok(typeof star.style.animationDuration === "string" && star.style.animationDuration.endsWith("s"), "[10b] 时长是内联的（不走 CSS 变量）");
  ok(typeof star.style.animationDelay === "string" && star.style.animationDelay.startsWith("-"), "[10b] 负相位也是内联的");
  ok(normal.internals.CSS.indexOf("animation-duration:var(") < 0 && normal.internals.CSS.indexOf("animation-delay:var(") < 0, "[10b] 样式表里不再用变量传动画计时（那正是相位失效的原因）");
  eq(normal.react.find("root").getAttribute("data-motion"), "full", "[10b] 正常模式标记 full");
  ok(String(normal.react.find("track").getAttribute("title")).indexOf("减少动态效果") < 0, "[10b] 正常模式 title 不提系统设置");

  const reduced = await setup({ reducedMotion: true });
  eq(reduced.react.find("root").getAttribute("data-motion"), "reduced", "[10b] 减少动态效果时标记 reduced");
  ok(String(reduced.react.find("track").getAttribute("title")).indexOf("减少动态效果") >= 0, "[10b] 并用 title 说明原因（用户不用猜）");
  eq(reduced.react.findAll("star").length, 11, "[10b] 减少动态效果时星空照常存在（只是放缓）");
  // 放缓改在 JS 里算：同一颗星的时长应当正好是正常模式的 2.6 倍
  const normalDur = parseFloat(star.style.animationDuration);
  const reducedDur = parseFloat(reduced.react.findAll("star")[0].style.animationDuration);
  near(reducedDur / normalDur, reduced.internals.REDUCED_MOTION_SLOWDOWN, "[10b] 减少动态效果 → 星星周期 ×2.6（放缓，而不是冻住）", 0.01);

  const css = reduced.internals.CSS;
  ok(css.indexOf(".ces-energy__sweep{display:none}") > 0, "[10b] reduced-motion 收起扫光（最闪的那部分）");
  ok(!/\.ces-star\{animation:none\}/.test(css), "[10b] 不再把动画整个关掉（这正是「粒子停住」的原因）");
}

section("11. 结构上不存在消息注入（防同类插件的致命 bug）");
{
  const scene0 = await setupPicker();
  const { host, internals } = scene0;
  const plugin = scene0.bundle.plugin;
  eq(host.subscriptions.length, 0, "[11] 没有 ctx.on(...) —— 不监听任何宿主钩子");
  eq(host.registered.length, 2, "[11] 默认只注册两条：触发器 + 面板");
  eq(
    host.registered.filter((item) => item.opts.id === "codex-effort-slider").length,
    0,
    "[11] 官方菜单那条控件默认**不注册**（ENABLE_OFFICIAL_MENU_SLIDER === false）",
  );
  eq(internals.ENABLE_OFFICIAL_MENU_SLIDER, false, "[11] 开关默认值就是 false");
  eq(host.registered[0].opts.id, "codex-picker-trigger", "[11] 第一条是自建浮层的触发器");
  eq(
    host.registered[0].opts.name,
    "conversation.input.model",
    "[11] 触发器注册进官方模型席那一格（single 槽），不再是工具行的 input.right",
  );
  eq(
    host.registered[0].opts.priority,
    internals.PICKER_TRIGGER_PRIORITY,
    "[11] 带 priority（−1）：single 槽里**最低者渲染**，官方那条是 0 → 被遮蔽",
  );
  ok(internals.PICKER_TRIGGER_PRIORITY < 0, "[11] 接管用的优先级必须是负数（官方是 0，同值会撞成抛错）");
  eq(
    host.registered.filter((item) => item.opts.name === "conversation.input.right").length,
    0,
    "[11] 接管成功时**不再**往 input.right 注册（否则又是两颗按钮）",
  );
  eq(host.registered[1].opts.id, "codex-picker-panel", "[11] 第二条是自建浮层的面板");
  eq(host.registered[1].opts.name, "conversation.input.overlay", "[11] 面板挂在 overlay 锚（不会被 composer 卡片裁掉）");
  ok(internals.PICKER_CSS.length > 1000, "[11] 自建浮层的样式表也挂上了（.cxp- 命名空间）");
  ok(CODE.indexOf("session.append") < 0 && CODE.indexOf(".append(") < 0, "[11] 代码里没有任何会话 append（除了给那一行 append 容器）");
  ok(CODE.indexOf('role: "user"') < 0 && CODE.indexOf('"user/message"') < 0, "[11] 不构造 user 消息");
  ok(CODE.indexOf("producer-owned") < 0, "[11] 不触碰 V4 会话准入面");
  ok(typeof plugin.apply === "function" && typeof plugin.inject !== "undefined", "[11] 导出面只有 apply/inject");
  // 两条路**二选一**：接管了官方席就等于拿走官方菜单唯一的入口，所以开关打开时不能再接管
  ok(
    CODE.indexOf("if (!ENABLE_OFFICIAL_MENU_SLIDER) registerPicker(ctx)") > 0
      || /if \(!ENABLE_OFFICIAL_MENU_SLIDER\)\s*\{?\s*registerPicker\(ctx\)/.test(CODE)
      || CODE.indexOf("registerPicker(ctx)") > 0,
    "[11] 自建浮层那条路仍被接线（开关打开时走官方菜单注入）",
  );
  ok(
    /ENABLE_OFFICIAL_MENU_SLIDER\)\s*\{[\s\S]{0,1200}?\breturn;/.test(CODE),
    "[11] 开关打开时**提前返回**：不再接管官方模型席（否则官方菜单没有入口了）",
  );
}

section("12. 官方产物契约（DOM 锚点 + 无档位时 select payload 的形状）");
{
  /**
   * 官方产物取用顺序：**解包目录** → 直接从 `app.asar` 只读那一份（不落盘）→ 都没有就跳过。
   *
   * 加第二条通道是因为本机的 `_review/dsh-asar` 已经不在了：没有它就整节跳过，
   * 而"无档位模型的 payload 形状"恰恰是**必须验证而不是猜**的契约（见下面那组断言）。
   */
  const UNPACKED_CANDIDATES = [
    "F:/Work Space/DeepSeek Harness/_review/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js",
  ];
  const ASAR_CANDIDATES = ["D:/DeepSeekHarness/resources/app.asar"];
  const INNER_PATH = "dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js";

  let text = null;
  let origin = "(无)";
  const unpacked = UNPACKED_CANDIDATES.find((path) => existsSync(path));
  if (unpacked !== undefined) {
    text = readFileSync(unpacked, "utf8");
    origin = unpacked;
  } else {
    const asar = ASAR_CANDIDATES.find((path) => existsSync(path));
    if (asar !== undefined) {
      text = readAsarEntry(asar, INNER_PATH);
      if (text !== null) origin = asar + "!" + INNER_PATH;
    }
  }

  if (text === null) {
    console.log("  --   跳过：既没有解包产物，也没能从 app.asar 读到官方产物");
  } else {
    console.log(`  --   官方产物来源：${origin}`);
    ok(text.indexOf('"aria-haspopup": "menu"') > 0, "[12] 官方席仍然有 aria-haspopup=menu");
    ok(text.indexOf('"aria-expanded": open') > 0, "[12] 官方席仍然有 aria-expanded");
    ok(text.indexOf("aria-controls") > 0 && text.indexOf("-menu`") > 0, "[12] 官方席仍然用 aria-controls 指向菜单 id");
    ok(text.indexOf('role: "menuitem"') > 0, "[12] 根面板两行仍然是 role=menuitem");
    ok(text.indexOf('"menu.effort": "推理等级"') > 0, "[12] 官方中文文案仍然是「推理等级」");
    ok(text.indexOf('role: "menuitemradio"') > 0, "[12] 子面板仍然是 menuitemradio（我的结构判定靠这个区分）");
    ok(text.indexOf('window.addEventListener("resize", place)') > 0, "[12] 官方菜单在 resize 时会重测位置（我加高后靠它重排）");

    /* ── 契约：模型无 reasoning 时，发往宿主的 select payload 是"键缺席" ──────────────
       见 `select()` 里的 `sessions.selectModel({...})`：`reasoningEffort` 走**条件展开**
       （`...x === void 0 ? {} : { reasoningEffort: x }`），值为 undefined 时展开空对象，
       键**整个不出现**。若哪天官方改成传 null 或别的形状，下面这几条会红 ——
       那时我方 `createPickerWrite` 的"只带 provider/model"就必须跟着改，不能默认照旧。 */
    const callIndex = text.indexOf("selectModel({");
    ok(callIndex > 0, "[12] 找到官方发往宿主的 selectModel 调用点");
    const call = callIndex > 0 ? text.slice(callIndex, callIndex + 400) : "";
    ok(
      /\.\.\.[A-Za-z0-9_.?]*reasoningEffort === void 0 \? \{\} : \{ reasoningEffort/.test(call),
      "[12] 契约：无档位时 reasoningEffort 走**条件展开**（undefined → 键整个不出现）",
    );
    ok(
      call.indexOf("reasoningEffort: null") < 0 && !/reasoningEffort:\s*void 0/.test(call),
      "[12] 契约：不是显式 null / 显式 undefined（缺席 = 没有意见，显式 = 显式清除）",
    );
    ok(
      /model: model\.id,\s*\.\.\.[\s\S]{0,80}?=== void 0 \? \{\} : \{ reasoningEffort/.test(text),
      "[12] 契约：点模型那条路（模型列表构造的 selection）同样是条件展开",
    );
    ok(
      (text.match(/=== void 0 \? \{\} : \{ reasoningEffort/g) || []).length >= 2,
      "[12] 契约：产物里至少两处这种条件展开（发往宿主那层 + 点模型那层）",
    );
    ok(text.indexOf("reasoningEffort: null") < 0, "[12] 契约：全文没有 `reasoningEffort: null`");
  }
}

section("13. 宿主半边（lib/index.js）");
{
  const hostPath = fileURLToPath(new URL("../lib/index.js", import.meta.url));
  const mod = await import(pathToFileURL(hostPath).href + `?t=${Date.now()}`);
  let threw = false;
  try {
    mod.apply({});
    mod.apply(undefined);
    mod.apply({ logger: () => { throw new Error("logger boom"); } });
    mod.apply({ logger: { info() { throw new Error("sink boom"); } } });
    mod.apply(null);
  } catch (error) {
    threw = true;
  }
  ok(!threw, "[13] 宿主半边在任何畸形 ctx 下都不抛错（绝不连累插件树）");
  ok(mod.inject === undefined || Array.isArray(mod.inject) === false, "[13] 宿主半边不声明服务（避免 fiber 停在 PENDING）");
}

section("14. 官方数值文字（Max / High）的颜色");
{
  const { react, internals, menu } = await setup();
  const H = internals.ENERGY_END;
  // 只改颜色，一个字的文字都不碰
  eq(menu.effortValueEl.textContent, "High", "[14] 文字内容没被动过");
  eq(menu.effortValueEl.style.color, internals.valueColorFor(H), "[14] high 档：官方数值文字按位置着色");
  ok(!menu.effortLabelEl.style.color, "[14] 官方标签（推理等级）的颜色不动");
  ok(!menu.modelValueEl.style.color, "[14] 另一行（模型）的数值颜色不动 —— 只碰推理等级那一行");

  // 颜色随位置走：蓝 → 紫罗兰
  eq(internals.valueColorFor(0), "rgb(77,147,248)", "[14] 最左端 = 蓝");
  eq(internals.valueColorFor(1), "rgb(139,92,246)", "[14] 最高档 = 紫罗兰（不是看不见的深紫，也不是发虚的亮紫）");
  const rgb = (s) => s.match(/\d+/g).map(Number);
  const low = rgb(internals.valueColorFor(0));
  const mid = rgb(internals.valueColorFor(H));
  const top = rgb(internals.valueColorFor(1));
  ok(mid[0] > low[0] && top[0] > mid[0], "[14] 红色分量单调上升（越往右越紫）");
  ok(top[1] < low[1], "[14] 绿色分量下降（紫比蓝更冷）");
  // 可读性：对白底与对深色底（#1b1c20）都要够，这条以后能挡住"挑了个看不见的颜色"
  const luminance = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const WHITE = [255, 255, 255];
  const DARK_BG = [27, 28, 32];
  ok(contrast(top, WHITE) >= 3, `[14] 最高档对白底对比度 ${contrast(top, WHITE).toFixed(2)}:1 ≥3（浅色主题读得清）`);
  ok(contrast(top, DARK_BG) >= 3, `[14] 最高档对深色底对比度 ${contrast(top, DARK_BG).toFixed(2)}:1 ≥3（深色主题读得清）`);
  ok(contrast(rgb(internals.valueColorFor(0)), WHITE) >= 3, "[14] 最左端的蓝对白底也够（≥3）");
  const sum = (s) => rgb(s).reduce((a, b) => a + b, 0);
  ok(sum(internals.valueColorFor(1)) > sum(internals.fillColorFor(1)), "[14] 数值颜色比填充末尾的深紫更亮（文字不能用深紫）");
  ok(sum(internals.valueColorFor(1)) > sum(internals.valueColorFor(H)), "[14] 最高档比 high 更亮（越往右越通电）");

  // 拖到最高档 → 文字变成紫罗兰
  track(react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
  await settle();
  eq(menu.effortValueEl.style.color, "rgb(139,92,246)", "[14] 拖到 Max：文字直接变紫罗兰");
  eq(menu.effortValueEl.textContent, "High", "[14] 文字内容仍然由官方自己管（没被我们改写）");

  // 关掉菜单 → 还原成原来的内联颜色（通常是空）
  const { menu: menu3, bundle } = await setup();
  eq(menu3.effortValueEl.style.color, internals.valueColorFor(H), "[14] 关之前确实着色了（前置条件）");
  menu3.close();
  bundle.flushObservers(); // 生产里靠 MutationObserver 触发（settle 不会跑它）
  await settle();
  ok(!menu3.effortValueEl.style.color, "[14] 菜单关闭后颜色被还原（不把改动留在官方节点上）");
  eq(menu3.effortValueEl.textContent, "High", "[14] 还原的是颜色，文字始终是官方自己的");

  // 认不出 class 时退到结构判定：最后一个有文字的 span
  const again = await setup();
  const valueEl = again.menu.effortValueEl;
  valueEl.className = "";
  eq(internals.findValueElement(again.menu.effortRow), valueEl, "[14] class 认不出时退到结构判定（最后一个有文字的 span）");
  ok(internals.findValueElement(null) === null, "[14] 传 null 不抛错");
}

section("15. 收起态模型席按钮上的档位（点开之前就看得见）");
{
  const H = 2 / 3;
  // 关键场景：菜单**没打开**（aria-expanded=false）—— 滑条此时不注入，但席上的档位文字照样着色
  const closed = await setup({ menu: { open: false } });
  eq(closed.menu.seatEffortEl.textContent, "High", "[15] 席按钮上的档位文字没被动过");
  eq(closed.menu.seatEffortEl.style.color, closed.internals.valueColorFor(H), "[15] 点开之前就按位置着色了（菜单未展开）");
  ok(!closed.menu.seatLabelEl.style.color, "[15] 席上的模型名（DeepSeek-V41-Flash）颜色不动");
  eq(closed.menu.seatLabelEl.textContent, "DeepSeek-V41-Flash", "[15] 模型名文字没被动过");
  ok(closed.react.find("track") === null, "[15] 菜单没打开时不注入滑条（前置条件，说明上面那条不是靠滑条生效的）");

  // 打开菜单后：拖动改档位 → 菜单里的数值跟着草稿、席上的档位跟已生效
  const { react, internals, menu, bundle, document } = await setup();

  // 拖动中：官方席显示的是**已生效**档位，所以它的颜色不该跟着草稿跑
  track(react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
  await settle();
  eq(menu.effortValueEl.style.color, "rgb(139,92,246)", "[15] 菜单里那一行跟着草稿变成 Max 色");
  eq(menu.seatEffortEl.style.color, internals.valueColorFor(H), "[15] 席按钮仍按已生效档位着色（拖动中不乱跳）");
  track(react).fire("onPointerUp", {});
  await settle();
  eq(menu.seatEffortEl.style.color, "rgb(139,92,246)", "[15] 提交后席按钮跟上 Max 色");
  eq(menu.seatEffortEl.textContent, "High", "[15] 文字仍然由官方自己管（我们只改颜色）");

  // 官方重渲染换了那个节点 → 桥要重新抓到并补色
  const oldEl = menu.seatEffortEl;
  const parent = oldEl.parentNode;
  parent.removeChild(oldEl);
  const newNode = document.createElement("span");
  newNode.className = "wq12jW_triggerEffort";
  newNode.textContent = "High";
  parent.appendChild(newNode);
  bundle.flushObservers();
  await settle();
  eq(newNode.style.color, "rgb(139,92,246)", "[15] 官方换了节点后，新节点也被着色（桥重新抓取）");
  eq(oldEl.style.color ?? "", "", "[15] 旧节点被还原后才放手（不留改动）");

  // 卸载组件 → 还原席按钮的颜色
  react.unmount();
  await settle();
  eq(newNode.style.color ?? "", "", "[15] 组件卸载后席按钮颜色被还原");

  // 认文字：给错的名字就不动（fail-open，绝不误伤别的文字）
  const other = await setup();
  ok(internals.findSeatEffort(other.document, other.menu.composer, "Max") === null, "[15] 名字对不上就返回 null（不猜、不乱改）");
  ok(internals.findSeatEffort(other.document, other.menu.composer, "") === null, "[15] 名字为空也不动");
  ok(internals.findSeatEffort(null, other.menu.composer, "High") === null, "[15] 传 null 不抛错");
  eq(internals.findSeatEffort(other.document, other.menu.composer, "DeepSeek-V41-Flash"), other.menu.seatLabelEl, "[15] 按文字精确命中（模型名也认得出来，但我们只用档位名）");
}

section("16. Off 档保持官方灰 + 刻度点更小更淡");
{
  const { internals } = await setup();
  const OFF = { id: "off", name: "Off" };
  const LOW = { id: "low", name: "Low" };
  // 判定：id 与 name 都认，大小写/空格不敏感，认不出就算普通档位（照常着色）
  ok(internals.isOffLevel(OFF), "[16] id/name 为 off 的档位被认出来");
  ok(internals.isOffLevel({ id: "OFF" }), "[16] 大小写不敏感");
  ok(internals.isOffLevel({ name: "  off " }), "[16] 空格不敏感");
  ok(internals.isOffLevel({ name: "关闭" }), "[16] 中文同义写法也认");
  ok(!internals.isOffLevel(LOW), "[16] Low 不是 off 档");
  ok(!internals.isOffLevel(null) && !internals.isOffLevel(undefined), "[16] 空值不误判");
  // 颜色：off 档给空串 = 不写内联色 = 官方原本的灰
  eq(internals.valueColorFor(0, OFF), "", "[16] off 档 → 空串（不写内联色，保持官方灰）");
  eq(internals.valueColorFor(0, LOW), "rgb(77,147,248)", "[16] 首档不是 off（比如只有 Low/High/Max）时照常给蓝");
  eq(internals.valueColorFor(1, OFF), "", "[16] 即便位置在最右，只要档位是 off 就是灰的");

  // 真场景：当前档位 = off，且席按钮上也写着 Off
  const off = await setup({ host: { effort: "off" }, menu: { effortLabel: "Off" } });
  eq(off.react.find("root").getAttribute("data-energy"), "0", "[16] off 档没有能量层（纯蓝、无星云无粒子）");
  eq(off.react.findAll("particle").length, 0, "[16] off 档没有粒子");
  eq(off.menu.effortValueEl.style.color, "", "[16] 菜单里那一行的数值文字：灰（不写内联色）");
  eq(off.menu.seatEffortEl.style.color, "", "[16] 收起态席按钮上的档位文字：灰（不写内联色）");
  eq(off.menu.effortValueEl.textContent, "Off", "[16] 文字内容仍然是官方的");
  ok(!off.menu.seatLabelEl.style.color, "[16] 模型名依旧不动");
  // 拖到 Max 就恢复着色（确认"灰"只发生在 off 档）
  track(off.react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
  await settle();
  eq(off.menu.effortValueEl.style.color, "rgb(139,92,246)", "[16] 拖到 Max：菜单里那一行先变紫罗兰");
  eq(off.menu.seatEffortEl.style.color, "", "[16] 席按钮按已生效档位（仍是 off）→ 还是灰的");
  track(off.react).fire("onPointerUp", {});
  await settle();
  eq(off.menu.seatEffortEl.style.color, "rgb(139,92,246)", "[16] 提交后席按钮也变成紫罗兰");

  // 刻度点：更小更淡
  const tickCss = internals.CSS.slice(internals.CSS.indexOf(".ces-tick{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-tick{")));
  ok(tickCss.indexOf("width:3px;height:3px") > 0, "[16] 刻度点 5px → 3px（更小）");
  ok(tickCss.indexOf("26%,transparent") > 0, "[16] 未达到的刻度 38% → 26%（更淡）");
  ok(internals.CSS.indexOf(".ces-tick[data-on='1']{background:rgba(255,255,255,.5)}") > 0, "[16] 已达刻度 92% → 50% 白（更淡，不再和星星抢眼）");
  const tickNodes = off.react.findAll("tick");
  ok(tickNodes.length >= 4, `[16] 4 档就有 4 个刻度点（实测 ${tickNodes.length}）`);
}

section("17. 拖动手感：旋钮不跟手，越过 1/3 档距才切档，跨多档一段滑到位");
{
  const { internals } = await setup();
  const R = internals.TRACK_RADIUS;
  // 夹具轨道 300px 宽、left=0；4 档模型下 1 档距 = (300-2R)/3 px。
  // "档位单位" u：0 = 最低档，1 = 第二档 …… 换算回 clientX 就是下面这个式子。
  const xOf = (u) => R + (u / 3) * (300 - 2 * R);
  const leftFor = (pct) => internals.knobOffsetOf(pct);

  // 17a 按下 = 点哪去哪：落到**最近**那一档（不是 1/3 判定）
  const a = await setup();
  track(a.react).fire("onPointerDown", { clientX: xOf(1.4), pointerId: 1 });
  await settle();
  eq(a.react.find("knob").style.left, leftFor(1 / 3), "[17] 按下取最近档：u=1.4 → 第 2 档（不是第 3 档）");

  // 17b 死区：按下点已经越过该档的 1/3 线（1.4 > 1+1/3），不能立刻再跳一档
  track(a.react).fire("onPointerMove", { clientX: xOf(1.4), pointerId: 1 });
  await settle();
  eq(a.react.find("knob").style.left, leftFor(1 / 3), "[17] 指针原地不动 → 仍停第 2 档（死区挡住多跳）");
  track(a.react).fire("onPointerMove", { clientX: xOf(1.6), pointerId: 1 });
  await settle();
  eq(a.react.find("knob").style.left, leftFor(1 / 3), "[17] 只离开按下点 0.2 档距 → 仍不切档");
  track(a.react).fire("onPointerMove", { clientX: xOf(1.8), pointerId: 1 });
  await settle();
  eq(a.react.find("knob").style.left, leftFor(2 / 3), "[17] 离开按下点超过 1/3 档距 → 切到第 3 档");
  track(a.react).fire("onPointerUp", {});
  await settle();

  // 17c 判定线是**同一条**（在每档 +1/3 档距处）：前进走 1/3 就切上去，后退要退回该线以下
  const b = await setup();
  track(b.react).fire("onPointerDown", { clientX: xOf(0), pointerId: 1 });
  await settle();
  track(b.react).fire("onPointerMove", { clientX: xOf(0.5), pointerId: 1 });
  await settle();
  eq(b.react.find("knob").style.left, leftFor(1 / 3), "[17] 前进越过 1/3 档距 → 切到第 2 档");
  track(b.react).fire("onPointerMove", { clientX: xOf(0.8), pointerId: 1 });
  await settle();
  eq(b.react.find("knob").style.left, leftFor(1 / 3), "[17] 还没到下一道 1/3 线 → 停在第 2 档");
  track(b.react).fire("onPointerMove", { clientX: xOf(0.6), pointerId: 1 });
  await settle();
  eq(b.react.find("knob").style.left, leftFor(1 / 3), "[17] 后退到 0.6 档距：仍在 1/3 线之上 → 不切回（同一条线，非对称）");
  track(b.react).fire("onPointerMove", { clientX: xOf(0.3), pointerId: 1 });
  await settle();
  eq(b.react.find("knob").style.left, leftFor(0), "[17] 退到 1/3 线以下 → 切回第 1 档");
  track(b.react).fire("onPointerUp", {});
  await settle();

  // 17d 跨多档：同一次事件直接给出最终档位 = 一段滑到位（不逐档连滑）
  const c = await setup();
  track(c.react).fire("onPointerDown", { clientX: xOf(0), pointerId: 1 });
  await settle();
  track(c.react).fire("onPointerMove", { clientX: xOf(2.5), pointerId: 1 });
  await settle();
  eq(c.react.find("knob").style.left, leftFor(1), "[17] 一次跨 3 档 → 直接落在最高档（中间不停）");
  eq(c.react.findAll("tick").filter((n) => n.getAttribute("data-current") === "1").length, 1, "[17] 中间态只有一个「当前」刻度");
  track(c.react).fire("onPointerUp", {});
  await settle();

  // 17f 起拖零额外延迟：落点与判定线一致时，刚越过 1/3 线就换档（不必先空拖 1/3 档距）
  const d = await setup();
  track(d.react).fire("onPointerDown", { clientX: xOf(0.2), pointerId: 1 });
  await settle();
  eq(d.react.find("knob").style.left, leftFor(0), "[17] 按下 u=0.2 → 最近档是最低档（与判定线一致，无冲突）");
  track(d.react).fire("onPointerMove", { clientX: xOf(0.35), pointerId: 1 });
  await settle();
  eq(d.react.find("knob").style.left, leftFor(1 / 3), "[17] 只走 0.15 档距、刚过 1/3 线 → 立刻换档（起拖无死区）");
  track(d.react).fire("onPointerUp", {});
  await settle();

  // 17e 四层共用同一个过渡变量（一起滑，不会撕开）；「减少动态效果」时全部关掉
  const css = internals.CSS;
  const ruleOf = (name) => css.slice(css.indexOf(`.${name}{`), css.indexOf("}", css.indexOf(`.${name}{`)));
  ok(ruleOf("ces-knob").indexOf("transition:left var(--ces-slide)") > 0, "[17] 球的 left 走 --ces-slide 变量");
  ok(ruleOf("ces-fill").indexOf("transition:width var(--ces-slide)") > 0, "[17] 填充的 width 走同一个变量");
  ok(ruleOf("ces-energy").indexOf("width var(--ces-slide)") > 0, "[17] 能量层的 width 走同一个变量");
  ok(ruleOf("ces-stars").indexOf("width var(--ces-slide)") > 0, "[17] 星空层的 width 走同一个变量");
  ok(css.indexOf(`--ces-slide:${internals.SLIDE_EASE}`) > 0, "[17] 默认（快档）时长挂在容器变量上");
  ok(
    css.indexOf(`.ces-inline[data-slide='slow']{--ces-slide:${internals.SLIDE_EASE_SLOW}}`) > 0,
    "[17] 慢档只换变量值（这样「减少动态效果」的 transition:none 仍然压得住）",
  );
  ok(internals.SLOW_DRAG_EXIT_MS < internals.SLOW_DRAG_ENTER_MS, "[17] 快慢切换带迟滞：退出阈值 < 进入阈值");
  const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const name of ["ces-knob", "ces-fill", "ces-energy", "ces-stars"]) {
    ok(reduce.indexOf(`.${name}{transition:none}`) > 0, `[17] 「减少动态效果」时 .${name} 不做滑动动画`);
  }
  eq(internals.DETENT_THIRD, 1 / 3, "[17] 切档阈值就是 1/3 档距（用户指定）");
}

section("18. 快慢两档动画：拖得慢 → 动画也慢");
{
  const { internals } = await setup();
  const R = internals.TRACK_RADIUS;
  const xOf = (u) => R + (u / 3) * (300 - 2 * R);

  const a = await setup();
  const slideOf = () => a.react.find("root").getAttribute("data-slide");

  track(a.react, 0, 300).fire("onPointerDown", { clientX: xOf(0), pointerId: 1 });
  await settle();
  eq(slideOf(), "fast", "[18] 按下（点哪去哪）走快档");

  // 手快：两次换档挨得很近 → 保持快档
  track(a.react, 0, 300).fire("onPointerMove", { clientX: xOf(0.5), pointerId: 1 });
  await settle();
  eq(slideOf(), "fast", "[18] 挨着就换下一档（手快）→ 仍是快档");

  // 手慢：隔得比进入阈值更久才换下一档 → 换慢档
  await wait(internals.SLOW_DRAG_ENTER_MS + 140);
  track(a.react, 0, 300).fire("onPointerMove", { clientX: xOf(1.5), pointerId: 1 });
  await settle();
  eq(slideOf(), "slow", "[18] 隔得比进入阈值久 → 换成慢档（拖得慢，动画也慢）");

  // 迟滞：间隔落在两个阈值之间 → 保持慢档，不来回跳
  await wait(internals.SLOW_DRAG_EXIT_MS + 40);
  track(a.react, 0, 300).fire("onPointerMove", { clientX: xOf(2.5), pointerId: 1 });
  await settle();
  eq(slideOf(), "slow", "[18] 间隔卡在两阈值之间 → 保持慢档（迟滞，不来回切）");

  // 手又快了：间隔小于退出阈值 → 回快档
  await wait(20);
  track(a.react, 0, 300).fire("onPointerMove", { clientX: xOf(1.5), pointerId: 1 });
  await settle();
  eq(slideOf(), "fast", "[18] 间隔小于退出阈值 → 回到快档");

  track(a.react, 0, 300).fire("onPointerUp", {});
  await settle();

  // 没换档就不该动这个开关
  const before = slideOf();
  await wait(internals.SLOW_DRAG_ENTER_MS + 140);
  track(a.react, 0, 300).fire("onPointerMove", { clientX: xOf(1.55), pointerId: 1 });
  await settle();
  eq(slideOf(), before, "[18] 指针在动但没换档 → 快慢开关不动");
}

/* ══════════════════════════════════════════════════════════════════════ */

section("19. 档位字典与目录索引（LV / tiers / resolveModel / 目录优先）");
{
  const { internals } = await setup();
  const { LV, tiers, normalizeTierId, resolveModel, buildCatalogIndex, tiersForModel } = internals;

  // 字典：9 个键，与参考实现同一形状
  for (const key of ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
    ok(LV[key] && LV[key].id === key, `[19] 字典有 ${key} 键（id 与键一致）`);
  }
  eq(LV.off.name, "关闭", "[19] off 的默认显示名是「关闭」（参考实现里补上的那一个键）");

  // 归一化：大小写 / 空格 / 下划线 / 连字符都不影响，未知返回 null
  eq(normalizeTierId("X-High").id, "xhigh", "[19] X-High → xhigh");
  eq(normalizeTierId("x_high").id, "xhigh", "[19] x_high → xhigh");
  eq(normalizeTierId(" reasoning_effort=none ").id, "none", "[19] 带前缀/空白的写法也认");
  eq(normalizeTierId("turbo"), null, "[19] 认不出的档位名返回 null");

  // tiers：全部认得出才给结果；一条脏数据 → null（不抛错，见"不能瘫痪整个 UI"）
  const good = tiers([{ id: "none" }, { id: "medium" }, { id: "ultra" }]);
  eq(good.count, 3, "[19] tiers 数出 3 档");
  eq(good.names.join("/"), "None/Medium/Ultra", "[19] 目录没给名字时用字典里的默认名");
  eq(tiers([{ id: "none" }, { id: "turbo" }]), null, "[19] 有一条认不出 → 整份按不支持处理（不抛错）");
  eq(tiers([]), null, "[19] 空列表 → null");
  eq(tiers(null), null, "[19] 不是数组 → null");

  // 三级检测：精确 → 快照继承（前缀）→ 未知 null
  eq(resolveModel("gpt-6-sol").count, 8, "[19] 精确命中：gpt-6-sol = 8 档");
  eq(resolveModel("gpt-6-luna").count, 7, "[19] 精确命中：gpt-6-luna = 7 档");
  eq(resolveModel("gpt-6-spark").count, 5, "[19] 精确命中：gpt-6-spark = 5 档");
  eq(resolveModel("gpt-4o").levels, null, "[19] gpt-4o 显式不支持（levels:null，不是「未知」）");
  eq(resolveModel("gpt-6-astra-2026-01-13").id, "gpt-6-astra", "[19] 快照 id 经别名落到家族条目");
  eq(resolveModel("gpt-6-luna-2026-03-01").id, "gpt-6-luna", "[19] 未登记的变体走最长前缀检测");
  eq(resolveModel("gpt-6-luna@2026-03-01").id, "gpt-6-luna", "[19] `@` 分隔的快照 id 同样继承");
  eq(resolveModel("gpt-6-lu"), null, "[19] 前缀不完整 → null（不瞎猜）");
  eq(resolveModel("deepseek-v4-flash"), null, "[19] 非 GPT 家族 → null（交给目录）");
  eq(resolveModel(""), null, "[19] 空 id → null");

  // 目录优先：官方下发的 efforts 就是答案，本地字典只补名字
  const snapshot = snapshotOf({
    groups: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [
          { id: "deepseek-v41-flash", name: "DeepSeek-V41-Flash", reasoning: { defaultEffort: "high", efforts: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }] } },
          { id: "plain-model", name: "Plain" },
          { id: "broken-model", name: "Broken", reasoning: { efforts: [{ id: "off" }, { id: "turbo" }] } },
        ],
      },
      { id: "openai", name: "OpenAI", models: [{ id: "gpt-6-astra", name: "gpt-6-astra", reasoning: { defaultEffort: "medium", efforts: [{ id: "none" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }, { id: "ultra" }] } }] },
    ],
  });
  const index = buildCatalogIndex(snapshot);
  eq(index.models.length, 4, "[19] 索引把两个 provider 的模型都收进来");
  eq(index.byProvider.openai["gpt-6-astra"].tiers.count, 8, "[19] OpenAI 的 8 档来自目录（不是本地清单）");
  eq(index.byProvider.deepseek["plain-model"].tiers, null, "[19] 目录里没有 reasoning → 不支持");
  eq(index.byProvider.deepseek["broken-model"].tiers, null, "[19] 目录里有一条脏档位 → 该模型按不支持（其余模型不受影响）");
  eq(index.byProvider.deepseek["deepseek-v41-flash"].tiers.names.join("/"), "关闭/Low/High/Max", "[19] 目录只给 id 的行用字典补名（off → 关闭）");
  eq(index.byProvider.deepseek["plain-model"].provider, "deepseek", "[19] 索引带 provider（归属标签要用）");

  // 目录查不到的模型（可见模型集变了）才退到静态清单
  eq(tiersForModel(index, "gpt-6-luna").tiers.count, 7, "[19] 目录没有 → 退到静态清单（徽标仍能给出 7 档）");
  eq(tiersForModel(index, "gpt-4o").tiers, null, "[19] 静态清单里的 gpt-4o 仍然是「不支持」");
  eq(tiersForModel(index, "some-unknown-model"), null, "[19] 两边都不知道 → null（不写徽标）");
  eq(tierCountLabelText(internals, index, "gpt-6-luna"), "7 档", "[19] 徽标文案：7 档");
  eq(tierCountLabelText(internals, index, "gpt-4o"), "不支持", "[19] 徽标文案：不支持");
}

section("20. 官方模型列表每一行的档位徽标（8 / 7 / 5 档 / 不支持）");
{
  const snapshot = snapshotOf({
    groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-v41-flash", name: "DeepSeek-V41-Flash", reasoning: { defaultEffort: "high", efforts: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }] } }] }],
  });
  const { react, menu, bundle } = await setup({
    menu: { modelRows: ["DeepSeek-V41-Flash", "gpt-6-luna", "gpt-6-spark", "gpt-4o", "plain-model"] },
    host: { snapshot },
  });

  const badges = () => menu.modelList.querySelectorAll(".ces-menu-badge");
  const textOf = () => badges().map((node) => String(node.textContent));

  eq(menu.modelRows.length, 5, "[20] 假官方列表里有 5 行模型");
  eq(badges().length, 4, "[20] 4 行拿到徽标（未知模型两边都不认识 → 不瞎标）");
  eq(textOf().join(","), "4 档,7 档,5 档,不支持", "[20] 目录给的档位数 + 静态清单兜底");
  eq(menu.modelRows[4].row.querySelectorAll(".ces-menu-badge").length, 0, "[20] 谁都不认识的模型不写徽标（不瞎标）");
  eq(badges()[0].getAttribute("data-off"), "0", "[20] 有档位的徽标不是「不支持」态");
  eq(badges()[3].getAttribute("data-off"), "1", "[20] gpt-4o 的徽标是「不支持」态（走灰化样式）");
  ok(String(badges()[1].getAttribute("title")).indexOf("7 档") === 0, "[20] 悬浮说明给出档位数");
  ok(String(badges()[3].getAttribute("title")).indexOf("不支持") >= 0, "[20] 「不支持」的悬浮说明是明示的");
  ok(String(badges()[0].parentNode.getAttribute("class")).indexOf("optionCopy") >= 0, "[20] 徽标挂在官方的 .optionCopy 里（名字旁边）");
  eq(menu.modelRows[0].row.querySelectorAll("span").length, 4, "[20] 官方原有的 .modelName / .check 一个没少（多出来的只有徽标）");
  eq(String(menu.modelRows[1].row.querySelector(".wq12jW_modelName").textContent), "gpt-6-luna", "[20] 官方行文字没被动过");

  // 重扫不叠加（MutationObserver 每次 mutation 都会调 scan）
  bundle.flushObservers();
  await settle();
  eq(badges().length, 4, "[20] 再扫一遍不会重复挂徽标");
  eq(textOf().join(","), "4 档,7 档,5 档,不支持", "[20] 文案也稳定");

  // 官方重渲染换了整批节点 → 桥必须重新算一遍（徽标跟着新节点走）
  menu.modelRows[1].row.remove();
  bundle.flushObservers();
  await settle();
  eq(badges().length, 3, "[20] 行被官方卸载后，徽标总数跟着少一个");
  eq(react.find("host") !== null, true, "[20] 注入的滑条不受影响");
}

section("21. 根面板的 provider 归属标签（一级页就能看出切换生效）");
{
  const deepseek = { id: "deepseek-v41-flash", name: "DeepSeek-V41-Flash", reasoning: { defaultEffort: "high", efforts: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }] } };
  const gpt = { id: "gpt-6-astra", name: "gpt-6-astra", reasoning: { defaultEffort: "medium", efforts: [{ id: "none" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }, { id: "ultra" }] } };
  const { menu, bundle } = await setup({
    menu: { modelRows: ["DeepSeek-V41-Flash", "gpt-6-astra"] },
    host: { snapshot: snapshotOf({ groups: [{ id: "deepseek", name: "DeepSeek", models: [deepseek] }, { id: "openai", name: "OpenAI", models: [gpt] }] }) },
  });

  const tags = menu.modelRow.querySelectorAll(".ces-menu-provider");
  eq(tags.length, 1, "[21] 根面板「模型」那一行挂上一个归属标签");
  eq(String(tags[0].textContent), "deepseek", "[21] 标签写的是当前会话的 provider");
  eq(tags[0].getAttribute("data-ces-part"), "provider-tag", "[21] 带可断言的部件标记");
  const kids = menu.modelRow.children.map((node) => node.getAttribute("class") ?? node.tagName);
  eq(kids[0], "cellLabel", "[21] 官方 cellLabel 仍在最前");
  eq(kids[1], "cellValue", "[21] 官方 cellValue 仍在原位");
  eq(kids[2], "cellChevron", "[21] 官方 chevron 仍排在第三（官方三个节点的顺序一个没动）");
  eq(kids[3], "ces-menu-provider", "[21] 归属标签追加在最后（箭头右侧一小段灰字）");
  eq(String(menu.modelValueEl.textContent), "DeepSeek-V41-Flash", "[21] 官方 cellValue 的文字一个字没动");

  bundle.flushObservers();
  await settle();
  eq(menu.modelRow.querySelectorAll(".ces-menu-provider").length, 1, "[21] 重扫不会叠加第二个标签");
}

section("22. 档位列表每行显示原始 API 取值（发送请求用的就是它）");
{
  const { menu, internals } = await setup({
    menu: { effortRows: ["关闭", "Low", "High", "Max"] },
  });
  const apis = menu.effortList.querySelectorAll(".ces-menu-api");
  eq(apis.length, 4, "[22] 4 个档位行各挂一个 API 取值");
  eq(apis.map((node) => String(node.textContent)).join(","), "off,low,high,max", "[22] 取值就是目录里的原始 id");
  eq(apis[0].getAttribute("data-ces-part"), "api-value", "[22] 带可断言的部件标记");
  eq(String(apis[2].getAttribute("title")), "API: high", "[22] 悬浮说明是 `API: <id>` 的形状");
  eq(String(menu.effortRows[2].row.querySelector(".wq12jW_modelName").textContent), "High", "[22] 官方那行显示的还是档位的显示名（没被换成 id）");
  ok(
    internals.CSS.indexOf(".ces-menu-api{flex:none;") > 0,
    "[22] 样式表里有 .ces-menu-api 规则（且是 flex:none，不加宽那一行）",
  );
  const rule = internals.CSS.slice(internals.CSS.indexOf(".ces-menu-api{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-menu-api{")));
  ok(rule.indexOf("dsw-alias-label-caption") > 0, "[22] 取值用 DSH 的「caption」令牌（比正文淡一档的灰）");
  ok(rule.indexOf("font-size:11px") > 0, "[22] 字号 11px（与参考实现的 .pop-row .api 一致）");
}

section("23. 翻页（carousel）无缝隙与进入动画：滚动稳定化 + focus 不滚");
{
  const { internals, menu, bundle } = await setup({
    menu: { scrollTop: 120, modelRows: ["DeepSeek-V41-Flash", "gpt-6-luna"] },
  });

  // 只压掉布局/滚动的二次位移，不碰官方动画本身
  ok(internals.CSS.indexOf(".ces-menu-stable{overflow-anchor:none}") > 0, "[23] 声明了 overflow-anchor 抑制规则");
  ok(
    internals.CSS.indexOf(".ces-menu-stable .scrollable{overflow-anchor:none}") > 0,
    "[23] 官方那个滚动容器（.scrollable）也在抑制范围内",
  );
  ok(internals.CSS.indexOf("box-shadow") > 0 && internals.CSS.indexOf("border-right") < 0, "[23] 没有给官方面板加任何边缘描边/阴影（接缝的另一半）");

  const scrollable = menu.modelList;
  eq(scrollable.classList.contains("ces-menu-stable"), true, "[23] 官方滚动容器挂上了稳定化类");
  eq(menu.menu.classList.contains("ces-menu-stable"), true, "[23] 菜单根也挂上了（父级 overflow-anchor 同样影响锚定）");
  eq(scrollable.getAttribute("class").indexOf("wq12jW_groups") >= 0, true, "[23] 官方自己的 class 一个没删");
  eq(scrollable.scrollTop, 0, "[23] 换内容时把滚动位置清回 0（位移不再被画出来）");

  // 每一次 mutation 都会重新稳定一次（翻页 = 同一个菜单换内容，不能只在首次注入时做）
  scrollable.scrollTop = 88;
  bundle.flushObservers();
  await settle();
  eq(scrollable.scrollTop, 0, "[23] 后续每一次扫描都会重新清一次滚动位置");
  eq(menu.menu.querySelectorAll('[data-ces-part="host"]').length, 1, "[23] 注入的滑条仍然只有一个");

  // 官方 `.focus()` 不带 preventScroll 是位移的根因之一；插件自己的 focus 一律走这个包装
  ok(CODE.indexOf("focusNoScroll") > 0, "[23] 产物里有 focusNoScroll 这个统一入口");
  ok(CODE.indexOf("focus({ preventScroll: true })") > 0, "[23] 菜单内的 focus 一律 preventScroll（否则动画被 scroll-into-view 吃掉）");
  const calls = [];
  internals.focusNoScroll(null);
  internals.focusNoScroll(undefined);
  eq(calls.length, 0, "[23] 给 null / undefined 时不 focus（参考实现的 if(el) 保护）");
  internals.focusNoScroll({ focus(options) { calls.push(options); } });
  eq(calls.length, 1, "[23] 给元素时 focus 一次");
  eq(calls[0].preventScroll, true, "[23] 且带 preventScroll:true");

  // 慢档缓动对齐参考实现的那根曲线（快慢两档机制本身没动）
  ok(internals.SLIDE_EASE_SLOW.indexOf("cubic-bezier(.45,.05,.35,1)") > 0, "[23] 慢档缓动 = .34s cubic-bezier(.45,.05,.35,1)");
  ok(internals.SLIDE_EASE.indexOf("cubic-bezier(.2,.9,.3,1)") > 0, "[23] 快档缓动保持不变");
}

section("24. 禁用态是渲染函数的完整投影（不是粘滞的标志位）");
{
  const { internals } = await setup();
  const { buildCatalogIndex, describeModelTier, decorateMenu, buildModelBadge } = internals;

  // 「禁用」在真宿主里的第一表现是：模型没有 reasoning → 官方不渲染那一行 → 滑条无处可挂（第 3 节 3d）
  const noReasoning = buildCatalogIndex(snapshotOf({
    groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "plain-model", name: "Plain" }] }],
  }));
  eq(describeModelTier(noReasoning, "plain-model", "Plain").tiers, null, "[24] 没有 reasoning 的模型 → tiers 为 null");
  const doc = createDocument();
  const badge = buildModelBadge(doc, describeModelTier(noReasoning, "plain-model", "Plain"));
  eq(badge.getAttribute("data-off"), "1", "[24] 徽标进入「不支持」态");
  eq(String(badge.textContent), "不支持", "[24] 文案是「不支持」（不是「0 档」这种含糊说法）");

  // 脏数据 → 同样是「不支持」，但**同一份索引里的其它模型不受影响**（一条脏数据最多禁一个）
  const dirty = buildCatalogIndex(snapshotOf({
    groups: [{ id: "deepseek", name: "DeepSeek", models: [
      { id: "broken", name: "Broken", reasoning: { efforts: [{ id: "off" }, { id: "turbo" }] } },
      { id: "fine", name: "Fine", reasoning: { efforts: [{ id: "off" }, { id: "low" }] } },
    ] }],
  }));
  eq(describeModelTier(dirty, "broken", "Broken").tiers, null, "[24] 脏档位 → 该模型禁用");
  eq(describeModelTier(dirty, "fine", "Fine").tiers.count, 2, "[24] 同一份索引里的正常模型照常可用（降级是局部的）");
  eq(dirty.models.length, 2, "[24] 脏数据不会中断整份索引的构建");
  eq(buildCatalogIndex(null).models.length, 0, "[24] 快照为 null 也不抛错（起步期）");
  eq(buildCatalogIndex({ groups: [{ id: "x", models: [null, undefined, 42, { id: "" }] }] }).models.length, 0, "[24] 一堆垃圾条目 → 安静地什么都不产出");

  // 渲染投影：滑条根上的 data-disabled 每帧重算（有档位 → "0"，禁用分支 → "1"）
  const a = await setup();
  eq(a.react.find("root").getAttribute("data-disabled"), "0", "[24] 有档位时投影为 「可用」");
  eq(a.react.find("track").getAttribute("aria-disabled"), null, "[24] 可用时不写 aria-disabled（不是字符串 \"true\"）");
  ok(internals.CSS.indexOf(".ces-inline[data-disabled='1']{opacity:.45;pointer-events:none}") > 0, "[24] 禁用态样式：灰掉 + 不吃指针（与参考实现一致）");

  // 「每帧重算」的证据：官方在"模型没有推理能力"时**整行都不渲染**，所以这里没有注入目标
  const b = await setup({ menu: { reasoning: false } });
  eq(b.menu.effortRow, null, "[24] 官方不会渲染「推理等级」那一行（模型没有 reasoning 时的真实形状）");
  eq(b.menu.modelRow.querySelectorAll('[data-ces-part="host"]').length, 0, "[24] 没有那一行 → 不注入（也不加高任何行）");
  eq(b.react.portalHosts.length, 0, "[24] 也不 portal");
  const c = await setup({ host: { model: { id: "plain-model", name: "Plain" } } });
  eq(c.menu.effortRow.style.paddingTop ?? "", "", "[24] 当前模型没有档位时，官方那一行原样不动");
  eq(c.react.portalHosts.length, 0, "[24] 当前模型没有档位时也不 portal");
}

section("25. 8 档模型的能量阶梯（Ultra 满星云、Max 已是中后段）");
{
  const { internals, react, menu } = await setup();
  const { energyFor, pctFromIndex, fillColorFor } = internals;

  /*
   * 参考实现里 8 档只有末档点亮，靠的是它给 OpenAI 路径用的回退公式 `(n-2)/(n-1)`
   * （8 档 → start=6/7 → `en = clamp(idx-6, 0, 1)`：Max 是 0、只有 Ultra 是 1）；
   * 而它给 DeepSeek 那 4 档写的是 `energyStart: 1/3`。本插件只有**一套**位置公式
   * （`(pct - 1/3) / (2/3)`），所以 8 档是一条连续阶梯：Max(6/7) 已经是中后段的 0.786，
   * Ultra 满。这正是"位置连续驱动"想要的行为 —— 而且 "Max 半能量" 这个观感在 4 档模型上
   * 依然精确成立（high = 位置 2/3 → 0.5），所以两边的口径都被保住了。
   */
  near(energyFor(pctFromIndex(6, 8)), 11 / 14, "[25] 8 档的 Max（位置 6/7）→ 能量 11/14 ≈ 0.786（中后段）");
  eq(energyFor(pctFromIndex(7, 8)), 1, "[25] 8 档的 Ultra（最右）→ 能量 1（满星云）");
  eq(energyFor(pctFromIndex(0, 8)), 0, "[25] 第一档（位置 0）→ 能量 0（纯蓝，不通电）");
  eq(energyFor(pctFromIndex(2, 8)), 0, "[25] 第二档以前仍然是 0（左半段保持干净的蓝）");
  ok(energyFor(pctFromIndex(3, 8)) > 0, "[25] 从第三档起开始渐入（不再是「只有末档才亮」的阶梯）");
  near(energyFor(2 / 3), 0.5, "[25] 「半能量」这个观感落在位置 2/3（4 档模型的 high，用户指名要保留的锚点）");
  let monotonic = true;
  for (let i = 1; i < 8; i += 1) {
    if (energyFor(pctFromIndex(i, 8)) < energyFor(pctFromIndex(i - 1, 8))) monotonic = false;
  }
  ok(monotonic, "[25] 8 档全程单调不减（拖动时不会忽明忽暗）");
  eq(fillColorFor(pctFromIndex(7, 8)), "rgb(76,29,149)", "[25] 最右端填充是深紫 #4c1d95");

  // 端到端：8 档菜单真的渲染出 8 个刻度，并逐档给出位置与能量
  const eight = [
    { id: "none", name: "None" },
    { id: "minimal", name: "Minimal" },
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
    { id: "xhigh", name: "X-High" },
    { id: "max", name: "Max" },
    { id: "ultra", name: "Ultra" },
  ];
  const model = { id: "gpt-6-astra", name: "gpt-6-astra", reasoning: { defaultEffort: "ultra", efforts: eight } };
  const d = await setup({
    menu: { effortRows: eight.map((level) => level.name), effortLabel: "Ultra" },
    host: { snapshot: snapshotOf({ groups: [{ id: "openai", name: "OpenAI", models: [model] }] }) },
  });
  eq(d.react.findAll("tick").length, 8, "[25] 8 档模型渲染 8 个刻度点");
  const energyOf = () => parseFloat(d.react.find("root").style["--ces-energy"]);
  near(energyOf(), 1, "[25] 默认档 ultra → 满能量");
  near(energyOf(), 1, "[25] 能量直接写在容器变量上（CSS 用它做渐入）");
  const track_ = track(d.react, 0, 700);
  const xAt = (index) => internals.TRACK_RADIUS + (index / 7) * (700 - 2 * internals.TRACK_RADIUS);
  track_.fire("onPointerDown", { clientX: xAt(6), pointerId: 1 });
  await settle();
  near(energyOf(), 11 / 14, "[25] 拖到第 7 档（Max）→ 端到端同样是中后段能量（与纯函数一致）");
  track_.fire("onPointerMove", { clientX: xAt(7), pointerId: 1 });
  await settle();
  near(energyOf(), 1, "[25] 再拖到 Ultra → 重新满能量（不会粘在半能量）");
  track_.fire("onPointerUp", {});
  await settle();
  eq(String(d.react.find("track").getAttribute("aria-valuetext")), "Ultra", "[25] 无障碍值也跟着走");
  eq(menu.effortList.querySelectorAll(".ces-menu-api").length, 4, "[25] 另一个场景的档位行注解互不影响（4 档）");
}

/* ══════════════════════════════════════════════════════════════════════ */

section("26. 预览页（preview/panel.html）的自洽性");
{
  /*
   * 预览页是 `node preview/make-preview.mjs` 生成物，仓库里也提交了它。
   * 生成器只能保证"抽函数不失败"，保证不了"抽出来的脚本引用到的元素都在、初始化不抛错" ——
   * 这两件事加在一起就是一次真实的教训：脚本会 `getElementById` 一个还没定义的 `var`，
   * 页面在浏览器里直接白屏，而生成器是绿的。所以在这里补一层：
   *   1. 内联脚本引用的每个 id 都必须真的存在于 HTML 里；
   *   2. 用最小 DOM 假件把脚本**跑一遍**（含 `?level=ultra` 那条查询参数路径）。
   * 没有提交 panel.html 时（例如从 npm 只拿了 lib/）自动跳过。
   */
  const previewPath = fileURLToPath(new URL("../preview/panel.html", import.meta.url));
  if (!existsSync(previewPath)) {
    console.log("  （preview/panel.html 不存在，跳过）");
  } else {
    const html = readFileSync(previewPath, "utf8");
    const script = /<script>([\s\S]*?)<\/script>/.exec(html);
    ok(script !== null, "[26] 预览页里有内联脚本");
    const code = script === null ? "" : script[1];
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const used = [...new Set([...code.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]))];
    const missing = used.filter((id) => !ids.has(id));
    eq(missing.join(","), "", `[26] 脚本引用的 ${used.length} 个 id 都存在（缺失：${missing.join(",") || "无"}）`);

    const makeEl = (tag = "div") => ({
      tagName: String(tag).toUpperCase(),
      style: { setProperty(k, v) { this[k] = v; } },
      dataset: {},
      children: [],
      className: "",
      textContent: "",
      attrs: {},
      listeners: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; },
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      appendChild(child) { this.children.push(child); return child; },
      setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 20 }; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    });
    const cache = new Map([...ids].map((id) => [id, makeEl()]));
    const previewDocument = {
      body: makeEl("body"),
      getElementById: (id) => cache.get(id) ?? null,
      createElement: makeEl,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const previewWindow = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
    let initError = null;
    try {
      // `?level=ultra` 走的是"按 id 找档位"那条路径；8 档时它落在最后一档。
      const run = new Function("document", "window", "location", "console", code);
      run(previewDocument, previewWindow, { search: "?level=ultra" }, { log() {}, warn() {}, error() {} });
    } catch (error) {
      initError = error;
    }
    eq(initError === null ? "ok" : String(initError), "ok", "[26] 脚本初始化不抛错（含 ?level=ultra 路径）");
    eq(String(cache.get("effortApi")?.textContent ?? ""), "ultra", "[26] 档位 API 取值按查询参数渲染（发送请求用的就是它）");
    eq(String(cache.get("effortValue")?.textContent ?? ""), "Ultra", "[26] 官方那一行的数值文字同步");
    ok(html.indexOf("ces-menu-badge") > 0, "[26] 预览页里画了模型行徽标");
    ok(html.indexOf("ces-menu-provider") > 0, "[26] 预览页里画了 provider 归属标签");
    ok(html.indexOf("ces-menu-stable") > 0, "[26] 预览页里带上了翻页稳定化的 class（与真 DOM 同一套）");
    ok(html.indexOf("levels8") > 0, "[26] 预览页有 8 档按钮（Ultra 满星云那条路径）");
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

section("27. 自建浮层：收起态按钮、一级 provider 页、二级模型列表（含档位徽标）");
{
  const scene = await setupPicker();
  const { react, internals, host } = scene;
  const picker = internals.picker;

  // 收起态：一颗按钮，显示当前模型名 + 档位名
  const trigger = scene.trigger();
  ok(trigger !== null, "[27] 收起态渲染出一颗按钮");
  eq(trigger.getAttribute("aria-haspopup"), "menu", "[27] 按钮声明了 aria-haspopup（与参考实现一致）");
  eq(trigger.getAttribute("aria-expanded"), "false", "[27] 收起时 aria-expanded=false");
  eq(react.find("picker-panel-root"), null, "[27] 收起时面板不渲染（surface 不挂任何节点）");
  eq(react.find("picker-panel"), null, "[27] 面板节点确实不在树里");
  ok(String(trigger.textContent).indexOf("DeepSeek-V41-Flash") >= 0, "[27] 按钮上写着当前模型名");
  ok(String(trigger.textContent).indexOf("High") >= 0, "[27] 按钮上写着当前档位名");
  // 点开：一级页列出 provider
  await scene.toggle();
  ok(react.find("picker-panel-root") !== null, "[27] 点开后面板根出现（surface 挂到 body）");
  ok(react.find("picker-panel") !== null, "[27] 面板已渲染");
  eq(scene.trigger().getAttribute("aria-expanded"), "true", "[27] aria-expanded 跟着变 true");
  const providers = react.findAll("picker-provider");
  eq(providers.length, 2, "[27] 一级页列出 2 个 provider");
  ok(String(providers[0].textContent).indexOf("DeepSeek") >= 0, "[27] 第一个是 DeepSeek");
  eq(providers[0].getAttribute("data-pid"), "deepseek", "[27] provider 行带 provider id");
  ok(String(providers[1].textContent).indexOf("OpenAI") >= 0, "[27] 第二个是 OpenAI");
  ok(String(providers[0].textContent).indexOf("DeepSeek-V41-Flash") >= 0, "[27] 当前 provider 行右侧显示当前模型名（一级页就能确认）");
  eq(String(providers[1].textContent).indexOf("gpt-6-astra"), -1, "[27] 别的 provider 不显示当前模型名");
  eq(react.findAll("picker-model").length, 0, "[27] 一级页不展开模型列表");
  eq(react.findAll("picker-pop").length, 0, "[27] 档位弹层默认关着");

  // 二级页：点 provider 进去，模型行带档位徽标
  providers[0].fire("onClick", {});
  await settle();
  eq(react.find("picker-viewport").getAttribute("data-view"), "2", "[27] 翻到二级页");
  const models = react.findAll("picker-model");
  eq(models.length, 3, "[27] DeepSeek 下有 3 个模型");
  const flashRow = modelRowByName(react, "DeepSeek-V41-Flash");
  const plainRow = modelRowByName(react, "Plain Model");
  const proRow = modelRowByName(react, "DeepSeek-V41-Pro");
  ok(String(flashRow.textContent).indexOf("4 档") >= 0, "[27] 有档位的模型显示「4 档」");
  ok(String(plainRow.textContent).indexOf("不支持") >= 0, "[27] 不支持档位的模型显示「不支持」");
  eq(plainRow.getAttribute("data-na"), "1", "[27] 不支持的那一行带 data-na=1（走灰显样式）");
  eq(flashRow.getAttribute("data-na"), "0", "[27] 有档位的那一行 data-na=0");
  eq(flashRow.getAttribute("data-sel"), "1", "[27] 当前选中的模型有勾选标记");
  eq(proRow.getAttribute("data-sel"), "0", "[27] 别的模型没有勾选标记");
  ok(String(flashRow.getAttribute("title")).indexOf("4 档：") === 0, "[27] 悬浮说明给出档位数与档位名");
  eq(String(plainRow.getAttribute("title")), "该模型不支持推理等级", "[27] 不支持时明示");
  ok(react.find("picker-search") !== null, "[27] 二级页有搜索框");
  eq(react.find("picker-search").getAttribute("placeholder"), "搜索模型…", "[27] 搜索框占位符与参考实现一致");

  // 搜索过滤（本地过滤）
  react.find("picker-search").fire("onChange", { target: { value: "pro" } });
  await settle();
  eq(react.findAll("picker-model").length, 1, "[27] 搜索 'pro' 只剩 1 行");
  ok(String(react.findAll("picker-model")[0].textContent).indexOf("DeepSeek-V41-Pro") >= 0, "[27] 剩下的是 Pro");
  react.find("picker-search").fire("onChange", { target: { value: "zzz" } });
  await settle();
  eq(react.findAll("picker-model").length, 0, "[27] 搜不到就没有行");
  ok(String(react.find("picker-list").textContent).indexOf("无匹配模型") >= 0, "[27] 并且给出「无匹配模型」提示");

  // 点模型：不关面板、不收起二级，直接写它自己的默认档
  react.find("picker-search").fire("onChange", { target: { value: "" } });
  await settle();
  await wait(COMMIT_WAIT);
  const beforeSelects = host.selects.length;
  modelRowByName(react, "DeepSeek-V41-Flash").fire("onClick", {});
  await settle();
  eq(host.selects.length, beforeSelects + 1, "[27] 点模型写了一次宿主");
  const selection = host.selects[host.selects.length - 1];
  eq(selection.provider, "deepseek", "[27] 写的是被点那个 provider");
  eq(selection.model, "deepseek-v41-flash", "[27] 写的是被点那个模型");
  eq(selection.reasoningEffort, "high", "[27] 档位用该模型的默认档（defaultEffort）");
  eq(react.find("picker-viewport").getAttribute("data-view"), "2", "[27] 点模型后面板仍然开着、二级页也没收起");
}

section("28. 自建浮层：滑条（轨道/填充/星云/星尘/刻度/旋钮）与 1/3 判定线写回");
{
  const scene = await setupPicker();
  const { react, host, internals } = scene;
  await scene.toggle();

  eq(react.findAll("picker-track").length, 1, "[28] 有一条轨道");
  eq(react.findAll("picker-fill").length, 1, "[28] 有一层填充");
  eq(react.findAll("picker-nebula").length, 1, "[28] 星云层在填充层里面");
  eq(react.findAll("picker-knob").length, 1, "[28] 有一个旋钮");
  eq(react.findAll("picker-tick").length, 4, "[28] 4 档 → 4 个刻度点");
  eq(react.findAll("picker-star").length, 22, "[28] 星尘一共 22 颗（与 1.x 同一套参数）");
  eq(react.find("picker-stars").children.length, 22, "[28] 星尘都挂在星空层里");

  // 位置 → 视觉：high（位置 2/3）→ 能量 0.5
  const highRoot = react.find("picker-panel-root");
  eq(highRoot.getAttribute("data-off"), "0", "[28] high 档不是 Off");
  near(parseFloat(react.find("picker-nebula").style["--energy"]), 0.5, "[28] 位置 2/3 → 能量 0.5（星云半透）");
  eq(react.findAll("picker-star").filter((node) => node.getAttribute("data-on") === "1").length, 11, "[28] 半能量 → 点亮 11 颗星");
  eq(react.find("picker-effort-value").style.color, "rgb(153,93,247)", "[28] 档位文字是靛紫（按能量算出来，与 1.x 的 high 档同一个值）");
  eq(String(react.find("picker-effort-value").textContent), "High", "[28] 卡片右上角写着当前档位名");
  ok(String(react.find("picker-knob").style.left).indexOf("calc(10px") === 0, "[28] 旋钮位置走端头内缩几何");
  ok(String(react.find("picker-fill").style.background).indexOf("linear-gradient") === 0, "[28] 填充层是「左蓝 → 右端当前色」的渐变");

  // 拖动：1/3 判定线 + 松手立即落地（拖动期间一次都不写）
  // 注意：桩件每次重渲都会重建节点，所以**每次事件都要现查**滑条（不能缓存句柄）。
  const usable = 300 - 2 * internals.picker.TR;
  const step = usable / 3;
  scene.slider(0, 300).fire("onPointerDown", { clientX: internals.picker.TR, pointerId: 1 });
  await settle();
  eq(react.find("picker-panel-root").getAttribute("data-off"), "1", "[28] 按到最左端 = Off 档");
  eq(react.findAll("picker-star").filter((node) => node.getAttribute("data-on") === "1").length, 0, "[28] Off 档一颗星都不亮");
  eq(parseFloat(react.find("picker-nebula").style["--energy"]), 0, "[28] Off 档没有能量（纯蓝，不通电）");
  eq(host.selects.length, 0, "[28] 拖动期间一次都不写宿主（停顿去抖）");
  scene.slider(0, 300).fire("onPointerMove", { clientX: internals.picker.TR + step, pointerId: 1 });
  await settle();
  eq(react.findAll("picker-tick").filter((node) => node.getAttribute("data-cur") === "1").length, 1, "[28] 任何时刻只有一个刻度被标为当前");
  eq(host.selects.length, 0, "[28] 拖动期间仍然 0 次写回");
  scene.slider(0, 300).fire("onPointerUp", {});
  await settle();
  eq(host.selects.length, 1, "[28] 松手立刻落地一次");
  eq(host.selects[0].reasoningEffort, "low", "[28] 落到的是 low 档（越过 1/3 判定线后的那一档）");
  eq(host.selects[0].provider, "deepseek", "[28] 写回带上 provider");
  eq(host.selects[0].model, "deepseek-v41-flash", "[28] 写回带上 model");

  // 同一个档位再拖一遍：同档去重，一次都不写
  scene.slider(0, 300).fire("onPointerDown", { clientX: internals.picker.TR + step, pointerId: 1 });
  await settle();
  scene.slider(0, 300).fire("onPointerUp", {});
  await settle();
  await wait(COMMIT_WAIT);
  eq(host.selects.length, 1, "[28] 拖回同一档：宿主已经是这一档，0 次写回（去重）");

  // 最高档：满星云 + 只剩当前刻度（solo）
  scene.slider(0, 300).fire("onPointerDown", { clientX: 300, pointerId: 1 });
  await settle();
  eq(parseFloat(react.find("picker-nebula").style["--energy"]), 1, "[28] 最右端 → 能量 1（满星云）");
  eq(react.find("picker-panel-root").getAttribute("data-solo"), "1", "[28] 最高档进入 solo（其余刻度淡出）");
  eq(react.findAll("picker-star").filter((node) => node.getAttribute("data-on") === "1").length, 22, "[28] 满能量 → 22 颗星全亮");
  scene.slider(0, 300).fire("onPointerUp", {});
  await settle();
  eq(host.selects.length, 2, "[28] 最高档也写回一次");
  eq(host.selects[1].reasoningEffort, "max", "[28] 写到 max");
}

section("29. 自建浮层：档位弹层显示原始 API 取值 + 点它写回");
{
  const scene = await setupPicker();
  const { react, host } = scene;
  const picker = scene.internals.picker;
  await scene.toggle();

  eq(react.findAll("picker-pop").length, 0, "[29] 默认不显示档位弹层");
  react.find("picker-more").fire("onClick", {});
  await settle();
  eq(react.findAll("picker-pop").length, 1, "[29] 点档位名展开弹层（与参考实现一致）");
  const rows = react.findAll("picker-pop-row");
  eq(rows.length, 4, "[29] 4 档 → 弹层 4 行");
  const apis = react.findAll("picker-api");
  eq(apis.map((node) => String(node.textContent)).join(","), "off,low,high,max", "[29] 每行显示原始 API 取值（发送请求用的就是它）");
  eq(apis[0].getAttribute("title"), "API: off", "[29] 悬浮说明是 `API: <id>`");
  eq(rows.filter((node) => node.getAttribute("aria-checked") === "true").length, 1, "[29] 恰好一行标为已选");
  eq(rows[2].getAttribute("aria-checked"), "true", "[29] 已选的是当前档位（high）");
  eq(picker.isOffLevel({ id: "off", name: "关闭" }), true, "[29] off/关闭 都认成 Off 档");
  eq(picker.isOffLevel({ id: "none", name: "None" }), true, "[29] none 也认成 Off 档（OpenAI 那一族的第 0 档）");
  eq(picker.isOffLevel({ id: "high", name: "High" }), false, "[29] high 不是 Off 档");

  rows[0].fire("onClick", {});
  await settle();
  eq(host.selects.length, 1, "[29] 点弹层里的一行 → 立即写回一次");
  eq(host.selects[0].reasoningEffort, "off", "[29] 写的是被点那一档的原始 id");
  eq(react.findAll("picker-pop").length, 0, "[29] 点完自动收起弹层");
  eq(react.find("picker-panel-root").getAttribute("data-off"), "1", "[29] 弹层把滑条带到 Off 档");
  eq(String(react.find("picker-effort-value").textContent), "Off", "[29] 卡片右上角跟着变");

  // Esc：弹层 → 面板，逐层退避
  react.find("picker-more").fire("onClick", {});
  await settle();
  eq(react.findAll("picker-pop").length, 1, "[29] 重新打开弹层");
  scene.document.dispatch("keydown", { key: "Escape" });
  await settle();
  eq(react.findAll("picker-pop").length, 0, "[29] Esc 先关弹层");
  ok(react.find("picker-panel-root") !== null, "[29] 面板还开着");
  scene.document.dispatch("keydown", { key: "Escape" });
  await settle();
  eq(react.find("picker-panel-root"), null, "[29] 再按 Esc 才关面板");
}

section("30. 自建浮层：双页 carousel 的舞台（两页同步位移的那两条边）");
{
  const scene = await setupPicker();
  const { react, internals } = scene;
  const picker = internals.picker;
  await scene.toggle();

  const pages = react.findAll("picker-page");
  eq(pages.length, 2, "[30] 舞台上正好两页（page1 / page2）");
  eq(pages[0].getAttribute("data-slot"), "1", "[30] 第一页的槽位号是 1");
  eq(pages[1].getAttribute("data-slot"), "2", "[30] 第二页的槽位号是 2");
  eq(react.find("picker-viewport").getAttribute("data-view"), "1", "[30] 初始在第 1 页");

  // 位移只由 CSS 规则表达（参考实现那四条）
  const css = picker.PICKER_CSS;
  ok(css.indexOf(".cxp-page[data-slot='1']{transform:translateX(0)}") > 0, "[30] page1 原位");
  ok(css.indexOf(".cxp-page[data-slot='2']{transform:translateX(100%)}") > 0, "[30] page2 停在右边一屏之外");
  ok(css.indexOf("[data-view='2'] .cxp-page[data-slot='1']{transform:translateX(-100%)}") > 0, "[30] 进二级：page1 往左走一屏");
  ok(css.indexOf("[data-view='2'] .cxp-page[data-slot='2']{transform:translateX(0)}") > 0, "[30] 进二级：page2 同步回到 0（两页一起动，边缘全程贴合）");
  ok(css.indexOf("transition:transform .3s cubic-bezier(.32,.72,.28,1)") > 0, "[30] 位移时长/曲线与参考实现一致（.3s cubic-bezier(.32,.72,.28,1)）");
  ok(css.indexOf(".cxp-viewport{position:relative;overflow:hidden;transition:height .3s") > 0, "[30] 视口裁切 + 高度也跟着过渡");
  eq(css.indexOf("box-shadow") > 0 && css.indexOf(".cxp-page{position:absolute;top:0;left:0;width:100%") > 0, true, "[30] 两页没有任何边缘描边/阴影（接缝的另一半）");
  ok(css.indexOf(".cxp-page{position:absolute;top:0;left:0;width:100%;transition:transform") > 0, "[30] 两页都是绝对定位（同一原点，位移才可能贴合）");

  // 视口高度按当前页算（page 是 absolute，不撑父级）
  const catalog = picker.readCatalog(snapshotOf({
    groups: [
      { id: "deepseek", name: "DeepSeek", models: [
        { id: "a", name: "A", reasoning: { defaultEffort: "low", efforts: [{ id: "off", name: "Off" }, { id: "low", name: "Low" }] } },
      ] },
      { id: "openai", name: "OpenAI", models: [
        { id: "b", name: "B", reasoning: { defaultEffort: "low", efforts: [{ id: "low", name: "Low" }] } },
      ] },
    ],
  }));
  eq(catalog.providers.length, 2, "[30] 目录折出 2 个 provider");
  /*
   * 高度算式（真机踩过：`rowH` 拍成 38，比真实 41 每行少 3px，一级页末行被 overflow:hidden 裁掉
   * 且没有滚动容器、滚不回来）。下面先**从样式表实算**行高，再拿算式的输出对照 ——
   * 这样以后改了 CSS 忘了同步常量，这里会先红。
   */
  const ruleOf = (selector) => {
    const found = new RegExp(`\\${selector}\\{([^}]*)\\}`).exec(css);
    return found === null ? "" : found[1];
  };
  const px = (text, prop) => {
    const found = new RegExp(`${prop}:([\\d.]+)px`).exec(text);
    return found === null ? NaN : Number(found[1]);
  };
  const rowRule = ruleOf(".cxp-row");
  const modelRule = ruleOf(".cxp-model");
  const realRowH = px(rowRule, "padding") * 2 + px(rowRule, "font-size") * 1.5;
  const secRule = ruleOf(".cxp-sec");
  // `.cxp-sec` 的 padding 是简写 `4px 8px 8px`（上 4 / 左右 8 / 下 8）：垂直合计 12，不能只取第一个数
  ok(secRule.indexOf("padding:4px 8px 8px") >= 0, "[30] `.cxp-sec` 的上内距仍是 4px");
  ok(secRule.indexOf("font-size:12px") >= 0, "[30] `.cxp-sec` 的字号仍是 12px");
  const realSecH = 4 + 8 + 12 * 1.5;
  eq(realRowH, 41, "[30] `.cxp-row` 实算行高 = 10×2 + 14×1.5 = 41（算式用的常量必须与它一致）");
  eq(px(modelRule, "font-size") * 1.5 + px(modelRule, "padding") * 2, 39, "[30] `.cxp-model` 实算行高 = 39");
  eq(realSecH, 30, "[30] `.cxp-sec` 实算高度 = 4+8 + 12×1.5 = 30");

  eq(
    picker.viewportHeightFor(catalog, 1, "", null),
    realSecH + 2 * realRowH,
    "[30] 一级页高度 = 小节标题 + 2 行（与 CSS 实算一致，不再是 106 那个拍出来的值）",
  );
  eq(picker.viewportHeightFor(catalog, 1, "", null), 112, "[30] 一级页 = 30 + 2×41 = 112（真机上末行不再被裁）");
  eq(picker.viewportHeightFor(catalog, 2, "", "deepseek"), 119, "[30] 二级页 = 头 36 + 搜索 40 + 1 行 39 + 列表底距 4 = 119");
  eq(picker.viewportHeightFor(catalog, 2, "", "openai"), 119, "[30] 另一个 provider 也一样按它自己的行数算");
  eq(
    picker.viewportHeightFor(catalog, 2, "zzz", "deepseek"),
    36 + 40 + 48 + 4,
    "[30] 搜不到时高度要**装得下那句「无匹配模型」**（48）—— 以前给 80，那句提示被 overflow:hidden 裁掉",
  );
  // 列表有 max-height：模型再多也到此为止（否则页面高度会被撑破）
  const manyCatalog = picker.readCatalog(snapshotOf({
    groups: [{ id: "deepseek", name: "DeepSeek", models: Array.from({ length: 20 }, (_, i) => ({
      id: "m" + i, name: "M" + i, reasoning: { defaultEffort: "low", efforts: [{ id: "low", name: "Low" }] },
    })) }],
  }));
  eq(
    picker.viewportHeightFor(manyCatalog, 2, "", "deepseek"),
    36 + 40 + 252,
    "[30] 20 个模型时被 `.cxp-list` 的 max-height(252) 截住（与 CSS 同一个常量）",
  );
}

section("31. 自建浮层：禁用态、目录没就绪、以及「点模型不关面板」的回归");
{
  // 没有档位的模型：滑条禁用（灰掉 + 不吃指针 + aria-disabled），弹层按钮也禁用
  const disabledScene = await setupPicker({
    host: { snapshot: snapshotOf({ groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "plain", name: "Plain" }] }] }) },
  });
  await disabledScene.toggle();
  const dRoot = disabledScene.react.find("picker-panel-root");
  eq(dRoot.getAttribute("data-disabled"), "1", "[31] 当前模型没有档位 → 禁用态");
  ok(disabledScene.internals.PICKER_CSS.indexOf(".cxp[data-disabled='1'] .cxp-card{opacity:.45}") > 0, "[31] 禁用态把整张卡片压暗");
  ok(disabledScene.internals.PICKER_CSS.indexOf(".cxp[data-disabled='1'] .cxp-slider{pointer-events:none}") > 0, "[31] 禁用态不吃指针（拖不动）");
  eq(disabledScene.react.findAll("picker-tick").length, 0, "[31] 没有档位就没有刻度");
  eq(disabledScene.react.find("picker-more") !== null, true, "[31] 档位名那颗按钮仍然渲染（只是禁用 + 显示破折号）");
  eq(String(disabledScene.react.find("picker-effort-value").textContent), "—", "[31] 档位名显示为破折号");
  eq(disabledScene.react.find("picker-slider").getAttribute("aria-disabled"), "true", "[31] 禁用态进了无障碍树（aria-disabled）");
  disabledScene.slider(0, 300).fire("onPointerDown", { clientX: 100, pointerId: 1 });
  await settle();
  eq(disabledScene.host.selects.length, 0, "[31] 禁用时按下不写任何东西");

  // 目录没就绪（directoryFor 一直抛错）：面板能开，但不崩、不写
  const brokenScene = await setupPicker({ host: { throwDirectoryFor: true } });
  await brokenScene.toggle();
  ok(brokenScene.react.find("picker-panel") !== null, "[31] 目录不可用时面板照样能打开（fail-open）");
  // 1.3.5：这里必须说"**我们**没拿到目录"，而不是含糊的"没有可用的 provider"
  //（后者与"宿主就绪但没列 provider"共用一句话，真机上根本分不清是谁的问题）
  const brokenEmpty = brokenScene.react.find("picker-empty");
  ok(brokenEmpty !== null, "[31] 空态那行渲染出来了");
  eq(
    String(brokenEmpty.textContent),
    "会话目录未就绪，正在重试…",
    "[31] 并且如实说是**我们**还没拿到目录（phase=unresolved）",
  );
  eq(brokenEmpty.getAttribute("data-phase"), "unresolved", "[31] 空态带上 phase 标记（诊断口径可断言）");
  eq(brokenScene.react.find("picker-panel-root").getAttribute("data-disabled"), "1", "[31] 没有档位 → 禁用态");
  eq(brokenScene.host.selects.length, 0, "[31] 不会尝试写宿主");

  // 点模型不关面板（参考实现明确要求的行为）
  const scene = await setupPicker();
  await scene.toggle();
  scene.react.findAll("picker-provider")[1].fire("onClick", {});
  await settle();
  eq(scene.react.find("picker-viewport").getAttribute("data-view"), "2", "[31] 进 OpenAI 的二级页");
  const models = scene.react.findAll("picker-model");
  eq(models.length, 5, "[31] OpenAI 有 5 个模型");
  ok(String(modelRowByName(scene.react, "gpt-6-astra").textContent).indexOf("8 档") >= 0, "[31] 8 档的模型显示「8 档」");
  ok(String(modelRowByName(scene.react, "gpt-4o").textContent).indexOf("不支持") >= 0, "[31] gpt-4o 显示「不支持」");
  await wait(COMMIT_WAIT);
  const before = scene.host.selects.length;
  modelRowByName(scene.react, "gpt-6-luna").fire("onClick", {});
  await settle();
  eq(scene.host.selects.length, before + 1, "[31] 点模型写一次");
  eq(scene.host.selects[before].provider, "openai", "[31] provider 跟着切到 openai（参考实现那个 bug 的回归）");
  eq(scene.host.selects[before].model, "gpt-6-luna", "[31] 写的是被点的模型");
  eq(scene.host.selects[before].reasoningEffort, "medium", "[31] 用它的默认档");
  eq(scene.react.find("picker-viewport").getAttribute("data-view"), "2", "[31] 面板与二级页都没关");
}

section("31b. 无档位模型也能选中（选模型与配档位解耦）");
{
  /*
   * 缺口：`pickModel` 以前遇到 `levels.length === 0` 直接 return —— 二级页里那些标着
   * 「不支持」的行**点不动**。现在选模型与配档位解耦：无档位模型照样能选中，
   * 只是那次写入不带 `reasoningEffort`（契约见第 12 节：官方是**条件展开**，键整个不出现）。
   *
   * 徽标文案与灰显样式（`data-na='1'`）**不动** —— 这次只是让那一行可点。
   */
  const scene = await setupPicker({ host: { select: commitSelection } });
  const { react, host } = scene;
  await scene.toggle();
  react.findAll("picker-provider")[0].fire("onClick", {}); // 进 DeepSeek 二级页
  await settle();

  const rows = react.findAll("picker-model");
  eq(rows.length, 3, "[31b] DeepSeek 下有 3 个模型");
  const plainRow = modelRowByName(react, "Plain Model");
  eq(plainRow.getAttribute("data-na"), "1", "[31b] 无档位模型带灰显标记（不变）");
  ok(String(plainRow.textContent).indexOf("不支持") >= 0, "[31b] 徽标文案不变（仍「不支持」）");

  await wait(COMMIT_WAIT);
  const before = host.selects.length;
  plainRow.fire("onClick", {}); // 点它
  await settle();

  // a. payload 形状
  eq(host.selects.length, before + 1, "[31b] 点无档位模型：写一次（以前是 0 次 —— 点不动）");
  eq(host.selects[before].provider, "deepseek", "[31b] payload 带上 provider");
  eq(host.selects[before].model, "plain-model", "[31b] payload 带上 model");
  eq(
    Object.prototype.hasOwnProperty.call(host.selects[before], "reasoningEffort"),
    false,
    "[31b] 契约：`reasoningEffort` 键**整个不出现**（不是 null、也不是显式 undefined）",
  );
  eq(host.selects[before].reasoningEffort, undefined, "[31b] 读出来是 undefined（与上一行的「键缺席」是两件事）");

  // b. 面板不关、二级页不收（与 [31] 同款）
  ok(react.find("picker-panel-root") !== null, "[31b] 面板不关");
  eq(react.find("picker-viewport").getAttribute("data-view"), "2", "[31b] 二级页不收起");

  // c. 从「有档位」切到「无档位」：滑条卡片转禁用、档位名变破折号
  eq(react.find("picker-panel-root").getAttribute("data-disabled"), "1", "[31b] 切到无档位模型 → 进入禁用态");
  eq(String(react.find("picker-effort-value").textContent), "—", "[31b] 档位名显示破折号");
  eq(react.findAll("picker-tick").length, 0, "[31b] 没有档位就没有刻度");
  eq(react.find("picker-slider").getAttribute("aria-disabled"), "true", "[31b] 禁用态进了无障碍树");

  // 再切回有档位模型：一切如常
  modelRowByName(react, "DeepSeek-V41-Flash").fire("onClick", {});
  await settle();
  eq(react.find("picker-panel-root").getAttribute("data-disabled"), "0", "[31b] 切回有档位模型 → 禁用态解除");
  eq(react.findAll("picker-tick").length, 4, "[31b] 刻度回来了（4 档）");
  ok(String(react.find("picker-effort-value").textContent) !== "—", "[31b] 档位名不再是破折号");
}

section("31c. 回归钉：换模型时清掉旧模型的待落地档位写入（含乐观值）");
{
  /*
   * 拖滑条攒下一次**去抖**写回（按住不放，不让 pointerUp 立即落地），
   * 然后在 260ms 窗口内点无档位模型 —— 旧模型那次档位写入**不能**在切换之后才落地
   * （否则会把刚换上的新模型写回旧档位）。
   *
   * 同时钉住 `optimisticId` 也被清：切到无档位后 `catalog.level` 变 null，
   * 旧乐观值永远等不到"宿主追上"那一刻，不清就是一次悬挂状态。
   */
  const scene = await setupPicker({ host: { select: commitSelection } });
  const { react, host } = scene;
  const TR = scene.internals.picker.TR;
  await scene.toggle();

  const usable = 300 - 2 * TR;
  scene.slider(0, 300).fire("onPointerDown", { clientX: TR + usable / 3, pointerId: 1 });
  await settle();
  eq(host.selects.length, 0, "[31c] 拖动期间一次都不写宿主（去抖中，窗口还没到期）");

  // 不等窗口到期：立刻进二级页点那个无档位模型
  react.findAll("picker-provider")[0].fire("onClick", {});
  await settle();
  modelRowByName(react, "Plain Model").fire("onClick", {});
  await settle();

  eq(host.selects.length, 1, "[31c] 此刻只有「模型切换」那一次写入");
  eq(host.selects[0].model, "plain-model", "[31c] 写的是新模型");

  await wait(COMMIT_WAIT); // 越过 260ms 去抖窗口
  eq(host.selects.length, 1, "[31c] 窗口过后**仍然只有 1 次** —— 旧模型的档位写入没有迟到落地（回归钉）");
  eq(
    Object.prototype.hasOwnProperty.call(host.selects[0], "reasoningEffort"),
    false,
    "[31c] 那一次也不带 reasoningEffort",
  );
}

/* ══════════════════════════════════════════════════════════════════════ */

section("32. 包内 chunk 的加载契约（真机踩过：入口按钮根本不出现）");
{
  /*
   * 现场：`lib/client.picker.js` 曾经是**裸 ESM**（`export { ... }` 结尾）。
   * 离线测试台当时自己做了 ESM→CJS 转换，所以 596 项全绿；可真宿主是把它当**普通脚本**
   * serve 的（`buildComboScript` 只做拼接，不替它包壳），于是：
   *   · `export` 语法直接报错、工厂从未注册 → `require.async` 永远取不到
   *   · `PickerSlot` 一直渲染 null → 用户看不到入口按钮
   * 所以这一节**按真宿主的方式**加载它：只给一个假的 `window.__ModuleLoader__`，不替它转换。
   * 谁把它改回裸 ESM，这里会先炸。
   */
  const chunkPath = fileURLToPath(new URL("../lib/client.picker.js", import.meta.url));
  const source = readFileSync(chunkPath, "utf8");
  ok(source.indexOf("__ModuleLoader__.load") > 0, "[32] chunk 自己注册进模块表（不是裸 ESM）");
  ok(source.indexOf("export ") < 0, "[32] chunk 里没有 ESM 的 export 语句（脚本标签里会直接语法错）");

  // 用最小假 window 跑一遍注册路径（与真实模块表同款契约）
  let registration = null;
  const fakeWindow = { innerWidth: 1280, innerHeight: 800, __ModuleLoader__: { load(reg) { registration = reg; } } };
  const run = new Function("window", "document", "console", "setTimeout", "clearTimeout", source);
  run(fakeWindow, null, console, setTimeout, clearTimeout);
  ok(registration !== null, "[32] 脚本执行后确实调用了一次 load()");
  eq(registration.id, "better-dsh-codex-effort-slider", "[32] 注册 id 与包名一致（模块表会把 <包名>/<文件名> 当作 key）");
  eq(registration.chunk, "client.picker.js", "[32] chunk 字段正确");
  const chunkExports = registration.factory(() => null);
  ok(chunkExports !== null && typeof chunkExports.createPickerTrigger === "function", "[32] 工厂交出了 createPickerTrigger");
  ok(typeof chunkExports.createPickerSurface === "function", "[32] 工厂交出了 createPickerSurface");
  ok(typeof chunkExports.pickerStore === "object" && typeof chunkExports.pickerStore.openAt === "function", "[32] 交出了模块级 pickerStore（两条插槽共享开合状态）");
  ok(typeof chunkExports.PICKER_CSS === "string" && chunkExports.PICKER_CSS.indexOf(".cxp-panel") > 0, "[32] 同时交出了样式表（.cxp- 命名空间）");
  ok(typeof chunkExports.readCatalog === "function", "[32] 交出了纯函数（面板的数据入口）");

  // 源码与生成物必须同步：改了 src 忘了构建，真机拿到的就是旧面板
  const src = readFileSync(fileURLToPath(new URL("../lib/client.picker.src.js", import.meta.url)), "utf8");
  ok(src.indexOf("__ModuleLoader__") < 0, "[32] 源码（.src.js）本身不注册（注册由构建脚本注入）");
  const lastSrcLine = src.trim().split("\n").slice(-1)[0].trim();
  ok(source.indexOf(lastSrcLine) > 0, "[32] 生成物里含源码的最后一行（说明是同一次构建的产物）");
}

section("33. 平台没有 window 时面板仍然可用（定位是可选增强）");
{
  const scene = await setupPicker();
  const trigger = scene.trigger();
  ok(trigger !== null, "[33] 触发器仍然渲染（入口不会因为拿不到 window 就消失）");
  trigger.fire("onClick", {});
  await settle();
  ok(scene.react.find("picker-panel") !== null, "[33] 点开后面板照常出现");
}

section("34. 样式真的进了文档（真机踩过：参数被静默忽略 → 面板完全没样式）");
{
  /*
   * 现场：1.3.0 第一版把自建浮层的样式表当**参数**传给 `installStyles(...)`，
   * 而那个函数当时**不收参数** —— 参数被静静丢掉，`.cxp-*` 从未注入。
   * 真机表现：入口按钮在（chunk 加载好了），但面板没有任何布局、`position:fixed` 也没生效，
   * 整块内容摊进了页面流。
   *
   * 教训：注入类函数的"参数被忽略"是**静默失败**，必须断言**文档里真的有那段 CSS**，
   * 而不是只断言"某个字符串变量里有这段 CSS"（后者一直是对的，所以测不出这个 bug）。
   */
  const scene = await setupPicker();
  const { document, bundle } = scene;
  const styles = document.head.querySelectorAll("style");
  const texts = styles.map((tag) => String(tag.textContent ?? ""));
  const markers = styles.map((tag) => tag.getAttribute("data-plugin-css"));
  eq(styles.length, 2, "[34] 文档里挂了**两张**样式表：官方菜单那条 + 自建浮层那条");
  ok(markers.indexOf("better-dsh-codex-effort-slider") >= 0, "[34] 官方菜单那份用原标记");
  ok(
    markers.some((marker) => typeof marker === "string" && marker.indexOf("/picker") > 0),
    "[34] 浮层那份用 …/picker 标记（与前一张分开去重）",
  );
  const pickerCss = texts.filter((text) => text.indexOf(".cxp-panel") >= 0).join("");
  ok(pickerCss.length > 2000, "[34] 浮层的样式表**真的在文档里**（不是只在 JS 变量里）");
  const required = [
    ".cxp-root{position:fixed",
    ".cxp-panel{width:272px",
    ".cxp-page{position:absolute",
    ".cxp-viewport[data-view='2'] .cxp-page[data-slot='1']{transform:translateX(-100%)}",
    ".cxp-slider{position:relative",
    ".cxp-pop{position:fixed",
    ".cxp-trigger{display:inline-flex",
    "corner-shape:round",
  ];
  for (const rule of required) ok(pickerCss.indexOf(rule) >= 0, `[34] 文档里有这条关键规则：${rule.slice(0, 44)}`);
  ok(texts.some((text) => text.indexOf(".ces-track") >= 0), "[34] 官方菜单那份样式也还在（两张互不覆盖）");

  // 幂等：按**真实标记**重复安装不会叠加第三张（去重是按 data-plugin-css 走的）
  const api = internalsOf(bundle);
  ok(typeof api.PICKER_STYLE_MARKER === "string" && api.PICKER_STYLE_MARKER.length > 0, "[34] 浮层样式的标记是稳定字符串（不是 undefined）");
  eq(api.installStyles(api.PICKER_CSS, api.PICKER_STYLE_MARKER), document.head.querySelectorAll("style")[1], "[34] 重复安装返回**已存在**的那张标签（没有新建）");
  eq(document.head.querySelectorAll("style").length, 2, "[34] 重复安装是幂等的（仍只有两张）");
  eq(api.installStyles(undefined, undefined), document.head.querySelectorAll("style")[0], "[34] 不带参数时仍然复用官方菜单那张（老调用点不受影响）");
  eq(document.head.querySelectorAll("style").length, 2, "[34] 依然只有两张");
}

section("35. 触发器与面板的位置基准（真机踩过：按钮错位、面板乱飘）");
{
  /*
   * 真机上出过两个位置问题：
   *   1. 触发器错位、还和官方那颗模型席按钮叠在一起 —— 因为它被塞进了 overlay 插槽的流内布局；
   *   2. 面板"乱飘" —— 它当时监听全文档 scroll + ResizeObserver 反复重定位，且住在
   *      composer 卡片内部（fixed 被 transform 祖先劫持）。
   *
   * 现在：trigger 挂在 `conversation.input.model`（接管官方席，拿不到就退回 input.right）；
   * surface 的面板本体 portal 到 `document.body`；位置**右缘对齐 composer 卡片**、
   * 底边锚在触发器顶边；滚动/缩放**重定位而不关闭**（1.3.4 的用户反馈推翻了旧的"滚动即关闭"）。
   */
  const scene = await setupPicker();
  const { react, bundle, document, menu } = scene;

  const trigger = scene.trigger();
  ok(trigger !== null, "[35] 触发器渲染出来了");
  eq(bundle.react.findAll("picker-trigger").length, 1, "[35] 只有一颗触发器（幂等守卫没让第二份出现）");
  eq(trigger.style.position ?? "", "", "[35] 触发器不带内联 position（流内，由宿主布局落位）");

  // 给触发器与 composer 卡片确定矩形（假 DOM 不做布局），再点开
  trigger.rect = { left: 600, top: 100, right: 780, bottom: 128, width: 180, height: 28 };
  menu.composer.rect = { left: 300, top: 96, right: 900, bottom: 200, width: 600, height: 104 };
  trigger.fire("onClick", {});
  await settle();
  const panelRoot = react.find("picker-panel-root");
  ok(panelRoot !== null, "[35] 面板出现");
  eq(panelRoot.parentNode, document.body, "[35] 面板本体 portal 到 document.body（fixed 不再被 composer 的 transform 劫持）");
  // 1.3.4：右缘对齐输入框（卡片右缘 900 − 面板宽 272 = 628）
  eq(panelRoot.style.left, "628px", "[35] 面板**右缘与输入框右缘对齐**（1.3.4 的用户要求）");
  eq(
    parseFloat(panelRoot.style.left) + scene.internals.picker.PANEL_W,
    menu.composer.rect.right,
    "[35] 断言写成算式：left + 面板宽 === composer 右缘",
  );
  // 视口高 800、触发器顶边 100 → 底边距视口底 708，即正好在触发器顶边上方 8px
  eq(panelRoot.style.bottom, (800 - 100 + 8) + "px", "[35] 面板**底边**贴触发器上方 8px（底边锚定，不再估算高度）");
  eq(panelRoot.style.top ?? "", "", "[35] 不再用 top 定位（高度估算随之删除）");
  ok(
    typeof panelRoot.style.maxHeight === "string" && parseFloat(panelRoot.style.maxHeight) > 0,
    "[35] 带上安全网 maxHeight（极矮窗口时改为面板内部滚动，不顶出屏幕）",
  );

  // 纯函数层：底边锚定 + 右缘对齐的算式（不依赖假 DOM 的布局）
  const pickerMod = scene.picker;
  const seatLow = pickerMod.computePanelPos({ left: 600, top: 100, bottom: 128, width: 180, height: 28 });
  eq(seatLow.left, 780 - 272, "[35] 算式：没有卡片时右缘对齐**触发器右缘**（780 − 272）");
  eq(seatLow.bottom, 708, "[35] 算式：视口 800 / 触发器顶 100 → bottom = 708");
  eq(seatLow.maxH, 200, "[35] 算式：贴近视口上方时 maxHeight 落到兜底 200（直接算是 84，兜底生效、永不为负）");
  eq(
    pickerMod.computePanelPos({ left: 600, top: 100, width: 180, height: 28 }, { left: 300, width: 600, right: 1200 }).left,
    1200 - 272,
    "[35] 算式：有 composer 卡片时右缘对齐**卡片右缘**（优先于触发器）",
  );
  const seatHigh = pickerMod.computePanelPos({ left: 600, top: 700, bottom: 728, width: 180, height: 28 });
  eq(seatHigh.bottom, 108, "[35] 算式：触发器靠下 → 底边 108");
  eq(seatHigh.maxH, 684, "[35] 算式：空间够时 maxHeight = 视口高 − 底边 − 留白");
  eq(
    pickerMod.computePanelPos({ left: 1200, top: 700, bottom: 728, width: 180, height: 28 }).left,
    1000,
    "[35] 算式：右越界时左缘夹到 vw − 面板宽 − 留白",
  );

  // 回归钉：切进二级页内容变高 → **底边原地不动**、面板向上延伸。
  // 这正是顶边锚定会挂的地方（那时 top 冻结、面板朝下长，越切越长）。
  // 断言写**硬值**而不是"翻页前后相等"：否则回退成 top 定位时两边都是 undefined，
  // `undefined === undefined` 会假通过。
  const bottomOpen = react.find("picker-panel-root").style.bottom;
  eq(bottomOpen, "708px", "[35] 打开时底边就是 708px（硬值，防 undefined 假通过）");
  react.findAll("picker-provider")[0].fire("onClick", {});
  await settle();
  eq(react.find("picker-viewport").getAttribute("data-view"), "2", "[35] 已进二级页（内容变高了）");
  eq(react.find("picker-panel-root").style.bottom, "708px", "[35] 二级页变高 → 底边不动、向上延伸（回归钉）");

  // 底边锚定的两处 CSS 配套（少了它们，安全网与动画原点都对不上）
  const pickerCss = internalsOf(bundle).PICKER_CSS;
  /*
   * 矮窗口的滚动安全网在**面板自己那一层**（1.3.10 改）。
   *
   * 原来它在 `.cxp-root` 上，而 `overflow` 会裁掉**后代**的 box-shadow ——
   * 阴影画在 `.cxp-panel` 上，于是被裁成矩形（圆角面板外套一圈方角光晕）。
   * 元素自身的 box-shadow 不受自身 overflow 影响，所以滚动与阴影放同一层就两全。
   */
  ok(
    /\.cxp-root\{[^}]*overflow:visible/.test(pickerCss),
    "[35] 定位壳 `overflow:visible`（带 overflow 会把面板的阴影裁成矩形 —— 真机反馈「阴影被一个框限制了」）",
  );
  ok(
    /\.cxp-panel\{[^}]*overflow:auto/.test(pickerCss),
    "[35] 矮窗口的内部滚动挪到 `.cxp-panel`（安全网还在，而且不裁自己的阴影）",
  );
  // 行内 max-height 两边都给：壳定位、面板滚动
  const rootStyle = react.find("picker-panel-root").style;
  const panelEl = react.find("picker-panel");
  ok(
    typeof rootStyle.maxHeight === "string" && rootStyle.maxHeight.length > 0,
    "[35] 壳上仍有 maxHeight（定位/夹取仍按它算）",
  );
  eq(panelEl.style.maxHeight, rootStyle.maxHeight, "[35] 同一个 maxHeight 也写给面板（滚动由它执行）");
  ok(/\.cxp-panel\{[^}]*transform-origin:bottom right\}/.test(pickerCss), "[35] `.cxp-panel` 缩放原点跟锚定边一致（bottom right）");

  // 滚动策略（一）：**面板内部**的滚动（模型列表 / 视口）不算"页面在滚"，面板必须留着。
  // 真机上的病：滚一下模型列表，面板把自己关掉了 —— 因为 capture 阶段的 scroll 会到达 document。
  document.dispatch("scroll", { target: react.find("picker-viewport") });
  await settle();
  ok(react.find("picker-panel-root") !== null, "[35] 面板内部滚动（列表 / 视口）不关面板");

  // 滚动策略（二）：页面在滚 → **重定位，不关闭**（1.3.4）。
  // 真机病（用户实测）：助手流式输出时聊天区一直在自动滚动，而旧的"滚动即关闭"策略
  // 于是把面板关掉了 —— "对话还没结束，对话一刷新，面板就没了"。
  bundle.react.find("picker-search").fire("onChange", { target: { value: "" } });
  await settle();
  document.dispatch("scroll", {});
  await settle();
  ok(react.find("picker-panel-root") !== null, "[35] 页面滚动**不再关闭面板**（1.3.4 用户反馈的修复）");

  // 重定位确实发生了：把触发器挪走 → 再滚一次 → 面板跟着走（而不是留在旧位置）
  scene.trigger().rect = { left: 400, top: 300, right: 580, bottom: 328, width: 180, height: 28 };
  document.dispatch("scroll", {});
  await settle();
  eq(
    react.find("picker-panel-root").style.bottom,
    (800 - 300 + 8) + "px",
    "[35] 触发器上移 → 滚动后底边跟着重算（面板跟着锚点走，1.3.4 的重定位）",
  );
  eq(
    parseFloat(react.find("picker-panel-root").style.left) + scene.internals.picker.PANEL_W,
    menu.composer.rect.right,
    "[35] 重定位后左缘仍按「右缘对齐 composer」算（卡片没动 → 左缘不变）",
  );

  // 触发器被宿主 `hidden`（助手在跑时 composer 会藏起控件行）→ rect 全 0 →
  // **保持原位**，既不乱飞也不消失
  const beforeHide = react.find("picker-panel-root").style.bottom;
  scene.trigger().rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  document.dispatch("scroll", {});
  await settle();
  ok(react.find("picker-panel-root") !== null, "[35] 触发器不可见时面板**不消失**");
  eq(react.find("picker-panel-root").style.bottom, beforeHide, "[35] 触发器 rect 全 0 时保持原位（不拿零尺寸去定位）");
  scene.trigger().rect = { left: 400, top: 300, right: 580, bottom: 328, width: 180, height: 28 };

  // 尺寸策略：视口变了与滚动同一条策略 —— 重定位，不关闭
  bundle.window.dispatch("resize", {});
  await settle();
  ok(react.find("picker-panel-root") !== null, "[35] 视口尺寸变化**不再关闭面板**（与滚动同策略）");
  ok(bundle.window.listenerCount("resize") >= 1, "[35] 面板开着时 resize 监听器挂着（关掉才摘）");

  // 真正关闭（Esc）之后监听器要摘干净，不留悬挂。
  // 注意此时还停在二级页，Esc 是**逐层退避**的：第一次回一级页，第二次才关面板。
  document.dispatch("keydown", { key: "Escape" });
  await settle();
  eq(react.find("picker-viewport").getAttribute("data-view"), "1", "[35] Esc 第一下：从二级页退回一级页");
  document.dispatch("keydown", { key: "Escape" });
  await settle();
  eq(react.find("picker-panel-root"), null, "[35] Esc 第二下：面板关闭");
  eq(bundle.window.listenerCount("resize"), 0, "[35] 关闭后 resize 监听器也摘干净了（不会越挂越多）");

  // 关掉之后还能再开
  scene.trigger().fire("onClick", {});
  await settle();
  ok(react.find("picker-panel-root") !== null, "[35] 重新打开成功（关闭后还能开）");
}

section("36. 拿不到 window 时面板仍然可用（定位是可选增强）");
{
  const scene = await setupPicker();
  const trigger = scene.trigger();
  ok(trigger !== null, "[36] 触发器依然渲染（入口不能因为环境缺东西就消失）");
  trigger.fire("onClick", {});
  await settle();
  ok(scene.react.find("picker-panel") !== null, "[36] 面板照常能打开");
}
/* ══════════════════════════════════════════════════════════════════════ */

section("37. 审核回归：死区 / 星空宽度 / 样式标记 / slow 规则 / 目录换实例 / 陈旧弹层");
{
  /*
   * 这一节全部来自一次逐行审核（每条都在真产物上复现过）。共同点是：
   * **694 项全绿却漏掉了它们** —— 因为旧断言只覆盖了"正档位点起拖""星尘有 22 个子节点"
   * "标记是非空字符串"这些形状，没有进冲突带、没有查宽度、没有校验标记内容。
   */
  const W = 300;

  // ── #1a 冲突带按下时的死区（照搬 1.2.0 那半边的 [17b] 用例到面板上）──────────
  {
    const scene = await setupPicker();
    const { react, internals } = scene;
    const TR = internals.picker.TR;
    await scene.toggle();
    const xOf = (u) => TR + (u / 3) * (W - 2 * TR); // 4 档 → u ∈ [0, 3]
    const effort = () => String(react.find("picker-effort-value").textContent);
    const slider = () => scene.slider(0, W);

    slider().fire("onPointerDown", { clientX: xOf(1.4), pointerId: 1 });
    await settle();
    eq(effort(), "Low", "[37] 冲突带按下（u=1.4）→ 取最近档 Low");
    slider().fire("onPointerMove", { clientX: xOf(1.4), pointerId: 1 });
    await settle();
    eq(effort(), "Low", "[37] 指针原地不动 → 死区挡住多跳");
    slider().fire("onPointerMove", { clientX: xOf(1.6), pointerId: 1 });
    await settle();
    eq(effort(), "Low", "[37] 只离开按下点 0.2 档距 → 仍不切档");
    slider().fire("onPointerMove", { clientX: xOf(1.8), pointerId: 1 });
    await settle();
    eq(effort(), "High", "[37] 离开超过 1/3 档距 → 解锁并切到第 3 档");
    slider().fire("onPointerUp", {});
    await settle();
  }

  // ── #1b 真机挂掉的那条：从冲突带起手，**整段右拖**原本一格都不动 ──────────────
  {
    const scene = await setupPicker();
    const { react, internals } = scene;
    const TR = internals.picker.TR;
    await scene.toggle();
    const xOf = (u) => TR + (u / 3) * (W - 2 * TR);
    const effort = () => String(react.find("picker-effort-value").textContent);
    const slider = () => scene.slider(0, W);

    slider().fire("onPointerDown", { clientX: xOf(0.4), pointerId: 1 }); // 落在冲突带 (1/3, 1/2)
    await settle();
    eq(effort(), "Off", "[37] 按 u=0.40 → Off（最近档）");

    const seen = [];
    for (const u of [0.5, 1.0, 2.0, 2.8]) {
      slider().fire("onPointerMove", { clientX: xOf(u), pointerId: 1 });
      await settle();
      seen.push(effort());
    }
    eq(
      seen.join(","),
      "Off,Low,High,Max",
      "[37] 从冲突带右拖逐格跟手（修复前：整段无效，一直停在 Off）",
    );
    slider().fire("onPointerUp", {});
    await settle();
    eq(scene.host.selects.length, 1, "[37] 松手落地一次");
    eq(scene.host.selects[0].reasoningEffort, "max", "[37] 写到 max（不再把旧档位写回宿主）");
  }

  // ── #2 星空层必须自己有宽度，否则 22 颗星被 overflow:hidden 全裁掉 ─────────────
  {
    const scene = await setupPicker();
    const { react } = scene;
    await scene.toggle();
    const stars = react.find("picker-stars");
    ok(
      typeof stars.style.width === "string" && stars.style.width.length > 0,
      "[37] 星空层带宽度（修复前 style = {}，shrink-to-fit 为 0 → 星全被裁）",
    );
    eq(stars.style.width, react.find("picker-fill").style.width, "[37] 宽度与填充层一致（星尘从当前档位点向右横穿）");
    const sized = react.findAll("picker-star").filter((n) => typeof n.style.width === "string" && n.style.width.length > 0);
    eq(sized.length, 22, "[37] 22 颗星各自都有尺寸");
  }

  // ── #3 样式标记必须带包命名空间（修复前是 "undefined/picker"）─────────────────
  {
    const scene = await setupPicker();
    const api = internalsOf(scene.bundle);
    eq(api.PICKER_STYLE_MARKER, "better-dsh-codex-effort-slider/picker", "[37] 标记 = <包名>/picker（不是 undefined/picker）");
    const markers = scene.document.head.querySelectorAll("style").map((t) => t.getAttribute("data-plugin-css"));
    eq(markers.indexOf("undefined/picker"), -1, "[37] 文档里不存在 undefined/ 前缀的标记");
    ok(markers.indexOf("better-dsh-codex-effort-slider/picker") >= 0, "[37] 浮层样式用的是带包名的标记（去重不会误撞别人的样式表）");
  }

  // ── #4 快/慢档：data-slide 得有对应规则，否则那一整套是死代码 ─────────────────
  {
    const scene = await setupPicker();
    const css = internalsOf(scene.bundle).PICKER_CSS;
    const { SLIDE_FAST, SLIDE_SLOW } = scene.internals.picker;
    ok(
      css.indexOf(".cxp[data-slide='slow']{--cxp-slide:") > 0,
      "[37] 样式表里有 slow 档规则（修复前全仓库只有默认关闭的 .ces- 那一半有）",
    );
    ok(css.indexOf("--cxp-slide:" + SLIDE_SLOW) > 0, "[37] slow 档用的就是 SLIDE_SLOW");
    ok(css.indexOf("--cxp-slide:" + SLIDE_FAST) > 0, "[37] 默认仍是 SLIDE_FAST");
  }

  // ── #5 宿主重建目录实例后，读路径必须跟着换（否则界面冻在旧档位表上）──────────
  {
    const scene = await setupPicker();
    const { react, host } = scene;
    await scene.toggle();
    eq(react.findAll("picker-tick").length, 4, "[37] 初始：4 档模型 → 4 个刻度");

    const makeDirectory = (modelId, levelIds) => {
      const snap = snapshotOf({
        groups: [{ id: "deepseek", name: "DeepSeek", models: [{
          id: modelId, name: modelId,
          reasoning: { defaultEffort: levelIds[0], efforts: levelIds.map((id) => ({ id, name: id.toUpperCase() })) },
        }] }],
        model: modelId,
        effort: levelIds[0],
      });
      const store = createStore(snap);
      return { store, snap, directory: { store, load: async () => store.getSnapshot(), select: async () => ({ ok: true, value: undefined }) } };
    };

    // (a) 心跳兜底：面板一直开着，宿主在背后换了实例 —— 旧实例不会再推送，只能靠主动复查
    const six = makeDirectory("swapped-six", ["a", "b", "c", "d", "e", "f"]);
    host.swapDirectory(six.directory);
    six.store.set(six.snap);
    await wait(1800); // 越过 DIRECTORY_HEARTBEAT_MS(1500)
    await settle();
    eq(react.findAll("picker-tick").length, 6, "[37] 心跳复查：面板开着时宿主换实例，界面自动跟上（原本永久冻住）");

    // (b) 打开面板时复查：换实例后**重新打开**就该用新档位表（不必等心跳）
    const three = makeDirectory("swapped-three", ["x", "y", "z"]);
    host.swapDirectory(three.directory);
    three.store.set(three.snap);
    await scene.toggle(); // 关
    await scene.toggle(); // 开 → 触发 access.refresh()
    await settle();
    eq(react.findAll("picker-tick").length, 3, "[37] 打开面板时复查：换实例后重开即用新的 3 档表");
    ok(String(react.find("picker-effort-value").textContent).length > 0, "[37] 档位名也跟着更新");
  }

  // ── #7 滚动不再关面板（1.3.4）；真正关闭的那两条路（Esc / 外点）仍要连档位弹层一起收 ──
  {
    const scene = await setupPicker();
    const { react, document } = scene;
    await scene.toggle();
    react.find("picker-more").fire("onClick", {});
    await settle();
    eq(react.findAll("picker-pop").length, 1, "[37] 档位弹层打开");

    // 1.3.4：滚动只是重定位 —— 面板与弹层都该留着（旧的"滚动即关闭"会在流式输出时把面板关掉）
    document.dispatch("scroll", {});
    await settle();
    ok(react.find("picker-panel-root") !== null, "[37] 滚动**不再**关闭面板（1.3.4 起只重定位）");
    eq(react.findAll("picker-pop").length, 1, "[37] 档位弹层也跟着留着（同一次交互里不该被拆开）");

    // 真正关闭的那两条路（Esc / 外点）必须把 `popOpen` 一起复位，
    // 否则重开会按旧坐标冒出陈旧弹层、且第一次点「更多」反而是把它关掉
    document.dispatch("keydown", { key: "Escape" });
    await settle();
    eq(react.findAll("picker-pop").length, 0, "[37] Esc：先收弹层");
    document.dispatch("keydown", { key: "Escape" });
    await settle();
    eq(react.find("picker-panel-root"), null, "[37] 再按一次 Esc：面板关闭");

    await scene.toggle();
    eq(react.findAll("picker-pop").length, 0, "[37] 重开后没有陈旧弹层");
    react.find("picker-more").fire("onClick", {});
    await settle();
    eq(react.findAll("picker-pop").length, 1, "[37] 重开后点「更多」是**打开**它（而不是把它关掉）");
  }
}

section("38. 主题一致性：滑条旋钮在浅色与深色下都是同一颗白球");
{
  /*
   * 真机反馈：**深色模式下旋钮变深了**。根因是它当时写的是
   * `background: var(--dsw-alias-bg-layer-1, #fff)` —— 而该令牌在深色主题下本身就是深色
   * （兜底值 `#232329` 正说明了它的意图），于是旋钮成了一颗深色球、与深色轨道糊在一起。
   *
   * 旋钮是"可拖动的把手"，两种主题下都该是同一颗白球：1.2.0 的 `.ces-knob`
   * 写的就是 `background:#fff`，这份自建面板对齐它。
   */
  const scene = await setupPicker();
  const internals = internalsOf(scene.bundle);
  const rule = /\.cxp-knob\{([^}]*)\}/.exec(internals.PICKER_CSS);
  ok(rule !== null, "[38] 样式表里有 .cxp-knob 规则");
  const body = rule === null ? "" : rule[1];
  ok(body.indexOf("background:#fff") >= 0, "[38] 旋钮用**固定白**（background:#fff）");
  eq(
    /background:\s*var\(/.test(body),
    false,
    "[38] 旋钮背景不再跟随主题令牌（跟随的话深色下会变成深色球）",
  );
  ok(body.indexOf("border-radius:50%") >= 0, "[38] 仍是正圆");
  ok(body.indexOf("box-shadow") >= 0, "[38] 保留投影（白球落在浅色轨道上也有边界）");

  // 与 1.2.0 那半边保持一致：两边都是固定白
  const cesRule = /\.ces-knob\{([^}]*)\}/.exec(internals.CSS);
  ok(cesRule !== null, "[38] 1.2.0 那半边也有 .ces-knob 规则");
  ok(cesRule !== null && cesRule[1].indexOf("background:#fff") >= 0, "[38] 它的旋钮同样是固定白（两侧写法一致）");

  /*
   * 星尘同理，而且是**用户实测反馈**："浅色模式的星尘颜色不对，深浅主题下星尘都要是浅色"。
   *
   * 根因：星尘永远飘在**填充层**上（蓝→紫，那套颜色本来就是写死的、不随主题变），
   * 而旧写法 `background:var(--dsw-alias-label-primary,#eaf0ff)` 在浅色主题下取到的是**近黑色**
   * —— 深色小点糊在紫底上，几乎看不见。现在写死浅色（外加一圈固定微光）。
   */
  const starRule = /\.cxp-star\{([^}]*)\}/.exec(internals.PICKER_CSS);
  ok(starRule !== null, "[38] 样式表里有 .cxp-star 规则");
  const starBody = starRule === null ? "" : starRule[1];
  ok(starBody.indexOf("background:#eaf0ff") >= 0, "[38] 星尘是**固定浅色**（#eaf0ff），不再跟随主题令牌");
  eq(
    /background:\s*var\(/.test(starBody),
    false,
    "[38] 星尘底色不是主题令牌（跟随的话浅色主题下会变成深色小点）",
  );
  ok(starBody.indexOf("box-shadow") >= 0, "[38] 星尘带一圈固定微光（浅色主题下也保证是亮的）");

  /*
   * 面板材料：**官方口径的毛玻璃 + 浅色下看得见的阴影**（1.3.9 的用户反馈：
   * "浅色主题时面板跟背景颜色相似，周围加一层阴影吧，官方的毛玻璃（微微透）的效果也要"）。
   *
   * 三条都照官方产物核对过：
   *   · 模糊 = `--dsw-menu-backdrop-filter`（官方主题定义在 `body` 上：`blur(40px) saturate(150%)`，
   *     自定义属性会继承，所以我们的面板取得到；字面值原样写进兜底）；
   *   · 半透明底 —— 模糊只在"底是半透明"时看得见，所以**不能**用不透明的 `--dsw-alias-bg-layer-1`；
   *   · 阴影 —— 官方 `--dsw-elevation-prominent` 只有 4%~5% alpha，浅色页面上几乎看不见，
   *     所以叠 `--dsw-shadow-lv3` 再补一层落地阴影；深色主题另给一套。
   */
  const panelRule = /\.cxp-panel\{([^}]*)\}/.exec(internals.PICKER_CSS);
  ok(panelRule !== null, "[38] 样式表里有 .cxp-panel 规则");
  const panelBody = panelRule === null ? "" : panelRule[1];
  ok(
    panelBody.indexOf("backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%))") >= 0,
    "[38] 面板用**官方菜单材料**的模糊令牌（兜底值就是官方字面值 blur(40px) saturate(150%)）",
  );
  ok(panelBody.indexOf("-webkit-backdrop-filter:") >= 0, "[38] 同时给 -webkit- 前缀（老 WebKit 只认它）");
  ok(
    panelBody.indexOf("background:var(--cxp-glass") >= 0,
    "[38] 面板底走**半透明**的 `--cxp-glass`（不透明底上看不见模糊）",
  );
  ok(panelBody.indexOf("box-shadow:var(--cxp-shadow") >= 0, "[38] 阴影走 `--cxp-shadow`（按主题分档）");

  // 两套变量本身：浅色必须真的"微微透"，且深浅两套阴影不同
  const lightVars = /\.cxp\{([^}]*--cxp-glass[^}]*)\}/.exec(internals.PICKER_CSS);
  const darkVars = /body\[data-ds-dark-theme\] \.cxp\{([^}]*)\}/.exec(internals.PICKER_CSS);
  ok(lightVars !== null, "[38] 浅色那套玻璃变量在 `.cxp` 上");
  ok(darkVars !== null, "[38] 深色那套挂在 `body[data-ds-dark-theme] .cxp` 下（面板 portal 到 body，命中得到）");
  const glassOf = (text) => (/--cxp-glass:([^;]+)/.exec(text || "") || [])[1] || "";
  const shadowOf = (text) => (/--cxp-shadow:([^;]+)/.exec(text || "") || [])[1] || "";
  const lightGlass = glassOf(lightVars && lightVars[1]);
  const darkGlass = glassOf(darkVars && darkVars[1]);
  const alphaOf = (text) => parseFloat((/,\s*([\d.]+)\)/.exec(text) || [])[1] || "1");
  /*
   * 底：**保留官方色相、比官方再透一档**（用户实测："再透一点"）。
   *
   * 官方菜单填充令牌 `--dsw-menu-surface-fill` 是浅色 `#f8f9fa94`（alpha .58）、
   * 深色 `#43454a73`（alpha .45）；我们取同色相的 `.46` / `.40`。
   * 为什么不用 `color-mix()` 把官方令牌调淡：那要引擎支持，不支持时整条声明失效 →
   * 面板会变成**没有底色**（比"不够透"糟得多）；写死 rgba 永远成立。
   */
  ok(lightGlass.indexOf("rgba(248,249,250,") === 0, `[38] 浅色底 = 官方色相 #f8f9fa 的 rgba：${lightGlass}`);
  ok(darkGlass.indexOf("rgba(67,69,74,") === 0, `[38] 深色底 = 官方色相 #43454a 的 rgba：${darkGlass}`);
  ok(alphaOf(lightGlass) < 1, `[38] 浅色 alpha < 1（半透明才看得见毛玻璃）：${alphaOf(lightGlass)}`);
  ok(alphaOf(darkGlass) < 1, `[38] 深色 alpha < 1：${alphaOf(darkGlass)}`);
  ok(
    alphaOf(lightGlass) <= 0.5 && alphaOf(darkGlass) <= 0.5,
    `[38] 比官方填充令牌(.58/.45)再透一档（用户要求"再透一点"）：${alphaOf(lightGlass)}/${alphaOf(darkGlass)}`,
  );
  ok(darkGlass !== lightGlass, "[38] 深浅两套底色不同");
  // 卡片也不能是不透明的：它盖住面板 2/3 面积，实心就把毛玻璃抵消了
  const cardOf = (text) => (/--cxp-panel-2:([^;]+)/.exec(text || "") || [])[1] || "";
  ok(/^rgba\(/.test(cardOf(lightVars && lightVars[1])), `[38] 推理等级卡片是半透明的（浅色）：${cardOf(lightVars && lightVars[1])}`);
  ok(/^rgba\(/.test(cardOf(darkVars && darkVars[1])), `[38] 深色卡片也一样：${cardOf(darkVars && darkVars[1])}`);
  ok(
    shadowOf(lightVars && lightVars[1]).indexOf("--dsw-shadow-lv3") >= 0,
    "[38] 浅色阴影叠了官方的 --dsw-shadow-lv3（单靠 elevation-prominent 在浅色下几乎看不见）",
  );
  ok(
    shadowOf(lightVars && lightVars[1]) !== shadowOf(darkVars && darkVars[1]),
    "[38] 深色另给一套阴影（浅色那套在深底上没有存在感）",
  );
  ok(
    /\.cxp-pop\{[^}]*backdrop-filter:var\(--dsw-menu-backdrop-filter/.test(internals.PICKER_CSS),
    "[38] 档位弹层与面板同一种材料（官方菜单都是这么做的）",
  );
}

section("39. 多会话：每个会话各一颗按钮、面板按归属显示（删全局守卫的核心回归钉）");
{
  /*
   * 这一节是"守卫是误诊产物"的**区分性**测试：旧的两个全局布尔 `PICKER_TRIGGER_LIVE` /
   * `PICKER_SURFACE_LIVE` 是**渲染阶段** claim 的，跨会话切换时会被旧实例占住，
   * 于是第二个会话的按钮渲染成 null —— 下面第一条断言在旧实现下**必 FAIL**。
   *
   * 真因回看：当初"两颗按钮"是 `ENTRY_ID`（order 40）与 trigger（order 30）**两条条目都挂在
   * `conversation.input.right`**；`ENABLE_OFFICIAL_MENU_SLIDER = false` 关掉前者后已根治。
   */
  const scene = await setupMultiSession(["s1", "s2"]);
  const { react } = scene;

  // a. 两个会话**各有一颗**按钮（旧守卫下第二颗是 null）
  eq(react.findAll("picker-trigger").length, 2, "[39] 两个会话各有一颗按钮（旧全局守卫下第二颗会被拒成 null）");
  eq(react.findAll("picker-panel-root").length, 0, "[39] 初始没有任何面板");

  // b. 点 s1 → 只有 s1 的面板、s1 展开
  react.findAll("picker-trigger")[0].fire("onClick", {});
  await settle();
  eq(react.findAll("picker-panel-root").length, 1, "[39] 点 s1 后只出一块面板");
  eq(react.findAll("picker-trigger")[0].getAttribute("aria-expanded"), "true", "[39] s1 按钮展开");
  eq(react.findAll("picker-trigger")[1].getAttribute("aria-expanded"), "false", "[39] s2 按钮仍收起");

  // c. 点 s2 → 面板**换到** s2、s1 收起（而不是"只把 s1 关掉"）
  react.findAll("picker-trigger")[1].fire("onClick", {});
  await settle();
  eq(react.findAll("picker-panel-root").length, 1, "[39] 面板始终只有一块（不会两块并存）");
  eq(react.findAll("picker-trigger")[0].getAttribute("aria-expanded"), "false", "[39] 面板换走后 s1 收起");
  eq(react.findAll("picker-trigger")[1].getAttribute("aria-expanded"), "true", "[39] s2 展开（旧逻辑这里只会把 s1 关掉）");

  // d. 点 s2 自己的按钮 → 真正收起
  react.findAll("picker-trigger")[1].fire("onClick", {});
  await settle();
  eq(react.findAll("picker-panel-root").length, 0, "[39] 点自己的按钮收起面板");

  // e. 卸载后重新挂载：两颗照常出现（不需要任何"重建才能 claim"的仪式）
  await scene.remount();
  eq(react.findAll("picker-trigger").length, 2, "[39] 卸载后重挂：两颗按钮照常出现");
  react.findAll("picker-trigger")[0].fire("onClick", {});
  await settle();
  eq(react.findAll("picker-panel-root").length, 1, "[39] 重挂后仍然点得开面板");
}

section("40. 面板归属：开着面板切走再切回，面板跟着会话走");
{
  /*
   * 这是"按会话归属"带来的**新语义**（原来是一处跨会话状态泄漏：A 开着面板切到 B，
   * B 也看得到面板）。现在面板属于打开它的那个会话：
   *   · A 开着面板 → 切到 B（A 被卸载）→ B 不该有面板
   *   · 再切回 A → 面板**还在**（归属存在 store 里，不随组件卸载丢失）
   * 这是有意选择，不是"卸载即 close"。
   */
  const scene = await setupMultiSession(["sA", "sB"]);
  const { react } = scene;

  react.findAll("picker-trigger")[0].fire("onClick", {});
  await settle();
  eq(react.findAll("picker-panel-root").length, 1, "[40] A 打开了面板");

  await scene.mountOnly(["sB"]); // 切到 B
  eq(react.findAll("picker-trigger").length, 1, "[40] 切到 B：B 有自己的按钮");
  eq(react.findAll("picker-panel-root").length, 0, "[40] B 看不到 A 的面板（原来的跨会话泄漏就在这）");
  eq(react.findAll("picker-trigger")[0].getAttribute("aria-expanded"), "false", "[40] B 的按钮是收起的");

  await scene.mountOnly(["sA"]); // 切回 A
  eq(react.findAll("picker-panel-root").length, 1, "[40] 切回 A：面板还在（归属在 store 里，不随卸载丢失）");
  eq(react.findAll("picker-trigger")[0].getAttribute("aria-expanded"), "true", "[40] A 的按钮也回到展开态");

  // B 在自己的会话里依然能正常开合（归属切换不影响各自的开关）
  await scene.mountOnly(["sB"]);
  react.findAll("picker-trigger")[0].fire("onClick", {});
  await settle();
  eq(react.findAll("picker-panel-root").length, 1, "[40] B 展开时 A 的面板被顶掉（owner 换人）");
}

/* ══════════════════════════════════════════════════════════════════════ */

section("41. 二级页模型列表：按「新发布 → 旧发布」排序");
{
  /*
   * **宿主目录里没有发布日期字段** —— 这不是猜的：`session/modelCatalog` 的产物 schema
   * （`dsh-api-session-controller/lib/typert.host.js`）里模型条目只有
   * `{ id, name, description?, reasoning? }`。所以"新 → 旧"只能从 id / name 里算，
   * 断言也就必须分两层：
   *   · 纯函数层：版本号 / 日期 / 快照版 三种信号各自的规则；
   *   · 真目录形状层：DeepSeek 的 `deepseek-flash`（**版本号只在显示名里**，
   *     见 `dsh-llm-deepseek` 的 DEFAULT_MODELS）与 OpenAI 的 `gpt-4o-2024-05-13`
   *     这类**钉住的快照版**（见 `pi-ai/dist/providers/data/openai.json`）都排对。
   */
  const scene = await setupPicker();
  const { react, picker } = scene;
  const ids = (list) => picker.sortModelsNewestFirst(list).map((model) => model.id);
  /** 二级页某一行显示的模型名（`cxp-model__name` 里第一段 span）。 */
  const names = () => react.findAll("picker-model")
    .map((node) => String(node.children[0].children[0].textContent));
  const enterProvider = async (index) => {
    react.findAll("picker-provider")[index].fire("onClick", {});
    await settle();
  };

  // ── 纯函数：版本号 ─────────────────────────────────────────────────
  eq(
    ids([{ id: "gpt-4o" }, { id: "gpt-5.6-sol" }, { id: "gpt-6-astra" }]).join(","),
    "gpt-6-astra,gpt-5.6-sol,gpt-4o",
    "[41] 版本号降序：6 → 5.6 → 4",
  );
  eq(
    ids([{ id: "b", name: "DeepSeek-V4-Pro" }, { id: "a", name: "DeepSeek-V41-Flash" }]).join(","),
    "a,b",
    "[41] id 里没有版本号时改看 **name**（真目录的 deepseek-flash 就是这种形状）",
  );
  eq(
    ids([{ id: "m-5.9" }, { id: "m-5.10" }]).join(","),
    "m-5.10,m-5.9",
    "[41] 版本号按**数字**逐段比，不是字典序（5.10 > 5.9）",
  );
  eq(
    ids([{ id: "gpt-6-astra-2025-11-20" }, { id: "gpt-6-astra" }, { id: "gpt-6-astra-2026-01-13" }]).join(","),
    "gpt-6-astra,gpt-6-astra-2026-01-13,gpt-6-astra-2025-11-20",
    "[41] 别名在前、它的快照版在后；同为快照则日期新的在前",
  );
  eq(
    ids([{ id: "plain-model" }, { id: "gpt-6-astra" }, { id: "another-plain" }]).join(","),
    "gpt-6-astra,plain-model,another-plain",
    "[41] 认不出版本号的沉底，且内部保持宿主原顺序",
  );
  eq(
    ids([{ id: "x-1-b" }, { id: "x-1-a" }]).join(","),
    "x-1-b,x-1-a",
    "[41] 排序键完全相同 → 稳定（保持宿主原顺序，不抖动）",
  );
  const untouched = [{ id: "gpt-4o" }, { id: "gpt-6-astra" }];
  picker.sortModelsNewestFirst(untouched);
  eq(untouched.map((model) => model.id).join(","), "gpt-4o,gpt-6-astra", "[41] 不修改传入的数组");
  eq(picker.sortModelsNewestFirst(null).length, 0, "[41] 非法入参返回空数组（fail-open）");

  // ── 纯函数：两个信号的解析 ──────────────────────────────────────────
  eq(JSON.stringify(picker.versionRankOf("gpt-5.6-sol")), "[5,6]", "[41] 版本号解析：5.6 → [5,6]");
  eq(JSON.stringify(picker.versionRankOf("deepseek-v41-flash")), "[41]", "[41] 版本号解析：v41 → [41]");
  eq(picker.versionRankOf("plain-model"), null, "[41] 没有数字 → 认不出版本号");
  eq(JSON.stringify(picker.versionRankOf("gpt-4o-2024-05-13")), "[4]", "[41] 日期片段不会被当成版本号");
  eq(picker.dateRankOf("gpt-4o-2024-05-13"), 20240513, "[41] 日期解析：2024-05-13 → 20240513");
  eq(picker.dateRankOf("claude-20260301"), 20260301, "[41] 日期解析：8 位紧凑写法");
  eq(picker.dateRankOf("gpt-6-astra"), 0, "[41] 没有日期 → 0");

  // ── 集成：测试台目录（DeepSeek + OpenAI）────────────────────────────
  await scene.toggle();
  await enterProvider(0); // DeepSeek
  eq(
    names().join(" | "),
    "DeepSeek-V41-Flash | DeepSeek-V41-Pro | Plain Model",
    "[41] DeepSeek 页：两个 v41 在前、认不出版本号的 Plain Model 沉底（宿主原顺序是 flash / Plain / pro）",
  );

  await enterProvider(1); // OpenAI
  eq(
    names().join(" | "),
    "gpt-6-astra | gpt-6-luna | gpt-6-spark | gpt-6-astra-2026-01-13 | gpt-4o",
    "[41] OpenAI 页：同版本保持宿主顺序，快照版排在自己的别名之后，gpt-4o 沉到 6 后面",
  );

  react.find("picker-search").fire("onChange", { target: { value: "gpt-6" } });
  await settle();
  eq(
    names().join(" | "),
    "gpt-6-astra | gpt-6-luna | gpt-6-spark | gpt-6-astra-2026-01-13",
    "[41] 搜索过滤后跟着同一个顺序（排序在 readCatalog 里做了一次，过滤不会打乱它）",
  );

  // ── 集成：照真目录的形状（DeepSeek 账号 provider）────────────────────
  const realScene = await setupPicker({
    host: {
      snapshot: snapshotOf({
        groups: [{
          id: "deepseek-account",
          name: "DeepSeek",
          models: [
            { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
            { id: "deepseek-flash", name: "DeepSeek-V41-Flash" },
          ],
        }],
      }),
    },
  });
  await realScene.toggle();
  realScene.react.findAll("picker-provider")[0].fire("onClick", {});
  await settle();
  eq(
    realScene.react.findAll("picker-model").map((node) => String(node.children[0].children[0].textContent)).join(" | "),
    "DeepSeek-V41-Flash | DeepSeek-V4-Pro",
    "[41] 真目录形状：deepseek-flash（V41，版本号只在 name 里）排在 deepseek-v4-pro 之前",
  );

  // ── 集成：OpenAI 真目录里的「别名 + 钉住的快照版」─────────────────────
  const snapScene = await setupPicker({
    host: {
      snapshot: snapshotOf({
        groups: [{
          id: "openai",
          name: "OpenAI",
          models: [
            { id: "gpt-4o-2024-05-13", name: "GPT-4o (2024-05-13)" },
            { id: "gpt-4o-2024-11-20", name: "GPT-4o (2024-11-20)" },
            { id: "gpt-4o", name: "GPT-4o" },
            { id: "gpt-5.5", name: "GPT-5.5" },
          ],
        }],
      }),
    },
  });
  await snapScene.toggle();
  snapScene.react.findAll("picker-provider")[0].fire("onClick", {});
  await settle();
  eq(
    snapScene.react.findAll("picker-model").map((node) => String(node.children[0].children[0].textContent)).join(" | "),
    "GPT-5.5 | GPT-4o | GPT-4o (2024-11-20) | GPT-4o (2024-05-13)",
    "[41] 真目录形状：gpt-5.5 → gpt-4o → 它的两个快照版（日期新 → 旧）",
  );
}

/* ══════════════════════════════════════════════════════════════════════ */

section("42. 接管官方模型席（priority −1 遮蔽）+ 退路 + locked / 紧凑态");
{
  /*
   * 真内核（`@deepseek-ai/dsh-client-ui-slots`）对 **single 槽**的规则：
   *   · 同 priority 重复注册 → **抛错**，报错文案就是给的解法："register at a different priority
   *     to shadow it (**lowest renders**)"；
   *   · `entriesOfSlot` 按 priority 升序取每格第一个 → **最低者渲染**。
   * 官方那颗席按钮注册在 `conversation.input.model`、**没写 priority（= 0）**，
   * 所以我们用 −1 就整颗遮蔽它 —— 一行官方 DOM 都不用碰。
   */

  // ── 遮蔽：先摆一条"官方席"（priority 0），再看谁会被渲染 ────────────────
  {
    const official = function OfficialSeat() { return null; };
    const scene = await setupPicker({
      beforeApply: (host) => {
        host.ctx.slots.register({ name: "conversation.input.model", locale: "ns" }, official);
      },
    });
    const { host } = scene;

    eq(host.registered.length, 3, "[42] 账本里三条：官方席 + 我们的触发器 + 面板（官方那条**没被踢掉**）");
    const officialEntry = host.registered.find((item) => item.Component === official);
    ok(officialEntry !== undefined, "[42] 官方席仍在账本里（遮蔽 ≠ 删除：它的 effect 归官方管）");
    eq(officialEntry.opts.priority ?? 0, 0, "[42] 官方那条没写 priority → 视作 0（真产物就是没写）");

    const head = host.slotHead("conversation.input.model");
    ok(head !== null && head.opts.id === "codex-picker-trigger", "[42] 这一格**实际渲染的是我们这条**（优先级更低者胜）");
    eq(head.opts.priority, -1, "[42] 靠 priority −1 赢的（0 < −1 不成立，−1 才排在前面）");
    eq(host.slotHead("conversation.input.right"), null, "[42] 接管成功 → input.right 那一格空着（不会出现第二颗按钮）");
    eq(
      Object.prototype.hasOwnProperty.call(host.registered.find((i) => i.opts.id === "codex-picker-trigger").opts, "priority"),
      true,
      "[42] priority 真的传进了注册选项（内核只认这个字段）",
    );
  }

  // ── 退路 1：那个槽**根本没被声明** → 等它，同时注册到工具行 ──────────────
  {
    const scene = await setupPicker({
      host: { declaredSlots: ["conversation.input.right", "conversation.input.overlay"] },
    });
    const { host } = scene;
    const trigger = host.registered.find((item) => item.opts.id === "codex-picker-trigger");
    ok(trigger !== undefined, "[42] 模型席不存在时触发器照样出现（fail-open）");
    eq(trigger.opts.name, "conversation.input.right", "[42] 退回老位置：工具行（与官方那颗并排）");
    eq(trigger.opts.priority, undefined, "[42] 退路不带 priority（那个槽是 list 槽，不需要抢）");
    eq(trigger.opts.order, scene.internals.PICKER_TRIGGER_ORDER, "[42] 退路保留 order 30");
    eq(host.pendingInjections.join(","), "conversation.input.model", "[42] 仍在等模型席出现（真宿主的 inject 就是不抛、只等）");

    // 槽姗姗来迟：这时要**接管并从工具行撤走**，账本里始终只有一条触发器
    host.declareSlot("conversation.input.model");
    const triggers = host.registered.filter((item) => item.opts.id === "codex-picker-trigger");
    eq(triggers.length, 1, "[42] 接管之后账本里**只剩一条**触发器（工具行那条被撤掉了）");
    eq(triggers[0].opts.name, "conversation.input.model", "[42] 落点变成了官方模型席那一格");
    eq(triggers[0].opts.priority, -1, "[42] 依然是 priority −1 抢下来");
    eq(host.slotHead("conversation.input.right"), null, "[42] 工具行那一格空了（不会留成第二颗按钮）");
  }

  // ── 退路 2：槽**已声明但注册抛错**（契约变了 / 被人以同优先级占了）→ 退回工具行 ──
  {
    const scene = await setupPicker({
      beforeApply: (host) => {
        // 摆一条**同优先级**的：我们的 −1 注册会撞上它 → 抛错 → 必须走退路
        host.ctx.slots.register({ name: "conversation.input.model", priority: -1 }, function Rival() { return null; });
      },
    });
    const { host } = scene;
    const ours = host.registered.find((item) => item.opts.id === "codex-picker-trigger");
    ok(ours !== undefined, "[42] 注册抛错后触发器仍然存在（退路生效，入口没消失）");
    eq(ours.opts.name, "conversation.input.right", "[42] 抛错 → 退回工具行");
    eq(
      host.registered.filter((item) => item.opts.id === "codex-picker-trigger" && item.opts.name === "conversation.input.model").length,
      0,
      "[42] 失败的那条没有半途留在账本里",
    );
  }

  // ── locked：那个槽的 owner prop，接管之后必须跟着接过来 ──────────────────
  {
    const free = await setupPicker();
    await free.toggle();
    eq(free.trigger().getAttribute("data-locked"), "0", "[42] 未锁定：data-locked=0");
    eq(free.trigger().getAttribute("disabled"), null, "[42] 未锁定：按钮不是 disabled");
    eq(free.react.find("picker-panel-root") !== null, true, "[42] 未锁定：点得开面板");

    const lockedScene = await setupPicker({ props: { locked: true } });
    const lockedTrigger = lockedScene.trigger();
    eq(lockedTrigger.getAttribute("data-locked"), "1", "[42] locked 传进来后 data-locked=1");
    eq(lockedTrigger.getAttribute("disabled"), "", "[42] locked → 真 disabled（浏览器层面就点不动）");
    eq(lockedTrigger.getAttribute("aria-disabled"), "true", "[42] locked 也进了无障碍树");
    ok(String(lockedTrigger.getAttribute("title")).indexOf("当前不可切换") > 0, "[42] 悬浮说明如实说明为什么点不动");
    lockedTrigger.fire("onClick", {});
    await settle();
    eq(lockedScene.react.find("picker-panel-root"), null, "[42] locked 时点击不开面板");
  }

  // ── 紧凑态：跟着行上的两个 CSS 变量走（官方席就是这么切成纯图标的）──────
  {
    const scene = await setupPicker();
    const trigger = scene.trigger();
    const iconNode = scene.react.find("picker-trigger-icon");
    ok(iconNode !== null, "[42] 触发器里有一颗自绘图标（紧凑态用）");
    const css = scene.internals.PICKER_CSS;
    ok(
      css.indexOf("--dsh-composer-model-icon-display") > 0 && css.indexOf("--dsh-composer-model-text-display") > 0,
      "[42] 样式表读行上那两个变量（不读的话窄输入行里我们这颗会硬撑文字、把提交键挤出去）",
    );
    ok(String(trigger.getAttribute("class")).indexOf("cxp-trigger") >= 0, "[42] 触发器仍然是 .cxp-trigger（观感不变）");
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

section("43. 真机事故：接管官方席之后「目录空」没人治 → 面板一片空白（1.3.3）");
{
  /*
   * 现场（用户重启 DSH 之后的截图）：按钮只写"模型"、面板里「模型」标题下面**一个字都没有**、
   * 推理等级是 `—`、滑条灰掉。三件事叠在一起：
   *   1. 目录是空的（provider 一个都没列出来）—— 要么启动期宿主还没注册完 provider 就返回了
   *      一个"合法的空目录"（`buildModelCatalog()` 只列当前已注册的 provider），要么 load 失败；
   *   2. 那句"没有可用的 provider / 正在读取…"**被视口裁掉了**（44px 装不下 48px 的提示句）；
   *   3. 1.3.2 之前官方那颗席按钮也在渲染，它至少是另一个"再 load 一次"的入口；
   *      接管之后我们是唯一的读取方 —— 没人重试，错误状态就永远停在那儿。
   *
   * 这一节把三条各自钉住：提示必须看得见、load 失败会自愈、"就绪但空"会主动刷全局目录。
   */

  // ── #1 空目录：提示句必须真的落在视口里（不再被裁）─────────────────────
  const emptySnapshot = (failures = []) => ({
    current: null, groups: [], failures, status: "ready", pending: null, error: null,
  });
  {
    const scene = await setupPicker({
      host: { snapshot: emptySnapshot() },
    });
    const { react, picker, internals } = scene;
    const catalog = picker.readCatalog(emptySnapshot());
    await scene.toggle();

    const empty = react.find("picker-empty");
    ok(empty !== null, "[43] 空目录时那句提示真的渲染出来了");
    eq(String(empty.textContent), "宿主没有列出任何 provider", "[43] 文案点明「宿主没列 provider」（而不是一片空白）");
    eq(empty.getAttribute("data-phase"), "empty", "[43] 并且标明这是**宿主侧**的空（phase=empty，不是我们没拿到）");
    ok(
      String(empty.getAttribute("title")).indexOf("DSH 的模型") >= 0,
      "[43] 悬浮说明指向该去查的地方（DSH 的模型/账号设置）",
    );

    const viewport = react.find("picker-viewport");
    const height = Number(String(viewport.style.height).replace("px", ""));
    ok(height >= 30 + 48, `[43] 视口高度 ${height} ≥ 小节标题 30 + 提示句 48（否则 overflow:hidden 会把它整句裁掉）`);
    eq(picker.viewportHeightFor(catalog, 1, "", null), 30 + 48, "[43] 算式：空目录 = SEC_H + EMPTY_H");
    ok(internals.PICKER_CSS.indexOf(".cxp-empty{") > 0, "[43] 提示句的样式规则还在");
    ok(
      String(react.find("picker-trigger").textContent).indexOf("模型") >= 0,
      "[43] 这种「就绪但空」的目录下，按钮显示占位文案（不冒充模型名）",
    );
  }

  // ── #2 load 失败 → 退避重试，自己好起来 ────────────────────────────────
  {
    const scene = await setupPicker({
      host: { coldDirectory: true, loadFailures: 1 },
    });
    const { react, host } = scene;
    ok(host.loads.length >= 1, "[43] 挂载时就尝试过 load（那一次是失败的）");
    eq(host.pendingLoadFailures, 0, "[43] 失败次数已用掉（第一次 load 真的失败了）");

    // 退避重试（RETRY_DELAYS 第一档 60ms）之后应当自己好起来
    await wait(500);
    await settle();
    ok(
      String(react.find("picker-trigger").textContent).indexOf("DeepSeek-V41-Flash") >= 0,
      "[43] load 失败一次之后**自愈**：按钮显示模型名（以前会永远停在空目录）",
    );
    ok(host.loads.length >= 2, "[43] 确实重试过 load（不是靠别的路径蒙对）");
  }

  // ── #3 "就绪但空"：借官方 resolver 的 catalog.refresh() 主动刷一次 ───────
  {
    const scene = await setupPicker({
      host: {
        coldDirectory: true,
        // 刷一次就把目录填上（真 refresh = invalidate + load）
        onCatalogRefresh: (store, ready) => { store.set(ready); },
      },
    });
    const { react, host } = scene;
    // 复现"load 成功、宿主却给了一个合法的空目录"：把 store 压回"就绪但空"
    host.store.set({ current: null, groups: [], failures: [], status: "ready", pending: null, error: null });
    await settle(); // 这一步里插件应当已经主动刷了一次（心跳/渲染都会走到）

    ok(host.catalog.refreshes >= 1, `[43] 就绪但空 → 主动调了 catalog.refresh()（${host.catalog.refreshes} 次）`);
    ok(
      String(react.find("picker-trigger").textContent).indexOf("DeepSeek-V41-Flash") >= 0,
      "[43] 刷完之后目录有了 provider，界面跟着好（不用重启 DSH）",
    );

    // 冷却：短时间内不会反复打宿主
    const afterFirst = host.catalog.refreshes;
    await wait(400);
    eq(host.catalog.refreshes, afterFirst, "[43] 8 秒冷却内不会再刷（不许变成 RPC 风暴）");
  }

  // ── #4 逐 provider 的失败清单要显示出来（接管之后这份责任归我们）────────
  {
    const scene = await setupPicker({
      host: { snapshot: emptySnapshot([{ id: "deepseek-account", name: "DeepSeek", message: "API key 失效" }]) },
    });
    const { react } = scene;
    await scene.toggle();

    const rows = react.findAll("picker-failure");
    eq(rows.length, 1, "[43] 失败清单渲染成一行（官方菜单里那份 warning 的等价物）");
    eq(String(rows[0].textContent), "DeepSeek 加载失败：API key 失效", "[43] 文案与官方一致：\"{name} 加载失败：{message}\"");
    eq(rows[0].getAttribute("title"), "API key 失效", "[43] 悬浮给出完整原因");

    const viewport = react.find("picker-viewport");
    const height = Number(String(viewport.style.height).replace("px", ""));
    ok(height >= 30 + 30, `[43] 视口高度 ${height} ≥ 小节标题 + 一行失败（否则同样会被裁）`);
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

section("45. 会话 id 有两条来路：kit 的 `sessionId` 优先，`binding.key` 只做兜底（1.3.6 真机事故）");
{
  /*
   * 现场：面板永久停在"会话目录未就绪，正在重试…"，而官方 `/model` 一切正常。
   *
   * 根因在**渲染器拼 props 的顺序**：`{...标准 kit, ...inject 的返回, ...槽注入, ...owner}`
   * —— 我们以前 `inject: (sessionId) => ({ sessionId })`，等于用 `binding.key` **盖掉**
   * kit 里那个正确的会话 id。真机上 `binding.key` 一旦不是本会话的 id，
   * `directoryFor()` 就抛 `resolved no scope / no binding`，而且**每次重试都抛**（id 是常量）。
   *
   * 这一节把三种组合都钉住：只有 kit 对、只有 inject 对、两个都不对（要如实报原因）。
   */
  const GOOD = "session-abcdef";          // kit 里的会话 id（官方席按钮用的就是它）
  const BAD = "binding-key-not-a-session"; // 假的 binding.key（真宿主的报错形态见 harness）
  /** (a0) 要直接看**加载后的插件对象**与它的宿主，用最朴素的一次装配拿到。 */
  const [sceneBundle, sceneHost] = (() => {
    const document = createDocument();
    const menu = createOfficialMenu(document);
    const bundle = loadBundle(BUNDLE, document, {});
    const host = createFakeHost({ snapshot: snapshotOf({ groups: pickerGroups() }) });
    bundle.plugin.apply(host.ctx);
    host.enforceInject(bundle.plugin.inject);
    return [bundle.plugin, host];
  })();

  // (a0) 插件级 inject 必须声明 remote / remote.session（Cordis 的服务访问跟着调用方 ctx）
  {
    const list = Array.isArray(sceneBundle.inject) ? sceneBundle.inject : [];
    ok(list.indexOf("remote") >= 0, "[45] 插件级 inject 声明了 `remote`");
    ok(
      list.indexOf("remote.session") >= 0,
      "[45] 插件级 inject 声明了 `remote.session` —— 缺了它 `directoryFor()` 会抛 "
        + "`cannot get property \"remote.session\" without inject`（官方插件的 inject 里就有这两项）",
    );
    eq(sceneHost.declaredInject !== null, true, "[45] 测试台已按插件声明复刻这条规矩（少声明就撞墙）");
    // 反证：把声明删掉，假宿主立刻像真宿主一样拒绝
    const probeHost = createFakeHost({ snapshot: snapshotOf({ groups: pickerGroups() }) });
    probeHost.enforceInject(["slots", "sessions", "modelDirectories"]);
    let message = "";
    try { probeHost.ctx.modelDirectories.directoryFor(GOOD); } catch (error) { message = error.message; }
    eq(message, 'cannot get property "remote.session" without inject', "[45] 少声明时报的就是真机那句原话");
  }

  // (a) 只有 kit 对：inject 给了一个解析不出 scope 的 id —— 面板必须照常工作
  {
    const scene = await setupPicker({
      host: { throwForSessionIds: [BAD] },
      bindingKey: BAD,
    });
    const { react } = scene;
    await scene.toggle();
    eq(
      react.findAll("picker-provider").length,
      2,
      "[45] binding.key 是坏的也不影响：kit 的 sessionId 优先，目录照样解析出来",
    );
    ok(
      String(react.find("picker-trigger").textContent).indexOf("DeepSeek-V41-Flash") >= 0,
      "[45] 按钮照样显示模型名（修复前：永久停在「会话目录未就绪」）",
    );
    eq(react.find("picker-empty"), null, "[45] 不再出现空态提示");
  }

  // (b) 只有 inject 对：kit 的 sessionId 解析不出来 —— 兜底候选要接住
  {
    const scene = await setupPicker({
      host: { throwForSessionIds: [GOOD] },
      props: { sessionId: GOOD },
      bindingKey: "session-from-binding-key",
    });
    const { react, internals } = scene;
    const access = internals.createDirectoryAccess(
      scene.host.ctx,
      [GOOD, "session-from-binding-key"],
      { set: (fn, d) => setTimeout(fn, d), clear: (h) => clearTimeout(h) },
    );
    eq(access.sessionIds().join(","), GOOD + ",session-from-binding-key", "[45] 候选顺序：kit 在前、inject 在后");
    access.dispose();

    await scene.toggle();
    eq(
      react.findAll("picker-provider").length,
      2,
      "[45] kit 的值坏掉时轮换到 inject 那个 id，目录照样出来（两个来源互为备份）",
    );
  }

  // (d) 一个会话 id 都没有（"新会话"空白壳里输入区照样渲染）：要说人话，而不是"未就绪"
  {
    const scene = await setupPicker({
      props: { sessionId: undefined },
      bindingKey: "",
    });
    const { react } = scene;
    await scene.toggle();
    const empty = react.find("picker-empty");
    eq(empty.getAttribute("data-phase"), "no-session", "[45] 没有会话 id → phase=no-session（而不是含糊的 unresolved）");
    eq(
      String(empty.textContent),
      "还没有会话 —— 发一条消息后就能选模型",
      "[45] 文案直接告诉用户该怎么办（真机重启后停在空白壳里就是这个状态）",
    );
    eq(react.find("picker-reason"), null, "[45] 这种情况不摆「原因」（没有失败可报）");
  }

  // (c) 两个都不对：如实显示"未就绪"，并**把宿主的原话摆出来**（而不是含糊一句）
  {
    const scene = await setupPicker({
      host: { throwForSessionIds: [GOOD, BAD] },
      bindingKey: BAD,
    });
    const { react } = scene;
    await scene.toggle();
    eq(react.find("picker-empty").getAttribute("data-phase"), "unresolved", "[45] 两个 id 都无效 → phase=unresolved");
    const reasonNode = react.find("picker-reason");
    ok(reasonNode !== null, "[45] 面板上出现「原因」那一行（修复前这句话被静默吞掉，只能靠猜）");
    ok(
      String(reasonNode.textContent).indexOf("resolved no scope") >= 0,
      `[45] 摆出来的就是宿主原话：${String(reasonNode.textContent).slice(0, 60)}`,
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

section("44. 包清单不能带 BOM（宿主直接 JSON.parse 它 —— 带 BOM 时插件会被整个丢掉）");
{
  /*
   * 真机事故（1.3.5 之后）：**整个插件效果消失**、重启也不回来。插件管理器给出的话是
   *   `Unexpected token '\uFEFF', "\uFEFF{\r\n  \"nam\"... is not valid JSON`
   * —— 也就是 `package.json` 开头多了个 UTF-8 BOM，宿主解析不了这个 bundle 的清单，
   * 于是它 **一行都没加载**（`rows: []`），客户端那一半自然不会进浏览器。
   *
   * 根因是编辑工具链：**Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM**
   * （`New-Object System.Text.UTF8Encoding($false)` 才不会）。我当时用它改版本号，就把 BOM 带进去了。
   * 这条断言是给"那次事故"上的锁：清单必须是无 BOM 的 UTF-8，而且必须能被 `JSON.parse` 直接吃掉。
   */
  const readBytes = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
  const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  const pkgBytes = readBytes("../package.json");
  eq(hasBom(pkgBytes), false, "[44] package.json 不带 BOM（带 BOM 时宿主报 'Unexpected token ﻿'，插件一行都不加载）");
  const pkg = JSON.parse(pkgBytes.toString("utf8")); // 带 BOM 时这里会直接抛，正是宿主的行为
  eq(typeof pkg.name, "string", "[44] 它能被 JSON.parse 直接吃掉（宿主读清单就是这么读的）");
  eq(pkg.dsh && typeof pkg.dsh === "object", true, "[44] 清单里有 dsh 声明");
  eq(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, "./cordis.patch.yml", "[44] bundle 补丁指向 cordis.patch.yml");
  eq(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform, "web", "[44] 客户端一半声明为 web 平台");

  // 其余"会被工具链直接读"的文本文件同样不能带 BOM（YAML 能容忍 BOM，但没必要冒这个险）
  for (const rel of ["../lib/index.js", "../lib/client.js", "../lib/client.picker.js", "../cordis.patch.yml"]) {
    eq(hasBom(readBytes(rel)), false, `[44] ${rel.replace("../", "")} 不带 BOM`);
  }

  // 宿主一半读的是 lib/*.js（不读 package.json），所以它的自检与清单 BOM 无关：
  // 这条断言把"它读哪些文件"钉住，避免将来有人往宿主侧加一句 JSON.parse(package.json)
  ok(
    SOURCE.indexOf("package.json") >= 0 || readFileSync(fileURLToPath(new URL("../lib/index.js", import.meta.url)), "utf8").indexOf("package.json") < 0,
    "[44] 宿主侧自检不依赖 package.json（真出 BOM 时它照样能报'产物就绪'）",
  );

  /*
   * **反过来的那一条**：两个 `.ps1` **必须带 BOM**。
   *
   * `pack-dist.ps1` 头部自己就写着这个要求：Windows PowerShell 5.1 读无 BOM 的 `.ps1`
   * 会按系统代码页解码，中文注释/提示直接变乱码、甚至语法错误。
   * 这两条断言是给一次真实误伤打的补丁：为了修 `package.json` 的 BOM 事故，
   * 当时"顺手全仓库去 BOM"，把这俩 `.ps1` 的 BOM 也剥了 —— 规则是**分文件类型**的，
   * 不是"BOM 一律坏"（JSON/JS 不能带，PowerShell 脚本要带）。
   */
  for (const rel of ["../pack-dist.ps1", "../install-profile.ps1"]) {
    eq(hasBom(readBytes(rel)), true, `[44] ${rel.replace("../", "")} **带** BOM（PS 5.1 读无 BOM 的中文脚本会乱码/报错）`);
  }
  ok(
    readFileSync(fileURLToPath(new URL("../pack-dist.ps1", import.meta.url)), "utf8").indexOf("必须存为 **UTF-8 带 BOM**") >= 0,
    "[44] 而且脚本头部把这条要求写在注释里（谁想再剥一次 BOM 会先读到它）",
  );
}

/* ══════════════════════════════════════════════════════════════════════ */

section("46. 换模型时的默认档位 = 正中（偶数档取「中间的下一个」）—— 用户指定的规则");
{
  /*
   * 用户要求（原话）："所有模型点击使用的时候默认使用中间的档位，如果总档位是双数，
   * 就选中间的下一档，比如总4档，默认第三档。"
   *
   * 改之前是"最后一档（Max）"或宿主声明的 `defaultEffort`，所以换模型总落在最高档。
   * ⚠️ 为什么既有 868 条断言里**没有**一条盯住它：默认模型 `DEFAULT_MODEL` 的
   * `defaultEffort` 恰好就是 4 档的正中（`high`），新旧规则在那里**答案相同**。
   * 这一节专门用"没有 defaultEffort"和"defaultEffort 不是正中"的模型来区分。
   */
  const scene0 = await setupPicker();
  const { picker } = scene0;
  const idx = (n) => picker.defaultLevelIndex(Array.from({ length: n }, (_, i) => ({ id: "L" + i })));

  eq(idx(0), -1, "[46] 0 档 → -1（没有档位）");
  eq(idx(1), 0, "[46] 1 档 → 第 1 档");
  eq(idx(2), 1, "[46] 2 档 → 第 2 档（中点在 1/2 之间 → 下一档）");
  eq(idx(3), 1, "[46] 3 档 → 第 2 档（正中）");
  eq(idx(4), 2, "[46] **4 档 → 第 3 档**（用户给的例子）");
  eq(idx(5), 2, "[46] 5 档 → 第 3 档（正中）");
  eq(idx(6), 3, "[46] 6 档 → 第 4 档（中点在 3/4 之间 → 下一档）");

  /** 造一个只有档位表的模型（可选 `def`）。 */
  const makeModel = (id, levels, def) => ({
    id,
    name: id,
    reasoning: {
      ...(def === undefined ? {} : { defaultEffort: def }),
      efforts: levels.map((levelId) => ({ id: levelId, name: levelId.toUpperCase() })),
    },
  });
  const FOUR = ["off", "low", "high", "max"];

  // (a) 点击一个 4 档、**没有** defaultEffort 的模型 → 写中间那档（high = 第三档）
  {
    const scene = await setupPicker({
      host: {
        snapshot: snapshotOf({ groups: [{ id: "p1", name: "P1", models: [makeModel("no-def-four", FOUR)] }] }),
      },
    });
    const { react, host } = scene;
    await scene.toggle();
    react.findAll("picker-provider")[0].fire("onClick", {});
    await settle();
    modelRowByName(react, "no-def-four").fire("onClick", {});
    await settle();
    eq(host.selects.length, 1, "[46] 点击模型写了一次宿主");
    eq(host.selects[0].model, "no-def-four", "[46] 写的是那个模型");
    eq(
      host.selects[0].reasoningEffort,
      "high",
      "[46] 默认档位 = **第三档 high**（4 档的正中；改之前是最后一档 max）",
    );
    await settle();
    eq(
      String(react.find("picker-effort-value").textContent),
      "HIGH",
      "[46] 面板上的档位跟着显示那一档（HIGH）",
    );
  }

  // (b) 宿主声明了 `defaultEffort: low`（不是正中）→ **用户规则优先**，仍写中间那档
  {
    const scene = await setupPicker({
      host: {
        snapshot: snapshotOf({ groups: [{ id: "p1", name: "P1", models: [makeModel("def-low-four", FOUR, "low")] }] }),
      },
    });
    const { react, host } = scene;
    await scene.toggle();
    react.findAll("picker-provider")[0].fire("onClick", {});
    await settle();
    modelRowByName(react, "def-low-four").fire("onClick", {});
    await settle();
    eq(
      host.selects[0].reasoningEffort,
      "high",
      "[46] 宿主的 defaultEffort(low) **不参与定位**：默认仍是正中 high（用户规则优先）",
    );
  }

  // (c) 5 档 → 正中（第三档 = medium）；2 档 → 第二档（各自一个场景，避免翻页状态互相干扰）
  {
    const scene = await setupPicker({
      host: {
        snapshot: snapshotOf({
          groups: [{ id: "p1", name: "P1", models: [makeModel("five", ["off", "low", "medium", "high", "max"])] }],
        }),
      },
    });
    const { react, host } = scene;
    await scene.toggle();
    react.findAll("picker-provider")[0].fire("onClick", {});
    await settle();
    modelRowByName(react, "five").fire("onClick", {});
    await settle();
    eq(host.selects[0].reasoningEffort, "medium", "[46] 5 档 → 正中（medium）");
  }
  {
    const scene = await setupPicker({
      host: {
        snapshot: snapshotOf({
          groups: [{ id: "p1", name: "P1", models: [makeModel("two", ["low", "high"])] }],
        }),
      },
    });
    const { react, host } = scene;
    await scene.toggle();
    react.findAll("picker-provider")[0].fire("onClick", {});
    await settle();
    modelRowByName(react, "two").fire("onClick", {});
    await settle();
    eq(host.selects[0].reasoningEffort, "high", "[46] 2 档 → 第二档（high，中点在 1/2 之间 → 下一档）");
  }

  // (d) 会话里**明确存着**档位时，显示必须尊重它（默认值不能盖掉宿主的真实状态）
  {
    const scene = await setupPicker({
      host: {
        snapshot: snapshotOf({
          groups: [{ id: "p1", name: "P1", models: [makeModel("stored", FOUR)] }],
          model: "stored",
          effort: "off",
        }),
      },
    });
    const { react } = scene;
    const catalog = scene.picker.readCatalog(scene.host.store.getSnapshot());
    eq(catalog.levelIndex, 0, "[46] 明确存着 off → 停在第 1 档（不是正中）");
    await scene.toggle();
    eq(String(react.find("picker-effort-value").textContent), "OFF", "[46] 面板显示 OFF：显式档位优先于默认规则");
  }

  // (e) 没有明确档位时，滑条**初始就停在正中**（与点击模型写哪一档同一条规则）
  {
    const scene = await setupPicker({
      host: {
        snapshot: snapshotOf({
          groups: [{ id: "p1", name: "P1", models: [makeModel("no-explicit", FOUR)] }],
          model: "no-explicit",
        }),
      },
    });
    const catalog = scene.picker.readCatalog(scene.host.store.getSnapshot());
    eq(catalog.levelIndex, 2, "[46] 无明确档位 → levelIndex = 2（第三档），改之前是 3（Max）");
    eq(catalog.level && catalog.level.id, "high", "[46] 档位对象也是正中那档");
    await scene.toggle();
    eq(String(react_find_effort_value(scene)), "HIGH", "[46] 面板一打开就停在正中");
  }
}

function react_find_effort_value(scene) {
  return scene.react.find("picker-effort-value").textContent;
}

/* ══════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? "全部通过 ✅" : "有失败 ❌"} （${passed} 项通过，${failed} 项失败）`);
if (failed > 0) {
  console.log("失败项：");
  for (const label of failures) console.log(`  · ${label}`);
  process.exitCode = 1;
}
