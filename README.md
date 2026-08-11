# AssppJailbroken

AssppJailbroken 是面向个人越狱 iPhone 的 AssppWeb 后端。它从 Apple CDN 下载加密 IPA，注入下载响应中的 SINF 和 `iTunesMetadata.plist`，执行砸壳，并通过 Web UI/API 提供最终 IPA 下载。

本仓库的生产后端位于 `backend-swift/`，使用 Swift、Vapor 和 UnfairKit。项目参考并复用了以下实现：

- [Lakr233/AssppWeb](https://github.com/Lakr233/AssppWeb)
- [lbr77/unfair](https://github.com/lbr77/unfair)
- [lbr77/unfaird](https://github.com/lbr77/unfaird)

## 已验证设备和解密模式

| 设备 | 系统/越狱 | 软件包架构 | Provider | 自动解密模式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| iPhone 15（A16/arm64e） | iOS 17.3、Dopamine 2 rootless、ElleKit | `iphoneos-arm64` | `builtin` | daemon 自身的 rootless Adapter | 已验证 |
| iPhone 8 Plus | iOS 16.2、Dopamine rootless | `iphoneos-arm64` | `builtin` | daemon 自身的 rootless Adapter | 已验证 |
| iPhone 11 | iOS 14.3、Taurine/Procursus | `iphoneos-arm` | `kernrw` | 独立 `UnfairRuntimeRunner`，按 offline → runtime → task-memory → Frida 降级 | 已验证 |

普通 arm64 daemon 可以在 arm64e 设备上兼容运行，但注入 arm64e 进程的 dylib/helper 必须包含 arm64e slice。Taurine 包内的 `fouldecrypt.kernrw` 和 `libkernrw.0.dylib` 必须同时包含 `arm64`、`arm64e`；daemon 与注入目标的架构不能混为一谈。

当前 Taurine 发布版本为 `0.1.7`。该版本已把 iStoreOS 的
`forceExtensionDecryption` 贯通到独立 runner 的 `--force-extensions` 参数，可对主程序、Framework、
`.appex` 和 Watch 组件执行严格完整解密。

rootless 发布版本 `0.1.8` 新增持久化解密 Checkpoint、`main_only` / `compatible` / `strict`
三档扩展策略，以及可恢复 runner 的 `8 → 4 → 2 → 1` Jetsam 自动缩批 Interface。只有 runner
显式声明 `UNFAIR_PACKAGE_RUNNER_RESUMABLE=1` 时 daemon 才会传递 `--batch-size` 和
`--checkpoint`，旧 runner 不会收到不兼容参数。daemon 重启后，有原始 IPA 和有效 Checkpoint 的
解密任务会自动重新进入后台队列；Safari 连接并不拥有任务生命周期。

版本 `0.1.9` 在设备首页加入按 Apple ID 地区加载的 App Store 免费榜推荐。推荐数据由 daemon
代理 Apple Marketing Tools 榜单，前端提供响应式卡片、加载骨架、错误重试和应用详情深链接。

## 本次修复和适配

### 1. rootless 部署

- 补充 rootless launchd 路径和动态库搜索路径。
- `postinst` 根据实际 jailbreak prefix 渲染 launchd 配置。
- daemon entitlements 增加无沙箱、App Bundle 访问、调试、动态签名和 `IOSurfaceRootUserClient` 权限。
- 运行时从 Dopamine 的 `libjailbreak.dylib` 初始化内核原语。

### 2. iOS 17 加密映射诊断

- 保留 Mach-O 原始 `cryptid`、加密区间和 RX 映射信息。
- 增加代码签名状态、映射权限和内核偏移诊断。
- 适配 Dopamine `jbinfo_get_serialized` 提供的动态结构偏移。
- 增加 VM entry 权限提升与恢复逻辑。
- 增加 `F_ADDFILESIGS_RETURN` 和相关错误检查。

需要注意：在本次 iOS 17.3/A16 设备上，传统静态路径仍会得到：

```text
mremap_encrypted failed: Operation not permitted
```

因此，当前设备最终采用进程内存导出路径，而不是把静态 `mremap_encrypted` 成功作为完成条件。

### 3. FairPlay 启动错误定位

原始闪退发生在应用进程创建之前，实时日志为：

```text
AppleFairplayTextCrypterSession::fairplayOpen() failed, error -42004
spawn failed, error=80: Authentication error
```

排查确认：

- 应用包、主程序、数据容器和 LaunchServices 注册均存在，不是桌面图标缓存。
- SINF 清单只有一个主票据，并按 `SinfReplicationPaths` 复制给 Framework/appex；不是多票据顺序取错。
- AppSync 允许安装和伪签名，但不会替代 FairPlay 页面解密。
- 该设备的 FairPlay 授权状态在登录并 respring 后刷新，应用才能被正常创建。其他系统/越狱版本不一定要求相同操作，不能把“必须登录 App Store”视为通用前提。

### 4. iOS 17 进程砸壳流程

成功路径调整为：

1. 安装带正确 SINF 的原始加密 IPA。
2. 通过 SpringBoardServices 正常启动主 App。
3. 在目标进程中读取主程序和已加载 Framework 的解密页面。
4. 主 App/Framework 与 appex 分批导出，降低 Jetsam 峰值。
5. 对未自然加载的 Framework，在应用自身正常线程中加载后再导出。
6. 合并各批次的 Mach-O，并从原始 IPA复制其他资源。
7. 对最终 IPA执行全量校验。

本次测试包包含 24 个 Mach-O，最终结果为：

```text
cryptid != 0:       0
zero-filled region: 0
byte mismatches:    0
missing entries:    0
```

其中包括主程序、20 个 Framework 和 2 个 appex 可执行文件。

### 5. 内存峰值和 helper 退出 137

大型 App 在一次进程中导出全部组件并回传时，可能被 Jetsam 杀死：

```text
helper exit 137
```

本次修复策略：

- 主 App/Framework 和 appex 分批运行。
- 已落盘的 Mach-O 通过 64KB 缓冲流式回传。
- 避免对单个缺失 Framework 创建大型远程线程池。
- 合并后统一执行 cryptid、零填充和源文件字节比对。

daemon 服务进程和每个 `package` runner 启动时都会通过内核
`MEMORYSTATUS_CMD_SET_MEMLIMIT_PROPERTIES` 将 active/inactive Jetsam 上限设置为 512 MB，
随后使用 `MEMORYSTATUS_CMD_GET_MEMLIMIT_PROPERTIES` 回读验证。回读值不是 512 MB 时进程会
立即失败，避免在系统默认的小内存上限下继续处理大型 IPA。`launchctl print` 展示的是 launchd
作业模板值，可能仍显示默认值；运行日志中的 `jetsam memory limit verified` 是内核实时回读值。

### 6. Taurine/Procursus 独立 runner

iOS 14/Taurine 不复用 iOS 17 的 staged runner。launchd 通过
`UNFAIR_PACKAGE_RUNNER=/usr/local/lib/unfaird/UnfairRuntimeRunner` 选择独立 Adapter：

1. 复用版本匹配的已安装 App，或通过 AppSync + `appinst` 临时安装原始加密 IPA。
2. 优先使用 `fouldecrypt.kernrw` 离线处理主程序和 Framework。
3. 离线失败时依次尝试 runtime dump、task-memory 和 Frida 降级。
4. 默认完成后恢复/清理临时安装状态。
5. `--force-extensions` 开启时，`.appex` 和 Watch 组件也必须成功解密，否则任务失败。

Web 日志会明确打印实际 runner：

```text
package runner: /usr/local/lib/unfaird/UnfairRuntimeRunner
```

整个流程在 iPhone 本地运行；macOS 只用于构建、SSH 部署和诊断，不参与线上任务解密。

## 设备依赖

设备至少需要：

- 可用的 rootless/rootful jailbreak。
- OpenSSH（部署与诊断使用，Web 任务运行时不依赖 Mac 保持在线）。
- AppSync Unified。
- appinst 2.1.1 或兼容版本。
- 对应越狱的运行时：Dopamine 使用 `libjailbreak.dylib`/ElleKit；Taurine 使用 Procursus、libhooker 和 `libkernrw`。

Taurine/iOS 14 推荐安装：

```bash
apt-get install ai.akemi.appinst
```

该包会依赖安装 `ai.akemi.appsyncunified`。安装后检查：

```bash
/usr/bin/appinst
```

输出必须包含 `Usage: appinst <path to IPA file>`。`GET /api/node/info` 中还应显示
`appinstInstall: true`、`provider: kernrw` 和 `extensionDecryption: true`。

OpenSSH 用于部署和诊断；AppSync/appinst 用于安装下载得到的加密 IPA。最终砸壳 IPA是否需要签名取决于后续安装工具，本项目的核心交付物是可下载、校验通过的未签名 IPA。

## 构建和安装

需要 Xcode、Theos、Swift 工具链及前端构建依赖。

```bash
git clone https://github.com/lbr77/AssppJailbroken.git
cd AssppJailbroken

make build
make install DEVICE_HOST=mobile@<device-ip>
```

也可以使用 Theos 设备变量：

```bash
THEOS=/path/to/theos \
THEOS_DEVICE_IP=<device-ip> \
THEOS_DEVICE_USER=mobile \
make install
```

按设备生成 deb：

```bash
# Dopamine/rootless（iPhone 8/15）
cd backend-swift
make package FINALPACKAGE=1 DEVICE_PROFILE=rootless

# Taurine/Procursus（iPhone 11）
make package FINALPACKAGE=1 DEVICE_PROFILE=taurine \
  TAURINE_RUNTIME_RUNNER=/absolute/path/to/unfair-swift \
  TAURINE_RUNTIME_DUMPER=/absolute/path/to/UnfairRuntimeDumper.dylib
```

Taurine 构建会拒绝缺失或不可执行的 runtime runner/dumper，避免生成能安装但不能砸壳的发布包。

### 当前发布包与回退

| Profile | 版本 | 文件 | SHA-256 |
| --- | --- | --- | --- |
| Dopamine/rootless | 0.1.8 | `wiki.qaq.unfaird_0.1.8_iphoneos-arm64.deb` | `0a26781f9c40bc8401d11ae1d49e303baa5a74b03d5c51c7f536eff13e0cfde1` |
| Taurine/Procursus | 0.1.7 | `wiki.qaq.unfaird_0.1.7_iphoneos-arm.deb` | `aec1109e6284308dcb2a4cdf473b21da0b48edf53157d142be4e9d74099a4af8` |
| Dopamine/rootless 稳定版 | 0.1.3 | `wiki.qaq.unfaird_0.1.3_rootless_iphoneos-arm64.deb` | `120daf4b5e3018ce53fd4306976a84b78a88d8f7e2dab37eb7c230f3e87f05ae` |

发布时只增加版本号，不覆盖 `backend-swift/debs/` 中的旧 deb，便于按设备 Profile 回退。升级前必须
确认没有处于 `decrypting` 状态的任务；安装 deb 会重启 daemon。Taurine 使用
`iphoneos-arm`，Dopamine rootless 使用 `iphoneos-arm64`，不得交叉安装。

安装后确认 daemon：

```bash
ssh mobile@<device-ip>
launchctl print system/wiki.qaq.unfaird
```

默认 Web UI：

```text
http://<device-ip>:8080/
```

不要把未配置访问控制的服务暴露到公网。

## 使用流程

1. 在 Web UI 添加 Apple 账号并完成认证。
2. 搜索或输入目标 App。
3. 获取购买许可（免费 App 也需要获取 license）。
4. 创建下载任务。
5. 后端下载 IPA、注入 SINF、执行砸壳和校验。
6. 任务完成后从下载页面获取 IPA。

## iPhone 15 Web UI 与 iStoreOS 平台

Web UI 已针对 iPhone 15（含 Safari/PWA）调整：顶部和底部使用安全区，页面采用动态视口高度，
底部导航不会遮挡内容，移动端交互控件保持至少 44pt 的触控区域。下载列表与安装包详情会显示
Mach-O 校验数量、产物 SHA-256 和稳定错误码；长 Bundle ID、哈希及应用名称会在窄屏正确换行。

附件中的 `private-platform/` 可直接作为 iStoreOS 综合管理平台使用，无需修改其业务代码。
推荐在 iStoreOS 上使用示例 Compose 文件启动：

```bash
cd private-platform
docker compose -f docker-compose.istoreos.example.yml up -d --build
npm test
npm run check
```

平台要求 Node.js 22.5 或更高版本；Docker Compose 使用 host 网络，默认管理端口为 8090，
持久化目录应按 iStoreOS 实际磁盘挂载点设置。iPhone 与 iStoreOS 必须位于同一可信局域网。

调度器在下载原始 IPA 前检查设备能力。明确报告
`appinstInstall=false` 且 `trollStoreInstall=false` 的设备不会接收任务，避免下载数百 MB 后才因缺少
安装 Provider 失败。全局默认扩展策略为“尝试解密应用扩展”；可在设备组或单台设备上改为
“跳过应用扩展”稳定模式。

当前 iPhone 后端为平台提供以下兼容接口：

- `GET /api/node/info`：设备、运行时、存储和能力发现。
- `GET /api/account/default/status`、`POST /api/account/default/import`：默认 Apple 账号状态与导入。
- `POST /api/downloads/apple/default/materials`：在手机上获取 Apple CDN、SINF 和元数据。
- `POST /api/downloads/external-url`：让手机从 iStoreOS 的私网 URL 取回 IPA 并完成砸壳。

这些接口沿用 Web UI 的访问令牌鉴权。外部 IPA 回源只接受 localhost、链路本地或 RFC 1918
私网地址，避免把设备变成任意公网下载代理。默认账号材料以 `0600` 权限保存，状态接口只返回
账号哈希和配置状态，不回传密码或认证令牌。

HTTP API 的本地解密接口：

```bash
curl -sS -F "ipa=@/path/to/app.ipa" \
  http://127.0.0.1:8080/api/v1/decrypt
```

查询任务：

```bash
curl -sS http://127.0.0.1:8080/api/v1/decrypt/<job-id>/ready
```

下载成功输出：

```bash
curl -L -o decrypted.ipa \
  http://127.0.0.1:8080/api/v1/decrypt/<job-id>/output
```

## 输出验收标准

任务只有同时满足以下条件才能标记为成功并开放下载：

- 强制扩展模式下，所有目标 Mach-O 的 `LC_ENCRYPTION_INFO[_64].cryptid == 0`。
- 稳定模式下，只有明确跳过的 `.appex`/Watch 组件可以保留 `cryptid != 0`；主程序和 Framework 仍必须全部解密。
- 原加密区不能全部为零。
- 加密区和 cryptid 字段之外的字节与源文件一致。
- 主程序、Framework 和未跳过的 appex 均已处理。
- 输出 ZIP/IPA 可以完整读取。

“成功写出 IPA”不等于砸壳成功；必须执行上述校验。

当前 Swift 后端已经把该校验作为发布门禁接入两条路径：Web 下载任务和
`/api/v1/decrypt` 上传任务。即使 runner 退出码为 0，只要存在残留加密、加密区全零、
Mach-O 遗漏或非预期字节变化，任务仍会标记为失败且不会开放下载。Web 下载任务的
JSON 还会返回 `verification.scannedMachOCount` 与
`verification.verifiedMachOCount`；该字段为可选字段，兼容升级前持久化的任务。
校验完成后会流式计算最终 IPA 的 SHA-256，写入任务的 `sha256` 字段，并在文件下载
响应中返回 `X-Artifact-SHA256` 和基于该哈希的 `ETag`。

同一 Bundle ID 的设备处理阶段使用独占 lease。并发任务不会同时操作同一个 App；后进入
处理阶段的任务会以 `bundle_busy` 失败，不同 Bundle ID 仍可并发。失败任务同时返回稳定的
`errorCode`，目前覆盖加密映射权限、FairPlay 授权、Jetsam/退出 137、无效签名、设备未解锁、
Bundle 冲突和产物校验失败。

下载阶段和砸壳 runner 阶段都支持暂停。砸壳阶段暂停时，daemon 会终止 runner 的整个进程组，
清理临时输出并保留任务恢复所需的下载信息；恢复任务会重新执行完整下载和校验流程。runner
超时不再固定为 15 分钟，而是根据 IPA 大小在 15–60 分钟之间计算，并同时应用于 Web 下载
任务和 `/api/v1/decrypt` 上传任务。

砸壳开始前会执行磁盘预算门禁。单个任务按 `max(2GB, IPA 大小 × 3 + 512MB)` 预留空间，
覆盖解压目录、输出 IPA 和临时文件；Web 下载与上传 API 共用同一个 reservation gate，并发任务
按各自实际预算累计。空间不足时任务返回 `insufficient_storage`，不会进入解压或砸壳阶段。

## 正式发布状态

已完成：

- iPhone 8/15 的 rootless Adapter 与 iPhone11/Taurine 的独立 runtime Adapter 已接入同一 Web 流程。
- 后端成功条件已从“退出码为 0 且文件存在”升级为强制 IPA/Mach-O 校验。
- Taurine 的安装、复用已安装 App、offline/runtime/task-memory 降级和扩展强制解密已接通。
- AppSync/appinst 能力通过 `/api/node/info` 暴露，并由 iStoreOS 在调度前检查。
- 最终产物 SHA-256、下载响应校验头、Bundle ID 互斥与结构化错误码已接入 Web 任务。
- 校验错误使用稳定错误码，包括 `still_encrypted`、`zero_filled_encrypted_region`、
  `missing_macho` 和 `unexpected_binary_mutation`。
- Web 下载、上传 API、runner 参数和综合管理能力门禁均有回归测试。
- Web 任务已持久化 Mach-O 进度、批次和尝试次数；daemon 重启可识别并恢复仍有 IPA 的解密任务。
- 扩展校验策略已从布尔值升级为 `main_only`、`compatible`、`strict`，并兼容旧任务字段。

后续优化项：

- 在 iPhone runtime runner 内实现 `--checkpoint` / `--batch-size` Adapter；daemon 侧 Interface 和
  `8 → 4 → 2 → 1` 调度已完成，未声明能力的旧 runner 会保持原调用方式。
- 把 Taurine runtime runner/dumper 源码和构建入口完全收拢到单一可复现发布流水线。
- 增加真实设备升级测试矩阵和 deb 内 `arm64`/`arm64e` 构建期自动审计。
- 让解密期断点恢复复用已下载 IPA，而不是重新执行完整下载。

## 常见故障

### `mremap_encrypted failed: Operation not permitted`

iOS 17 上静态映射路径被内核拒绝。应使用已适配的进程内存导出路径，不要仅通过反复增加 entitlement 规避。

### `fairplayOpen() failed, error -42004`

说明当前 SINF、Mach-O 和设备 FairPlay 环境认证失败。检查：

- SINF 是否来自同一次 Apple 下载响应。
- `SC_Info/Manifest.plist` 的 `SinfPaths` 和 `SinfReplicationPaths`。
- App 是否通过 appinst/AppSync 完整安装。
- 当前设备的授权状态；必要时登录、respring 后重新测试。

### 点击图标立即返回桌面

先检查实时 syslog。若 launchd 在 spawn 阶段失败，则不是应用业务代码崩溃，也不是单纯图标缓存。

### `helper exit 137`

通常是 Jetsam。对主 App、Framework、appex 分批导出，避免在同一进程里同时执行远程注入、全量扫描和大文件回传。

### `appinst unavailable`

设备可以下载 IPA，但无法安装全新 App。Taurine 上安装 `ai.akemi.appinst`（会依赖 AppSync Unified），
确认 `/usr/bin/appinst` 可执行并且 `/api/node/info` 返回 `appinstInstall: true`。只安装 AppSync 不够，
它不提供 `appinst` CLI。

### `still_encrypted` 只列出 `.appex`

检查任务是否启用了扩展强制解密。完整模式的 runner 参数应包含：

```text
--force-extensions
```

若日志显示 `extension decryption disabled`，说明 iStoreOS 设备/设备组仍配置为“跳过应用扩展”。
改为“尝试解密应用扩展”后重新创建任务。旧任务不会自动改变已持久化的扩展策略。

### `Task interrupted while decrypting`

表示 daemon 在任务处于 `decrypting` 时被重启、升级或系统终止。先检查
`/var/tmp/unfaird/logs/unfaird.err`、Jetsam 记录和 launchd 状态；不要把该状态当成具体的
`mremap_encrypted` 错误。升级 deb 会重启 daemon，因此应在没有运行中任务时操作。

### `Bad executable (or shared library)` / error 85

砸壳会改变 Mach-O 内容并使原代码签名失效。该错误属于后续签名/安装阶段，不代表砸壳数据错误。若需要安装输出 IPA，应对所有嵌套 Framework、appex 和主程序按由内到外顺序重新签名。

## 安全说明

- 本项目面向个人设备和本地网络使用。
- Apple 凭据由浏览器账户管理流程提交给本地 Swift 后端。
- 不要提交真实账号、密码、设备标识符、LAN 地址或任务日志到仓库。
- 不要向公网暴露未配置认证的 Web UI/API。
