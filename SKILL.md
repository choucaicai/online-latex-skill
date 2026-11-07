---
name: latex-workspace
description: 通过统一 CLI 登录并操作 Overleaf（overleaf.com）和 TeXPage（texpage.com）：列出账号下项目、浏览文件树、读取和修改已有 LaTeX/文本文件、云端编译及下载 PDF、日志。用户提及这两个平台的账号、项目或文档操作时使用；普通本地 LaTeX 写作无需启用。
---

# LaTeX Workspace

使用 `latex-workspace` CLI 操作两个平台。所有操作结果默认输出 JSON，成功为 `ok: true`；错误为 `ok: false` 并附错误码。命令不在 PATH 时，用 Node 执行本 skill 内 `scripts/latex-workspace.mjs` 的绝对路径。

## 初始化与账号绑定

1. 首次使用运行 `latex-workspace doctor`。若依赖缺失，在本 skill 根目录运行 `npm ci --ignore-scripts --no-audit --no-fund`。
2. `latex-workspace auth status` 只检查本地是否保存了会话，不能据此声称账号访问已验证。需要验证时加 `--live`。
3. 没有会话或会话过期时，按目标平台启动浏览器登录：

```bash
latex-workspace auth login --provider overleaf
latex-workspace auth login --provider texpage
```

让用户在打开的窗口完成正常登录、验证码或 SSO。保持命令运行，成功后继续原任务。不要索取用户密码或让用户把 Cookie 粘贴进对话。登录过程最长等待五分钟；登录窗口关闭或超时后，根据实际状态报告。

每个平台保存一套当前账号会话。凭据与浏览器资料保存在本机 `~/.local/share/latex-workspace/auth/`，不会写入 skill。`LATEX_WORKSPACE_HOME` 可指定整个工具的数据目录。换账号时执行目标平台的 `auth logout`，再登录。

## 选择项目与文件

```bash
latex-workspace project list
latex-workspace project list --provider texpage
latex-workspace file list --provider overleaf --project PROJECT_ID
latex-workspace file read --provider overleaf --project PROJECT_ID --path main.tex
```

- `project list` 默认查询两个平台；检查返回的 `projects` 和 `errors`，其中一个平台登录失败不代表另一个平台没有项目。
- 项目参数支持 ID、精确名称或项目 URL；URL 可以推断平台。重名项目必须用 ID，不要任选一个。
- TeXPage 默认使用项目当前选中的版本；需要指定版本时，从项目列表的 `versions` 取 ID，传 `--project-version VERSION_NO`。
- 文件路径来自文件树，使用相对项目根目录的路径。读取文本返回 `content` 和 `sha256`；加 `--output /absolute/local/main.tex` 则保存文本并返回文件路径与哈希。

## 修改已有文档

先读取相关文件，保留 LaTeX 命令、引用、标签及用户未要求修改的内容。优先使用精确文本替换，把编辑内容写入本地 JSON 文件，避免通过 shell 传入大段 LaTeX。

```json
[{"old":"唯一匹配的原文","new":"修改后的内容"}]
```

```bash
latex-workspace file edit --provider overleaf --project PROJECT_ID --path main.tex --edits /absolute/local/edits.json --dry-run
latex-workspace file edit --provider overleaf --project PROJECT_ID --path main.tex --edits /absolute/local/edits.json
```

每个 `old` 必须恰好匹配一次，多项编辑按顺序应用；整组编辑先校验。用户已要求修改时，`--dry-run` 是可用的预览功能，不是强制审批步骤。也可为 `file edit` 传 `--if-match`，要求文件与上次读取完全一致。

需要整文件写回时，把 UTF-8 文本写入本地文件，并使用最近一次读取返回的 SHA256：

```bash
latex-workspace file write --provider texpage --project PROJECT_ID --path main.tex --file /absolute/local/main.tex --if-match SHA256_FROM_READ
```

写入前检查原文并保存本地备份；写入后读取远端文件核对内容。成功需检查 `verified: true`。Overleaf 的 `file edit` 使用实时文本操作；TeXPage 将编辑结果通过 CRDT 通道整文件写回。`--if-match` 是写前检查，不能当作平台提供的原子事务。

遇到 `VERSION_CONFLICT`、`EDIT_MATCH_CONFLICT` 或 `WRITE_UNVERIFIED`，先重新读取远端再决定下一步。连接中断或部分操作失败时，检查错误里的 `backup` 路径和当前远端内容；不要直接重放写入或自动回滚。恢复方法见 [references/backends.md](references/backends.md)。

## 编译与下载

```bash
latex-workspace compile --provider overleaf --project PROJECT_ID --pdf /absolute/local/paper.pdf --log /absolute/local/build.log
latex-workspace compile --provider texpage --project PROJECT_ID --main-file main.tex --pdf /absolute/local/paper.pdf
```

Overleaf 使用项目设置的主文档。TeXPage 可用 `--main-file` 指定主文件，默认选择 `main.tex`，没有该文件且只有一个 `.tex` 时选择该文件。编译结果检查 `success`、`errors` 和 `warnings`；有 PDF 仍可能存在 LaTeX 错误。编译失败退出码为 2。

报告实际修改的项目、版本和文件，以及写入核验和编译结果。只有本地检查完成时，说明本地检查结果；账号登录后的远端操作按实际返回结果报告。

遇到后端兼容、会话或安装问题，按需读取 [references/backends.md](references/backends.md)。
