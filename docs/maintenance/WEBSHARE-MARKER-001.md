# WEBSHARE-MARKER-001：静态住宅出口来源头对照

状态：本地配置与握手诊断完成，本机显式隧道仍失败；后续[独立线上测试](../tasks/WORKER-WEBSHARE-001.md)已完成：Worker经住宅代理严格TLS成功，模型不带来源头200、带CF-Worker403。无需循环本机旧失败请求；本文件本地计数不代表后续云端计数。日期2026-09-17，源码基线13c8de1。依赖：[本地当前基线](LOCAL-MARKER-002.md)。

目标：用户提出住宅出口方案，并在本地200/403来源头对照后提供其Webshare用户名认证下载链接；验证通过固定静态住宅代理带CF-Worker及不带头的模型目录结果。

范围：配置下载到Git忽略的.env.webshare.json，共3条。初始选首个9.142.39.218:7388，最多一次无账号凭据的HTTPS出口检查及两次固定官方模型GET；若出口检查未通过，不读取账号凭据、不发模型请求。只读现有SQLite凭据快照，内存解密并复用createModelsRequest。不生成、不刷新、不自动重试，不改运行中的8787，不操作8789/3000，不部署或更改主架构。

首次HTTPS出口检查超时后，范围调整为区分TCP与隧道握手失败：首个代理一次TCP-only、一次HTTP CONNECT-only、一次SOCKS5无账号HTTPS检查；随后主会话说明对另外两条各做一次CONNECT-only。各假设/候选仅运行一次，不自动循环、不替换套餐代理；全部握手诊断均不携带Codex凭据。

预期：HTTP CONNECT只携带代理认证，账号Authorization与Account-ID仅在到chatgpt.com的TLS内发送；保持rejectUnauthorized=true和正常目标主机校验。两次模型请求固定同一代理、同一凭据、同一URL和应用字段，差别仅CF-Worker。重定向不跟随；401或重定向停止依赖步骤；403允许继续计划中的不带头对照。响应仅保存脱敏状态、长度、哈希、白名单元数据，不保存原始正文/账号认证。

风险R1：临时本地受限目录诊断，不改变鉴权/持久化契约，账号token仅计划在验证证书的官方HTTPS连接内传输，代理只转发加密数据。本轮因出口检查失败未访问账号数据库、未发送账号认证。复用锁定undici7.29.0的ProxyAgent，经本地官方源码核对CONNECT与内层TLS行为，无新增依赖。独立Worker隧道能力随后在[WORKER-WEBSHARE-001](../tasks/WORKER-WEBSHARE-001.md)单独验证；生成/SSE不在本轮验收范围。

## 实际诊断证据

UTC 2026-09-17T15:03至15:05，下载成功，共3条，用户名/密码不输出、下载链接不登记到文档。

| 代理 | CONNECT-only目标 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 9.142.39.218:7388 | chatgpt.com:443 | ECONNRESET，无HTTP状态 | 262ms |
| 138.226.61.165:6338 | chatgpt.com:443 | ECONNRESET，无HTTP状态 | 258ms |
| 9.249.18.109:7343 | chatgpt.com:443 | ECONNRESET，无HTTP状态 | 255ms |

首个代理TCP-only可连接（1ms）；这不证明到真实代理的完整路径或握手可用，本机中间网络可能接管连接。首个代理经HTTP ProxyAgent向固定api.ipify.org的无账号HTTPS出口检查15秒超时，无CONNECT成功/TLS事件；SOCKS5同目标检查ECONNRESET，无CONNECT成功/TLS事件。Undici提示其SOCKS5支持为实验性。

计数：带账号的模型请求0、生成0、刷新0。未得出口IP、未得目标TLS验证成功记录。不能将该网络/握手失败写成ChatGPT 403，不能判定住宅出口无效，也未证明代理账号认证错误。当前未知：本机到代理的网络路径、实际Webshare访问/账号限制或其他中间组件为何重置连接。

8787健康检查ok，Node PID7448继续普通 Node 默认出站；用户8789 PID34668、3000 PID10172保持不变。

## 实施、验证和恢复

入口：output/webshare-marker/probe.mjs，SOCKS5入口probe-socks5.mjs；复用src/security.ts与src/codex/upstream.ts打包到helpers.mjs。配置与所有入口/脱敏结果位于Git忽略范围。脚本node --check通过；两请求header差异断言因出口检查先失败而尚未运行，不声称该真实对照通过。无现有业务源码修改。

脱敏证据：output/webshare-marker/result.json（HTTP检查）、result-socks5.json、tcp.json、connect.json、other-connect.json。第一份超时回执最初以DOMException数值23记录，离线规范化为proxy_timeout，未重复发请求。

本地实施：临时诊断入口准备完成；本地握手验证失败，证据已保存，本地上游对照未执行；审查为R1当前会话自查，不加入已验证修复队列。后续线上隔离测试已完成R2独立审查和两次模型GET对照，证据及结论见[WORKER-WEBSHARE-001](../tasks/WORKER-WEBSHARE-001.md)，并已停用实验入口；未发布主产品。

恢复条件：已确认本机mihomo TUN正在接管默认路由；用户说明本机出口也是Webshare。需修正测试脚本到代理端点的实际路径或确认Webshare连接限制后，先做一次无账号隧道/TLS检查；可用后执行原定最多两次模型GET。不要继续循环旧失败端点，不刷新账号、不把8787切换代理，也不从本地成功推导Worker已可用。

## 同会话网络事实与解释

用户明确本机当前出口为138.226.61.165。无额外ProxyAgent的Node fetch在UTC2026-09-17T15:10:49.846Z经api.ipify.org确认同一IP；结果output/webshare-marker/default-exit.json。该地址匹配下载列表第二条；本机mihomo TUN默认路由开启，mixed入口127.0.0.1:7890。未关闭代理、未修改任何路由、未继续串联隧道。生成配置未直接出现这三条代理IP，尚未验证实时节点拓扑。

因此“Node直连”不能理解为不经过外层代理。显式连接Webshare端点可能经过同一供应商/出口，存在代理自我串联假设，但现有ECONNRESET不能单独证明无限回环或由供应商主动拒绝。若14:57模型对照到15:10出口检查期间路由未变，则来源头对照已经在住宅出口进行，不能继续把住宅IP视为未验证的唯一差异。下一候选应聚焦不带来源标记的受验证TLS隧道路径，后续独立Worker首次测试取得CONNECT 200但平台TLS失败；随后严格JS TLS已通过HTTPS200并确认住宅出口，账号目录对照经明确目的地授权后已完成，不带CF-Worker200、带头403，详见[线上隔离测试](../tasks/WORKER-WEBSHARE-001.md)。

## 当前Worker可构建性核对

用户询问是否仍能部署到Worker，并提出可以新增线上测试Worker。现有src/index.ts、AccountDurableObject、ASSETS以及Worker构建/部署命令仍保留。当前wrangler.worker.jsonc指向既有oneapi及其origin，不能直接用现有deploy:worker命令当作新建独立资源。

npm run build:worker（Wrangler4.129.0）dry-run通过，246.06KiB/gzip54.44KiB；秘密值只在内存比对，Worker构建输出与3个静态资源共6个文件、0命中。脱敏证据output/webshare-marker/worker-build.json。此构建步骤仅验证可打包，未部署主产品Worker；后续[WORKER-WEBSHARE-001](../tasks/WORKER-WEBSHARE-001.md)已部署独立无账号探针并完成有限测试。可通过独立名称/配置/Secrets和新DO namespace进行隔离部署；测试前须准备实际隧道代码和对应验证，不能把旧fetch路径构建通过写成上游已可用。
