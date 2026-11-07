# 新平台接入 SOP

目标：为新的在线 LaTeX 服务增加一个适配器，复用现有 CLI、原文检查、备份、写后核验与错误输出。完成后，用户仍通过 `latex-workspace ... --provider 平台名` 操作。

当前实现参考：[`overleaf.mjs`](../scripts/overleaf.mjs)、[`texpage.mjs`](../scripts/texpage.mjs)；注册入口：[`providers.mjs`](../scripts/providers.mjs)。

## 1. 明确平台范围与接口依据

接入前记录以下信息，形成实现和测试依据：

| 项目 | 需要确定的内容 |
|---|---|
| 平台标识 | 简短、稳定的小写 ID，例如 `exampletex` |
| 域名 | 精确的服务域名及项目链接格式；自建实例应单独设计地址配置 |
| 登录 | 官方 OAuth / Token / 浏览器会话，以及验证码、SSO、会话过期处理 |
| 项目 | 可访问项目的列表接口、分页方式、项目唯一 ID 和名称重名情况 |
| 文件 | 文件树、文本/二进制区别、文件 ID 与路径的映射 |
| 文档写入 | 官方编辑 API、实时协同协议、整文件上传或 Git 同步的实际语义 |
| 编译 | 主文档、版本、编译状态、日志和 PDF 下载方式 |
| 权限 | 只读项目和写入/编译权限的实际错误响应 |

优先使用平台公开 API 或维护中的 SDK。需要使用网页接口时，通过官方前端请求或源码确认参数与协议；不要猜测写入端点。复用第三方代码需固定来源版本并保留许可证。

为准备接入的平台先填写能力表，分别记录“已实现”“本地测试通过”“真实账号验证通过”。暂未实现的能力返回明确的 `WorkspaceError('UNSUPPORTED_OPERATION', ...)`；不能以空列表、空文件或成功状态替代。

## 2. 实现适配器

新增 `scripts/exampletex.mjs`，导出 `ExampletexBackend`。构造函数接收工具数据目录，不能读取仓库中的真实凭据。认证资料放在 `path.join(home, 'auth', this.provider)` 下，以支持现有的 `auth logout`。

现有 CLI 使用下述契约；这是接口说明，不需要引入 TypeScript 构建工具：

```ts
interface Project {
  provider: string;
  id: string;
  name: string;
  accessLevel?: string | string[];
  owner?: string;
  lastUpdated?: string;
  version?: string;
  versionNo?: string;
  versions?: { id: string; name?: string }[];
  // 平台内部定位信息可使用 _ 前缀字段，CLI 项目列表会过滤它们。
  // 凭据、Cookie 和签名下载地址不能放入 Project。
}

interface Backend {
  provider: string;
  init(): Promise<void>;
  login(): Promise<{ provider: string; authenticated: true }>;
  status(live?: boolean): Promise<{
    provider: string;
    sessionStored: boolean;
    checked: 'local' | 'live';
    authenticated?: boolean;
    projects?: number;
  }>;
  projects(): Promise<Project[]>;
  files(project: Project): Promise<{ path: string; type: string }[]>;
  read(project: Project, file: string, options?: { fresh?: boolean }): Promise<string>;
  write(project: Project, file: string, content: string, options: {
    before: string;
    edits?: { old: string; new: string }[];
  }): Promise<void>;
  compile(project: Project, options: {
    mainFile?: string;
    pdf?: string;
    log?: string;
  }): Promise<{
    provider: string;
    project: string;
    success: boolean;
    status: string;
    errors: unknown[];
    warnings: unknown[];
    pdf?: string;
    log?: string;
  }>;
  close(): Promise<void>;
}
```

### 登录与状态

- 构造函数及 `init()` 只准备客户端，不自动打开登录窗口或执行线上修改。`doctor` 会初始化适配器。
- `login()` 完成认证并保存必要的站点会话；不能把 Cookie、密码、Token 或浏览器状态写入 JSON 命令输出。
- 本地资料目录使用 `privateDir()`，JSON 会话使用 `privateJSON()`；两者位于 [`core.mjs`](../scripts/core.mjs)。仓库中只保留虚构的测试数据。
- `status(false)` 只检查本地资料，返回 `checked: 'local'`。没有联网验证时，不返回 `authenticated: true`。
- `status(true)` 执行一个能确认账号访问权限的只读请求；有效会话返回 `checked: 'live'`。缺少会话可返回本地未登录状态。网络故障和不兼容响应应抛错，不解释成账号已退出或没有项目。
- 浏览器验证码和 SSO 交给用户正常完成。只保存该平台所需的会话，不读取用户日常浏览器中的其他账号。

### 项目与读取

- `projects()` 返回完整列表或明确报告分页限制。项目和版本 ID 统一为字符串，不用项目名称代替唯一 ID。
- 项目名称精确匹配及重名拒绝由通用层负责，适配器不需要重复实现。
- `files()` 返回项目相对路径，并区分文件夹、文本和二进制文件；不在读取时创建、重命名或修复文件。
- `read()` 返回完整 UTF-8 文本。`fresh: true` 必须刷新实时镜像或缓存，供写后核验使用。
- 请求参数只包含平台接口实际接受的字段。展示名称、权限说明等元数据不能直接展开进接口参数；TeXPage 文件树曾因此返回参数错误，已有回归测试。

### 写入

通用流程在 `core.mjs` 的 `changeFile()` 中：

1. 读取原文，检查 `--if-match` 或精确替换条件。
2. 计算完整目标内容；多项替换先全部验证。
3. 再次读取，拒绝已变化的原文。
4. 保存原文备份与修改信息。
5. 调用适配器 `write()`。
6. 用 `read(..., { fresh: true })` 读取并比较，核验通过后才返回成功。

适配器负责平台端提交：

- `before` 是本次计算修改时的原文，`content` 是完整目标文本。若平台支持条件写入，在平台提交阶段也检查原文或服务端版本。
- 有实时文本接口时可使用 `edits` 进行局部编辑；仅支持全文写回时提交 `content`。不要把平台整文件覆盖描述成字符级原子编辑。
- 在实时协同协议中等待本次写入对应的确认，不能把其他协作者的广播当成自己的成功确认。
- 正确处理清空文件、中文、多行及 Unicode 代理对。分块时保持协议要求的长度与依赖位置。
- 发生冲突、拒绝或断连时抛错，交给通用层返回备份和恢复信息。不要盲目重发未知是否完成的写操作，也不要自动覆盖远端以回滚。

`--if-match` 当前是通用层的写前检查；只有平台本身提供原子版本条件时，才能将该适配器描述为具备原子条件提交。

### 编译与释放资源

- `compile()` 使用平台的云端编译服务，解析真实返回状态及日志，填写 `errors` / `warnings`。生成了 PDF 并不等于 LaTeX 无错。
- 若传 `pdf` / `log`，把对应产物写到指定本地路径。PDF 下载检查 HTTP 状态和 `%PDF-` 文件头。下载请求只向匹配的站点发送相应 Cookie，不向任意产物域名附加账号凭据。
- 编译正常返回但 LaTeX 构建失败时返回 `success: false`，CLI 将退出码设为 `2`。鉴权、网络或日志无法检查等问题抛出错误，退出码为 `1`。
- 输出本地文件路径，不输出带签名的产物 URL。
- `close()` 释放 socket、浏览器和客户端资源，允许 `init()` 只完成一部分时调用。所有业务操作都由 CLI 的 `using()` 在 `finally` 中调用 `close()`。

## 3. 在统一注册表注册

在 [`scripts/providers.mjs`](../scripts/providers.mjs) 的 `PROVIDER_REGISTRY` 中增加一项：

```js
exampletex: {
  label: 'ExampleTeX',
  module: './exampletex.mjs',
  exportName: 'ExampletexBackend',
  hosts: ['exampletex.example'],
  dependencies: [],
  capabilities: { mainFile: false, projectVersions: false },
  projectIdFromUrl: url => url.pathname.match(/^\/project\/([^/]+)$/)?.[1],
},
```

这里的域名与 URL 规则仅是结构示例，需替换为实际服务。新增的 npm 依赖写入 `package.json`，更新 `package-lock.json`，并在注册项中列出 `doctor` 应检查的包。

注册表同时驱动：

- 可用 provider 列表和 `all` 查询范围；
- 适配器加载及 CLI 帮助中的平台列表；
- 精确域名匹配与项目 URL 解析；
- `doctor` 的依赖检查；
- `--main-file` 与 `--project-version` 的能力判断。

这两个 capability 字段是命令选项开关，不是整个平台的功能开关。其他能力是否实现仍由适配器方法返回结果或明确错误。新增特殊参数时，另外修改 CLI 的参数白名单、验证逻辑、帮助与测试，不能静默忽略不支持的选项。

目前无需修改 `core.mjs` 即可新增平台。只有通用语义确实需要变化时才调整通用层，并验证已有两个平台仍可使用。

## 4. 完成本地测试

为新适配器新增 `tests/exampletex.test.mjs`，使用本地 HTTP / socket 替身或模拟浏览器响应。测试应验证行为、请求契约和失败后的状态，不依赖真实账号：

| 测试点 | 预期结果 |
|---|---|
| 无会话 / 失效会话 | 返回对应认证状态或明确错误，不报空项目成功 |
| 网络失败 / 非预期 HTML | 保留网络或浏览器验证错误，不当作有效登录 |
| 多页项目和重名项目 | 列表完整，重名不能误选 |
| 文件树和文本读取 | 请求参数正确，内容完整，真实换行和 Unicode 保留 |
| 原文变化 / 替换不唯一 | 不发送写入 |
| 空文本 / 大文本 / Unicode 分块 | 清空与分块符合平台协议 |
| 写入被拒绝 / 断连 / 无关确认 | 不误报成功，不盲目重试 |
| 写后内容不一致 | 返回核验失败并保留备份 |
| 编译有 PDF 但含错误 | `success: false`，错误不会漏报 |
| 无效 PDF / 缺少日志 | 明确报错，不报告产物成功 |
| 资源清理 | 成功和失败都关闭连接，后续命令可再次运行 |

注册表的公共方法检查见 [`tests/providers.test.mjs`](../tests/providers.test.mjs)。通用层已有的测试不需要为每个平台复制；补充能覆盖新平台协议差异的测试。

运行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
node scripts/latex-workspace.mjs doctor
git diff --check
```

CI 只运行无需真实账号的检查，不上传浏览器会话或账号密钥。

## 5. 按功能验证真实账号

使用新平台账号及对应任务授权范围验证。先执行读取流程：

```bash
latex-workspace auth login --provider exampletex
latex-workspace auth status --provider exampletex --live
latex-workspace project list --provider exampletex
latex-workspace file list --provider exampletex --project TEST_PROJECT_ID
latex-workspace file read --provider exampletex --project TEST_PROJECT_ID --path main.tex
```

写入与编译验证使用用户指定的测试项目或已授权的测试范围：

1. 保存测试文件原文与 SHA256。
2. 对可唯一定位的测试文本执行 `file edit --dry-run`。
3. 执行对应编辑，确认服务器确认、备份和 `verified: true`。
4. 重新执行独立 `file read`，核对内容。
5. 编译并下载 PDF、日志，检查状态和本地产物。
6. 在测试范围内恢复原文，使用当前远端 SHA256 保护恢复写入，再读取确认。

会话复用应在独立 CLI 进程中验证，不能只在登录窗口内测试。账号权限不足或还没有可用测试项目时，记录已经验证的步骤和未验证的能力，不补写成功结果。

## 6. 更新文档与发布内容

接入完成时同步这些文件：

- `README.md`：平台名称、功能表、登录与常用命令。
- `docs/supported-platforms.md`：域名、已实现能力、真实验证范围和日期。
- `SKILL.md`、`agents/openai.yaml`：平台触发描述、使用流程和必要的平台差异。
- `references/backends.md`：依赖、协议来源、兼容处理和故障恢复。
- `THIRD_PARTY_NOTICES.md`：引入代码与依赖的来源和许可证。
- `package.json` / `package-lock.json`：新增依赖与需要时的版本更新。

提交只包含源码、文档、测试及必要许可。实际登录资料、浏览器目录、项目源码、编译产物和原文备份保存在工具数据目录。同步给其他人安装时，随源码提供依赖锁文件。

## 交付记录模板

每次新增平台在 PR 或交付说明中填写下面的信息，不需要在仓库里保存真实账号或项目标识：

```text
平台 / provider ID：
服务域名及项目 URL 规则：
登录方式与数据保存位置：
实现能力：
本地测试及结果：
真实账号已验证的功能、日期：
尚未验证或暂不支持的功能：
第三方代码 / SDK 版本及许可证：
```
