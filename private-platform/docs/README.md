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

平台运行在 Docker Compose 容器中；iPhone 仅安装对应的 `wiki.qaq.unfaird` DEB。不要将平台部署到 iPhone，也不要把下载文件写入 iStoreOS 系统盘。

### 1. 准备目录和配置

以下命令在 iStoreOS 的终端执行。将 `/mnt/nvme0n1-4` 替换为实际的大盘挂载点：

```bash
git clone https://github.com/Restless91/AssppJailbroken.git /opt/asspp
cd /opt/asspp/private-platform
cp config.example.json config.json
cp docker-compose.istoreos.example.yml docker-compose.yml
mkdir -p /mnt/nvme0n1-4/asspp-platform
chown -R 1000:1000 /mnt/nvme0n1-4/asspp-platform
```

生成主密钥：

```bash
openssl rand -hex 32
```

将该值写入 `docker-compose.yml` 的 `PLATFORM_MASTER_KEY`。主密钥用于加密 Apple ID、COS 密钥和设备访问密码；开始使用后不可随意更换。

### 2. 配置平台

编辑 `config.json`：

- `publicBaseUrl`：用户访问的 HTTPS 地址，例如 `https://dump.dkapps.cn`；
- `internalBaseUrl`：iPhone 访问平台的内网地址，例如 `http://192.168.100.1:8090`；
- `devices[].baseUrl`：每台 iPhone 节点地址，例如 `http://192.168.100.122:8080`；
- `storage.localDir`：保持为 `./data/artifacts`，它会映射到大盘；
- `adminToken`：替换为一次性高强度初始化口令。

不要把真实 Apple ID、COS 密钥、节点 Token 或 `config.json` 提交到 Git 仓库。

### 3. 启动与验证

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8090/api/health
```

局域网访问：

```text
用户前端：http://iStoreOS_IP:8090/
管理后台：http://iStoreOS_IP:8090/admin
```

查看运行日志：

```bash
docker compose logs -f --tail=200
```

更新平台：

```bash
cd /opt/asspp
git pull --ff-only
cd private-platform
docker compose up -d --build
```

### 4. 公网访问

Cloudflare Tunnel 或反向代理应转发到 `http://127.0.0.1:8090`。公网域名使用 HTTPS；iPhone 与 iStoreOS 保持局域网 HTTP 通信即可。

公网地址为 `https://dump.dkapps.cn` 时，在后台“存储与 COS”中填写：

- 公网基础地址：`https://dump.dkapps.cn`；
- iPhone 内网取件地址：`http://192.168.100.1:8090`；
- 文件保留分钟：`1440`（24 小时）。

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
