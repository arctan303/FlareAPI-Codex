# WEBSHARE-SETTINGS-001 独立审查

日期：2026-09-18。当前结论：**通过，两项首审发现均已关闭**。下文保留首审发现及当时基线。

## 范围、基线和风险

对应 REQ-21 / AC-21、WEBSHARE-SETTINGS-001；基线HEAD为13c8de151b66f24cb730824916f38ee644a226b3。仅审查本轮Webshare官方API、加密设置、管理员扩展、实验Worker动态出站、后台卡片、发布审计和对应测试；未参与实现。Node未注入扩展，当前Worker优先只是任务记载的临时范围假设，不将其冒认用户最终选择。

R2依据有效：API key/节点认证及当前出口的敏感持久化、管理员新写入口、动态代理目的地址，若边界错误可能泄露秘密或扩大出站权限。

首审文件SHA256：api.ts 297730cc8f3ebe1db89b558c40b4118c294c6e77d7083e81af62f009928b8e5d；settings.ts 085505ae52007816542c28a1bcd9fde6f2e530a7261395e821078fc07d76f716；contracts.ts c2e712306daddf39439fb88534dee664e7fdb51f50aa6946e712eb4e896b2451；account-core.ts 5766950e75565a956e261a80528f56da6e5ca8ffa1e721c1d41dde3ddaa3aa31；oneapi-webshare-worker.ts 703fd4a9eb9d7fe044496bb2bb4f629fd40de20fdc29cf1de78c1f7379bb10a5；app.js cc71b980ab0ed27e4a1c42007a057a33da8395b4cbcd33303f84486f7cfa1ead；index.html 45b7e244fe42ac2bd0763fd3641f1354232e9b3bf2993e080bd3ae58c862f669；deploy-webshare-app.mjs fcdbaa33cf969b15f11fc2df945e5999347763e04c5d85678ba0aa3258099640。

## 一轮汇总发现

1. **P2：分页完整性没有核对，矛盾的count/next可覆盖旧完整列表。** src/webshare/api.ts:60只检查count为非负整数，:67遇next=null即返回。独立用全虚构响应 `{count:3,next:null,results:[一个合法节点]}` 复现成功返回1个节点；设置sync会把此结果保存并显示同步成功，违反“完整获取成功才保存、不返回部分页”。建议记录稳定且安全的总数、拒绝分页期间count变化、累计超过总数、结束累计不等于总数；异常仍保留原完整列表和active快照。补上述矛盾及跨页变化fixture。
2. **P2：仅公网IPv4的过滤漏掉非全球可达特殊地址。** src/webshare/api.ts:11未排除192.88.99.0/24，独立复现isPublicProxyIPv4(192.88.99.2)返回true。[IANA IPv4特殊用途登记](https://www.iana.org/assignments/iana-ipv4-special-registry)将该/32标记Globally Reachable=false，外层/24为已废弃6to4 Relay用途。建议明确排除此块并补边界fixture。未发现私网/loopback等已声明拒绝范围的其他具体放行，不将此问题夸大为已发生凭据泄露。

## 独立证据与已覆盖边界

独立执行 `node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts test/webshare-api.node.spec.ts test/webshare-settings.node.spec.ts`：11/11通过。独立执行 `node --test scripts/test-webshare-app.mjs`：4/4通过。针对上述两项的内存esbuild导入与虚构API返回复现，不调用真实API。

鉴权/CSRF：AccountService仅在既有管理员认证成功后调用adminExtension；Gateway原有同源/CSRF边界继续适用。完整新Worker产物fixture验证匿名新设置401、管理员cookie读取200、跨站sync403、非法key400、旧账号导入404；未注入扩展的平台返回404，UI因此隐藏卡片。

敏感状态：API key、全部节点用户名密码及active完整快照统一AES-GCM，加密AAD独立；返回仅配置bool、plan、节点公开字段和当前出口/时间，不含认证内容。无设置正文/原始上游错误输出路径。UI密码输入、不填保留、textContent渲染、成功清草稿、退出清字段并使旧异步回执失效；不写浏览器持久存储。

同步/切换：官方固定HTTPS GET、Token认证、重建本origin分页，不跟next URL或重定向；无供应商购买/替换/轮换操作。单次mutation门禁、失败不保存、换key/plan仅清列表、节点消失保留active完整快照；无state时兼容bootstrap。启用只接受已同步valid节点，无账号固定模型GET得到200/401后才提交，失败保留旧出口；explicit null才直连。进行中请求的已开隧道不因设置写入而更换；无自动切换/failover。

发布：新增源码已进入秘密审计路径；本Worker原配置guard、密钥连续性、所属DO及其他产品比较沿用既定保护，没有变更其他线上产品的发布入口。TLS实现未变化，之前适用的严格TLS、帧、流式/背压、取消证据可复用，不声称重新全跑。真实Webshare API key当前缺失，不能宣称真实同步已通过；实现会话的秘密值审计、浏览器验收、最终部署及原资源盘点仍待完成。

## 本轮状态与恢复

未读取真实.env、Cloudflare token、账号数据库、proxy/API认证秘密；未部署、访问真实Webshare API或触发账号上游请求；未改实现或范围外修改。本报告为唯一审查产物。

首审要求两项实质修复后由同一实例仅聚焦api完整性/地址边界及相邻保存回归；最终关闭证据如下，不扩大范围。

## 聚焦复核：通过（2026-09-18）

两项发现均关闭：首次响应固定安全整数expectedCount且拒绝超过250；后续页count变化、累计超总数、next=null时累计不等于总数均拒绝，完整返回后settings才保存。异常沿用失败保留原节点列表和当前完整出口的代码路径；成功零节点及有效多页仍可用。公网地址校验明确排除192.88.99/24，新增边界矩阵证明该块内.1/.2拒绝、相邻192.88.98/100地址仍允许。

独立重新执行限定API/设置fixture：12/12通过，包括原问题复现对应拒绝、稳定多页、失败不回显、旧列表/active快照保留和串行变更。未变的入口鉴权/CSRF等4项沿用首审证据；TLS实现未变，无需重跑其旧回归。

本轮API SHA256：d9dbff18384bba07de0a51ec02fde651f037e9f1d0c5d5fed5c2c0c9889b7252；API测试SHA256：600872fc2e20ef9cddf47be31e7b3ceffd1cc1425f2deb623472ad524a9e0124。

无剩余可执行审查问题。允许按既定单实例范围继续最终构建/秘密审计与发布准备；实际浏览器验收、最终产物版本回读、部署后原资源/账号状态保留仍由实现会话完成。没有真实Webshare API key，因此本审查不证明真实供应商同步或新节点在线启用已通过；后台填写后须按契约验收，不能把fixture代替真实结果。仍未读取真实秘密、部署或访问真实API。

## 发布工具窄差异复核（2026-09-18）

结论继续通过，允许既定限定发布。inventory(stage="app")在任何Cloudflare读取前只接受app/settings两值，分别使用对应*-before.json并写对应*-isolation.json；--settings在发布前后两次盘点均选择settings阶段。不存在可控任意路径或混用旧app隔离结果的入口，002历史基线/隔离证据不被本设置任务覆盖。精确实例/config/resource门禁、唯一目标排除、其他产品完整比较、已有namespace核对及原密钥组合指纹保护保持不变。秘密审计源码列表包含本轮shared account-core/contracts及webshare两文件。

该窄变化仅影响发布证据文件选择，未改变功能/TLS/账号边界，复用适用证据，不重复无变化测试。审查为只读源码核验，没有读取token/秘密或调用线上。最终runner SHA256：e31d46757126f943670d7895add1060ad67d46070f6c1e4c49456908714f4751。

实现会话仍须在真实写入前采集settings-before实际基线，再仅部署oneapi-webshare-test、完成原资源及本实例已有账号/出口的发布后回读；真实APIkey同步仍由用户后台输入后验证。本结论不授权其他产品或Node新接入。
