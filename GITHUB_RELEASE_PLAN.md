# GitHub 多平台交付实施计划

本轮授权：将客户端代码、构建流程及安装包放入 ZonEaseTech；优先 GitHub，官网发布暂缓。仓库公开以履行已批准的 AGPL 源码交付。保留原作者、版权、许可、用户已有改动与原始上游历史。

## 冻结基线
- 客户端版本：0.1.0-alpha.1。
- 应用源 tag：v0.1.0-alpha.1，提交 8095244a6494575eeb6fb9dca09794341cd4cf0a。
- 完整对应源码 tar SHA256：78b8a55536ab208c297605083aa8e08219fe7656648c0328f4be387092855e38。
- 冻结源码 398 个文件逐字节匹配；160 测试及 typecheck 刚重跑通过。
- CI 与说明文件随后加入 main；构建旧版必须显式检出应用 tag，不能覆盖本地同版本冻结源归档。

## 执行步骤
1. 创建 ZonEaseTech/yitoken-studio 公开仓库；推送冻结客户端到 main 与源 tag；不向 upstream 推送。
2. 新增 .github/workflows/ci.yml：PR/main 的 Linux 原生媒体、typecheck、完整测试、桌面应用构建；无发布权限。
3. 新增 .github/workflows/release.yml：手动输入 source_ref，或新版本 v* tag 触发；发布前确认该 tag 与 package.json 版本一致。
4. 源码任务在 Ubuntu 上使用 GNU tar 生成完整 AGPL 对应源码及校验，不上传凭据、缓存、工作区接力包。
5. 独立矩阵构建 Windows x64（Ubuntu/MinGW/Wine）、Linux x64（Ubuntu24.04）、macOS arm64（macos-15）、macOS x64（macos-15-intel）。只用标准公开 runner，不申请付费 larger runner。
6. 各矩阵先原生生成测试媒体工具并运行现有测试，Windows 再构建锁定 MinGW 媒体；只收集包装检查已通过的最终 release/build 文件，不上传失败 staging 或普通开发工具。
7. 平台 artifact 含安装包与来源说明；聚合任务需要全部平台和源任务成功，才允许上传完整 GitHub prerelease。缺平台/缺源码即失败；现有同版本 Release 不覆盖、不使用 --clobber。
8. 发布使用最小 contents:write；其它任务 contents:read，checkout 不持久化凭据；Actions 按官方仓库完整 commit SHA 锁定。
9. 发布后验证 tag/提交、源码/各平台资产、GitHub Action 终态与 SHA256；执行中/失败不称成功。

## 验收与边界
- actionlint 静态校验；真实 GitHub Actions 构建日志是平台构建证据。
- Mac 当前已原生安装到 Happy mac pro 的 ~/Applications/YITOKEN Studio.app，LaunchServices 正常启动、调试端口已关闭；原生 160 测试通过。
- 无签名/无公证预发布；Windows 原生安装、真实付费 API 生成、旧 macOS/Linux 兼容性未验。
- 不带用户/运营方 API Key，不读取/提交登录密钥，不关系统防护，不改支付、数据库、官网现有服务。
- 官网服务器仅已核实访问与现有 Caddy 路由；尚未修改生产配置或发布下载页。本轮优先 GitHub。
- 回滚仅限新增 GitHub 工作流/未发布 draft；不得自动删现有 Release 或用户文件。
