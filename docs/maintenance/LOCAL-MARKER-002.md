# LOCAL-MARKER-002：本地启动与来源头复现

状态：本地服务启动及来源头对照完成；Webshare 对照未执行。日期：2026-09-17。源码基线：13c8de1。

目标：按用户授权在 127.0.0.1:8787 启动现有原生 Node 服务，验证模型目录正常请求与仅增加 CF-Worker 的状态差异，为后续 Webshare 对照建立当前基线。

范围：复用现有 .env、data/oneapi.sqlite、dist/server 产物以及 MARKER-001 的 createMarkerOutbound。后台与 API 保留在 8787；不操作用户正在使用的 8789、3000，不接代理、不部署、不变更产品主架构。

预期与预算：固定官方目录目标、同一凭据快照，仅来源头变化；正式对照最多两次模型 GET，baseline 非 200 就停止 variant，禁止生成、令牌刷新、自动重试和重登。测试期间拒绝非目录上游请求；结束后恢复普通 Node 默认出站并保留本地服务运行。

首次预检因 refresh_window_too_close 停止，0 上游请求。当前账号超过正常刷新窗口；主会话随后说明先通过应用正常刷新恢复账号，在账号准备阶段允许最多一次固定官方 OAuth 刷新和一次目录读取，然后重新预检再执行对照。该准备独立计数，不声称本次总计 0 refresh。

风险 R1：限定本地来源头诊断，不改变鉴权与存储契约，凭据继续只向既有固定官方目标发送；输出只含脱敏状态、长度、哈希与白名单响应头。依赖：原生产物运行时可注入 fetchImpl、账号连接且正式对照无需刷新、8787 可用。

## 真实证据

时间 UTC 2026-09-17T14:57:55.205Z，client_version=0.153.4。来源头值：oneapi.12213443th.workers.dev。

| 请求 | 状态 | 响应 | 字节数 | CF-Ray |
| --- | --- | --- | --- | --- |
| 正式 baseline：不带来源头 | 200 | application/json | 405467 | a3c8f74ac88acf13-SJC |
| 正式 variant：仅增加 CF-Worker | 403 | text/html; charset=UTF-8 | 6634 | a3c8f74f4b95cf13-SJC |

正式对照前后 connected=true、reauthenticationRequired=false，tokenExpiresAt 与 lastRefreshAt 精确一致。管理目录返回 baseline 的正常结果（200），不会把该管理 HTTP200 当作 variant 成功。

实际计数：准备 OAuth 刷新 1 次（200）、准备目录 1 次（200）；正式目录 2 次；生成 0、正式刷新 0、自动重试 0。没有使用 Webshare。正式响应仅保存长度、哈希和白名单元数据，未保存凭据或原始正文。

结论：本项目再次复现正常请求 200、仅增加来源头后 403，支持该来源头影响此次拒绝；不证明上游官方规则、不排除逐请求网络差异、不承诺每次百分百复现，也不把本地结果写成云 Worker 修复。

## 验证与恢复

node v24.15.0；node --test scripts/test-probe-local-marker.mjs 4/4，通过单变量、失败停止、目标/刷新拒绝、摘要脱敏和响应读取限制检查；包装脚本 node --check 通过。git diff --check 通过。

诊断入口：output/local-marker/start-and-probe.mjs（忽略目录）；脱敏结果：output/local-marker/result.json；PID：output/local-marker/pid.txt。当前 Node PID 7448，监听 127.0.0.1:8787，诊断模式已关闭、普通请求使用 Node 默认出站。用户现有 8789 PID34668、3000 PID10172 保持不变。仅在重启诊断包装脚本时会重新自动预检/执行来源头对照，普通标准启动仍为 npm start；未修改现有业务源码和启动命令。

实施：本地启动/诊断包装入口完成；真实验证：通过，已复现上游拒绝；审查：R1 当前会话自查，加入轻量待复查队列；发布：未发布。

下一步：若继续 Webshare 实验，复用今天的有效基线，以同一目录请求对照代理带头和代理不带头；需先核对实际代理认证/隧道可用性。本任务不包括该实验。

## 网络解释补充（同次诊断）

用户随后明确本机出口为138.226.61.165；UTC2026-09-17T15:10:49.846Z，在未显式配置代理的Node fetch中进行一次无账号api.ipify.org检查，返回同一IP。该IP是Webshare列表第二条。系统mihomo TUN开启，IPv4默认路由经过mihomo。先前normalTransport=node-direct只表示应用没有额外配置ProxyAgent，不能解释成公网路径没有代理。

模型对照发生于14:57，出口检查发生于15:10，原对照没有同步采集出口IP；如果期间节点/路由未变，则两组请求已通过这个住宅出口，支持住宅IP本身不足以避免这次CF-Worker触发的拒绝。这是依据用户报告与当前路由的条件推断，不能声称逐请求公网IP已经实测一致。无头200/加头403的原始事实不变。
