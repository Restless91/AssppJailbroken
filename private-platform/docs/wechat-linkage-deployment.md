# 微信公众号与 Asspp 联动部署

本文对应联动方案第 1–6 阶段的已实现版本。微信公众号管理平台是唯一微信协议网关，`dump.dkapps.cn` 只保存本站用户、额度、任务和下载权限。

## 已实现范围

| 阶段 | 已实现内容 |
| --- | --- |
| 1. 微信网关 | `subscribe`、`SCAN`、`unsubscribe` 统一处理；登录场景匹配；MongoDB 持久化事件；后台 Worker、指数退避和死信 |
| 2. 内部 API | 业务应用、加密密钥、HMAC-SHA256、时间窗口、nonce 防重放、登录会话、客服消息、事件 Webhook |
| 3. dump 登录 | 匿名浏览、扫码登录、浏览器 nonce 绑定、HttpOnly Cookie、复合微信身份、首次赠送 5 次 |
| 4. 业务权限 | 任务归属、关注状态检查、创建任务预扣、失败/取消幂等退款、卡密充值、COS 短期签名 |
| 5. 通知后台 | 微信任务成功/失败通知、通知重试与死信、企业微信运维告警、两端可视化配置、事件日志和手动重投 |
| 6. 联调验证 | Go 与 Node 单元测试、HMAC/重放/幂等测试、前端生产构建、隔离数据目录的本机 HTTP 冒烟测试 |

## 一、微信公众号管理平台

### 1. 环境变量

在 `wechat-official-account-admin-main/.env` 设置：

```dotenv
LISTEN_ADDR=0.0.0.0:9305
MONGO_HOST=127.0.0.1:27017
MONGO_DB=weixin
REDIS_ADDR=127.0.0.1:6379

# 至少 32 位，必须长期保存
SESSION_SECRET=
INTEGRATION_MASTER_KEY=

# 可通过环境变量预置，也可启动后在“业务联动”页面创建
INTEGRATION_CLIENT_ID=asspp-dump
INTEGRATION_CLIENT_SECRET=
INTEGRATION_APPID=
INTEGRATION_WEBHOOK_URL=https://dump.dkapps.cn
```

生成密钥：

```bash
openssl rand -hex 32
```

`INTEGRATION_MASTER_KEY` 用于加密业务 Client Secret。更换它会导致已有密文无法解密。

### 2. 微信公众平台回调

公众号的服务器 URL 继续只指向微信公众号管理平台：

```text
https://你的公众号平台域名/wxmp/<APPID>/handler
```

不要再把微信回调配置到 dump 的 `/api/wechat/callback`。Token、EncodingAESKey、AppSecret 只保存在公众号管理平台。

### 3. 创建业务应用

打开公众号管理后台的“业务联动”：

1. 新增业务应用，Client ID 建议为 `asspp-dump`。
2. Webhook URL 填 `https://dump.dkapps.cn`，不要附加 API 路径。
3. 启用 `wechat.login.confirmed` 和 `wechat.subscription.changed`。
4. 点击“轮换密钥”，立即复制只显示一次的 Client Secret。
5. “最近事件”可查看投递状态、错误和次数；`pending` 或 `dead` 事件可点“立即重投”。

内部接口：

```text
POST /internal/v1/login-sessions
GET  /internal/v1/login-sessions/:sessionId
POST /internal/v1/messages
GET  /internal/v1/health
```

这些接口必须只允许可信内网或反向代理访问，不能当作浏览器 API 暴露。

## 二、Asspp 私有平台

### 1. 基础环境

必须设置：

```dotenv
PLATFORM_MASTER_KEY=<openssl rand -hex 32 的结果>
PLATFORM_DATABASE=/data/platform.sqlite
PLATFORM_STATE=/data/state.json
PORT=8090
```

生产环境应把 `/data` 映射到 iStoreOS 大盘持久化目录。

### 2. 后台配置网关

进入：

```text
https://dump.dkapps.cn/admin
```

在“通知与联动”填写：

- 网关地址：iStoreOS 能访问公众号平台的地址，例如 `http://wechat-admin:9305`；不在同一 Docker 网络时可填公众号平台 HTTPS 地址。
- Client ID：`asspp-dump`。
- Client Secret：公众号后台轮换后显示的密钥。
- AppID：当前公众号 AppID。
- 超时：建议 `10000` 毫秒。

保存后点击“测试网关”。测试成功后，前台 `/api/platform` 会显示微信模式为 `gateway`。

旧 `wechat.appSecret` 直连配置仅保留为迁移兼容。新部署不要填写，避免两个系统争用微信 `access_token`。

### 3. 用户和额度

- 主身份是 `appid:openid`，不同公众号不会串号。
- 首次有效关注并完成登录赠送 5 次，唯一流水保证终身只赠送一次。
- 取消关注后保留历史、余额和已有下载，但禁止创建新任务。
- 创建任务预扣 1 次；最终失败或执行前取消自动退回。
- 相同事件、赠送、扣费和退款均有唯一约束，重复请求不会重复记账。

### 4. 下载和通知

- 任务和下载按用户身份隔离。
- COS 文件保留 24 小时；用户点击下载时才生成短期签名地址。
- 完成或最终失败时通过网关发送微信客服消息。
- 客服消息受微信 48 小时互动窗口限制；发送失败不会改变砸壳结果。
- 通知采用指数退避重试，8 次失败后进入死信并触发已配置的企业微信机器人告警。

## 三、反向代理

建议保持两个独立域名：

```text
dump.dkapps.cn  -> Asspp :8090
wx.example.com -> 公众号管理平台 :9305
```

Cloudflare Tunnel 或 Nginx 必须透传请求方法、原始路径和请求体，不能改写 `/internal/v1/*` 或 `/api/integrations/wechat/events`，否则 HMAC 校验会失败。

## 四、本机验证

微信公众号管理平台：

```bash
cd wechat-official-account-admin-main
gofmt -w integration controllers
go test ./...
```

公众号前端：

```bash
cd wechat-official-account-admin-main/wechat-official-account-admin-fe
npm install
npm run build
```

Asspp：

```bash
cd asspp-work/AssppJailbroken/private-platform
npm run check
npm test
```

隔离状态的 HTTP 冒烟测试可通过 `PLATFORM_DATABASE` 和 `PLATFORM_STATE` 指向临时目录启动，不会读写生产任务。

## 五、正式联调清单

1. 新用户扫码关注：5 秒内登录，余额为 5。
2. 同一用户退出后再次扫码：可登录，不重复赠送。
3. 已关注用户扫码：由 `SCAN` 完成登录。
4. 在另一浏览器轮询同一 session：因 browser nonce 不匹配被拒绝。
5. 重复投递同一 event ID：不重复更新或赠送。
6. 取消关注：旧任务可见，新任务返回 403。
7. 创建任务：余额扣 1；最终失败或取消只退 1 次。
8. 暂停 dump Webhook 后恢复：事件自动重试；死信可从公众号后台手动重投。
9. COS 下载：平台返回短期签名地址，其他用户不能读取该任务。
10. 任务完成/失败：站内状态正确；微信通知失败不会改写任务状态。

## 六、安全上线

- 轮换所有曾出现在截图、聊天或日志里的 AppSecret、Token、EncodingAESKey、COS Secret 和业务 Client Secret。
- 两个主密钥均至少 32 字节，写入密码管理器并离线备份。
- 生产环境只使用 HTTPS。
- `/internal/v1/*` 增加内网、Cloudflare Access 或防火墙限制。
- 不在日志、截图和前端代码中保存任何完整密钥。

