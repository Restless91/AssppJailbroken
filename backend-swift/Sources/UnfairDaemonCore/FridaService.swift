import Foundation
import ZIPFoundation
import CFridaCore

// MARK: - On-Device Frida Decryption Service

/// Uses libfrida-core (linked statically into unfaird) via the frida_shim C bridge.
/// Connects to local frida-server on 127.0.0.1:27042 — no Mac, no posix_spawn.
final class FridaService {
    private let fridaHost: String
    private var ctx: OpaquePointer?
    private var dumpComplete = false
    private var dumpError: String?
    private let dumpLock = NSLock()

    init(fridaHost: String = "127.0.0.1:27042") {
        self.fridaHost = fridaHost
    }

    deinit {
        if let ctx = ctx {
            frida_shim_destroy(ctx)
        }
    }

    // MARK: - Public

    func decrypt(
        inputIPA: URL,
        outputIPA: URL,
        workingDirectory: URL,
        bundleID: String
    ) throws -> Bool {
        guard let ctx = try connect() else {
            throw FridaError.deviceNotConnected
        }

        // Step 1: Ensure app is running
        let pid = try ensureAppRunning(ctx: ctx, bundleID: bundleID)

        // Step 2: Attach
        try attach(ctx: ctx, pid: pid)

        // Step 3: Load dump script
        try loadDumpScript(ctx: ctx, bundleID: bundleID, outputDir: workingDirectory)

        // Step 4: Wait for dump and repack
        return try waitAndRepack(
            input: inputIPA,
            output: outputIPA,
            dumpDir: workingDirectory,
            bundleID: bundleID
        )
    }

    // MARK: - Private

    private func connect() throws -> OpaquePointer? {
        if let ctx = ctx { return ctx }

        guard let newCtx = frida_shim_init(fridaHost) else {
            throw FridaError.fridaCoreError("frida_shim_init failed")
        }
        self.ctx = newCtx

        // Test connection by listing apps
        var err: UnsafeMutablePointer<CChar>?
        let appsJson = frida_shim_list_apps(newCtx, &err)
        if let err = err {
            let msg = String(cString: err)
            frida_shim_free_string(err)
            throw FridaError.fridaCoreError("list apps: \(msg)")
        }
        if let json = appsJson {
            fputs("[frida] Connected. \(String(cString: json).prefix(100))...\n", stderr)
            frida_shim_free_string(json)
        }

        return newCtx
    }

    private func ensureAppRunning(ctx: OpaquePointer, bundleID: String) throws -> Int {
        var err: UnsafeMutablePointer<CChar>?

        // Check if already running
        let existingPid = frida_shim_get_app_pid(ctx, bundleID, &err)
        if let err = err {
            let msg = String(cString: err)
            frida_shim_free_string(err)
            fputs("[frida] get_app_pid warning: \(msg)\n", stderr)
        }
        if existingPid > 0 {
            fputs("[frida] App already running: \(bundleID) PID=\(existingPid)\n", stderr)
            return Int(existingPid)
        }

        // Spawn
        fputs("[frida] Spawning: \(bundleID)\n", stderr)
        let pid = frida_shim_spawn_app(ctx, bundleID, &err)
        if let err = err {
            let msg = String(cString: err)
            frida_shim_free_string(err)
            throw FridaError.spawnFailed("\(bundleID): \(msg)")
        }
        guard pid > 0 else {
            throw FridaError.spawnFailed(bundleID)
        }

        // Resume
        if !frida_shim_resume_app(ctx, pid, &err) {
            if let err = err {
                let msg = String(cString: err)
                frida_shim_free_string(err)
                fputs("[frida] resume warning: \(msg)\n", stderr)
            }
        }

        Thread.sleep(forTimeInterval: 3.0)
        fputs("[frida] Spawned PID=\(pid)\n", stderr)
        return Int(pid)
    }

    private func attach(ctx: OpaquePointer, pid: Int) throws {
        var err: UnsafeMutablePointer<CChar>?
        fputs("[frida] Attaching to PID \(pid)...\n", stderr)

        guard frida_shim_attach(ctx, Int32(pid), &err) else {
            let msg = err.map { String(cString: $0) } ?? "unknown"
            if let err = err { frida_shim_free_string(err) }
            throw FridaError.attachFailed(pid, msg)
        }
        fputs("[frida] Attached\n", stderr)
    }

    private func loadDumpScript(ctx: OpaquePointer, bundleID: String, outputDir: URL) throws {
        let js = Self.dumpJS(bundleID: bundleID, outputDir: outputDir.path)
        var err: UnsafeMutablePointer<CChar>?

        fputs("[frida] Loading dump script (\(js.count) bytes)...\n", stderr)

        guard frida_shim_load_script(ctx, js, &err) else {
            let msg = err.map { String(cString: $0) } ?? "unknown"
            if let err = err { frida_shim_free_string(err) }
            throw FridaError.scriptLoadFailed(msg)
        }

        // Set up message callback
        let handler = FridaMessageHandler()
        handler.onComplete = { [weak self] error in
            self?.dumpLock.lock()
            self?.dumpComplete = true
            self?.dumpError = error
            self?.dumpLock.unlock()
        }
        let handlerPtr = Unmanaged.passRetained(handler).toOpaque()

        frida_shim_set_message_callback(ctx, { (json, dataPtr, dataLen, userData) in
            guard let userData = userData else { return }
            let handler = Unmanaged<FridaMessageHandler>.fromOpaque(userData).takeUnretainedValue()
            let message = json != nil ? String(cString: json!) : ""

            if let data = dataPtr, dataLen > 0 {
                let nsData = Data(bytes: data, count: Int(dataLen))
                handler.onMessage(message: message, data: nsData)
            } else {
                handler.onMessage(message: message, data: nil)
            }
        }, handlerPtr)

        fputs("[frida] Script loaded, waiting for dump...\n", stderr)
    }

    private func waitAndRepack(
        input: URL,
        output: URL,
        dumpDir: URL,
        bundleID: String
    ) throws -> Bool {
        // Wait for dump completion (max 10 minutes)
        let deadline = Date().addingTimeInterval(600)
        while true {
            dumpLock.lock()
            let done = dumpComplete
            let err = dumpError
            dumpLock.unlock()

            if done {
                if let err = err {
                    throw FridaError.dumpScriptFailed(err)
                }
                break
            }
            if Date() > deadline {
                throw FridaError.timeout("Frida dump timed out after 10 minutes")
            }
            Thread.sleep(forTimeInterval: 1.0)
        }

        fputs("[frida] Dump complete, repacking IPA...\n", stderr)
        return try repackIPA(input: input, output: output, dumpDir: dumpDir, bundleID: bundleID)
    }

    private func repackIPA(input: URL, output: URL, dumpDir: URL, bundleID: String) throws -> Bool {
        let payloadDir = dumpDir.appendingPathComponent("Payload")
        let fm = FileManager.default

        guard fm.fileExists(atPath: payloadDir.path) else {
            fputs("[frida] No Payload directory at \(payloadDir.path)\n", stderr)
            return false
        }

        // Repack using ZIPFoundation (in-process, no Process spawn)
        let tmpOutput = dumpDir.appendingPathComponent("output.ipa")
        if fm.fileExists(atPath: tmpOutput.path) {
            try fm.removeItem(at: tmpOutput)
        }

        var files: [(relativePath: String, sourceURL: URL)] = []
        if let enumerator = fm.enumerator(at: payloadDir, includingPropertiesForKeys: [.isRegularFileKey]) {
            for case let fileURL as URL in enumerator {
                guard let resourceValues = try? fileURL.resourceValues(forKeys: [.isRegularFileKey]),
                      resourceValues.isRegularFile == true else { continue }
                let relativePath = fileURL.path.replacingOccurrences(of: payloadDir.path + "/", with: "")
                files.append((relativePath, fileURL))
            }
        }

        guard let archive = try? ZIPFoundation.Archive(url: tmpOutput, accessMode: ZIPFoundation.Archive.AccessMode.create) else {
            throw FridaError.zipFailed
        }

        let parentDir = payloadDir.deletingLastPathComponent()
        for (relativePath, _) in files {
            try archive.addEntry(
                with: relativePath,
                relativeTo: parentDir,
                compressionMethod: ZIPFoundation.CompressionMethod.deflate
            )
        }

        guard fm.fileExists(atPath: tmpOutput.path) else { return false }

        if fm.fileExists(atPath: output.path) {
            try fm.removeItem(at: output)
        }
        try fm.moveItem(at: tmpOutput, to: output)

        fputs("[frida] IPA repacked: \(output.path)\n", stderr)
        return true
    }

    // MARK: - Embedded Dump JS

    private static func dumpJS(bundleID: String, outputDir: String) -> String {
        let escapedDir = outputDir.replacingOccurrences(of: "\\", with: "\\\\")
        return """
        (function() {
            'use strict';
            const OUT = '\(escapedDir)';
            const BID = '\(bundleID)';

            function mkdir(p) {
                var dir = '';
                p.split('/').forEach(function(part) {
                    dir += (dir ? '/' : '') + part;
                    try { Module.ensureInitialized('Foundation'); } catch(e) {}
                    try {
                        var fm = ObjC.classes.NSFileManager.defaultManager();
                        fm.createDirectoryAtPath_withIntermediateDirectories_attributes_error_(
                            ObjC.classes.NSString.stringWithUTF8String_(Memory.allocUtf8String(dir)),
                            true, null, null
                        );
                    } catch(e) {}
                });
            }

            function dumpMod(name) {
                var mod = Process.findModuleByName(name);
                if (!mod) { send(JSON.stringify({s:'skip',n:name})); return; }

                var outFile = OUT + '/Payload/' + name.replace(/.*\\/[^/]+\\.app\\//, '');
                var outDir = outFile.substring(0, outFile.lastIndexOf('/'));
                mkdir(outDir);

                var f = new File(outFile, 'wb');
                f.write(Memory.readByteArray(mod.base, mod.size));
                f.close();
                send(JSON.stringify({s:'dump',n:name,z:mod.size}));
            }

            Process.enumerateModules({
                onMatch: function(m) { dumpMod(m.name); },
                onComplete: function() {
                    send(JSON.stringify({s:'p1'}));
                    setTimeout(function() {
                        Process.enumerateModules({
                            onMatch: function(m) { dumpMod(m.name); },
                            onComplete: function() { send(JSON.stringify({s:'done'})); }
                        });
                    }, 5000);
                }
            });
        })();
        """
    }
}

// MARK: - Message Handler

private class FridaMessageHandler {
    var onComplete: ((String?) -> Void)?

    func onMessage(message: String, data: Data?) {
        guard let jsonData = message.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let status = msg["s"] as? String
        else {
            // Check for error type
            if let jsonData = message.data(using: .utf8),
               let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               dict["type"] as? String == "error" {
                onComplete?(dict["description"] as? String ?? "frida error")
            }
            return
        }

        switch status {
        case "done":
            fputs("[frida-dump] All modules processed\n", stderr)
            onComplete?(nil)
        case "dump":
            let name = msg["n"] as? String ?? ""
            let size = msg["z"] as? Int ?? 0
            fputs("[frida-dump] \(name) (\(size) bytes)\n", stderr)
        case "skip":
            fputs("[frida-dump] Skip: \(msg["n"] as? String ?? "")\n", stderr)
        case "p1":
            fputs("[frida-dump] Phase 1 done, waiting for late loaders...\n", stderr)
        default:
            break
        }
    }
}

// MARK: - Errors

enum FridaError: Error, LocalizedError {
    case deviceNotConnected
    case spawnFailed(String)
    case attachFailed(Int, String)
    case scriptLoadFailed(String)
    case dumpScriptFailed(String)
    case timeout(String)
    case zipFailed
    case fridaCoreError(String)

    var errorDescription: String? {
        switch self {
        case .deviceNotConnected: return "Not connected to frida-server"
        case .spawnFailed(let id): return "Failed to spawn: \(id)"
        case .attachFailed(let pid, let msg): return "Attach PID \(pid): \(msg)"
        case .scriptLoadFailed(let msg): return "Script load: \(msg)"
        case .dumpScriptFailed(let msg): return "Dump failed: \(msg)"
        case .timeout(let msg): return "Timeout: \(msg)"
        case .zipFailed: return "Failed to create IPA"
        case .fridaCoreError(let msg): return "frida: \(msg)"
        }
    }
}
