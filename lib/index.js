/**
 * better-dsh-codex-effort-slider — 宿主半边（零依赖、空逻辑）
 *
 * 这个插件的全部功能都在客户端半边（`lib/client.js`）。宿主半边存在的唯一理由是
 * **让这个包成为 cordis 树上的一行**：`dsh.client` 的客户端 bundle 是靠
 * 「宿主 Loader 的条目里有这个包」被 `dsh-client-modules` 扫出来、编进
 * `window.__DSH_BOOT__` 的。没有宿主条目，客户端产物永远不会被加载。
 *
 * 三条纪律（沿用 DSH 生态里已被事故验证过的形状）：
 *   1. **apply() 绝不抛错**：同步抛错会让该条目的 fiber 失败，启动审计会把它报成
 *      「Failed to load plugins」。这里它什么都不做，所以也没有可抛的东西。
 *   2. **inject 只声明确定存在的服务**：本插件宿主半边**不声明任何服务**
 *      （申明一个从未被 provide 的服务会让 fiber 停在 PENDING，从而拖累整棵插件树）。
 *   3. **不打日志噪音**：加载成功不值得写一行日志；出问题时该看的是客户端心跳。
 *      因此这里只在 bundle 缺失时告警一次 —— 那是唯一一种「插件装了但界面不会有东西」
 *      的宿主侧可观测故障。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_ID = "better-dsh-codex-effort-slider";

/**
 * 静态核对客户端产物：只读文件、查关键标志，**不执行**产物。
 * 任何问题只告警，绝不阻断启动（这份产物坏了，坏的也只是那一块控件）。
 *
 * 1.3.0 起客户端是**两个文件**（第二个是**包内动态 chunk**，由模块表的 `require.async` 取）：
 *   · `lib/client.js` —— 官方菜单那一行那条控件 + 接线
 *   · `lib/client.picker.js` —— 自建浮层（code.html 那套界面）。文件名必须匹配宿主的
 *     `client.*.js` 规则，否则 `/plugins/<包名>/client.picker.js` 这条路由不会 serve 它。
 * 少任何一个的后果不同：少了 client.js 两边都没了；少了 chunk 只有自建浮层没了，
 * 所以这里分开报，别让一条告警掩盖另一条。
 */
function auditClientBundle(log) {
  const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

  try {
    const bundle = read("./client.js");
    const problems = [];
    if (!bundle.includes(`id: "${PACKAGE_ID}"`) && !bundle.includes(`id:"${PACKAGE_ID}"`)) problems.push("bundle id 不匹配");
    if (!bundle.includes("__ModuleLoader__.load")) problems.push("不是模块加载器 bundle");
    if (!bundle.includes("return module.exports")) problems.push("工厂没有交出 exports");
    if (!bundle.includes("conversation.input.right")) problems.push("没有声明目标插槽");
    if (!bundle.includes("conversation.input.overlay")) problems.push("没有声明自建浮层的插槽");
    if (!/exports\.apply\s*=/.test(bundle)) problems.push("没有导出 apply");
    if (problems.length > 0) {
      log(`客户端产物 lib/client.js 检查未通过（界面可能不会出现滑条）：${problems.join("；")}`);
      return;
    }
    log(`客户端产物 lib/client.js 就绪（${Buffer.byteLength(bundle, "utf8")} 字节，静态检查通过）`);
  } catch (error) {
    log(`客户端产物 lib/client.js 不可读（界面不会出现滑条）：${String(error)}`);
    return;
  }

  try {
    const picker = read("./client.picker.js");
    const problems = [];
    // chunk 是 `npm run build` 从 .src.js 生成的**自注册**产物（不再是 ESM）：
    // 宿主 serve 时不会替它包壳，所以它必须自己调 __ModuleLoader__.load 注册。
    if (!picker.includes("__ModuleLoader__.load")) problems.push("没有自注册（不是可用的包内 chunk）");
    if (!picker.includes('chunk: "client.picker.js"')) problems.push("注册时没带 chunk 文件名");
    if (!picker.includes("createPickerTrigger")) problems.push("没有导出 createPickerTrigger");
    if (!picker.includes("createPickerSurface")) problems.push("没有导出 createPickerSurface");
    if (!picker.includes("pickerStore")) problems.push("没有模块级 pickerStore（两条插槽共享开合状态）");
    if (!picker.includes("data-slot")) problems.push("没有双页 carousel 的舞台");
    if (problems.length > 0) {
      log(`自建浮层 lib/client.picker.js 检查未通过（自建面板不会出现，官方菜单那条路不受影响）：${problems.join("；")}`);
      return;
    }
    log(`自建浮层 lib/client.picker.js 就绪（${Buffer.byteLength(picker, "utf8")} 字节，静态检查通过）`);
  } catch (error) {
    log(`自建浮层 lib/client.picker.js 不可读（自建面板不会出现，官方菜单那条路不受影响）：${String(error)}`);
  }
}

/**
 * @param ctx 宿主 cordis 上下文（本插件不使用它的任何能力）
 */
export function apply(ctx) {
  try {
    const candidate = ctx?.logger;
    const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
    const log = (message) => {
      try {
        if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
        else console.info(`[${PACKAGE_ID}] ${message}`);
      } catch {
        /* 连日志都不能抛 */
      }
    };
    auditClientBundle(log);
  } catch {
    /* 审计本身失败也必须让 apply 静默成功 */
  }
}

export default { apply };
