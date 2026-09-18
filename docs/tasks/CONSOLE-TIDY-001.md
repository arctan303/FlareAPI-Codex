# CONSOLE-TIDY-001：后台局部整理与布局稳定

目标：响应用户“后台混乱、元素经常位移，稍微优化”的要求，保留现有配色和六区导航，减少设置页的说明与操作混杂。

范围：public/index.html、styles.css、app.js 的设置分组、反馈占位、状态标签和切页焦点。Webshare账户配置/固定出口分开；宽屏Access和日志并列，小屏单列；按用户最新纠正删除设置常驻描述与折叠说明；Webshare支持实例隐藏本机启动指引，Node的404回退保留指引。首次能力加载结束再显示设置卡片，避免异步插入推移其他卡片。

非目标：不更改账号、权限、API、存储、TLS、代理选择规则、Codex配置或其他线上产品。依赖WEBSHARE-SETTINGS-001现有接口与独立Worker；无新Phase。

风险：R1。可回滚的前端行为整理，沿用现有控件ID和事件，没有鉴权与代理业务变化。部署包装只增加layout证据阶段，精确实例和资源隔离断言保留。R1当前会话自查，不派遣子代理。

验收：桌面1280和手机390无页面横向溢出；无节点提示、保存、刷新节点期间下面卡片位置稳定；六区和弹窗可使用、草稿保留；Node404保留网络指引、加载错误显示错误而不是无限隐藏。

基线：修改前无节点提示让Access卡片下移37.5px（真实浏览器假凭据夹具）；线上原版本778f245e-0850-4c60-b315-1daf95e49c53。

状态：实施完成；针对性验证通过；R1自查完成；独立测试Worker已发布。桌面提示位移0px；390px保存、刷新节点位移0px，六区无横向溢出，选中导航可见，标题焦点正确、草稿保留、创建弹窗可开关。延迟加载、404 Node回退、503错误结束加载通过。回滚通过恢复本任务前端基线或原Worker版本，保留当前秘密与DO，不回滚账号数据。

授权：本轮局部优化；延续仅oneapi-webshare-test的线上测试授权，不操作其他产品。
证据（2026-09-18）：
- `node --check public/app.js` 与部署包装语法检查通过；Wrangler dry-run通过，复用锁文件与原入口，未重装TLS依赖。
- Playwright CLI隔离假凭据夹具：`output/worker-webshare/layout-browser-check.js`、`layout-mobile-check.js`执行无断言失败；最终手机六区/保存/同步结果输出通过。只拦截GET能力查询及假Webshare API，不触发真实代理切换、上游生成或其他产品。
- 截图：`output/playwright/console-before.png`、`console-tidy-desktop.png`、`console-tidy-mobile.png`，已视觉检查；其中仅假账号与假API key配置，无真实秘密。命名夹具及浏览器已关闭。
- `node scripts/deploy-webshare-app.mjs --layout --deploy`通过。秘密连续性与TLS补丁SHA有效；14个源码/资产/包文件实际秘密匹配0。只把相同4个实例秘密写回原实例，无轮换、无重建DO。
- 线上版本 `83b0910f-2fda-4035-9741-f1d35c7b96a3`；后台 https://oneapi-webshare-test.12213443th.workers.dev/admin/#settings 。`output/worker-webshare/layout-live.json`记录三项线上资产200且SHA256与本地相同；Webshare读取200、匿名401，bootstrap出口保留，真实API key仍未填。
- `output/worker-webshare/layout-before.json`为本轮首次外部写入前基线；`layout-isolation.json`确认7个已有产品无etag/time变化、域名/子域不变，无新增或改变持久化namespace。

验证边界：未重跑不受本轮前端改动影响的TLS/代理/生成验证；此前后台功能证据仍按原基线适用。更长错误自然展开，动态业务内容仍可改变高度，本轮不宣称所有内容永远不位移。未升级主Node部署包或其他在线实例。
## 文案精简承接

用户明确不需要说明文字。删除设置副标题、Webshare说明、Access解释/故障指引、日志记录解释与读取成功提示，收紧静态状态和反馈占位；字段、实时状态、错误反馈保留。R1短任务延续，权限/代理规则不变。桌面1280与手机390实际提示位移0px、无横向溢出，初始Access反馈为空。已发布版本924185f9-3927-4820-8e41-39eab9931e3f；三项线上资产200且哈希与本地一致，配置读取200/匿名401，7个已有产品及域名/持久化资源不变。证据：output/worker-webshare/concise-live.json、concise-isolation.json、concise-check.js及output/playwright/settings-concise-1280.png、settings-concise-390.png。独立实例精确限制保持。原生本机启动指引不在当前Worker显示。