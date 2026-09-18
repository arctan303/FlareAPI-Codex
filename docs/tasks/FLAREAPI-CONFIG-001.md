# FLAREAPI-CONFIG-001：单密码、无默认代理（已发布）

来源/目标：用户明确只保留登录密码，取消默认代理；后台输入Webshare key、获取节点、选择后启用；先本地修改，不部署。范围只为FlareAPI Worker，Node与原oneapi-webshare-test运行时兼容保留。

路线：产品变更+短任务。修改Worker入口、加密密钥持久初始化、Webshare无默认出口、配置与本地准备脚本。风险R2：密钥位置与内部控制路由改变可能导致数据解密失败/越权；需密钥生命周期、鉴权/Host/CSRF/取消流测试及fresh reviewer独立审查。规模不需要Phase。

有效契约：
- 用户唯一输入ADMIN_API_KEY。ACCOUNT/ASSETS为平台绑定；非秘密的可信origin编译进产物，不从客户端Origin/Host/转发头学习，也不再显示为运行时变量。
- 加密密钥首次随机生成，事务持久在专属DO的私有状态；独立于管理员口令，重启、换口令不会重置。不向任何后台API暴露。密钥与密文在同一DO内，依赖存储访问隔离，不承诺完整数据库副本仍不可解密。
- 已有加密数据须原密钥验证后持久迁入；无原密钥、错密钥或坏状态失败关闭，不重写旧数据。当前原秘密只保存到git忽略的.env.worker-flareapi.legacy.json供恢复，实际持久迁移见FLAREAPI-RELEASE-002；不写入产物/示例。
- 停用环境全局调用密钥，仅使用后台创建的API key；管理口令不能调用/v1。
- 不读取/继承PROXY_CONFIG默认代理；后台已有显式选择的节点保留，新实例/旧bootstrap状态均无启用节点。填key和同步不会自动启用节点，必须选择并通过连通测试。无节点/关闭后上游调用报配置错误，不默默直接或套用旧代理。固定节点不轮换。
- 原测试Worker保留原bootstrap/direct兼容行为，Node接口不变。

授权/非目标：最初只本地编辑/验证；后续用户明确授权按FLAREAPI-RELEASE-002更新既有flareapi、迁移及清理变量，现已完成。其他产品、数据与namespace不删除。原47d版本为历史发布事实；本地prepare runner仍不执行外部动作，新的一次性受控release runner已验证发布。

验收：配置/active秘密文件只ADMIN；本地运行仅ADMIN可登录/设置/创建调用key；无默认节点；后台key→同步→选择→测试启用；关闭后停止上游；重启及口令更新保持密钥和节点；错误迁移无数据改写；Host/CSRF/匿名鉴权/内部路由拒绝，流取消清理；秘密审计无真实凭据。

状态：实施、针对性验证、独立审查完成；发布与迁移后变量清理完成，见FLAREAPI-RELEASE-002。线上原多变量事实与新本地契约分开记录，不改原部署历史。承接并替代FLAREAPI-001本地四secret/默认proxy契约；保留线上版本与原测试实例历史。
验证证据（2026-09-18）：
- 主 TypeScript 检查与 Worker 入口 strict 检查通过；public/app.js 语法检查通过。
- Worker dry-run 输出 output/flareapi/single-dist/flareapi-worker.js，仅ACCOUNT/ASSETS平台绑定，无运行时vars；1185.94 KiB，gzip335.97 KiB。没有外部发布。
- Vitest：flareapi-key 5、flareapi-settings 2、webshare-settings 6、webshare-api 6、flareapi-boundary 2，共21项通过。覆盖密钥并发初始化/持久化/迁移失败保护、显式启用/关闭、旧运行时兼容、流取消与内部控制。
- node --test scripts/test-flareapi-worker.mjs：2项完整Miniflare SQLite Worker测试通过，只有ADMIN配置；验证登录、匿名/调用key隔离、Host/CSRF、Webshare key保存/同步、重启和换密码后保留数据，以及runner拒绝部署。外部Webshare API使用模拟响应。
- 本地模拟浏览器：只ADMIN登录→保存fake Webshare key→刷新节点→选择仍未启用→关闭反馈正确；1280与390宽度无横向溢出，手机截图字段及反馈可读。截图output/playwright/flareapi-single-desktop.png、flareapi-single-mobile.png。隔离fixture仅模拟Webshare列表；未进行真实代理连接。
- 本地prepare真实秘密匹配审计：output/flareapi/single-audit.json，12项源码/资产/bundle匹配0；TLS补丁哈希通过。
- fresh reviewer通过，见 [独立审查](../verification/FLAREAPI-CONFIG-001-review.md)。两项发现（关闭反馈、当前README与旧部署记录歧义）已修复关闭。

恢复/下一步：单密码和测速已上线，原密钥已验证迁入私有状态，旧变量清理后仍可读。legacy备份保留用于恢复；用户填自己的Webshare key同步/选择启用，再连接Codex。主应用尚无节点，不宣称主DO实际TCP排名或模型成功；发布证据见FLAREAPI-RELEASE-002。
后续本机节点测试（2026-09-18）：用户要求试测速。未部署、未切换线上出口；使用显式HTTP代理与无账号认证Codex模型GET，清空子进程HTTP_PROXY/HTTPS_PROXY/ALL_PROXY环境，不改系统/TUN。三条既有代理各最多3样本、连续2失败提前停止；实际各2样本全部curl56连接/接收重置，TLS未完成、无目标HTTP状态，不能形成有效延迟排名。脱敏结果output/flareapi/local-node-latency.json。外层系统代理影响尚未排除，不据此宣布节点失效。该次本机测试时线上只有测试并启用入口，不支持不切换出口的独立逐节点测速；该次没有实施或部署独立入口。现已由FLAREAPI-RELEASE-002上线独立测速，账号DO真实排名待用户配置节点后测量。