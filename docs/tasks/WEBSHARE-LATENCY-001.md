# WEBSHARE-LATENCY-001：账号 Worker 到 Webshare TCP 测速

来源：用户纠正测速方向为Worker到Webshare，明确要求试测。前轮本机HTTPS结果无效，不作为本需求证据。

路线/规模：产品变更、短任务，复用product-spec-builder/dev-builder。R1：新增既有管理员权限下的有界TCP诊断，仅允许最新已同步并有效的公网节点，无自定义地址、不改鉴权/存储密钥/当前出口；针对性测试覆盖目标限制、超时清理与状态不变。没有阶段依赖，不建Phase。

目标：在账号DO内部对手选节点测3次TCP连接建立耗时，显示成功次数及成功样本中位数；测的是DO→Webshare代理地址，不连接Codex、不发送代理/账号认证，不等于ICMP或模型首字延迟。每样本3秒超时，连续调用10秒冷却，始终关闭socket，拒绝并行设置操作。测速不启用、关闭或切换出口、不写设置，失败不伪造延迟。UI单独“测速”按钮，结果简短，节点可逐个比较。Node与旧Worker缺测量依赖时不展示按钮。

范围/授权：用户后续明确“先落地能力，然后部署测速的worker，进行测速”。后台能力本地实现；仅新增flareapi-latency-test诊断Worker并真实测三条既有节点，不更新主flareapi或原实验实例。诊断实例直接在其边缘执行TCP测试，复用相同测量模块，无DO/资产/自定义域名绑定，不发送Webshare凭据，仅随机PROBE_KEY保护并限时；本地后台执行位置仍为账号DO。原local-node-latency仅本机失败现象。

验收：3样本中位数与失败计数正确；超时/同步连接失败关闭socket且隐藏错误内部详情；未同步、无效、私网节点不能拨号；仅管理员、同源校验延续；测速前后设置密文/启用节点不变；页面有独立测速且不调用apply；可构建且实际秘密审计0命中。

状态：本地实施/针对性验证/diff自查完成；独立诊断Worker已部署并实测。R1不派遣独立reviewer。后续FLAREAPI-RELEASE-002已发布主FlareAPI后台能力；主应用节点0，尚无账号DO实际测量样本，本任务真实结果仍仅诊断Worker的SIN边缘位置。
交付/证据：
- 新增src/runtime/worker/webshare-latency.ts，/admin/webshare/measure管理员接口与独立测速按钮；只有新FlareAPI依赖支持按钮，原Node/旧Worker兼容隐藏。后台填key→获取节点→手选测速/启用流程保持。
- Vitest 13/13：测速5、既有Webshare设置6、无默认代理2。两个入口strict检查、主tsc、app.js语法与diff格式通过。
- 专用测试Worker Miniflare +部署护栏2/2；主FlareAPI单密码完整集成2/2。专用bundle6.31 KiB/gzip2.50，无平台资源绑定；主应用仅本地dry-run1188.78 KiB/gzip336.56。
- 实际秘密审计专用7文件匹配0，不上传Webshare凭据；主应用审计新增模块，13文件匹配0。PROBE_KEY只在ignore .env.worker-latency.json，不回显；ADMIN active文件不变。
- 2026-09-18T05:57:17Z，https://flareapi-latency-test.12213443th.workers.dev ，版本339f3ec8-d7ce-4b46-bcc2-74fc4db42055。请求cf.colo=SIN（新加坡），无Placement设置，三条节点各3/3成功：9.142.39.218:7388样本174/175/171ms，中位174；138.226.61.165:6338样本178/175/173ms，中位175；9.249.18.109:7343样本234/239/226ms，中位234。无需凭据的TCP握手，不证明代理认证、Codex连通或模型生成。前两个差1ms，单轮不足以分胜负。
- 发布后9个已有Worker etag/modified_on不变，域名/子域与全部DO不变，只新增专用Worker。结果output/flareapi/worker-node-latency.json，资源隔离latency-isolation.json，审计latency-audit.json。
- 初次自动审批认为密钥目标账户归属未验证而拒绝；官方只读/user与/account核验当前用户12213443th@gmail.com及账户ed6c2f7b12e4f0659cf8b70077fa649b，与用户截图和既有flareapi账户一致后，重新审批获准。首轮secret bulk创建本目标成功、代码CLI退出非0；未重写secret，后续同一目标CLI部署成功并回读隔离。没有绕过审批或改其他资源。
- UI浏览器首次进程退出属宿主中断，无有效截图；核对后仅一次短恢复。最终模拟测速结果48ms展示在下拉节点及反馈，保持选择、未启用出口，measure1/apply0；1280/390无横向溢出，手机截图可读。截图output/playwright/flareapi-latency-desktop.png与mobile.png。UI返回值模拟，不混入真实Worker结果。

恢复：专用/measure认证保护，编译到期时间1789714362846，超时410；health可读取到期时间。该地址是诊断API，不是FlareAPI后台。当前诊断部署runner拒绝覆盖任何既有目标；重复实测须在有效期限内调用专用接口，部署后的key保留，不再生成/上传。到期后保留报告；回滚只针对本新Worker且需删除授权，不动其他产品。该次独立诊断部署没有处理主应用旧密文迁移，也不构成迁移授权；后续用户明确授权FLAREAPI-RELEASE-002，现已完成主应用持久迁移及发布。