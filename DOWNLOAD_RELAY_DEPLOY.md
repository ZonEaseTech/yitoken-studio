# 官网下载中转部署与回滚

范围：`/downloads/` 静态说明与独立中转。不是开放的 GitHub 代理；仅固定 Alpha1 的15个公开附件，无磁盘安装包缓存。不修改原客户端398文件/冻结tag、new-api、API Key、支付、数据库或其它业务容器。

## 先验证、再部署

1. `cd deploy/download-relay && GOWORK=off go vet ./... && GOWORK=off go test -race ./...`；对应服务源码包须与本目录代码一致，按本目录 README 的打包步骤生成，不把安装包或用户数据打入源归档。
2. `GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/yitoken-download-relay .`。传输只含二进制、Dockerfile、独立compose；对传输前后文件做SHA256核验。SSH使用已确认主机指纹、原生认证或既有ControlMaster，不使用明文密码脚本、环境文件或sshpass。
3. 在服务器新独占的 `/opt/yitoken/download-relay/releases/<本次提交>/` 建目录；既有路径/容器不擅自覆盖。读取原Caddy实际镜像digest，`docker build --pull=false --build-arg BASE_IMAGE=<已存在固定digest> -t yitoken/download-relay:<本次提交> <本次上下文>`。只用该镜像已有CA根证书，不把证书或登录凭据从宿主复制进去。
4. 设置 `YITOKEN_DOWNLOAD_RELAY_IMAGE` 为本次精确tag，用独立 `docker compose -p yitoken-download-relay -f /opt/yitoken/download-relay/compose.yaml config` 验证，然后仅 `up -d download-relay`。不要运行原站compose，不公开宿主端口。检查非root、只读、dropcaps、内存/CPU/pids/日志限制、无挂载与固定现有网络。
5. 从 Caddy 容器内请求 `http://download-relay:8080/healthz`、页面和真实小附件，验证完整字节和Range；容器不健康、重定向外泄、上游失败等都不得继续主站路由发布。

## Caddy 仅新增这一段

置于 `yitoken.com.cn` 站点块内。保留其它配置逐字不变，尤其原 `encode zstd gzip` 与所有反向代理白名单。

```caddyfile
redir /downloads /downloads/ 308
handle /downloads/* {
    reverse_proxy download-relay:8080 {
        header_up -Cookie
        header_up -Authorization
        header_up -Proxy-Authorization
        header_up -X-Api-Key
        header_down -Set-Cookie
    }
}
```

不是 `handle_path`（不能剥掉前缀），也不是 `/downloads*`（不能接管别的路径）。不使用负 `flush_interval`；它会使提前断开的浏览器不再取消后端请求。附件响应 `Content-Encoding: identity`、`Cache-Control: no-store, no-transform`，保持字节与区间不被现有压缩中间件改写。

读取当前Caddy与SHA作为发布基线。候选文件存原配置目录、先在原Caddy容器 `caddy validate --adapter caddyfile`；确认线上原文件SHA仍与基线相同才备份并在同目录原子替换。核对容器内实际新SHA、再次validate，然后 `caddy reload`（不重启Caddy或其它服务）。命令超时/输出不明先查运行态与文件SHA，不重复发布。

## 公网验收与风险

- 不使用 `curl -L` 掩盖跳转，官网页面/附件应直接200或206，无GitHub Location或上游Set-Cookie；`/downloads` 仅同域308到带尾斜杠的下载页。
- 15个附件HEAD逐件比固定大小、名称与Disposition。真实小附件与至少一个完整Mac安装包必须按SHA核验，不只测试HTTP200；发送 Accept-Encoding 检查未压缩。
- 小文件两段Range拼接后SHA与完整文件相同；非法Range明确416。任意URL参数、未知附件、编码路径、POST与源码目录探测明确4xx，不返回主站伪成功页面。
- 检查更新兼容：本地 `/downloads/version.json?_ts=1791974197000` 应直接200并与不带参数的JSON一致；只有一个1至16位数字 `_ts` 被接受，不接受URL、重复参数或附件上的查询。冻结Electron客户端及其API源/Key规则不改。
- 本地回归覆盖容量8、取消、上游错误、重定向白名单、错误Content-Length/Content-Range等；不要在生产压测8路大文件。
- 原首页/keys/pricing/about/source内容SHA和API/支付/docs/统计服务可用性与发布前基线比较。不得用付费生成或修改生产数据做验证。
- 实时链路仍依赖GitHub，消耗服务器带宽；实测本次跨境验证链路较慢，单请求总时限放宽到2小时、并发仍最多8。并发限制不是带宽配额，不承诺所有国内网络的速度。无签名/无公证与平台安装未认证的预发布风险仍在。

## 回滚

只恢复本次备份的Caddy文件：先确认当前文件仍是本次发布SHA（避免覆盖后来用户修改），复制备份到同目录临时文件，validate后原子替换，再确认容器SHA等于旧基线并reload。旧下载路径应恢复404，原业务页面/API仍可用。独立中转可留运行待排查或仅停止 `yitoken-download-relay`；不停止原站容器、不删除Release、不删除旧源材料和用户文件。临时传输或备份保留到确认成功，不删未知目录。

对应源码：站内 `/downloads/relay-source.tar.gz` 与公开GitHub本目录；原Moyin Creator/MemeCalculate版权与AGPL许可保留。
