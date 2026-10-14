# 官网桌面创作客户端入口

AGPL-3.0-or-later。此目录是独立、无第三方依赖的官网渐进增强模块，不修改原客户端或 new-api / QuantumNous 的代码、许可、品牌归属及现有业务。

## 范围与复用

生产是定制 rc37-green-studio；本机 new-api main 不匹配，旧源归档也无法证明覆盖所有生产修改。因此不能为三处入口重建整个前端/网关。

模块只在现有公开页面的 `#root` 存在时启动，复用：
- PublicHeader 的现有导航链接样式，分别支持桌面和原手机全屏菜单；不复制认证事件，不删除已有菜单。
- 已有 `.custom-home-content` open Shadow DOM、`.l[lang]` 七语言块，以及 `.ze` 的 card/btn/footer。保留原有网页创作台、API说明、版权、备案及开源来源。
- 三处均为原生 `href="/downloads/" target="_self"`：无需登录，同标签页发出 Document GET，不交给 SPA 路由。下载页维持四个平台卡片，不恢复源码大卡。

这是既有线上定制内容没有可验证重建基线、且 HeaderNavModules 不支持新增链接时的兼容接点；不是新建替代 UI 组件或绕开现有确认/弹窗业务封装。

768px 法/俄原导航已裁切，新增项不能继续挤占登录按钮。仅桌面导航组按可用宽度自动换行，项目原菜单和登录操作保持不变；下载项排在首页后。全部原导航及操作保持可见，键盘 Tab 可到达。窄屏仍复用原手机菜单。

## 检查

```sh
node --check site-entry.mjs
node --test site-entry.test.mjs
python3 -m unittest -v patch_shells_test.py
```

需要 Node >=22、Python3、google-chrome（可用 CHROME_BIN 指定）。浏览器测试用独立临时 profile 和本地 HTTP fixture，测试后停止自己的 Chrome并清理该profile；不读用户真实浏览器、账户、Key或认证缓存。

## 隔离与生命周期

不读取 localStorage/cookie/用户信息，不新增 API 请求、遥测或第三方资源。只读取文档语言和必要的导航/定制首页结构。DOM变化通过 MutationObserver 合并到一帧，更新幂等；移除的Shadow宿主观察器及时释放。异步Shadow装载探测最多2秒，停止时移除本模块节点/样式与观察器，不修改原内容。

七语言 UI 文案在独立模块内完整提供，不使用 new-api 的 t() key，不写其 locale JSON，不改变其语言文件或默认翻译规则。

## 发布与回滚

1. 核对线上生成器和 Caddy 当时实际内容SHA并备份；不得以旧缓存覆盖用户并行改动。补丁只作用于已核验的 SEO 生成输出接点，不改现有价格/版权/资源、数据库读取逻辑。
2. 文件名采用 `site-download-entry.<sha256前12位>.js`，发布到原SEO目录。Caddy只新增这一**精确路径**：同目录rewrite到同名文件并file_server；不新增开放目录或任意代理。浏览器拿到的是完整可阅读源文件。
3. 先validate/reload新增精确文件路由，再原子更新生成器并运行一次。原每30分钟SEO cron沿用同一个已更新生成器，避免入口被下轮重生成覆盖。不调用会改root access_token的旧i18n apply脚本，不写 options/users 表，不重启 API/支付/数据库/下载relay。
4. 实际验收三个入口与手机菜单的原生文档导航，七语言/390/768/1280及收缩header无新增溢出；保留旧导航/首页内容/版权和下载页四卡。HEAD和小文件验证不代表整件安装包SHA或国内提速已认证。
5. 回滚先核对当前Caddy/生成器仍是本次SHA，再恢复备份、重生成原SEO页并reload Caddy。不要覆盖后来用户改动，不动业务数据或容器；已打开页面刷新后恢复原外观。

## 控制台布局回归

AppHeader 的 TopNav 是独立 NAV，其父节点为 block 容器，与 PublicHeader 的桌面 DIV / 整条 NAV 不同。只给公共顶栏使用换行/最小高度样式；应用顶栏仅追加下载链接，保留原48px高度、搜索和个人操作对齐。正常下载点击显式使用同标签页；浏览器快捷键打开新标签仍遵守浏览器行为。实际生产bundle结构已只读核对；真实已登录会话界面与匿名公开首页不能混为一项验收。

## 控制台直达与刷新：保留客户端入口

原先从首页进行 SPA 内站跳转时，文档已经加载下载入口模块，因此控制台仍显示客户端入口；直接打开控制台或刷新时，后端返回的原始 SPA HTML 没有该模块，入口会消失。

`patch_shells.py` 在已核验的 `pages = {}` 接点新增 `pages['app-shell.html'] = base`。这里的 `base` 是生成器从原应用 `/` 获取的完整原始 HTML，不调用首页 SEO 的 `build()`，不加首页营销卡片、导航、SEO 文案或 FAQ 内容。现有输出 helper 只为此 SPA 壳追加同源指纹 module；原 HTML、应用资源引用、品牌与版权保持原样。404 原样返回，无 `#root` 的未知素材不注入模块。

页面与操作的变化：

```text
首页 -> SPA 内站跳转 -> 控制台：沿用已加载模块，入口仍在
控制台白名单路径 -> 直接打开/刷新 -> app-shell.html -> 加载同一模块
控制台 -> 点击“桌面创作客户端” -> 同标签页 Document GET /downloads/
```

发布时还须由 Caddy 将**精确 UI 路径白名单的 GET / HEAD** 指向 `app-shell.html`，不能对所有路径兜底替换。API、静态资源、认证/OAuth 及其他请求继续交给原后端；后端登录、会话和 API 权限规则不变。生成器补丁本身不修改 Caddy，也不表示路由已上线；必须另行验证直达、刷新和内站跳转。每轮原 SEO cron 同时重生成此壳，避免过期应用资源引用。

首次打补丁会添加原有 helper 和应用壳输出；已打相同 module URL 的旧补丁只补应用壳输出，保留所有原函数和数据库读取逻辑；重复调用不重复添加。不同 URL、未知或重复的 pages 接点、未知输出接点均拒绝自动覆盖，须重新核验。回滚还需按发布时备份恢复精确 UI 路由和生成器；残留未被路由使用的应用壳文件不能视为仍在生效。

本次后端表/字段变动 **0**，数据库迁移 **0**，新增 API **0**；不读账户、Key 或认证会话，不改变原业务权限。

## 入口文案改名（七语言）

原“软件下载”导航和页脚入口统一改名为“桌面创作客户端”；独立 module 的对应文案为：简体 `桌面创作客户端`、繁体 `桌面創作客戶端`、英文 `Desktop client`、法文 `Client de bureau`、俄文 `Клиент для ПК`、日文 `デスクトップアプリ`、越南文 `Ứng dụng máy tính`。这是客户端入口名称，不是安装动作；卡片“下载 YITOKEN Studio”和创作台“下载桌面版”按钮不变。所有入口仍到 `/downloads/`，同标签页原生导航及权限规则不变。未修改 new-api locale JSON 或任何业务翻译。

SEO helper 的首页导航（含 aria-label）、首页页脚和 FAQ 导航/页脚同样使用新中文名称。升级已有同 URL 生成器时，仅在唯一补丁 BEGIN / END 内替换这四个已知 HTML 字符串；用户注释、其他原函数、数据库读取及外部同名中文不动。未知 helper 结构/文案拒绝覆盖，module URL 不自动换。新指纹模块需单独发布到新的不可变地址，原指纹文件不能覆写；生成器 URL 更新仍需另行核对 SHA。

布局验收以独立本地浏览器 fixture 为准：PublicHeader 覆盖 390 / 768 / 1024 / 1280 / 1920，包含较长原法语菜单与登录项，对比增强前后无新增溢出、原导航全部保留；AppHeader 覆盖 1024 / 1280 / 1920 的七语言标签，保持原48px、nowrap、搜索/通知/个人操作几何不变，不给应用 wrapper 添加64px或换行规则。fixture 不是实际已登录生产会话，生产控件仍需另行验证；入口改名本身不调整 AppHeader / PublicHeader 布局 CSS；下面的紧凑双卡 CSS 仅作用于首页自有推广 wrapper。

## 首页紧凑双卡（用户批准原型）

只调整现有首页 GPT-6.1 Sol 推广卡和自有 YITOKEN Studio 卡。已匿名只读核查生产公开 ShadowDOM：每个 `.ze .l[lang]` 的 `section.hero` 最后一个直属 `div.launch`，包含 `.launch-t`、`.launch-d` 和原生模型按钮；不是其他模型清单里的 GPT 介绍卡。原按钮地址固定为 `/playground?model=gpt-6.1-sol&group=GPT%20Codex`。测试内保留七语言真实 hero HTML 与原 `.ze` CSS，不用假定的独立 GPT section。

模块仅识别唯一、结构完整且地址匹配的原推广卡，保留原节点、文本、点击处理和链接，把它临时移动到 hero 后的自有双卡 wrapper 内，与 Studio 并排。桌面大于700px时等宽等高、左对齐、20px间距；卡内24px留白、22px标题、14px按钮，减少原全宽区块的留白。700px及以下堆叠，卡内20px留白。原 hero 的标题、介绍、注册/价格/创作台按钮和事实清单，以及其余营销内容、版权、备案和来源不改。无原 GPT 卡、重复卡、未知 class/子结构或按钮地址不匹配时，不创建双卡；保持原仅 Studio 卡行为，不能拿其他业务区块拼凑。

原推广卡位置由本模块 comment 占位；`stop()` 把同一个原节点搬回原位置并删掉自有 wrapper/card/style/footer/nav，测试对完整原 ShadowDOM 字符串逐字比较。外部改动 class 后也恢复位置，保留该外部改动；React/ShadowDOM 重建、七语言与多次 refresh 不重复建组，离开页面释放观察器。`MutationObserver` 只监听结构与必要的 class/href/lang，未知结构失败闭合。

自有首页 note 的七语言“预发布”字样移除，Windows/macOS/Linux 与 API Key 获取说明保留；SEO no-JS 自有说明同样移除此词。不同 URL 仍拒绝覆盖，既有 helper 只升级已知中文 note 字符串；真实版本/Release/manifest/安装包元数据不改，不把预发布安装包声称为稳定版。

页面操作仍为：GPT按钮去原模型使用页（原登录/额度规则不变）；Studio按钮同标签页 Document GET `/downloads/`，不自动下载、不携带账户/Key。后端表字段、迁移、新 API 均为0。浏览器回归覆盖七语言 × 390/700/701/768/1024/1280/1920，包含精确stop恢复、未知原页面保护和后续class变化恢复；可用 `YITOKEN_SCREENSHOT_DIR=/tmp/owned-directory node --test site-entry.test.mjs` 导出本地fixture截图/几何日志。截图文件不是生产已上线证明，发布后仍需公开首页实测。
