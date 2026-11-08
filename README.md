# dsh-codex-effort-slider — 性能改进分支

用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的推理等级滑条，基于 [Microqian2th/dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider) 的已发布 **1.1.4** 整理。

> 这是 [Yutai233 的性能改进分支](https://github.com/Yutai233/dsh-codex-effort-slider/tree/perf/slider-preview-animation)，不代表上游已经合并或发布。整合时已核对：Fork 与上游默认分支均位于 `fc5a994`，客户端基线与本次修改前的 1.1.4 一致。原作者、许可证和包标识保留。当前 npm 包名仍指向上游发行版，不能用它判断是否装到了本分支。

## 使用行为

- 拖动：滑条和菜单右上角档位文字实时预览，**松手后才提交最终档位**。
- 单击：点击轨道对应位置，松手确认，旋钮连续移动到目标档位。
- 键盘：方向键调整，Home/End 到两端。
- 右键或长按滑条：打开动画和刻度设置。
- 收起态模型按钮显示已生效档位，而非尚未提交的拖动预览。
- 提交失败会回滚；关闭菜单或卸载时恢复真实档位文字。

## 本分支改了什么

1. **预览与提交分离**：去掉拖动跨档时的宿主写回，保留松手/键盘提交、同档去重及错误处理。
2. **高频视觉更新脱离 React state**：rAF 通过 ref 同步位置、标签、ARIA、title 和刻度，拖动起手/跨档不再引起组件重渲染。
3. **减少布局读写**：旋钮用 `translate3d`；三层填充保持全宽、以 `clip-path` 控制终点；轨道几何按需缓存，在按下、滚动、resize 和 ResizeObserver 通知时刷新。
4. **稳定粒子**：固定 22 个粒子节点，通过可见性和暂停状态控制密度；固定 duration/delay，避免不断重设动画相位。
5. **减少重绘工作**：静态位置渐变；固定阴影层加 opacity；边框及文字颜色按需更新，不逐帧重建背景和不同强度的阴影。
6. **改善单击起步**：首帧按 1/60 秒推进，之后根据实际帧间隔，以不大于 1/120 秒的子步积分。
7. **收窄 DOM 扫描**：过滤插件自身及无关子树变化，按帧合并扫描，并覆盖同一菜单容器内的面板往返。
8. **完善生命周期**：节点身份绑定几何缓存、提交后同步补画、预览文字恢复、诊断实例编号固定。

### 有意改变的交互/观感

- **跨档不再立即写回宿主**，而是松手确认。
- 粒子速度固定在原 High 档基准（完整模式约 3 秒横穿，粒子间保留小幅差异）；简洁模式仍放缓。密度仍随位置变化。
- 渐变固定在轨道位置，不再每帧拉伸到填充终点。
- 行边框不再连续改变透明度；独立光晕层负责能量渐入。

这些不是“完全不改变行为”的内部重构，请维护者评估后再合并。

## 本地测试

需要 **Node.js 22 或更高版本**。没有额外 npm 依赖，不需要先安装 React 或 DSH。

```sh
npm test
```

也可以直接运行，避免依赖 npm：

```sh
node test/run-tests.mjs
```

单独运行：

```sh
npm run test:functional
npm run test:performance
npm run test:lifecycle
```

- 功能测试：689 项离线断言；未提供真实宿主产物时，会明确跳过可选的宿主源码契约检查。
- 性能行为测试：检查拖动不渲染、不写回、只测量一次；单击首帧有位移、动画过程无额外渐变/阴影写入等。
- 生命周期测试：同菜单容器返回、观察器过滤/合并、滚动期间继续补画。
- CI 配置：Node.js 22 / 24 × Ubuntu / Windows。仅配置了 CI；须推送后在 Actions 页面确认远端执行结果。

如需额外检查真实宿主产物，可以设置 `DSH_MODEL_SELECTION_BUNDLE` 为可读取的 model-selection 客户端脚本路径后运行功能测试。不提供就跳过；提供无效路径会失败。不要把宿主产物或本机配置提交到仓库。

**测试边界：**使用假 DOM、假 React 和假宿主。它们不能证明真实 Chromium 的 FPS、GPU 开销、最新 DSH 兼容性或视觉完全一致。真实浏览器检查清单见 [测试说明](docs/TESTING.md)。

## 安装本分支

推荐先解压/下载到一个固定目录，在 DSH 的 **设置 → 插件 → 添加插件** 中使用该本地目录（包含根目录的 `package.json`）。安装后完全退出并重开 DSH。不同 DSH 版本的面板名称或支持方式可能不同，以实际界面为准。

当前修复在独立分支，尚未合入本 Fork 的 `main`。可直接 [下载修复分支 ZIP](https://github.com/Yutai233/dsh-codex-effort-slider/archive/refs/heads/perf/slider-preview-animation.zip)，解压后用本地目录安装；支持 GitHub 分支来源的插件面板也可使用：

```text
github:Yutai233/dsh-codex-effort-slider#perf/slider-preview-animation
```

不要省略分支名，否则会读取尚未包含修复的默认分支。**不要同时启用上游版和改进版。** 已安装上游版时先通过插件面板切换来源，操作前备份配置。只刷新页面未必会重新读取宿主缓存的插件脚本。

本次整理没有重写或重新验证原项目的安装脚本；不要为测试而直接改写真实 profile。

## 打包

```sh
npm pack
```

生成本地 `.tgz` 包，不会上传 npm。`npm publish` 才是发布命令，本项目不要求执行它。上游仓库已有的 Windows ZIP 工具仍保留在 `npm run pack`；本分支没有运行会改写本地打包暂存目录的旧脚本。

现有 `install.cmd` / `install-profile.ps1`、`preview/` 和截图资源沿用上游。**历史预览页没有同步本次新渲染及提交逻辑，不能用来演示或证明新版行为。** `npm run preview` 仅保留旧工具入口，不属于本分支验收范围。

## 提交到 GitHub

第一次使用 GitHub，请从 [中文网页提交指南](docs/GITHUB_GUIDE_ZH.md) 开始。已准备好 [PR 描述](docs/PR_DESCRIPTION_ZH.md)；复制内容并填入自己的测试环境即可。

代码与测试主要位于：

```text
lib/client.js                    客户端修复
lib/index.js                     保留上游宿主入口
test/client.test.mjs              功能测试
test/harness.mjs                  离线测试桩
test/performance.test.mjs         无本机备份依赖的性能行为检查
test/lifecycle.test.mjs           生命周期回归
test/run-tests.mjs                跨平台测试入口
.github/workflows/tests.yml      自动测试配置
docs/                            通用说明、测试边界和提交指南
```

## 许可证与致谢

基于 Microqian2th 及原项目贡献者的工作，继续采用 [MIT License](LICENSE)，保留原有版权及许可声明。性能修复不改变原项目归属，也不代表上游官方发行。
