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
import { fileURLToPath } from "node:url";

/* ───────────────────────────── 假 DOM ───────────────────────────── */

/**
 * 选择器匹配：支持 `tag`、`.class`、`[attr="value"]`、`[class*="sub"]`，以及它们的串联
 * （`button[aria-haspopup="menu"][aria-expanded="true"]` —— 插件的 DOM 桥正是用这条
 * 选择器找"打开的那颗官方席"；`.scrollable` 与 `[class*="optionCopy"]` 是 v1.2.0 的三处
 * 注记要用的，所以这里必须真的实现 class 与子串两种匹配，不能只做属性等值）。
 */
function matches(node, selector) {
  if (typeof selector !== "string" || selector.length === 0) return false;
  const parts = String(selector)
    .trim()
    .match(/[a-zA-Z0-9-]+|\.[a-zA-Z0-9_-]+|\[[a-zA-Z0-9-]+(?:\*?="[^"]*")?\]/g);
  if (!parts || parts.join("") !== String(selector).trim()) return false;
  for (const part of parts) {
    if (part.startsWith(".")) {
      const wanted = part.slice(1);
      const classes = (node.getAttribute("class") ?? "").split(/\s+/).filter((name) => name.length > 0);
      if (!classes.includes(wanted)) return false;
      continue;
    }
    if (part.startsWith("[")) {
      const body = part.slice(1, -1);
      const substring = body.includes("*=");
      const [name, rawValue] = (substring ? body.split("*=") : body.split("="));
      const value = rawValue === undefined ? undefined : rawValue.replace(/^"|"$/g, "");
      const actual = node.getAttribute(name);
      if (actual === null || actual === undefined) return false;
      if (value === undefined) continue; // 只判存在
      if (substring ? !String(actual).includes(value) : String(actual) !== value) return false;
      continue;
    }
    if (part.length > 0 && node.tagName !== part.toUpperCase()) return false;
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
    /** 滚动位置：官方菜单的 `.scrollable` 是 `overflow-y:auto`，插件会在翻页时把它清回去。 */
    this.scrollTop = 0;
    this.scrollLeft = 0;
    /** focus() 的调用记录：`[{ options }]`，用来断言"菜单内的 focus 都带了 preventScroll"。 */
    this.focusCalls = [];
    this.scrollIntoViewCalls = [];
  }

  /** 真实 DOM 里 `el.className = "a"` 等价于写 `class` 属性，两者必须一致（选择器认 attribute）。 */
  get className() {
    return this.getAttribute("class") ?? "";
  }

  set className(value) {
    this.setAttribute("class", String(value));
  }

  /**
   * 够用的 classList（装饰器只用到 add/contains）。
   * 与 `className` 共用同一份 `class` 属性 —— 这正是插件里"官方重渲染换节点后
   * 我们要能重新算一遍"那条纪律在测试台里的落点。
   */
  get classList() {
    const node = this;
    const read = () => (node.getAttribute("class") ?? "").split(/\s+/).filter((name) => name.length > 0);
    const write = (list) => node.setAttribute("class", list.join(" "));
    return {
      add(...names) {
        const list = read();
        for (const name of names) if (!list.includes(name)) list.push(name);
        write(list);
      },
      remove(...names) {
        write(read().filter((name) => !names.includes(name)));
      },
      contains(name) {
        return read().includes(name);
      },
      toggle(name, force) {
        const has = read().includes(name);
        const next = force === undefined ? !has : force === true;
        if (next && !has) this.add(name);
        else if (!next && has) this.remove(name);
        return next;
      },
    };
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

  /** 真实 DOM 的 insertBefore —— `null` 参考节点等价于 append（插件就是这样插入归属标签的）。 */
  insertBefore(child, reference) {
    if (reference === null || reference === undefined) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    child.parentNode = this;
    this.children.splice(index, 0, child);
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

  /** `closest`：向上找第一个匹配选择器的祖先（自建浮层用它找 composer 卡片）。 */
  closest(selector) {
    let current = this;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
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

  focus(options) {
    this.focusCalls.push({ options });
  }

  scrollIntoView(options) {
    this.scrollIntoViewCalls.push({ options });
  }

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
 * 另有**两个二级页**（v1.2.0 起需要，用于徽标 / API 值 / 翻页稳定化的断言）：
 *   · `modelList`  —— `.scrollable` + 分组的模型行（`id="${menuId}-model-${index}"`）
 *   · `effortList` —— 档位行（`role=menuitemradio`，**没有 id**）
 * 两页可以同时在菜单里（官方同一时刻只渲染一页，但"多挂几个节点"不影响任何用例），
 * 也可以传 `panes: false` 只保留根面板（老用例的最小形状）。
 *
 * @param document createDocument() 的结果
 * @param options  { effortLabel?, modelLabel?, open?, reasoning?, panes?, modelRows?, scrollTop? }
 * @returns { composer, seat, menu, modelRow, effortRow, modelList, effortList, close() }
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
  menu.className = "wq12jW_menu";
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

  /* ── 两个二级页（形状对齐官方：`.scrollable` 里分组 + 行）───────────────
     官方模型行的 id 是 `${menuId}-model-${index}`（index = 目录展平后的序号），
     档位行**没有 id**、内部只有 `.optionCopy > .modelName`。 */
  const modelList = options.panes === false ? null : new FakeNode("div");
  const effortList = options.panes === false ? null : new FakeNode("div");
  const makeOption = (name, extra = {}) => {
    const row = new FakeNode("button");
    row.setAttribute("role", "menuitemradio");
    if (extra.id) row.setAttribute("id", extra.id);
    row.setAttribute("aria-checked", extra.checked === true ? "true" : "false");
    row.className = "wq12jW_option";
    const copy = new FakeNode("span");
    copy.className = "wq12jW_optionCopy";
    const labelEl = new FakeNode("span");
    labelEl.className = "wq12jW_modelName";
    labelEl.textContent = name;
    copy.appendChild(labelEl);
    const check = new FakeNode("span");
    check.className = "wq12jW_check";
    row.appendChild(copy);
    row.appendChild(check);
    return { row, labelEl, copy };
  };
  const modelRows = [];
  if (modelList !== null) {
    modelList.className = "wq12jW_groups scrollable";
    modelList.setAttribute("role", "menu");
    modelList.setAttribute("id", "model-menu-models");
    modelList.scrollTop = options.scrollTop ?? 0;
    const names = options.modelRows ?? ["DeepSeek-V41-Flash"];
    const group = new FakeNode("div");
    group.className = "wq12jW_group";
    names.forEach((name, index) => {
      const option = makeOption(name, { id: `model-menu-model-${index}`, checked: index === 0 });
      modelRows.push(option);
      group.appendChild(option.row);
    });
    modelList.appendChild(group);
    menu.appendChild(modelList);
  }
  const effortRows = [];
  if (effortList !== null) {
    const optionsList = options.effortRows ?? ["Off", "Low", "High", "Max"];
    optionsList.forEach((name, index) => {
      const option = makeOption(name, { checked: index === optionsList.length - 1 });
      effortRows.push(option);
      effortList.appendChild(option.row);
    });
    menu.appendChild(effortList);
  }

  return {
    composer,
    seat,
    seatLabelEl: seatModelSpan,
    seatEffortEl: seatEffortSpan,
    menu,
    modelRow,
    effortRow,
    modelList,
    effortList,
    modelRows,
    effortRows,
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
    //
    // ⚠️ 这里必须摘掉**上一次新增的全部节点**，不能只摘最后一个：一次渲染可以产出多个兄弟
    // 节点（多会话场景下每个会话一颗 trigger），只摘最后一个会让其余节点逐轮残留、越查越多。
    // `baseCount` 是挂载时宿主容器已有的孩子数（官方菜单那些节点），新增的都排在它后面。
    const parent = currentRoot.parent ?? null;
    const host = parent ?? new FakeNode("div");
    if (parent !== null) {
      if (currentRoot.baseCount === undefined) {
        currentRoot.baseCount = host.children.length;
      } else {
        while (host.children.length > currentRoot.baseCount) {
          host.removeChild(host.children[host.children.length - 1]);
        }
      }
    }
    for (const container of portalHosts) container.children.length = 0;
    portalHosts.length = 0;
    renderElement(react.createElement(currentRoot.type, currentRoot.props), host);
    currentRoot.host = host;
    // `tree` 取本次产出的**第一个**新节点：`find`/`findAll` 还会把整个 `host` 作为搜索根，
    // 所以兄弟节点（多会话的第二颗按钮）不会漏。
    currentRoot.node = parent !== null
      ? (host.children[currentRoot.baseCount] ?? null)
      : (host.children[0] ?? null);
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
    /**
     * 按 `data-ces-part` 找节点（也可传任意 tag/属性选择器）。
     *
     * 搜索根包含**整个宿主容器**（`currentRoot.host`）而不只是 `tree`：一次渲染可能产出多个
     * **兄弟**节点（多会话场景每个会话一颗 trigger），只从第一个节点往下找会漏掉其余的。
     */
    find(part) {
      const roots = [currentRoot && currentRoot.host, stub.tree, ...portalHosts].filter(Boolean);
      for (const root of roots) {
        if (typeof root.getAttribute === "function" && root.getAttribute("data-ces-part") === part) return root;
        const found = root.querySelector(`[data-ces-part="${part}"]`);
        if (found) return found;
      }
      return null;
    },
    findAll(part) {
      const seen = new Set();
      const out = [];
      const roots = [currentRoot && currentRoot.host, stub.tree, ...portalHosts].filter(Boolean);
      for (const root of roots) {
        if (typeof root.getAttribute === "function" && root.getAttribute("data-ces-part") === part && !seen.has(root)) {
          seen.add(root);
          out.push(root);
        }
        for (const node of root.querySelectorAll(`[data-ces-part="${part}"]`)) {
          if (seen.has(node)) continue;
          seen.add(node);
          out.push(node);
        }
      }
      return out;
    },
    /** 当前所有 portal 容器（测试用来确认"滑条挂进了官方那一行"）。 */
    get portalHosts() {
      return [...portalHosts];
    },
    /**
     * 卸载：跑所有 effect 清理，并把本次渲染 append 的节点**摘干净**。
     *
     * 摘节点这步不能省：`render` 用 `baseCount` 做增量清理，而重挂会重建 `currentRoot`
     * （`baseCount` 归零重算），若卸载时留着旧节点，新一次渲染就会与残留**叠加**
     * —— 多会话场景下表现为"重挂后按钮变成 4 颗"。
     */
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
      if (currentRoot && currentRoot.parent !== null && currentRoot.host) {
        const host = currentRoot.host;
        const base = currentRoot.baseCount ?? 0;
        while (host.children.length > base) {
          host.removeChild(host.children[host.children.length - 1]);
        }
      }
      for (const container of portalHosts) container.children.length = 0;
      portalHosts.length = 0;
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
 * 多 provider / 多模型的快照（徽标与归属标签那两段断言要用）。
 *
 * @param options.groups      [{ id, name, models:[模型] }]，模型形状同 DEFAULT_MODEL
 * @param options.provider    会话当前 provider（默认取第一组）
 * @param options.model       会话当前模型 id（默认取第一组的第一个）
 * @param options.effort      会话当前显式档位
 */
export function snapshotOf(options = {}) {
  const groups = options.groups ?? [{ id: "deepseek", name: "DeepSeek", models: [DEFAULT_MODEL] }];
  const first = groups[0];
  return {
    current: {
      provider: options.provider ?? first.id,
      model: options.model ?? first.models[0].id,
      ...(options.effort === undefined ? {} : { reasoningEffort: options.effort }),
    },
    groups,
    failures: [],
    status: "ready",
    pending: null,
    error: null,
  };
}

/**
 * 真宿主里 `conversation.composer.bar` 那条条目声明的三个子槽 —— 本插件用到的全部。
 * 少声明一个就能复现"那个槽不存在"（退路分支）。
 */
export const DEFAULT_DECLARED_SLOTS = [
  "conversation.input.model",
  "conversation.input.right",
  "conversation.input.overlay",
];
/** 其中 `kind === "single"` 的槽：同一优先级只能有一条（官方模型席 = priority 0）。 */
export const SINGLE_SLOTS = new Set(["conversation.input.model"]);

/**
 * 官方形状的假宿主。
 *
 * @param options.model            目录里的模型（含 reasoning.efforts）
 * @param options.effort           会话当前显式档位（undefined = 未设置，走默认档）
 * @param options.failDirectoryFor 前 N 次 directoryFor 抛错（复现"会话作用域还没就绪"）
 * @param options.subagent         sessions.subagentAddress 是否返回地址（子代理会话）
 * @param options.select           select 的替身：返回 {ok}／抛错／返回 Promise
 * @param options.declaredSlots    宿主实际声明了哪些槽（默认三个都有）
 */
export function createFakeHost(options = {}) {
  const model = options.model ?? DEFAULT_MODEL;
  const store = createStore(options.snapshot ?? snapshotFor(model, options.effort));
  const selects = [];
  const loads = [];
  let directoryForCalls = 0;
  const failTimes = options.failDirectoryFor ?? 0;
  /**
   * 插件声明的**插件级 inject 清单**（`setupPicker` 用 `enforceInject(bundle.plugin.inject)` 灌进来）。
   * `directoryFor` 拿它复刻真宿主的规矩："少声明 `remote.session` 就抛错"。
   */
  let declaredInject = null;
  /**
   * "冷目录"：store 一开始是**空的**（`status: idle`、没有 groups），只有 `load()` 成功之后
   * 才变成 `ready` + 有 provider。真宿主的 `ModelDirectory` 就是这样：它的 store 由
   * `catalog.load()` → `syncInputs()` 填。
   *
   * 为什么要这个模式：1.3.2 接管官方模型席之后，官方那颗席按钮不再渲染（它原本也会调
   * `props.load()`），于是"启动期那次 load 失败/被缓存成空目录"就没人再治 —— 真机上表现为
   * "面板一片空白 + 档位 `—` + 滑条灰掉"。这两条自愈路径必须能在离线测试里复现。
   */
  const coldDirectory = options.coldDirectory === true;
  const readySnapshot = options.snapshot ?? snapshotFor(model, options.effort);
  let loadFailures = options.loadFailures ?? 0;
  /** 全局目录（官方 resolver 上的实例字段）—— 插件会借用它的 `refresh()` 治"就绪但空"。 */
  const catalog = {
    refreshes: 0,
    refresh() {
      catalog.refreshes += 1;
      // 真 refresh() = invalidate + load：刷新之后目录就"有了 provider"（除非调用方另有安排）
      if (typeof options.onCatalogRefresh === "function") {
        options.onCatalogRefresh(store, readySnapshot, catalog.refreshes);
        return;
      }
      store.set(readySnapshot);
    },
  };
  if (coldDirectory) store.set({ ...readySnapshot, current: null, groups: [], failures: [], status: "idle" });

  let directory = {
    store,
    load: async () => {
      loads.push(Date.now());
      if (loadFailures > 0) {
        loadFailures -= 1;
        throw new Error("model catalog unavailable");
      }
      if (coldDirectory) store.set(readySnapshot);
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
  /**
   * 假槽位系统要复刻真内核（`@deepseek-ai/dsh-client-ui-slots`）的三条行为，
   * 否则"接管官方模型席"这件事在离线测试里根本测不出来：
   *   1. **槽没被声明就不能注册**（真内核原话：`slot "X" is not declared`）；
   *   2. `inject` 是"**等**那个槽出现"，没声明就一直不回调（所以插件得自己有退路）；
   *   3. **single 槽同优先级撞了会抛错**，而换个优先级就是"遮蔽"——**最低者渲染**。
   */
  const declaredSlots = new Set(options.declaredSlots ?? DEFAULT_DECLARED_SLOTS);
  const pendingInjections = [];
  const ctx = {
    /** 监视宿主事件订阅：本插件应当**一次都不订阅**（这是"不注入消息"的结构性证据）。 */
    on: (name, ...rest) => {
      subscriptions.push({ name, rest });
      return () => {};
    },
    modelDirectories: {
      /**
       * 真宿主（`ModelDirectoryResolver.directoryFor`）对"解析不出 scope/binding 的会话 id"
       * 是**抛错**的，所以测试台也能声明"哪些 id 无效"（`throwForSessionIds`）——
       * 1.3.6 那个"注入的 binding.key 盖掉了 kit 的正确 id"的事故就靠它复现。
       */
      directoryFor: (id) => {
        directoryForCalls += 1;
        if (directoryForCalls <= failTimes) throw new Error("resolved no scope / no binding");
        if (options.throwDirectoryFor === true) throw new Error("resolved no scope / no binding");
        const bad = options.throwForSessionIds;
        if (Array.isArray(bad) && (id === undefined || id === null || bad.indexOf(id) >= 0)) {
          throw new Error(`ui-model-selection: session "${String(id)}" resolved no scope`);
        }
        /*
         * **真 Cordis 的服务访问是跟着调用方 ctx 的**：`directoryFor()` 在给一个新 binding
         * 建目录实例时要访问 `this.ctx.remote.session`，于是**调用方**（我们插件）也必须声明
         * `remote` / `remote.session` —— 官方插件的插件级 inject 里就有它们。
         * 缺了就抛这句（1.3.7 的真机事故，报错一字不差地出现在用户控制台里）。
         * 这里复刻它，好让"少声明一个服务"在离线测试里就撞墙。
         */
        if (declaredInject !== null && declaredInject.indexOf("remote.session") < 0) {
          throw new Error('cannot get property "remote.session" without inject');
        }
        return directory;
      },
      /** 官方 resolver 上的实例字段（插件借用它的 `refresh()` 治"就绪但空"）。 */
      catalog: catalog,
    },
    sessions: {
      subagentAddress: () => (options.subagent === true ? { session: "child" } : undefined),
    },
    slots: {
      inject: (name, callback) => {
        // 真宿主里 inject 是"等那个槽被声明"：没声明就一直不回调（不是抛错）。
        if (declaredSlots.has(name)) callback();
        else pendingInjections.push({ name, callback });
        return () => {};
      },
      register: (opts, Component) => {
        if (!declaredSlots.has(opts.name)) {
          throw new Error(`slot "${opts.name}" is not declared (a parent entry's children table must declare it)`);
        }
        const priority = opts.priority ?? 0;
        // single 槽：**同优先级撞了会抛错**（真内核的原话就是"换个优先级去遮蔽它，最低者渲染"）
        if (SINGLE_SLOTS.has(opts.name)) {
          const occupant = registered.find((item) => item.opts.name === opts.name && (item.opts.priority ?? 0) === priority);
          if (occupant) {
            throw new Error(`single slot "${opts.name}" already has a registration at priority ${priority}`
              + `${occupant.registrant !== undefined ? ` (registered by ${occupant.registrant})` : ""}`
              + " — register at a different priority to shadow it (lowest renders)");
          }
        }
        const entry = { opts, Component };
        registered.push(entry);
        return {
          dispose() {
            const index = registered.indexOf(entry);
            if (index >= 0) registered.splice(index, 1);
          },
        };
      },
    },
  };

  return {
    ctx,
    store,
    directory,
    catalog,
    selects,
    loads,
    registered,
    subscriptions,
    /** 还有几次 load 会失败（测试用来制造"启动期 load 失败 → 之后自愈"）。 */
    get pendingLoadFailures() { return loadFailures; },
    setLoadFailures(next) { loadFailures = next; },
    /** 某个槽**当前会渲染**的那一条（真内核：按 priority 升序取第一个 —— 最低者渲染）。 */
    slotHead(name) {
      const entries = registered.filter((item) => item.opts.name === name);
      if (entries.length === 0) return null;
      return entries.slice().sort((a, b) => (a.opts.priority ?? 0) - (b.opts.priority ?? 0))[0];
    },
    /** 补声明一个槽（真宿主里是父条目挂上来），把等它的 `inject` 回调放出来。 */
    declareSlot(name) {
      declaredSlots.add(name);
      for (let i = pendingInjections.length - 1; i >= 0; i -= 1) {
        if (pendingInjections[i].name !== name) continue;
        const [pending] = pendingInjections.splice(i, 1);
        pending.callback();
      }
    },
    /** 还在等声明的 `inject`（槽名列表）—— 用来断言"退路在等哪个槽"。 */
    get pendingInjections() { return pendingInjections.map((item) => item.name); },
    /**
     * 测试用：**换掉目录实例**（默认行为不变，仍是同一个实例）。
     *
     * 复现宿主重建 `ModelDirectory` 的情形（父子会话换 binding、会话作用域重建等）——
     * 那时旧实例已被 `dispose`，读路径若不复查就会永久冻在旧档位表上。
     */
    swapDirectory(next) { directory = next; },
    get directoryForCalls() { return directoryForCalls; },
    /**
     * 告诉假宿主"插件声明了哪些服务"（真 Cordis 里这是插件对象上的 `inject` 数组）。
     * 灌进来之后，`directoryFor` 会像真宿主那样对缺 `remote.session` 的调用方抛错。
     */
    enforceInject(list) { declaredInject = Array.isArray(list) ? list.slice() : null; },
    get declaredInject() { return declaredInject === null ? null : declaredInject.slice(); },
  };
}

/* ─────────────────────── 加载真实产物 ─────────────────────── */

/** `lib/client.picker.js` 在模块表里的 id（真宿主里是 `<包名>/client.picker.js`）。 */
export const PICKER_MODULE_ID = "better-dsh-codex-effort-slider/client.picker.js";

/**
 * 把真实的包内 chunk `lib/client.picker.js` 加载成模块对象。
 *
 * 这个文件是**自注册**的（`window.__ModuleLoader__.load({ id, chunk, factory })`），
 * 与真宿主拿到的字节完全一样 —— 所以这里也**走一遍那个注册路径**，而不是自己解析 ESM：
 * 少了这一步，chunk 的包壳写错（id 不对、忘了 chunk 字段、忘了 return）都会被测试放过，
 * 而在真机上表现为"入口按钮根本不存在"。
 */
function createPickerModuleStub(react, document, win) {
  const path = fileURLToPath(new URL("../lib/client.picker.js", import.meta.url));
  const code = readFileSync(path, "utf8");
  if (!code.includes("__ModuleLoader__.load")) {
    throw new Error("lib/client.picker.js 没有自注册（先跑 node build/pack-picker.mjs）");
  }
  let registration = null;
  /**
   * chunk 里的 `platform = { window, document }` 必须拿到**真 window 的能力**（`addEventListener`
   * 之类），不能只给一个带 `__ModuleLoader__` 的空壳 —— 之前就是空壳，于是"视口尺寸变了就关面板"
   * 这种挂在 window 上的行为在测试里**根本注册不上**（被 `typeof` 守卫静默跳过），也就测不到。
   *
   * 注册用的 `__ModuleLoader__` 给**单独一份**：不能覆盖 client.js bundle 那一次的 registration。
   * 对象是新的，但方法来自同一个假 window，所以监听器仍落在同一张表里 —— `bundle.window.dispatch()`
   * 能触发 chunk 注册的监听器，`bundle.window.listenerCount()` 也数得到它们。
   */
  const chunkWindow = Object.assign({}, win, {
    __ModuleLoader__: { load(reg) { registration = reg; } },
  });
  // 真宿主里 document / window 是**平台全局**；离线测试台没有它们，所以显式传进去
  // （少了这一层，面板里所有"只在浏览器里跑"的副作用——Esc、外点、滚动稳定化——会被跳过）。
  const run = new Function("window", "document", "console", "setTimeout", "clearTimeout", code);
  run(chunkWindow, document ?? null, console, setTimeout, clearTimeout);
  if (registration === null) throw new Error("lib/client.picker.js 没有调用 window.__ModuleLoader__.load()");
  if (registration.chunk !== "client.picker.js") {
    throw new Error(`chunk 注册的 chunk 字段不对：${JSON.stringify(registration.chunk)}（模块表按 ${PICKER_MODULE_ID} 取它）`);
  }
  const exported = registration.factory((spec) => {
    if (spec === "react") return react;
    // 面板自己 createPortal 到一个由它创建的宿主元素（挂在 composer 卡片上）
    if (spec === "react-dom") return { createPortal: react.createPortal };
    throw new Error(`chunk 里出现了不认识的 require(${JSON.stringify(spec)})`);
  });
  if (exported === null || typeof exported !== "object"
    || typeof exported.createPickerTrigger !== "function"
    || typeof exported.createPickerSurface !== "function") {
    throw new Error("lib/client.picker.js 的工厂没有交出 createPickerTrigger / createPickerSurface");
  }
  return exported;
}

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
  function MutationObserverStub(callback) {
    this.callback = callback;
    this.targets = [];
    observers.push(this);
  }
  MutationObserverStub.prototype.observe = function observe(target) { this.targets.push(target); };
  MutationObserverStub.prototype.disconnect = function disconnect() { this.targets.length = 0; };
  MutationObserverStub.prototype.trigger = function trigger() { this.callback([]); };

  /**
   * 假 window：**记录**注册上来的监听器并支持 `dispatch` 触发它们。
   *
   * 之前这里是空函数（`addEventListener() {}`），于是"注册了 window.resize 监听器"这件事
   * 在测试里根本看不见、也触发不了 —— 自建浮层那条"视口变了就关面板"的策略就测不到。
   */
  const windowListeners = new Map();
  const window = {
    __ModuleLoader__: {
      load(reg) { registration = reg; },
    },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      const set = windowListeners.get(type);
      if (set) set.delete(listener);
    },
    /** 触发注册在 window 上的监听器（真实 window 由浏览器派发）。 */
    dispatch(type, event) {
      const set = windowListeners.get(type);
      if (!set) return;
      for (const listener of [...set]) listener(Object.assign({ type, target: window, preventDefault() {} }, event));
    },
    /** 当前挂在 window 上的监听器条数（断言"卸载时摘干净了"用）。 */
    listenerCount(type) {
      const set = windowListeners.get(type);
      return set ? set.size : 0;
    },
    dispatchEvent() {},
    Event: function FakeEvent(type) { this.type = type; },
    MutationObserver: MutationObserverStub,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
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
  const code = readFileSync(bundlePath, "utf8");
  // 只给这个 bundle 传它真正依赖的宿主全局；其余走真实全局（Promise/Set/Math/Date…）。
  const run = new Function("window", "document", "console", "setTimeout", "clearTimeout", code);
  run(window, document, console, setTimeout, clearTimeout);
  if (registration === null) throw new Error("bundle 没有调用 window.__ModuleLoader__.load()");
  const react = createReactStub();
  /**
   * 插件把"自建浮层"放在**包内动态 chunk** 里：`lib/client.picker.js`，用
   * `require.async("./client.picker.js")` 取（文件名必须匹配宿主的 `client.*.js` 规则）。
   * 这里把那个**真文件**加载起来，于是"自建面板"那条路跑的也是真代码。
   */
  let pickerModule = null;
  const pickerModuleOf = () => {
    if (pickerModule === null) pickerModule = createPickerModuleStub(react, document, window);
    return pickerModule;
  };
  const requireStub = (spec) => {
    if (spec === "react") return react;
    // 真宿主里 react-dom 是平台种子词；桩件只要 createPortal（组件唯一的用法）。
    if (spec === "react-dom") return { createPortal: react.createPortal };
    throw new Error(`测试台没有为 require(${JSON.stringify(spec)}) 准备桩件`);
  };
  // 与真模块表一致：同步 require 不认包内子路径，只有 require.async 能取到 chunk。
  requireStub.async = async (spec) => {
    if (spec === "./client.picker.js" || spec === PICKER_MODULE_ID || spec === "./picker") return pickerModuleOf();
    throw new Error(`测试台没有为 require.async(${JSON.stringify(spec)}) 准备桩件`);
  };
  const plugin = registration.factory(requireStub);
  /** 触发所有 MutationObserver 桩（等价于"官方菜单刚出现"）。 */
  const flushObservers = () => {
    for (const observer of observers) observer.trigger();
  };
  return { registration, plugin, react, window, document, observers, flushObservers };
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
