# MULTI-ACCOUNT-001：保存多个 Codex 账号并切换默认

日期：2026-09-18；产品变更，短任务，R2。基线：v0.2.0-dev.5 / main 09cde6b987e139045db3d03d0eeb85e1afbae108。

## 目标、决定与范围

用户有多个自有账号，切换需要反复连接；已明确回复“对的”，确认保存多个账号、后台手动切换默认，现有 API 密钥跟随默认。有效契约：DEC-016 / REQ-24 / AC-24，替代DEC-001单账号限制。

复用官方设备码、单管理员、原生后台、Node/Worker共同服务和现有SQLite/DO存储。最多32个账号；不增加按key绑定、自动轮询/故障切换、配额规避、多人注册、角色、计费、导出凭据或代理自动轮换。用户在本地完成及独立审查通过后回复“嗯”，明确授权本次新小版本推送及部署到现有FlareAPI Worker。限定更新flareapi，保留原账号、API密钥、代理、Access、域名与存储；不修改其他产品。

## 预期行为

- 首个官方授权账号成为默认；添加其他账号保留原账号和默认选择。相同账号重新授权更新已有记录。
- 后台列表有邮箱/身份提示、套餐、默认标识及需要重授权状态，可设为默认及确认移除单个账号。退出后台不影响账号。
- 所有现有调用key、模型目录和两种生成接口使用默认账号。切换后清除测试对话、旧模型和额度显示。
- 切换及新版移除要求当前请求/流式生成/刷新空闲，忙时409，不中断生成、不自动重试到另一个账号；待完成设备授权须先完成或取消。
- 移除默认后没有默认选择；其他账号保留，须管理员显式选择。旧POST /admin/disconnect保留立即中断请求/设备授权的兼容例外，仅移除默认账号。
- 凭据加密、不向页面回显；刷新成功原子同步轮换凭据，失败只停用对应账号。过期access token在使用时按已有规则刷新，不把已保存宣称为永远有效。

## 实施与依赖

`src/account/account-registry.ts`保存加密账号索引和默认标识；沿用credentials活跃槽位和现有加密密钥，不新增Secret。旧单账号首次启动登记默认，不重加密原凭据；损坏旧凭据保留管理员恢复授权入口。

AuthManager的写入、导入、设备换票、刷新及停用同步索引。设备授权代际与当前账号代际分离，新增账号不会使原账号刷新结果过期。AccountService的账号操作计数与生成生命周期防止切换竞争，授权查询保留原单次共享行为。Node迁移同时保留索引和默认选择。

依赖现有官方授权协议与存储事务。新增真实账号仍须用户在官方页面操作；本次测试仅fixture模拟，不复制其他部署可轮换refresh token。

兼容/回滚：完整备份同版本存储，恢复代码及完整存储一起回退。旧程序只懂默认credentials，不允许把旧程序继续写入后重升级视为安全多账号兼容；不得删除新增账号冒充回滚成功。

## 风险、验证与证据

R2理由：新增多套敏感凭据和账号选择 → 可能串用账号、覆盖轮换token、泄漏访问能力 → 核验加密/脱敏、旧数据登记/迁移、刷新竞争、实际路由、在途请求及权限，并使用未参与本次实现的fresh reviewer。

- `test/multi-account.node.spec.ts`：最终14/14针对性用例通过，包括双账号存储导入。实际A/B/A身份覆盖同一key的目录、官方用量及Responses/Chat，重启、重复授权、移除、匿名/API-key拒绝、跨站拒绝、容量、损坏旧凭据恢复和刷新竞争。
- 最终完整Node回归11文件65/65通过；typecheck及node --check public/app.js通过。
- 原Worker四文件首跑52例中发现2个授权共享/断开竞争兼容回归，已修复；gateway20/20通过。最终完整Worker回归9文件95/95通过。
- fresh首审独立复现MA-01：过期账号的模型与额度并发导致2次刷新。主会话加入受控generation读取等待，修复前同样失败（预期1次，实际2次）；现已在第一次await前同步建立覆盖读/判断/刷新的共享Promise，受控并发回归和完整两运行时回归通过，finally仅清除自己持有的实例。审查回执：[MULTI-ACCOUNT-001-review](../verification/MULTI-ACCOUNT-001-review.md)，最终聚焦复核通过，MA-01及MA-02已关闭，独立14/14通过。
- Playwright CLI隔离回环模拟实例：正常登录、按钮切换B、添加C后默认仍B、确认移除C及刷新后A/B保留、会话保持；390px document scrollWidth375，无横向溢出。桌面/手机截图已视觉检查，位于忽略的output/playwright/multi-account/。页面已有8条内联样式CSP警告和Node不支持Webshare配置的404，不是本次新增JS异常；未放宽CSP。

- `npm run build:server`与FlareAPI Worker deploy --dry-run构建通过；无平台写入。`node --test scripts/test-server-artifact.mjs scripts/test-migrate-server.mjs` 5/5通过，包含实际构建迁移脚本的双账号/默认标识/加密与源库不变，以及无node_modules产物启动。
- 复用秘密审计读取规则核验289个候选源码文件与18个Node/Worker构建文件：真实本地秘密匹配0，未打印值；回执在忽略的output/flareapi/multi-account-secret-audit.json。

- 第一次聚焦复核关闭MA-01后发现MA-02：普通未过期凭据读取与force=true并发，共享的无OAuth任务吞掉强制意图。修复前新增回归失败（预期刷新1次，实际0）；现按共享任务是否实际刷新区分，强制调用在普通读取结束后执行或共享一次真实刷新，finally仍仅清理自己任务。14/14、完整Node65/65、类型及重新构建/5项冒烟/秘密审计均通过，同一fresh reviewer已对这项实质修复聚焦核验并通过，无剩余可执行问题。
- SQLite-backed DO的当前每条键值合计2MB限制已查[Cloudflare官方限制](https://developers.cloudflare.com/durable-objects/platform/limits/)，当前实例使用SQLite后端；不混用旧KV后端128KiB限制。

## 状态与实际下一步

实施、必要验证、fresh独立审查及发布完成。MA-01/MA-02关闭，无剩余可执行问题；独立最终14/14通过。用户已明确授权推送及部署v0.2.0-dev.6；版本已上线，原账号及配置回读保留。实际下一步：用户在账号连接页面逐个添加账号并完成官方授权，点击设为默认选择使用。

保留此前docs/maintenance/batch.md和LOCAL-CLEANUP-001.md未提交清理记录，不纳入多账号成果。真实新增多个账号授权/调用尚未执行；升级后原单账号已无损登记并线上回读验证，本地模拟多账号调用不代替真实新增账号验收。
## 发布准备历史与授权（发布前记录）

用户在实现、验证及fresh审查完成后回复“嗯”，授权本次v0.2.0-dev.6推送与部署现有flareapi。使用release-builder，发布与审查状态分别记录；不沿用旧版本授权。

只读平台回读发现账户workers.dev子域名已改为arctan，当前线上341b0ac5-f3ad-48bf-8e08-ad8a9ab26714仍构建旧origin。下载线上代码SHA-256与dev.5已审查构建完全相同（7c1f1822e93ed0a3c6761100b7c79822d0852902dc0aa9a6851a3efcd0aadf77），不是其他未合入功能。先限定本实例origin对齐现有平台域名；原生产代码仅替换一个origin字符串，原三项资产无更新，不修改Access/域名/触发器。前置版本598eb036-d397-4dd8-90bf-10341abe47f5上线后只读确认connected=true、API密钥0项、代理3节点、Access仍启用，保存原状态供多账号升级逐项比对。仓库wrangler.flareapi.jsonc及部署辅助ORIGIN同步新入口，其余实例不改。

实际入口：https://flareapi.arctan.workers.dev/admin/login ，自定义域名api.arcinks.com及原ACCOUNT命名空间保留。域名配置属于本实例已变更平台地址的R1维护，严格host/同源鉴权实现不变，使用实际health和后续host拒绝检查核验。

最终产物：dist/oneapi-server-0.2.0-dev.6.tar.gz，122595字节，SHA-256 ff258d9e2878fc537cd62404a7c853699bb2478c831efd06a1f31906d278d54b。package.json及锁文件一致，无运行时npm依赖。
npm run build:server、package:server、test:release通过；实际归档在仓库外安装启动1/1通过。最终Worker新origin dry-run通过（1208.76KiB / gzip340.62KiB）；实际构建迁移/无npm产物5/5通过；候选源码290项、Node/Worker产物18项真实本地秘密匹配0。秘密仅本机忽略配置和平台已有Secret Store，不写入附件或发布说明。原R2代码及最终14/14审查基线未改；仅增加版本、发布记录及实例origin配置，复用65/65、95/95有效回归证据。

发布进行中：下一步暂存仅本任务文件，index秘密审计、提交标签与推送，再限定versions upload/deploy，线上账号/设置/资产及其他资源回读通过后创建GitHub预发布、回下载附件校验。失败保留实际checkpoint，不删除账号或伪装回滚；多账号升级后回退代码须配合同版本完整存储恢复。
暂存审计290项仅命中scripts/test-webshare-tls.mjs的PEM边界字符串；该文件与HEAD无差异，私钥每次由WebCrypto P-256 generateKey生成，再exportKey拼接，未包含字面私钥正文。已核验为既有测试fixture边界误报，未扩大忽略规则或修改审计。真实配置值、运行数据、二进制、token字面量无其他命中，git diff --cached --check通过。

## 发布完成与线上证据

代码提交768d5ee6f6e71b50fbbfd4ad753b67c4edf35137，注释标签v0.2.0-dev.6与main原子推送成功。最终Worker版本1949a90d-0b39-49c3-adb4-075698c1bfae，100%发布，部署cf332bc4-3800-4c12-b76b-6b1cfd576120。发布前曾观测到外部中间版本82ca6bf7-149c-41f7-bd07-7e3063258837，不推断其来源；以实际当前版本与发布前只读数据快照核验，不冒认其他部署成果。

部署后第一次立即回读收到403，平台传播后同一请求200，未修改账号或边界以绕过错误。线上状态、原账号身份/邮箱/套餐/token有效期/刷新时间与升级前完全一致；其SHA-256内部ID及默认指针匹配，列表仅1原账号且不返回凭据。API密钥列表、完整Webshare节点/当前出口、Access和网络origin配置逐项相同。匿名列表401、跨站激活403，未执行真实账号切换、移除、刷新或生成。三项资产远端SHA与本地一致，自定义域名health200。其他8Worker、所有域名、子域名和DO命名空间与多账号升级前基线无差异，原ACCOUNT绑定及唯一ADMIN_API_KEY保留。

GitHub预发布：https://github.com/arctan303/FlareAPI-Codex/releases/tag/v0.2.0-dev.6 。两项附件均回下载逐字节匹配本地；归档SHA为ff258d9e2878fc537cd62404a7c853699bb2478c831efd06a1f31906d278d54b，GitHub返回的digest一致。线上及附件脱敏回执在忽略的output/flareapi/multi-release-live.json和multi-release-artifacts.json；含账号元数据的before/after原始快照不提交或上传。

独立审查回执保留当时仅本地授权的事实，后续用户授权及线上证据由本任务记录，不改写为reviewer亲自验收生产。线上多个新增账号、长期轮换及真人Access回跳尚未独立操作，不能由本次原账号保留及fixture推断通过。回退需恢复同版本完整代码/存储，不删除账号索引；旧域名代码版本不可作为当前arctan入口的直接安全回退。此前清理记录仍单独保留未提交。
