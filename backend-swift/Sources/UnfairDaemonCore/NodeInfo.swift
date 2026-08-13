import Foundation
import Vapor

#if canImport(Darwin)
import Darwin
#endif

struct NodeInfoResponse: Content {
    struct Build: Content {
        let commit: String
        let timestamp: String
    }

    struct Runtime: Content {
        let jailbreak: String
        let provider: String
    }

    struct Storage: Content {
        let totalBytes: Int64?
        let freeBytes: Int64?
    }

    struct Vnode: Content {
        let current: Int64?
        let limit: Int64?
    }

    struct Capabilities: Content {
        let externalURLDownload: Bool
        let defaultAppleAccount: Bool
        let historicalVersions: Bool
        let extensionDecryption: Bool
        let appinstInstall: Bool
        let trollStoreInstall: Bool
        let structuredDecryptEvents: Bool
        let cryptidReport: Bool
    }

    let status: String
    let service: String
    let machineIdentifier: String
    let modelName: String
    let iosVersion: String
    let thermalState: String
    let build: Build
    let runtime: Runtime
    let storage: Storage
    let vnode: Vnode
    let capabilities: Capabilities

    static func current(config: WebConfig) -> NodeInfoResponse {
        let machine = sysctlString("hw.machine") ?? "unknown"
        let storage = storageInfo(path: config.dataDirectory.path)
        let executablePath = currentExecutablePath()
        let jailbreakRuntime = detectJailbreakRuntime(executablePath: executablePath)
        let decryptProvider = detectDecryptProvider(runtime: jailbreakRuntime)
        let install = installCapabilities(
            executablePath: executablePath,
            runtime: jailbreakRuntime
        )
        return NodeInfoResponse(
            status: "ok",
            service: "unfaird",
            machineIdentifier: machine,
            modelName: marketedModelName(machine),
            iosVersion: operatingSystemVersion(),
            thermalState: currentThermalState(),
            build: Build(commit: BuildInfo.commit, timestamp: BuildInfo.timestamp),
            runtime: Runtime(
                jailbreak: jailbreakRuntime,
                provider: decryptProvider
            ),
            storage: Storage(totalBytes: storage.total, freeBytes: storage.free),
            vnode: Vnode(
                current: sysctlInteger("kern.num_vnodes"),
                limit: sysctlInteger("kern.maxvnodes")
            ),
            capabilities: Capabilities(
                externalURLDownload: true,
                defaultAppleAccount: true,
                historicalVersions: true,
                extensionDecryption: true,
                appinstInstall: install.appinst,
                trollStoreInstall: install.trollStore,
                structuredDecryptEvents: true,
                cryptidReport: true
            )
        )
    }
}

func appinstCandidatePaths(executablePath: String) -> [String] {
    var candidates: [String] = [
        "/var/jb/usr/bin/appinst",
        "/usr/bin/appinst",
        "/bin/appinst",
    ]
    if let prefix = rootHidePrefixFromExecutable(executablePath) {
        // RootHide namespace binaries may not see stable package paths under
        // /var/mobile/AssppWebData. Prefer standard paths, use namespace paths
        // only as fallback.
        candidates.append("\(prefix)/usr/bin/appinst")
        candidates.append("\(prefix)/var/jb/usr/bin/appinst")
    }
    return candidates.reduce(into: []) { unique, path in
        if !unique.contains(path) {
            unique.append(path)
        }
    }
}

func trollStoreHelperCandidatePaths(executablePath: String) -> [String] {
    let standard = [
        "/var/jb/Applications/TrollStoreLite.app/trollstorehelper",
        "/Applications/TrollStoreLite.app/trollstorehelper",
        "/var/jb/Applications/TrollStore.app/trollstorehelper",
        "/Applications/TrollStore.app/trollstorehelper",
        "/var/jb/usr/local/bin/trollstorehelper",
        "/usr/local/bin/trollstorehelper",
    ]
    var candidates: [String] = []
    if let prefix = rootHidePrefixFromExecutable(executablePath) {
        candidates.append(contentsOf: standard.map { prefix + $0 })
    }
    candidates.append(contentsOf: standard)
    return candidates.reduce(into: []) { unique, path in
        if !unique.contains(path) {
            unique.append(path)
        }
    }
}

private func rootHidePrefixFromExecutable(_ executablePath: String) -> String? {
    guard let range = executablePath.range(of: "/.jbroot-") else {
        return nil
    }
    let suffix = executablePath[range.lowerBound...]
    guard let slash = suffix.dropFirst().firstIndex(of: "/") else {
        return nil
    }
    return String(executablePath[..<slash])
}

private func executableExists(_ path: String) -> Bool {
    #if canImport(Darwin)
    return access(path, X_OK) == 0
    #else
    return FileManager.default.isExecutableFile(atPath: path)
    #endif
}

func installCapabilities(
    executablePath: String,
    runtime: String,
    isExecutable: (String) -> Bool = executableExists
) -> (appinst: Bool, trollStore: Bool) {
    switch runtime {
    case "RootHide/Dopamine", "Dopamine/rootless", "Taurine/Procursus", "libjailbreak":
        return (
            appinst: appinstCandidatePaths(
                executablePath: executablePath
            ).contains(where: isExecutable),
            trollStore: trollStoreHelperCandidatePaths(
                executablePath: executablePath
            ).contains(where: isExecutable)
        )
    default:
        return (appinst: false, trollStore: false)
    }
}

private func operatingSystemVersion() -> String {
    let value = ProcessInfo.processInfo.operatingSystemVersion
    return "\(value.majorVersion).\(value.minorVersion).\(value.patchVersion)"
}

private func currentThermalState() -> String {
    if #available(iOS 11.0, macOS 10.10, *) {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
    return "unknown"
}

func detectJailbreakRuntime(
    executablePath: String = currentExecutablePath(),
    pathExists: (String) -> Bool = fileExists
) -> String {
    if executablePath.contains("/.jbroot-")
        || executablePath.contains("/.jbroot/")
        || (pathExists("/usr/lib/libroot.dylib") && pathExists("/basebin/jailbreakd"))
    {
        return "RootHide/Dopamine"
    }
    if executablePath.contains("/var/jb/") || pathExists("/var/jb/basebin/jailbreakd") {
        return "Dopamine/rootless"
    }
    if pathExists("/usr/lib/libhooker.dylib")
        || pathExists("/usr/lib/libkernrw.0.dylib")
    {
        return "Taurine/Procursus"
    }
    if pathExists("/usr/lib/libjailbreak.dylib")
        || pathExists("/var/jb/usr/lib/libjailbreak.dylib")
    {
        return "libjailbreak"
    }
    #if os(iOS)
    return "unknown-jailbreak"
    #else
    return "development"
    #endif
}

private func detectDecryptProvider(runtime: String) -> String {
    let candidates: [(String, String)] = [
        ("/usr/local/lib/unfaird/fouldecrypt.kernrw", "kernrw"),
        ("/var/jb/usr/local/lib/unfaird/fouldecrypt.kernrw", "kernrw"),
        ("/usr/local/lib/unfaird/fouldecrypt", "libjailbreak"),
        ("/var/jb/usr/local/lib/unfaird/fouldecrypt", "libjailbreak")
    ]
    if let provider = candidates.first(where: { access($0.0, X_OK) == 0 })?.1 {
        return provider
    }
    if runtime == "RootHide/Dopamine" {
        if fileExists("/basebin/libjailbreak.dylib") {
            return "libjailbreak (/basebin/libjailbreak.dylib)"
        }
        return "libjailbreak (builtin)"
    }
    return "builtin"
}

private func storageInfo(path: String) -> (total: Int64?, free: Int64?) {
    guard let values = try? FileManager.default.attributesOfFileSystem(forPath: path) else {
        return (nil, nil)
    }
    return (
        (values[.systemSize] as? NSNumber)?.int64Value,
        (values[.systemFreeSize] as? NSNumber)?.int64Value
    )
}

private func marketedModelName(_ machine: String) -> String {
    let known: [String: String] = [
        "iPhone10,1": "iPhone 8",
        "iPhone10,4": "iPhone 8",
        "iPhone10,2": "iPhone 8 Plus",
        "iPhone10,5": "iPhone 8 Plus",
        "iPhone10,3": "iPhone X",
        "iPhone10,6": "iPhone X",
        "iPhone11,8": "iPhone XR",
        "iPhone12,1": "iPhone 11",
        "iPhone12,3": "iPhone 11 Pro",
        "iPhone12,5": "iPhone 11 Pro Max",
        "iPhone13,1": "iPhone 12 mini",
        "iPhone13,2": "iPhone 12",
        "iPhone13,3": "iPhone 12 Pro",
        "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,4": "iPhone 13 mini",
        "iPhone14,5": "iPhone 13",
        "iPhone14,2": "iPhone 13 Pro",
        "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,6": "iPhone SE (3rd generation)",
        "iPhone14,7": "iPhone 14",
        "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro",
        "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15",
        "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro",
        "iPhone16,2": "iPhone 15 Pro Max"
    ]
    return known[machine] ?? machine
}

private func sysctlString(_ name: String) -> String? {
    #if canImport(Darwin)
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 1 else {
        return nil
    }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &bytes, &size, nil, 0) == 0 else {
        return nil
    }
    return String(cString: bytes)
    #else
    return nil
    #endif
}

private func sysctlInteger(_ name: String) -> Int64? {
    #if canImport(Darwin)
    var value: Int64 = 0
    var size = MemoryLayout<Int64>.size
    if sysctlbyname(name, &value, &size, nil, 0) == 0 {
        return value
    }
    var intValue: Int32 = 0
    size = MemoryLayout<Int32>.size
    guard sysctlbyname(name, &intValue, &size, nil, 0) == 0 else {
        return nil
    }
    return Int64(intValue)
    #else
    return nil
    #endif
}
