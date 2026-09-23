# dsh-permission-compat

DSH（DeepSeek Harness）权限兼容工具：把 relay 侧模型（`codex-relay / gpt-5.6-sol`）每次回填"提权专用"字段 `sandbox_permissions` 导致 `pwsh` / `bash` / `write` / `edit` 被 fail-closed 拒绝的问题，修正为**模式感知的冗余提权归一化**。

完整分析报告见 1.logseq 工作区：`70-WorkSpace/dsh-provider-failover/docs/dsh权限问题完整分析与处理方案-20260923.md`。

## 为什么是"补丁工具"而不是 cordis 运行时插件

DSH 工具管道在派发前把模型参数**冻结**，公开扩展点都无法修改参数：

- `tools/pre-execute`：只能 allow / deny / ask；
- `tools/execute`：around 包装，**只能替换 `exec.signal`**，参数与调用身份不可变；
- `tools/post-execute`：只能处理结果；
- 同名全局 `register()` 会报 duplicate；按 agent 作用域影子注册需要 agent 生命周期钩子（上游未公开）。

pwsh / bash / fs 三个工具族的提权判定收敛在 `@deepseek-ai/dsh-sandbox`，因此在该模块打补丁是唯一不吞失败、不越权的落点。

## 行为契约（补丁后）

模式等级 `read-only(0) < workspace-write(1) < danger-full-access(2)`：

| 场景 | 行为 |
|---|---|
| 未传 `sandbox_permissions` / 两字段全空 | 普通调用，原样执行 |
| `requestedRank <= effectiveRank`（冗余声明） | 按当前模式执行，`console.warn("[dsh-permission-compat] redundant escalation normalized: ...")`，**不弹审批** |
| `requestedRank > effectiveRank` 且 justification 非空 | 真提权：走 approval（rejected / cancelled / unavailable 仍报错，文案与官方逐字一致） |
| 真提权但 justification 为空 | 仍报 `invalid justification: expected a non-empty sentence`，不降级 |
| 未知模式 / 未知生效模式 | 显式报错 |
| 工具真实失败（非零退出、写失败、`[sandbox: file access denied ...]`） | **原样返回，绝不改写** |

## 使用

```powershell
# 日常启动（apply → verify → dsh web，任一步失败即不启动）
tools\dsh-web-safe.ps1            # 可附 dsh web 参数，如 --no-open / --port 8080

# 单独应用 / 验证
node tools\apply-dsh-permission-compat.mjs
node tools\verify-dsh-permission-compat.mjs
```

## 升级后重放

脚本、备份都在本仓库；dsh 升级只覆盖安装目录：

1. `tools\dsh-web-safe.ps1` 启动时自动定位全局 dsh（`NVM_SYMLINK` / `npm root -g`）；
2. 新版本**代码锚点**（`WIDER_MODES` 表、`normalizeEscalationArgs`、`approveEscalation`）全部匹配 → 重新打补丁（`APPLIED`）；任一不匹配 → 拒绝修改并失败退出，**绝不盲改**；
3. 已应用（`DSH_PERMISSION_COMPAT_V1` 标记在位）→ `SKIP`，幂等；
4. 上游若内置同类判定，锚点失配会阻止打补丁——届时从 `dsh-web-safe.ps1` 移除 apply 步骤即可。

## 回滚

把 `backups/dsh-sandbox-index-<version>-<时间戳>.js` 拷回：

```
<npm-global>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-sandbox\lib\index.js
```

恢复后不要再用 `dsh-web-safe.ps1` 启动（幂等脚本会再次打上补丁）。

## 验证基线

`tools/verify-dsh-permission-compat.mjs` 覆盖 9 项断言（普通调用、全空、仅 justification、冗余声明不弹审批且留诊断、真提权缺理由、真提权走审批、审批拒绝），并要求补丁标记在位；每次打补丁后自动运行。
