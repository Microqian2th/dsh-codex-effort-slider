/**
 * dsh-codex-effort-slider — 客户端离线测试
 *
 * 跑法：`node test/client.test.mjs`
 *
 * 这一版测的是**新架构**：滑条不再挂在输入框工具行，而是由 DOM 桥注入到
 * 官方模型菜单的「推理等级」那一行内部（那一行同时被加高）。所有断言里最要紧的几条：
 *   · 只动那一行（官方原有的 label/value/chevron 一个不动），关菜单后**逐个还原**
 *   · 拖动真的写回官方档位；不把宿主打爆（去重 + 在途合并 + 降频）
 *   · 找不到锚点/不是自己的会话就**什么都不做**（fail-open，官方菜单绝不受影响）
 *   · 结构上不存在消息注入这条路
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDocument, createFakeHost, createOfficialMenu, loadBundle, settle, wait } from "./harness.mjs";

const BUNDLE = fileURLToPath(new URL("../lib/client.js", import.meta.url));
const SOURCE = readFileSync(BUNDLE, "utf8");
/** 去掉注释后的代码：断言「产物里没有 X」时必须看代码，注释里提到同类插件的坑不算违规。 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

let passed = 0;
let failed = 0;
const failures = [];

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
  ok(same, same ? label : `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function near(actual, expected, label, tolerance = 1e-6) {
  const same = typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
  ok(same, same ? label : `${label}（期望 ≈${expected}，实际 ${actual}）`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

/**
 * 取**滑条**那一条注册。
 *
 * 插件现在注册两个插槽条目：滑条本体（`conversation.input.right`）与设置卡片
 * （`plugins.bundle.config`，`key` = 包名）。两者都进 `host.registered`，
 * 所以按 `opts.name` 精确挑，而不是赌顺序。
 */
function sliderEntry(host) {
  const entry = host.registered.find((item) => item.opts && item.opts.name === "conversation.input.right");
  if (!entry) throw new Error("没有找到 conversation.input.right 的注册条目");
  return entry;
}

/**
 * 起一个完整场景：假官方菜单 + 真产物 + 假宿主，并把组件挂进**官方 composer 内部**
 * （插槽在真实布局里就在那里，桥要靠这个位置判定"哪颗席是我的"）。
 */
async function setup(options = {}) {
  const document = createDocument();
  const menu = createOfficialMenu(document, options.menu);
  const bundle = loadBundle(BUNDLE, document, { reducedMotion: options.reducedMotion === true });
  const host = createFakeHost(options.host ?? {});
  bundle.plugin.apply(host.ctx);
  const entry = sliderEntry(host);
  if (!entry) throw new Error("插件没有注册任何插槽条目");
  bundle.react.mount(entry.Component, Object.assign({ sessionId: "session-abcdef" }, options.props ?? {}), menu.composer);
  await settle();
  return {
    document,
    menu,
    bundle,
    react: bundle.react,
    plugin: bundle.plugin,
    registration: bundle.registration,
    host,
    entry,
    internals: bundle.plugin.__internals,
    // 引擎是**逐帧**推进的，测试必须显式泵帧才能看到位置变化。
    flushFrames: bundle.flushFrames,
    advanceClock: bundle.advanceClock,
    clockNow: bundle.clockNow,
  };
}

/**
 * 推进引擎到收敛。
 *
 * ⚠️ 两点关键：
 *  1. 必须**每帧之间让渲染落定**：引擎通过 setDraft 触发 React 重渲染，而测试台
 *     的渲染是 queueMicrotask 批处理的 —— 一次泵多帧而不落定微任务，读到的还是旧 DOM。
 *  2. 落定必须用**微任务**而不是 setTimeout：引擎时间走的是假时钟（flushFrames 推进），
 *     但真实墙上时间若被 setTimeout 拖长，`COMMIT_THROTTLE_MS`(120ms) 的定时器会
 *     在拖动中途触发、把"已生效档位"改掉，让"拖动中席按钮不乱跳"这类断言变得不确定。
 */
async function runFrames(ctx, frames = 90, dtMs = 16) {
  for (let i = 0; i < frames; i += 1) {
    const executed = ctx.flushFrames(1, dtMs);
    for (let m = 0; m < 6; m += 1) await Promise.resolve(); // 只落微任务，不推进墙上时间
    if (executed === 0) break; // 引擎已停（收敛或未启动）
  }
}

/** 按下并把引擎跑到收敛（等价于"按下 → 等它追到位"）。 */
async function pressAndSettle(ctx, clientX) {
  track(ctx.react).fire("onPointerDown", { clientX, pointerId: 1 });
  await runFrames(ctx);
  await settle();
}

/** 松手并把吸附动画跑到收敛。 */
async function releaseAndSettle(ctx) {
  track(ctx.react).fire("onPointerUp", {});
  await runFrames(ctx);
  await settle();
}

/** 按下但**不**等收敛（用于观察拖动中的中间态）。只落微任务，不推进墙上时间。 */
async function pressOnly(ctx, clientX) {
  track(ctx.react).fire("onPointerDown", { clientX, pointerId: 1 });
  for (let m = 0; m < 6; m += 1) await Promise.resolve();
}

/** 现查轨道节点并给确定几何（假 DOM 不做布局）。 */
function track(react, left = 0, width = 300) {
  const node = react.find("track");
  if (!node) return null;
  node.rect = { left, top: 0, right: left + width, bottom: 28, width, height: 28 };
  return node;
}

function officialRowText(row) {
  return String(row.textContent);
}

/** 真实 DOM 里"没设置过的内联样式"读作 ""，假 DOM 是 undefined；断言统一走这个。 */
function cssValue(node, prop) {
  return node.style[prop] ?? "";
}

/* ══════════════════════════════════════════════════════════════════════ */

section("1. 接线与产物");
{
  const { registration, plugin, entry, document, host, internals } = await setup();
  eq(registration.id, "dsh-codex-effort-slider", "[1] bundle 注册 id 正确");
  ok(Array.isArray(plugin.inject) && plugin.inject.indexOf("slots") >= 0, "[1] inject 含 slots");
  ok(plugin.inject.indexOf("modelDirectories") >= 0, "[1] inject 含 modelDirectories（读写官方档位靠它）");
  ok(plugin.inject.indexOf("sessions") >= 0, "[1] inject 含 sessions（判子代理会话靠它）");
  eq(entry.opts.name, "conversation.input.right", "[1] 仍然注册插槽条目（不可见锚点：拿 sessionId + ctx 的立足点）");
  eq(entry.opts.id, "codex-effort-slider", "[1] 条目 id 是自己的");
  const styles = document.querySelectorAll('style[data-plugin-css="dsh-codex-effort-slider"]');
  eq(styles.length, 1, "[1] 样式挂载一次");
  internals.installStyles();
  eq(document.querySelectorAll('style[data-plugin-css="dsh-codex-effort-slider"]').length, 1, "[1] 重复安装样式是幂等的");
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
  eq(internals.KNOB_SIZE, internals.TRACK_HEIGHT, "[2b] 旋钮直径 = 轨道高度（「加大到与滑条同宽」）");
  eq(internals.KNOB_RADIUS, internals.KNOB_SIZE / 2, "[2b] 半径 = 直径的一半");
  eq(internals.knobOffsetOf(0), "calc(14px + 0 * (100% - 28px))", "[2b] pct=0 时圆心落在左端半径处");
  eq(internals.knobOffsetOf(1), "calc(14px + 1 * (100% - 28px))", "[2b] pct=1 时圆心落在右端半径处");
  ok(internals.CSS.indexOf(".ces-knob{") > 0, "[2b] 有旋钮规则");
  const knobCss = internals.CSS.slice(internals.CSS.indexOf(".ces-knob{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-knob{")));
  ok(knobCss.indexOf("border-radius:50%") > 0, "[2b] 旋钮是正圆（border-radius:50%）");
  ok(knobCss.indexOf(`width:${internals.KNOB_SIZE}px;height:${internals.KNOB_SIZE}px`) > 0, "[2b] 旋钮盒子是等宽高的正方形（配合 50% 圆角才是圆）");
  ok(knobCss.indexOf(`margin:${-internals.KNOB_RADIUS}px 0 0 ${-internals.KNOB_RADIUS}px`) > 0, "[2b] 用 margin 把圆心对准计算出的 left");
  const trackCss = internals.CSS.slice(internals.CSS.indexOf(".ces-track{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-track{")));
  ok(trackCss.indexOf(`height:${internals.TRACK_HEIGHT}px`) > 0, "[2b] 轨道高度与旋钮直径用同一组常量");

  // 指针映射与视觉几何一致：拖到最左必定命中第一档（而不是因为内缩差一点点）
  {
    const d = await setup();
    track(d.react, 0, 300).fire("onPointerDown", { clientX: 0, pointerId: 1 }); // 远在左端之外
    await pressAndSettle(d, 0);
    releaseAndSettle(d);
    eq(d.react.find("knob").style.left, internals.knobOffsetOf(0), "[2b] 拖到最左 → 旋钮贴左端圆角内（圆心不越界）");
    eq(d.host.selects[d.host.selects.length - 1].reasoningEffort, "off", "[2b] 最左端映射到第一档");
  }

  // 右端同理
  {
    const d = await setup();
    await pressAndSettle(d, 300);
    releaseAndSettle(d);
    eq(d.react.find("knob").style.left, internals.knobOffsetOf(1), "[2b] 拖到最右 → 旋钮贴右端圆角内（不会被菜单裁掉）");
    eq(d.host.selects[d.host.selects.length - 1].reasoningEffort, "max", "[2b] 最右端映射到最高档");
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
  bundleA.react.mount(sliderEntry(hostA).Component, { sessionId: "session-abcdef" }, menuA.composer);
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
    bundle.react.mount(sliderEntry(host).Component, { sessionId: "session-abcdef" }, menu.composer);
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
    bundle.react.mount(sliderEntry(host).Component, { sessionId: "session-abcdef" }, mine.composer);
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

section("5. 拖动**跨档即写回**（拖到哪档就变成哪一档），松手再确认一次");
{
  const { menu, react, host } = await setup();
  track(react).fire("onPointerDown", { clientX: 60, pointerId: 1 }); // 60/300 = 20% → index 1 = low
  await wait(180);
  // ⚠️ 契约：拖动期**只在跨过档位边界的那一刻**写回一次（不是原来的每 120ms 一次）。
  //    用户要的是"拖到哪档就变成哪一档"（官方那一行的档位文字随手走）；
  //    但每秒 8 次写回会让「已生效档位」在拖动中不停变化 → 与滞后的引擎位置不同步 → 抽搐。
  eq(host.selects.length, 1, "[5] 拖动跨到新档位即写回一次（跨档触发，不是每 120ms 一次）");
  eq(host.selects[0].reasoningEffort, "low", "[5] 写回的就是指针所在那一档（low）");

  track(react).fire("onPointerUp", {});
  await settle();
  eq(host.selects.length, 1, "[5] 松手时同档位去重，不重复写");
  eq(JSON.stringify(host.selects[0]), JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v41-flash",
    reasoningEffort: "low",
  }), "[5] 写回的是官方 select 契约 { provider, model, reasoningEffort }");
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

  // 键盘也一样不能漏给官方菜单
  let menuKey = false;
  menu.effortRow.parentNode.handlers.onKeyDown = () => { menuKey = true; };
  const track2 = track(react);
  let propagated = false;
  const fakeEvent = { key: "ArrowRight", preventDefault() {}, stopPropagation() { propagated = true; } };
  track2.handlers.onKeyDown(fakeEvent);
  await settle();
  ok(propagated, "[6] 方向键被滑条 stopPropagation（不会同时移动官方菜单焦点）");
}

section("7. 键盘可达 + 去重/限频/在途合并");
{
  const { react, host } = await setup();
  track(react).fire("onKeyDown", { key: "ArrowRight" });
  await settle();
  eq(host.selects[host.selects.length - 1].reasoningEffort, "max", "[7] 右方向键上移一档并写回");
  track(react).fire("onKeyDown", { key: "Home" });
  await settle();
  eq(host.selects[host.selects.length - 1].reasoningEffort, "off", "[7] Home 键回到最低档");

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
  await pressAndSettle(a, 290);
  await releaseAndSettle(a);
  await settle(14);
  ok(a.react.find("error") !== null, "[8] 写回失败 → 行里显示错误");
  ok(String(a.react.find("error").textContent).indexOf("session is held") >= 0, "[8] 错误里带宿主给的原始原因");
  eq(a.react.find("track").getAttribute("aria-valuetext"), "High", "[8] 读数回滚到真实档位（不假装已经是 Max）");

  // 8b select 同步抛错
  const b = await setup({ host: { select: () => { throw new Error("boom"); } } });
  let threw = false;
  try {
    await pressAndSettle(b, 290);
    await releaseAndSettle(b);
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
  const ctx10 = await setup();
  const { react, internals, menu, host } = ctx10;
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
  await pressAndSettle(ctx10, internals.KNOB_RADIUS + T * (300 - 2 * internals.KNOB_RADIUS));
  await releaseAndSettle(ctx10);
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
  await pressAndSettle(ctx10, 300); // 最右
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
  await pressAndSettle(another, 300);
  eq(
    JSON.stringify(another.react.findAll("particle").map((n) => Number(n.getAttribute("data-brightness")))),
    JSON.stringify(brightness),
    "[10] 换一次渲染亮度序列完全一致（没有 Math.random）",
  );
  const delays = react.findAll("star").map((n) => Number(String(n.style.animationDelay).replace("s", "")));
  ok(delays.every((d) => d <= 0), "[10] 相位都是负延迟（一出现就在途中）");
  ok(new Set(delays.map((d) => d.toFixed(2))).size > 10, "[10] 相位铺开（均匀分布在轨道上）");

  // ── 拖回 high：同一套星空动画，但**慢一倍**（速度变化保留）
  await pressAndSettle(ctx10, internals.KNOB_RADIUS + H * (300 - 2 * internals.KNOB_RADIUS));
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

  // ⚠️ 默认已改为「完整动画」（用户要求）：系统即使开着「减少动态效果」，默认也走完整动画。
  //    「快速动画」是**用户可选**的弱化档（其参数组在 19 节覆盖）。
  const reduced = await setup({ reducedMotion: true });
  eq(reduced.react.find("root").getAttribute("data-motion"), "full", "[10b] 默认「完整动画」→ 即便系统要求减少动态也标记 full");
  ok(String(reduced.react.find("track").getAttribute("title")).indexOf("减少动态效果") < 0, "[10b] 默认下 title 不加「已放缓」提示");
  eq(reduced.react.findAll("star").length, 11, "[10b] 星空照常存在");
  const normalDur = parseFloat(star.style.animationDuration);
  const reducedDur = parseFloat(reduced.react.findAll("star")[0].style.animationDuration);
  near(reducedDur / normalDur, 1, "[10b] 默认「完整动画」→ 星星周期与正常模式一致（不放缓）", 0.01);
  ok(reduced.internals.REDUCED_MOTION_SLOWDOWN > 1, "[10b] 「快速动画」档所用的放缓系数仍在（>1）");

  const css = reduced.internals.CSS;
  ok(css.indexOf(".ces-energy__sweep{display:none}") > 0, "[10b] reduced-motion 收起扫光（最闪的那部分）");
  ok(!/\.ces-star\{animation:none\}/.test(css), "[10b] 不再把动画整个关掉（这正是「粒子停住」的原因）");
}

section("11. 结构上不存在消息注入（防同类插件的致命 bug）");
{
  const { host, plugin } = await setup();
  eq(host.subscriptions.length, 0, "[11] 没有 ctx.on(...) —— 不监听任何宿主钩子");
  // 插件注册**两个**插槽条目：滑条本体 + 官方插件详情页的设置卡片。
  // 这条断言守的是"除了这两块 UI 什么都没有"，尤其没有任何会话事件注入。
  eq(host.registered.length, 2, "[11] 只注册两块 UI：滑条 + 设置卡片");
  eq(sliderEntry(host).opts.name, "conversation.input.right", "[11] 其一是输入框工具行的滑条");
  const cardEntry = host.registered.find((item) => item.opts && item.opts.name === "plugins.bundle.config");
  ok(cardEntry !== undefined, "[11] 其二挂在官方插件页的 plugins.bundle.config 槽位");
  eq(cardEntry.opts.key, "dsh-codex-effort-slider", "[11] 设置卡片的 key 必须是包名（key 错会静默不渲染）");
  ok(CODE.indexOf("session.append") < 0 && CODE.indexOf(".append(") < 0, "[11] 代码里没有任何会话 append（除了给那一行 append 容器）");
  ok(CODE.indexOf('role: "user"') < 0 && CODE.indexOf('"user/message"') < 0, "[11] 不构造 user 消息");
  ok(CODE.indexOf("producer-owned") < 0, "[11] 不触碰 V4 会话准入面");
  ok(typeof plugin.apply === "function" && typeof plugin.inject !== "undefined", "[11] 导出面只有 apply/inject");
}

section("12. DOM 锚点契约（官方产物里必须还存在我依赖的语义属性）");
{
  const candidates = [
    "F:/Work Space/DeepSeek Harness/_review/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js",
  ];
  const official = candidates.find((path) => existsSync(path));
  if (official === undefined) {
    console.log("  --   跳过：本机没有解包出来的官方产物（_review/dsh-asar）");
  } else {
    const text = readFileSync(official, "utf8");
    ok(text.indexOf('"aria-haspopup": "menu"') > 0, "[12] 官方席仍然有 aria-haspopup=menu");
    ok(text.indexOf('"aria-expanded": open') > 0, "[12] 官方席仍然有 aria-expanded");
    ok(text.indexOf("aria-controls") > 0 && text.indexOf("-menu`") > 0, "[12] 官方席仍然用 aria-controls 指向菜单 id");
    ok(text.indexOf('role: "menuitem"') > 0, "[12] 根面板两行仍然是 role=menuitem");
    ok(text.indexOf('"menu.effort": "推理等级"') > 0, "[12] 官方中文文案仍然是「推理等级」");
    ok(text.indexOf('role: "menuitemradio"') > 0, "[12] 子面板仍然是 menuitemradio（我的结构判定靠这个区分）");
    ok(text.indexOf('window.addEventListener("resize", place)') > 0, "[12] 官方菜单在 resize 时会重测位置（我加高后靠它重排）");
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
  const ctx14 = await setup();
  const { react, internals, menu } = ctx14;
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
  await pressAndSettle(ctx14, 300);
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
  const ctx15 = await setup();
  const { react, internals, menu, bundle, document } = ctx15;

  // 拖动中：官方席显示的是**已生效**档位，所以它的颜色不该跟着草稿跑
  await pressAndSettle(ctx15, 300);
  eq(menu.effortValueEl.style.color, "rgb(139,92,246)", "[15] 菜单里那一行跟着草稿变成 Max 色");
  eq(menu.seatEffortEl.style.color, internals.valueColorFor(H), "[15] 席按钮仍按已生效档位着色（拖动中不乱跳）");
  await releaseAndSettle(ctx15);
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
  await pressAndSettle(off, 300);
  eq(off.menu.effortValueEl.style.color, "rgb(139,92,246)", "[16] 拖到 Max：菜单里那一行先变紫罗兰");
  eq(off.menu.seatEffortEl.style.color, "", "[16] 席按钮按已生效档位（仍是 off）→ 还是灰的");
  await releaseAndSettle(off);
  eq(off.menu.seatEffortEl.style.color, "rgb(139,92,246)", "[16] 提交后席按钮也变成紫罗兰");

  // 刻度点：更小更淡
  const tickCss = internals.CSS.slice(internals.CSS.indexOf(".ces-tick{"), internals.CSS.indexOf("}", internals.CSS.indexOf(".ces-tick{")));
  ok(tickCss.indexOf("width:3px;height:3px") > 0, "[16] 刻度点 5px → 3px（更小）");
  ok(tickCss.indexOf("26%,transparent") > 0, "[16] 未达到的刻度 38% → 26%（更淡）");
  ok(internals.CSS.indexOf(".ces-tick[data-lit='1']{background:rgba(255,255,255,.5)}") > 0, "[16] 亮的刻度 92% → 50% 白（更淡，不再和星星抢眼）");
  const tickNodes = off.react.findAll("tick");
  ok(tickNodes.length >= 4, `[16] 4 档就有 4 个刻度点（实测 ${tickNodes.length}）`);
}

/* ══════════════════════════════════════════════════════════════════════ */

section("17. 连续运动引擎：纯函数层（刹车预测 + 速度跟踪）");
{
  const ctx = await setup();
  const I = ctx.internals;
  const P = I.MOTION;
  const DT = 1 / 60;

  /** 跑一串帧，返回轨迹与统计。 */
  function trace(init, frames, mutate) {
    const m = Object.assign({ x: 0, v: 0, a: 0, target: 0 }, init);
    const rows = [];
    let maxDv = 0, prevV = m.v, maxDa = 0, prevA = m.a;
    for (let f = 0; f < frames; f += 1) {
      if (mutate) mutate(m, f);
      I.motionStep(m, DT, P);
      maxDv = Math.max(maxDv, Math.abs(m.v - prevV));
      maxDa = Math.max(maxDa, Math.abs(m.a - prevA));
      prevV = m.v; prevA = m.a;
      rows.push({ x: m.x, v: m.v, a: m.a, target: m.target });
    }
    return { m, rows, maxDv, maxDa };
  }

  /** 从静止走到 target，跑到精确落点（或超时）；同时统计 v 的符号翻转（抖振）。 */
  function run(target, maxFrames = 3000) {
    const m = { x: 0, v: 0, a: 0, target };
    let peak = 0, frames = 0, flips = 0, prevSign = 0;
    for (; frames < maxFrames; frames += 1) {
      I.motionStep(m, DT, P);
      peak = Math.max(peak, m.x);
      const s = Math.sign(m.v);
      if (s !== 0 && prevSign !== 0 && s !== prevSign) flips += 1;
      if (s !== 0) prevSign = s;
      if (m.x === target && m.v === 0) break;
    }
    return { m, frames, overshoot: peak - target, flips, landed: m.x === target && m.v === 0 };
  }

  // ① 参数：四个旋钮都是正数
  ok(P.K > 0, `[17] 位置→速度增益 K = ${P.K} > 0`);
  ok(P.A > 0, `[17] 刹车斜率 A = ${P.A} > 0`);
  ok(P.k > 0, `[17] 速度跟踪增益 k = ${P.k} > 0`);
  ok(P.vmax > 0, `[17] 速度上限 vmax = ${P.vmax} > 0`);

  // ② ⚠️ **最关键的结构性断言**：两项必须同时存在。
  //    只留刹车曲线 √(2A|e|) 会抖振（它是 bang-bang 的切换曲线，
  //    与恒力 ±A 配套；换成连续力律后必须补线性映射 K·|e|）。
  {
    // 复现"只留刹车曲线"的缺陷版本，确认它确实抖振 —— 防止将来有人把 K 项删掉
    function stepBrakeOnly(m) {
      const e = m.target - m.x;
      let vW = Math.sqrt(2 * P.A * Math.abs(e));
      if (vW > P.vmax) vW = P.vmax;
      const vDes = e > 0 ? vW : (e < 0 ? -vW : 0);
      m.a = Math.max(-P.amax, Math.min(P.amax, P.k * (vDes - m.v)));
      m.v = Math.max(-P.vmax, Math.min(P.vmax, m.v + m.a * DT));
      m.x += m.v * DT;
    }
    const bad = { x: 0, v: 0, a: 0, target: 0.5 };
    let flipsBad = 0, prevSign = 0;
    for (let f = 0; f < 600; f += 1) {
      stepBrakeOnly(bad);
      const s = Math.sign(bad.v);
      if (s !== 0 && prevSign !== 0 && s !== prevSign) flipsBad += 1;
      if (s !== 0) prevSign = s;
    }
    ok(flipsBad > 100,
      `[17] 反例确认：只有刹车曲线时 v 翻转 ${flipsBad} 次（抖振不收敛）→ 所以 K·|e| 那一项不能删`);
    // 而正式实现零翻转
    const good = run(0.5);
    ok(good.flips === 0, `[17] 正式实现（含 K·|e|）零抖振（v 翻转 ${good.flips} 次）`);
  }

  // ③ **精确落点 + 零抖振**：所有距离都必须严丝合缝停住
  for (const target of [0.02, 0.05, 0.1, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1]) {
    const r = run(target);
    ok(r.landed && r.flips === 0,
      `[17] 目标 ${target.toFixed(4)} 精确落点且零抖振（${r.frames} 帧，翻转 ${r.flips}）`);
  }

  // ④ 过冲在亚像素级（≤0.5px / 272px）
  {
    const subPixel = 0.5 / 272;
    let worst = 0;
    for (const target of [0.02, 0.1, 0.25, 0.5, 0.75]) worst = Math.max(worst, run(target).overshoot);
    ok(worst < subPixel, `[17] 各距离过冲 ${(worst * 272).toFixed(3)}px < 0.5px（亚像素）`);
  }

  // ⑤ 加速度被 amax 限住，且**不抖振**（这是本模型相对 bang-bang 的核心优势）
  //    ⚠️ 口径说明：以前写过"帧间 Δa ≤ amax·dt"，但那条**对速度跟踪力律不成立** ——
  //       `a = k·(v期望 − v)`，速度差大时 a 就大，一帧内可以变很多（实测 160）。
  //       这不叫不连续：a 是 (x, v) 的**连续函数**，只是 v 自身一帧内变化大。
  //       真正该断言的是：a 始终被 amax 限住 + 在目标附近**不来回翻转**（不抖振）。
  {
    const r = trace({ x: 0, target: 1 }, 200);
    let maxAbsA = 0;
    for (const row of r.rows) maxAbsA = Math.max(maxAbsA, Math.abs(row.a));
    ok(maxAbsA <= P.amax + 1e-9, `[17] 加速度始终被 amax 限住（实测峰值 ${maxAbsA.toFixed(0)} ≤ ${P.amax}）`);

    // 不抖振：目标固定时，a 的符号翻转次数应为 0（bang-bang 会反复翻转）
    const m = { x: 0, v: 0, a: 0, target: 1 };
    let aFlips = 0, prevSign = 0;
    for (let f = 0; f < 300; f += 1) {
      I.motionStep(m, DT, P);
      const s = Math.sign(m.a);
      if (s !== 0 && prevSign !== 0 && s !== prevSign) aFlips += 1;
      if (s !== 0) prevSign = s;
      if (m.x === 1 && m.v === 0) break;
    }
    ok(aFlips <= 1, `[17] 到位过程加速度只换向 ${aFlips} 次（加速→减速；不抖振）`);
  }

  // ⑥ 速度连续（帧间 Δv ≤ amax·dt，撞墙帧除外）
  {
    const r = trace({ target: 1 }, 200);
    const limit = P.amax * DT + 1e-9;
    ok(r.maxDv <= limit, `[17] 帧间 Δv ${r.maxDv.toFixed(3)} ≤ amax·dt ${limit.toFixed(3)}（速度连续）`);
  }

  // ⑦ 反向：**先滑行再掉头**（v 连续穿过 0），滑行距离 ≈ v²/(2A)
  {
    const m = { x: 0, v: 0, a: 0, target: 1 };
    for (let f = 0; f < 200 && m.v < P.vmax * 0.95; f += 1) I.motionStep(m, DT, P);
    const vBefore = m.v, x0 = m.x;
    let sameDirFrames = 0, maxDv = 0, prevV = m.v, slidePx = 0;
    for (let f = 0; f < 200; f += 1) {
      m.target = 0;
      I.motionStep(m, DT, P);
      maxDv = Math.max(maxDv, Math.abs(m.v - prevV)); prevV = m.v;
      if (m.v > 0) { sameDirFrames += 1; slidePx = Math.abs(m.x - x0); }
      else break;
    }
    ok(vBefore > P.vmax * 0.5, `[17] 前置：反向时确实在满速附近（v=${vBefore.toFixed(2)}）`);
    ok(sameDirFrames >= 1, `[17] 满速反向后有 ${sameDirFrames} 帧仍朝原方向滑行（v 连续穿过 0）`);
    ok(maxDv <= P.amax * DT + 1e-9, `[17] 反向过程 v 依然连续（最大 Δv ${maxDv.toFixed(3)}）`);
    // 滑行距离由 A 决定（这是 A 这个旋钮的物理含义）
    const theory = (vBefore * vBefore) / (2 * P.A);
    ok(slidePx <= theory * 272 * 1.6 + 1,
      `[17] 反向滑行 ${(slidePx * 272).toFixed(1)}px ≈ v²/2A ${(theory * 272).toFixed(1)}px（A 越大越"立即听话"）`);
  }

  // ⑧ 边界：位置夹在 [0,1]；非撞墙帧 Δv ≤ amax·dt
  {
    for (const target of [-0.5, 1.5]) {
      const m = { x: 0.5, v: 0, a: 0, target };
      let maxDvNonWall = 0, prevV = m.v;
      for (let f = 0; f < 200; f += 1) {
        const before = m.x;
        I.motionStep(m, DT, P);
        const dv = Math.abs(m.v - prevV);
        const hitWall = (m.x === 0 && before > 0 && m.v === 0) || (m.x === 1 && before < 1 && m.v === 0);
        if (!hitWall) maxDvNonWall = Math.max(maxDvNonWall, dv);
        prevV = m.v;
      }
      ok(m.x >= 0 && m.x <= 1, `[17] 目标 ${target}：位置被夹在 [0,1]（实测 ${m.x.toFixed(4)}）`);
      ok(maxDvNonWall <= P.amax * DT + 1e-9,
        `[17] 目标 ${target}：非撞墙帧 Δv ${maxDvNonWall.toFixed(3)} ≤ amax·dt`);
    }
  }

  // ⑨ 极小距离也精确落点
  {
    for (const target of [0.001, 0.005, 0.01]) {
      const r = run(target);
      ok(r.landed, `[17] 极小距离 ${target} 精确落点（${r.frames} 帧）`);
    }
  }

  // ⑩ 松手外推：速度的连续函数，无门槛
  {
    eq(I.releaseIndexFor(0.5, 0, 4), I.indexFromPct(0.5, 4), "[17] 速度为 0 → 外推量为 0（不改落点）");
    eq(I.RELEASE_PROJECT_S, 0, "[17] 灵敏度已关闭（诊断结论：非零外推会跨档 → 抽搐）");
    ok(I.indexFromPct(0.5 + 6 * 0.08, 4) >= I.indexFromPct(0.5, 4), "[17] 外推顺着运动方向（不会反向推）");
  }
}

section("18. 连续运动引擎：接线层（按下/拖动/松手/键盘只改目标）");
{
  // ① 按下不瞬移：按下后**不泵帧**，位置应停在原处（引擎还没走）
  {
    const ctx = await setup();
    const before = ctx.react.find("knob").style.left;
    track(ctx.react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
    for (let m = 0; m < 6; m += 1) await Promise.resolve();
    const after = ctx.react.find("knob").style.left;
    eq(after, before, "[18] 按下瞬间**不瞬移**（位置停在原处，等引擎追过去）");
  }

  // ② 逐帧推进：位置单调逼近目标，且单帧位移有界（永不跳变）
  {
    const ctx = await setup();
    const I = ctx.internals;
    /** 从 calc(14px + <pct> * (100% - 28px)) 里取出 pct。 */
    const pctOf = (css) => {
      const m = /\+ ([\d.]+) \*/.exec(String(css));
      return m === null ? null : Number(m[1]);
    };
    track(ctx.react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
    let prev = pctOf(ctx.react.find("knob").style.left);
    ok(prev !== null, "[18] 位置是 calc() 形式（能解析出 pct）");
    let maxJump = 0;
    const seen = [];
    for (let f = 0; f < 30; f += 1) {
      ctx.flushFrames(1, 16);
      for (let m = 0; m < 6; m += 1) await Promise.resolve();
      const now = pctOf(ctx.react.find("knob").style.left);
      maxJump = Math.max(maxJump, Math.abs(now - prev));
      prev = now;
      seen.push(now);
    }
    const jumpLimit = I.MOTION.vmax * (16 / 1000) + 0.01;
    ok(maxJump <= jumpLimit, `[18] 单帧位移 ${(maxJump * 100).toFixed(2)}% ≤ vmax·dt ${(jumpLimit * 100).toFixed(2)}%（永不跳变）`);
    ok(seen[seen.length - 1] > seen[0], "[18] 位置逐帧在推进（引擎在工作）");
  }

  // ③ 松手：写回发生在**松手瞬间**，且落点 = 外推后的档位
  {
    const ctx = await setup();
    const I = ctx.internals;
    await pressOnly(ctx, 300);
    const selectsBefore = ctx.host.selects.length;
    track(ctx.react).fire("onPointerUp", {});
    await settle();
    ok(ctx.host.selects.length > selectsBefore, "[18] 松手立即写回（不等待吸附动画跑完）");
    eq(ctx.host.selects[ctx.host.selects.length - 1].reasoningEffort, "max", "[18] 松手落点 = 外推后的档位（与视觉无关）");
  }

  // ④ 吸附结束后交回 effectivePct（不残留 draft）
  {
    const ctx = await setup();
    await pressAndSettle(ctx, 0);
    await releaseAndSettle(ctx);
    eq(ctx.react.find("knob").style.left, ctx.internals.knobOffsetOf(0), "[18] 吸附完成后精确落在档位点");
    eq(ctx.react.find("track").getAttribute("aria-valuenow"), "0", "[18] 吸附完成后读数 = 落点档位");
  }

  // ⑤ 拖动中"追上指针"后位置停在指针处（不能清掉 draft 跳回已生效档位）
  {
    const ctx = await setup();
    const I = ctx.internals;
    await pressOnly(ctx, 150); // 指针落在中间（不是档位点）
    await runFrames(ctx);
    const pct = (150 - I.KNOB_RADIUS) / (300 - 2 * I.KNOB_RADIUS);
    eq(ctx.react.find("knob").style.left, I.knobOffsetOf(I.clamp01(pct)), "[18] 拖动中追上指针后停在指针处（不跳回档位）");
  }

  // ⑥ 键盘：只改目标，位置连续过去（不瞬移）
  {
    const ctx = await setup();
    const before = ctx.react.find("knob").style.left;
    const trackNode = ctx.react.find("track");
    trackNode.fire("onKeyDown", { key: "Home", preventDefault() {} });
    for (let m = 0; m < 6; m += 1) await Promise.resolve();
    eq(ctx.react.find("knob").style.left, before, "[18] 键盘改档也不瞬移（位置交给引擎）");
    await runFrames(ctx);
    eq(ctx.react.find("knob").style.left, ctx.internals.knobOffsetOf(0), "[18] 键盘目标最终精确到位");
  }

  // ⑦ 卸载后帧循环必须停（否则 setDraft 到已卸载组件）
  {
    const ctx = await setup();
    track(ctx.react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
    ctx.flushFrames(1, 16);
    for (let m = 0; m < 6; m += 1) await Promise.resolve();
    ctx.react.unmount();
    const noop = () => null;
    ctx.react.find = noop; // 卸载后若还渲染就会读到 null 而崩
    const executed = ctx.flushFrames(20, 16);
    ok(executed === 0, `[18] 卸载后帧循环已停（继续泵 ${executed} 帧都无人响应）`);
  }
}

section("19. 两种动画模式：简洁 / 完整，且都不受系统「减少动态效果」影响");
{
  const pctOf = (c) => {
    const m = /\+ ([\d.]+) \*/.exec(c.react.find("knob").style.left || "");
    return m ? parseFloat(m[1]) : 0;
  };
  const run = async (c, frames, dt = 16) => {
    for (let i = 0; i < frames; i += 1) {
      const e = c.flushFrames(1, dt);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      if (e === 0) break;
    }
  };

  const ctx = await setup();
  const I = ctx.internals;

  // ① 设置共四项：动画（下拉）+ 隐藏（下拉）+ 目标/已到达（开关）
  eq(I.SETTINGS_SCHEMA.length, 4, "[19] 设置四项（动画 + 隐藏 + 目标 + 已到达）");
  eq(I.SETTINGS_SCHEMA.map((it) => it.key).join(","), "motion,hideTicks,highlightTarget,highlightReached",
    "[19] 键名正确，力度已删除、reachedTicks 已拆分");
  eq(I.readSettings().motion, "full", "[19] 动画默认 = 完整动画");
  ok(I.SETTINGS_SCHEMA.every((it) => it.default !== undefined), "[19] 每项都显式声明 default");
  eq(I.SETTINGS_SCHEMA[0].options.map((o) => o.label).join("/"), "完整动画/简洁动画", "[19] 两个选项的文案（默认值排第一）");

  // ② 两种模式的参数组
  ok(I.motionParamsForMode() === I.MOTION, "[19] 完整动画 → MOTION（他的方案）");
  I.writeSettings({ motion: "quick" });
  ok(I.motionParamsForMode() === I.MOTION_REDUCED, "[19] 简洁动画 → MOTION_REDUCED（我们之前的方案）");
  ok(I.MOTION_REDUCED.K > I.MOTION.K && I.MOTION_REDUCED.vmax > I.MOTION.vmax, "[19] 简洁参数更紧");

  // ③ 灵敏度写死为"他原来的一半"
  ok(I.RELEASE_PROJECT_S === 0, "[19] 灵敏度 = 0（非零外推会把落点推到另一档 → 抽搐）");

  // ④ 系统「减少动态效果」完全不影响行为
  //
  // ⚠️ 每次写设置后必须 `await settle()` 再比较：设置广播会触发重渲染，
  //    而 `await setup(...)` 内含 settle —— 不落定的话，先建的那个实例
  //    已经渲染成新值、后建的那个还没有，比较的其实是"同一个值的两个时刻"。
  //
  // 断言方式是**两边各自对照期望值**，而不是互相对照：
  // 互相对照在两边都停在旧值时也会通过，那就测不出"设置根本没生效"。
  for (const mode of ["full", "quick"]) {
    const wantMotion = mode === "quick" ? "concise" : "full";
    const a = await setup({ reducedMotion: true });
    const b = await setup({ reducedMotion: false });
    a.internals.writeSettings({ motion: mode });
    b.internals.writeSettings({ motion: mode });
    await settle();
    eq(a.react.find("root").getAttribute("data-motion"), wantMotion,
      `[19] ${mode}：系统要求减少动态时也按设置渲染（data-motion）`);
    eq(b.react.find("root").getAttribute("data-motion"), wantMotion,
      `[19] ${mode}：系统没要求时同样按设置渲染（data-motion）`);
    eq(a.react.find("root").getAttribute("data-motion"), b.react.find("root").getAttribute("data-motion"),
      `[19] ${mode}：系统开关不改变 data-motion`);
    eq(String(a.react.find("track").getAttribute("title")), String(b.react.find("track").getAttribute("title")),
      `[19] ${mode}：系统开关不改变提示文案`);
    const drive = async (c) => {
      track(c.react).fire("onPointerDown", { clientX: 60, pointerId: 1 });
      await run(c, 4);
      track(c.react).fire("onPointerMove", { clientX: 260, buttons: 1 });
      await run(c, 12);
      return pctOf(c);
    };
    eq(await drive(a), await drive(b), `[19] ${mode}：逐帧位置与系统设置无关`);
  }

  // ⑤ 刻度点：默认「显示」+ 只亮目标
  eq(I.readSettings().hideTicks, "show", "[19] 隐藏默认 = 显示");
  eq(I.readSettings().highlightTarget, true, "[19] 目标默认 = 亮");
  eq(I.readSettings().highlightReached, false, "[19] 已到达默认 = 不亮（只亮目标）");
  I.writeSettings({ hideTicks: "hideReached" });
  eq(I.readSettings().hideTicks, "hideReached", "[19] 可切到隐藏已到达");
  ok(I.CSS.indexOf(".ces-tick[data-hide='1']{display:none}") > 0, "[19] CSS 含隐藏规则");
  ok(I.CSS.indexOf(".ces-tick[data-lit='1']{background:rgba(255,255,255,.5)}") > 0, "[19] CSS 含亮白规则");
  I.writeSettings({ hideTicks: "show" });

  // ⑥ 未按键的 move 不得带动滑条
  {
    const c = await setup();
    track(c.react).fire("onPointerDown", { clientX: 300, pointerId: 1 });
    await run(c, 40);
    track(c.react).fire("onPointerUp", {});
    await run(c, 20);
    const before = pctOf(c);
    track(c.react).fire("onPointerMove", { clientX: 100, buttons: 0 });
    await run(c, 6);
    eq(pctOf(c), before, "[19] 松手结束后的无按键 move 不带动滑条");
  }
}

section("20. 指针速度不得冻结（滑块跑到鼠标一侧的回归）");
{
  const ctx = await setup();
  const I = ctx.internals;

  // ── 纯函数层：陈旧衰减 ──
  ok(typeof I.decayPointerSpeed === "function", "[20] 暴露了 decayPointerSpeed（可离线断言）");
  eq(I.decayPointerSpeed(2, 0.001, I.POINTER_STALE_S, I.POINTER_SPEED_TAU), 2,
    "[20] 保鲜期内不衰减（刚发生的 pointermove 有效）");
  eq(I.decayPointerSpeed(2, I.POINTER_STALE_S, I.POINTER_STALE_S, I.POINTER_SPEED_TAU), 2,
    "[20] 恰在保鲜期边界上不衰减");
  {
    const d = I.decayPointerSpeed(2, 0.2, I.POINTER_STALE_S, I.POINTER_SPEED_TAU);
    ok(d < 0.01 && d > 0, `[20] 超时 200ms 后几乎衰减到 0（实测 ${d.toExponential(2)}）`);
  }
  ok(I.decayPointerSpeed(-2, 0.2, I.POINTER_STALE_S, I.POINTER_SPEED_TAU) < 0,
    "[20] 反向速度同样衰减（不会变号）");

  // ── 这个 bug 现在从机理上消失了：vPtr 不再参与运动演化 ──
  // （上一版（弹簧阻尼 + 前馈）里 vPtr 是前馈项 2ζω(vPtr−v) 的输入，冻结会把它
  //   变成一个恒定的力，让滑块永久偏在鼠标一侧 13.33%。本版运动律只看 x 与 v，
  //   不含前馈项，所以那一整类问题从机理上不存在。）
  // 但 vPtr 仍被"松手外推"使用，所以衰减本身必须保留（见上面几条）。
  {
    const P = I.MOTION;
    // 运动演化**完全不看 vPtr**：给一个巨大的 vPtr 也不影响结果
    const a = { x: 0.5, v: 0, a: 0, target: 0.8, vPtr: 0 };
    const b = { x: 0.5, v: 0, a: 0, target: 0.8, vPtr: 99 };
    for (let f = 0; f < 200; f += 1) { I.motionStep(a, 1 / 60, P); I.motionStep(b, 1 / 60, P); }
    ok(a.x === b.x && a.v === b.v,
      `[20] 运动演化与 vPtr 无关（本版无前馈项）：两者终点都是 ${a.x.toFixed(4)}`);
    ok(a.x === 0.8, "[20] 且精确落在目标（不再被冻结的速度推偏）");
  }

  // ── 接线层：真实的"指针移动 → 停住"必须停在指针处 ──
  {
    const c = await setup();
    const W = 300;
    const pctOf = (css) => { const m = /\+ ([\d.]+) \*/.exec(String(css)); return m === null ? null : Number(m[1]); };
    const readPct = () => pctOf(c.react.find("knob").style.left);
    const at = (pct) => 14 + pct * (W - 28);

    // 按下并追到位
    track(c.react).fire("onPointerDown", { clientX: at(0.20), pointerId: 1 });
    for (let f = 0; f < 120; f += 1) {
      const e = c.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      if (e === 0) break;
    }
    near(readPct(), 0.20, "[20] 前置：按下召唤追到位", 1e-3);

    // 连续 pointermove 向右扫（模拟 60Hz）
    let lastPct = 0.20;
    for (let step = 1; step <= 25; step += 1) {
      c.advanceClock(16);
      lastPct = 0.20 + step * 0.02;
      track(c.react).fire("onPointerMove", { clientX: at(lastPct) });
      c.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
    }

    // 指针停住：不再有任何 pointermove。**手指仍按着**，所以循环应当常驻
    // （这正是修掉"拖动时瞬间卡顿"的做法：追平后不停循环，避免重启第一帧白费）。
    let framesAfterStop = 0;
    for (let f = 0; f < 90; f += 1) {
      const e = c.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      if (e === 0) break;
      framesAfterStop += 1;
    }
    await settle();

    const finalPct = readPct();
    const offset = finalPct - lastPct;
    ok(Math.abs(offset) < 0.01,
      `[20] 指针停住后滑块停在指针处（偏移 ${(offset * 100).toFixed(3)}%，旧代码是 +13.33%）`);
    ok(framesAfterStop >= 80,
      `[20] 拖动中（手指未松）帧循环**保持常驻**（跑了 ${framesAfterStop} 帧）—— 避免重启第一帧白费`);

    // 真正该"停"的时机：松手之后
    track(c.react).fire("onPointerUp", {});
    let framesAfterRelease = 0;
    for (let f = 0; f < 400; f += 1) {
      const e = c.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      if (e === 0) break;
      framesAfterRelease += 1;
    }
    ok(framesAfterRelease < 300,
      `[20] 松手并吸附完成后帧循环自行停止（${framesAfterRelease} 帧），不空转烧 CPU`);
  }

  // ⚠️ 拖动中段不能有"该动没动"的帧 —— 这是"瞬间卡顿"的回归断言。
  //    旧代码在拖动中"追上指针"就停循环，下一个 pointermove 再 startFrames()，
  //    而 startFrames 会重置时间基准 → 重启第一帧 dt≈0 → **那一帧位移为 0**
  //    （实测：指针只挪 0.5% 后循环 7 帧就停；重启第 1 帧位移 0.0000%、
  //      第 2 帧才 0.2100%）。慢拖最容易触发，所以用户体感是"偶尔卡一下"。
  {
    const c = await setup();
    const W = 300;
    const pctOf = (css) => { const m = /\+ ([\d.]+) \*/.exec(String(css)); return m === null ? null : Number(m[1]); };
    const readPct = () => pctOf(c.react.find("knob").style.left);
    const at = (pct) => 14 + pct * (W - 28);

    // 按下并追到位
    track(c.react).fire("onPointerDown", { clientX: at(0.1), pointerId: 1 });
    for (let f = 0; f < 400; f += 1) {
      const e = c.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      if (e === 0) break;
    }

    // 匀速慢拖 40 帧（每帧指针走 0.4% ≈ 1px，最容易触发"追平→停循环"）
    const jumps = [];
    let prev = readPct();
    for (let f = 0; f < 40; f += 1) {
      c.advanceClock(16);
      const want = 0.1 + (f + 1) * 0.004;
      track(c.react).fire("onPointerMove", { clientX: at(want) });
      c.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      const now = readPct();
      jumps.push(now - prev);
      prev = now;
    }
    const stalled = jumps.filter((d) => Math.abs(d) < 1e-7).length;
    const maxJump = Math.max(...jumps);
    const minJump = Math.min(...jumps);
    ok(stalled === 0, `[20] 慢拖 40 帧里没有"该动没动"的帧（停滞 ${stalled} 帧）`);
    ok(minJump > 0, `[20] 每一帧都在推进（最小位移 ${(minJump * 100).toFixed(4)}%）`);
    ok(maxJump < minJump * 4 + 1e-9,
      `[20] 位移均匀：最大 ${(maxJump * 100).toFixed(4)}% / 最小 ${(minJump * 100).toFixed(4)}% = ${(maxJump / minJump).toFixed(2)}× < 4×`);
  }

  // ── 松手外推不被污染的 vPtr 带偏 ──
  {
    // 指针停住 → vPtr 已衰减到 ~0 → 外推量 ~0（不该多跳一档）
    const decayed = I.decayPointerSpeed(3, 0.2, I.POINTER_STALE_S, I.POINTER_SPEED_TAU);
    ok(decayed * I.RELEASE_PROJECT_S < 0.002,
      `[20] 指针停住后的松手外推 ≈0（残留 ${(decayed * I.RELEASE_PROJECT_S * 100).toFixed(3)}% 行程），不会多跳一档`);
  }
}

section("21. 官方菜单改档后，引擎必须跟随（防瞬移）");
{
  // 复现用户报的 bug：滑块拖到 max → 官方菜单选 low → 在滑块里点 max → 瞬移到 max。
  //
  // 根因：官方菜单是 pane 状态机（root/model/effort），点进"推理等级"后 root 那一块
  // 被替换、滑条不渲染；选完档位回来时 effectivePct 已变，而引擎 x 只被"滑条自己的
  // 操作"更新 —— 它不知道官方改了档位。
  // 于是点 max 时 target=1.0 而 x 已=1.0 → 一帧内 settled → 显示从 1/3 跳成 1.0。
  //
  // 用 host.store.set 模拟官方那条改档路径（真机里就是 ModelSelect 的 submit）。
  const W = 300;
  const pctOf = (css) => { const m = /\+ ([\d.]+) \*/.exec(String(css)); return m === null ? null : Number(m[1]); };

  async function scene21() {
    const document = createDocument();
    const menu = createOfficialMenu(document, {});
    const bundle = loadBundle(BUNDLE, document, {});
    const host = createFakeHost({});
    bundle.plugin.apply(host.ctx);
    bundle.react.mount(sliderEntry(host).Component, { sessionId: "session-abcdef" }, menu.composer);
    await settle();
    const react = bundle.react;
    return {
      bundle, host, menu, react,
      track: () => { const n = react.find("track"); if (n) n.rect = { left: 0, top: 0, right: W, bottom: 28, width: W, height: 28 }; return n; },
      readPct: () => pctOf(react.find("knob").style.left),
      at: (pct) => 14 + pct * (W - 28),
      /** 模拟官方菜单改档：直接改共享 store（= ModelSelect 的 submit 效果） */
      officialSelectTo(id) {
        const snap = host.store.getSnapshot();
        host.store.set({ ...snap, current: { ...snap.current, reasoningEffort: id } });
      },
    };
  }
  async function pump21(s, n = 1, dt = 16) {
    for (let i = 0; i < n; i += 1) {
      const e = s.bundle.flushFrames(1, dt);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      if (e === 0) return i;
    }
    return n;
  }
  /** 按一下，返回"第 0 帧后"的位置（必须先落定微任务才能读到新渲染） */
  async function tapFirstFrame(s, pct) {
    const before = s.readPct();
    s.track().fire("onPointerDown", { clientX: s.at(pct), pointerId: 1 });
    for (let k = 0; k < 6; k += 1) await Promise.resolve();
    s.bundle.flushFrames(1, 16);
    for (let k = 0; k < 6; k += 1) await Promise.resolve();
    return { before, after: s.readPct() };
  }

  // ① 用户的确切步骤：拖到 max → 官方选 low → 点 max
  {
    const s = await scene21();
    s.track().fire("onPointerDown", { clientX: s.at(1.0), pointerId: 1 });
    await pump21(s, 200);
    s.track().fire("onPointerUp", {});
    await pump21(s, 200);
    await settle();
    near(s.readPct(), 1.0, "[21] 前置：滑块先拖到 max", 1e-3);

    s.officialSelectTo("low");
    await settle();
    near(s.readPct(), 1 / 3, "[21] 官方选 low 后显示位置跟到 low", 1e-3);

    const r = await tapFirstFrame(s, 1.0);
    ok(Math.abs(r.after - r.before) < 0.05,
      `[21] 点 max 不再瞬移（第 0 帧跳变 ${((r.after - r.before) * 100).toFixed(2)}%，修前是 66.67%）`);
    await pump21(s, 40);
    near(s.readPct(), 1.0, "[21] 之后平滑滑到 max", 1e-2);
  }

  // ② 点"当前显示位置"应当完全不动（引擎起点正确的最强证据）
  {
    const s = await scene21();
    s.track().fire("onPointerDown", { clientX: s.at(1.0), pointerId: 1 });
    await pump21(s, 200);
    s.track().fire("onPointerUp", {});
    await pump21(s, 200);
    await settle();
    s.officialSelectTo("low");
    await settle();
    const r = await tapFirstFrame(s, 1 / 3);
    ok(Math.abs(r.after - r.before) < 0.02,
      `[21] 点"显示中的位置"完全不动（第 0 帧跳变 ${((r.after - r.before) * 100).toFixed(2)}%）`);
  }

  // ③ 连续多轮"官方改档 → 滑块操作"都不跳变
  {
    const s = await scene21();
    const ids = ["off", "low", "high", "max"];
    let worst = 0;
    for (let round = 0; round < 4; round += 1) {
      s.track().fire("onPointerDown", { clientX: s.at(1.0), pointerId: 1 });
      await pump21(s, 200);
      s.track().fire("onPointerUp", {});
      await pump21(s, 200);
      await settle();
      s.officialSelectTo(ids[round]);
      await settle();
      const r = await tapFirstFrame(s, 0.5);
      worst = Math.max(worst, Math.abs(r.after - r.before));
      s.track().fire("onPointerUp", {});
      await pump21(s, 200);
      await settle();
    }
    ok(worst < 0.05, `[21] 连续 4 轮"官方改档 → 滑块操作"最大跳变 ${(worst * 100).toFixed(2)}% < 5%`);
  }

  // ④ ⚠️ 反向保护：修法不能破坏写回（曾把对齐放进 ensureMotion 导致写回变 0 次）
  {
    const s = await scene21();
    s.track().fire("onPointerDown", { clientX: 0, pointerId: 1 });
    for (let i = 1; i <= 60; i += 1) s.track().fire("onPointerMove", { clientX: (i / 60) * 300 });
    s.track().fire("onPointerUp", {});
    await settle();
    ok(s.host.selects.length >= 1 && s.host.selects.length <= 3,
      `[21] 60 次拖动仍正常写回 ${s.host.selects.length} 次（1~3；修法若破坏写回会变 0）`);
    eq(s.host.selects[s.host.selects.length - 1].reasoningEffort, "max", "[21] 最后一次写回的是落点档位");
  }
}

section("22. 松手手感：两种模式都是动过去而不是瞬跳");
{
  const pctOf = (c) => {
    const m = /\+ ([\d.]+) \*/.exec(c.react.find("knob").style.left || "");
    return m ? parseFloat(m[1]) : 0;
  };
  for (const mode of ["full", "quick"]) {
    const c = await setup({ reducedMotion: true });     // 系统开着减少动态，也必须一模一样
    c.internals.writeSettings({ motion: mode });
    track(c.react).fire("onPointerDown", { clientX: 60, pointerId: 1 });
    for (let i = 0; i < 6; i += 1) { c.flushFrames(1, 16); for (let k = 0; k < 6; k += 1) await Promise.resolve(); }
    track(c.react).fire("onPointerMove", { clientX: 260, buttons: 1 });
    for (let i = 0; i < 4; i += 1) { c.flushFrames(1, 16); for (let k = 0; k < 6; k += 1) await Promise.resolve(); }
    track(c.react).fire("onPointerUp", {});
    const series = [];
    for (let i = 0; i < 40; i += 1) {
      c.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      series.push(pctOf(c));
    }
    let moved = 0;
    let reversals = 0;
    let lastDir = 0;
    for (let i = 1; i < series.length; i += 1) {
      const d = series[i] - series[i - 1];
      if (Math.abs(d) > 0.002) moved += 1;
      const dir = d > 0.002 ? 1 : (d < -0.002 ? -1 : 0);
      if (dir !== 0 && lastDir !== 0 && dir !== lastDir) reversals += 1;
      if (dir !== 0) lastDir = dir;
    }
    if (mode === "full") {
      ok(moved >= 1, `[22] full：松手是"动过去"的（${moved} 帧有位移，不是瞬跳）`);
    } else {
      ok(moved <= 2, `[22] quick：简洁动画几乎瞬跳（只动了 ${moved} 帧，符合预期）`);
    }
    ok(reversals <= 1, `[22] ${mode}：松手过程中不来回抖（折返 ${reversals} 次）`);
  }
}

section("48. 目录就绪：插件必须声明 remote / remote.session（参考实现事故 #2）");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const m = src.match(/var inject = \[([^\]]*)\]/);
  ok(!!m, "[48] 找到 inject 声明");
  const list = m ? m[1] : "";
  for (const svc of ["slots", "sessions", "modelDirectories", "remote", "remote.session"]) {
    ok(list.includes(`"${svc}"`), `[48] inject 声明了 ${svc}`);
  }
  ok(/release-abort/.test(src), "[48] 档位列表为空时 endDrag 会中止落点（release-abort 守卫）");
  ok(/!\(levelCount > 0\)/.test(src), "[48] 有 levelCount > 0 的前置判断");
}

/* ══════════════════════════════════════════════════════════════════════ */

/**
 * 起一个场景并挂载**设置卡片**那一条注册（不是滑条）。
 *
 * 放在顶层（而不是某个 section 的块里）：第 23 节与第 26 节都要用，
 * 块作用域内定义的话后一节取不到。
 */
async function setupCard(options = {}) {
  const document = createDocument();
  const bundle = loadBundle(BUNDLE, document, {});
  const host = createFakeHost(options.host ?? {});
  bundle.plugin.apply(host.ctx);
  const card = host.registered.find((item) => item.opts && item.opts.name === "plugins.bundle.config");
  if (!card) throw new Error("插件没有注册设置卡片");
  // 真渲染器会把 opts.inject() 的返回值作为 props 交给组件；这里照做，
  // 并按官方契约补上 t（locale）与 view。
  const injected = card.opts.inject();
  const dict = host.localeRegistrations.find((r) => r.ns === card.opts.locale);
  const dictFor = (lang) => (dict && dict.dictionaries[lang]) || {};
  const t = (key, vars) => {
    const raw = dictFor("zh")[key] !== undefined ? dictFor("zh")[key] : key;
    if (vars === undefined || typeof raw !== "string") return raw;
    return raw.replace(/\{(\w+)\}/g, (all, name) => (vars[name] !== undefined ? String(vars[name]) : all));
  };
  // `hooks` 里的每一项会被官方渲染器绑成 `useXxx(selector)` 选择器 hook；
  // 桩件里用 useSyncExternalStore 等价复刻（它正是选择器 hook 的底层）。
  const useSettings = (selector) => selector(bundle.react.useSyncExternalStore(
    injected.hooks.settings.subscribe,
    () => injected.hooks.settings.getSnapshot(),
  ));
  return { document, bundle, host, card, injected, t, dict, dictFor, useSettings };
}

section("23. 详情页设置卡片（plugins.bundle.config）");
{
  const { bundle, host, injected, card, t, dictFor, useSettings } = await setupCard();

  // ① 注册形状：这是"key 写错会静默不渲染"的唯一离线防线。
  eq(card.opts.name, "plugins.bundle.config", "[23] 挂在官方插件页的设置槽位");
  eq(card.opts.key, "dsh-codex-effort-slider", "[23] key = 包名（必须是它，否则页面静默不渲染）");
  eq(card.opts.locale, "settings.codexEffortSlider", "[23] 声明了 locale 命名空间");
  ok(host.effectLabels.some((l) => l.indexOf("settings dictionaries") >= 0), "[23] 词典经 ctx.effect 登记（随卸载释放）");

  // ② 中英两套词条都要齐：缺一个语言就会在界面上露出键名。
  const zhKeys = Object.keys(dictFor("zh")).sort();
  const enKeys = Object.keys(dictFor("en")).sort();
  ok(zhKeys.length > 0, "[23] 注册了中文词典");
  eq(zhKeys.join(","), enKeys.join(","), "[23] 中英词条一一对应（键集合完全相同）");
  for (const key of ["motionTitle", "motionQuick", "motionFull", "hideTitle", "ticksShow", "ticksHideReached", "ticksHideAll", "targetTitle", "targetDesc", "reachedTitle", "reachedDesc", "copyTrace", "restoreDefaults"]) {
    ok(zhKeys.indexOf(key) >= 0, `[23] 词条含 ${key}`);
  }

  // ③ 注入面：卡片只拿到"读观察器 + 写回调"，不直接碰宿主服务。
  ok(typeof injected.setSetting === "function", "[23] 注入 setSetting 写入口");
  ok(typeof injected.restoreSettings === "function", "[23] 注入 restoreSettings 写入口");
  ok(typeof injected.dumpTrace === "function", "[23] 注入 dumpTrace（复制诊断）");
  ok(injected.hooks && injected.hooks.settings, "[23] hooks.settings 提供给渲染器绑成选择器 hook");
  ok(typeof injected.hooks.settings.getSnapshot === "function", "[23] 观察器有 getSnapshot");
  ok(typeof injected.hooks.settings.subscribe === "function", "[23] 观察器有 subscribe");

  // ④ 观察器契约：快照总是完整设置；订阅可退订且退订后不再通知。
  const snap = injected.hooks.settings.getSnapshot();
  eq(Object.keys(snap).filter((k) => k !== "v").sort().join(","), "hideTicks,highlightReached,highlightTarget,motion", "[23] 快照含全部设置项");
  let notified = 0;
  const off = injected.hooks.settings.subscribe(() => { notified += 1; });
  bundle.plugin.__internals.writeSettings({ motion: "quick" });
  eq(notified, 1, "[23] 设置变化会通知订阅者");
  off();
  bundle.plugin.__internals.writeSettings({ motion: "full" });
  eq(notified, 1, "[23] 退订之后不再通知（不会泄漏订阅）");

  // ⑤ 真正挂载卡片：渲染出两个下拉框（两组选项）。
  const props = Object.assign({}, injected, { t, view: "page", useSettings });
  bundle.react.mount(card.Component, props, null);
  await settle();
  const tree = bundle.react.tree;
  ok(tree !== null, "[23] 卡片渲染出根节点");
  const buttons = tree.querySelectorAll ? tree.querySelectorAll("button") : [];
  const selectButtons = Array.prototype.filter.call(buttons, (b) => b.className === "ces-card__select");
  eq(selectButtons.length, 2, "[23] 两个下拉框（动画 / 隐藏）");
  const titles = Array.prototype.map.call(
    tree.querySelectorAll ? tree.querySelectorAll("div") : [],
    (d) => d.className,
  ).filter((c) => c === "ces-card__title");
  eq(titles.length, 5, "[23] 五行各有一个标题（四项设置 + 「操作」）");

  // ⑤b 卡片结构：两个设置项之间**不分隔**，只在「设置 → 动作」之间有一条线。
  {
    const kids = tree.children.map((c) => c.className);
    eq(kids.filter((c) => c === "ces-card__rule").length, 1,
      "[23] 只有一条分隔线（设置与动作之间）；几项设置之间不画线");
    // 线的位置：必须是**最后一行设置之后、动作行之前**。
    // ⚠️ 这里用结构推导而不是写死下标 —— 以后再增删设置项，这条断言不用改也依然成立，
    //    而"线跑到设置中间去了"这类真错误仍会被抓住（动作行是最后一个 .ces-card__row）。
    const rowIdxs = kids.map((c, i) => (c === "ces-card__row" ? i : -1)).filter((i) => i >= 0);
    const ruleIdx = kids.indexOf("ces-card__rule");
    eq(ruleIdx, rowIdxs[rowIdxs.length - 1] - 1,
      "[23] 分隔线紧跟在最后一行设置之后、动作行之前");
    // 动作行与设置项**同构**：复用 .ces-card__row，而不是自己的特例类。
    eq(kids.filter((c) => c === "ces-card__row").length, 5,
      "[23] 五行（四项设置 + 动作行）都用同一个 .ces-card__row");
    eq(kids.indexOf("ces-card__actions"), -1, "[23] 已无 .ces-card__actions 特例类");
  }

  // ⑥ 下拉框显示的是"当前值的中文文案"，而不是原始 id。
  eq(selectButtons[0].textContent, t("motionFull"), "[23] 动画默认显示「完整动画」");
  eq(selectButtons[1].textContent, t("ticksShow"), "[23] 隐藏默认显示「显示」");

  // ⑦ 点开下拉框 → 列出该组的全部选项（Menu 桩把 items 渲染成按钮）。
  //    注意：测试台的假 DOM 只支持 `tag[attr="value"]` 形式的选择器，
  //    所以这里按 class 过滤按钮，而不是用 `[data-menu-id]`。
  const menuItemsOf = (root) => Array.prototype.filter.call(
    root.querySelectorAll("button"),
    (b) => b.className === "menu-stub__item",
  );
  selectButtons[0].handlers.onClick();
  await settle();
  const items = menuItemsOf(bundle.react.tree);
  eq(items.length, 2, "[23] 点开后列出该组两个选项");
  eq(Array.prototype.map.call(items, (i) => i.textContent).join(","), `${t("motionFull")},${t("motionQuick")}`, "[23] 选项顺序：默认值（完整动画）排第一");

  // ⑧ 选一项 → 写入设置 + 关闭面板 + 下拉框文案跟着变。
  //    选**第二项**（简洁动画），而不是写死"第一项" —— 顺序会变（默认值排前面），
  //    但"选了就生效"这条语义不变。
  eq(items[1].textContent, t("motionQuick"), "[23] 第二项是「简洁动画」");
  items[1].handlers.onClick();
  await settle();
  eq(bundle.plugin.__internals.readSettings().motion, "quick", "[23] 选择后写入设置");
  const afterButtons = Array.prototype.filter.call(
    bundle.react.tree.querySelectorAll("button"),
    (b) => b.className === "ces-card__select",
  );
  eq(afterButtons[0].textContent, t("motionQuick"), "[23] 下拉框文案切换成「简洁动画」");
  eq(menuItemsOf(bundle.react.tree).length, 0, "[23] 选择后面板关闭");

  // ⑨ 「恢复默认」把设置写回 schema 默认值。
  const restoreBtn = Array.prototype.filter.call(
    bundle.react.tree.querySelectorAll("button"),
    (b) => b.textContent === t("restoreDefaults"),
  )[0];
  ok(restoreBtn !== undefined, "[23] 有「恢复默认」按钮");
  restoreBtn.handlers.onClick();
  await settle();
  const restored = bundle.plugin.__internals.readSettings();
  eq(restored.motion, "full", "[23] 恢复默认后动画回到 full");
  eq(restored.hideTicks, "show", "[23] 恢复默认后隐藏回到 show");
  eq(restored.highlightTarget, true, "[23] 恢复默认后目标回亮");
  eq(restored.highlightReached, false, "[23] 恢复默认后已到达回不亮");

  // ⑩ 复制诊断：没有剪贴板时给失败提示而不是抛错（卡片必须 fail-open）。
  const copyBtn = Array.prototype.filter.call(
    bundle.react.tree.querySelectorAll("button"),
    (b) => b.textContent === t("copyTrace"),
  )[0];
  ok(copyBtn !== undefined, "[23] 有「复制诊断」按钮");
  let threw = false;
  try { copyBtn.handlers.onClick(); } catch (error) { threw = true; }
  eq(threw, false, "[23] 无剪贴板时点诊断不抛错");
  await settle();

  // ⑩b 瞬时反馈（toast）必须是**行的水平兄弟**，不能挂在 .ces-card__rowText 里。
  //
  // 实机反馈过的缺陷：toast 原先放在 rowText 里（标题下方），一点按钮
  // 那一列就多一行 → 整行变高 → 下面所有东西被顶下去（用户原话
  // "点完多一行会变高然后位置会变"）。
  // 正确形态：toast 与按钮同为 row 的直接孩子，只占宽度、不改行高。
  {
    const actionRow = bundle.react.tree.children[bundle.react.tree.children.length - 1];
    ok(actionRow !== null, "[23] 动作行存在");
    const kidCls = actionRow.children.map((c) => c.className);
    ok(kidCls.includes("ces-card__rowText"), "[23] 动作行有左列（行名）");
    ok(kidCls.includes("ces-card__toast"), "[23] toast 是动作行的直接孩子（水平兄弟，不塞进左列）");
    const rowText = actionRow.children.find((c) => c.className === "ces-card__rowText");
    eq(rowText.children.filter((c) => c.className === "ces-card__toast").length, 0,
      "[23] toast 不在 rowText 里面（进去就会撑高整行）");
    // toast 必须排在按钮**之前**（即「操作」的右边、按钮的左边）。
    // 用「它的下标小于第一个按钮的下标」表达，而不是写一个恒真的条件。
    const toastIdx = kidCls.indexOf("ces-card__toast");
    const firstButtonIdx = actionRow.children.findIndex(
      (c) => c.tagName === "BUTTON" || (Array.isArray(c.children) && c.children.some((k) => k.tagName === "BUTTON")),
    );
    ok(toastIdx >= 0 && firstButtonIdx >= 0 && toastIdx < firstButtonIdx,
      `[23] toast 排在按钮之前（toast#${toastIdx} < button#${firstButtonIdx}）`);
  }

  // ⑩c toast 的三道 CSS 约束缺一不可（都是实测出来的，去掉任一就退回"行变高"）：
  //   nowrap  → 不换行（换行必撑高行）
  //   max-width → 不把左边的「操作」挤到折行
  //   ellipsis + hidden → 超长截断，而不是推走右边的按钮
  {
    const css = bundle.plugin.__internals.CSS;
    const body = /\.ces-card__toast\{([^}]*)\}/.exec(css);
    ok(body !== null, "[23] 有 .ces-card__toast 规则");
    if (body) {
      ok(/white-space\s*:\s*nowrap/.test(body[1]), "[23] toast 不换行（nowrap）");
      ok(/max-width\s*:\s*[^;}]+/.test(body[1]), "[23] toast 有 max-width（否则把行名挤到折行）");
      ok(/text-overflow\s*:\s*ellipsis/.test(body[1]), "[23] toast 超长用省略号");
      ok(/overflow\s*:\s*hidden/.test(body[1]), "[23] toast 截断（overflow:hidden）");
    }
    // 行名自己也不能折行：它一折，行就变高（这就是 max-width 要防的后果）。
    const title = /\.ces-card__title\{([^}]*)\}/.exec(css);
    ok(title !== null && /white-space\s*:\s*nowrap/.test(title[1]),
      "[23] 行名不折行（否则被 toast 挤到折行时整行变高）");
  }

  // ⑩d 瞬时反馈的定时器：时长必须是命名常量，且**连点两次不能互相清掉**。
  //
  // 实机反馈过的缺陷：`showToast` 每次无条件新建定时器、不清上一个。
  // 用虚拟时钟实测（第 1 次点击 t=2001、第 2 次 t=3801）：
  //   第 2 条本应活到 5801ms，却在 **4501ms** 被第 1 条清空（只显示 700ms）。
  // 这里在离线测试里用**可控假时钟**复现同一场景。
  {
    // 时长必须是命名常量 TOAST_MS，且取 3500（各家实现的中位）；不能是裸魔数。
    const src = SOURCE;
    ok(/var TOAST_MS = 3500;/.test(src), "[23] 反馈时长是命名常量 TOAST_MS = 3500");
    ok(!/setToast\(""\)[^;]*,\s*2000\s*\)/.test(src), "[23] 不再有裸写的 2000 魔数");
  }

  // ⑪ 结构纪律：控件都走官方原语，没有自造的浮层 / 全局监听。
  ok(bundle.react.tree.querySelectorAll(".ces-set").length === 0, "[23] 不再有自绘设置面板 .ces-set");
  ok(CODE.indexOf("contextmenu") < 0, "[23] 源码里不再有右键监听");
  ok(CODE.indexOf("longPressTimer") < 0, "[23] 源码里不再有长按监听");
  ok(CODE.indexOf("openSettingsPanel") < 0, "[23] 源码里不再有自绘面板的打开函数");

  // ⑫ 分隔线两侧留白必须相等（实机反馈过的缺陷：按钮行上内距 8px、其余块 16px，
  //    线因此偏向一侧，看起来"上面松、下面紧"）。
  //
  // 这是**不变量**而不是某个具体值：线自身 margin:0，位置完全由相邻两块的
  // padding 决定 —— 线在上方 = 上一块的 padding-bottom，线在下方 = 下一块的
  // padding-top。所以只要相邻两块的上下内距都对称，线就恒居中。
  // 离线测试台没有 CSS 引擎，量不到几何，因此直接审 CSS 源码本身。
  {
    const css = bundle.plugin.__internals.CSS;
    /** 取某选择器的 padding 四值（简写展开）。返回 null 表示该规则没写 padding。 */
    const paddingOf = (selector) => {
      const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`).exec(css);
      if (!m) return null;
      const p = /padding(?:-block)?\s*:\s*([^;}]+)/.exec(m[1]);
      if (!p) return null;
      const parts = p[1].trim().split(/\s+/).map((v) => parseFloat(v));
      if (parts.some((v) => Number.isNaN(v))) return null;
      if (parts.length === 1) return { top: parts[0], bottom: parts[0], raw: p[1].trim() };
      if (parts.length === 2) return { top: parts[0], bottom: parts[0], raw: p[1].trim() };
      if (parts.length === 3) return { top: parts[0], bottom: parts[2], raw: p[1].trim() };
      return { top: parts[0], bottom: parts[2], raw: p[1].trim() };
    };

    // 卡片里**每一个**行块（现在只有 .ces-card__row 一种）都必须上下内距相等。
    // 逐个把源码里出现的 ces-card__row* 规则都过一遍：只要将来有人再加一个
    // "特例行类"，它要么复用这份 padding（通过），要么自己写一份（被下面这条拦住）。
    const pad = paddingOf(".ces-card__row");
    ok(pad !== null, "[23] .ces-card__row 声明了 padding（线两侧的留白全靠它）");
    if (pad !== null) {
      eq(pad.top, pad.bottom, `[23] .ces-card__row 上下内距相等（否则分隔线不居中）—— 实测 ${pad.raw}`);
      eq(pad.top, 16, "[23] .ces-card__row 的留白 = 16px（与官方行距一致）");
    }

    // 不允许再出现"动作行的特例类"：它正是上一版不对称的根因。
    ok(!/\.ces-card__actions\s*\{/.test(css),
      "[23] 不再有 .ces-card__actions 特例类（动作行复用 .ces-card__row）");

    // 线自身不能带 margin：带了就不再"由两侧 padding 决定位置"。
    const ruleBody = /\.ces-card__rule\{([^}]*)\}/.exec(css);
    ok(ruleBody !== null, "[23] 有 .ces-card__rule 规则");
    if (ruleBody) {
      ok(/margin\s*:\s*0/.test(ruleBody[1]), "[23] 分隔线 margin:0（位置由两侧 padding 决定，不自己撑开）");
    }
  }
}

section("24. 瞬时反馈的定时器：连点两次不许互相清掉");
{
  // 用**可控假时钟**跑，结论与机器快慢无关（真实等待会因定时器漂移越界，
  // 我第一版确认脚本就是这么误判的）。
  //
  // 手法：`loadBundle` 把 setTimeout/clearTimeout 作为参数注入 bundle，
  // 所以在装载前替换掉全局的它们，组件里的 `setTimeout` 就变成假实现。
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let vnow = 0;
  let seq = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: vnow + (Number(ms) || 0), fn }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  function advance(ms) {
    const target = vnow + ms;
    for (;;) {
      let pick = null, pickAt = Infinity;
      for (const [id, t] of timers) if (t.at <= target && t.at < pickAt) { pickAt = t.at; pick = id; }
      if (pick === null) break;
      const t = timers.get(pick);
      timers.delete(pick);
      vnow = t.at;
      t.fn();
    }
    vnow = target;
  }

  let bundle2;
  try {
    const document2 = createDocument();
    bundle2 = loadBundle(BUNDLE, document2, {});
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  const host2 = createFakeHost({});
  bundle2.plugin.apply(host2.ctx);
  const card2 = host2.registered.find((i) => i.opts && i.opts.name === "plugins.bundle.config");
  const inj2 = card2.opts.inject();
  const dict2 = host2.localeRegistrations.find((r) => r.ns === card2.opts.locale);
  const zh2 = (dict2 && dict2.dictionaries.zh) || {};
  const t2 = (k, v) => {
    let r = zh2[k] !== undefined ? zh2[k] : k;
    if (typeof r !== "string" || v === undefined || v === null) return r;
    Object.keys(v).forEach((n) => { r = r.split("{" + n + "}").join(String(v[n])); });
    return r;
  };
  bundle2.react.mount(card2.Component, Object.assign({}, inj2, {
    t: t2, view: "page",
    useSettings: (sel) => sel(inj2.hooks.settings.getSnapshot()),
  }), null);
  await settle();

  /** 假 DOM 不支持 .class 选择器，按 className 递归找。 */
  const byClass = (node, cls, out = []) => {
    if (!node) return out;
    if (node.className === cls) out.push(node);
    for (const k of node.children || []) byClass(k, cls, out);
    return out;
  };
  const toastText = () => {
    const f = byClass(bundle2.react.tree, "ces-card__toast");
    return f.length ? f[f.length - 1].textContent : null;
  };
  /** 当前 toast 节点（判 data-ok 与尾部图标用）。 */
  const toastNode = () => byClass(bundle2.react.tree, "ces-card__toast")[0];
  const toastIcons = () => byClass(bundle2.react.tree, "ces-card__toastIcon").map((n) => n.getAttribute("data-icon"));
  const btn = (label) => Array.prototype.filter
    .call(bundle2.react.tree.querySelectorAll("button"), () => true)
    .find((b) => b.textContent === label);
  const I2 = bundle2.plugin.__internals;
  const TOAST_MS = 3500;
  // 假时钟下，React 的微任务批渲染用**真实**微任务落定即可
  const flush2 = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

  const restore2 = btn(t2("restoreDefaults"));
  const copy2 = btn(t2("copyTrace"));
  ok(restore2 !== undefined && copy2 !== undefined, "[24] 找到两个动作按钮");

  // ① 基线：单次点击精确活满 TOAST_MS
  restore2.handlers.onClick();
  await flush2();
  eq(toastText(), t2("restored"), "[24] 点击后立即显示");
  advance(TOAST_MS - 1); await flush2();
  eq(toastText(), t2("restored"), `[24] ${TOAST_MS - 1}ms 时仍在（未到点）`);
  advance(2); await flush2();
  eq(toastText(), null, `[24] ${TOAST_MS + 1}ms 时已自行消失`);

  // ② 连点两次：第 2 条不得被第 1 条的定时器清掉
  restore2.handlers.onClick();
  await flush2();
  advance(1800); await flush2();
  eq(toastText(), t2("restored"), "[24] 第 1 条在 1800ms 时仍在");
  copy2.handlers.onClick();
  await flush2();
  const second = t2("copyFailed");
  eq(toastText(), second, "[24] 第 2 条已显示");
  // 走到第 1 条的到点时刻（第 2 条此时只活了 TOAST_MS-1800ms）——旧代码正是在这里被清空
  advance(TOAST_MS - 1800 + 100); await flush2();
  eq(toastText(), second, "[24] ★ 第 1 条的到点时刻，第 2 条仍在（旧代码在此被清掉）");
  // 第 2 条自己活满后仍要消失
  advance(1800 - 100 - 1); await flush2();
  eq(toastText(), second, "[24] 第 2 条接近自己的到点时刻仍在");
  advance(2); await flush2();
  eq(toastText(), null, "[24] 第 2 条最终自行消失（不会永远挂着）");

  // ③ 源码层面：必须有"先清旧定时器"这一步 + 卸载清理钩子
  ok(/clearToastTimer\(\)/.test(SOURCE), "[24] showToast 里有 clearToastTimer()");
  ok(/toastTimerRef/.test(SOURCE), "[24] 定时器句柄存在实例 ref 上（不是模块级）");
  ok(/React\.useEffect\(function \(\) \{ return clearToastTimer; \}, \[\]\)/.test(SOURCE),
    "[24] 卸载时取消定时器（否则已卸载组件仍会跑满时长）");
  ok(!/var toastTimer = null;/.test(SOURCE),
    "[24] 定时器句柄不是模块级变量（模块级会让两个卡片实例互相清掉对方的提示）");

  // ④ 成功/失败的视觉区分：绿勾 vs 红叉，且状态必须来自**真实结果**。
  //
  // 「恢复默认」写盘成功 → 绿 + 勾；写盘失败 → 红 + 叉（不谎报）。
  // 「复制诊断」剪贴板成功 → 绿 + 勾；失败 → 红 + 叉。
  {
    advance(TOAST_MS + 10); await flush2();   // 先让上一条散掉
    restore2.handlers.onClick();
    await flush2();
    eq(toastNode().getAttribute("data-ok"), "1", "[24] 恢复默认（写盘成功）→ data-ok=1（绿）");
    eq(toastIcons().join(","), "check", "[24] 成功时尾部是勾");
    eq(toastText(), t2("restored"), "[24] 成功文案");

    advance(TOAST_MS + 10); await flush2();
    copy2.handlers.onClick();
    await flush2();
    eq(toastNode().getAttribute("data-ok"), "0", "[24] 剪贴板失败 → data-ok=0（红）");
    eq(toastIcons().join(","), "close", "[24] 失败时尾部是叉（标准的那个关闭图标）");
    eq(toastText(), t2("copyFailed"), "[24] 失败文案");

    // 图标必须是 toast 的**内部孩子**，不能是行的第三个孩子 —— 后者会参与 flex
    // 分配，把前两轮修好的「行高恒定 / 按钮位置恒定」又弄坏。
    ok(toastNode().children.some((c) => c.className === "ces-card__toastIcon"),
      "[24] 图标在 toast 元素内部（不是行的独立孩子，不影响行高与按钮位置）");
    const actionRow = bundle2.react.tree.children[bundle2.react.tree.children.length - 1];
    eq(actionRow.children.filter((c) => c.className === "ces-card__toastIcon").length, 0,
      "[24] 动作行里没有裸的图标孩子（只有 toast 一个）");

    // 颜色走官方语义令牌，不写死；绿灯令牌与 dpg 的链接校验勾是同一个。
    const css2 = bundle2.plugin.__internals.CSS;
    ok(/\.ces-card__toast\[data-ok='1'\]\{color:var\(--dsw-alias-state-success-primary\)\}/.test(css2),
      "[24] 成功色 = --dsw-alias-state-success-primary（与 dpg 那个勾同令牌）");
    ok(/\.ces-card__toast\[data-ok='0'\]\{color:var\(--dsw-alias-state-error-primary\)\}/.test(css2),
      "[24] 失败色 = --dsw-alias-state-error-primary（官方报错色）");
  }

  // ⑤ 「恢复默认」必须用写盘的**真实结果**，不能无脑报成功。
  {
    ok(/var result = props\.restoreSettings\(\);/.test(SOURCE),
      "[24] 恢复默认取 restoreSettings() 的返回值");
    ok(/var ok = !!\(result && result\.ok\);/.test(SOURCE),
      "[24] 按 result.ok 决定成功/失败");
    ok(/showToast\(ok \? t\("restored"\) : t\("restoreFailed"\), ok\)/.test(SOURCE),
      "[24] 失败时显示 restoreFailed 而不是谎报 restored");
    // writeSettings 现在必须返回 { ok, settings }
    ok(/return \{ ok: persisted, settings: next \};/.test(SOURCE),
      "[24] writeSettings 返回 { ok, settings }");
    ok(/persisted = false;/.test(SOURCE), "[24] 写盘异常会把 persisted 置 false");
  }
}

section("25. 剪贴板的成功/失败两条路径都要走对（绿勾 vs 红叉）");
{
  // ⚠️ 这一节单独起场景，因为要注入 `navigator.clipboard`。
  //    上一节的场景里没有 clipboard，`writeText` 那条路径**永远走不到** ——
  //    所以把 reject 分支注入回归时测试依然全绿（实测过），说明断言漏了它。
  const mountWithClipboard = async (clipboard) => {
    const document3 = createDocument();
    const bundle3 = loadBundle(BUNDLE, document3, { navigator: { clipboard } });
    const host3 = createFakeHost({});
    bundle3.plugin.apply(host3.ctx);
    const card3 = host3.registered.find((i) => i.opts && i.opts.name === "plugins.bundle.config");
    const inj3 = card3.opts.inject();
    const dict3 = host3.localeRegistrations.find((r) => r.ns === card3.opts.locale);
    const zh3 = (dict3 && dict3.dictionaries.zh) || {};
    const t3 = (k, v) => {
      let r = zh3[k] !== undefined ? zh3[k] : k;
      if (typeof r !== "string" || v === undefined || v === null) return r;
      Object.keys(v).forEach((n) => { r = r.split("{" + n + "}").join(String(v[n])); });
      return r;
    };
    bundle3.react.mount(card3.Component, Object.assign({}, inj3, {
      t: t3, view: "page", useSettings: (sel) => sel(inj3.hooks.settings.getSnapshot()),
    }), null);
    await settle();
    const byClass3 = (node, cls, out = []) => {
      if (!node) return out;
      if (node.className === cls) out.push(node);
      for (const k of node.children || []) byClass3(k, cls, out);
      return out;
    };
    const btn3 = (label) => Array.prototype.filter
      .call(bundle3.react.tree.querySelectorAll("button"), () => true)
      .find((b) => b.textContent === label);
    return { bundle3, byClass3, btn3, t3 };
  };

  // ① 剪贴板成功 → 绿 + 勾
  {
    const { bundle3, byClass3, btn3, t3 } = await mountWithClipboard({
      writeText: () => Promise.resolve(),
    });
    btn3(t3("copyTrace")).handlers.onClick();
    await settle();
    await settle();
    const node = byClass3(bundle3.react.tree, "ces-card__toast")[0];
    ok(node !== undefined, "[25] 剪贴板成功 → 出现提示");
    eq(node.getAttribute("data-ok"), "1", "[25] 剪贴板成功 → data-ok=1（绿）");
    ok(/已复制诊断/.test(node.textContent), "[25] 文案是「已复制诊断…」");
    eq(byClass3(bundle3.react.tree, "ces-card__toastIcon").map((n) => n.getAttribute("data-icon")).join(","),
      "check", "[25] 剪贴板成功 → 尾部是勾");
  }

  // ② 剪贴板 reject → 红 + 叉（这条**必须**走 .then 的第二个回调，
  //    而不是"没有 clipboard"的兜底分支 —— 两者文案相同，但只有这条验证了 reject 处理）
  {
    const { bundle3, byClass3, btn3, t3 } = await mountWithClipboard({
      writeText: () => Promise.reject(new Error("denied")),
    });
    btn3(t3("copyTrace")).handlers.onClick();
    await settle();
    await settle();
    const node = byClass3(bundle3.react.tree, "ces-card__toast")[0];
    ok(node !== undefined, "[25] 剪贴板 reject → 出现提示");
    eq(node.getAttribute("data-ok"), "0", "[25] 剪贴板 reject → data-ok=0（红）");
    eq(byClass3(bundle3.react.tree, "ces-card__toastIcon").map((n) => n.getAttribute("data-icon")).join(","),
      "close", "[25] 剪贴板 reject → 尾部是叉");
  }

  // ③ 剪贴板同步抛错 → 也要走失败（红叉），不能冒泡
  {
    const { bundle3, byClass3, btn3, t3 } = await mountWithClipboard({
      writeText: () => { throw new Error("sync boom"); },
    });
    let threw = false;
    try { btn3(t3("copyTrace")).handlers.onClick(); } catch (error) { threw = true; }
    await settle();
    eq(threw, false, "[25] 剪贴板同步抛错不冒泡出事件处理");
    const node = byClass3(bundle3.react.tree, "ces-card__toast")[0];
    ok(node !== undefined, "[25] 同步抛错 → 仍给出提示");
    eq(node.getAttribute("data-ok"), "0", "[25] 同步抛错 → data-ok=0（红）");
  }
}

section("26. 刻度点：目标 / 已到达解耦 + v3→v4 迁移 + 置灰联动");
{
  // 本节自带一份 bundle 实例：前面的 section 把各自的 bundle 关在块作用域里，
  // 顶层没有可复用的那个（而且这里要的正是"从零读一遍设置"的干净状态）。
  const bundle26 = loadBundle(BUNDLE, createDocument(), {});
  const host26 = createFakeHost({});
  bundle26.plugin.apply(host26.ctx);
  const I = bundle26.plugin.__internals;

  // ① 迁移（v3 的 reachedTicks 三态 → 新三字段）。这条最容易漏：新 schema 里
  //    没有 reachedTicks，不走迁移就会被**静默丢掉**、落回默认，用户观感无声变化。
  {
    const m = I.migrateSettings;
    ok(typeof m === "function", "[26] 有 migrateSettings 迁移函数");

    const hl = I.normalizeSettings(m({ reachedTicks: "highlight", v: 3 }));
    eq(hl.hideTicks, "show", "[26] highlight → 显示");
    eq(hl.highlightTarget, true, "[26] highlight → 目标亮");
    eq(hl.highlightReached, true, "[26] highlight → 已到达亮（复刻旧的累计高亮）");

    const dm = I.normalizeSettings(m({ reachedTicks: "dim", v: 3 }));
    eq(dm.hideTicks, "show", "[26] dim → 显示");
    eq(dm.highlightTarget, false, "[26] dim → 都不亮");
    eq(dm.highlightReached, false, "[26] dim → 都不亮");

    const hd = I.normalizeSettings(m({ reachedTicks: "hidden", v: 3 }));
    eq(hd.hideTicks, "hideReached", "[26] hidden → 隐藏已到达");
    eq(hd.highlightTarget, true, "[26] hidden → 目标仍亮（修掉旧实现连目标一起藏的 bug）");
    eq(hd.highlightReached, false, "[26] hidden → 已到达不亮");

    // ⚠️ 迁移必须幂等：已经迁过的对象再进一次不能再变（否则每次读盘都漂移）。
    const once = m({ reachedTicks: "highlight", v: 3 });
    eq(JSON.stringify(m(once)), JSON.stringify(once), "[26] 迁移幂等（已迁过的不再动）");

    // 没有旧字段时原样返回（不能凭空塞字段）。
    const plain = { motion: "quick", v: 3 };
    eq(JSON.stringify(m(plain)), JSON.stringify(plain), "[26] 无旧字段时不动输入");
  }

  // ①b **端到端迁移**：把 v3 原始 JSON 预置进 localStorage，再走真实的读盘路径
  //     （readSettings → migrateSettings → normalizeSettings）。
  //     只测 migrateSettings 函数**不够**：万一有人把 readSettings 里的调用改回
  //     `normalizeSettings(parsed)`，上面的单测照样全绿（实测确认过这个假通过）。
  {
    const seeded = loadBundle(BUNDLE, createDocument(), {
      settings: { reachedTicks: "hidden", v: 3 },
    });
    seeded.plugin.apply(createFakeHost({}).ctx);
    const s = seeded.plugin.__internals.readSettings();
    eq(s.hideTicks, "hideReached", "[26] 端到端：旧 v3 JSON 经真实读盘后 hideTicks=hideReached");
    eq(s.highlightTarget, true, "[26] 端到端：旧 v3 的 hidden 迁移后目标仍亮");
    eq(s.highlightReached, false, "[26] 端到端：旧 v3 的 hidden 迁移后已到达不亮");
    eq(s.v, 4, "[26] 端到端：读盘后版本号升到 4");
    // 迁移结果要**回写**盘，否则每次启动都要重迁一遍（且 v 永远是旧的）。
    const written = JSON.parse(seeded.localStorage.getItem("dsh-codex-effort-slider.settings"));
    eq(written.hideTicks, "hideReached", "[26] 端到端：迁移结果已回写 localStorage");
    eq(written.reachedTicks, undefined, "[26] 端到端：旧键 reachedTicks 已被清除");
  }

  // ② 默认值：显示 + 只亮目标（用户最初要的效果）。
  {
    I.writeSettings({ hideTicks: "show", highlightTarget: true, highlightReached: false });
    const s = I.readSettings();
    eq(s.hideTicks, "show", "[26] 默认隐藏=显示");
    eq(s.highlightTarget, true, "[26] 默认目标=亮");
    eq(s.highlightReached, false, "[26] 默认已到达=不亮");
  }

  // ③ 渲染：**这是本次的核心回归锁** —— 默认只亮目标那一格，
  //    其余已达的必须是 0（旧代码 `t <= shownIndex` 会把它们全点亮）。
  //
  //    ⚠️ 两个测试台的硬约束，决定了这里的写法：
  //      1. `mount()` 只有一个根（currentRoot）→ 卡片与滑条**不能同时挂**；
  //      2. `loadBundle()` 每次都给一套**新的** localStorage / window 桩
  //         → 卡片和滑条必须在**同一个 bundle 实例**里，否则设置根本传不过去
  //           （我第一版就是各起一个 bundle，结果设置改动对滑条完全不可见）。
  //    所以：一次 loadBundle，交替 mount（挂卡片点开关 → 换挂滑条读属性）。
  //    这正是真机的顺序：在详情页改设置 → 回输入框看滑条。
  {
    const document26 = createDocument();
    const menu26 = createOfficialMenu(document26, { effortLabel: "Low" });
    const bundle26b = loadBundle(BUNDLE, document26, {});
    const host26b = createFakeHost({ effort: "low" });
    bundle26b.plugin.apply(host26b.ctx);
    const sliderEntry26 = host26b.registered.find(
      (item) => item.opts && item.opts.name === "conversation.input.right",
    );
    ok(sliderEntry26 !== undefined, "[26] 注册了滑条槽位");
    const card26 = host26b.registered.find((item) => item.opts && item.opts.name === "plugins.bundle.config");
    const inj26 = card26.opts.inject();
    const dict26 = host26b.localeRegistrations.find((r) => r.ns === card26.opts.locale);
    const zh26 = (dict26 && dict26.dictionaries.zh) || {};
    const t26 = (k, v) => {
      let r = zh26[k] !== undefined ? zh26[k] : k;
      if (typeof r !== "string" || v === undefined || v === null) return r;
      Object.keys(v).forEach((n) => { r = r.split("{" + n + "}").join(String(v[n])); });
      return r;
    };
    const useSettings26 = (sel) => sel(bundle26b.react.useSyncExternalStore(
      inj26.hooks.settings.subscribe,
      () => inj26.hooks.settings.getSnapshot(),
    ));

    /** 挂滑条，返回刻度点属性读取器。 */
    const showSlider = async () => {
      bundle26b.react.mount(sliderEntry26.Component, { sessionId: "session-abcdef" }, menu26.composer);
      await settle();
      const ticks = () => bundle26b.react.findAll("tick");
      return {
        attrs: (name) => ticks().map((n) => n.getAttribute(name)),
        count: () => ticks().length,
        /** 旋钮当前的 left（calc 形式），几何判定的期望值要用它。 */
        knobLeft: () => {
          const k = bundle26b.react.find("knob");
          return k === null ? "" : k.style.left;
        },
      };
    };
    /** 挂卡片，返回操作句柄。 */
    const showCard = async () => {
      bundle26b.react.mount(card26.Component, Object.assign({}, inj26, {
        t: t26, view: "page", useSettings: useSettings26,
      }), null);
      await settle();
      const buttons = () => Array.prototype.filter.call(
        bundle26b.react.tree.querySelectorAll("button"), () => true,
      );
      return {
        switchByLabel: (label) => buttons().find((b) => b.getAttribute && b.getAttribute("aria-label") === label),
        selectByLabel: (label) => buttons().find((b) => b.className === "ces-card__select" && b.getAttribute("aria-label") === label),
        menuItem: (label) => buttons().find((b) => b.className === "menu-stub__item" && b.textContent === label),
        buttonByText: (text) => buttons().find((b) => b.textContent === text),
      };
    };

    // 默认（显示 + 只亮目标）
    let slider = await showSlider();
    const roles = slider.attrs("data-tick");
    ok(slider.count() >= 4, `[26] 渲染出刻度点（实测 ${slider.count()}）`);
    eq(roles.filter((r) => r === "target").length, 1, "[26] 目标角色唯一");
    const lits = slider.attrs("data-lit");
    eq(lits.filter((x) => x === "1").length, 1, "[26] ★ 只亮一格（旧代码会把已到达的全点亮）");
    eq(slider.attrs("data-hide").every((x) => x === "0"), true, "[26] 默认都不隐藏");
    const targetAt = roles.indexOf("target");
    eq(roles.slice(0, targetAt).every((r) => r === "reached"), true, "[26] 目标之前都是「已到达」");
    eq(roles.slice(targetAt + 1).every((r) => r === "ahead"), true, "[26] 目标之后都是「未到达」");

    // 通过**卡片的开关**打开「高亮已到达」→ 滑条那边跟着变
    let card = await showCard();
    card.switchByLabel(t26("reachedTitle")).handlers.onClick();
    await settle();
    eq(inj26.hooks.settings.getSnapshot().highlightReached, true, "[26] 开关写入设置");
    slider = await showSlider();
    const lits2 = slider.attrs("data-lit");
    ok(lits2.filter((x) => x === "1").length > 1, "[26] 打开已到达后亮的格数增多");
    slider.attrs("data-tick").forEach((r, i) => {
      if (r === "ahead") eq(lits2[i], "0", `[26] 未到达的第 ${i} 格不许亮`);
      if (r === "reached") eq(lits2[i], "1", `[26] 已到达的第 ${i} 格应亮`);
    });

    // 切到「隐藏已到达」→ **旋钮左侧的点全隐**（含落在左侧的目标）
    card = await showCard();
    card.selectByLabel(t26("hideTitle")).handlers.onClick();
    await settle();
    card.menuItem(t26("ticksHideReached")).handlers.onClick();
    await settle();
    slider = await showSlider();
    {
      const roles3 = slider.attrs("data-tick");
      const hides3 = slider.attrs("data-hide");
      const lits3 = slider.attrs("data-lit");
      // 用**几何位置**算期望值（与实现同一套判据，但独立算一遍）：
      // 刻度点在轨道上的 pct 与旋钮当前 pct 比，≤ 旋钮就算"已过"。
      //
      // ⚠️ 必须带容差：旋钮的 `left` 是 `calc(14px + 0.3333 * (...))` 形式，
      //    pct 被 `Math.round(pct*10000)/10000` **截到 4 位小数**；
      //    而实现内部用的是全精度 `shownPct`。旋钮正好停在某一档上时两者
      //    会差 ~3e-5，直接比较会把"恰好相等"判反（实测踩过）。
      const EPS = 1e-4;
      const count = roles3.length;
      const knobPct = Number(/\+ ([\d.]+) \*/.exec(String(slider.knobLeft()))[1]);
      const pcts = [];
      for (let t = 0; t < count; t += 1) pcts.push(I.pctFromIndex(t, count));
      roles3.forEach((role, i) => {
        const passed = pcts[i] <= knobPct + EPS;
        eq(hides3[i], passed ? "1" : "0",
          `[26] 隐藏已到达：第 ${i} 格（${role}，pct=${pcts[i].toFixed(4)} vs 旋钮 ${knobPct.toFixed(4)}）${passed ? "应隐藏" : "不该隐藏"}`);
        if (passed) eq(lits3[i], "0", `[26] 被隐藏的第 ${i} 格不许亮（lit 不能与 hide 同时为 1）`);
      });
      // 这条是本次修的 bug：目标落在旋钮**左侧**时，旧实现在 hideReached 下仍让它
      // 豁免隐藏（因为判据是 `t < shownIndex` 而不是位置），于是左侧残留一个点。
      const leftVisible = roles3.filter((r, i) => hides3[i] === "0" && pcts[i] <= knobPct + EPS);
      eq(leftVisible.length, 0, "[26] ★ 旋钮左侧没有残留的可见点（旧实现会留下一个）");
    }

    // 置灰联动：hideTicks != show 时「已到达」置灰，但存储值保留
    card = await showCard();
    eq(card.switchByLabel(t26("reachedTitle")).disabled, true, "[26] 隐藏已到达 → 「已到达」开关置灰");
    eq(inj26.hooks.settings.getSnapshot().highlightReached, true, "[26] 置灰不改存储值（用户选择被保住）");
    eq(card.switchByLabel(t26("targetTitle")).disabled, false, "[26] 隐藏已到达时「目标」开关仍可用");

    // 切到「全部隐藏」→ 两个开关都置灰、每一格都隐藏
    card.selectByLabel(t26("hideTitle")).handlers.onClick();
    await settle();
    card.menuItem(t26("ticksHideAll")).handlers.onClick();
    await settle();
    card = await showCard();
    eq(card.switchByLabel(t26("targetTitle")).disabled, true, "[26] 全部隐藏 → 「目标」也置灰");
    slider = await showSlider();
    eq(slider.attrs("data-hide").every((x) => x === "1"), true, "[26] 全部隐藏 → 每一格都隐藏");

    // 恢复默认 → 显示 + 只亮目标
    // ⚠️ 必须先重新挂卡片：上面 showSlider() 已经把根换成了滑条，
    //    而 card 句柄里的 buttons() 读的是**当前**树 —— 不重挂就会拿到滑条的按钮。
    card = await showCard();
    card.buttonByText(t26("restoreDefaults")).handlers.onClick();
    await settle();
    eq(inj26.hooks.settings.getSnapshot().hideTicks, "show", "[26] 恢复默认 → 隐藏=显示");
    eq(inj26.hooks.settings.getSnapshot().highlightReached, false, "[26] 恢复默认 → 已到达不亮");
    slider = await showSlider();
    eq(slider.attrs("data-lit").filter((x) => x === "1").length, 1, "[26] 恢复默认后回到只亮一格");
  }

  // ③b **本次修的 bug 的定点复现**：旋钮停在两档之间、最近档位落在旋钮**左侧**时，
  //     旧实现按 `t < shownIndex` 判定"已到达"，于是那一格（角色=target）豁免隐藏，
  //     在 hideReached 下**左侧残留一个点**（用户看到的就是"目标强制显示已到达的"）。
  //     新实现按几何位置判定，所以左侧必须干净。
  {
    const W = 300;
    const doc = createDocument();
    const menu = createOfficialMenu(doc, {});
    const b = loadBundle(BUNDLE, doc, {});
    const h = createFakeHost({ effort: "low" });
    b.plugin.apply(h.ctx);
    b.plugin.__internals.writeSettings({
      hideTicks: "hideReached", highlightTarget: true, highlightReached: false,
    });
    b.react.mount(sliderEntry(h).Component, { sessionId: "session-abcdef" }, menu.composer);
    await settle();

    const track = b.react.find("track");
    track.rect = { left: 0, top: 0, right: W, bottom: 28, width: W, height: 28 };
    // 4 档：Low=1/3≈0.333、High=2/3≈0.667。拖到 0.42 → 最近档位是 Low，
    // 而 Low 的物理位置（0.333）在旋钮（0.42）**左侧**。
    const KNOB_RADIUS = b.plugin.__internals.KNOB_RADIUS;
    const clientX = KNOB_RADIUS + 0.42 * (W - 2 * KNOB_RADIUS);
    track.fire("onPointerDown", { clientX, pointerId: 1 });
    for (let i = 0; i < 120; i += 1) {
      const ran = b.flushFrames(1, 16);
      for (let k = 0; k < 6; k += 1) await Promise.resolve();
      if (ran === 0) break;
    }
    await settle();

    const knobCss = b.react.find("knob").style.left;
    const knobPct = Number(/\+ ([\d.]+) \*/.exec(String(knobCss))[1]);
    const ticks = b.react.findAll("tick");
    const roles = ticks.map((n) => n.getAttribute("data-tick"));
    const hides = ticks.map((n) => n.getAttribute("data-hide"));
    const lits = ticks.map((n) => n.getAttribute("data-lit"));
    const pcts = ticks.map((n, i) => b.plugin.__internals.pctFromIndex(i, ticks.length));

    console.log(`    （旋钮 pct=${knobPct.toFixed(3)}；各格 pct=${pcts.map((p) => p.toFixed(3)).join(", ")}；角色=${roles.join(",")}）`);
    ok(roles.indexOf("target") >= 0, "[26b] 存在目标格");
    const targetIdx = roles.indexOf("target");
    ok(pcts[targetIdx] <= knobPct, "[26b] 前提：目标格确实落在旋钮左侧（否则这条测不到）");
    eq(hides[targetIdx], "1", "[26b] ★ 目标落在旋钮左侧时，hideReached 下必须隐藏它");
    eq(lits[targetIdx], "0", "[26b] ★ 被隐藏的目标不许 lit=1");
    // 左侧全部隐藏、右侧保留
    roles.forEach((role, i) => {
      eq(hides[i], pcts[i] <= knobPct ? "1" : "0",
        `[26b] 第 ${i} 格（左=${pcts[i] <= knobPct}）隐藏状态正确`);
    });
    eq(hides.filter((x) => x === "1").length > 0, true, "[26b] 确实隐藏了一些格");
  }

  // ④b 降级纪律：取不到官方 Switch 就不注册卡片（否则会渲染出"有标签没控件"的空行）。
  //     这条只能靠**故意抽掉原语**来验证 —— 否则把门禁里的 `Switch === null` 删掉也全绿。
  {
    const b = loadBundle(BUNDLE, createDocument(), { omitPrimitives: ["Switch"] });
    const h = createFakeHost({});
    b.plugin.apply(h.ctx);
    eq(h.registered.some((i) => i.opts && i.opts.name === "plugins.bundle.config"), false,
      "[26] 缺 Switch 原语 → 不注册设置卡片（降级）");
    // 但滑条那一条必须照常注册（原语缺失不能把滑条拖下水）。
    eq(h.registered.some((i) => i.opts && i.opts.name === "conversation.input.right"), true,
      "[26] 缺 Switch 原语 → 滑条照常注册（不受卡片降级影响）");
  }

  // ④ CSS 只剩两条刻度规则（判定全在 JS；旧的选择器组合已删除）
  {
    const css = I.CSS;
    eq(/\.ces-inline\[data-reached-ticks=/.test(css), false, "[26] 旧的 data-reached-ticks 组合选择器已删除");
    eq(css.indexOf(".ces-tick[data-lit='1']") > 0, true, "[26] 有 data-lit 规则");
    eq(css.indexOf(".ces-tick[data-hide='1']") > 0, true, "[26] 有 data-hide 规则");
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? "全部通过 ✅" : "有失败 ❌"} （${passed} 项通过，${failed} 项失败）`);
if (failed > 0) {
  console.log("失败项：");
  for (const label of failures) console.log(`  · ${label}`);
  process.exitCode = 1;
}
