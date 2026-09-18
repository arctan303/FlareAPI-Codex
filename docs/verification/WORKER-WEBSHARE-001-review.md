# WORKER-WEBSHARE-001：R2 独立审查回执

日期2026-09-17，源码基线13c8de1。范围：独立oneapi-webshare-test实验的JS TLS、固定模型两次GET、只读本地runner、针对性测试及执行契约。实施者/root，fresh reviewer /root/review_webshare_pair；无其他产品/旧维护队列覆盖。

首审：不通过。①固定库未强制CertificateVerify成功状态，存在跳过服务端私钥证明而进入Finished的缺口；②未强制实际协商版本及密码套件符合TLS1.3/AES-GCM契约。未部署账号代码、未发送凭据时发现，修复后才重新核验。

实质修复：固定0.1.4文件指纹的可复现补丁，CertificateVerify验证成功才设置标记，TLS1.3 Finished前强制require；握手resolve前assertTlsMetadata。补丁原SHA2566203af15f12e36409d0778d7f2d9da0f1d2a666eac178efc818315a3749bb5d1，后SHA256accf51dd31b5c5783cfdfd2ebfc44ea1438896897078dc7e58b6b27a997ca405；真实TLS测试钩子移除签名消息，明确certificate_verify_required拒绝；实际协议/套件拒绝回归通过。

聚焦复核：通过，可执行已界定的单次账号目录对照。原两项关闭；独立无账号19/19；准备bundle包含修复。相邻敏感边界未发现问题：账号仅完整验证TLS后的固定GET内发送，CONNECT不含账号，禁止AIA额外网络，无重定向/刷新/生成/自动重试，无账号Secrets/存储，回执不含原文或凭据。Bearer+nonce+短期期限限制，单isolate限制非全局保证已记录。

覆盖边界：只覆盖当前实验和限定两次GET，不是生产级TLS库全面认证。reviewer未读取真实凭据、数据库或在线拨号。真实秘密内存审计、部署版本/就绪核对、线上结果、停用及既有资源盘点由主会话执行并记录到[任务](../tasks/WORKER-WEBSHARE-001.md)。用户授权持续测试只作用于新实验Worker，不允许变更其他线上产品。
