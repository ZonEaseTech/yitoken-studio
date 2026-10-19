# YITOKEN Studio：构建与预发布

YITOKEN Studio 基于 **Moyin Creator**，原作者 **MemeCalculate**。原有作者信息、版权、AGPL-3.0-or-later 许可与上游提交信息保留；请阅读 `LICENSE`、`NOTICE.md`、`README.md` 和 `third_party/README.md`。发布安装包必须同时交付对应版本的完整源码、第三方许可及来源材料，不可以只交付二进制。

## 历史冻结版本（不覆盖）

| 项目 | 值 |
| --- | --- |
| 应用版本 | `0.1.0-alpha.1` |
| 应用 tag | `v0.1.0-alpha.1` |
| 应用提交 | `8095244a6494575eeb6fb9dca09794341cd4cf0a` |
| 完整对应源码 SHA256 | `78b8a55536ab208c297605083aa8e08219fe7656648c0328f4be387092855e38` |

工作流与本说明随后加入 `main`，**不属于该冻结版本的 398 个源码文件**。所有发布构建显式检出应用 tag，不用后来的 `main` 替代旧版源码。**Alpha1 保持原历史附件，不重新构建发布、不替换下载清单。Mac 签名修复必须进入新的应用版本、对应源码包和 tag；新版流水线会拒绝不含修复脚本的 tag。**完整源码包由 `npm run release:source` 生成，包含依赖锁、应用源码、构建脚本以及 `third_party/sources` 内 FFmpeg/x264 原始源码、签名和许可材料。包内 `SOURCE_PROVENANCE.json` 提供逐文件校验。

冻结 Alpha1 的归档权限规范是：399 个普通文件（含生成的来源清单）均为 `0664`，71 个目录均为 `0775`。Git checkout 通常恢复为 `0644`，因此这一版本生成源码包前必须只将该 tag 的 Git 跟踪普通文件恢复为 `0664`，并设置 `umask 0002`。CI 已限定 Alpha1 做此恢复，不修改 `.git`、缓存、依赖或用户文件，也不把旧版权限规范强加给新版。文件权限也是 tar 字节的一部分，不能只校验内容相同就声称归档 SHA256 相同。

## 本次 Alpha2 的用户可见修复

- 角色图、场景图、自由画布使用 YITOKEN 图片模型时，原先自动带上的视觉排除词不再触发“不支持负向提示词”的本地拒绝；现在将排除词追加为普通提示文本 `Avoid these visual elements: ...`。没有向上游发送原生 `negative_prompt` 或 `negativePrompt` 参数，也不承诺模型一定遵守文字约束。
- 普通提示词未填写时仍拒绝提交，不允许只靠排除词绕过；自由画布尚未验证的高级图片参数仍拒绝发送。
- 请求可能已经发出而结果不明确时，标为 `retrySafe=false` 的失败不会自动重试或轮换到其它提供商，降低重复提交和重复计费风险；这不代表上游一定没有扣费，应先查询已有请求而不是重复点击生成。
- 上述网络回归使用模拟响应；本次构建不代表已实测付费模型生成效果、约束遵从性或实际扣费结果。Mac 完整 bundle 签名修复也不等于 Apple 公证，具体信任状态看本次来源证明与下方发布模式说明。

## GitHub Actions 怎么用

仓库：`ZonEaseTech/yitoken-studio`。

```text
main / Pull request
  -> Linux 原生 FFmpeg/x264 -> typecheck -> 全部测试 -> build:app

Actions / Verified desktop prerelease / Run workflow（选择含修复的受信分支）
  -> source_ref = 新版本精确应用 tag
  -> mac_signing_mode = adhoc（默认）或 developer-id
  -> publish 默认 false；allow_adhoc_prerelease 默认 false
  -> 校验 tag = v + package.json.version，并锁定提交
  -> 校验该 tag 含完整签名/验收脚本；旧 Alpha1 不可按新版重新发布
  +-> 完整对应源码归档 + SHA256
  +-> Windows x64：Linux 原生媒体 + 测试 -> MinGW Windows 媒体 -> Wine 打包
  +-> Linux x64：原生媒体 + 测试 -> AppImage
  +-> macOS arm64/x64：
      adhoc       -> 原生媒体 + 测试 -> 全 bundle 临时签名 -> DMG + ZIP
      developer-id -> mac-signing 审批 -> 凭据预检 -> 原生媒体 + 测试
                   -> Developer ID + hardened runtime -> Apple 公证
                   -> app/媒体/最终 DMG、ZIP 内容验签 + Gatekeeper + 公证核验
  -> 每个安装包实际 resources 校验成功 -> 独立 artifact
  -> 仅手动 dispatch + publish = true + 新 tag + 所有任务成功
     developer-id：签名/公证/Gatekeeper 全部通过
     adhoc：仅新 alpha tag + 显式 allow_adhoc_prerelease = true（无 Apple 信任）
  -> 校验全部来源/文件/SHA256 -> 创建 draft -> 上传 -> 公开 prerelease
```

- 首次或只验构建：保持 `publish=false`；默认 `mac_signing_mode=adhoc`、`allow_adhoc_prerelease=false`，不表示 Apple 认可或公众可顺利安装。在运行页下载 artifacts；不会创建 Release。Artifacts 保留 14 天。
- 受信签名预发布：手动选择新的应用 tag、`mac_signing_mode=developer-id` 和 `publish=true`；必须先安全配置 Apple 凭据与受保护 environment。两种 Mac 架构都必须提供真实签名、公证及 Gatekeeper 证明；任何失败禁止发布，不降级到 ad-hoc。
- 无公证 Alpha 预发布（明确授权的例外）：仅手动运行，选择新的 `vX.Y.Z-alpha.N` tag（正整数 N，禁止旧 `v0.1.0-alpha.1`）、`mac_signing_mode=adhoc`、`publish=true`，并**显式勾选 `allow_adhoc_prerelease=true`**。默认不允许、稳定版不允许、tag push 不允许。两种 Mac 架构仍须完整 bundle/媒体签名、资源与最终 DMG/ZIP 核验全部通过；证明必须如实为 `signatureVerified=true`、`unsigned=true`、`notarized=false`、`gatekeeperAccepted=false`、`teamId=null`。这不是 Developer ID 或 Apple 公证，macOS 仍可能阻止安装/启动；不得指导关闭系统保护或去隔离。
- 两种发布路径都要求四平台完整成功，不覆盖已有同版本 Release（含 draft）或资产。失败上传只保留 draft，不自动公开，也不自动删除。
- 新版需先修改应用版本并生成新的对应源码，再创建精确 `vVERSION` tag。**tag push 只做 ad-hoc 构建，固定 `publish=false`，不会自动发布或读取 Apple 凭据**；公开发布必须另行手动 dispatch 并显式 `publish=true`。旧冻结 tag 不通过新版签名管线验收；不从 `main` 叠加新脚本冒充旧版完整对应源码。
- `source_ref` 只接受与该 tag 中 `package.json` 一致的应用版本 tag，不允许分支发布。同版本冻结源码校验不一致时停止，不覆盖原包；应调查来源和工具差异。
- 当前矩阵是标准 `ubuntu-24.04`、`macos-15`（arm64）及 `macos-15-intel`（x64）runner，不使用付费 larger runner。GitHub 托管资源仍受账户的 Actions 使用政策约束。
- 全局仅 `contents:read`；只有最后发布任务拥有 `contents:write`。官方 Actions 用完整提交 SHA 固定，checkout 不保存 Git 凭据。Windows/Linux 与 ad-hoc Mac 不注入 Apple secrets；正式 Mac 仅在受保护 `mac-signing` environment 下接入下面列出的凭据。`desktop-build` environment 不应存放任何签名凭据。
- 上传内容仅最终安装包、每个平台 `BUILD-PROVENANCE-*.json`（Mac 内嵌签名证明）、完整源码与校验。不会上传 unpacked、失败 `build-staging-*`、`.cache`、日志或工作区接力包。

**说明：新增工作流不代表四个平台已经构建通过。** 请以具体 GitHub Actions 运行的最终状态、日志和可下载资产为准；进行中、超时、部分平台成功都不算完整交付。应用测试数量以当前 tag 的实际测试日志为准，冻结版本基线为 160 项测试。

### 首轮流水线故障与修复范围

- macOS 首轮在导入 FFmpeg 公钥时失败：默认工作区太长，隔离 GnuPG home 下的 agent 额外 Unix socket 路径达到或超过 macOS 的 104 字节容量。桌面矩阵现在将刚检出的冻结源码物理复制到独占的 `/tmp/yitoken-desktop` 后构建（macOS 实际为 `/private/tmp/yitoken-desktop`）；目标存在即失败，不复用、不覆盖。应用提交身份检查、媒体源码 SHA256、GPG 签名及签名指纹检查全部保留。
- Windows/Linux 首轮已生成安装文件，但锁定的 electron-builder 根据 CI 环境隐式尝试自行发布，因没有 `GH_TOKEN` 失败。只在打包子进程使用 `env -u GITHUB_REF_TYPE CI=false`，同时关闭 CI 和 tag 两种隐式发布推断；测试步骤仍在真实 CI 环境下执行，之后的来源清单和最终发布步骤仍使用真实 GitHub 上下文。没有给桌面构建添加 token、写权限，也没有修改冻结打包脚本。
- 上述首轮修复当时只修改流水线及说明。它们不等于此次全 bundle 签名修复，也不能证明已通过 Apple 公证。冻结应用 tag、398 个应用源码文件、完整对应源码包及其 SHA256 保持不变。
- 四平台重跑 `38543823880` 全部成功并公开预发布。独立下载核验又发现 GitHub 将 Linux 文件名中的空格转换为点，导致旧清单的文件名不匹配（安装文件字节及 SHA256 正确）。收集步骤现先规范公共 ASCII 文件名，再复制/生成来源与校验清单。Alpha1 已有 13 件资产保留、不覆盖，另附 `BUILD-PROVENANCE-linux-x64-GITHUB.json`（仅修正下载文件名并说明映射）和 `SHA256SUMS-GITHUB.txt`（按实际公开文件名校验 14 个其它附件），不会重新构建或替换旧安装包。

## Mac 签名与 Apple 公证接入

### 两种模式不是一回事

| 模式 | 结果 | 允许公开发布 |
| --- | --- | --- |
| `adhoc`（默认） | 完整 app bundle、嵌套组件及媒体工具临时签名，验证签名完整性；没有可信 Developer ID、公证或 Gatekeeper 放行承诺 | 默认否；仅手动显式授权的新 Alpha 可作无公证预发布，系统仍可能拦截 |
| `developer-id`（显式开启） | Developer ID Application 签名、hardened runtime、Apple API Key 公证；原生核验 app/工具及最终 DMG、ZIP 内容 | 仅全部验收成功后 |

缺少正式凭据、身份标识格式错误或文件路径/权限不合规，会在任何构建命令前失败；真实证书/私钥是否可用仍须由证书导入、签名和 Apple 公证确认，这些步骤或 Gatekeeper 检查失败同样停止，不自动退回 ad-hoc、不上传部分结果。只支持 App Store Connect API Key，不从 Apple ID 密码或 keychain profile 静默回退。不能通过关闭 Gatekeeper、删除隔离属性、关闭 SIP 或修改系统策略来“验收”。

**当前状态：接入代码不等于已签名发布。** 调查时本机有效代码签名身份为 0、仓库 secrets 列表为空；未持有合规凭据前，不能声称已完成 Developer ID、公证、浏览器首次下载安装或公众分发验收。实际 GitHub environment/secret 配置及 Apple 账户资格需由拥有者通过安全渠道完成，本次文件修改不会自动创建这些凭据或保护规则。

### GitHub 配置（不要把密钥发到聊天或提交到 Git）

先在仓库 **Settings → Environments** 创建 `mac-signing`，配置必需审批者、禁止自行审批（如可用）、仅允许受信发布分支/tag，并依仓库套餐核实保护规则实际生效。手动运行时保护规则匹配工作流运行引用，而 `source_ref` 是实际应用 tag：审批者还必须核对输入 tag 与冻结提交。审批通过才向正式 Mac job 提供 secrets。[GitHub 环境保护说明](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

只在该 environment 中配置以下 **Secrets**，不要使用普通变量、日志或聊天传递私钥：

| Secret 名 | 内容 |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64` | Developer ID Application 证书及匹配私钥导出的 `.p12`，单行 base64（base64 不是加密） |
| `MAC_CERTIFICATE_PASSWORD` | 该 `.p12` 的导出密码 |
| `MAC_CERTIFICATE_NAME` | 证书身份，例如 `Company Name (TEAMID)`；支持去掉 `Developer ID Application:` 前缀后供打包器使用 |
| `APPLE_TEAM_ID` | 与证书匹配的 10 位 Apple Team ID |
| `APPLE_API_KEY_P8_BASE64` | 有权进行公证的 App Store Connect API 私钥 `.p8`，单行 base64 |
| `APPLE_API_KEY_ID` | 对应 API Key ID |
| `APPLE_API_ISSUER` | 对应 API Issuer UUID |

工作流不下载远程证书。Node 只在 Mac 正式签名 job 把文件写到 `runner.temp/yitoken-mac-credentials`（目录 `0700`、文件 `0600`），私钥内容和密码不回显；只将临时文件路径写到 step outputs，密码只注入凭据预检/打包步骤。成功、失败均通过 `always()` 清理临时凭据；强制终止或 runner 故障仍依赖托管 runner 生命周期，不能保证清理步骤一定执行。不要启用会打印环境/凭据的自定义调试。Windows/Linux 步骤不注入这些 secrets。

### 来源证明与签名后媒体字节

签名会改变 FFmpeg/ffprobe 的 Mach-O 字节，不能把签名前 hash 冒充安装后 hash，也不能因此跳过资源完整性核验：

```text
锁定原始源码/媒体 hash
  -> before signing: afterPack 对全部实际资源逐字节检查并留证明
  -> 原生签完整 app + ffmpeg/ffprobe
  -> 核验最终 bundle 与 DMG/ZIP 的签名/内容
  -> 只允许已验签的两个 Mach-O 出现预期签名变化
  -> 所有许可、来源、其它资源仍保持严格一致
  -> 保存最终媒体 hash 与签名/公证证明
```

每个成功 Mac 输出目录生成 `MAC-SIGNING-PROVENANCE.json`，不是手填“成功”：`schemaVersion=1`、`mode`、`signatureVerified`、`gatekeeperAccepted`、`notarized`、`teamId`、`mediaArtifacts[{filename,sha256}]`、`artifactHashScope=after-mac-code-signing`、`verificationScope=unpacked-app-and-final-dmg-zip`。CI 内嵌到 `BUILD-PROVENANCE-mac-<arch>.json` 的 `macSigning`。发布任务再次将两种 Mac 证明与**本次请求的 mode**逐项绑定：Developer ID 要求三个验证布尔值为 true、同一合法 Team ID；顶层 `unsigned=false, notarized=true`。获显式例外的 ad-hoc Alpha 只能为 `signatureVerified=true`、`gatekeeperAccepted=false`、`notarized=false`、`teamId=null`；顶层 `unsigned=true, notarized=false`。两种路径的媒体 hash/scope 校验都不放松，不能混合架构模式、冒充信任或静默降级；Windows/Linux 也不被误标为已签名或已公证。

## 本机 macOS 构建

需要匹配本机架构的 Node.js **24.21.0**、npm、Xcode Command Line Tools，以及 Homebrew 的 `gnupg`、`pkg-config`、`gnu-tar`、`nasm`、`yasm`。先安装缺少的前置工具，不使用未锁定的 `npx` 临时下载打包器。**必须检出包含本次修复的新版本 tag**；不要用旧 Alpha1 的命令/源码来验收新版签名。

```bash
git clone https://github.com/ZonEaseTech/yitoken-studio.git
cd yitoken-studio
git checkout "${NEW_VERSION_TAG:?Set NEW_VERSION_TAG to a new tag containing this repair}"
brew install gnupg pkg-config gnu-tar nasm yasm  # 仅在缺少时安装
export PATH="$(brew --prefix gnu-tar)/libexec/gnubin:$PATH"
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export CC="$(xcrun --find clang)"
mkdir -p .cache/test-tmp
export TMPDIR="$(cd .cache/test-tmp && pwd -P)/"
# 正式模式：先通过安全的本机环境/密钥管理工具注入下表全部变量。
# 如设置 developer-id，先预检，再运行下面任何依赖/媒体/app 构建命令。
node scripts/mac-signing.mjs --preflight
npm ci
npm run build:media
npm run typecheck
npm test
npm run build:mac:arm64  # Apple Silicon；Intel 机器改为 build:mac:x64
npm run release:source
```

| 本机变量 | 要求 |
| --- | --- |
| `YITOKEN_MAC_SIGNING_MODE` | 默认 `adhoc`；正式签名显式设置 `developer-id` |
| `CSC_LINK` | 本机 `.p12` 绝对路径，必须普通文件且非符号链接；不是 URL/base64 |
| `CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| `CSC_NAME` | Developer ID Application 证书身份，须与 Team ID 匹配 |
| `APPLE_TEAM_ID` | 10 位团队 ID |
| `APPLE_API_KEY` | 本机 `.p8` 绝对路径，必须普通文件且非符号链接 |
| `APPLE_API_KEY_ID`、`APPLE_API_ISSUER` | 与 `.p8` 匹配的 Key ID、Issuer UUID |

不要把明文密码作为 shell 历史里的命令参数，不在聊天中粘贴私钥；本机敏感文件使用 `0600` 并在完成后安全移出构建目录。媒体必须本机原生编译，不在 arm64 机器上直接打 x64 媒体或反过来。源码归档需要 GNU tar。安装包只从成功的 `release/build/<version>/mac-<arch>-.../` 取；未完成 `build-staging-*` 不可分发。保留完整对应源码与所有许可，不修改已有同版本归档。

## 下载、安装和验收

1. 到 GitHub Releases 选择对应版本和架构：Windows x64 `.exe`；Linux x64 `.AppImage`；Apple Silicon macOS `arm64` 或 Intel macOS `x64` 的 `.dmg` / `.zip`。
2. 同时下载校验清单与对应源码；Alpha1 使用修正附件 `SHA256SUMS-GITHUB.txt`（原 `SHA256SUMS.txt` 保留审计，不要用于按下载文件名批量核验），后续版本使用 `SHA256SUMS.txt`。Linux 用 `sha256sum <文件>`，macOS 用 `shasum -a 256 <文件>`，Windows PowerShell 用 `Get-FileHash <文件> -Algorithm SHA256`，核对清单。
3. Windows 按安装向导选择目录；macOS 从 DMG/ZIP 把应用移到自己的 `~/Applications`；Linux 给 AppImage 执行权限后运行。Linux 图形桌面、FUSE/发行版依赖和系统兼容性需另行核验。
4. **旧 Alpha1 无正式签名、无公证；新 ad-hoc 构建也不是公众可信签名。** Windows 未签名安装包可能触发 SmartScreen。只有新版 Mac 来源证明真实显示 Developer ID + 公证 + Gatekeeper 核验通过，才可称为已签名公证候选；仍须从浏览器首次下载到未特殊放行的干净 macOS 账户，核验隔离下载安装、启动与实际媒体调用。不要关闭系统保护，不执行去隔离或免杀脚本；如安全策略拒绝，停止并调查，不能把绕过后的启动当验收。
5. 应用自带源代码编译的 FFmpeg/x264 及第三方来源材料；API Key 由使用者自行配置，不包含开发者或运营方密钥。当前应用中的官网更新/下载配置未改为 GitHub 自动更新；本轮不发布或修改官网服务。

构建和现有测试并不证明 Windows 原生安装、真实付费 API 生成、旧 macOS/Linux 兼容性全部可用；这些需要独立实测，不能以 CI 绿灯替代。本次签名修复影响桌面打包、媒体签名后的来源证明、Mac 安装安全与发布门禁；不修改支付、数据库表/字段、业务 API 或旧版冻结资产。
