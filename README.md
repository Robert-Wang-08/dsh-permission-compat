# dsh-permission-compat

DSH（DeepSeek Harness）权限兼容工具：把 relay 侧模型（`codex-relay / gpt-5.6-sol`）每次回填"提权专用"字段 `sandbox_permissions` 导致 `pwsh` / `bash` / `write` / `edit` 被 fail-closed 拒绝的问题，修正为**模式感知的冗余提权归一化**。

完整分析报告见 1.logseq 工作区：`70-WorkSpace/dsh-provider-failover/docs/dsh权限问题完整分析与处理方案-20260923.md`。
本机复装 / dsh 升级恢复 runbook 见同工作区：`70-WorkSpace/dsh复装说明.md`。

## 为什么是"补丁工具"而不是 cordis 运行时插件

DSH 工具管道在派发前把模型参数**冻结**，公开扩展点都无法修改参数：

- `tools/pre-execute`：只能 allow / deny / ask；
- `tools/execute`：around 包装，**只能替换 `exec.signal`**，参数与调用身份不可变；
- `tools/post-execute`：只能处理结果；
- 同名全局 `register()` 会报 duplicate；按 agent 作用域影子注册需要 agent 生命周期钩子（上游未公开）。

pwsh / bash / fs 三个工具族的提权判定收敛在 `@deepseek-ai/dsh-sandbox`，因此在该模块打补丁是唯一不吞失败、不越权的落点。

## 移植说明（重要）

本补丁最初针对**源码树构建**编写（当时锚点函数名为 `normalizeEscalationArgs`，返回归一化对象）。npm 上发布的 `@deepseek-ai/dsh`（0.1.5-rc.2 / rc.3 / 0.1.6-alpha / 0.1.7-alpha）代码形状不同，因此已按发布包形状移植：

| 差异点 | 源码树构建（原补丁） | 发布包（现补丁） |
|---|---|---|
| 参数判定函数 | `normalizeEscalationArgs`（有返回值） | `validateEscalationArgs`（纯校验，无返回值） |
| 空 justification 在哪抛 | `normalizeEscalationArgs` | `approveEscalation`（模式感知后才判） |
| 工具层是否跳过提权 | 无守卫 | `args.justification !== void 0` 守卫会**静默降级**，必须一并改写 |

因此现补丁改 **4 个文件、6 处锚点**：

| 文件 | 改动 |
|---|---|
| `dsh-sandbox/lib/index.js` | ① 新增 `MODE_RANK` 等级表；② `validateEscalationArgs` 只保留"只有 justification、没有 sandbox_permissions"的配对报错；③ `approveEscalation` 冗余声明归一化 + 真提权才校验理由 |
| `dsh-tool-pwsh/lib/index.js` | 提权守卫改为只看 `sandbox_permissions`，空理由不再静默降级 |
| `dsh-tool-bash/lib/index.js` | 同上 |
| `dsh-tool-fs/lib/index.js` | `resolvePolicy` 守卫改为只看 `sandbox_permissions` |

## 行为契约（补丁后）

模式等级 `read-only(0) < workspace-write(1) < danger-full-access(2)`：

| 场景 | 行为 |
|---|---|
| 未传 `sandbox_permissions` / 两字段全空 | 普通调用，原样执行 |
| `requestedRank <= effectiveRank`（冗余声明） | 按当前模式执行，`console.warn("[dsh-permission-compat] redundant escalation normalized: ...")`，**不弹审批** |
| `requestedRank > effectiveRank` 且 justification 非空 | 真提权：走 approval（rejected / cancelled / unavailable 仍报错，文案与官方逐字一致） |
| 真提权但 justification 为空白串 | 报 `invalid justification: expected a non-empty sentence`，不降级 |
| 真提权但 justification 缺失 | 报官方原文 `invalid escalation: sandbox_permissions requires a justification`，不降级 |
| 未知请求模式 / 未知生效模式 | 显式报错（`invalid sandbox escalation target` / `invalid effective sandbox mode`） |
| 工具真实失败（非零退出、写失败、`[sandbox: file access denied ...]`） | **原样返回，绝不改写** |

## 使用

```powershell
# 日常启动（apply → verify → dsh web，任一步失败即不启动）
tools\dsh-web-safe.ps1            # 可附 dsh web 参数，如 --no-open / --port 8080

# 单独应用 / 验证 / 回滚
node tools\apply-dsh-permission-compat.mjs
node tools\verify-dsh-permission-compat.mjs
node tools\apply-dsh-permission-compat.mjs --revert
```

`--revert` 按 `backups/` 中**当前 dsh 版本**的最新备份逐文件还原，还原后不要再经 `dsh-web-safe.ps1` 启动。

## 升级后重放

脚本、备份都在本仓库；dsh 升级只覆盖安装目录：

1. `tools\dsh-web-safe.ps1` 启动时自动定位全局 dsh（`NVM_SYMLINK` → `npm root -g` → `%APPDATA%\npm\node_modules`）；
2. 新版本**代码锚点**（`WIDER_MODES` 表、`validateEscalationArgs`、`approveEscalation`、三个工具提权守卫）全部匹配 → 重新打补丁（`APPLIED`）；任一不匹配 → 拒绝修改并失败退出，**绝不盲改**；
3. 已应用（`DSH_PERMISSION_COMPAT_V1` 标记在位）→ `SKIP`，幂等；
4. 上游若内置同类判定，锚点失配会阻止打补丁——届时从 `dsh-web-safe.ps1` 移除 apply 步骤即可。

## 回滚

```powershell
node tools\apply-dsh-permission-compat.mjs --revert
```

或手工把 `backups\<模块名>-index-<版本>-<时间戳>.js` 拷回：

```
<npm-global>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<模块名>\lib\index.js
```

恢复后不要再用 `dsh-web-safe.ps1` 启动（幂等脚本会再次打上补丁）。

## 验证基线

`tools/verify-dsh-permission-compat.mjs` 先断言 4 个文件都带补丁标记，再动态 import 补丁后的 `dsh-sandbox` 断言行为：普通调用 / 全空 → 原样；仅 justification → 报错；冗余声明（同级、以及生效模式更宽）→ 保留当前模式、**不触发审批**且输出 `redundant escalation normalized` 诊断；真提权缺理由 / 空白理由 → 继续报错且不弹窗；真提权 + 理由 → 走审批并返回更宽模式；审批 `rejected` → 继续 `the user rejected escalating`；未知请求模式 / 未知生效模式 / 无审批服务 → 各自显式报错。每次打补丁后自动运行。
