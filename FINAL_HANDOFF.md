# YITOKEN Studio 接力与交付说明 — 2026-10-14

## 仓库与保留范围

- 独立实现目录：`/workspace/yitoken-studio`；分支 `feat/yitoken-studio`；基线 `7e5c5655de94d49885e13c369f0a71212893a0aa`；版本 `0.1.0-alpha.1`。
- 未提交、未推送、未部署。`/workspace/new-api` 保持原状，已有 `.happy-ai/` 保留；不修改 new-api / QuantumNous 归属。
- 用户批准 Moyin Creator 的 AGPL 派生、默认 YITOKEN API、自有 Key、首版整片合成。项目版权、LICENSE 与 README_UPSTREAM 保留，原 LICENSE/README 已逐字节核对。

## 已实现

1. YITOKEN 标题、SVG-derived 图标、官网/源码入口；首次配置不含 Key；用户到 `/keys` 获取自己的 Key。
2. 模型列表与公开协议元数据查询；已适配对话、Seedream 图像和 Seedance 视频入口。真实服务能力尚未付费验证。不支持的视觉/高级/旧后台协议明确拒绝。
3. 计费 POST 单次提交，不因网络未知、5xx、响应解析、轮询或上层 batch/stage 失败自动重提；合法不同阶段仍独立调用。用户手动再次生成仍可能计费。
4. 加密配置窄 IPC、主 frame/来源验证、路径与外链限制；系统安全加密不可用只保留会话，不新写明文；已有迁移数据安全失败时保留，不能称磁盘已全部清理。renderer仍需要Key，不是密钥完全隔离。
5. 本地 FFmpeg 整片：当前项目时间线顺序、完整片段、真实时长、720p/1080p、16:9/9:16、30fps、H264/AAC；保留原音、无音轨补静音，等比例黑边；非方形像素按显示比例缩放。无字幕/BGM/转场/裁剪/多轨编辑。
6. 任务快照、全局进度、取消、最终probe+全量decode+无覆盖原子保存；200段/单段600s/总长7200s/单源512MiB/源合计2GiB；不支持原子硬链接的目标磁盘明确失败。
7. 时间线项目归属隔离、启动迁移后重读、复制修正归属、读写失败保护和切换排队；合成与存储迁移/导入/清缓存双向互斥。虚假Saved提示删除，拖入成功必须实际新增。
8. 素材导出部分失败清单和真实状态；完整源码、媒体工具对应源码、许可证、依赖声明、逐字节资源打包门及下载页交付脚本。

## 已运行验证（非所有环境认证）

- `npm test`：19 files / 160 tests PASS，最终代码后执行；`npm run typecheck` PASS。
- `npm run build:linux` PASS，`npm run build:win` 经 Wine32 + 专用 WINEPREFIX/xvfb 重试 PASS；两包实际 resources 被逐文件后验，不仅依赖 builder 退出码。
- `npm run build:web` PASS；devproxy真实Vite入口加载回归已覆盖。
- FFmpeg9.0.2源码签名/源码与二进制hash/固定x264源码/GPL原文校验通过；Linux/Windows工具由锁定源码构建。Windows CLI在Wine运行version成功，不是原生Windows验收。
- Linux packaged（unpacked payload）实际启动、CSP/无renderer require、受限IPC、原生UI创建项目/导出页、安全加密不可用拒绝保存已验证。
- Linux已从真实导出页点击合成→原生保存窗口→实际输出MP4；UI显示2/2与成功路径。720x1280、30fps、视频2.466667s、容器2.488021s；时间线估计10s并未被当真实时长；红→蓝顺序、原音RMS0.0882/静音0、全量decode通过。
- 另含真实720p横版/1080p竖版、40短混音累积时差、SAR非方形像素、实际child取消/源保留测试。
- 运行依赖`npm audit --omit=dev`：0已知通报；全依赖审计：8 moderate（构建依赖链）；不是无漏洞保证。
- Lint未全绿：上游在同一新规则工具下758 errors/95 warnings；本次初次全量839 errors/97 warnings，最后结果见验证日志。存在新增测试/类型风格问题，不将全部问题归上游。未做无关全仓重构。

## 交付文件

- 完整源码：`release/source/yitoken-studio-0.1.0-alpha.1-source.tar.gz` 与 `.sha256`，生成后以实际hash为准。
- Linux最终：`release/build/0.1.0-alpha.1/linux-x64-20261014054247981-6XPu7R/`。
- Windows最终：`release/build/0.1.0-alpha.1/win-x64-20261014055243937-eH6zDE/`，NSIS未签名（PE Authenticode certificate size=0），未完成原生安装验收。
- 准备上传官网的独立静态目录：`release/website/downloads/`，包含安装包、同版本源码、SHA256SUMS、manifest.json、version.json。须先运行stage脚本，不能从模板存在推断上线。
- 第一份Linux缺resources、第一份Windows缺Wine32而失败/不完整的输出仍保留；**不得分发**，不以其退出码或存在的exe作为验收。

## 尚未完成 / 风险

- 官网未上线：已授权的YITOKEN服务器SSH BatchMode检查仍Permission denied；没有可用AISSH对应连接。需提供已配置连接入口，不在聊天贴密码/私钥。未接触其他服务器跳板、生产数据库或TTPOS。
- 尚未使用真实Key/付费预算测试渠道权限、素材组合、模型生成、计费和结果；不会借用运营凭据。
- Windows原生安装/系统DPAPI、macOS构建/签名公证、常见真实用户素材与HDR尚未验证；Linux只完成当前Ubuntu24.04环境。
- 异常renderer崩溃/强制reload没有后台job发现恢复接口；关闭应用会取消并清理，正常项目/页面切换有全局监控。不能称断点续传或异常重启恢复。
- Linux工具依赖当前构建glibc；较老发行版/FAT-exFAT不承诺支持。网络URL凭证或私有/重定向被拒绝，部分素材需重新合法下载/授权存储。
- 第三方许可不属于法务认证：157包声明和13份内嵌D3原文保留；react-remove-scroll-bar2.3.8只发布MIT声明/README，精确证据与SPDX参考原文分开标注，唯一限版本预发布例外，正式分发前需复核授权。
- 原版本比较未全面支持SemVer预发布优先级；没有自动安装，未来稳定版版本策略与更新清单需单独验收。

## 上线下一步（先核对服务器实际配置）

1. 拿到YITOKEN已配置连接，只读核实`/opt/yitoken`、实际域名、nginx容器/配置、已有downloads路径；备份配置与已有站点文件。
2. 完成Windows/实际素材/用户自备测试Key验收与许可复核。将测试版清楚标注，不冒称稳定版。
3. 上传交付目录到版本化只读静态目录；以最小nginx`/downloads/`静态location暴露，不覆盖首页与new-api程序/品牌/数据库。
4. 在服务器逐项核对SHA256；校验下载Content-Type/Content-Disposition/源码链接/version JSON并用浏览器走下载。配置测试通过后再reload，验证原登录/API/充值路由未受影响。
5. 回滚只切回旧downloads目录/对应nginx备份；不动账户数据、Key、项目或输出MP4。客户端回滚前备份项目与encrypted配置；不要回写明文Key作为回滚。

## 长任务交接

审计/原始验证证据在`/tmp/yitoken-*-report-audit.json`、`/tmp/yitoken-sourcehandoff-review.json`、`/tmp/yitoken-final-tests4.log`、`/tmp/yitoken-final-typecheck4.log`、`/tmp/yitoken-package-linux-final.log`、`/tmp/yitoken-package-win-retry.log`及`/tmp/yitoken-packaged-film-e2e.json`。这些临时路径可能被清理；源码归档与SHA才是长期交付输入。未记录任何可用Key/密码/私钥。
