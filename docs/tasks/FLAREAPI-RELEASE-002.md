# FLAREAPI-RELEASE-002：单密码后台与测速上线

目标/来源：用户明确要求修改后台达到已确认效果，部署此前全新flareapi Worker、清理无关变量，并交付登录密钥和地址。授权只覆盖flareapi及它已有专属DO；不更新oneapi-webshare-test、独立诊断Worker或其他产品，不删除namespace/数据。

路线/规模/风险：产品变更发布、短任务，R2。原加密密钥从环境供应改为DO持久状态、清理原Secret可能导致旧密文无法读取；必须同一namespace连续性护栏、完整迁移后去除环境密钥验证、fresh reviewer审查发布脚本。复用FLAREAPI-CONFIG-001本地审查，不重复原实现审查，只覆盖发布迁移与本轮差异。

预期：后台保留Webshare key、同步/手选、独立TCP测速、测试启用固定节点；无默认代理，无自动启用/轮换。最终仅ADMIN_API_KEY Secret，ACCOUNT/ASSETS为必要平台绑定。登录密钥沿用既有active文件，不生成/轮换。内部密钥持久且原Webshare设置/账号/APIkeys保留。

发布步骤：只读核对账户归属、原key组合fingerprint和既有专属namespace17a8dd0ea83c47edbdbf94ce6c33c71c；记录所有现有Worker/域名/DO真实发布前基线。部署新版并保留原TOKEN/GATEWAY/PROXY Secret（Wrangler保留Secret，覆盖普通vars），GET配置触发原密钥验证和事务持久初始化，核对账号/节点/APIkeys连续性；成功后依次删除GATEWAY_API_KEY、PROXY_CONFIG、TOKEN_ENCRYPTION_KEY，每步验证。最终只ADMIN且原DO不变，实际登录/静态资产与鉴权校验通过，再提供地址和密钥。

范围外：不自动填用户Webshare API key、不将原bootstrap重新启用；若已有显式选择则保留。没有Codex账号时如实报告未连接，不复制旧实例账号。旧秘密local .legacy.json保留用于恢复，不上传为新变量，不在证据打印实际值。仅清理指定Worker已知多余变量。

验证：密钥迁移到持久DO后删除全部legacy绑定，重启仍读取同一密文；错误迁移不改数据；发布guard禁止错误namespace/目标/额外资源；针对性测试与strict入口检查、最终秘密审计；线上配置/鉴权/账号状态/APIkeys连续性与资产哈希；资源隔离回读。后台测速无节点时验证明确错误而不是套用默认节点；若用户已配置有效节点则测其手选节点而不切换。

状态：实施/验证/发布前fresh R2审查通过，真实发布、持久迁移、变量清理与上线回读完成。验证脚本请求格式修正后的聚焦审查通过，文档时间歧义关闭；见[独立回执](../verification/FLAREAPI-RELEASE-002-review.md)。生产代码未因该修正变化。此任务替代单密码任务先不部署约束及当前local runner禁部署状态；原历史验证不改写。
实际结果（2026-09-18）：
- 真实版本b72a7840-7d5f-4fb8-8325-5900ee7e9176 100%，地址https://flareapi.12213443th.workers.dev/admin/login 。初次代码版本9a152972-41fa-4ea6-8f18-af65e0252ccb，三次旧Secret删除后最终版本以部署API回读为准。
- 账户归属/原组合fingerprint/ADMIN未轮换/原namespace验证通过。当前云绑定只有ACCOUNT、ASSETS、ADMIN_API_KEY(secret_text)，普通变量0，旧GATEWAY/PROXY/TOKEN已删除。阶段一保留四项Secret、先持久迁移再删除TOKEN，每步重新读取账号/节点/调用key通过。
- 真实登录200、Cookie配置读取200，独立测量能力true，匿名测量401、无效节点400、CSRF403；三项静态资产SHA256与本地完全一致。connectedfalse、nodes0、activeSourcenone、真实创建APIkeys0（旧列表1项是legacy环境虚拟key，按契约停用，不是用户创建key丢失）。没有实际代理/模型请求，不宣称主DO真实测速或Codex已连接。
- 原9个其他Worker etag/modified_on无改动、域名/子域/所有DO完全一致。output/flareapi/release-before.json、release-preflight.json、release-checkpoint.json、release-live.json脱敏证据。
- 发布前审查发现当前安装Wrangler仅keep-vars=false不会保留未声明旧Secret；修复为同时传仅原ADMIN的--secrets-file以开启keepSecrets，云设置在snapshot前assertMigrationBindings；审查通过后才发布。
- pure发布护栏/实际旧bundle→新版带TOKEN→仅ADMIN重启保持密文与创建keys/登录验证3项测试通过。关键密钥/取消流/测速12Vitest通过，main/Worker strict类型和真实发布参数dry-run通过，bundle1188.78KiB/gzip336.56，实际秘密13文件匹配0，TLS补丁校验通过。
- 初次上线验证匿名POST测速与DELETE退出缺Content-Type，被既有JSON网关正确返回415，finally错误遮盖首个检查失败。仅修正验证helper，加完整Miniflare行为回归；后续登录/退出/资产检查全部通过，未重复部署/删除。首轮Cookie未保存且进程退出，仅不可使用孤立会话摘要按既有7天TTL到期；后续测试会话成功删除。不宣称首轮摘要已清理，不清除用户会话。生产鉴权规则未改变。

恢复/下一步：用户登录设置自己的Webshare key并同步节点，手选测速/测试启用，再连接自己的Codex账号。内部密钥已存原DO，后续发布沿用ADMIN即可；legacy备份保持用于必要回退，禁止删除DO或生成替代存储密钥。release-flareapi是旧状态一次性迁移发布，不重新跑旧fingerprint预检；失败恢复先核对checkpoint/cloud绑定，禁止重复生成或上传key。回滚旧版本需恢复旧Secret供应，不能仅回滚到依赖TOKEN的旧代码。