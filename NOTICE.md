# 来源与版权声明

## 原项目

- 项目：魔因漫创 / Moyin Creator
- 原作者与维护者：MemeCalculate / hotflow2024
- 原仓库：https://github.com/MemeCalculate/moyin-creator
- 本派生版本的源基线：`7e5c5655de94d49885e13c369f0a71212893a0aa`
- 上游声明：`Copyright (c) 2025 hotflow2024`；`AGPL-3.0-or-later`

所有原代码版权及授权声明继续有效。根目录 LICENSE、COMMERCIAL_LICENSE.md 及其他原有许可/作者归属不删除或替换。README_UPSTREAM.md 保存派生前 README，含原作者联系方式、赞助归属与项目说明。上游的成片/平台描述不代表本派生版本的能力或验收结果。

## 派生版本修改

2026-10-14：YITOKEN Studio 初版由 AI 辅助修改，包含 YITOKEN 品牌与官网入口、模型/API 配置、桌面凭证和 IPC/路径安全约束、参考素材上传告知、本地整片合成与项目隔离、素材部分失败报告、测试及可复现分发材料。具体变更见 CHANGELOG_RELEASE.md 与对应源码差异。

YITOKEN Studio 名称及 SVG 图标属于本派生版本品牌，不改变原程序的 AGPL 授权。未表示原作者、第三方服务商或依赖维护者为本版本背书。

## 第三方

源代码保留 CineGen-AI / OpenCut 相关出处说明、第三方代码原有 headers；依赖包含 Electron、React、Vite、Zustand、Radix UI、lucide-react、Tailwind CSS、mediabunny 等，各自许可证继续适用，不能以本声明覆盖它们。直接/传递依赖版本由 package-lock.json 固定，安装后的包许可证位于各依赖目录的 LICENSE / NOTICE 等文件；打包分发仍需保留适用第三方声明。本文件不是法务审计结论。

## 对应源码

官网下载入口：https://yitoken.com.cn/downloads/ 。分发安装包时，须在同一入口提供该版本完整对应源码（含锁文件、构建脚本和许可证）、版本来源及 SHA256；不能只给上游原仓库链接。若安装包或对应源码尚未就绪，下载页必须显示不可用，不能伪称已经发布。

媒体工具由锁定的 FFmpeg 9.0.2 / x264 源码构建；GPL许可、源码及重建脚本见 third_party/。分发包 resources/ffmpeg 包含工具与来源校验，THIRD-PARTY-NOTICES.txt包含打包运行依赖声明，Electron自身许可证仍原样保留。
