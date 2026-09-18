# FLAREAPI-001：项目改名与全新 Worker

目标/授权：用户明确要求项目改名FlareAPI，并部署全新Worker，随机口令后交付地址和口令。保留原测试实例及其他在线产品；不改用户Codex配置或GitHub远端名称。

范围/预期：后台标题、桌面/手机品牌、包名称及当前说明入口采用FlareAPI；复用已经验证的固定Webshare代理Worker运行时，部署到独立flareapi.12213443th.workers.dev，仅workers.dev，无自定义域名/路由。新建自身SQLite DO和三项随机密钥，沿用已授权住宅代理接入；不复制原Codex账号/refresh token/会话/API key。API/header/SQLite加密AAD/脚本旧文件名保持兼容，不修改上游客户端标识。

依赖：WORKER-WEBSHARE-002、WEBSHARE-SETTINGS-001当前已验证运行时及严格TLS补丁；现有Cloudflare账号。规模：短任务；风险R1，品牌/实例配置改变，不改变鉴权或租户隔离逻辑，资源影响限于新名字的Worker与自身namespace。R2后端原证据保留适用范围，不把新部署冒写成模型通过。

验收：新实例名此前不存在；生成的管理员口令以ADMIN_API_KEY Secret存储；独立密钥与DO，后台/配置读取/新口令登录可用，新账号为空；线上品牌正确，匿名拒绝；所有既有Worker、域名及namespace相对本轮外部写入前基线不变；产物无实际秘密。

当前状态：品牌/配置完成；dry-run与精确目标保护验证通过；新实例已部署并完成脱敏回读，版本47d7b7e5-15bc-485d-89f9-3495f17251eb。三项线上资产200、SHA256与本地一致；新随机口令登录及会话200，临时测试会话已退出；配置读取200，匿名401；新Codex账号为空且三项密钥与原实例不同。新目标缺失时prepare只接受其精确settings路径的404，其他错误失败；已有namespace/指纹必须沿用原密钥。原Worker配置与秘密文件保留。验证/线上版本在回读后补齐。

恢复：原部署秘密现备份在被忽略的.env.worker-flareapi.legacy.json；未来迁移必须沿用原加密密钥，禁止为已有实例重生成。回滚品牌文件或只回滚flareapi版本，保留数据与秘密；不触碰原测试Worker。用户登录新后台后需要重新连接Codex。
验证证据：output/flareapi/app-before.json（首次外部写入前，8个已有Worker）；app-isolation.json（8个已有Worker无改动，域名/子域不变，既有DO不变，只新增flareapi_WebshareAccount namespace 17a8dd0ea83c47edbdbf94ce6c33c71c）；app-audit.json（14项源码/资产/bundle实际秘密匹配0，TLS补丁及精确配置通过）；live.json（品牌、密码登录、匿名隔离、独立密钥、空新账号、测试会话清理）。部署后Cloudflare OAuth刚过期401，经Wrangler只读自动续期后配置密钥连续性验证通过；未要求用户再次授权，未改云账号令牌内容。

后续决定替代关系：本地配置契约由 [FLAREAPI-CONFIG-001](FLAREAPI-CONFIG-001.md) 替代，改为仅ADMIN_API_KEY、无默认代理，active .env.worker-flareapi.json已收拢。原四Secret/三变量和默认代理仅是本任务记录的线上发布事实。后续FLAREAPI-RELEASE-002已更新线上至单密码/测速版本并清理变量，原密钥持久迁移通过；deploy-flareapi仍只本地准备，一次性发布改用release-flareapi。