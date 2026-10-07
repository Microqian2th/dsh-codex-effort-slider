/**
 * 离线测试台 —— 让 `lib/client.js` 在没有浏览器、没有真 React 的机器上也能被真跑一遍。
 *
 * 三块桩件：
 *   · `FakeNode` / `createDocument()`  —— 够用的假 DOM（属性、样式、事件、rect、contains）
 *   · `createReactStub()`              —— **保状态**的 React 桩（useState/useRef/useMemo/
 *                                         useCallback/useEffect/useSyncExternalStore + 渲染 → 假 DOM）
 *   · `createFakeHost()`               —— 假宿主：官方形状的 modelDirectories / sessions / slots
 *
 * 为什么值得写这么多：这个插件的全部价值都在「拖动真的写回官方档位」和「不把宿主搞坏」
 * 这两件事上，而它们只有在真跑组件时才能验证。没有真 React 可用（本机 app.asar 里不带
 * react），所以用一个**会保留跨渲染状态**的桩 —— 状态不保留的桩会让去重/限频/乐观值
 * 这些用例假通过（社区同类插件的测试升级记录里踩过同一个坑）。
 */
import { readFileSync } from "node:fs";

/* ───────────────────────────── 假 DOM ───────────────────────────── */

/**
 * 选择器匹配：支持 `tag`、`[attr="value"]`、`tag[attr="value"]`，
 * 以及**多个属性串联**（`button[aria-haspopup="menu"][aria-expanded="true"]` ——
 * 插件的 DOM 桥正是用这条选择器找"打开的那颗官方席"）。
 */
function matches(node, selector) {
  if (typeof selector !== "string" || selector.length === 0) return false;
  const parsed = /^([a-zA-Z0-9-]*)((?:\s*\[[a-zA-Z0-9-]+="[^"]*"\])*)$/.exec(selector.trim());
  if (!parsed) return false;
  const [, tag, attrPart] = parsed;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const attrs = attrPart.match(/\[([a-zA-Z0-9-]+)="([^"]*)"\]/g) ?? [];
  for (const attr of attrs) {
    const [, name, value] = /\[([a-zA-Z0-9-]+)="([^"]*)"\]/.exec(attr);
    if (node.getAttribute(name) !== value) return false;
  }
  return true;
}

class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this._text = undefined;
    this.handlers = {};
    this.listeners = new Map();
    this.rect = { left: 0, top: 0, right: 200, bottom: 28, width: 200, height: 28 };
  }

  /** 插件在向上找 composer 时会判 nodeType === 1，所以文本节点要给 3。 */
  get nodeType() {
    return this.tagName === "#TEXT" ? 3 : 1;
  }

  /** 像 DOM 一样：元素是后代文本的拼接，文本节点就是自己的字符串。 */
  get textContent() {
    if (this._text !== undefined) return this._text;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    const set = this.listeners.get(type);
    if (set) set.delete(listener);
  }

  /** 触发挂在**属性**上的处理器（React 的 onClick/onPointerDown…）。 */
  fire(prop, event) {
    const handler = this.handlers[prop];
    if (typeof handler !== "function") return undefined;
    return handler(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, event));
  }

  /** 触发用 addEventListener 注册的处理器（假 document/window 用）。 */
  dispatch(type, event) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) listener(Object.assign({ type, target: this, preventDefault() {} }, event));
  }

  contains(node) {
    if (node === this) return true;
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setPointerCapture(pointerId) {
    this.capturedPointer = pointerId;
  }

  releasePointerCapture() {
    this.capturedPointer = null;
  }

  focus() {}

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export function createDocument() {
  const documentElement = new FakeNode("html");
  const head = new FakeNode("head");
  const body = new FakeNode("body");
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  /** 按 id 找元素（插件的 DOM 桥用 aria-controls + getElementById 定位官方菜单）。 */
  const byId = (id) => {
    const found = documentElement.querySelectorAll(`[id="${id}"]`);
    return found.length > 0 ? found[0] : null;
  };
  const document = {
    documentElement,
    head,
    body,
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    getElementById: (id) => byId(id),
    addEventListener: (type, listener) => documentElement.addEventListener(type, listener),
    removeEventListener: (type, listener) => documentElement.removeEventListener(type, listener),
    dispatch: (type, event) => documentElement.dispatch(type, event),
  };
  return document;
}

/**
 * 造一份"官方模型菜单"：席(aria-haspopup/aria-expanded/aria-controls) + 菜单(role=menu)
 * + 根面板两行(模型 / 推理等级)，形状逐字对齐 app.asar 里 ModelSelect 的产物。
 *
 * @param document createDocument() 的结果
 * @param options  { effortLabel?: string, modelLabel?: string, open?: boolean, reasoning?: boolean }
 * @returns { composer, seat, menu, modelRow, effortRow, close() }
 */
export function createOfficialMenu(document, options = {}) {
  const composer = new FakeNode("div");
  composer.setAttribute("data-composer-card", "");
  composer.setAttribute("data-ces-test-composer", "1");
  document.body.appendChild(composer);

  const seat = new FakeNode("button");
  seat.setAttribute("aria-haspopup", "menu");
  seat.setAttribute("aria-expanded", options.open === false ? "false" : "true");
  seat.setAttribute("aria-controls", "model-menu");
  // 官方席按钮上就是这两段文字：模型名 + 当前档位名（后者官方用哈希 class，我按文字认它）
  const seatModelSpan = new FakeNode("span");
  seatModelSpan.className = "wq12jW_triggerLabel";
  seatModelSpan.textContent = options.modelLabel ?? "DeepSeek-V41-Flash";
  const seatEffortSpan = new FakeNode("span");
  seatEffortSpan.className = "wq12jW_triggerEffort";
  seatEffortSpan.textContent = options.effortLabel ?? "High";
  seat.appendChild(seatModelSpan);
  seat.appendChild(seatEffortSpan);
  composer.appendChild(seat);

  const menu = new FakeNode("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("id", "model-menu");
  document.body.appendChild(menu); // 官方是 portal 到 body 的

  const makeRow = (label, value) => {
    const row = new FakeNode("button");
    row.setAttribute("role", "menuitem");
    row.className = "cell";
    const labelSpan = new FakeNode("span");
    labelSpan.className = "cellLabel";
    labelSpan.textContent = label;
    const valueSpan = new FakeNode("span");
    valueSpan.className = "cellValue"; // 官方真实 DOM 里就是这个 class（见第 12 节对照）
    valueSpan.textContent = value;
    const chevron = new FakeNode("svg");
    chevron.className = "cellChevron";
    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    row.appendChild(chevron);
    menu.appendChild(row);
    return { row, labelSpan, valueSpan };
  };

  const model = makeRow("模型", options.modelLabel ?? "DeepSeek-V41-Flash");
  const effort = options.reasoning === false ? null : makeRow("推理等级", options.effortLabel ?? "High");
  const modelRow = model.row;
  const effortRow = effort === null ? null : effort.row;

  return {
    composer,
    seat,
    seatLabelEl: seatModelSpan,
    seatEffortEl: seatEffortSpan,
    menu,
    modelRow,
    effortRow,
    modelLabelEl: model.labelSpan,
    modelValueEl: model.valueSpan,
    effortLabelEl: effort === null ? null : effort.labelSpan,
    effortValueEl: effort === null ? null : effort.valueSpan,
    close() {
      seat.setAttribute("aria-expanded", "false");
      menu.remove();
    },
  };
}

/* ─────────────────────────── React 桩 ─────────────────────────── */

const FRAGMENT = Symbol.for("react.fragment");
const ELEMENT = Symbol.for("react.element");

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * 只支持**函数组件 + 单根**的保状态渲染器。
 *
 * 关于 hook 作用域：整套桩共用一条 hook 列表，因此假定渲染树里**只有一个真正用 hook
 * 的组件**（本插件的组件就是），嵌在它外面的无 hook 包装组件不消耗 hook 槽位。
 */
export function createReactStub() {
  const hooks = [];
  const portalHosts = [];
  let cursor = 0;
  let currentRoot = null;
  let pendingEffects = [];
  let scheduled = false;
  let rendering = false;
  let renderCount = 0;
  let uSESDepthGuard = 0;

  const react = {
    Fragment: FRAGMENT,
    /** react-dom 的 createPortal：本插件用它把滑条渲染进官方菜单那一行。 */
    createPortal(children, container) {
      return { __portal: true, props: { children }, container };
    },
    createElement(type, props, ...children) {
      const normalized = {};
      if (props) for (const key of Object.keys(props)) normalized[key] = props[key];
      const flat = [];
      const push = (child) => {
        if (Array.isArray(child)) { child.forEach(push); return; }
        if (child === null || child === undefined || child === false || child === true) return;
        flat.push(child);
      };
      push(children);
      normalized.children = flat.length <= 1 ? flat[0] : flat;
      return { $$typeof: ELEMENT, type, props: normalized, __flat: flat };
    },
    useState(initial) {
      const slot = slotAt(cursor++, "state");
      if (!slot.ready) {
        slot.value = typeof initial === "function" ? initial() : initial;
        slot.ready = true;
      }
      const setter = (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        scheduleRender();
      };
      return [slot.value, setter];
    },
    useRef(initial) {
      const slot = slotAt(cursor++, "ref");
      if (!slot.ready) {
        slot.value = { current: initial };
        slot.ready = true;
      }
      return slot.value;
    },
    useMemo(factory, deps) {
      const slot = slotAt(cursor++, "memo");
      if (!slot.ready || !sameDeps(slot.deps, deps)) {
        slot.value = factory();
        slot.deps = deps;
        slot.ready = true;
      }
      return slot.value;
    },
    useCallback(factory, deps) {
      return react.useMemo(() => factory, deps);
    },
    useEffect(effect, deps) {
      const slot = slotAt(cursor++, "effect");
      const changed = !slot.ready || !sameDeps(slot.deps, deps);
      if (changed) {
        slot.deps = deps;
        slot.ready = true;
        pendingEffects.push({ slot, effect });
      }
      return undefined;
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const slot = slotAt(cursor++, "uses");
      if (!slot.ready || slot.subscribe !== subscribe) {
        if (typeof slot.unsubscribe === "function") slot.unsubscribe();
        slot.subscribe = subscribe;
        slot.unsubscribe = subscribe(scheduleRender);
        slot.ready = true;
      }
      const value = getSnapshot();
      slot.value = value;
      slot.getSnapshot = getSnapshot;
      return value;
    },
  };

  function slotAt(index, kind) {
    if (hooks.length <= index) hooks.push({ kind });
    const slot = hooks[index];
    if (slot.kind !== kind) {
      throw new Error(`hook 顺序变了：第 ${index} 个槽位是 ${slot.kind}，本次拿到 ${kind}`);
    }
    if (slot.hookIndex === undefined) slot.hookIndex = index;
    return slot;
  }

  function scheduleRender() {
    if (scheduled || rendering) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (currentRoot !== null) render();
    });
  }

  function renderElement(element, parent) {
    if (element === null || element === undefined || element === false || element === true) return null;
    if (typeof element === "string" || typeof element === "number") {
      const text = new FakeNode("#text");
      text.textContent = String(element);
      if (parent) parent.appendChild(text);
      return text;
    }
    // portal：内容渲染进**另一个容器**（本插件就是靠它把滑条塞进官方菜单那一行）
    if (element.__portal === true) {
      if (element.container && !portalHosts.includes(element.container)) portalHosts.push(element.container);
      return renderChildren(element.props.children, element.container);
    }
    const { type, props } = element;
    if (type === FRAGMENT) return renderChildren(props.children, parent);
    if (typeof type === "function") return renderElement(type(props), parent);

    const node = new FakeNode(type);
    for (const key of Object.keys(props)) {
      if (key === "children") continue;
      const value = props[key];
      if (key === "style") { node.style = Object.assign({}, value); continue; }
      if (key === "ref") {
        if (typeof value === "function") value(node);
        else if (value && typeof value === "object") value.current = node;
        continue;
      }
      if (key.startsWith("on") && typeof value === "function") { node.handlers[key] = value; continue; }
      if (key === "className") { node.className = value; node.setAttribute("class", value); continue; }
      if (value === undefined || value === null || value === false) continue;
      if (value === true) { node.setAttribute(key, ""); continue; }
      node.setAttribute(key, value);
    }
    if (parent) parent.appendChild(node);
    renderChildren(props.children, node);
    return node;
  }

  function renderChildren(children, parent) {
    if (children === null || children === undefined || children === false || children === true) return;
    if (Array.isArray(children)) {
      for (const child of children) renderElement(child, parent);
      return;
    }
    renderElement(children, parent);
  }

  function render() {
    rendering = true;
    cursor = 0;
    pendingEffects = [];
    // 桩件不做 diff：每次重渲前把上一次的产物摘掉、portal 容器清空，
    // 否则重复渲染会叠加出多份 DOM，测试就会查到上一次的陈旧节点。
    if (currentRoot !== null && currentRoot.node && currentRoot.node.parentNode) {
      currentRoot.node.parentNode.removeChild(currentRoot.node);
    }
    for (const container of portalHosts) container.children.length = 0;
    portalHosts.length = 0;
    const parent = currentRoot.parent ?? null;
    const host = parent ?? new FakeNode("div");
    renderElement(react.createElement(currentRoot.type, currentRoot.props), host);
    currentRoot.host = host;
    currentRoot.node = parent !== null ? (host.children[host.children.length - 1] ?? null) : (host.children[0] ?? null);
    rendering = false;
    renderCount += 1;

    // 效果：先跑上一次的清理，再跑本次的。
    for (const { slot, effect } of pendingEffects) {
      if (typeof slot.cleanup === "function") {
        try { slot.cleanup(); } catch (error) { /* 清理抛错不阻断其它效果 */ }
      }
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
    pendingEffects = [];

    // 模仿 uSES 的「渲染后再对一次快照」：如果 getSnapshot 每次返回新对象，这里会一直
    // 重渲 —— 桩件直接把这种不稳定判成失败，而不是静默死循环。
    for (const slot of hooks) {
      if (slot.kind !== "uses" || typeof slot.getSnapshot !== "function") continue;
      const latest = slot.getSnapshot();
      if (!Object.is(latest, slot.value)) {
        uSESDepthGuard += 1;
        if (uSESDepthGuard > 40) {
          uSESDepthGuard = 0;
          throw new Error("useSyncExternalStore 快照不稳定：getSnapshot() 每次返回新对象，会把渲染打成死循环");
        }
        scheduleRender();
        return;
      }
      uSESDepthGuard = 0;
    }
  }

  const stub = {
    ...react,
    /** 挂载一个组件；`parent` 非空时渲染进那个节点（用来放进假的 composer 里）。 */
    mount(Component, props, parent) {
      hooks.length = 0;
      cursor = 0;
      portalHosts.length = 0;
      currentRoot = { type: Component, props: props ?? {}, parent: parent ?? null };
      render();
      return stub;
    },
    /** 当前渲染出来的假 DOM 根（含上下文里的所有节点）。 */
    get root() {
      return currentRoot;
    },
    get tree() {
      return currentRoot ? currentRoot.node : null;
    },
    get renderCount() {
      return renderCount;
    },
    /** 按 `data-ces-part` 找节点（也可传任意 tag/属性选择器）。同时搜 portal 容器。 */
    find(part) {
      const roots = [stub.tree, ...portalHosts].filter(Boolean);
      for (const root of roots) {
        if (typeof root.getAttribute === "function" && root.getAttribute("data-ces-part") === part) return root;
        const found = root.querySelector(`[data-ces-part="${part}"]`);
        if (found) return found;
      }
      return null;
    },
    findAll(part) {
      const out = [];
      for (const root of [stub.tree, ...portalHosts].filter(Boolean)) {
        if (typeof root.getAttribute === "function" && root.getAttribute("data-ces-part") === part) out.push(root);
        out.push(...root.querySelectorAll(`[data-ces-part="${part}"]`));
      }
      return out;
    },
    /** 当前所有 portal 容器（测试用来确认"滑条挂进了官方那一行"）。 */
    get portalHosts() {
      return [...portalHosts];
    },
    /** 卸载：跑所有 effect 清理。 */
    unmount() {
      for (const slot of hooks) {
        if (slot.kind === "effect" && typeof slot.cleanup === "function") {
          try { slot.cleanup(); } catch (error) { /* 忽略 */ }
          slot.cleanup = undefined;
        }
        if (slot.kind === "uses" && typeof slot.unsubscribe === "function") {
          try { slot.unsubscribe(); } catch (error) { /* 忽略 */ }
          slot.unsubscribe = undefined;
        }
      }
      currentRoot = null;
    },
  };
  return stub;
}

/* ─────────────────────────── 假宿主 ─────────────────────────── */

export function createStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

export const DEFAULT_MODEL = {
  id: "deepseek-v41-flash",
  name: "DeepSeek-V41-Flash",
  reasoning: {
    defaultEffort: "high",
    efforts: [
      { id: "off", name: "Off" },
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
      { id: "max", name: "Max" },
    ],
  },
};

export function snapshotFor(model = DEFAULT_MODEL, reasoningEffort = undefined) {
  return {
    current: {
      provider: "deepseek",
      model: model.id,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    groups: [{ id: "deepseek", name: "DeepSeek", models: [model] }],
    failures: [],
    status: "ready",
    pending: null,
    error: null,
  };
}

/**
 * 官方形状的假宿主。
 *
 * @param options.model            目录里的模型（含 reasoning.efforts）
 * @param options.effort           会话当前显式档位（undefined = 未设置，走默认档）
 * @param options.failDirectoryFor 前 N 次 directoryFor 抛错（复现"会话作用域还没就绪"）
 * @param options.subagent         sessions.subagentAddress 是否返回地址（子代理会话）
 * @param options.select           select 的替身：返回 {ok}／抛错／返回 Promise
 */
export function createFakeHost(options = {}) {
  const model = options.model ?? DEFAULT_MODEL;
  const store = createStore(snapshotFor(model, options.effort));
  const selects = [];
  const loads = [];
  let directoryForCalls = 0;
  const failTimes = options.failDirectoryFor ?? 0;

  const directory = {
    store,
    load: async () => {
      loads.push(Date.now());
      return store.getSnapshot();
    },
    select: async (selection) => {
      selects.push(selection);
      const behavior = options.select;
      if (typeof behavior === "function") return behavior(selection, store);
      // 默认：模拟宿主往返 —— 成功并把 durable projection 写回共享快照。
      store.set({
        ...store.getSnapshot(),
        current: {
          ...store.getSnapshot().current,
          reasoningEffort: selection.reasoningEffort,
        },
      });
      return { ok: true, value: undefined };
    },
  };

  const registered = [];
  const subscriptions = [];
  const ctx = {
    /** 监视宿主事件订阅：本插件应当**一次都不订阅**（这是"不注入消息"的结构性证据）。 */
    on: (name, ...rest) => {
      subscriptions.push({ name, rest });
      return () => {};
    },
    modelDirectories: {
      directoryFor: () => {
        directoryForCalls += 1;
        if (directoryForCalls <= failTimes) throw new Error("resolved no scope / no binding");
        if (options.throwDirectoryFor === true) throw new Error("resolved no scope / no binding");
        return directory;
      },
    },
    sessions: {
      subagentAddress: () => (options.subagent === true ? { session: "child" } : undefined),
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (opts, Component) => {
        registered.push({ opts, Component });
        return { dispose() {} };
      },
    },
  };

  return {
    ctx,
    store,
    directory,
    selects,
    loads,
    registered,
    subscriptions,
    get directoryForCalls() { return directoryForCalls; },
  };
}

/* ─────────────────────── 加载真实产物 ─────────────────────── */

/**
 * 用假模块加载器执行真实的 `lib/client.js`，返回它注册的 {id, factory} 与工厂导出的插件。
 * @param bundlePath lib/client.js 的路径
 * @param document   假 document（样式挂载用）
 * @param options    { reducedMotion?: boolean } —— 决定假 window 的 matchMedia 结果
 */
export function loadBundle(bundlePath, document, options = {}) {
  let registration = null;
  /** MutationObserver 桩：只记录回调，由测试显式触发（这样扫描是确定性的，不靠计时）。 */
  const observers = [];
  /** 假时钟（毫秒）：rAF 帧时间戳与 performance.now 都读它，保证测试完全确定。 */
  let clock = 0;
  /** 待执行的 rAF 回调队列（flushFrames 消费）。 */
  const frameQueue = [];
  function clockNow() { return clock; }
  function MutationObserverStub(callback) {
    this.callback = callback;
    this.targets = [];
    observers.push(this);
  }
  MutationObserverStub.prototype.observe = function observe(target) { this.targets.push(target); };
  MutationObserverStub.prototype.disconnect = function disconnect() { this.targets.length = 0; };
  MutationObserverStub.prototype.trigger = function trigger() { this.callback([]); };

  const window = {
    __ModuleLoader__: {
      load(reg) { registration = reg; },
    },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    Event: function FakeEvent(type) { this.type = type; },
    MutationObserver: MutationObserverStub,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    /**
     * **可控的 requestAnimationFrame 桩**。
     *
     * 连续运动引擎靠帧循环推进；真实 rAF 由浏览器调度，离线测试里既不存在、
     * 也无法确定性地断言"第 N 帧的位置"。所以这里把它做成**手动泵**：
     * 回调入队，由测试用 flushFrames() 显式推进固定步长。
     *
     * 这样引擎的每条性质（连续性、零过冲、收敛）都能用**固定 dt** 精确验证，
     * 不依赖真实时钟 —— 这正是这次改造能离线证明"不咯裂"的前提。
     */
    requestAnimationFrame(callback) {
      frameQueue.push({ callback, cancelled: false });
      return frameQueue.length; // 句柄 = 队列下标（1 起）
    },
    cancelAnimationFrame(handle) {
      const entry = frameQueue[handle - 1];
      if (entry) entry.cancelled = true;
    },
    /** 只实现本插件会查的那条媒体查询（系统「减少动态效果」）。 */
    matchMedia(query) {
      return {
        media: query,
        matches: options.reducedMotion === true && String(query).indexOf("prefers-reduced-motion") >= 0,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };
  /**
   * 推进 `count` 帧，每帧步长 `dtMs` 毫秒。
   * 语义与真实 rAF 一致：**只执行本帧开始时已入队的回调**，回调里新排的帧留到下一轮。
   * 返回实际执行的帧数。
   */
  function flushFrames(count = 1, dtMs = 16) {
    let executed = 0;
    for (let i = 0; i < count; i += 1) {
      const batch = frameQueue.splice(0, frameQueue.length);
      const live = batch.filter((entry) => !entry.cancelled);
      if (live.length === 0) break;
      for (const entry of live) entry.callback(clockNow());
      clock += dtMs; // 时间只在**帧执行后**前进，与真实 rAF 的时间戳语义一致
      executed += 1;
    }
    return executed;
  }
  /** 手动推进时钟（毫秒），让"指针速度"这类基于时间的量可控。 */
  function advanceClock(ms) { clock += ms; return clock; }
  /** 当前假时钟值（毫秒）。 */
  function clockNow() { return clock; }
  const code = readFileSync(bundlePath, "utf8");
  // 只给这个 bundle 传它真正依赖的宿主全局；其余走真实全局（Promise/Set/Math/Date…）。
  // performance 单独传**假时钟**：引擎的"指针速度/松手外推"都读它，必须可控。
  const performanceStub = { now: () => clockNow() };
  const run = new Function("window", "document", "console", "setTimeout", "clearTimeout", "performance", code);
  run(window, document, console, setTimeout, clearTimeout, performanceStub);
  if (registration === null) throw new Error("bundle 没有调用 window.__ModuleLoader__.load()");
  const react = createReactStub();
  const plugin = registration.factory((spec) => {
    if (spec === "react") return react;
    // 真宿主里 react-dom 是平台种子词；桩件只要 createPortal（组件唯一的用法）。
    if (spec === "react-dom") return { createPortal: react.createPortal };
    throw new Error(`测试台没有为 require(${JSON.stringify(spec)}) 准备桩件`);
  });
  /** 触发所有 MutationObserver 桩（等价于"官方菜单刚出现"）。 */
  const flushObservers = () => {
    for (const observer of observers) observer.trigger();
  };
  return {
    registration, plugin, react, window, document, observers, flushObservers,
    flushFrames, advanceClock, clockNow,
  };
}

/** 让微任务、渲染和 promise 链都落定。 */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
