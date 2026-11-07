# 平台支持说明

更新日期：2026-11-06。这里区分已提供的命令能力与实际完成的验证，后续接入以 [平台接入 SOP](platform-integration-sop.md) 为准。

## 在线服务

| 项目 | Overleaf | TeXPage |
|---|---|---|
| Provider ID | `overleaf` | `texpage` |
| 服务域名 | `overleaf.com` / `www.overleaf.com` | `texpage.com` / `www.texpage.com` |
| 登录方式 | 独立浏览器窗口手动登录，保存本地会话 | 独立浏览器窗口手动登录，保存站点会话 |
| 项目列表 | 已实现 | 已实现，真实账号验证通过 |
| 文件树和源码读取 | 已实现 | 已实现，真实账号验证通过 |
| 精确编辑 | 已实现，实时文本操作 | 已实现，本地生成编辑结果后通过 CRDT 通道整文件写回 |
| 整文件写回 | 已实现，需原文 SHA256 | 已实现，需原文 SHA256 |
| 写入前备份 / 写入后核验 | 已实现 | 已实现 |
| 云端编译 / PDF / 日志 | 已实现 | 已实现 |
| 本工具中的主文件设置 | 使用平台已配置的主文档 | 接受 `--main-file`；默认 `main.tex`，或唯一的 `.tex` |
| 本工具中的版本设置 | 当前项目文档 | 选中版本，或 `--project-version` 指定版本 ID |
| 协议来源 | `claudeleaf@0.3.0` SDK | HTTP 接口与 Socket.IO / CRDT 辅助代码 |

当前真实账号验证范围：TeXPage 登录、项目列表、文件树及已有 `.tex` 文件读取。验证过程中没有提交线上文档修改，也没有调用线上编译。Overleaf 真实账号验证尚未执行。

本地测试覆盖通用写入校验、备份与核验、Overleaf 协同编辑期间保留新增内容、TeXPage CRDT 确认与冲突路径、文件树参数契约和日志解析。新增真实验证后，应按功能更新本表；不使用统一的“全平台已验证”标签。

## 当前命令范围

共同入口：`auth login/status/logout`、`project list`、`file list/read/edit/write`、`compile`、`doctor`。

操作对象是已有文本文件，例如 `.tex`、`.bib`、`.sty` 和 `.cls`。文件树也可列出图片和 PDF，但 `file read` / `file write` 提供的是文本操作，不是二进制上传下载接口。

创建/删除项目、创建/上传文件、项目成员权限、审阅批注和修订建议没有 CLI 入口。当前注册项连接上述站点；自建 Overleaf 地址尚未提供命令配置。

## Agent 客户端与操作系统

| 环境 | 当前情况 |
|---|---|
| Codex | Skill 已安装使用，CLI 已执行 |
| 其他 Agent | 使用 `SKILL.md` 和本地 CLI；需客户端支持加载 skill 和执行 Node 命令 |
| macOS | 已完成依赖安装、CLI、本地测试和 TeXPage 真实登录/读取 |
| Linux / Windows | 使用相同 Node 源码；真实图形浏览器登录尚未验证 |
| 无图形界面的服务器 | 可运行本地测试；首次浏览器登录流程需要图形界面 |

浏览器当前尝试 Chrome，然后 Edge。不要求使用用户的日常浏览器配置；会话保存在本工具独立的数据目录。平台账号仍需具备目标项目的相应读取、修改或编译权限。
