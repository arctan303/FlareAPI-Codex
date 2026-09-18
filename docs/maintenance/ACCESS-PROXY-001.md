# ACCESS-PROXY-001：Access 登录后的公钥读取修复

日期：2026-09-18。用户授权：修复 Access 登录后无法进入后台，并推送一个小版本。
基线：main / 8df396c62035f59379f3f9757558dec13ee3c3ee；已有 LOCAL-CLEANUP-001 及 batch 修改保留，不纳入此修复提交。
目标：启用 Webshare 节点或未配置节点时，合法 Cloudflare Access 令牌仍能完成验签并进入管理后台。
范围：WebshareSettings 的公钥请求出站选择、集成回归、v0.2.0-dev.5 版本及 GitHub 发布/flareapi Worker 更新。
非目标：不变更管理员口令、Access Team/AUD/策略、账号、代理配置、DO namespace 或数据库；不更新其他 Worker；不重复执行旧密钥迁移脚本。
依赖：现有 TLS 锁文件、GitHub/Cloudflare 登录、原 ACCOUNT 绑定和平台 ADMIN_API_KEY。

R2：改变管理员认证所依赖的公钥获取路径 → 需要证明无法绕过签名/issuer/audience/有效期校验，直连目标与重定向严格受限；发布前 fresh reviewer 独立核验。

## 根因与修复

Access 公钥读取使用通用 timedFetch，继而使用 Webshare proxyFetch；代理仅接受 OpenAI 固定路径，拒绝 cloudflareaccess.com，错误最终映射为 upstream_network_error / HTTP502。
公开团队公钥直接请求200；validateTarget 同请求报 outbound_target_rejected。
新增隔离集成回归在修复前5项中4项失败，包含启用节点时HTTP502、无节点时HTTP503。

修复仅将 HTTPS、标准端口、无用户信息/查询/片段、合法单标签团队域名的 GET /cdn-cgi/access/certs 请求走 native directFetch；请求仅携带 Accept，强制 manual redirect，继承取消信号。现有 timedFetch 的5秒超时/64KiB上限以及全部 JWT 校验保持不变。其他请求沿用既有代理路径。

## 验证与发布状态

实施：完成。验证：通过。独立审查：[通过](../verification/ACCESS-PROXY-001-review.md)。GitHub发布：[已推送并发布](https://github.com/arctan303/FlareAPI-Codex/releases/tag/v0.2.0-dev.5)，附件回下载校验通过。Worker上线：已发布并回读验证。
集成回归覆盖 Access session/管理接口、节点启用与未配置节点、错误AUD/过期/伪造签名、Codex保持代理、相似域名/子域/非HTTPS/异常端口/query/path/method拒绝直连、秘密头剥离、取消传播、重定向失败关闭。
验证命令：npm run typecheck 通过；vitest --config vitest.node.config.ts 全部51/51通过，原有 test/access.test.ts 9/9通过；TLS准备校验与Worker dry-run通过；Node build/package通过，独立payload和archive安装启动检查2/2通过。
发布产物：dist/oneapi-server-0.2.0-dev.5.tar.gz，119620 bytes，SHA256 28ff316ec7fa76ac090547636c99eb0ef962bd3f15adb60cf78555be4adf88e6。
发布检查发现旧 test-server-artifact 固定断言OneAPI与当前FlareAPI页面不符，仅同步这一行断言后2/2通过，不改变页面。
线上发布前对无权限伪造JWT请求 /admin/session，真实复现HTTP502 / upstream_network_error；不调用Codex。云端预检账号connected、3节点、Access启用，api.arcinks.com绑定flareapi，DO与仅三项平台绑定匹配。敏感基线保存在ignored output/flareapi/access-fix-before.json；不写入Git。
Worker发布采用 versions upload / versions deploy，只切换版本，不执行 triggers deploy，避免改变后台添加的域名和路由；依据 [Cloudflare版本发布文档](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/)。
Cloudflare旧OAuth直接API查询失效，Wrangler whoami已成功刷新现有登录，不修改线上策略。

## 线上验收与恢复

Worker版本60bcc6b6-be02-46ac-bf91-01a085aad3be，v0.2.0-dev.5，100%流量。发布前实际版本为79a703da-9d54-4996-9051-6d086ce7d66c（既有README版本信息滞后，以发布前API清单/CLI回读为准）。
同形伪造Access令牌上线前 /admin/session 为502，上线后200且authenticated=false；/admin/status 401 invalid_access_token，证明公钥读取恢复且未跳过验签。真实有效令牌进入管理接口由本地签名集成回归证明；浏览器运行时启动失败，尚未独立读取用户真实Access登录会话回跳，不能记为真人登录验收通过。
发布后账号/keys/Webshare/Access/origins状态逐项与发布前一致；domains及DO清单一致；其他9个Worker etag/modified_on未变。三项线上资产与本地SHA256一致。api.arcinks.com健康200，匿名/admin/login保持Access302门禁。
Ignored证据：output/flareapi/access-fix-before.json、access-fix-live-before.json、access-fix-after.json；不进入Git或安装包。源码与最终Worker/Node产物303文件、22项实际配置秘密值审计0命中。
回滚：wrangler versions deploy 79a703da-9d54-4996-9051-6d086ce7d66c@100 --config wrangler.flareapi.jsonc --yes（保持原DO与平台Secret），Git按修复提交回退；不要重生成加密密钥。

提交审计：285个索引文件实际配置秘密0命中、无私有runtime文件。启发式筛查唯一命中既有 scripts/test-webshare-tls.mjs 的 BEGIN PRIVATE KEY 标记，核验其来自现场生成ECDSA密钥的PKCS8导出/拼接，没有字面私钥，且与HEAD基线完全一致；人工分类为测试格式标记，未忽略实际秘密匹配或扩大白名单。未解决审计项0。

Git发布闭环：修复提交224f5d2，annotated tag v0.2.0-dev.5与main普通原子推送成功；GitHub预发布非draft，安装包及sha256附件uploaded。GitHub回下载、原始包与校验文件三方SHA256一致（28ff316ec7fa76ac090547636c99eb0ef962bd3f15adb60cf78555be4adf88e6）。回下载副本校验后删除，保留安装包与此记录。前轮LOCAL-CLEANUP-001和batch修改保持未提交，不归入本次发布。
