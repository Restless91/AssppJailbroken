# AssppWeb Jailbroken

面向越狱 iPhone 的 App Store IPA 下载、设备端解密与私有分发系统。设备可独立运行，也可接入 iStoreOS 进行多设备统一管理。

## 功能

- 搜索 App Store 应用、查看应用详情并选择历史版本。
- 使用 Apple ID 获取下载材料并从 Apple CDN 下载 IPA。
- 注入 SINF 与 `iTunesMetadata.plist`，解密主程序、Framework 和兼容的 Extension。
- 校验解密结果，保留任务日志、版本安装包及下载入口。
- 每台 iPhone 同时执行一个解密任务，其余任务自动排队，降低内存压力。
- iStoreOS 支持多设备调度、Apple ID 管理、任务监控、COS 存储与分发。

## 当前版本

**v0.1.16**

同一版本提供三个设备包，必须按照设备、iOS 和越狱环境选择：

| DEB | 设备环境 | 解密方式 | 需要安装 |
| --- | --- | --- | --- |
| `wiki.qaq.unfaird_0.1.16_iphone8_iphoneos-arm64.deb` | iPhone 8/8 Plus · iOS 16.2 · Dopamine Rootless | 内置 `libjailbreak` 进程导出；默认仅处理主程序，批大小 2 | OpenSSH、AppSync Unified、appinst、ElleKit、`libjailbreak.dylib` |
| `wiki.qaq.unfaird_0.1.16_iphone11_iphoneos-arm.deb` | iPhone 11 · iOS 14.3 · Taurine/Procursus Rootful | `kernrw` Runtime Adapter；兼容扩展，批大小 4 | OpenSSH、AppSync Unified、appinst、libhooker、Procursus/libkernrw |
| `wiki.qaq.unfaird_0.1.16_iphone15_iphoneos-arm64.deb` | iPhone 15 · iOS 17.3 · Dopamine 2 Rootless | 内置进程导出；兼容扩展，批大小 8 | OpenSSH、AppSync Unified、appinst、ElleKit、`libjailbreak.dylib` |

三个包的设备端内存预算均为 512 MB。`iphoneos-arm64` 是 Rootless DEB 包架构标识；iPhone 15 的注入与解密目标仍包含 arm64e，不应将两者混为一谈。

## 安装与使用

将对应 DEB 上传到设备并安装：

```bash
scp release/wiki.qaq.unfaird_0.1.16_<设备>_<架构>.deb root@设备IP:/var/tmp/unfaird.deb
ssh root@设备IP 'apt install -y /var/tmp/unfaird.deb'
```

安装后访问 `http://设备IP:8080/`，也可检查节点接口：

```bash
curl http://设备IP:8080/health
curl http://设备IP:8080/api/node/info
```

## 构建

GitHub Actions 会分别构建 iPhone 8、iPhone 11 和 iPhone 15 三个 DEB；推送 `v0.1.16` 标签时生成 Release。macOS 本地构建需要 Xcode、Theos、Swift 和 Node.js：

```bash
make package-iphone8
make package-iphone11
make package-iphone15
```

也可执行 `make build DEVICE_VARIANT=iphone15`；默认设备为 iPhone 15。构建会根据 `release/manifest.json` 自动选择布局、架构、最低 iOS 和 Taurine Runtime，并审计 DEB 元数据、Mach-O 架构与最低系统版本。产物统一保存到 `release/`。

安装指定设备包或回退历史版本：

```bash
make install DEVICE_VARIANT=iphone15 DEVICE_HOST=root@设备IP
make install-version VERSION=0.1.16 DEVICE_VARIANT=iphone11 DEVICE_HOST=root@设备IP
make list-releases DEVICE_VARIANT=iphone11
```

## 项目结构

```text
backend-swift/    iPhone 服务与 DEB 打包
frontend/         设备端 Web 界面
private-platform/ iStoreOS 私有管理平台
scripts/          构建与部署脚本
```

## 致谢

- [Lakr233/AssppWeb](https://github.com/Lakr233/AssppWeb)
- [lbr77/unfair](https://github.com/lbr77/unfair)
- [lbr77/unfaird](https://github.com/lbr77/unfaird)
