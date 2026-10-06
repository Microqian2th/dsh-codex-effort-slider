# dsh-codex-effort-slider

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的 **Codex 风格推理等级滑条**。

**一档一色、越往右越"通电"**：填充从蓝渐变到紫罗兰，高档位亮起紫色星云与星尘粒子，
连官方那一行的数值文字也跟着变色（`Off` 档保持官方灰）。

## 装好之后长这样（真机截图）

收起态：档位就在输入框里那枚模型席按钮上，**点开之前**也按档位着色。

![收起态：输入框里的档位显示](preview/screenshots/shot-01.png)

点开模型菜单后（左列浅色主题 / 右列深色主题，四档从上到下）：

| 档位 | 浅色主题 | 深色主题 |
|---|---|---|
| **Max** | ![浅色 Max](preview/screenshots/shot-02.png) | ![深色 Max](preview/screenshots/shot-06.png) |
| **High** | ![浅色 High](preview/screenshots/shot-03.png) | ![深色 High](preview/screenshots/shot-07.png) |
| **Low** | ![浅色 Low](preview/screenshots/shot-04.png) | ![深色 Low](preview/screenshots/shot-08.png) |
| **Off** | ![浅色 Off](preview/screenshots/shot-05.png) | ![深色 Off](preview/screenshots/shot-09.png) |

对比度都算过（最高档的数值文字：白底 **4.23:1**、深色底 **4.02:1**）。
**不用安装也能先玩**：浏览器打开 [`preview/panel.html`](preview/panel.html)，可拖动、切浅深色、切 4/2/6 档模型
（另有脚本生成的实现示意图：[`preview/seat-color.png`](preview/seat-color.png)、[`preview/distribution.png`](preview/distribution.png)）。

它不新增入口：**直接改造官方模型菜单里的「推理等级」那一行** ——
那一行被加高上下内距、允许折行，滑条作为第二行铺满整行宽度；拖到最高档时整条轨道亮起紫色能量层。

```
点开官方模型菜单后：
┌────────────────────────────────────┐
│ 模型             DeepSeek-V41-Flash › │   ← 官方原样
├────────────────────────────────────┤
│ 推理等级                       Max › │   ← 官方原样（label / value / chevron 一个没动）
│ ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━    │   ← 插件注入的滑条（这一行因此被加高）
└────────────────────────────────────┘
输入框工具行：**不加任何东西**（没有胶囊、没有浮层）
```

拖到最高档：轨道变为**紫色星云**（流向渐变 + 扫光 + 22 颗错峰星尘粒子），那一行同时描一圈紫边。

**30 秒上手**：下载/克隆本仓库 → 双击 `install.cmd`（或按下面的「安装」一节）→
**完全退出并重开** DSH Desktop。

## 安装

> 不想 clone 的话,直接下载打包好的 zip:[**Releases → dsh-codex-effort-slider-1.0.0.zip**](https://github.com/Microqian2th/dsh-codex-effort-slider/releases/latest)。

**只走 DSH Desktop 自己的插件面板**——命令行装不了 `desktop` profile：

```powershell
dsh plugin --profile desktop add link:"F:\Work Space\DeepSeek Harness\dsh-codex-effort-slider"
# error: profile "desktop" is managed exclusively by the Electron application
```

（这不是配置问题：`bin.js` 里对 `desktop` 直接 `program.error`，只有 Electron 应用本人被允许管理这个保留 profile。）

两条路：

1. **面板安装**（推荐）：**设置 → 插件 → 添加插件** → 填本地目录路径 → 安装 → 重启 DSH Desktop。
   面板会校验两件事，本插件都已满足：是有效的插件包、声明了组合包（`dsh.bundle.patch`）。
2. **手工安装**（当面板本身不可用时——例如 `profileContext` 没挂上，`dsh-base` 会把
   `plugin-manager` 整行 `disabled`，设置侧栏里就看不到「插件」）：
   备份 profile 的 `package.json` → 加一条 `link:` 依赖 → `dsh.profile.bundles` 追加本包名 →
   在 `profiles/<profile>/node_modules/` 下建一个指向本目录的 junction → 重启。

> 卸载用面板；手工装的用 `cmd /c rmdir <junction>`（**不要**用 `Remove-Item -Recurse`，
> 那可能顺着 junction 把插件目录里的文件删掉）。

想先看观感、不装也行：`node preview/make-preview.mjs` 生成 `preview/panel.html`，
用浏览器打开即可拖动、切浅深色、切 4/2/6 档模型（页面里连官方菜单外壳都复刻了，
CSS 与拖动数学都是从真产物抽出来的）。

## 分享给别人

### 打包

```powershell
npm run pack      # = powershell -NoProfile -ExecutionPolicy Bypass -File pack-dist.ps1
```

产出 `dist/dsh-codex-effort-slider-<version>.zip`（约 350 KB）。本插件**零运行时依赖、无构建步骤** ——
解开就能装，接收方不需要 `pnpm install`。若要让人从 GitHub / npm 装，把**本目录的内容**推到仓库根
（`package.json` 必须在仓库根，pnpm 才能把它当包解析）。

### 接收方怎么装（三种，按省事程度排序）

1. **面板安装（推荐）**：DSH Desktop → **设置 → 插件 → 添加插件**，填三者之一：
   - **本地目录路径**（解开 zip 后那一层目录）
   - **`github:<用户名>/<仓库>`**（面板会先做一次 GitHub 连接检查，再交给 pnpm 拉取）
   - **npm 包名**（走 registry；DSH 默认已配 npm 镜像作为回退）
2. **命令行**（**只有非 desktop profile 能这么装**）：
   ```powershell
   dsh plugin --profile tui add link:"<插件的绝对路径>"
   dsh plugin --profile tui add github:<用户名>/<仓库>
   ```
   `desktop` 是 Electron 保留 profile，命令行会被直接拒绝
   （`error: profile "desktop" is managed exclusively by the Electron application`）。
3. **脚本**（desktop profile 且设置里没有「插件」面板时）：
   ```powershell
   install.cmd                    # 装进 desktop
   install.cmd -Profile tui       # 装进别的 profile
   install.cmd -Uninstall         # 卸载
   ```
   `install-profile.ps1` 做四件事：备份 profile 的 `package.json` → 加一条 `link:` 依赖 →
   把包名追加进 `dsh.profile.bundles` → 在 profile 的 `node_modules` 下建链接
   （Windows 用 junction，其它平台用符号链接），最后校验这三项都成立。
   **已用一个假 profile 完整跑过安装与卸载**，并确认卸载只删链接、不会顺着链接删掉插件本体。

### 注意事项

- `link:` 里是**绝对路径**，所以每台机器装完都必须指向自己的目录（面板/脚本会自动写对）。
- 改过 `lib/client.js` 后**必须完全退出并重开** DSH Desktop 才生效 —— 宿主在启动时把插件读进内存，
  只关窗口不够。
- **卸载**：面板卸载，或 `install.cmd -Uninstall`；手工建过 junction 的用 `cmd /c rmdir <junction>`。
  **不要**用 `Remove-Item -Recurse`，它可能顺着链接把插件目录里的文件删掉。
- **兼容性**：DOM 锚点全部是官方**语义属性**（`aria-haspopup` / `aria-expanded` / `aria-controls` / `role`）
  加两个官方 class；哈希前缀不依赖（收起态那段档位文字是**按文字**认的）。官方若改语义，插件
  **静默不生效**（fail-open），不会把官方界面改坏。本插件**不注册任何宿主钩子、不注入消息**
  （测试里有 `ctx.on` 监视断言守着这一点）。
- 许可 MIT（见 `LICENSE`）。`package.json` 里现在是 `"private": true`（**要发 npm 得先删掉这一行**）。

## 它怎么工作（两半）

| 半边 | 干什么 |
|---|---|
| `lib/index.js`（宿主） | 空逻辑 + 一次客户端产物静态核对。存在的唯一理由是让本包成为 cordis 树上的一行，否则 `dsh.client` 的 bundle 不会被扫进启动图 |
| `lib/client.js`（客户端） | 一个不可见锚点（注册进 `conversation.input.right`，用来拿 `sessionId` 与 `ctx`）+ **DOM 桥** + 滑条（`react-dom` portal 注入官方那一行） |

### DOM 桥依赖的官方锚点（全部是**语义属性**，不是哈希 class）

| 锚点 | 官方产物里的形状 |
|---|---|
| 席：`button[aria-haspopup="menu"][aria-expanded="true"]` | `<button aria-haspopup="menu" aria-expanded={open} aria-controls={…}>` |
| 菜单：席的 `aria-controls` → `getElementById(…)` | 菜单 `id={…-menu}`，portal 到 body |
| 目标行：菜单里 `button[role="menuitem"]` 的**第 2 个** | 根面板恰好两行（模型 / 推理等级）；子面板用 `menuitemradio`，所以 `menuitem` 唯一标识根面板 |
| 归属判定：从自己的锚点向上找 `[data-composer-card]` | composer 卡片带这个标记；打开的那颗席必须在**自己的** composer 里 |

**只改那一行**：写 4 个内联样式（`height:auto` / `flex-wrap:wrap` / `padding-block:10px`）+ append 一个容器；
关菜单或插件卸载时逐个还原。不碰官方 class、不改官方文字与 chevron。

**fail-open**：任何一步认不出（没有 `aria-controls`、不是根面板、不是自己的 composer、
目录里没有档位、会话作用域没就绪）就**什么都不做** —— 官方菜单保持原样，绝不会因为本插件点不开。

官方菜单是"测量后固定定位"的，插件加高那一行后会派发一次 `resize`，
官方自己的 `place()` 会重新读 `offsetHeight` 并重新夹取位置。

## 数据路径（只用官方公开面）

| 用途 | 接口 |
|---|---|
| 读档位 | `directoryFor(sessionId).store.getSnapshot()` → `groups[].models[].reasoning.efforts` |
| 写档位 | `directory.select({ provider, model, reasoningEffort })`（与官方菜单同一写入口） |
| 订阅 | `store.subscribe()` + `React.useSyncExternalStore` |

## 色彩与粒子（**由位置连续驱动**，与档位数无关）

拖到哪，颜色与粒子就跟到哪。三个纯函数（都有断言）：

| 位置 `pct` | 颜色 `fillColorFor` | 能量 `energyFor` | 粒子数 `particleCountFor` | 速率 `speedFor` |
|---|---|---|---|---|
| 0（第一档） | 蓝 `#4d93f8` | 0 | 0 | 0.35× |
| 1/3（第二档） | 蓝（**第一档到第二档恒为蓝**） | 0 | 0 | 0.35× |
| 2/3（high） | 紫 `#9333ea` | 0.5 | 11 / 22 | **1×（就是"现在这个速度刚刚好"）** |
| 1（max） | 深紫 `#4c1d95` | 1 | 22 / 22 | **2×** |

- **颜色**：填充层是 `linear-gradient(90deg, 蓝, 当前位置的颜色)` —— **左端恒为蓝、右端是当前位置的颜色**，
  所以 high 档自然呈现"左蓝右紫"，越往右右端越深（深紫 `#4c1d95`）。
- **能量层**（紫色星云 + 扫光）强度 = `energyFor`，它在第二档以前是 0 —— 所以左半段是**干净的蓝**，
  往右才逐渐"通电"；官方那一行的紫边透明度也跟着能量走（`0.16 + 0.34 × energy`）。
- **能量条只覆盖已填充那一段**：能量层宽度与填充层完全相同（都到旋钮圆心），
  所以**档位右边没达到的部分不会出现能量条**，只剩轨道底色。
- **Off 档在"两个界面"里都保持官方灰**（`isOffLevel` + `valueColorFor` 返回**空串**）：
  Off 档时既不给菜单里那一行的数值文字上色，也不给收起态席按钮上的档位文字上色 ——
  空串 = 不写内联色 = 官方原本的颜色。档位是不是"关"按 **id 和 name 都认**（`off`/`none`/`关闭`/`无`，
  大小写与空格不敏感；DeepSeek 的真实档位表见 `dsh-llm-deepseek/lib/index.js` 的 `REASONING_EFFORTS`）。
  Off 档本身也没有能量层（energy 0 → 纯蓝、无星云、无星尘）。
- **刻度点更小更淡**（用户要求）：`5px → 3px`；已达刻度 `rgba(255,255,255,.92) → .5`，
  未达刻度 `color-mix(... 38% → 26%)`。改小改淡之后它们不再和星尘粒子抢眼。
- **星空（所有出现粒子的档位都用这一套，动画已统一）**：
  - **不消失**：外层是一条**整轨宽度**的轨道，自己在做 `translate3d(-100%)` 的连续横穿；
    残影只在 0%/6% 与 94%/100% 淡出淡入 —— 那两端在可视区外，所以看起来星星**从不消失**。
    （旧的"短掠过 + 原地淡出"那套逻辑与 CSS 已整体删除，有断言守着 `.ces-particle` / `ces-drift` 不再存在。）
  - **亮度随机、越亮越大**：每颗的亮度/大小系数由确定性伪随机给出，落在 **0.5 ~ 1** 之间
    （1 = 3px 与亮度 100%）；圆点用 `opacity:var(--ces-b)` + `transform:scale(var(--ces-b))`，
    所以"亮的那颗同时更大"。
  - **速度随位置变化（保留）**：横穿时长 = `STARFIELD_DURATION_MEAN × MAX_SPEED_FACTOR / speedFor(pct)`
    —— **MAX 档 1.5s、high 档 3s、第二档附近约 8.6s**（位置速率 2× / 1× / 0.35×）。
  - **星星单独一层，不跟星云淡入**：星云层（紫色渐变 + 扫光）的透明度 = 能量强度，high 档只有 0.5；
    若星星套在里面，每颗的实际不透明度会被压到 0.25~0.5，在紫色底上几乎看不见
    （用户实测反馈"high 档一打开几乎没粒子"）。所以星星放在 `.ces-stars` 独立层，
    透明度 = `starLayerOpacityFor`（high 档 **0.8**、MAX 档 **1.0**），"逐渐出现"交给**粒子数**表达。
    **MAX 档观感与之前完全一致（都是 1.0），没有动。**
  - **各星之间只差 ±8%**（`STARFIELD_DURATION_SPREAD`）：保留"有的稍快有的稍慢"的层次，
    又不会像原来 0.95–2.05s（速度差 **2.16×**）那样快星追上慢星排成一队。
  - **高度 = 随机排列的等距槽位，并与相位解耦**（8%~92% 用满轨道高度）：
    早期版本高度和相位**取自同一个数** `frac((i+1)×φ)`，于是"越靠右的星越高"，22 颗排成
    一条斜线（用户实测反馈"太规整，再随机一点"；高度↔相位相关系数实测 **0.999**）。
    现在高度是一条**确定性随机排列**（哈希排序，不用 `Math.random`），并自动挑一个盐值
    保证**相位相邻**（会一直并排在轨道上走）的两颗至少差 **28%** 轨道高，不会并成一坨。
    相关系数实测 **−0.110**（有断言守着 `|r| < 0.35` —— 旧版会直接失败）。
  - **相位只跟 index 有关、跟"当前显示几颗"无关**（黄金比低差异序列，任意前缀都铺得开）：
    拖动改变粒子密度时不会改写已挂载动画的 `animation-delay`，所以**进档那一下不会被整体重排**。
  - **时长与相位直接内联**写在元素上（`animationDuration` / `animationDelay`），
    **不走 CSS 变量**：真引擎实测（无头 Chromium 逐帧读 `getComputedStyle`）两种写法相位都成立，
    但内联更少一层不确定性，"减少动态效果"的放缓也顺势改到 JS 里算（`REDUCED_MOTION_SLOWDOWN`）。
  - 伪随机是**确定性**的（`starHash01`，不用 `Math.random`）：重渲染不跳变，且可离线断言。

**"聚集"的量化对照**（模拟真产物参数，轨道 300×28px，两星中心距离 <6px 记为粘住）：

| t=0.2s（刚进档） | t=0.4s | t=1s | t=2s | t=3s |
|---|---|---|---|---|
| 3 对 → **0 对** | 1 对 → **0 对** | 4 对 → 2 对 | 7 对 → 4 对 | 4 对 → **0 对** |

**长期行为（如实标注）**：只要每颗星的时长不完全相同，相位就会**缓慢互相错开**，最终趋近随机分布
（22 颗里总会有几对偶尔靠近）。实测粘住对数随每颗星时长浮动变化：

| 每颗星时长浮动 | t=0.5s | t=1s | t=2s | t=5s |
|---|---|---|---|---|
| **±8%（当前）** | 1 | 7 | 9 | 17 |
| ±4% | 0 | 2 | 7 | 10 |
| ±2% | 0 | 0 | 2 | 11 |
| **0%（全同速）** | **0** | **0** | **0** | **0** |

也就是说：**想彻底永不聚集，就把 `STARFIELD_DURATION_SPREAD` 设成 0**（代价是所有星速度完全一致，
少了"有的快有的慢"的层次）；保留 ±8% 则偶尔会有几颗靠近一下再分开。这个数字由常量控制，随时可调。
- **官方那一行的数值文字（"Max" / "High"）也会跟着变色**（`valueColorFor`）：
  与能量同源，**蓝 → 靛 → 紫罗兰**，越往右越"通电"。写的是内联 `color`（内联优先于官方样式表），
  关菜单时由桥还原；**文字内容一个字都不碰**（断言：内容仍归官方管，标签与"模型"那一行完全不动）。
  终点色 `COLOR_TEXT_VIOLET = #8b5cf6` 是**照着对比度挑的**：白底 **4.23:1**、深色底(#1b1c20) **4.02:1**，
  两种主题都读得清（先试过更亮的 `#c084fc`，浅色主题只有 2.6:1 发虚；测试里有对比度断言挡着）。
  **Off 档例外：不上色，保持官方灰**（见上）。
- **收起态的模型席按钮**（`DeepSeek-V41-Flash  High  ⌄`，**点开菜单之前**就看得见那个档位）同样着色：
  官方那一小段文字是 `triggerEffort` 这个**哈希 class**（前缀随构建变，靠 class 认迟早失效），
  所以按**文字**认 —— 官方 trigger 里的文字就是档位的 `name`，和我们从目录读到的是同一份数据
  （已对照官方源码 `dsh-client-ui-model-selection/lib/client.js:860-867` 确认那是个 `<span>`）。
  传的是**全部档位名**而不是"当前那个"：档位刚切换、官方还没重渲染席按钮时文字还是旧的，
  只认当前名字会在那一瞬间掉色。
  - 席上显示的是**已生效**档位，所以拖动过程中它不跟着草稿跳，提交后才变（有断言）。
  - 官方重渲染换了节点 → 桥在重新抓到的那一刻立刻补色（不必等 React 再渲染一次）。
  - 组件卸载时还原；认不出任何已知档位名就**什么都不做**（fail-open：绝不动模型名等别的文字）。
- **`prefers-reduced-motion`**：**放缓而不是冻住** —— 收起扫光、粒子周期 ×2.6，并在滑条的 `title`
  里说明原因（冻成静态图会让"能量在流动"这个表达整个消失）。
- **配色跟随主题**：轨道底色用 `--dsw-alias-border-l1`；浅色/深色都自动跟随。

## 旋钮几何（顶头适配）

旋钮是**正圆，直径 = 轨道高度**（`TRACK_HEIGHT = KNOB_SIZE = 28px`），
圆心只在 `[14px, 宽度 − 14px]` 之间移动：

```
left = calc(14px + pct × (100% − 28px))     ← 旋钮、填充终点、刻度共用这一个几何
```

所以 `pct=0` 时圆心落在左端圆角内、`pct=1` 时落在右端圆角内，圆**永远是完整的圆**
（之前圆心跑到两端之外，圆被官方菜单的 `overflow:hidden` 切掉右半边，
看起来就像个圆角方块 —— 这也是把直径加大到与轨道同高的原因）。
指针映射也用同一套内缩几何（`pctAt`），所以拖到最左/最右必定命中端点档位。

### 填充层的圆角：左端半圆 + 右端直角

**填充层的宽度 = 旋钮圆心位置**，所以贴最左时它只有 **14px 宽**（= 一个半径）。
这里不能用轨道那种 `border-radius:999px`：CSS 规定「一条边上两个角的半径之和不能超过这条边」，
超了就四角按同一因子等比缩小 —— 14px 宽会把 999px 压成 `14 ÷ 2 = 7px`，
左端从半圆退化成「半径 7 的圆角 + 上下各 7px 直边」，那两段直边露在旋钮（半径 14 的整圆）之外，
看起来就像旋钮左边被切成了方的。

所以填充层（`.ces-fill` / `.ces-energy` / `.ces-stars` 三层共用 `FILL_RADIUS`）写的是**显式值**：

```
border-radius: 14px 0 0 14px      ← 左上/左下 = 旋钮半径；右上/右下 = 直角
```

两条理由缺一不可：

- **左端必须是半径 14 的真半圆**，才能和旋钮完全同形、被完全盖住；
- **右端必须是直角**：填充右边界恒等于旋钮圆心，旋钮还会再向右多盖一个半径，
  所以右端的角一定看不见 —— 而且正因为右边不占圆角，「宽度」这条边就不再超标，
  收缩规则根本不触发，左端半径才能恒定是 14px（`border-radius` 与宽度彻底解耦）。

（曾经踩过：三层都写 `999px`，结果**只有最低档**出问题 —— 因为只有 `pct=0` 时才窄到 14px。
回归断言见 `test/client.test.mjs` 第 2c 节，它按 CSS 收缩规则逐个位置验算左端半径。）

## 稳健性（每条都有断言）

- `directoryFor()` 在会话作用域就绪前**按设计抛错** → 退避重试（60ms 起，约 9 秒）+ 自愈；
  档位数是**后到**的，桥会在档位数变化时主动重扫（DOM 不会因为 store 变化而产生 mutation）。
- 写入失败 / 超时（10s）→ 回滚到真实档位并显示原因，**不谎报成功**。
- 拖动写入有**同档位去重 + 在途合并 + 120ms 降频**：1 秒内 60 次拖动最多 3 次写回，
  落在当前档位时 0 次；松手必定落地。
- 滑条吞掉自己的 pointer/click/方向键事件，**不会误触官方那一行的 onClick**（那会跳进等级列表）。
- 组件卸载时清掉降频定时器；桥卸载时还原那一行的样式并摘掉容器。

## 开发

无构建步骤：`lib/client.js` 就是发布产物（手写、可读，`require("react")` 与 `require("react-dom")`
走宿主模块表的平台种子词）。

```powershell
npm test          # 离线断言套件（272 项：几何/色彩/星空/注入/失败回滚/无注入回归）
npm run preview   # 生成 preview/panel.html
```

测试台 `test/harness.mjs` 里有一份**保状态**的 React 桩、够用的假 DOM（含 portal、MutationObserver、
多属性选择器）、以及一个**假官方菜单**（形状逐字对齐官方产物）。本机没有可离线使用的真 React
（`app.asar` 里不带），所以渲染层是桩件驱动的；数据路径与 DOM 注入路径跑的都是真代码。

第 12 节断言会**直接读解包出来的官方产物**校验那 4 个语义锚点还在（`aria-haspopup` / `aria-expanded` /
`aria-controls` / `role="menuitem"` + 官方文案 + `resize` 重测），官方改版导致锚点漂移时会先炸测试，
而不是静默失效。本机没有解包产物时该节自动跳过。

## 已知限制

- 需要重启 DSH Desktop 才生效（客户端 bundle 在启动时注入）。
- 控制项活在官方菜单里，所以**必须先点开模型菜单**才能改档位；输入框工具行上没有常驻读数。
- 依赖官方菜单的 DOM 语义属性。官方若改成非 `menuitem` 结构、去掉 `aria-controls`、
  或不再用 `data-composer-card`，本插件会**静默退回"什么都不做"**（官方菜单照常可用）。
- 那一行加高约 20px + 滑条 28px，菜单总高会变大；官方会自己重测位置，但极小屏幕上可能出现
  菜单贴边（官方自身的 `max-height` 与夹取逻辑仍在）。
- 主题令牌缺失时回退到中性灰 + `#4d93f8` 蓝，观感可用但不如在 DSH 内贴合。

## 许可

MIT。无第三方代码：闪电标/雪弗龙是自己画的路径，粒子层是自己写的 DOM/CSS。
