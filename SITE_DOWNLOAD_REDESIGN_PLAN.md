# YITOKEN 下载页与创作台引导实施计划

用户已批准去掉顶部安装警告横幅后的绿色四平台设计，直接实施与部署。采用 subagent-driven-development 并行执行独立页面与引导模块，root 统一审查、发布、验收。

## 范围与架构

- 下载页仍由 Go relay 内嵌静态 HTML 提供，原 CSP、固定白名单、实时中转不变；四平台六安装地址、字节数/SHA、校验清单及普通 AGPL 源码链接全部保留。
- 创作台实际为 /chat/0 的跨域 iframe，加载 studio.yitoken.com.cn。生产只有 dist 与 Bun 服务器，无可重建源码；只为原 HTML 增加可阅读独立模块，不重建未知 bundle、不修改原 server.ts、上传签名或认证。
- 轻量引导放创作台主区顶部图片/视频 tabs 与任务日志旁，不占左表单/提示词/生成按钮。下载固定绝对官网 URL、target=_top，在同一浏览器标签页离开创作台，不携带 Key、query、fragment。不读任何凭据/存储/表单/用户/任务，不调用 API。
- 下载门户采用已批准原型的短 hero、系统选择、三步说明及折叠详细信息；不显示用户指定安装警告横幅，不添加 JS/自动检测或自动下载，不把 alpha 冒充稳定版。

## Task 1 下载页（deploy/download-relay）
- [ ] 延伸现有 main_test.go 页面回归并确认红：4卡/6链接/完整原文件元数据与源码入口、新系统锚点、三步骤、无指定横幅。
- [ ] 修改 index.html，更新 README；sh package-source.sh 生成完整对应源码。
- [ ] GOWORK=off go vet/test -race/build；真实390/768/1280布局、链接/哈希与CSP验证。

## Task 2 创作台（deploy/studio-guide + 原 Chrome 测试）
- [ ] 核实公开 bundle 的 main 第一子 DIV toolbar 接点；先写红测试：唯一引导、保留原控件、幂等/重建、清理、跨域iframe同标签Top Document导航。
- [ ] 新独立 ES module，仅匹配原toolbar，七语言文案，DOM变化合并到一帧；不匹配则不改变原界面。
- [ ] 新模块的语法与回归接入既有 website-entry CI；不改原 new-api locale/React/后台配置。

## Task 3 root 审查、发布、实测与汇报
- [ ] 保留9cb6339的AppHeader修复和已有用户改动，new-api工作树不动；只提交推送本次批准文件。
- [ ] 核对当时远端SHA并专用备份；先发布studio指纹模块再原子修改唯一HTML引用，原Bun镜像/进程不重启。
- [ ] relay只更新自己镜像，保存旧镜像/配置；所有其他业务服务、15资产/version/manifest均不变。
- [ ] 实际公共页面完整SHA/MIME/CSP与创作台原DOM验收；真实点击同标签Top Document、布局/原控件保留，不提交计费生成。
- [ ] 验证四平台六入口、HEAD/Range前缀、源码完整SHA；不冒称完整大安装包/国内提速/付费API验收。
- [ ] 最新CI终态、逐文件逐行规则、0表字段、页面操作结果、限制与精确回滚增量更新既有HTML报告。
