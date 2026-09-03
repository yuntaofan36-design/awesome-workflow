# Awesome Workflow V2

Awesome Workflow V2 是一个面向 Web 与桌面微应用的安全平台，由一个控制平面和两个运行时平面组成。它以标准 OIDC、不可变发布、签名制品、原子化通道、能力代理和可审计执行，取代旧有的身份链路与可变部署模型。

> 本仓库是一套全新实现。它有意不导入旧版软件包、数据、凭据，也不集成 Portal、Kani、ZTI，且不与 P4 耦合。

## 仓库结构

```text
apps/
  api                 混合认证 BFF 与模块化控制平面 API
  worker              制品校验与发布任务
  web-shell           Web 微前端宿主
  control-plane       首个受信任的 Federation 远程模块
  desktop             Tauri 2 管理界面
  cli                 面向开发者与 CI 的 aw 客户端
packages/
  contracts           传输层与领域契约
  i18n                共享语言解析、偏好持久化与格式化
  manifest-schema     带版本的清单 Schema 与 JSON Schema
  web-sdk             能力受限的 Web 宿主桥接 SDK
  desktop-sdk         任务级桌面应用 SDK
  ui                  仅包含共享展示型基础组件
crates/
  agent               用户级调度器、安装器、更新器与状态管理
  runner              每个任务独立的进程边界
  elevated-helper     单次执行、操作受白名单限制的提权辅助程序
infra/
  compose             本地 PostgreSQL、Redis、MinIO、Mailpit 与 Logto
  helm                生产环境无状态组件
```

## 本地快速开始

开始前请准备 Node.js 24、pnpm 10、Rust stable、Docker，以及 Tauri 2 对应平台所需的开发环境。

1. 将 `.env.example` 复制为 `.env`，替换其中所有 `change-me` 值。
2. 启动依赖服务：

   ```bash
   docker compose --env-file .env -f infra/compose/docker-compose.yml up -d postgres redis minio minio-bootstrap mailpit logto
   ```

3. 安装依赖并执行基础校验：

   ```bash
   pnpm install
   pnpm typecheck
   pnpm test
   ```

4. 分别启动 API 与 Web 界面：

   ```bash
   pnpm dev:api
   pnpm dev:web
   pnpm dev:control-plane
   ```

5. 安装好 Tauri 所需依赖后，启动桌面管理界面与用户级 Agent：

   ```bash
   pnpm dev:desktop
   ```

Mailpit 仅用于本地 SMTP 测试。生产环境通过启用 TLS 的 SMTP，由 BFF 负责邮件验证码流程；只有明确启用的社交登录连接器才使用 Logto OIDC。生产环境必须全程启用 HTTPS，并使用托管式密钥管理。

同时配置 `AUTH_PASSWORD_ADMIN_EMAIL` 与 `AUTH_PASSWORD_ADMIN_PASSWORD` 后，
账号密码登录方式即会启用。该账号通过与其他 Web 登录方式相同的 HttpOnly
BFF Session 登录并获得平台管理员角色。两个值必须存放在未跟踪的 `.env` 或
部署 Secret 中；同时省略则禁用该登录方式。

## 国际化

平台目前完整提供 `en-US` 与 `zh-CN` 两套资源。Web Shell、Control Plane、
Web 示例应用和 Tauri 管理界面均支持明确选择语言或跟随系统，持久化本地偏好，
同步 Arco Design 与 `document.lang`，并按当前语言格式化日期、数字和字节大小。
在独立繁体中文资源完成前，繁体中文系统语言会回退到现有 `zh-CN`，但这不代表
已经提供繁体中文翻译。

平台客户端通过 `Accept-Language` 协商 API 语言；RFC Problem Details 与登录
邮件会本地化，但错误 `code`、校验路径和参数保持稳定。发布者可使用
`defaultLocale` 与可选 `localizations` 提供应用名称、摘要和描述。Web 微应用通过
受限 Host SDK 获取 `locale.getCurrent()` 并订阅 `locale.changed`。

桌面 UI 会把解析后的语言同步给常驻用户 Agent。每个新任务在 SQLite 中冻结
启动时的语言快照，并将其传给 Web UI、Python 和原生微应用；进程环境变量为
`AW_LOCALE` 与 `AW_FALLBACK_LOCALES`。UI 后续切换语言不会改变正在运行的任务。
协议枚举、Manifest 字段、签名输入、审计 action 和 CLI JSON 始终与语言无关。

## 核心不变量

- 发布版本不可变。发布与回滚操作只在事务中移动 `dev`、`canary` 或 `stable` 通道指针。
- Federation 代码拥有宿主权限，因此必须经过可信审查。非受信任应用或跨框架应用必须运行在独立源的沙箱 iframe 中。
- 微应用不能获得平台会话、访问令牌、刷新令牌、CI 身份或签名密钥。
- 只有当协议版本、应用、任务、租约、调用方和能力全部匹配时，桌面 RPC 才会被接受；否则一律拒绝。
- 使用 Tauri 并不会自动让原生可执行文件变得安全。原生程序仅允许来自受信任且已签名的发布版本，并仍以当前操作系统用户权限运行。
- 生产环境密钥与签名材料由 Secret Manager、KMS 或 CI 工作负载身份注入，严禁提交到仓库。

## 实现与验收边界

本仓库中的源码、配置、单元测试、内存仓库、模拟请求或本地进程集成，只能证明相应设计与实现已经存在，不能替代真实部署、真实浏览器或 Tauri 进程、真实身份系统、生产级网络与存储，以及签名安装包在真实设备上的验收。

当前能力与尚待完成的真实环境验收项，请参阅[实现状态](docs/implementation-status.md)。

## 延伸阅读

- [系统架构](docs/architecture.md)
- [发布模型](docs/release-model.md)
- [桌面安全](docs/desktop-security.md)
- [实现状态与验收边界](docs/implementation-status.md)

英文文档请参阅 [README.md](README.md)。
