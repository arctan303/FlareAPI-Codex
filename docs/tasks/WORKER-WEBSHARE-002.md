# WORKER-WEBSHARE-002：可使用的独立 Worker 实例

状态：实施、本地验证、R2独立审查、真实部署及新账号全链路验收完成。产品变更短任务，R2。

## 目标、范围与预期行为

用户要求“线上跑通了吗？给我一个线上跑通的worker”，并持续授权只操作新实验资源、不影响其他线上产品。将 WORKER-WEBSHARE-001 的目录成功路径接入完整 OneAPI 后台，在原独立 oneapi-webshare-test 上提供登录、账号设备授权、模型目录及最小生成。保留 Node 主交付方向、现有 API/后台契约和原服务。此新任务替代“本实验只保留停用探针”的后续状态，不撤销001已完成的有限对照结论。

唯一线上变更目标：oneapi-webshare-test.12213443th.workers.dev；新建仅属于它的 WebshareAccount SQLite DO namespace，绑定 ACCOUNT；仅部署其自身静态资源和随机生成独立密钥/既有 Webshare 代理Secret。不绑定自定义域名，不引用既有 namespace/其他 Worker service，不修改原7个 Worker、6个域名或其他数据。

固定上游：chatgpt.com 的 Codex models（固定 client_version=0.153.4）、responses 和 wham/usage；auth.openai.com 的设备授权两接口及 oauth/token。HTTPS443，固定方法/无额外查询；无任意转发入口、传输自动重试或跳转跟随。保留 AccountService 已有上游401后最多一次令牌刷新/重发鉴权恢复，以及管理员主动设备轮询；这些不是传输层自动重试。CONNECT只发送代理认证，账号内容仅在严格TLS完成后发送；不附加CF-Worker或代理来源头。

R2依据：新的云端账号加密持久化及代理中的账号传输，TLS/鉴权失误可能泄露凭据；需要严格TLS真实拒绝回归、流式/取消/帧行为和 fresh reviewer 独立证据。复用现有 Gateway/AccountService 鉴权、加密、日志与会话实现，无主产品行为变更。

## 账号和依赖

独立实例用官方设备授权建立自己的凭据，不复制现有本地/线上可轮换 refresh token，不修改现有账号。001仅两GET的access token授权不能被解释为复制refresh token或持久化既有凭据的许可。用户须在官方页面完成新实例设备授权；此前可以完成构建、审查、部署、后台登录和设备码发起验证。

TLS固定 @reclaimprotocol/tls 0.1.4，隔离依赖目录和001已核验CertificateVerify强制补丁/指纹保留。启动前验证补丁；配置nodejs_compat。无证书降级、额外生产根或AIA网络请求。

## 实现和验证

实验专用入口 experiments/oneapi-webshare-worker.ts 导出 WebshareAccount，复用已有Gateway；AccountService注入 experiments/webshare-fetch.mjs。HTTP/1.1按字节解析严格Content-Length/Chunked，响应body按消费者pull增量交付，TLS泵补有界背压。请求体2MiB；控制响应2MiB；生成响应64MiB，TLS wire另留8MiB；头32KiB，CONNECT16KiB。控制总时限20秒（现有AccountService控制10秒更早取消）、连接/握手/响应头20秒、生成总时限300秒。客户端abort/取消关闭仅其自身隧道，凭据/原始异常不打印。

本地已完成001的19项TLS/探针回归，新增7项HTTP测试通过（目标先拒绝、认证分层、真实字节长度/不跳转、流首事件提前交付/独立取消、abort、坏帧拒绝、消费者背压）。完整构建首次因WebCrypto导出拼写失败，已按001现有入口修正；待再次构建及新入口隔离运行验证。

验收门槛：独立审查通过；最终源码/构建秘密值内存审计0命中；隔离配置强断言；线上health、后台资产、未鉴权401、管理员登录/CSRF、独立未连接状态；新官方授权后目录200和最多两次gpt-5.5最小生成（Responses及Chat流式，SDK retries0），测试key/session清理；原资源盘点与本地监听保留。若授权需用户操作，提供可登录真实在线地址、口令和明确尚未验证的生成项，不将health当上游完成。

## 发布与回滚

只使用 wrangler.webshare-test.jsonc，不执行原 deploy:worker、域名绑定或迁移脚本。发布runner必须核对精确name/account/main/routes/origins/DO/migration及无其他服务资源。线上Secret由忽略的.env.worker-webshare-app.json注入，凭据不进bundle。回滚先在本资源关闭代理或恢复已验证probe配置/代码，不删除既有产品或数据库；若本实例已有账号，不换TOKEN_ENCRYPTION_KEY、不删除其DO数据。实际版本/资源ID、审查与live证据实施后原位更新。

本地追加证据：完整Worker dry-run成功1169.65KiB/gzip332.17KiB；实际新入口在Miniflare临时随机端口/隔离SQLite实例通过health、401、管理员cookie登录、未连接状态、CSRF403及禁用旧账号导入404。部署配置拒绝旧产品name、routes、跨服务绑定/DO及原域名；共28/28行为测试通过。源码+构建/地图/静态资源的代理及新密钥值内存审计0命中，固定TLS补丁指纹正确。主产品package/锁和源文件未变。待独立审查/部署/新授权。


独立首审不通过的两项已修复：①新实例密钥组合的SHA256指纹随本Worker变量保存；prepare()先只读本资源settings/namespace，已有namespace或指纹时缺少原文件/指纹、不匹配原key一律拒绝，不再生成或上传替代key；补纯fixture覆盖。首次probe无namespace/指纹才可初始化；每次发布重新核验。②无重试契约原位修为无传输重试，保留既有一次401鉴权刷新恢复。真实CONNECT/TLS/HTTP chunked首事件cancel回归通过，socket.closed拒绝显式观察；解压后也按2/64MiB限额，当前共30项针对性检查。

部署前原资源证据：UTC16:17:42采集app-before.json，当时本轮尚无任何Cloudflare写入；flaremail、flaremail-dev、music-arctan-top相对001旧基线已有外部变化（modified_on分别16:09:40、16:06:38、16:14:57）。保留app-preexisting-changes.json，不冒认或回滚其他产品修改；本次部署隔离按实际写入前app-before基线比较，不覆盖001历史盘点。原域名/namespace仍保持原状态，后续只允许新增归本script的单一WebshareAccount namespace。

聚焦复核的相邻发布检查发现app-before包含被授权目标自身，原比较会在成功发布后误报本目标变化；已抽出compareExistingWorkers仅排除精确oneapi-webshare-test，仍完整比较原7个产品etag/modified_on。纯fixture证明只有本目标变化允许，其他产品变化或丢失拒绝；app4/4通过（总31项）；发布前资源隔离断言通过。实验源码不再变化，待最后差异复核。

## 实际发布及授权前恢复点（历史，已完成）

当时状态：实施完成；31项针对性行为检查/实验入口TypeScript严格检查通过；R2最终独立审查通过（[回执](../verification/WORKER-WEBSHARE-002-review.md)）；完整实例已真实部署，等待官方授权。此等待状态已由末节真实全链路验收替代，保留为历史。

UTC2026-09-17T16:20:45最后源码/构建/静态资源秘密值审计0命中，固定TLS补丁及精确隔离配置通过。专用guarded runner上传仅本Worker独立ADMIN_API_KEY/GATEWAY_API_KEY/TOKEN_ENCRYPTION_KEY/PROXY_CONFIG，然后部署自身3个public资产及完整代码1169.99KiB/gzip332.24KiB。线上版本94ce538c-83ba-449e-a68e-1aa1a91c4783，启动46ms，地址 https://oneapi-webshare-test.12213443th.workers.dev 。本资源新namespace 21023ba651c34407b79f52dc9c1ec525（oneapi-webshare-test_WebshareAccount），只归本script和class。无域名绑定/其他service/D1/KV变更。

UTC16:21:15相对本轮实际部署前app-before基线，原7个产品etag/modified_on全部未变、6个自定义域名及workers.dev子域名未变；只新增上述自身namespace。001旧基线与本轮写入前的外部并发变化已另存，不伪称旧基线从未发生变化、不回滚其他产品。

UTC16:21:25–30线上完整验收（scripts/verify-webshare-app.mjs --start-login）：health200且service=oneapi-codex-gateway-demo；后台HTML200；匿名admin/status401；新管理员登录及cookie读status200；CSRF403；旧账号导入404；connected=false、reauthenticationRequired=false；官方auth.openai.com设备码接口经新住宅TLS隧道200，得到15分钟pending授权状态；测试管理员session清理成功。模型逻辑请求0，生成0，原refresh token传输/变更0。报告仅保存有限公开设备状态/脱敏结果，不保存上游token。此次只发起一次设备码，无自动重试。

用户需在官方设备页面完成新实例授权；已在主会话提供官方页面/设备码及新后台入口/口令（不写入本记录）。本地交付便条output/worker-webshare/app-access.txt仅含新管理员信息，ignore；随机密钥.env.worker-webshare-app.json严格ignore，勿删除/改写，云端已有实例必须保留并校验原组合fingerprint。旧诊断PROBE_KEY仍保留但新入口无/probe功能、无法通过它操作后台或拨号；不因发布宣告旧key有管理权。

恢复动作：用户完成授权后运行一次忽略的poll-app-login.mjs（固定本人实例、20秒、单次poll；连接成功后凭据由现有AccountService加密保存新DO），随后 scripts/verify-webshare-app.mjs --upstream 执行一次模型目录逻辑请求及最多两种最小生成（Responses普通、Chat流式；maxRetries0），记录结果/临时key和session清理，盘点原资源。未授权/过期则等待用户或在此实例重新发起设备码，禁止复用本地refresh token、生成循环或改其他产品。8787/8789/3000现有服务保留。


## 官方授权后真实全链路验收（完成）

用户在明确设备授权请求后回复“ok”；UTC16:23:15单次官方设备轮询返回200、status=connected。新凭据来自此独立设备授权，按原AccountService加密保存新DO；没有把原本地/线上refresh token复制到此Worker。云端已有专属namespace且公开高熵key指纹与原本地独立key组合匹配。

UTC16:23:26–38运行 scripts/verify-webshare-app.mjs --upstream：真实完整实例后台/管理员cookie/匿名401/CSRF403/旧导入404继续通过；connected=true，reauthenticationRequired=false；新临时API key不能访问管理员401。一次/v1/models逻辑请求返回200且allowlist含gpt-5.5；官方OpenAI SDK7.10.0 maxRetries0通过新Worker/v1分别完成gpt-5.5 Responses普通生成及Chat Completions流式生成，两次正文均为WORKER_OK，status/finish确认成功。Responses总40token，Chat18token。真实客户端生成逻辑操作2，模型目录逻辑请求1，没有执行生成循环或SDK重试；保留既有上游401一次鉴权恢复规则，不据此断言本轮有刷新。finally临时API key删除与管理session退出均成功。

脱敏报告：output/worker-webshare/app-live-upstream.json；单次设备轮询仅公共状态报告app-login-poll.json；精确版本元数据以回读94ce538c-83ba-449e-a68e-1aa1a91c4783为准。未保存/打印OAuth token、代理密码或真实generation输入账号信息；测试正文只为固定WORKER_OK回声。新实例账号保持连接和真实可使用状态，代理Secret保留以服务此实例，不再恢复停用探针。

验收结论：REQ20/AC20所需独立Worker登录、官方设备授权、模型目录及最小两种文本生成已完成，用户可访问后台创建自己的API key。此结论仅覆盖该住宅代理、当前固定Codex0.153.4及gpt-5.5文本/流式；未新增所有模型/工具/图像/长期稳定性承诺，Node默认交付方向及其他产品保持原范围。无需用户进一步操作本任务，未移除维护队列无关待复查项。


最终隔离回读UTC16:24:22：相对app-before，原7个WorkerChanges=[]，domains/subdomain unchanged，只新增本Worker专属namespace；原3个本地监听8787 PID7448、8789 PID34668、3000 PID10172保持不变。后台入口已交付/在Codex排队打开，独立实例在线且账号连接；无待执行生成或需用户出手的本任务步骤。
