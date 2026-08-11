# iStoreOS 部署说明

本目录用于把私有管理平台部署到 iStoreOS 软路由。

同步脚本优先使用当前项目中的集成版源码：

```text
private-platform
```

旧附件工作树仍可自动回退到 `asspp-work/AssppJailbroken/private-platform`，也可通过
`PLATFORM_SOURCE=/absolute/path` 覆盖。脚本不会同步或删除远端 `data/`、`config.json`、
`config.local.json`，因此设备、管理员、Apple ID 和历史任务数据库会保留。

- 软路由访问地址：`http://192.168.100.1:8080`
- iPhone worker：在综合管理后台分别添加 iPhone8、iPhone11、iPhone15 的当前局域网地址
- 容器内服务端口：`8090`
- 宿主映射端口：`8080`

部署目录建议为：

```text
/opt/asspp-platform
```

运行数据目录建议放在 Docker 大盘：

```text
/mnt/nvme0n1-4/asspp-platform-data/data
```

`docker-compose.yml` 已将容器内 `/app/data` 挂载到该目录。App Store 原始 IPA、最终 IPA、任务状态都会写入这里，避免占满 iStoreOS 的 `/overlay` 小分区。

启动：

```sh
cd /opt/asspp-platform
docker compose up -d
```

查看日志：

```sh
docker logs -f asspp-platform
```

健康检查：

```sh
curl http://127.0.0.1:8080/api/health
```

当前设备端调度契约采用与 unfaird `0.1.14` 一致的空间预算：`max(2 GiB, IPA × 3 + 512 MiB)`。
后台会保留设备返回的 `insufficient_storage` 错误，并在设备列表展示 daemon 构建和砸壳能力。
设备地址保存在远端 SQLite 数据库中，升级代码时不要用仓库内示例配置覆盖运行中的数据库。

## 腾讯云 COS 分发

平台支持砸壳完成后自动上传腾讯云 COS，并返回 COS/CDN 链接给用户。推荐配置：

```json
{
  "storage": {
    "mode": "cos",
    "artifactRetentionMinutes": 1440,
    "cos": {
      "enabled": true,
      "region": "ap-shanghai",
      "bucket": "blog-1314572338",
      "publicDomain": "https://cos.91ios.fun",
      "prefix": "ipa"
    }
  }
}
```

SecretId / SecretKey 建议通过 Docker 环境变量注入：

```sh
TENCENT_COS_SECRET_ID
TENCENT_COS_SECRET_KEY
TENCENT_COS_REGION
TENCENT_COS_BUCKET
TENCENT_COS_PUBLIC_DOMAIN
```

任务完成后，iStoreOS 会把成品 IPA 上传到 `ipa/` 前缀下，并删除 iStoreOS 本地成品文件。平台会在 24 小时后主动删除 COS 对象。

同时建议在腾讯云 COS 控制台配置生命周期规则：

```text
适用范围：指定前缀 ipa/
文件过期删除：1 天后删除
```

这样即使平台服务停止，COS 也会自动清理过期 IPA。

## 启用微信公众号扫码登录

编辑：

```sh
/opt/asspp-platform/config.router.json
```

填写：

```json
{
  "publicBaseUrl": "https://你的公网域名",
  "wechat": {
    "appId": "公众号 AppID",
    "appSecret": "公众号 AppSecret",
    "token": "公众号后台 Token",
    "encodingAESKey": "",
    "templateId": "模板消息 ID",
    "adminOpenids": [],
    "sessionMaxAgeSeconds": 604800
  }
}
```

公众号后台服务器配置：

```text
URL: https://你的公网域名/api/wechat/callback
Token: 与配置文件一致
消息加解密方式: 明文模式
```

保存后重启容器：

```sh
docker restart asspp-platform
```

未填写 `wechat.appId/appSecret/token` 时，平台会自动关闭扫码登录，只显示管理员 Token 备用入口。
