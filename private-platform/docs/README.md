# Asspp 私有自动化管理平台

平台运行在 iStoreOS，iPhone 仅负责安装与砸壳。平台负责 App Store/CDN 下载、全局排队、多设备调度、Apple ID 账户租约、COS 分发、用户额度、卡密和运维告警。

## 核心规则

- 同一台 iPhone 同时只执行 1 个任务。
- 普通用户不能选择物理设备；管理员可设置优先设备或锁定设备。
- 调度顺序为主力、普通、备用；同组按权重选择。测试设备仅在管理员锁定时使用。
- 网络错误优先在同一设备重试；设备运行时、内存、安装或权限错误切换设备。
- 单设备最多 2 次，最多尝试 3 台设备，总尝试不超过 5 次。
- Apple ID 可全局使用或绑定指定设备；同一账户同一时间只有一个租约。
- COS 主存储失败时可切换可选备用 COS。
- COS 下载经平台短时签名重定向，不把 SecretId/SecretKey 暴露给浏览器。
- 微信用户每创建一个任务扣 1 次额度；最终失败或取消会自动退回。

## iStoreOS Docker 部署

要求 Node.js 22.5+。推荐直接使用仓库中的 Dockerfile：

```bash
cd private-platform
cp config.example.json config.json
cp docker-compose.istoreos.example.yml docker-compose.yml
```

生成主密钥：

```bash
openssl rand -hex 32
```

把结果填入 `docker-compose.yml` 的 `PLATFORM_MASTER_KEY`。主密钥一旦用于保存 Apple ID、COS 或设备 Token，就不能随意更换，否则已有密文无法解密。

确保大盘目录存在并属于容器内的 Node 用户（UID 1000）：

```bash
mkdir -p /mnt/nvme0n1-4/asspp-platform
chown -R 1000:1000 /mnt/nvme0n1-4/asspp-platform
docker compose up -d --build
```

局域网访问：

```text
http://192.168.100.1:8090/
http://192.168.100.1:8090/admin
```

Cloudflare Tunnel 应指向：

```text
http://127.0.0.1:8090
```

公网地址为 `https://dump.dkapps.cn` 时，在后台“存储与 COS”中填写：

- 公网基础地址：`https://dump.dkapps.cn`
- iPhone 局域网取件地址：`http://192.168.100.1:8090`
- 文件保留分钟：`1440`（24 小时）

## 首次初始化

1. 打开 `/admin`。
2. 输入旧 `adminToken`，创建首个超级管理员。
3. 将页面显示的 TOTP 密钥添加到 Authenticator/1Password。
4. 输入 6 位验证码完成初始化。
5. 依次配置设备、Apple ID、主 COS、可选备用 COS、微信公众号和企业微信机器人。

## 设备

后台添加节点地址后会访问受保护的 `GET /api/node/info`，自动采集：

- 设备型号、iOS 版本；
- 越狱 runtime、权限 provider；
- daemon 构建版本；
- 存储、vnode 和温度状态；
- 能力集。

当前规划节点：

- 生产设备：`http://192.168.100.227:8080`
- Taurine 测试设备：`http://192.168.100.122:8080`

测试节点放入“测试设备”组，避免普通任务自动进入。

## Apple ID

旧 `devices[].accountFile` 会在首次启动时迁移到 SQLite，并使用 `PLATFORM_MASTER_KEY` 进行 AES-256-GCM 加密。后续可在 `/admin` 直接粘贴账户态 JSON，并选择：

- 全局默认；
- 所有设备可用；
- 仅绑定指定设备；
- 优先级与启用状态。

## 微信、卡密和通知

新部署使用独立微信公众号管理平台作为唯一微信网关。公众号回调必须指向网关的
`/wxmp/<APPID>/handler`，dump 不再直接保存 AppSecret 或刷新微信
`access_token`。完整配置见
[微信公众号与 Asspp 联动部署](./wechat-linkage-deployment.md)。

卡密按“可用次数”生成，明文保存在 SQLite，超级管理员可随时查看和导出；每次查看都会写审计日志。

企业微信机器人用于设备离线、恢复和自动隔离提醒，支持最低告警级别与合并窗口，可在后台发送测试告警。

## 主要接口

公共/用户接口：

- `GET /api/apps`
- `GET /api/devices`
- `GET /api/jobs`
- `POST /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/download`
- `POST /api/cards/redeem`

后台接口位于 `/api/admin/*`，使用 HttpOnly 管理员会话 Cookie：

- 认证与 TOTP：`/api/admin/bootstrap/*`、`/api/admin/auth/*`
- 设备：`/api/admin/devices`、`/api/admin/device-groups`
- 任务：`/api/admin/jobs`
- Apple ID：`/api/admin/apple-accounts`
- 卡密/额度：`/api/admin/cards/*`、`/api/admin/users/credits`
- 存储/通知：`/api/admin/settings/*`
- 管理员/审计：`/api/admin/admins`、`/api/admin/audit`

## 验证

```bash
npm run check
npm test
```
