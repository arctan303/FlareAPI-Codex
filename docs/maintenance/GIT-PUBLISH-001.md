# GIT-PUBLISH-001：迁移远端并推送FlareAPI

用户明确指定 git@github.com:arctan303/FlareAPI-Codex.git，授权切换origin并提交/推送当前已交付项目代码。远端main与当前本地HEAD同为13c8de1，可普通快进，不使用force、不推额外tags。

范围：FlareAPI/Webshare/Worker当前代码、测试、配置和已验证文档；前期排障文档如实保留。工作流signals已有他人/前轮修改保留在本机，不整体纳入本次提交。秘密.env*/.dev.vars、output/.wrangler/node_modules保持ignore，提交候选及历史做实际秘密值匹配，只输出命中文件名。

R1短维护：补齐独立TLS固定版本的原锁文件及本地准备脚本，以便拉取仓库后可构建；不改运行时补丁/代理/鉴权，不做Cloudflare写入。复用已通过的发布R2审查，不为git推送新增独立代理。

验证：目标分支HEAD相等、ignored秘密未跟踪；源码/资产/所有新blob与现有git历史实际秘密值0匹配；TLS准备校验/Worker dry-run成功；必要typescript检查/格式检查；提交后remote main回读与本地一致。

状态：本地构建准备与验证完成；origin已切换到指定仓库，main普通快进推送成功，已回读核验。项目提交7987d353f5b419c37c82718cda834f78d3392963；本记录的闭环提交仅更新任务状态。现有本机signals修改继续保留，未提交。

本地证据：隔离空目录npm ci安装25个固定依赖，严格TLS补丁原/后SHA256与既有运行时一致；原目录缓存准备与Worker dry-run通过。TypeScript检查通过。output/flareapi/git-secret-audit.json：候选273文件与全部历史446 blob实际认证秘密0匹配，公开节点IP不按秘密误报；.env与output忽略。线上本轮不写入。
