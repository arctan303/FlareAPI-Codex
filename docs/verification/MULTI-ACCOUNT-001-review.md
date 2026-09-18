# MULTI-ACCOUNT-001 独立审查

日期：2026-09-18。fresh reviewer未参与实现。基线 main / 09cde6b987e139045db3d03d0eeb85e1afbae108。

范围：DEC-016 / REQ-24 / AC-24多账号注册表、授权/刷新、默认切换、请求与流式生成保护、Node迁移白名单、后台和相关文档；含scripts/test-migrate-server.mjs。LOCAL-CLEANUP-001、已有batch修改不纳入。

风险：R2，多套敏感凭据、refresh token轮换与默认身份切换。仅授权本地实现/验证/审查，未授权新功能推送或部署。本审查不读取真实凭据、不访问生产、不作真实生成。fixture使用合成JWT及临时SQLite/mock HTTP，没有RSA验签；此前Access任务的RSA测试不属于本次证据。

最终结论：通过。MA-01与MA-02均已实质修复并由同一独立实例聚焦复核关闭，无剩余可执行问题。此结论只覆盖本地实现，不代表已推送、部署或真实多个账号线上验收。

## MA-01：并发重复刷新（已关闭）

首审src/account/auth-manager.ts的refreshCredentials在refreshPromise判空后await currentGeneration，两个请求可能越过判空而各自使用同一refresh token；第一个finally还能清空第二个实例的锁。真实轮换可能停用可用账号或丢失正确轮换结果。该窗口在基线已有，但属于本次刷新竞争验收范围。

独立隔离复现：默认a过期，同时/v1/models与/admin/usage，holdRefresh等待30ms再释放，观察/oauth/token2次、两个状态200，期望1次的断言失败。临时测试已删除，没有修改实现。

修复将读/判断/刷新完整流程在第一次await前同步建立共享Promise，finally仅清除自己持有的running。主会话受控generation读取等待测试修复前亦失败（2次），修复后本实例独立多账号13/13通过。原重复刷新窗口已关闭。

## MA-02：普通读取吞掉并发强制刷新（已关闭）

MA-01修复后，refreshCredentials(false)在尚未到刷新期时也无条件建立共享Promise，读取后直接返回旧凭据。紧接的refreshCredentials(true)仅复用该Promise，没有将force意图传入普通任务。这是本轮修复新引入的相邻回归。

独立复现：未过期fixture账号上同时启动普通与强制调用，等待两者完成；/oauth/token0次、两者version1，期望强制调用刷新一次的断言失败。临时测试删除。实际上游401后的强制重试与另一普通模型/额度请求读取重叠时，会复用已被拒绝token重试，可能把本可刷新恢复的账号停用。

建议共享任务在due判断前接收force升级，或只读任务结束后仍保证单次强制刷新；不能吞force，也不能恢复MA-01重复消费窗口。补普通/强制并发、多个强制及强制途中普通调用的行为证据。

## 其他有效独立证据

- 首审多账号9/9，第一次聚焦复核最终13/13独立通过；相关tracked diff格式检查通过。
- Legacy凭据原样登记默认，不重加密；新增第二账号保留默认，相同身份授权不重复，重启保持保存记录与默认选择。
- 列表剥离credentials，不返回token；OAuth使用原加密密钥/AAD；UI身份数据用textContent。
- 同一既有key随A/B/A选择使用模型、额度及两生成协议实际账号头。切换清理模型/额度缓存，原缓存身份/代际校验仍有效。
- 请求计数覆盖模型、额度、诊断和生成准备；流返回后activeGenerations保留至完成。新版切换/移除在请求/刷新/流或pending授权时409，原请求继续，不调度到其他账号。
- 成功刷新原子同步活跃槽位/对应记录；失败或不匹配只停用当前记录。旧disconnect立即取消的兼容路径仅移除默认，其他账号保留。移除默认后不自动选择备份账号。
- 管理员认证、API key/匿名拒绝、同源写入、额外参数/未知ID拒绝保持；没有按key绑定或轮询。
- 复核新增损坏旧凭据管理员恢复、容量与同账号重新授权、实际Node存储导入测试。迁移脚本与KV导入同时保留saved-accounts-v1/active-account-v1。
- scripts/test-migrate-server.mjs新增测试调用实际构建迁移入口，比对两账号/默认，源库哈希不变且第二账号refresh token不以明文出现，范围合理。

## 文档、剩余验证与恢复

第一次聚焦复核确认ProductSpec替代DEC-001并明确REQ-24；任务移除待确认临时建议，区分有效用户决定、本地实施/验证及未发布。旧disconnect立即取消的兼容例外已明确，新指定ID DELETE要求空闲，没有文档矛盾。

主会话报告Node64/64、Worker95/95、typecheck、构建和产物/迁移5项通过；未冒认为本审查独立执行。本地桌面/390px按钮流程模拟通过，不声称已完成真实多个账号授权或生产验收。真实凭据/生成/部署不在授权范围，未执行不阻塞本地实施。

最终关闭证据：refreshTask同步共享完整读取/判断/刷新流程，并记录是否真正进行OAuth。force共享到no-op读取时，等待原任务结束后启动或加入一次真实force刷新，不依赖force必须先于due判断到达；任务持有者finally只清理自己的实例。共享实际OAuth失败会原样向等待者传播，不重新消费旧refresh token。独立再次运行multi-account最终14/14通过，含MA-01受控并发和普通读取+两个强制调用只发起一次OAuth、version2及轮换refresh token持久保存。原问题与相邻回归关闭，复用其余有效首审/复核证据。没有更换reviewer或忽略失败。

第二次聚焦复核仅针对MA-02修复、MA-01单次刷新与共享任务ownership，未扩大审计。最终任务/DEV-PLAN记录两问题失败前与修复后证据，主会话报告Node65/65、Worker95/95、typecheck、重建/迁移5项与秘密匹配0；这些属于主会话证据，不冒认为独立运行。已完成审查状态可由主会话同步到当前任务/需求/计划。真实多个账号授权、长期token轮换及线上升级仍未执行；没有本次发布授权，实际下一步为交付本地实现与说明，发布需依当前用户指令处理。
