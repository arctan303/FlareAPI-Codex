# WORKER-WEBSHARE-001：独立线上住宅代理隧道探针

状态：隔离线上测试完成。严格JS TLS住宅出口通过；同一凭据/代理模型目录不带CF-Worker为200有效JSON模型数组，只增加该头为403 HTML；固定两次GET，无生成/刷新/重试，凭据未变。已停用代理与模型门禁，其他线上资源未改。日期2026-09-17，源码基线13c8de1。依赖：[本地诊断与Worker构建](../maintenance/WEBSHARE-MARKER-001.md)。

授权：用户明确“可以测试部署到线上，不能影响线上其他使用的东西”。仅创建oneapi-webshare-test，限定workers.dev；不改现有Worker、域名/路由、DO、D1/KV、Access或本机网络。名称创建前两次盘点均空闲。用户报告并已核对本机外层住宅出口138.226.61.165，本轮使用该代理。

目标：绕过本机TUN干扰，验证Worker经Webshare住宅出口能否正常访问模型目录，并固定对照CF-Worker来源头的影响。先完成无账号HTTPS与目标TLS，再在R2审查通过后用只读凭据做两次GET。

范围/非目标：独立实验代码和配置，无业务存储、资产或服务绑定，不导入/持久保存账号。初始无账号探针已通过，当前授权只在请求内存传递access Authorization及Account-ID做固定模型目录对照；不传refresh token或本地密钥，不发生成/刷新请求。匿名GET /health与随机测试Bearer保护的POST /probe；operation允许ip（api.ipify.org:443固定路径）、chatgpt-tls（chatgpt.com:443，仅验证握手）及短期nonce/期限门禁保护的models-pair（固定两次模型GET）。代理限定三个已授权地址/端口，凭据通过本Worker Secrets注入。不改变主产品REQ-17/DEC-014单服务器方向。

预期：无鉴权/非法参数/大请求不拨号，固定目标、单次连接、20秒总超时、CONNECT头16KiB及响应64KiB限制。当前使用严格校验的JS TLS1.3；早期平台startTls版本已被替代。指定正确SNI并校验证书/主机及私钥签名，不关闭验证。输出脱敏阶段/状态/出口，不输出密码、原始响应/错误。socket.opened或写入成功不能单独证明完整TLS握手、证书主机校验成功；必须有有效HTTPS应用响应才可进入账号测试。初始线上各一次ip和chatgpt-tls；失败后为新诊断信息补两次ip：第一次细分写/读/解析阶段，第二次记录读取字节数及白名单TLS错误。无自动重试，前置失败停止账号测试。

路线：独立诊断短任务。风险当前R2：access token经本人云端实验组件后转发固定上游，TLS缺陷或回执泄露会暴露凭据，需fresh reviewer；初始无账号范围R1自查不覆盖当前凭据边界。当前首审发现两项TLS校验缺口，已实质修复，聚焦复核通过，覆盖仅本轮固定两次GET；不代表生产TLS全面认证。

## 早期平台TLS版本：实施和线上证据（历史）

新资源：https://oneapi-webshare-test.12213443th.workers.dev。独立配置wrangler.webshare-test.jsonc，routes为空，无DO/KV/D1/资产/服务绑定；禁用observability和preview URLs。本轮仅向该资源上传PROBE_KEY与PROXY_CONFIG两个Secrets，无账号凭据。初始代码版本4e0e8e84-f35c-47be-b763-1517fb217514；阶段细分版本8035f6fe-e93c-4b34-8e84-ceabb507cda4；最终诊断代码版本09710257-4f10-48c7-a2da-00b334141c14。Secret操作另行产生版本，不把代码版本误写成最终部署版本。

| 验证 | UTC时间 | 结果 |
| --- | --- | --- |
| /health及无鉴权/probe | 15:29 | 200正确服务名；401，未拨号 |
| chatgpt-tls | 15:29 | 住宅代理138.226.61.165:6338 TCP可用，CONNECT 200，TLS socket.opened成功；未读应用数据，不能宣称目标完整TLS验证成功 |
| 初始ip | 15:29 | TCP/CONNECT可用，TLS升级后HTTPS失败，无出口结果 |
| ip阶段细分 | 15:31:35 | HTTPS写入返回成功，读取报TLS错误 |
| ip字节及白名单错误诊断 | 15:35:18 | CONNECT 200；https_read阶段TLS handshake failed，收到0字节HTTPS响应 |
| 停用验证 | 15:36:10 | 移除仅本测试Worker的PROXY_CONFIG；/health仍200，有效测试key的/probe返回503 probe_disabled，不再拨号 |
| 最终资源对比 | 15:36:12 | 原有7个Worker修改时间与etag未变；6个自定义域名、0个DO namespace及workers.dev子域名未变，只新增测试Worker |

未取得HTTPS响应，因此没有验证云端住宅出口IP，没有执行带/不带CF-Worker的目录对照，不能判断住宅代理能否消除原来的403，不能把TLS失败写成ChatGPT拒绝。模型/生成/账号刷新请求均0，未读取账号数据库。本机CONNECT重置未在云端复现，但不证明本机一定存在回环，也未定位云端TLS失败的最终原因。

## 早期平台TLS版本：验证和交接（历史）

针对性验证node --test scripts/test-webshare-worker.mjs：7/7通过，覆盖鉴权/参数先拒绝、407不升级TLS、固定目标/请求头、TLS失败脱敏、响应格式、总超时无重试及TLS读取失败收到0字节。最终Wrangler dry-run通过：9.33KiB/gzip3.20KiB，无资源绑定。源码及最终构建产物秘密值审计0命中。主产品代码与锁文件未变。8787 PID7448继续运行；用户8789 PID34668与3000 PID10172保持不变。

相关文件：experiments/webshare-worker.mjs、experiments/webshare-probe-core.mjs、scripts/test-webshare-worker.mjs、wrangler.webshare-test.jsonc。脱敏证据在Git忽略的output/worker-webshare/：before.json、after.json、isolation-result.json、live-result.json、ip-diagnosis.json、ip-final-diagnosis.json、disabled-result.json、audit.json。代理配置及测试key仅保存在忽略的本地.env文件，线上代理配置已移除。

早期恢复条件已由后续JS TLS的无账号HTTPS200及目标握手满足；当前依赖是完成R2修复复核，再做账号对照。官方workerd源码对expectedServerHostname存在可能拒绝的开关；native node:tls内部也调用socket.startTls，不能假定换Node接口自动解决。纯JS TLS属于另外的具体方案，需要先评估依赖和证书验证；早期阶段未安装该依赖；随后按继续授权装入独立实验目录，未降级TLS、未循环旧失败路径。每次恢复核对本资源仍为实验Worker及现有资源无变更，不直接执行主项目deploy:worker覆盖既有资源。

## 继续测试：严格校验的 JavaScript TLS（2026-09-17）

用户再次明确授权持续测试，仅不影响线上其他产品；只有需用户操作或证据足以确认路线不可行时停止。原20秒有界单次请求规则继续适用，整体不采用自动重试。当前范围恢复无账号前置测试；若通过，另行准备最小云端凭据边界、R2审查后再做固定两次模型GET，不发布主产品。

实现：独立目录output/worker-webshare/tls-runtime安装@reclaimprotocol/tls@0.1.4（--ignore-scripts，固定版本及本地package-lock；registry完整性sha512-YIz0bRJxBj6S4u0nJf7Rkb7Nkqpwv2ySKHWjdvHUVU0xK1NqxWPPNxyLmiXiqDL2x0sLmDhDDZFPJxtnhabDTw==）。主项目package.json和锁文件不变。配置仅本实验增加nodejs_compat。TLS客户端直接处理CONNECT后的字节，不调用平台startTls；仅TLS1.3、AES-GCM、P256/P384，ALPN固定HTTP/1.1。启用库内证书链、签名和Finished校验，再补SAN优先、单标签通配、CA/用途/pathLength、有效期、未知关键扩展及不支持name constraints拒绝规则。禁止证书AIA扩展引出额外网络目标，缺失中间证书即失败。握手必须经过严格证书回调才能resolve，不把socket.opened当完成校验。库日志关闭，只有固定握手阶段标签进入脱敏报告。

验证：node --test scripts/test-webshare-tls.mjs scripts/test-webshare-worker.mjs 12/12；真实TLS服务器使用随机空闲本地端口和临时生成的CA/leaf，正常HTTPS200、不可信CA、CN匹配但SAN不匹配、过期leaf均验证。发现证书回调异常可能延后反映到握手回调，已改为立即关闭并保留原固定错误；修复后同组通过。dry-run919.90KiB/gzip277.83KiB，源码及构建秘密值审计0命中。

相关新增：experiments/webshare-tls-transport.mjs、scripts/test-webshare-tls.mjs。后续线上结果将原位补到本节；早期有限测试及停用结论只代表其当时版本。

## 账号目录对照的执行契约（R2，独立审查通过，真实请求待执行）

无账号前置已通过：UTC15:47:51 ip真实HTTPS200、出口138.226.61.165、TLS1.3/证书/Finished校验通过；15:48:13 chatgpt.com完整TLS校验通过。JS TLS代码版本13e50600-c08b-4d07-9da3-0bb844d181cb，代理Secrets恢复版本26f14b42-62e5-4e81-95c5-a7f4216ebcc4。Secrets恢复后的首次探测命中旧配置503，无拨号；只读确认新部署与Secrets后首次实际ip探测通过，不把配置传播误作TLS失败。

本轮风险升级R2：本地已有账号access token及Account-ID会经HTTPS交给本人隔离测试Worker，在内存组装固定chatgpt.com模型请求；错误的TLS校验或泄露回执会暴露凭据，需要fresh reviewer独立核验。此前无账号部署的R1结论不覆盖此新边界。

只读SQLite credentials快照，保留加密值指纹和有效期/刷新窗口预检；通过预检后复用createModelsRequest核对所有应用头与固定URL。只传access Authorization和Account-ID，不传refresh token、存储加密key或ADMIN_API_KEY，不写Cloudflare Secrets/DO/D1/KV。请求正文不落盘、不打印；无可控URL/方法/客户端版本/任意头。测试Bearer、匹配运行nonce及最多30分钟期限同时通过才可运行，16KiB入站正文/5秒读取期限，单isolate再次调用拒绝409（非全局一次性保证）。客户端只调用一次models-pair，内部最多两次GET，各20秒，响应上限2MiB；不生成/刷新/自动重试/跟随重定向。基线不带CF-Worker，其后只增加同一个来源头；基线401、重定向或连接错误停止，403可继续对照。

TLS必须经过证书链/签名/严格SAN及用途/Finished校验才发送账号；代理CONNECT只含Webshare认证，不含账号头。上游输出仅状态、白名单Content-Type/CF-Ray/challenge、字节数、哈希及JSON/模型数组结构标记；不输出正文、账号、代理密码或原始异常。源码与构建再以真实秘密值内存审计。客户端finally读取credentials指纹，证明没有改变本地凭据。

当前fixture17/17通过：包含真实TLS正常及三类拒绝、仅头差异、账号不在CONNECT、未完成严格握手不发送账号、401/重定向停止、门禁和同isolate重复拒绝、UTF-8 chunk长度按字节及格式拒绝。真实账号runner为scripts/probe-webshare-models.mjs，需node --env-file=.env启动；helpers复用此前忽略目录构建。未来main app方向和现有资源仍不在变更范围。真实对照后移除本实验PROXY_CONFIG并取消MODEL_RUN_ID/期限，保留脱敏证据，再盘点既有资源。

R2首审结论不通过，两项问题已修复：①原TLS库未强制收到并验证CertificateVerify后才接受Finished；experiments/patch-webshare-tls.mjs核对0.1.4与原文件SHA2566203af15f12e36409d0778d7f2d9da0f1d2a666eac178efc818315a3749bb5d1，插入私钥签名成功标记及TLS1.3 Finished强制检查，补丁后SHA256accf51dd31b5c5783cfdfd2ebfc44ea1438896897078dc7e58b6b27a997ca405。②适配层在resolve之前强制实际协商TLS1.3且套件为指定AES-GCM。真实本地TLS握手通过onRead测试钩子把已解密CertificateVerify消息类型移除，明确在Finished前报certificate_verify_required；legacy protocol和非允许套件拒绝回归通过。全部19/19通过。可复现准备顺序：npm install --prefix output/worker-webshare/tls-runtime --ignore-scripts --no-audit --no-fund --save-exact @reclaimprotocol/tls@0.1.4，然后node experiments/patch-webshare-tls.mjs，测试及dry-run。附MIT声明，保留构建中第三方许可。上述新证据已由同一fresh reviewer聚焦复核通过；回执见[独立审查](../verification/WORKER-WEBSHARE-001-review.md)。账号代码待部署、真实请求待执行。

## 先前审批恢复点（已获明确授权，历史）

修复后实际账号对照代码版本c537edc1-c11f-4c6e-8558-4c2005e7a94d部署成功，UTC15:58:16无凭据/health确认strict-tls13-cv-v1及短期模型门禁ready；线上仅proxy/testkey两个Secrets，Account-ID/access token不在Secrets。UTC15:58:40使用签名检查修复后的版本再次真实ip HTTPS200，certificateChecksPassed/tlsHandshakeVerified均true，TLS1.3/AES128GCM，出口138.226.61.165。19/19针对性测试、独立复核及真实秘密内存审计通过，现已证明纯Worker通过该住宅代理访问HTTPS可行，不代表模型接口或生成成功。

随后请求执行node --env-file=.env scripts/probe-webshare-models.mjs被exec_command自动审批拒绝，进程未启动；原因是它要求用户明确允许本地Codex access token及Account-ID向本人测试Worker oneapi-webshare-test.12213443th.workers.dev及chatgpt.com出站。既有广泛测试授权在自动审批中被判不足。未绕过拒绝，当前cloud模型GET0、账号pair调用0、账号凭据向Worker传输0、生成/刷新0；只读预检和本地真实秘密审计不等于发生账号出站。

无关授权工作已完成：本轮测试只改变新Worker；已移除PROXY_CONFIG并取消MODEL_RUN_ID/MODEL_PROBE_DEADLINE，保留受限诊断代码、测试key与脱敏证据。实际停用回执和最终云端资源对比在output/worker-webshare/disabled-result.json及isolation-result.json。

当时未完成：固定两次模型目录GET；随后用户明确授权，现已在最终对照节完成。需要用户明确授权：允许把现有本地账号的access token和Account-ID经HTTPS交给指定本人实验Worker，再经严格验证TLS转发固定chatgpt.com/backend-api/codex/models?client_version=0.153.4，仅两次GET；不传refresh token/本地key，不保存凭据，无生成/刷新。得到后核对代码与补丁指纹、复用仍有效的R2证据，恢复仅本Worker代理Secrets和新短期nonce/期限，检查云端ready/前置HTTPS及账号窗口，然后运行单次pair，结束立即停用及资源复核。若代码实质改变，相关审查证据重新核验。不能把此审批拒绝当成技术方案失败。

## 明确授权后恢复（本地2026-09-18，UTC2026-09-17）

用户在主会话说明具体数据（本地Codex access token及Account-ID）、目的地（本人oneapi-webshare-test.12213443th.workers.dev及chatgpt.com）和仅固定两次GET后，明确回复“我允许”。此前自动审批未认可的敏感目的地授权条件已满足。范围仍不含refresh token/本地key云端传输、持久化账号、刷新/生成或其他线上产品改动。

恢复前UTC16:00:26 /health严格TLS profile且modelProbeEnabled=false，/probe503已停用；16:00:28对比7个既有Worker etag/modified_on、6个域名、0个DO namespace及子域名均未变；TLS补丁指纹保持accf51dd…997ca405，账号预检ready及真实秘密artifact0命中。代码未实质变动，复用有效19/19与R2独立通过证据，不重复审查。恢复新的10分钟nonce/期限、仅proxy/testkey Secrets，最终结果见下一节。

## 最终账号对照与结论

本地2026-09-18，UTC2026-09-17T16:01:39启动scripts/probe-webshare-models.mjs。明确目的地授权后自动审批允许执行，进程正常完成。新的门禁代码版本a1fa397d-ad43-48be-8911-ab0337dc666c，恢复proxy Secrets后的实际版本b55ddf5e-4fd3-47ae-af46-6050562535c1；/health严格profile、门禁ready且元数据仅两种proxy/testkey Secrets确认后发一次pair。账号只在请求内存存在，不传refresh token/本地key、不写云端Secrets或存储。

| 模型请求 | 住宅代理 | 上游状态及格式 | 正文字节 | CF-Ray |
| --- | --- | --- | --- | --- |
| 不带CF-Worker | 138.226.61.165:6338 | 200 application/json，JSON合法且models数组存在 | 405467 | a3c954b94de834bd-SJC |
| 同一请求仅增加CF-Worker: oneapi.12213443th.workers.dev | 同一代理 | 403 text/html; charset=UTF-8，HTML | 6634 | a3c954d67b541643-SJC |

两次均TCP/CONNECT200、严格证书/SAN/CertificateVerify/Finished校验完成、TLS1.3/AES128GCM。前置同一代理ip已确认出口138.226.61.165；模型请求自身不调用出口接口，不把代理配置和同时测得公网IP混作每条请求独立采样。两次使用同一内存凭据、固定URL/方法/应用字段，只在第二条增加来源头；没有凭据准备刷新或请求重试。实际pair调用1，模型GET尝试/写入完成2；生成0、刷新0、自动重试0，401/重定向未发生；finally只读凭据加密值指纹未变。仅保存脱敏回执output/worker-webshare/models-pair-result.json，不保存模型原正文或请求凭据。

结论：纯Worker经此Webshare静态住宅代理、严格JS TLS的出站路径可正常获取官方模型目录；在该路径与本轮同一住宅条件下，显式CF-Worker头仍触发403，住宅IP不能抵消其影响。应使用不会附加该来源头的隧道出站实现；不能把结果解释为仅换住宅IP、保留既有原生fetch路径就一定解决。此次只验证模型目录，未部署主产品/导入账号/验证生成/SSE，不改变现有单服务器产品方向。

测试结束已移除本实验PROXY_CONFIG并取消MODEL_RUN_ID/期限，只保留不可拨号的诊断代码与测试key。最终健康/停用、Secret名称与云端资源盘点证据在output/worker-webshare/disabled-result.json、isolation-result.json，停用代码与实际版本由末尾回读记录。任何下一轮必须另行建立具体测试范围和恢复短期门禁，不能继续循环当前pair或将实验TLS视作生产库全面认证。

最终停用回读：UTC16:03:20 /health200，profile strict-tls13-cv-v1、modelProbeEnabled=false，有效测试Bearer的/probe503 probe_disabled；云端绑定只剩PROBE_KEY，没有代理/账号Secrets、模型nonce/期限或任何业务资源。最终实际部署版本1386c0be-e8fb-4bc9-83c4-8401110e38f3。UTC16:03:18相对before基线，7个原有Worker etag/modified_on全部未变，6个自定义域名/0个DO namespace/子域名未变，只新增本测试Worker。8787 PID7448、用户8789 PID34668和3000 PID10172保持原监听。实施、针对性验证、R2审查及有限线上对照已完成；实验资源保留但拨号/模型入口停用，无待用户操作。
