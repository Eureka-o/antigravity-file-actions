# Antigravity 文件操作菜单 (`antigravity-file-actions`)

为 **Google Antigravity Desktop（Windows）** 中的原生文件胶囊、本地 `file:` 链接及带本机路径的文件条目注入贴合宿主原生玻璃态风格（支持深色/浅色模式自动切换）的右键上下文菜单。

## 功能列表

右击聊天或界面中可识别出本机绝对路径的文件/目录条目时，显示以下操作：

- **在资源管理器中打开**：调用 `explorer.exe /select,"<path>"` 高亮选中文件（若为目录则直接打开该目录；兼容空格与中文路径）。
- **在侧边栏中打开**：触发宿主原生点击行为，在 Antigravity 右侧边栏预览打开。
- **在默认应用中打开**：通过 Windows 默认关联程序打开文件或文件夹。
- **打开方式 › 选择其他应用…**：拉起 Windows 系统「打开方式」应用选择器（仅针对文件）。
- **另存为…**：打开置顶系统保存对话框将文件另存一份（仅针对文件）。
- **复制路径**：将规范化后的 Windows 绝对路径写入系统剪贴板，并展示轻量提示。
- **复制文件内容**：将 `≤ 1 MiB` 的常见文本/代码文件内容写入剪贴板（PDF、Office 文档、二进制文件及文件夹自动禁用）。

## 运行前提（必读）

1. **操作系统**：仅支持 **Windows**（动作执行层使用 `explorer.exe`、`powershell.exe`、`rundll32.exe`）。
2. **开启本机调试端口**：该 sidecar 插件通过 `%APPDATA%\Antigravity\DevToolsActivePort` 上的 Chrome DevTools Protocol 挂接主窗口界面。若你的 Antigravity 快捷方式未开启调试端口，请在启动参数中添加：
   ```text
   --remote-debugging-port=0 --remote-debugging-address=127.0.0.1
   ```
   > 确认方法：启动 Antigravity 后检查 `%APPDATA%\Antigravity\DevToolsActivePort` 是否存在；仅允许连接 `127.0.0.1` / `localhost` 回环页面，不会访问远程主机。

## 安装方法

### 方式一：克隆后通过 Antigravity CLI 安装（推荐）

```powershell
git clone https://github.com/Eureka-o/antigravity-file-actions.git
agy plugin install .\antigravity-file-actions
```

安装后重启 Antigravity 桌面客户端使 sidecar 生效（如未开启，可在设置 `Customizations -> Plugins` 中启用）。

### 方式二：从 GitHub Releases 下载或手动放置

从 [Releases](https://github.com/Eureka-o/antigravity-file-actions/releases/latest) 下载压缩包（或直接克隆本仓库），解压并确保包含 `plugin.json` 的目录位于：

```text
%USERPROFILE%\.gemini\config\plugins\antigravity-file-actions
```

重启 Antigravity 桌面客户端即可自动发现并拉起 sidecar。

## 目录结构

```text
antigravity-file-actions/
├── plugin.json                      # Antigravity 插件清单
├── package.json                     # 测试脚本配置
├── README.md                        # 说明文档
├── LICENSE                          # MIT 协议
├── assets/
│   └── logo.svg                     # 插件图标
├── sidecars/
│   └── file-actions/
│       ├── sidecar.json             # Sidecar 声明
│       ├── main.mjs                 # CDP 发现、绑定与状态自愈
│       ├── source.mjs               # 注入页面的自适应深/浅色右键菜单 UI
│       └── actions.mjs              # Windows 路径校验、规范化与动作执行
└── tests/
    └── source.test.mjs              # 单元测试
```

## 安全与边界说明

- **仅作用于可识别的本机绝对路径**：仅处理带明确本机盘符 / UNC 路径属性或 `file:` URI 的 DOM 元素；对只含文件名、无完整路径的条目不拦截原生右键菜单。
- **路径与输入校验**：执行前会过滤空字节、换行符及双引号，统一规范路径分隔符，并经 `fs.statSync` 确认目标存在。
- **不包含远程通信**：全部桥接均通过 `127.0.0.1` 本地回环 CDP 完成。

## 验证与测试

```powershell
agy plugin validate --strict .
node --test tests/source.test.mjs
```
