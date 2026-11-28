# Antigravity MCP adapter（v3.3.0）

把 DSH × Blender 的 6 个工具面（`blender_session` / `blender_op` / `blender_py` /
`blender_see` / `blender_run` / `blender_inspect`）连同会话面板包装成一个标准 stdio MCP
server，供 Antigravity 宿主使用。执行器、Gateway 与工具回执全部复用仓库的 `lib/` 构建产物，
本目录不重复实现 Blender 侧逻辑。

| 路径                                 | 作用                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `mcp-server.mjs`                     | stdio MCP server：工具清单、面板资源、`CallTool` 分派、Gateway 保活                                                         |
| `panel/index.html` · `panel/main.js` | MCP App 面板：Gateway 健康、virtual-gui 审批、确认策略、会话/作业、视口预览，经 `@modelcontextprotocol/ext-apps` 与宿主握手 |
| `vite.config.mjs`                    | 用 `vite-plugin-singlefile` 把面板打成单文件 HTML                                                                           |
| `dist/panel.html`                    | 构建产物，不入库（见根 `.gitignore`），由 `npm run build` 重建                                                              |

该目录不在 npm 包的 `files` 清单里：它只随仓库提供，不随 `npm pack` 发布。

## 构建与运行

`mcp-server.mjs` 直接 import `../lib/...` 下的执行器，所以先在**仓库根**生成 `lib/`：

```powershell
npm run build            # 仓库根：runtime/ + src/ → lib/（mcp-server.mjs 依赖它）
cd antigravity
npm install
npm run build            # → antigravity/dist/panel.html（单文件，~410 KiB）
```

在 Antigravity 的 MCP 配置里注册（stdio）：

```json
{
  "mcpServers": {
    "dsh-blender": {
      "command": "node",
      "args": ["<repo>/antigravity/mcp-server.mjs"],
      "env": { "ANTIGRAVITY_SESSION_ID": "antigravity-local" }
    }
  }
}
```

## 环境变量

| 变量                        | 默认                          | 说明                                                |
| --------------------------- | ----------------------------- | --------------------------------------------------- |
| `ANTIGRAVITY_SESSION_ID`    | `antigravity-mcp-<pid>`       | 工具调用与面板使用的 dshSessionId                   |
| `DSH_BLENDER_PANEL_HTML`    | `antigravity/dist/panel.html` | 面板 HTML 路径覆盖                                  |
| `DSH_BLENDER_TEST_NO_SPAWN` | 未设置                        | 置 `1` 时不自动拉起 Gateway，也不跑看门狗（测试用） |

Gateway 端口由 `resolveHttpPort()` 解析（默认 `127.0.0.1:39877`，见
[`docs/配置参考.md`](../docs/配置参考.md)）。

## 工具面

- **6 个宿主工具**：与 DSH 插件同名同参，参数 schema 见 `TOOLS`。
- **`blender_panel`**：打开面板（返回 `structuredContent` 与 `ui://dsh-blender/panel.html` 资源）。
- **app-only 工具**（`_meta.ui.visibility: ["app"]`，仅面板内可调）：`blender_panel_state`、
  `blender_panel_decide`（approve / deny 一条待批准请求）、`blender_panel_policy`
  （manual / auto / deny）。
- **图片回执**：单次工具回执最多内联 6 张图、累计 base64 ≤ 750 KiB，超出部分以一段文字说明省略。
- **生命周期**：启动即 `ensureBackend`；15 s 看门狗在连续两次探测失败后重启 Gateway
  （`killBackendByCmd` → `ensureBackend`）；stdin 关闭 / SIGINT / SIGTERM 时清理子进程。
