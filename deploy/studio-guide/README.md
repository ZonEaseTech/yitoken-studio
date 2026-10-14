# 创作台轻量桌面下载引导

AGPL-3.0-or-later。独立、可阅读、无依赖的 ES module；不修改原 new-api / QuantumNous 的代码、身份或版权，不修改创作、上传、任务、令牌或结算业务。

## 为什么使用这个接点

`new-api /chat/0` 的网页创作台是跨域 iframe，实际页面来自 `https://studio.yitoken.com.cn/`，不是本仓库 Electron 桌面源码的直接部署。生产没有可验证、可重建的源码基线。只读核对公开 bundle `assets/index-CE5AFMkq-cny.js`（2026-10-14）后，只允许给原 HTML 加载独立模块；不补丁修改打包 bundle、不重建未知业务、不更换原 Bun 服务。

这是既有定制页面缺少可验证组件源码时的兼容接点，不是重做原 toolbar、表单或业务组件。复用原工具条的小字号与 lime 视觉，新增入口采用 28px 高的浅绿小 pill，深绿文字和细边框；dark 模式改为深绿底 / 浅绿文字。只给自有节点加样式，避免原灰色任务日志对比度低时难以发现下载入口。新节点追加在任务日志后，不移动、替换、包裹或修改任何 React-owned 节点。

核实的结构：

```text
#root
└─ div.flex.h-screen
   ├─ aside.w-80                  原灵感创作 / 令牌 / 模型参数不动
   └─ main.flex.min-w-0.flex-1.flex-col
      ├─ div.flex.items-center.gap-2.border-b.px-6.py-3
      │  ├─ button                原图片 tab 不动
      │  ├─ button                原视频 tab 不动
      │  ├─ a.ml-auto.text-xs      原任务日志 /usage-logs/task 不动
      │  └─ a                     本模块新增：下载桌面版
      ├─ div                      原结果区不动
      └─ div                      原提示词 / 生成按钮不动
```

模块只匹配以上直接子级结构及原工具条恰有两个 BUTTON + 一个日志 A；结构不匹配则删除自己的入口和样式，不在其他页面、表单或任意链接旁猜测插入。观察器只合并 DOM / class / href / document.lang 变化到下一帧；不读取原控件文本、href 值、任务或输入值。

## 页面 → 操作 → 结果

- 创作台正常加载：主区工具条任务日志旁显示浅绿小下载链接（28px 高）；不显示大横幅，不占左参数/底部生成区。
- 点击“下载桌面版”：原生 `href="https://yitoken.com.cn/downloads/" target="_top" rel="noreferrer"`；跨域 iframe 中由浏览器在**当前顶层标签页**打开官网公开下载页。不是 iframe 内 SPA 切换，不主动跳转，不自动下载安装包。使用浏览器快捷键打开新标签仍遵守浏览器自身行为。
- URL 固定，没有令牌、查询参数或 fragment；`noreferrer` 不将创作台原 URL 作为 Referer 发送。模块不读 localStorage、cookie、location/hash/query、Key、input、用户、任务；不发 API、遥测、分析或第三方资源请求。
- `document.documentElement.lang` 决定七语言文案（zh-CN、zh-TW、en、fr、ru、ja、vi）；zh/Hans 回退简中，Hant/HK/TW 使用繁中，未知语言回退简中。不修改 new-api 的 i18n JSON、默认语言或其他网页文案。
- <=700px 隐藏**仅本模块入口**，避免原固定 320px 左栏和已经有限的工具条被进一步挤占。768px / 1280px 显示；较长译文允许省略，title 保留完整文字。没有改原工具条换行、宽度、高度或表单样式。
- 工具条重建：下一帧恢复唯一入口；主区卸载：清理其入口和样式，观察文档以等待重新挂载。
- `window.YitokenStudioGuide.refresh()` 幂等；`stop()` 取消 RAF、断开观察器，只移除自己持有的节点。停止后不再自动恢复；重新 `startStudioGuide(document)` 可明确恢复。

表 / 字段 / 迁移：**0**。认证、权限、价格、预扣 / 结算 / 退款、上传签名与任务状态：**0 规则变更**。

## 验证

```sh
node --check deploy/studio-guide/studio-guide.mjs
node --check deploy/website-entry/site-entry.test.mjs
node --test deploy/website-entry/site-entry.test.mjs
```

要求 Node >=22、google-chrome（或 CHROME_BIN）。沿用原真实 Chrome CDP 测试 harness、独立临时 profile，扩展原测试文件，不依赖用户浏览器/账户/认证。

新增 5 项真实浏览器回归：原控件节点与点击事件保留；浅绿 / dark 轻量样式、七语言文案与 390 / 768 / 1280 的同语言启用前后布局/溢出对比；重建、重复启动、卸载恢复和 stop；未知结构 fail-closed；真实跨域 iframe 用户点击、顶层 Document GET、同标签、无 URL 参数泄漏与 Referer。

跨源 fixture 的父页使用 127.0.0.1，iframe 使用 localhost（同端口不同 origin）。测试用真实 Input 鼠标按下/松开提供浏览器用户激活，不 mock top 导航、不替换 href / onclick。固定官网 URL 的 Document 响应用 CDP Fetch 提供测试 HTML；验证的是浏览器真实发出的 HTTPS Document GET 与顶层框架 URL / 标签数量，不代表测试已验证公网下载页响应或整件安装包。后续生产验收应单独验证实际公开响应；不要使用该模块访问令牌、用户账户或提交计费生成。

红绿记录：模块未实现时，5 项新 studio 回归因缺少入口 DOM 全部失败；实现后与原 11 项官网回归一起验证；后续浅绿 pill 样式同样先见到颜色 / 边框 / 高度断言失败，再实现并重跑完整回归。UTF-8 fixture 明确声明字符集，布局基线在相同 document.lang 下比较，避免浏览器语言字体差异产生假阳性。

## 发布与增量回滚（由主执行代理负责）

1. 核对当时线上原 HTML、bundle 与服务 SHA / 路径，备份原 HTML；不要覆盖后来用户改动。
2. 发布 `studio-guide.<sha256前12位>.mjs` 到原静态目录，先核对实际 HTTP 返回 MIME、内容 SHA 和原 CSP 是否允许此同源 module / 样式。
3. 仅在原 HTML 增加一条 `<script type="module" src="/studio-guide.<sha256前12位>.mjs"></script>`，原子替换 HTML。保留原资源引用；不改 bundle、Bun server、认证、上传或其他业务镜像，不重启原业务进程。
4. 实际公开创作台核对唯一小链接、原控件/结果区/生成区布局；正常点击检查当前顶层标签 Document GET。仅公开只读验证，不生成计费内容。
5. 回滚先确认 HTML 仍含本次精确引用，再**仅移除这条引用**。已有打开页面可执行 `YitokenStudioGuide.stop()` 或刷新；模块停止只清除自有节点。已发布的指纹静态文件可以暂留，避免误删其他人文件。若 HTML 已有后来变更，不拿旧完整备份覆盖。
