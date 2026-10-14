# YITOKEN Studio：构建与预发布

YITOKEN Studio 基于 **Moyin Creator**，原作者 **MemeCalculate**。原有作者信息、版权、AGPL-3.0-or-later 许可与上游提交信息保留；请阅读 `LICENSE`、`NOTICE.md`、`README.md` 和 `third_party/README.md`。发布安装包必须同时交付对应版本的完整源码、第三方许可及来源材料，不可以只交付二进制。

## 当前冻结版本

| 项目 | 值 |
| --- | --- |
| 应用版本 | `0.1.0-alpha.1` |
| 应用 tag | `v0.1.0-alpha.1` |
| 应用提交 | `8095244a6494575eeb6fb9dca09794341cd4cf0a` |
| 完整对应源码 SHA256 | `78b8a55536ab208c297605083aa8e08219fe7656648c0328f4be387092855e38` |

工作流与本说明随后加入 `main`，**不属于该冻结版本的 398 个源码文件**。所有发布构建显式检出应用 tag，不用后来的 `main` 替代旧版源码。完整源码包由 `npm run release:source` 生成，包含依赖锁、应用源码、构建脚本以及 `third_party/sources` 内 FFmpeg/x264 原始源码、签名和许可材料。包内 `SOURCE_PROVENANCE.json` 提供逐文件校验。

冻结 Alpha1 的归档权限规范是：399 个普通文件（含生成的来源清单）均为 `0664`，71 个目录均为 `0775`。Git checkout 通常恢复为 `0644`，因此这一版本生成源码包前必须只将该 tag 的 Git 跟踪普通文件恢复为 `0664`，并设置 `umask 0002`。CI 已限定 Alpha1 做此恢复，不修改 `.git`、缓存、依赖或用户文件，也不把旧版权限规范强加给新版。文件权限也是 tar 字节的一部分，不能只校验内容相同就声称归档 SHA256 相同。

## GitHub Actions 怎么用

仓库：`ZonEaseTech/yitoken-studio`。

```text
main / Pull request
  -> Linux 原生 FFmpeg/x264 -> typecheck -> 全部测试 -> build:app

Actions / Unsigned desktop prerelease / Run workflow（选择 main）
  -> source_ref = 精确应用 tag；publish 默认 false
  -> 校验 tag = v + package.json.version，并锁定提交
  +-> 完整对应源码归档 + SHA256
  +-> Windows x64：Linux 原生媒体 + 测试 -> MinGW Windows 媒体 -> Wine 打包
  +-> Linux x64：原生媒体 + 测试 -> AppImage
  +-> macOS arm64：原生媒体 + 测试 -> DMG + ZIP
  +-> macOS x64：原生媒体 + 测试 -> DMG + ZIP
  -> 每个安装包实际 resources 校验成功 -> 独立 artifact
  -> publish = true 且所有任务成功
  -> 校验全部来源/文件/SHA256 -> 创建 draft -> 上传 -> 公开 prerelease
```

- 首次或只验构建：保持 `publish=false`，在运行页下载 artifacts；不会创建 Release。Artifacts 保留 14 天。
- 确认要发布：同一工作流选择 `publish=true`；不会覆盖已有同版本 Release（含 draft）或资产。失败上传只保留 draft，不自动公开，也不自动删除。
- 新版需先修改应用版本并生成新的对应源码，再创建精确 `vVERSION` tag；含本工作流的新 `v*` tag 推送会自动构建并尝试发布预发布版本。旧冻结 tag 没有工作流，需要从 `main` 手动运行。
- `source_ref` 只接受与该 tag 中 `package.json` 一致的应用版本 tag，不允许分支发布。同版本冻结源码校验不一致时停止，不覆盖原包；应调查来源和工具差异。
- 当前矩阵是标准 `ubuntu-24.04`、`macos-15`（arm64）及 `macos-15-intel`（x64）runner，不使用付费 larger runner。GitHub 托管资源仍受账户的 Actions 使用政策约束。
- 全局仅 `contents:read`；只有最后发布任务拥有 `contents:write`。官方 Actions 用完整提交 SHA 固定，checkout 不保存 Git 凭据。无需配置 API Key、共享密钥、签名或公证 secrets。
- 上传内容仅最终安装包、每个平台 `BUILD-PROVENANCE-*.json`、完整源码与校验。不会上传 unpacked、失败 `build-staging-*`、`.cache`、日志或工作区接力包。

**说明：新增工作流不代表四个平台已经构建通过。** 请以具体 GitHub Actions 运行的最终状态、日志和可下载资产为准；进行中、超时、部分平台成功都不算完整交付。应用测试数量以当前 tag 的实际测试日志为准，冻结版本基线为 160 项测试。

## 本机 macOS 构建

需要匹配本机架构的 Node.js **24.21.0**、npm、Xcode Command Line Tools，以及 Homebrew 的 `gnupg`、`pkg-config`、`gnu-tar`、`nasm`、`yasm`。先安装缺少的前置工具，不使用未锁定的 `npx` 临时下载打包器。

```bash
git clone https://github.com/ZonEaseTech/yitoken-studio.git
cd yitoken-studio
git checkout v0.1.0-alpha.1
brew install gnupg pkg-config gnu-tar nasm yasm  # 仅在缺少时安装
export PATH="$(brew --prefix gnu-tar)/libexec/gnubin:$PATH"
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export CC="$(xcrun --find clang)"
mkdir -p .cache/test-tmp
export TMPDIR="$(cd .cache/test-tmp && pwd -P)/"
npm ci
npm run build:media
npm run typecheck
npm test
npm run build:mac:arm64  # Apple Silicon；Intel 机器改为 build:mac:x64
# 仅恢复冻结 Alpha1 的源码归档权限；不要对整个仓库递归 chmod。
if [ "$(node -p 'require("./package.json").version')" = '0.1.0-alpha.1' ]; then
  umask 0002
  tracked_files=$(mktemp "${TMPDIR}yitoken-source-files.XXXXXX")
  git ls-files -z > "$tracked_files" || exit 1
  while IFS= read -r -d '' file; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then
      echo "Frozen source is not a regular file: $file" >&2
      exit 1
    fi
    chmod 0664 "$file" || exit 1
  done < "$tracked_files"
  rm "$tracked_files"
fi
npm run release:source
```

媒体必须本机原生编译；不要在 arm64 机器上直接打 x64 媒体或反过来。macOS 使用当前 SDK 和对应 clang；测试临时目录先创建并规范化到真实路径，避免 `/var` 与 `/private/var` 差异。源码归档需要 GNU tar。安装包只从成功的 `release/build/<version>/mac-<arch>-.../` 取；该目录出现之前已验证实际打包资源。保留完整对应源码与所有许可，不修改已有同版本归档。

## 下载、安装和验收

1. 到 GitHub Releases 选择对应版本和架构：Windows x64 `.exe`；Linux x64 `.AppImage`；Apple Silicon macOS `arm64` 或 Intel macOS `x64` 的 `.dmg` / `.zip`。
2. 同时下载 `SHA256SUMS.txt` 与对应源码。Linux 用 `sha256sum <文件>`，macOS 用 `shasum -a 256 <文件>`，Windows PowerShell 用 `Get-FileHash <文件> -Algorithm SHA256`，核对清单。
3. Windows 按安装向导选择目录；macOS 从 DMG/ZIP 把应用移到自己的 `~/Applications`；Linux 给 AppImage 执行权限后运行。Linux 图形桌面、FUSE/发行版依赖和系统兼容性需另行核验。
4. 这是**无签名、无公证的预发布**，可能触发 SmartScreen/Gatekeeper。不要关闭系统保护，不执行来源不明的去隔离或免杀脚本；如安全策略拒绝，停止并等待已签名版本。
5. 应用自带源代码编译的 FFmpeg/x264 及第三方来源材料；API Key 由使用者自行配置，不包含开发者或运营方密钥。当前应用中的官网更新/下载配置未改为 GitHub 自动更新；本轮不发布或修改官网服务。

构建和现有测试并不证明 Windows 原生安装、真实付费 API 生成、旧 macOS/Linux 兼容性全部可用；这些需要独立实测，不能以 CI 绿灯替代。工作流修改只影响交付流程，不修改支付、数据库、业务 API 或客户端冻结代码。
