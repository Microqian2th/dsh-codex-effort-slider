# 第一次把代码提交到 GitHub（网页操作版）

这份指南不需要 Git 命令，也不需要安装 GitHub Desktop。准备一个 GitHub 账号和本代码包即可。

## 先认识 5 个词

| 名称 | 可以怎么理解 |
|---|---|
| Repository / 仓库 | 存放项目文件和修改历史的地方 |
| Fork | 把别人的项目复制到自己账号下；不会改动原作者的项目 |
| Branch / 分支 | 在自己的项目里单独开一条修改路线 |
| Commit / 提交 | 保存一批文件修改，并写一句说明 |
| Pull Request / PR | 邀请原作者查看并决定是否合并你的修改；不是强制覆盖 |

**路线：原作者仓库 → 你的 Fork → 你的修改分支 → 上传文件并 Commit → 可选地发 PR。**

## 1. 创建自己的 Fork

1. 登录 GitHub。
2. 打开原仓库：<https://github.com/Microqian2th/dsh-codex-effort-slider>。
3. 点击页面右上方 **Fork**，再点 **Create a new fork**（界面可能略有变化）。
4. Owner 选择自己的账号，Repository name 通常保留 `dsh-codex-effort-slider`。
5. 点击 **Create fork**。
6. 确认地址变成 `github.com/你的用户名/dsh-codex-effort-slider`。以后上传文件要在这个页面，不是在原作者页面。

Fork 是公开复制。MIT 许可证允许这样做，但要保留原 LICENSE 和归属说明。

## 2. 创建修改分支

1. 在自己的 Fork 的 **Code** 页，点击文件列表上方的分支按钮（默认通常叫 `main`，也可能是别的名字）。
2. 输入 `perf/slider-preview-animation`。
3. 选择创建同名分支。创建前确认来源是默认分支。
4. 检查分支按钮现在显示 `perf/slider-preview-animation`。

以后提交这一批改动时，都选择这个分支。

## 3. 解压并确认目录

解压收到的压缩包，打开 `dsh-codex-effort-slider` 文件夹。

正确层级应该直接看到：

```text
package.json
README.md
LICENSE
lib/
test/
docs/
.github/
```

**不是把压缩包本身上传，也不要在仓库里再套一层同名文件夹。** 目标是让 GitHub 仓库根目录直接存在 `package.json`。

## 4. 上传代码（先对比上游）

本代码来自已发布的 **1.1.4**；本次整合已核对上游和 Fork 默认分支均为 `fc5a994`，客户端基线一致，并已准备 `perf/slider-preview-animation` 分支。如果你正在查看该分支，代码无需再手工上传。以下步骤保留给日后自行操作时参考；若上游之后出现新改动，应先重新对比再合并，不能直接覆盖。

如果版本对应：

1. 回到你的 Fork，确认仍处于刚创建的分支。
2. 点击 **Add file → Upload files**。
3. 从解压目录拖入以下文件/文件夹（拖文件夹时会保留内部路径）：
   - `lib`：客户端修改；宿主入口保留。
   - `test`：原有功能测试、测试桩和新增专项测试。
   - `docs`：通用说明、测试边界、PR 文本及本指南。
   - `.github`：测试工作流、PR 模板。
   - `README.md`、`package.json`、`.gitignore`、`LICENSE`。
4. 上游已有的 `preview`、截图和安装脚本无需覆盖；本次没有修复这些工具，不把旧预览当作新版演示。
5. 检查上传列表。例如应出现 `lib/client.js`，而不是 `dsh-codex-effort-slider/lib/client.js`。
6. 若系统隐藏了 `.github` 或 `.gitignore`，先打开“显示隐藏文件”，或者分别在 GitHub **Add file → Create new file**，输入对应路径并复制文件内容。
7. 在 **Commit changes** 填标题：

```text
perf: decouple slider preview from commits and optimize click animation
```

8. 如界面给出选项，提交到当前的修改分支，不要切回默认分支。
9. 点击 **Commit changes** 保存。

Commit 不会自动修改原作者的仓库，也不会发布到 npm。

## 5. 查看自动测试

1. 打开你 Fork 的 **Actions** 页。
2. Fork 的工作流可能默认未启用；如果出现提示，可以启用自己仓库的 Actions。
3. 查看名为 **Tests** 的工作流，等待检查结束。绿色表示通过，红色表示失败。
4. 本次推送包含 `push` 触发器，通常会自动运行。只有工作流已存在于默认分支时，才通常能看到 **Tests → Run workflow** 手动入口；目前仅在功能分支新增，看不到按钮是正常的，不必为此合并默认分支。如果 Actions 被禁用，先启用，再在功能分支提交后续必要改动触发；不要反复空提交。
5. 红色时打开失败任务，看日志；不要把它当成账号损坏，也不要盲目删除测试。

CI 使用 Node.js 22/24 和 Ubuntu/Windows。CI 在上传前尚未远端验证。离线测试通过也不代表真实界面已经验收。

## 6. 在 DSH 检查实际体验

按 README 的本地目录方式测试，避免同时启用两个同名插件。完整退出重开 DSH 后检查：

- 拖动时右上角文字即时预览，松手后最终档位正确。
- 连续单击不同档位，动画没有启动停顿或反向跳动。
- 模型菜单关开、进入子菜单再返回，滑条仍在。
- 方向键、Home/End 正常。
- 深浅主题、不同档位数量、右键设置正常。

PR 中只写自己实际验证过的 DSH 版本、系统和结果。**不要把离线计数写成“实测提升到 60 FPS”。**

## 7. 发 Pull Request（可选）

如果只想保留自己的改进版，到这里已经完成，不必发 PR。

想贡献给原作者：

1. 打开原仓库的 **Pull requests → New pull request**。
2. 点击 **compare across forks**（若界面已自动识别，则不需要）。
3. Base repository 选 `Microqian2th/dsh-codex-effort-slider`，base 选它的默认分支。
4. Head repository 选你自己的 Fork，compare 选 `perf/slider-preview-animation`。
5. 查看 **Files changed**，确认没有本机路径、日志、凭据、备份或大批无关文件。
6. 如果出现冲突、修改量异常或包含上游新代码的删除，先不要强行提交，停下来核对。
7. 点击 **Create pull request**。
8. 标题可以用上面的 Commit 标题，正文复制 `docs/PR_DESCRIPTION_ZH.md` 后按实际情况填写。
9. 不确定是否准备好时，选择 **Create draft pull request**，即草稿 PR。

发出 PR 后，原作者可能提问题、要求调整或不合并，这都正常。你的 Fork 不会因此消失。

## 不需要做的事

- 不需要输入 npm 账号或执行 `npm publish`。
- 不需要把整个电脑工作目录上传。
- 不需要上传 `.env`、DSH profile、会话记录、API key、`node_modules`、本机备份或验收日志。
- 不需要先改包名。插件内部 ID、包名和 Cordis 配置有对应关系，不宜单独改一项。
- 不要删除原 LICENSE，也不要把原作者改成只有自己。

## 如果暂时只想本地跑测试

安装 Node.js 22 或更高版本，在解压后的仓库目录打开终端，运行：

```sh
node test/run-tests.mjs
```

测试无需 DSH、Git、npm 登录或安装额外依赖。Windows 的 PowerShell 若限制 `npm.ps1`，使用上面的 `node` 命令，或使用 `npm.cmd test`，不必为此降低系统执行策略。
