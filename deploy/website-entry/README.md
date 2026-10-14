# 官网软件下载入口

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
