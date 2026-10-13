# 真机事故复盘

> 这份文档记录**在真实 DSH Desktop 里踩到、并且已经修掉**的问题：现场是什么样、
> 根因在哪、怎么修的、以及哪条断言防止它回来。
>
> 为什么单独成篇：这些内容太细（引用官方产物的具体行号、Cordis 内核语义、Electron 缓存行为），
> 放进 [CHANGELOG.md](CHANGELOG.md) 会把发布流水淹掉；但它们又**最值钱** ——
> 下面每一条都是"离线断言全绿、真机却坏着"的类型，值得留着当排查手册。
>
> 速查：
>
> | # | 现场（用户看到的） | 真正的原因 |
> |---|---|---|
> | 1 | 面板一片空白，档位 `—`，滑条灰掉 | 接管官方席之后，官方菜单那份"报告"没人接手了 |
> | 2 | 面板永久卡在「会话目录未就绪」 | 插件级 `inject` 少了 `remote.session` |
> | 3 | 面板说「宿主没有列出任何 provider」 | 宿主侧：账号 provider 拿不到令牌时**静默**返回空列表 |
> | 4 | **整个插件消失**，重启也不回来 | `package.json` 被写进 UTF-8 BOM（宿主直接 `JSON.parse` 它） |
> | 5 | 「对话一刷新，面板就没了」 | 聊天区流式滚动触发了"滚动即关闭"策略 |
> | 6 | 浅色主题下面板与背景糊成一片 | 官方阴影令牌只有 4% alpha + 没有毛玻璃 |
> | 7 | 阴影外面套着一个"框" | 定位壳的 `overflow:auto` 把面板的 `box-shadow` 裁成矩形 |
> | 8 | 浅色主题的星尘是深色小点 | 星尘跟着主题令牌走，而它永远落在蓝紫填充层上 |
> | 9 | 换模型总落在最高档 | 默认档位取"最后一档"，用户要的是正中 |

---

## 1. 空目录：面板一片空白，连原因都读不到（1.3.3）

**现场**：装好后重启 DSH，输入区只剩一颗按钮、写着"模型"；点开面板，"模型"标题下面**一个字都没有**；
档位 `—`、滑条灰掉。

**三件事叠在一起**（缺一条都不会这么难查）：

1. **目录是空的**。宿主 `buildModelCatalog()`（`dsh-api-session-controller/lib/index.js:500`）
   只列**当前已注册的 LLM provider**，并把"0 个模型的组"整个丢掉（`:541`）；DSH 刚起来时
   provider 可能还没注册完 → 返回一个**合法的空目录**，而那个结果**会被缓存**
   （`ModelCatalogDirectory.load()` 见到 `status === "ready"` 直接短路，不再问宿主）。
2. **提示句被裁掉了**。`viewportHeightFor` 当时给的是 `max(44, 30 + 0×41) = 44px`，
   而那句提示要 48px —— `.cxp-viewport` 的 `overflow:hidden` 把它**整句裁掉**。
   于是"目录空/失败"与"面板坏了"在界面上长得一模一样。
3. **没人重试**。1.3.2 之前官方那颗席按钮也在渲染，它至少是另一个"再 `load()` 一次"的入口；
   **接管之后我们是唯一的读取方** —— 启动期那一次失败/空目录就永远停在那儿。

**修法**：

- 提示/失败原因都渲染出来，并且**高度算得下它们**（`EMPTY_H` / `FAILURE_H` 与 CSS 实算对齐）；
  二级页"无匹配模型"那句同样修了（以前只给 80px）。
- **逐 provider 的失败清单**按官方文案 `"{name} 加载失败：{message}"` 渲染（最多 4 条）。
- `load` 失败 → 按 `RETRY_DELAYS`（60ms→3s）退避重试，退避用尽由 1.5s 心跳兜底。
  ⚠️ 只治"**目录根本没到**"（idle/loading/error）：`status === "ready"` 时继续重拉会变成
  **60ms 一轮的活锁**（`load()` 每次都成功返回、store 却依然空，退避计数器还被重置）——
  这条是写测试时真的把进程跑死才发现的（`needsLoadRetry()` 就是为它加的）。
- **"就绪但空"主动刷一次全局目录**：借官方 resolver 的 `catalog.refresh()`，
  8 秒冷却、最多 3 次、全程 typeof/try 兜住。这是唯一能治"被缓存的空目录"的手段。
- 按钮文案如实：目录没到时写"正在加载模型…"（对齐官方 `trigger.loading`）。

**断言**：第 43 节 17 条 —— 提示真的落在视口里（断言视口高度 ≥ 小节 + 提示）、`load` 失败一次后自愈、
"就绪但空"调了 `catalog.refresh()` 且冷却期内不重复刷、失败清单的文案与 `title`。
测试台为此补了 `coldDirectory` / `loadFailures` / `catalog.refresh` 三个能力。

---

## 2. 永久"会话目录未就绪"：插件级 `inject` 少了 `remote.session`（1.3.7）

**现场**：面板卡在 **"会话目录未就绪，正在重试…"**、档位 `—`，等很久也不动。

**怎么找到的**：1.3.6 把"失败原因"摆到了面板与控制台上，控制台立刻给出原话：

```
[better-dsh-codex-effort-slider] 会话目录还没就绪：cannot get property "remote.session" without inject
```

这是 **Cordis 的服务注入报错**：服务访问是**跟着调用方 ctx** 走的。

**根因**（三份代码对起来才看得见）：

1. `ModelDirectoryResolver.directoryFor()`（`dsh-client-ui-model-selection/lib/client.js:391`）
   给一个**新** binding 建实例时要 `new ModelDirectory(this.ctx.remote.session, …)` ——
   访问 `this.ctx.remote.session` 要求**调用方**声明过它；
2. 官方插件在**插件级** inject 里就声明了：
   `["commandUi","locale","sessions","slots","remote","remote.session"]`（`:1188`）；
3. 我们的 inject 只有 `["slots","sessions","modelDirectories"]` —— **少了那两个** ✗。

**为什么"以前能用、接管之后才坏"**（这次的关键）：`directoryFor()` 对每个 binding **缓存**实例：

```js
const existing = live.directories.get(binding);
if (existing !== void 0) return existing;      // 命中就直接返回，根本不碰 remote.session
const directory = new ModelDirectory(this.ctx.remote.session, …);   // 只有走到这里才需要注入
```

从前官方那颗席按钮也在渲染，它先调一次把实例建出来（它的 ctx 声明齐全），我们只是**命中缓存**。
1.3.2 接管那一格之后官方组件不再渲染 —— 我们成了第一个（也是唯一的）调用方，
于是必须自己建实例、必须自己声明这两个服务。启动顺序的微小差异还让它表现为"时好时坏"。

**修法**：插件级 `inject` 补上 `"remote"` 与 `"remote.session"`（两个服务必然存在，
`modelDirectories` 自己就静态依赖它们，所以不会让 fiber 停在 PENDING）。

**断言**：第 45 节 +4 条，其中**最值钱的是测试台复刻了这条规矩** ——
假宿主的 `directoryFor()` 现在会像真宿主那样，对"没声明 `remote.session` 的调用方"抛同一句原话；
于是**少声明一个服务，离线套件立刻红**（原先它完全测不到）。

---

## 3. 「宿主没有列出任何 provider」：宿主侧的静默空（1.3.5）

**现场**：面板终于能看见了，写的是**"没有可用的 provider"**、档位 `—`、滑条灰掉。

这句含糊的话同时对应两种完全不同的处境 —— 1.3.5 就是把它们分开：

| 处境 | 谁的问题 | 现在怎么说 |
|---|---|---|
| `directoryFor(id)` 一直抛 / 目录实例没解析出来 | **本插件**（会自动重试） | "会话目录未就绪，正在重试…" + **宿主原话** |
| 目录 `status: ready` 但 `groups` 为空 | **宿主**（模型目录就是空的） | "宿主没有列出任何 provider"，悬浮提示指向 DSH 设置 |
| 一个会话 id 都没有（"新会话"空白壳） | 不是故障 | "还没有会话 —— 发一条消息后就能选模型" |

**查清的事**：为什么宿主会"就绪但空"且一声不吭 ——

1. `buildModelCatalog()` 只列当前注册的 provider，0 模型的组整个丢掉、异常收进 `failures`；
2. **`deepseek-account` 在拿不到账号令牌时静默返回空列表**：
   `dsh-llm-deepseek-account/lib/index.js:49-57` —— 抛 `ACCOUNT_SIGN_IN_REQUIRED` 就 `return []`；
3. `resolveToken`（`dsh-deepseek-account-platform/lib/index.js:786`）在这些情况下静默返回 `undefined`：
   端点 origin 与该账号推导出的 inference origin 不一致、凭证库里没有那条 grant、
   grant 的 issuer 与自建端点不匹配、或令牌是 `dsh_mock_` 前缀。

三者合起来就是"**groups 空 + failures 空 + status ready**"。**这种情况下官方菜单同样是空的** ——
该去查 DSH 的模型/账号设置，而不是查这个插件。

**断言**：第 31 节改成"必须说 `unresolved`"、第 43 节补 `data-phase=empty` 与悬浮说明。

---

## 4. 整个插件消失：`package.json` 里的 UTF-8 BOM（1.3.5）

**现场**：用户说"**整个插件效果都没有了**"，重启也不回来，但 `/model` 一切正常。
插件管理器里那一行给的是决定性的信息：

```
{ "name": "better-dsh-codex-effort-slider", "enabled": true, "installed": true,
  "error": { "code": "operation-error",
             "diagnostic": "Unexpected token '\uFEFF', \"\uFEFF{\r\n  \"nam\"... is not valid JSON" },
  "rows": [] }
```

**`rows: []` = 一个条目都没加载**（对照：宿主加载器那 191 个条目里确实没有我们）。
宿主读 bundle 清单是**直接 `JSON.parse` 文件内容**，而 `JSON.parse` 不吃 BOM。

**怎么造成的**：用 `Set-Content -Encoding UTF8`（Windows PowerShell 5.1）改版本号会写 BOM。
修法是**按字节剥掉**（`fs.writeFileSync(f, buf.subarray(3))`），不是用同一类命令再写一遍 ——
这个坑本身就是"工具链静默破坏"的典型。

**顺带学到的反面教训**：为了修这个 BOM 而"全仓库去 BOM"时，把 `pack-dist.ps1` /
`install-profile.ps1` 的 BOM 也剥了 —— 而那两个**必须带**（PowerShell 5.1 读无 BOM 的中文 `.ps1`
会按系统代码页解码，注释/提示乱码甚至语法错误）。规则是**分文件类型**的。

**断言**：第 44 节 13 条 —— `package.json` 不带 BOM 且能被 `JSON.parse` 直接吃掉、
`lib/*.js` 与 `cordis.patch.yml` 也不带；同时两个 `.ps1` **必须**带 BOM。

---

## 5. 「对话还没结束的时候，对话一刷新，面板就没了」（1.3.4）

**根因是旧的滚动策略**：面板监听全文档的 `scroll`（capture 阶段），规则是"页面在滚就关面板"，
理由是"重定位正是面板乱飘的来源"。但助手流式输出时**聊天区一直在自动滚动** ——
scroll 不停到达 document，面板被自己的策略关掉。

那条理由其实不成立：面板是 `position:fixed` + **底边锚在触发器顶边**，聊天区滚动根本不动 composer。
**现在改成重定位**（`scroll` / `resize` 只按当前几何重算一次，不关闭）。

两处配套细节：

- **触发器几何为 0 时保持原位**：助手在跑时宿主会给 composer 的控件行 `hidden`，
  那时 `getBoundingClientRect()` 全 0 —— 拿零尺寸去定位会把面板甩飞，所以直接跳过。
- **位置必须放进 state**（这一条是探针跑出来的隐藏 bug）：位置以前是渲染时现读 store 的，
  而重定位只改 store、不改 state —— 订阅回调里 `setOpen(同一个布尔)` 被 React **bail out**，
  于是**一次渲染都不发生**，面板看起来"纹丝不动"。现在 `pos` 也是 state、一起订阅。

**断言**：第 35 节扩到 34 条 —— 滚动/缩放不再关面板、重定位真的跟着锚点走、
触发器 `rect` 全 0 时保持原位、Esc 逐层退避后监听器摘干净。

---

## 6. 浅色主题：面板与背景糊成一片（1.3.9）

**现场**：浅色主题下面板几乎看不出边界；官方那种"毛玻璃"的观感完全没有。

照官方产物核对出三件事（都不是自己发明的值）：

1. **毛玻璃**：官方菜单材料用 `--dsw-menu-backdrop-filter: blur(40px) saturate(150%)`
   （定义在 `body` 上，自定义属性**会继承**，所以 portal 到 body 的面板取得到）；
2. **底必须是半透明的** —— 模糊只在"底透"时看得见，所以不能用不透明的 `--dsw-alias-bg-layer-1`；
   官方菜单填充令牌 `--dsw-menu-surface-fill`：浅色 `#f8f9fa94`（.58）、深色 `#43454a73`（.45）；
3. **阴影**：官方 `--dsw-elevation-prominent` 的 alpha 只有 **4%~5%**，浅色页面上几乎看不见 ——
   这就是"跟背景一个颜色"的来源。现在叠官方 `--dsw-shadow-lv3` 再补一层落地阴影，深色另给一套。

之后按反馈**再透一档**（1.3.10）：保留官方色相、只降 alpha（`.46` / `.40`），
并把推理等级卡片也改成半透明 —— 实心卡片盖住面板 2/3 面积，会把毛玻璃整个抵消。
（没有用 `color-mix()` 去"把官方令牌调淡"：引擎不支持时整条声明失效，面板会变成**完全没有底色**。）

**断言**：第 38 节 +13 条（模糊用官方令牌且带官方字面兜底、`-webkit-` 前缀、底必须是半透明、卡片半透明）。

---

## 7. 阴影外面套着一个"框"（1.3.10）

**现场**：用户原话"阴影好像被一个框限制了" —— 圆角面板外面套了一圈**方角**光晕。

**根因**：`overflow` 会裁掉**后代**的 `box-shadow`。阴影画在 `.cxp-panel` 上，
而定位壳 `.cxp-root` 为了"矮窗口内部滚动"带着 `overflow:auto` —— 于是裁成矩形。

**修法**：利用"元素自身的 box-shadow 不受自身 overflow 影响" —— 把滚动安全网与阴影放到同一层：
`.cxp-root{overflow:visible}`（只当定位壳）+ `.cxp-panel{overflow:auto}` 并给它行内 `max-height`。
顺带修掉一个潜在问题：档位弹层（fixed）也是壳的子元素，以前同样可能被裁。

**断言**：第 35 节那条"`.cxp-root` 带 `overflow:auto`"的断言**反过来**了（现在必须 `visible`），
并断言面板带 `overflow:auto`、行内 `maxHeight` 与壳上那个同值。

---

## 8. 浅色主题的星尘是深色小点（1.3.4）

**现场**：用户原话"浅色模式的星尘颜色不对，深浅主题下星尘都要是浅色"。

星尘永远飘在**填充层**上（蓝→紫，那套颜色本身就是写死的、不随主题变），
而旧写法是 `background:var(--dsw-alias-label-primary,#eaf0ff)` ——
`label-primary` 在浅色主题下是**近黑色**，于是浅色模式里星尘成了深色小点、糊在紫底上几乎看不见。

现在写死浅色 `#eaf0ff` + 一圈固定微光。与 1.2.0 那半边的 `.ces-star__dot`（本来就是 `#fff`）口径一致，
也和 `.cxp-knob` 的固定白同一条纪律：**"必须保持是亮的"的东西不跟主题令牌走**。

**断言**：第 38 节 4 条（星尘底色不是主题令牌、alpha/颜色固定）。

---

## 9. 换模型总落在最高档（1.3.8）

**现场**：用户要求"点击使用时默认中间的档位，双数档就取中间的下一个，比如 4 档 → 第三档"。

改之前是"最后一档（Max）"或宿主声明的 `defaultEffort`。现在两处共用同一条规则
（`defaultLevelIndex`，0 基下标 = `floor(n/2)`）：**点击模型时写回宿主的档位**、以及
**目录里没有明确档位时滑条停在哪**。会话里**明确存着**的档位仍然优先（那是宿主的真实状态）。

**为什么以前没被发现**：既有 868 条断言里**没有一条**盯住这个行为，而且测试台默认模型的
`defaultEffort` 恰好**就是 4 档的正中**（`high`）—— 新旧规则在那里答案完全相同。
第 46 节 19 条专门用"没有 `defaultEffort`"和"`defaultEffort` = low"的模型把它们区分开。

---

## 附：几条通用的排查手法

- **先看插件管理器那一行**：`rows: []` + `error` 能直接区分"整包没加载"和"加载了但界面不对"。
- **把宿主的原话摆到界面上**（1.3.6 起）：`directoryFor()` 抛的异常里带着**是哪个会话 id**，
  静默 `catch` 掉就等于把线索扔了。
- **假宿主必须复刻真内核的规矩**，否则测试全绿也证明不了什么：
  槽没声明不能注册、`inject` 只等不抛、single 槽同优先级撞了会抛错、调用方 ctx 缺服务会报错。
- **位置/尺寸这类"渲染时现读"的东西，改了必须让组件重渲**（否则 store 变了界面纹丝不动）。
- **工具链会静默破坏产物**：BOM、缓存 rev、`overflow` 裁阴影 —— 都要有断言盯着，
  而不是靠"我记得"。
