/**
 * 把 `lib/client.picker.src.js` 包成 **包内动态 chunk**：`lib/client.picker.js`
 *
 * 为什么需要这一层：自建浮层不能放在 `lib/client.js` 里（那一份已经很大），只能走宿主
 * `@deepseek-ai/dsh-client-modules` 的**包内 chunk** 机制：
 *   · 文件名必须匹配 `client.*.js`（宿主的 `CLIENT_CHUNK` 规则），与 `client.js` 同级
 *   · 宿主用 `buildComboScript` **原样** serve 它的内容（不替它包壳），所以 chunk 必须
 *     自己调用 `window.__ModuleLoader__.load({ id, chunk, factory })` 注册
 *   · 模块表用 `${ownerId}/${chunk}` 作为 key（`chunkId()`），id 里那串 `client.picker.js`
 *     会被 `stripClientSuffix()` 原样留下，所以注册 id 写成包名 + 文件名即可精确对上
 *
 * 于是这里做一次**确定性、幂等**的包壳：`lib/client.picker.src.js`（人写、可读、可测）
 * → `lib/client.picker.js`（机器生成、自注册）。构建脚本在 `npm run pack` 与 `npm test`
 * 里都会跑；已经包过壳的文件会被识别并跳过（不会套两层）。
 *
 * 用法：node build/pack-picker.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = `${ROOT}lib/client.picker.src.js`;
const OUT = `${ROOT}lib/client.picker.js`;
const PACKAGE_ID = "better-dsh-codex-effort-slider";
const CHUNK_FILE = "client.picker.js";
const MARKER = "/* dsh-client-chunk: generated from lib/client.picker.src.js — 不要手改 */";

/** ESM 尾巴 `export { a, b as c };` → 注册体结尾要的返回对象。 */
function rewriteExports(source) {
  const pattern = /export\s*\{([\s\S]*?)\};?/;
  const match = pattern.exec(source);
  if (match === null) throw new Error(`${SRC} 里没有找到 export 列表`);
  const pairs = [];
  for (const part of match[1].split(",")) {
    const token = part.trim();
    if (token.length === 0) continue;
    const alias = /\s+as\s+/.exec(token);
    if (alias) pairs.push(`${token.slice(alias.index + alias[0].length).trim()}: ${token.slice(0, alias.index).trim()}`);
    else pairs.push(token);
  }
  if (pairs.length === 0) throw new Error(`${SRC} 的 export 列表是空的`);
  const body = source.slice(0, match.index) + `\n  return { ${pairs.join(", ")} };\n`;
  if (/\bexport\b/.test(body)) throw new Error(`${SRC} 里还有未处理的 export（模块体必须是 CJS 风格）`);
  return body;
}

/** 包壳：把"模块体"塞进自注册的 factory 里（多一层缩进，保持可读）。 */
function wrap(body) {
  const indented = body
    .split("\n")
    .map((line) => (line.length > 0 ? "      " + line : line))
    .join("\n");
  return `${MARKER}
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_ID)},
  chunk: ${JSON.stringify(CHUNK_FILE)},
  factory: function (require) {
    /**
     * 运行环境的平台全局就是这里注入的这两个（模块体不依赖任何 require）——
     * 于是它在真宿主、离线测试台、以及任何脚本宿主里跑的都是同一套代码。
     */
    var platform = {
      window: typeof window === "undefined" ? null : window,
      document: typeof document === "undefined" ? null : document,
    };
    return (function (platform) {
${indented}
    })(platform);
  },
});
`;
}

const source = readFileSync(SRC, "utf8");
if (source.includes(MARKER)) throw new Error(`${SRC} 已经是生成物了（源码应该在 .src.js 里）`);
const packed = wrap(rewriteExports(source));
writeFileSync(OUT, packed, "utf8");
console.log(`已生成包内 chunk：lib/${CHUNK_FILE}（源码 ${source.length} 字节 → 生成物 ${packed.length} 字节）`);
