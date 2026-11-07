# 后端与故障处理

新增平台时，按 [平台接入 SOP](../docs/platform-integration-sop.md) 实现适配器，并在 `scripts/providers.mjs` 注册。平台能力和验证范围见 [平台支持说明](../docs/supported-platforms.md)。

## 实现来源

- Skill 采用 CLI + 指令文件结构，参考 [aloth/overleaf-skill](https://github.com/aloth/overleaf-skill)。本工具提供独立的双平台 CLI，没有复制其 skill 文本。
- Overleaf：依赖 [lonetis/claudeleaf](https://github.com/lonetis/claudeleaf)，npm `claudeleaf@0.3.0`，MIT。通过公开 SDK 完成浏览器登录、项目列表、实时文档读写、编译。依赖许可保留在 npm 包内。
- TeXPage：`scripts/vendor/texpage/utils.js` 基于 [dull-bird/opencli-plugin-texpage](https://github.com/dull-bird/opencli-plugin-texpage)，固定来源提交 `a751f0d867c83079794513de00c4e740b4b0ae44`，MIT；许可位于同目录 `LICENSE`。本工具直接调用复制的编译/CRDT 辅助函数，浏览器会话和 HTTP 适配由本工具提供，不依赖 OpenCLI 的运行环境。
- 本地修改：TeXPage 文档加入后、发出写操作前核对原文；拒绝被拒绝的项目加入和无效文档响应；只在发出本次写入后等待确认；分块保留 Unicode 代理对；编译日志先识别警告，防止将带文件行号的警告归为错误。
- 浏览器运行时固定 `playwright-core@1.56.1`，使用安装好的 Chrome 或 Edge，依赖精确版本及完整性由 `package-lock.json` 固定。

## 本地安装

在此 skill 根目录执行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

`scripts/latex-workspace.mjs` 可用 Node 直接执行。希望安装到当前 npm 全局命令目录时，在该 skill 根目录运行 `npm link --ignore-scripts --no-audit --no-fund`。仅在用户请求安装或修复命令入口时执行；不修改 shell 启动文件。

`doctor` 检查依赖和本地会话文件，不访问账号。浏览器登录会启动独立窗口，Overleaf 有本工具独立的持久浏览器目录；TeXPage 只保存该站点的 Cookie、localStorage 与用户代理信息。使用的是本地登录会话，不是平台 OAuth 应用绑定。

## 当前命令覆盖

两个平台均提供登录、会话状态、项目列表、文件树、已有文本文件的读取与编辑、编译、PDF/日志下载。当前 CLI 的写入目标是已有文本文件。创建/删除项目、创建/上传文件、成员权限及审阅批注没有 CLI 入口。不得用本地文件保存成功代替远端写入结果。

两个后端使用网站编辑器使用的接口；网站更新导致响应不兼容时，保留错误和备份，修复适配层后再操作，不猜测写入参数。

## 常见错误

| 错误码 | 处理 |
|---|---|
| `AUTH_REQUIRED` | 启动对应平台的 `auth login`，完成浏览器登录后重试读取 |
| `BROWSER_CHALLENGE` | 用对应平台 `auth login` 在浏览器完成网站验证，再验证会话 |
| `BROWSER_MISSING` | 安装 Chrome 或 Edge；不要自动下载安装另一套浏览器 |
| `PROVIDER_BUSY` | 同平台的另一个命令正在执行，等待它结束；不要删除活跃进程的锁 |
| `AMBIGUOUS_PROJECT` | 展示同名项目的 ID，由用户目标确定后再操作 |
| `VERSION_CONFLICT` | 重新读取文件并重新应用用户要求的编辑 |
| `EDIT_MATCH_CONFLICT` | 扩大原文上下文，使替换对象唯一 |
| `WRITE_FAILED` / `WRITE_UNVERIFIED` | 先读取当前远端状态，查看错误给出的本地备份，禁止盲目重试 |
| `MAIN_FILE_REQUIRED` | 从 TeXPage 文件树找到主文档，通过 `--main-file` 指定 |
| `LOG_UNAVAILABLE` | 未能检查编译日志，不能将本次编译报告为成功 |

`auth status` 中 `checked: local` 只描述会话文件是否存在；`checked: live` 且 `authenticated: true` 才表示本次验证成功。网络错误保留为错误，不将它解释成“账号无项目”或“密码错误”。

## 检查与恢复失败写入

备份位于工具数据目录下 `backups/平台/时间戳-随机ID/`：

- `original.txt`：本次写入前的 UTF-8 原文。
- `manifest.json`：平台、项目、文件、原文和目标哈希、时间。

先执行 `file read` 获取当前文本和 SHA256，与 `original.txt` 及预期修改对比。用户要求恢复时，用 `original.txt` 作为 `file write --file` 的输入，并用当前远端 SHA256 传给 `--if-match`。同样会再次备份和核验。若错误发生在多项实时编辑中途，部分编辑可能已应用，应根据实际原文重建剩余编辑列表。

## 维护验证

在 skill 根目录运行 `npm test`。测试使用本地替身及模拟浏览器/Socket.IO 消息，验证冲突拒绝、备份、写后核验、空文档、Unicode 分块与协议拒绝路径；不使用真实账号，不修改线上项目。

实际账号连通性通过用户完成浏览器登录后，运行 `auth status --live`、`project list` 和 `file read` 验证。修改真实文档仅在用户提出具体修改任务时执行。
