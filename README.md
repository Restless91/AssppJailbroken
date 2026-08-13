# AssppWeb Jailbroken

面向越狱 iPhone 的 App Store IPA 下载、设备端解密与私有分发系统。可单机运行，也可接入 iStoreOS 作为多设备管理与分发平台。

## 功能

- App Store 搜索、排行榜、应用详情与历史版本选择。
- Apple ID 登录、许可证获取与 IPA 下载。
- SINF、`iTunesMetadata.plist` 注入，以及主程序、Framework、Extension 解密。
- 解密结果校验、安装包下载、任务日志与自动清理。
- 单台设备单任务执行；其余任务自动排队，避免内存竞争。
- iStoreOS 可选多设备调度：按设备系统版本、可用空间和状态分配任务，并支持 COS 分发。
- 内置 Web 管理界面，可直接通过 `http://设备IP:8080/` 使用。

## 当前版本

**v0.1.7**

当前发布包面向 arm64e Rootless 越狱环境，适用于已完成越狱且具备 OpenSSH 的 iPhone。安装前请确认设备架构与越狱环境和 DEB 包一致。

## 安装

将对应的 DEB 上传到设备后安装：

```bash
scp backend-swift/debs/wiki.qaq.unfaird_*_iphoneos-arm64e.deb root@设备IP:/var/tmp/unfaird.deb
ssh root@设备IP 'apt install -y /var/tmp/unfaird.deb'
```

安装完成后访问：

```text
http://设备IP:8080/
```

检查服务：

```bash
curl http://设备IP:8080/health
curl http://设备IP:8080/api/node/info
```

## 可选：iStoreOS 综合管理

将 iPhone 节点添加到 iStoreOS 后，可由平台统一管理 Apple ID、设备队列、任务调度、成品存储与下载分发。每台 iPhone 同时只执行一个解密任务，其余任务保持排队。

## 项目结构

```text
backend-swift/   iPhone 服务端与 DEB 打包
frontend/        iPhone Web 界面
private-platform/iStoreOS 私有管理平台
scripts/         构建与部署脚本
```

## 构建

在 macOS 上准备 Xcode、Theos、Swift、Node.js 后执行：

```bash
make package-rootless
```

构建产物位于 `backend-swift/debs/`。

## 致谢

- [Lakr233/AssppWeb](https://github.com/Lakr233/AssppWeb)
- [lbr77/unfair](https://github.com/lbr77/unfair)
- [lbr77/unfaird](https://github.com/lbr77/unfaird)
