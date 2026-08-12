import Darwin
import Foundation
import Vapor

struct NodeInfoResponse: Content {
    struct Build: Content { let commit: String; let timestamp: String }
    struct Runtime: Content { let jailbreak: String; let provider: String }
    struct Storage: Content { let totalBytes: Int64?; let freeBytes: Int64? }
    struct Vnode: Content { let current: Int64?; let limit: Int64? }
    struct Capabilities: Content {
        let externalURLDownload: Bool
        let defaultAppleAccount: Bool
        let historicalVersions: Bool
        let extensionDecryption: Bool
        let appinstInstall: Bool
        let trollStoreInstall: Bool
        let structuredDecryptEvents: Bool
        let cryptidReport: Bool
        let resumableBatches: Bool
        let adaptiveBatchSize: Bool
        let extensionPolicies: [String]
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
        let fs = try? FileManager.default.attributesOfFileSystem(forPath: config.dataDirectory.path)
        return NodeInfoResponse(
            status: "ok",
            service: "unfaird",
            machineIdentifier: machine,
            modelName: modelName(machine),
            iosVersion: osVersion(),
            thermalState: thermalState(),
            build: Build(commit: BuildInfo.commit, timestamp: BuildInfo.timestamp),
            runtime: Runtime(jailbreak: jailbreakRuntime(), provider: decryptProvider()),
            storage: Storage(
                totalBytes: (fs?[.systemSize] as? NSNumber)?.int64Value,
                freeBytes: (fs?[.systemFreeSize] as? NSNumber)?.int64Value
            ),
            vnode: Vnode(current: sysctlInteger("kern.num_vnodes"), limit: sysctlInteger("kern.maxvnodes")),
            capabilities: Capabilities(
                externalURLDownload: true,
                defaultAppleAccount: true,
                historicalVersions: true,
                extensionDecryption: decryptProvider() != "unavailable",
                appinstInstall: executableExists(["/var/jb/usr/bin/appinst", "/usr/bin/appinst"]),
                trollStoreInstall: executableExists([
                    "/var/jb/Applications/TrollStoreLite.app/trollstorehelper",
                    "/Applications/TrollStoreLite.app/trollstorehelper"
                ]),
                structuredDecryptEvents: false,
                cryptidReport: true,
                resumableBatches: PackageRunnerResolver.supportsResumableBatches(),
                adaptiveBatchSize: true,
                extensionPolicies: ExtensionDecryptionPolicy.allCases.map(\.rawValue)
            )
        )
    }

    private static func executableExists(_ paths: [String]) -> Bool {
        paths.contains { access($0, X_OK) == 0 }
    }

    private static func jailbreakRuntime() -> String {
        if currentExecutablePath().contains("/var/jb/") { return "Dopamine/rootless" }
        if executableExists([
            "/usr/local/lib/unfaird/fouldecrypt.kernrw",
            "/usr/local/lib/unfaird/fouldecrypt",
        ]) || [
            "/usr/lib/libhooker.dylib",
            "/usr/lib/libkernrw.0.dylib",
            "/usr/lib/libkernrw.dylib",
            "/usr/lib/libiosexec.1.dylib",
            "/usr/lib/libdimentio.0.dylib",
        ].contains(where: fileExists) {
            return "Taurine/Procursus"
        }
        return "unknown-jailbreak"
    }

    private static func decryptProvider() -> String {
        if executableExists([
            "/usr/local/lib/unfaird/fouldecrypt.kernrw",
            "/var/jb/usr/local/lib/unfaird/fouldecrypt.kernrw"
        ]) {
            return "kernrw"
        }
        if fileExists("/var/jb/usr/lib/libjailbreak.dylib")
            || fileExists("/var/jb/basebin/libjailbreak.dylib")
            || fileExists("/basebin/libjailbreak.dylib")
            || fileExists("/usr/lib/libjailbreak.dylib") {
            return "builtin"
        }
        return "unavailable"
    }

    private static func osVersion() -> String {
        let value = ProcessInfo.processInfo.operatingSystemVersion
        return "\(value.majorVersion).\(value.minorVersion).\(value.patchVersion)"
    }

    private static func thermalState() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    private static func modelName(_ machine: String) -> String {
        [
            "iPhone10,2": "iPhone 8 Plus",
            "iPhone10,5": "iPhone 8 Plus",
            "iPhone12,1": "iPhone 11",
            "iPhone15,4": "iPhone 15",
            "iPhone15,5": "iPhone 15 Plus",
            "iPhone16,1": "iPhone 15 Pro",
            "iPhone16,2": "iPhone 15 Pro Max"
        ][machine] ?? machine
    }

    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 1 else { return nil }
        var value = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &value, &size, nil, 0) == 0 else { return nil }
        return String(cString: value)
    }

    private static func sysctlInteger(_ name: String) -> Int64? {
        var value: Int64 = 0
        var size = MemoryLayout<Int64>.size
        guard sysctlbyname(name, &value, &size, nil, 0) == 0 else { return nil }
        return value
    }
}
