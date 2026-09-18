# WORKER-WEBSHARE-002 独立审查

日期：2026-09-18。当前结论：**通过，首审及聚焦发现均已关闭，可部署唯一授权实验实例**。下文保留各轮发现及对应历史基线。

## 范围与基线

对应 REQ-20 / AC-20、WORKER-WEBSHARE-002。源码基线 `13c8de151b66f24cb730824916f38ee644a226b3`；只审查独立 oneapi-webshare-test 的完整 AccountService 接入、Webshare HTTP/TLS 传输、限定发布脚本和相关测试/契约。未读取真实 .env、账号数据库、Cloudflare token 或秘密值，未在线拨号、部署或修改实现，未覆盖其他产品和旧维护队列。

首审文件 SHA-256（最终变更指纹见聚焦复核）：

| 文件 | 指纹 |
| --- | --- |
| experiments/oneapi-webshare-worker.ts | 6248bc30918eb49057fe41170860e4beba3495466dba82ae7b97e9b9ff845ac4 |
| experiments/webshare-fetch.mjs | 9081d7705a616804881379c2a5d233c1e1c1cacd2633e8368d22cb7f753b168e |
| experiments/webshare-tls-transport.mjs | 395d2348330a7e8f20098d640510d9165a8f607937a9c321d6c7a3ee017f3dee |
| scripts/deploy-webshare-app.mjs | 12d9de98c5158e633b1d2afc8360030e1a6c991fce3cd788d690e2c64b89dc67 |
| wrangler.webshare-test.jsonc | f309d4dd0a60a1369ce2b325c7169a8875b2c1fbe0e16fd919d97a054eb7c0a5 |

R2 依据成立：新云端账号持久化及代理内敏感凭据传输，TLS 错误可能暴露 token，部署时改变加密 key 可能使已有账号密文不可解密。

## 一轮汇总问题

1. **P1：缺失本地秘密文件时，重复发布会无条件换掉已有实例的加密 key。** `scripts/deploy-webshare-app.mjs:55` 捕获 ENOENT 后重新随机生成所有 key；`:79` 的 secret bulk 无条件上传。只要本实例已完成授权而忽略的本地文件丢失，重跑发布就会覆盖 TOKEN_ENCRYPTION_KEY，现有 DO 凭据无法解密，违反任务“不换 TOKEN_ENCRYPTION_KEY”的明确契约。首次初始化应受线上应用/本实例 namespace 的存在状态约束；已有账号实例时禁止缺失原 key 或与可信发布指纹不匹配的 key 上传。增加不读取真实 key 的纯 fixture，证明已有实例时拒绝重建/替换，初次创建和原 key 重用仍可用。
2. **P2：任务的“无重试”与复用 AccountService 的现有规则冲突。** 任务第11行禁止重试，但 `src/account-core.ts:1726` 后的模型读取及 `:1999` 后的生成遇401会刷新本实例凭据并最多重发一次。新 HTTP 传输自身确实不重试。应将契约改为“无传输自动重试；保留已有 AccountService 的一次鉴权恢复/重发与设备码轮询规则”，明确不会复制或刷新原实例凭据，无需改变既定服务行为。

## 验收覆盖与证据

独立执行：`node --test scripts/test-webshare-worker.mjs scripts/test-webshare-models.mjs scripts/test-webshare-tls.mjs scripts/test-webshare-fetch.mjs scripts/test-webshare-app.mjs`，**29/29通过**。无真实账号请求。

覆盖实际随机端口 CONNECT → TLS1.3 → HTTP chunked 首事件提前交付及取消；正常 TLS 与不可信 CA、SAN 不匹配、过期 leaf、缺失 CertificateVerify 的拒绝；协议/套件限制；HTTP 字节长度、截断、重复长度、TE/CL歧义和CRLF拆分；消费者pull、独立请求取消和abort；实际完整入口的隔离SQLite DO、未鉴权401、管理员登录cookie、未连接状态、CSRF403、禁用导入404；配置拒绝旧产品name、routes、其他服务/namespace及旧域名。

源码核验：官方设备授权、换票、刷新、models、usage与生成均通过同一注入出站；固定HTTPS目标/方法/查询在拨号前拒绝，CONNECT只有代理认证，账号和POST正文在严格TLS成功后发送。CertificateVerify强制补丁保持既定指纹，证书AIA不扩展网络目标，生产不注入fixture CA。HTTP/TLS泵有增量背压；gzip/deflate解压后另施加2MiB/64MiB限制；abort和取消清理本请求隧道。无跟随重定向、凭据正文日志或原始异常回执。

发布配置精确限定 account/name/main/origins/空routes，DO绑定仅本Worker新WebshareAccount，迁移仅新增自己的SQLite class，不引用现有service/namespace。无 ACCOUNT_IMPORT_SECRET 配置；Node主交付和原产品不在变更范围。

秘密值审计及真实资源盘点由实现会话执行并报告，不因审查未读取真实秘密而伪称独立重做。真实设备授权、目录和生成尚未完成，不能以本地fixture或health推断上游可用。部署后的原产品盘点、真实授权及最小两协议生成、测试key/session清理仍是发布验收门槛。

## 状态与恢复

首审时尚未部署；当时要求两项问题修复后由同一实例聚焦核验原问题及相邻发布/凭据边界。当前关闭情况见最后一节。

## 聚焦复核1（2026-09-18）

原P1/P2已关闭：prepare()先只读精确本script settings/namespace；已有namespace或云端指纹时，缺少原秘密文件、缺少指纹、任意实例key不匹配均在上传前拒绝。云端变量只保存高熵三key组合SHA256，不保存明文。初次probe无namespace/指纹可初始化。独立执行 test-webshare-app.mjs，3/3通过；任务已准确区分传输无重试与AccountService既有一次鉴权恢复规则。

新增固定实例verify脚本只访问oneapi-webshare-test精确origin；不复制原refresh token，设备授权由官方页面完成；SDK maxRetries=0，最多一个模型目录逻辑请求及两个生成逻辑操作，临时API key和管理session在finally清理。未执行真实请求或读取秘密文件。

**相邻发布证据回归待修复（P2）：** app-before.json含8个Worker，包括授权修改目标oneapi-webshare-test，但inventory()比较before.workers所有条目的etag/modified_on并要求无变化。部署本资源后会必然把自身的正常变化当作其他产品变化而失败。必须只排除唯一授权目标，保留原7产品严格比对；纯fixture证明目标变化允许、任一其他产品变化拒绝。此时结论仍不通过，仅需聚焦此比较逻辑，不重复TLS/HTTP检查。

聚焦代码指纹：deploy-webshare-app.mjs b7533709415ad3c5f31dda249a30b9c9a8a820b80a6011c546e7266f3fc396c3；verify-webshare-app.mjs a4aee1d1ca0906d54ed7962ccb555be869dbeac14550fc3e99bb52cd09238bff；配置79dc3f94c51c1f06d913691e9da771f021938a86a76ba28b109a2b9f5b9ab2c7。

## 聚焦复核2：最终结论（2026-09-18）

**通过。** 最后相邻发布比较回归已关闭：compareExistingWorkers只排除精确授权目标oneapi-webshare-test，其他Worker仍检查存在性、etag和modified_on；inventory记录的比较数量也排除本目标。独立运行 `node --test scripts/test-webshare-app.mjs`，4/4通过，证明本目标正常变化允许、任一其他产品变化或删除拒绝，同时重新覆盖配置门禁、密钥连续性和实际隔离DO鉴权。未变TLS/HTTP沿用首审29项中的适用证据，总体31项覆盖，不冒认重新全跑。

最终发布runner SHA-256：bcec7229614903afcb1023d41a55870ebdb0af44e99be4628dd2e6e41d71992e。其他聚焦文件指纹及敏感scope保持聚焦复核1记载。

无剩余可执行审查问题。当前结论允许只发布oneapi-webshare-test；本报告不证明真实上游设备授权、模型或生成已完成，也不授权修改其他产品。实现会话仍须执行最终秘密审计、精确发布版本回读、以实际app-before基线核对原7产品/域名/namespace及固定实例在线冒烟。官方设备授权需要用户完成；真实模型与最多两种生成逻辑操作及临时key/session清理后才能宣告相应线上能力验收通过。既有401一次鉴权恢复规则已明确保留。
