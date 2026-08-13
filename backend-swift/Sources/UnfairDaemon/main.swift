import ArgumentParser
import Foundation
import UnfairDaemonCore
import UnfairDaemonSupport
import UnfairKit
import Vapor

struct UnfairDaemonCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "UnfairDaemon",
        abstract: "Serve unfaird and run local IPA package processing.",
        subcommands: [Serve.self, Package.self, PermissionProbe.self],
        defaultSubcommand: Serve.self
    )
}

UnfairDaemonCommand.main()

struct Serve: ParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Run the unfaird HTTP service.")

    @ArgumentParser.Option(help: "Hostname to bind.")
    var hostname = "127.0.0.1"

    @ArgumentParser.Option(help: "Port to bind.")
    var port = 8080

    func run() throws {
        #if os(macOS)
        try checkSupportedOS()
        #endif
        #if os(iOS)
        do {
            try raiseJetsamLimit(megabytes: 1024)
        } catch {
            print("warning: jetsam limit raise failed: \(error)")
        }
        do {
            try raiseVnodeLimit(minimum: 65_536)
        } catch {
            print("warning: failed to raise vnode limit: \(error)")
        }
        #endif

        var env = try Environment.detect()
        try LoggingSystem.bootstrap(from: &env)

        let app = Application(env)
        defer { app.shutdown() }

        try configure(app, hostname: hostname, port: port)
        try app.run()
    }
}

struct Package: ParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Process an IPA package.")

    @ArgumentParser.Option(name: .customLong("input"), help: "Input .ipa path.")
    var input: String

    @ArgumentParser.Option(name: .customLong("output"), help: "Output .ipa path.")
    var output: String

    @ArgumentParser.Option(name: .customLong("working-directory"), help: "Scratch directory under /var/folders/bg/<token>/X.")
    var workingDirectory: String?

    @ArgumentParser.Flag(name: .long, help: "Show detailed UnfairKit logs.")
    var verbose = false

    @ArgumentParser.Flag(name: .customLong("force-extensions"), help: "Attempt to launch and decrypt app extensions.")
    var forceExtensions = false

    func run() throws {
        #if os(iOS)
        do {
            try raiseJetsamLimit(megabytes: 1024)
            if verbose {
                print("jetsam limit requested: 1024 MB")
            }
        } catch {
            print("warning: failed to raise jetsam limit: \(error)")
        }
        do {
            let vnodeLimit = try raiseVnodeLimit(minimum: 65_536)
            if verbose {
                print("vnode limit ready: \(vnodeLimit)")
            }
        } catch {
            print("warning: failed to raise vnode limit: \(error)")
        }
        #endif
        try PackageProcessor(logger: UnfairLogger(verbose: verbose) { message in
            print(message)
        }).process(
            input: fileURL(input),
            output: fileURL(output),
            workingDirectory: workingDirectory.map(fileURL),
            forceExtensions: forceExtensions
        )
    }
}

struct PermissionProbe: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "permission-probe",
        abstract: "Verify the jailbreak permission provider without installing or decrypting an IPA."
    )

    func run() throws {
        try UnfairProcessPermissions.prepareForAppBundleDecryption(
            logger: UnfairLogger(verbose: true) { message in
                print(message)
            }
        )
        print("permission-probe: ok")
    }
}

private func fileURL(_ path: String) -> URL {
    URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
}

private func raiseJetsamLimit(megabytes: Int32) throws {
    var message = [CChar](repeating: 0, count: 512)
    let result = message.withUnsafeMutableBufferPointer { buffer in
        unfaird_raise_jetsam_limit(megabytes, buffer.baseAddress, buffer.count)
    }
    guard result == 0 else {
        throw ValidationError(String(cString: message))
    }
}

@discardableResult
private func raiseVnodeLimit(minimum: Int32) throws -> Int32 {
    var current: Int32 = 0
    var currentSize = MemoryLayout<Int32>.size
    guard sysctlbyname("kern.maxvnodes", &current, &currentSize, nil, 0) == 0 else {
        throw ValidationError("read kern.maxvnodes failed: \(String(cString: strerror(errno)))")
    }
    guard current < minimum else {
        return current
    }

    var requested = minimum
    guard sysctlbyname(
        "kern.maxvnodes",
        nil,
        nil,
        &requested,
        MemoryLayout<Int32>.size
    ) == 0 else {
        throw ValidationError("set kern.maxvnodes failed: \(String(cString: strerror(errno)))")
    }
    return requested
}

private func checkSupportedOS() throws {
    let supportedMaximumVersion = OperatingSystemVersion(majorVersion: 11, minorVersion: 2, patchVersion: 3)
    let currentVersion = ProcessInfo.processInfo.operatingSystemVersion
    guard currentVersion.isGreater(than: supportedMaximumVersion) == false else {
        let message = "unfaird supports macOS 11.2.3 or earlier; current macOS is \(currentVersion.displayString)"
        throw ValidationError(message)
    }
}

private extension OperatingSystemVersion {
    func isGreater(than other: OperatingSystemVersion) -> Bool {
        if majorVersion != other.majorVersion {
            return majorVersion > other.majorVersion
        }
        if minorVersion != other.minorVersion {
            return minorVersion > other.minorVersion
        }
        return patchVersion > other.patchVersion
    }

    var displayString: String {
        "\(majorVersion).\(minorVersion).\(patchVersion)"
    }
}
