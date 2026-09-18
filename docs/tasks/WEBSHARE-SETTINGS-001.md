# WEBSHARE-SETTINGS-001：后台 API key 与固定节点同步

状态：实施、验证、R2独立审查及限定上线完成；真实Webshare列表验收待用户后台填写key。产品变更短任务，REQ21/AC21。

用户希望把已跑通Webshare路径合入后台，通过API key获得节点并刷新，免手工重新导入下载链接。已验证官方 GET /api/v2/proxy/list/ 的 Token APIKEY、mode=direct及可选plan_id，响应带节点id/address/port/username/password。API key管理列表，代理连接使用节点用户名密码；同步是GET最新列表，不调用供应商刷新/替换/购买接口。

平台范围临时假设：当前独立测试Worker优先，Node保留现状；已异步问用户是否同步接Node，合理等待后暂按Worker优先推进，不把此假设标为用户已决定。仍只授权线上oneapi-webshare-test及自身DO/资产，不改其他产品、全局Codex配置或Node现有服务。

后台新增设置卡片：API key（留空保留、不回显）、可选Plan ID、刷新节点、固定节点列表、测试并启用、关闭代理、当前出口和同步时间。默认不轮换、不自动故障切换；同步失败/节点消失仍保留当前完整出口快照；切换必须来自官方完整列表、节点valid且通过固定目标HTTPS连通测试，失败保持旧配置。连通测试是无账号模型GET，200/401才视为目标可达，不把它当账号生成成功；启用后真实生成仍由现有AccountService规则处理。关闭明确改为直连，当前Worker直连曾失败，UI提示此后果。已有环境PROXY_CONFIG作为bootstrap兼容，尚未配置key时当前在线服务保持原路径。改变key/plan清空旧列表，但不切当前出口；成功同步后管理员明确测试启用新节点。

敏感API key及所有节点用户名/密码/当前完整出口共同AES-GCM加密保存在自身DO，AAD oneapi:webshare-settings:v1。GET/写返回只含密钥配置bool、plan、公开节点id/host/port/country/valid/当前出口及时间，秘密不回显、不进入调用日志。现有管理员鉴权/CSRF后才调用可选adminExtension；仅实验Worker注入此功能，Node/其他Worker返回404并隐藏UI卡片。新请求读已提交快照，进行中请求保持原隧道；更新操作串行，完整获取成功才保存，不返回部分页。没有任意代理输入或任意URL。

R2依据：新的API key/节点敏感状态、可变代理目的地和管理员扩展若错误可能泄露凭据或放宽权限。目标固定官方API HTTPS/GET；分页不追随nextURL；只接受公网标准IPv4、合法端口/ASCII认证/唯一ID；拒绝私网/loopback/linklocal/保留地址。一次同步20秒、每页256KiB、25节点/页、最多10页250节点；每个设置正文4KiB/5秒。上游错误输出固定脱敏码；无传输重试，保留AccountService现有鉴权恢复规则。APIkey撤销后同步失败保留当前可用代理快照，节点密码真正失效仍正常报出站失败，不伪称APIkey永久有效。

本地API fixture5/5及主类型检查通过；完整设置加密/同步保留/切换失败/鉴权/CSRF/重启/并发/UI/最终bundle审计待补；原TLS31项按实质改动复用/针对性验证。需fresh reviewer R2；准备后只给当前实例部署，新DOclass/加密key/账号不换、不迁移。当前不持有用户Webshare API key；可先交付设置入口，让用户在后台填写后真实同步验收，无须在聊天明文提供key。

部署/回滚：固定精确实例guard、云端原key组合fingerprint保护、发布前实际其他资源基线比较。保留原PROXY_CONFIGbootstrap；若设置回滚代码，恢复bootstrap不删账号/换加密key，已有新加密设置作为不可读取旧代码状态留存。主Node默认发布路径不改变。恢复点与上线/真实API状态实施后原位更新。

## 本地/独立审查证据

API/settings12/12通过；共享AccountService管理员扩展的Node现有全量28/28通过；既有TLS/HTTP/探针27/27通过；完整新入口app4/4通过，含新设置未鉴权401、会话GET200/仅公共信息、CSRF403与非法key400。主类型检查及实验入口严格类型检查通过。完整dry-run1184.06KiB/gzip335.62KiB（3个public资产）。原TLS补丁及协议安全规则未变。

R2首审两项已修复：稳定safe count、每页count一致和最终累计==count，拒绝不完整/矛盾列表才可save；排除192.88.99/24，并覆盖相邻地址边界。fresh reviewer聚焦API/settings12/12独立通过，[审查回执](../verification/WEBSHARE-SETTINGS-001-review.md)。当前追加发布盘点阶段selector只允许app/settings，保留旧app-before/isolation，settings另存，精确目标和密钥保护不变；等待对此窄diff的核验。

实际浏览器Playwright使用随机端口4360/临时独立DO、全虚构key和fake Webshare API：登录→设置卡片→保存key/Plan ID→输入清空/key已保存→同步出现9.142.39.218:7388/US→当前bootstrap138.226.61.165保持→切页列表保留→填秘密草稿后退出→key空/section隐藏。未点击会真实拨号的节点apply按钮；成功/失败切换门禁由纯fixture覆盖。CLI eval首次Windows引号失败，调整单引号JS字符串后DOM结果通过；临时fixture根路径映射404已修，属于夹具不改主产品。浏览器产物均ignore，不传真实账号或代理密码。

当前发布准备受实际Cloudflare API429/error10429影响（UTC2026-09-18T03:14后）；密钥连续性预检正确fail closed，因此本轮线上写入0/部署0，原账号和住宅路径继续原94ce538c版本。不是自动审批拒绝/不是Webshare路线失败；不绕过guard。按平台限流窗口有界等待，恢复后只读确认实际资源和原key指纹、最终真实秘密值内存审计、采集settings-before独立基线再精确部署。若本轮仍限流则保留此恢复点，不宣告设置上线。

## 发布及当前状态（完成，真实API列表待用户key）

UTC2026-09-18T03:16只读Wrangler whoami完成原OAuth自动续期；429/401恢复，原key组合指纹保护及最终源码/构建/静态资源真实秘密值内存审计14files/0matches通过。不手改token或触发新登录，不绕过guard。独立审查追加窄发布工具差异通过；settings-before实际基线采集03:16:44，7个其他Worker、7个自定义域名、1个既有专属DO。域名总数相对002增1是此写入前已有状态，不冒认或回滚他人变更。

03:17:14–40执行guarded --settings --deploy：同值独立Secrets原key指纹校验后重用、只更新本人oneapi-webshare-test代码及2个修改资产（styles未变）；没有迁移/删除已有DO、没有替换账号或代理配置。新版本778f245e-0850-4c60-b315-1daf95e49c53，1184.06KiB/gzip335.62KiB、启动31ms。发布前后7个其他WorkerChanges=[]、domains/subdomain unchanged、newNamespaces=[]；原namespace继续使用。

03:17:55线上设置回读：GET/admin/webshare200、supported=true、apiKeyConfigured=false、activeSource=bootstrap、activeNode138.226.61.165:6338、nodes=[]；匿名401；后台HTML含webshare-section。当前APIkey尚未输入/没有真实WebshareAPI列表请求或节点切换。旧Webshare住宅用户名密码不回显，旧住宅路径仍启用。

03:17:56–18:09发布后完整回归：原独立官方账号connected=true且无需重新授权；真实模型目录200；gpt-5.5 Responses普通和Chat流式均WORKER_OK，临时API key/session清理成功；各一逻辑生成，SDK maxRetries0。脱敏副本settings-live-upstream.json与settings-live-config.json。旧通用app-live-upstream.json被本轮烟测更新为最新回归，不把它的当前时间误认002历史时间；原002历史验收的具体回执保留于会话及文档记录，001的固定对照models-pair-result未改变。

当前用户步骤：打开https://oneapi-webshare-test.12213443th.workers.dev/admin/#settings，填Webshare APIkey；本用户静态住宅套餐PlanID可填14320842以免拿到其他默认套餐；保存→刷新节点→选择固定节点→测试并启用。APIkey不需在主会话发送。key未撤销且套餐可用时以后GET同步即可免下载链接；真实节点API列表/切换尚待用户后台输入key验证。不伪称真实API同步已验收。

当前实现、针对性验证、R2审查及限定发布/原服务回归已完成；依赖用户输入其Webshare key才能继续真实列表验收。Node范围仍为用户未回复的后续选择，本次不部署或接入Node；临时本地UI夹具PID9304及专用Playwright会话已清理。现有服务和其他任务修改保留，未自动审查/清空维护队列。


最终回读UTC03:19:05：其他7个WorkerChanges=[]，domains/subdomain unchanged，newNamespaces=[]；元数据确认实际版本778f245e-0850-4c60-b315-1daf95e49c53及原namespace/Secret名称保持。此次最后本机端口盘点未发现8787/8789/3000监听；本轮未启动/停止或修改这些端口的服务，不能把002十小时前的PID存活结论当当前证据。仅清理已核验本任务虚构UI夹具，不将本机外部进程状态变化写为本任务成果。
