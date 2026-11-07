# Online LaTeX Skill

通过一个 Agent Skill 和统一的 `latex-workspace` CLI，操作 **Overleaf** 与 **TeXPage** 的在线 LaTeX 项目：登录账号、查看项目、读取和修改源码、调用云端编译、下载 PDF 与日志。

例如，可以对 Agent 说：

> 读取 TeXPage 中 My Paper 项目的引言，按我的意见修改，然后编译并下载 PDF。

修改流程：**读取云端源码 → 本地生成改动 → 检查原文与备份 → 写回云端 → 读取核验 → 按需云端编译**。备份保存在本机；编辑提交到原平台的项目中。

## 支持的平台

| 能力 | Overleaf · `overleaf.com` | TeXPage · `texpage.com` |
|---|---|---|
| 浏览器登录、保存本地会话 | 支持 | 支持 |
| 列出账号可访问的项目 | 支持 | 支持 |
| 浏览文件树、读取文本源码 | 支持 | 支持 |
| 精确文本编辑、整文件写回 | 支持 | 支持 |
| 写入前备份、写入后核验 | 支持 | 支持 |
| 云端编译、下载 PDF 和日志 | 支持 | 支持 |
| 主文档选择 | 使用平台项目设置 | `--main-file` 指定 |
| 项目版本选择 | 使用项目当前文档 | `--project-version` 指定 |

TeXPage 的登录、项目列表、文件树和源码读取已在真实账号验证。两平台的编辑适配已实现，并包含本地模拟测试；真实项目的写入及云端编译验证状态见 [平台支持说明](docs/supported-platforms.md)。

当前 CLI 操作已有文本文件。新增/删除项目、上传新文件、成员权限和审阅批注尚未提供命令入口。

## 运行环境

- Node.js **20.18.1 或更高版本**、npm。
- 已安装 **Google Chrome 或 Microsoft Edge**，浏览器登录需要图形界面。
- Codex 已安装使用。其他能够加载 `SKILL.md` 并执行本地 Node 命令的 Agent 客户端，可使用相同 skill 和 CLI。
- 本地验证环境为 macOS。Linux、Windows 的真实浏览器登录尚未验证；CI 执行不依赖浏览器和账号的测试。

## 安装

```bash
git clone git@github.com:choucaicai/online-latex-skill.git
cd online-latex-skill
npm ci --ignore-scripts --no-audit --no-fund
npm link --ignore-scripts --no-audit --no-fund
latex-workspace doctor
```

`npm link` 安装命令入口。如果只想在仓库内运行，可以直接执行：

```bash
node scripts/latex-workspace.mjs --help
```

### 在 Codex 中安装 Skill

将仓库克隆到 `~/.codex/skills/latex-workspace`，或者在克隆的仓库根目录创建一个指向仓库的 skill 链接：

```bash
mkdir -p ~/.codex/skills
ln -s "$PWD" ~/.codex/skills/latex-workspace
```

如果目标位置已有该 skill，先确认使用现有安装还是更新它。安装后在新的对话中使用 `$latex-workspace`，或者直接提出 Overleaf / TeXPage 项目操作需求。

## 首次登录

按需登录要使用的平台：

```bash
latex-workspace auth login --provider texpage
latex-workspace auth login --provider overleaf
```

在打开的浏览器窗口中完成登录、验证码或 SSO。命令成功后自动保存本地会话，后续命令复用它。

```bash
latex-workspace auth status
latex-workspace auth status --provider texpage --live
```

`auth status` 默认检查会话文件是否存在；加 `--live` 才会访问平台验证。每个平台保存一套当前账号会话；换账号时先执行 `auth logout --provider 平台名`，再登录。

## 查看项目和源码

```bash
# 查询指定平台；不传 --provider 时查询两个平台
latex-workspace project list --provider texpage

# 使用项目 ID 或精确名称
latex-workspace file list --provider texpage --project "My Paper"
latex-workspace file read --provider texpage --project "My Paper" --path main.tex

# 保存源码到本地，并返回文件的 SHA256
latex-workspace file read --provider texpage --project "My Paper" \
  --path main.tex --output ./out/main.tex
```

也支持项目 URL；从 URL 可以推断平台。同名项目应使用 ID。TeXPage 的版本 ID 从项目列表的 `versions` 中取得，文件操作和编译均可传 `--project-version VERSION_NO`。

## 修改并同步回云端

优先使用精确替换。创建一个 UTF-8 编码的 `edits.json`：

```json
[
  {
    "old": "A uniquely matching original sentence.",
    "new": "The revised sentence."
  }
]
```

```bash
# 预览，不提交远端修改
latex-workspace file edit --provider texpage --project "My Paper" \
  --path main.tex --edits edits.json --dry-run

# 提交修改；成功时返回 verified: true 及本地备份路径
latex-workspace file edit --provider texpage --project "My Paper" \
  --path main.tex --edits edits.json
```

每项 `old` 必须恰好匹配一次，整组编辑先校验，再执行写入。Overleaf 使用实时文本操作；TeXPage 通过 CRDT 通道写回修改后的文件全文。

整文件替换需要先读取文件，使用该次读取结果中的 `sha256`：

```bash
latex-workspace file write --provider texpage --project "My Paper" \
  --path main.tex --file ./out/main.tex --if-match SHA256_FROM_READ
```

`--file -` 可从标准输入读取 UTF-8 文本。出现原文冲突、写入失败或核验不一致时，先读取远端状态再决定后续操作。恢复方法见 [后端与故障处理](references/backends.md)。

## 编译和下载 PDF

```bash
latex-workspace compile --provider texpage --project "My Paper" \
  --main-file main.tex --pdf ./out/paper.pdf --log ./out/build.log

latex-workspace compile --provider overleaf --project "My Paper" \
  --pdf ./out/paper.pdf --log ./out/build.log
```

编译由平台的云端编译服务完成，本地不需要安装 TeX Live。编辑和编译是两个命令；Agent 可根据“修改后编译”的要求连续完成。结果包含 `success`、`errors`、`warnings`，不能仅凭下载到了 PDF 判断编译无错。

## JSON 输出与本地数据

业务命令默认输出 JSON；登录提示写到标准错误流。退出码 `0` 表示命令成功，`1` 表示参数、登录或后端错误，`2` 表示编译结果失败或存在 LaTeX 错误。查询两个平台时，结果中的 `errors` 单独记录各平台错误，可同时保留其他平台的项目结果。

默认数据目录为 `~/.local/share/latex-workspace/`：

| 目录 | 内容 |
|---|---|
| `auth/` | 平台会话和独立浏览器资料 |
| `backups/` | 写入前原文和修改信息 |
| `locks/` | 同平台命令的进程锁 |

可用 `LATEX_WORKSPACE_HOME` 指定其他数据目录。源码仓库不包含账号会话、论文源码或论文备份。

## 开发与新增平台

```bash
npm test
```

测试覆盖项目选择、原文冲突、备份、写后核验、TeXPage 写入协议和平台注册，不需要真实账号。真实账号验证与本地测试分别记录。

新增平台从 [平台接入 SOP](docs/platform-integration-sop.md) 开始。平台定义集中在 [`scripts/providers.mjs`](scripts/providers.mjs)，通用的编辑校验、备份与核验由 [`scripts/core.mjs`](scripts/core.mjs) 处理。

## 来源与许可

采用 [MIT License](LICENSE)。Overleaf 适配使用 [claudeleaf](https://github.com/lonetis/claudeleaf)；TeXPage 协议代码基于 [opencli-plugin-texpage](https://github.com/dull-bird/opencli-plugin-texpage)。来源、固定版本与修改说明见 [后端文档](references/backends.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
