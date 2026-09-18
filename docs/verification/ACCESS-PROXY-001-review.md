# ACCESS-PROXY-001 独立审查

日期：2026-09-18。审查者：fresh reviewer 子会话，未参与实现。

范围与基线：`main / 8df396c62035f59379f3f9757558dec13ee3c3ee` 上本次 Access/Webshare 修复、隔离集成测试、`v0.2.0-dev.5` 版本及发布说明；另包含 `scripts/test-server-artifact.mjs` 的一行页面品牌断言更新。LOCAL-CLEANUP-001 与已有 batch 修改不纳入本轮，也未覆盖。

风险及依据：R2。管理员 JWT 验签依赖的公钥读取改变出站路径，必须确保既有认证检查继续生效、直连目标有限且不泄漏认证信息，同时保持 Codex 必须走代理的规则。

结论：**通过**。未发现需修复的可执行问题。此结论是当前相关代码与本地行为的独立审查，不代表已发布或真实 Access 浏览器登录已验收。

## 验收覆盖与独立证据

- 独立运行 `npx vitest run --config vitest.node.config.ts test/access-webshare.node.spec.ts`，退出码 0，1 个文件、6 项全部通过。测试使用临时 SQLite、现场生成的 RSA 密钥及 fixture 代理，未读取真实凭据或触发云端写入。
- 已启用代理与 `requireProxy: true` 但无节点两种情形：合法 RSA 签名 Access JWT 能返回认证 session，并访问管理员配置接口；公钥走 directFetch，代理回调不被调用，公钥缓存复用一次请求。
- 错误 AUD、过期及损坏签名不能访问管理员接口（401）；session 显示未认证。源代码核验 `src/access.ts` 的 RS256/kid/typ、精确 issuer、AUD、exp、nbf、RSA JWK 和签名检查未修改。`auth-manager.ts` 的配置 revision 再核对亦保留。
- 直连条件限制为合法单标签团队域名 `*.cloudflareaccess.com`、HTTPS、标准端口、固定 `/cdn-cgi/access/certs` 路径的 GET，拒绝 query/fragment/userinfo；相似恶意后缀、团队子域、HTTP、异常端口、其他路径/query/POST 均未进入新增直连分支。显式 `:443` 被 URL 标准化为标准端口，符合契约。
- 请求重新构造，仅保留 `Accept: application/json`。Authorization、Cookie、Access JWT 等秘密头没有被传给公钥服务；强制 `redirect: manual`，302 无法产生已认证 session，并返回 `access_jwks_unavailable / 503`。取消信号传递给新请求并能被后续 abort 触发。
- `timedFetch` 仍在出站请求外围执行；Access 调用保持 5 秒超时和 64 KiB 上限，公钥解析还有独立 64 KiB 限制。新直连分支既没有跳过该包装，也没有改动验签器对非 200 响应的失败处理。
- Codex 用量请求保持调用原 proxyFetch；`experiments/webshare-fetch.mjs` 的 OpenAI 固定目标、路径、方法和 query 白名单未变。新增分支在代理状态读取之前执行，公钥获取无需可用代理节点。
- 实际 FlareAPI Worker 入口 `experiments/flareapi-worker.ts` 使用同一 WebshareSettings，directFetch 为原生 fetch，bootstrap 为 null 且 requireProxy 为 true；`wrangler.flareapi.jsonc` 的 ACCOUNT/WebshareAccount、迁移和 ADMIN_API_KEY 要求无变更。通用旧 Worker 配置不是本轮发布目标。
- 页面产物测试原先断言 OneAPI，与既有 FlareAPI 页面不符；本轮仅改为精确现有 `<h1>FlareAPI 管理后台</h1>`，未降低独立安装、manifest 校验、启动/health 和管理员接口未认证401等其他门禁。

## 文档、关闭状态与缺口

`package.json` 与 lock 根版本同步为 `0.2.0-dev.5`，无依赖更新。任务与 release notes 明确本轮为恢复原 Access 行为，不改变账号、Team/AUD/策略、代理配置、DO 或 Secret；已分别记录验证、独立审查与发布状态，没有把预检误写为部署成功。

本轮没有剩余审查问题。主会话报告 Node 51/51、typecheck、Node/Worker 构建及 archive 安装测试证据；本审查没有重复声称这些是独立运行。构建产物品牌断言复跑、GitHub 推送/附件和 Worker 部署/readback 由主会话完成后原位更新任务及现状记录。

真实浏览器 Access 登录未在本子会话执行：按父会话限制不读取真实凭据、不写入云端，隔离测试不能代替 Cloudflare 应用策略、AUD 与浏览器会话的实际配置。发布后仍需在原域名重新进行 Access 登录，确认进入 `/admin/`；若失败，以本轮发布版本及请求状态为恢复基线，仅诊断尚未覆盖的边缘策略或浏览器路径。
