import Foundation
import Vapor

final class WebDownloadManager {
    private final class TaskRecord {
        var task: DownloadTask
        var sessionTask: URLSessionTask?
        var processCancellation: PosixSpawnCancellation?

        init(task: DownloadTask) {
            self.task = task
        }
    }

    private static let maxTaskLogLines = 200

    private let config: WebConfig
    private let lock = NSLock()
    private let queue = DeviceTaskQueue.shared
    private var tasks: [String: TaskRecord] = [:]

    init(config: WebConfig) throws {
        self.config = config
        try FileManager.default.createDirectory(at: packagesDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: config.dataDirectory, withIntermediateDirectories: true)
        try loadPersistedTasks()
        cleanOrphanedPackages()
        resumeRecoverableDecryptions()
    }

    func allTasks() -> [DownloadTask] {
        lock.lock()
        defer { lock.unlock() }
        return tasks.values.map { sanitized($0.task) }
    }

    func task(id: String) -> DownloadTask? {
        lock.lock()
        defer { lock.unlock() }
        guard let record = tasks[id] else {
            return nil
        }
        return sanitized(record.task)
    }

    func completedTask(id: String) -> DownloadTask? {
        lock.lock()
        defer { lock.unlock() }
        guard let task = tasks[id]?.task,
              task.status == DownloadStatus.completed.rawValue,
              let filePath = task.filePath,
              fileExists(filePath)
        else {
            return nil
        }
        return task
    }

    func packageInfos(accountHashes: Set<String>) -> [PackageInfo] {
        lock.lock()
        let values = tasks.values.map(\.task)
        lock.unlock()

        return values.compactMap { task in
            guard task.status == DownloadStatus.completed.rawValue,
                  let filePath = task.filePath,
                  accountHashes.contains(task.accountHash)
            else {
                return nil
            }
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: filePath),
                  let fileSize = attributes[.size] as? NSNumber
            else {
                return nil
            }
            return PackageInfo(
                id: task.id,
                software: task.software,
                accountHash: task.accountHash,
                fileSize: fileSize.int64Value,
                createdAt: task.createdAt
            )
        }
    }

    func createTask(
        _ request: CreateDownloadRequest,
        validateAppleURL: Bool = true,
        forceExtensionDecryption: Bool? = nil,
        extensionDecryptionPolicy: ExtensionDecryptionPolicy? = nil
    ) throws -> DownloadTask {
        if validateAppleURL {
            try validateDownloadURL(request.downloadURL)
        }
        _ = try sanitizePathSegment(request.accountHash, label: "accountHash")
        _ = try sanitizePathSegment(request.software.bundleID, label: "bundleID")
        _ = try sanitizePathSegment(request.software.version, label: "version")

        if config.maxDownloadMB > 0 {
            let size = try fetchDownloadSizeBytes(request.downloadURL)
            guard size > 0 else {
                throw Abort(.badRequest, reason: "Unable to verify file size from Apple")
            }
            guard size <= Int64(config.maxDownloadMB) * 1024 * 1024 else {
                throw Abort(.payloadTooLarge, reason: "File size exceeds the maximum limit of \(config.maxDownloadMB) MB")
            }
        }

        let id = UUID().uuidString
        let task = DownloadTask(
            id: id,
            software: request.software,
            accountHash: request.accountHash,
            downloadURL: request.downloadURL,
            sinfs: request.sinfs,
            iTunesMetadata: request.iTunesMetadata,
            status: DownloadStatus.pending.rawValue,
            progress: 0,
            speed: "0 B/s",
            error: nil,
            logs: nil,
            filePath: nil,
            createdAt: currentTimestampString(),
            hasFile: nil,
            forceExtensionDecryption: forceExtensionDecryption,
            extensionDecryptionPolicy: ExtensionDecryptionPolicy.resolved(
                explicit: extensionDecryptionPolicy,
                legacyForce: forceExtensionDecryption
            )
        )
        var loggedTask = task
        appendLogLocked(to: &loggedTask, phase: "download", message: "queued \(request.software.name) \(request.software.version)")

        lock.lock()
        tasks[id] = TaskRecord(task: loggedTask)
        lock.unlock()

        startDownload(id: id)
        return self.task(id: id) ?? loggedTask
    }

    func createExternalURLTask(_ request: CreateExternalURLDownloadRequest) throws -> DownloadTask {
        try validateExternalSourceURL(request.sourceURL)
        return try createTask(CreateDownloadRequest(
            software: request.software,
            accountHash: request.accountHash,
            downloadURL: request.sourceURL,
            sinfs: request.sinfs,
            iTunesMetadata: request.iTunesMetadata
        ), validateAppleURL: false,
           forceExtensionDecryption: request.forceExtensionDecryption,
           extensionDecryptionPolicy: request.extensionDecryptionPolicy)
    }

    func deleteTask(id: String) -> Bool {
        lock.lock()
        guard let record = tasks[id] else {
            lock.unlock()
            return false
        }
        record.sessionTask?.cancel()
        record.processCancellation?.cancel()
        let filePath = record.task.filePath
        tasks.removeValue(forKey: id)
        lock.unlock()

        deletePackageFile(path: filePath)
        try? FileManager.default.removeItem(at: checkpointURL(for: id))
        persistTasks()
        return true
    }

    func pauseTask(id: String) -> Bool {
        lock.lock()
        guard let record = tasks[id],
              record.task.status == DownloadStatus.downloading.rawValue ||
                record.task.status == DownloadStatus.decrypting.rawValue
        else {
            lock.unlock()
            return false
        }
        record.sessionTask?.cancel()
        record.processCancellation?.cancel()
        record.sessionTask = nil
        record.task.status = DownloadStatus.paused.rawValue
        record.task.speed = "0 B/s"
        appendLogLocked(to: &record.task, phase: "download", message: "paused")
        lock.unlock()
        persistTasks()
        return true
    }

    func resumeTask(id: String) -> Bool {
        lock.lock()
        guard let record = tasks[id],
              record.task.status == DownloadStatus.paused.rawValue
        else {
            lock.unlock()
            return false
        }
        let canResumeDecrypt = record.task.downloadURL == nil &&
            record.task.decryptCheckpoint != nil &&
            record.task.filePath.map(fileExists) == true
        lock.unlock()
        if canResumeDecrypt {
            startDecryptOnly(id: id)
        } else {
            startDownload(id: id)
        }
        return true
    }

    private func resumeRecoverableDecryptions() {
        lock.lock()
        let ids = tasks.values.compactMap { record -> String? in
            let task = record.task
            guard task.status == DownloadStatus.paused.rawValue,
                  task.decryptCheckpoint != nil,
                  task.filePath.map(fileExists) == true
            else { return nil }
            return task.id
        }
        lock.unlock()
        for id in ids {
            appendLog(id: id, phase: "decrypt", message: "resuming persisted checkpoint after daemon restart")
            startDecryptOnly(id: id)
        }
    }

    private func startDecryptOnly(id: String) {
        lock.lock()
        guard let record = tasks[id],
              let filePath = record.task.filePath,
              fileExists(filePath)
        else {
            lock.unlock()
            return
        }
        let bundleID = record.task.software.bundleID
        record.task.status = DownloadStatus.decrypting.rawValue
        record.task.error = nil
        record.task.errorCode = nil
        appendLogLocked(to: &record.task, phase: "decrypt", message: "queued persisted package for resume")
        lock.unlock()
        persistTasks()

        queue.async {
            do {
                let packageSize = ((try? FileManager.default.attributesOfItem(atPath: filePath)[.size]) as? NSNumber)?.int64Value ?? 0
                let storageReservation = try DecryptTaskGate.shared.reserve(
                    workDirectory: self.packagesDirectory,
                    bytesPerTask: StorageBudget.requiredBytes(packageSize: packageSize)
                )
                defer { storageReservation.release() }
                guard let bundleLease = BundleTaskGate.shared.tryAcquire(bundleID: bundleID) else {
                    throw Abort(.conflict, reason: "another task is processing this bundle")
                }
                defer { bundleLease.release() }
                let ipaURL = URL(fileURLWithPath: filePath)
                try self.decryptInPlace(ipaURL, taskID: id)
                let sha256 = try ArtifactDigest.sha256(of: ipaURL)
                self.updateTask(id: id) { task in
                    task.status = DownloadStatus.completed.rawValue
                    task.progress = 100
                    task.speed = "0 B/s"
                    task.sha256 = sha256
                    task.error = nil
                    task.errorCode = nil
                    task.decryptCheckpoint = nil
                    task.sessionFieldsCleared()
                    self.appendLogLocked(to: &task, phase: "verify", message: "sha256 \(sha256)")
                    self.appendLogLocked(to: &task, phase: "download", message: "completed after resume")
                }
                self.persistTasks()
            } catch {
                if self.isPaused(id: id) { return }
                let message = "Decrypt failed: \(self.errorDescription(error))"
                self.updateTask(id: id) { task in
                    task.status = DownloadStatus.failed.rawValue
                    task.error = message
                    task.errorCode = DecryptFailureClassifier.code(for: error, message: message)
                    task.speed = "0 B/s"
                    self.appendLogLocked(to: &task, phase: "decrypt", message: "resume failed: \(self.errorDescription(error))")
                }
                self.persistTasks()
            }
        }
    }

    func deletePackageFile(id: String) -> Bool {
        lock.lock()
        let path = tasks[id]?.task.filePath
        lock.unlock()
        guard let path = path else {
            return false
        }
        deletePackageFile(path: path)
        return true
    }

    func ensureSimulatorIpa(taskID id: String) throws -> URL {
        lock.lock()
        guard let task = tasks[id]?.task,
              task.status == DownloadStatus.completed.rawValue,
              let filePath = task.filePath,
              fileExists(filePath)
        else {
            lock.unlock()
            throw Abort(.notFound, reason: "Package not found")
        }
        let sourceURL = URL(fileURLWithPath: filePath)
        lock.unlock()

        appendLog(id: id, phase: "patch-sim", message: "requested simulator IPA")
        do {
            let simulatorURL = try SimulatorIPABuilder.ensureSimulatorIpa(sourceURL: sourceURL) { [weak self] message in
                self?.appendLog(id: id, phase: "patch-sim", message: message)
            }
            appendLog(id: id, phase: "patch-sim", message: "ready \(simulatorURL.lastPathComponent)")
            persistTasks()
            return simulatorURL
        } catch {
            appendLog(id: id, phase: "patch-sim", message: "failed: \(errorDescription(error))")
            persistTasks()
            throw error
        }
    }

    var packagesDirectory: URL {
        config.dataDirectory.appendingPathComponent("packages", isDirectory: true)
    }

    private var tasksFile: URL {
        config.dataDirectory.appendingPathComponent("tasks.json")
    }

    private func startDownload(id: String) {
        runTimeCleanup()
        runSpaceCleanup()

        lock.lock()
        guard let record = tasks[id],
              let downloadURL = record.task.downloadURL
        else {
            lock.unlock()
            return
        }

        let sinfs = record.task.sinfs ?? []
        let iTunesMetadata = record.task.iTunesMetadata
        let requestBundleID = record.task.software.bundleID
        record.task.status = DownloadStatus.pending.rawValue
        record.task.progress = 0
        record.task.speed = "0 B/s"
        record.task.error = nil
        record.task.errorCode = nil
        appendLogLocked(to: &record.task, phase: "download", message: "waiting for device task slot")
        lock.unlock()
        persistTasks()

        queue.async {
            var stage = "Download"
            do {
                self.lock.lock()
                guard let queuedRecord = self.tasks[id],
                      queuedRecord.task.status == DownloadStatus.pending.rawValue
                else {
                    self.lock.unlock()
                    return
                }
                do {
                    queuedRecord.task.filePath = try self.taskFileURL(for: queuedRecord.task).path
                } catch {
                    queuedRecord.task.status = DownloadStatus.failed.rawValue
                    queuedRecord.task.error = self.errorDescription(error)
                    self.appendLogLocked(to: &queuedRecord.task, phase: "download", message: "failed: \(self.errorDescription(error))")
                    self.lock.unlock()
                    self.persistTasks()
                    return
                }
                let filePath = queuedRecord.task.filePath ?? ""
                queuedRecord.task.status = DownloadStatus.downloading.rawValue
                queuedRecord.task.progress = 0
                queuedRecord.task.speed = "0 B/s"
                self.appendLogLocked(to: &queuedRecord.task, phase: "download", message: "device slot acquired; starting IPA download")
                self.lock.unlock()
                self.persistTasks()

                try FileManager.default.createDirectory(
                    at: URL(fileURLWithPath: filePath).deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try self.download(urlString: downloadURL, to: URL(fileURLWithPath: filePath), taskID: id)

                if sinfs.isEmpty == false {
                    stage = "SINF injection"
                    self.updateTask(id: id) { task in
                        task.status = DownloadStatus.injecting.rawValue
                        task.progress = 100
                        task.speed = "0 B/s"
                        self.appendLogLocked(to: &task, phase: "download", message: "injecting SINF and iTunesMetadata")
                    }
                    self.persistTasks()
                    try SinfInjector.inject(sinfs: sinfs, ipaURL: URL(fileURLWithPath: filePath), iTunesMetadata: iTunesMetadata)
                    self.appendLog(id: id, phase: "download", message: "SINF injection complete")
                }

                stage = "Decrypt"
                self.updateTask(id: id) { task in
                    task.status = DownloadStatus.decrypting.rawValue
                    task.progress = 100
                    task.speed = "0 B/s"
                    self.appendLogLocked(to: &task, phase: "decrypt", message: "running unfaird package processor")
                }
                self.persistTasks()
                let packageSize = ((try? FileManager.default.attributesOfItem(atPath: filePath)[.size]) as? NSNumber)?.int64Value ?? 0
                let storageReservation = try DecryptTaskGate.shared.reserve(
                    workDirectory: self.packagesDirectory,
                    bytesPerTask: StorageBudget.requiredBytes(packageSize: packageSize)
                )
                defer { storageReservation.release() }
                guard let bundleLease = BundleTaskGate.shared.tryAcquire(bundleID: requestBundleID) else {
                    throw Abort(.conflict, reason: "another task is processing this bundle")
                }
                defer { bundleLease.release() }
                try self.decryptInPlace(URL(fileURLWithPath: filePath), taskID: id)
                let sha256 = try ArtifactDigest.sha256(of: URL(fileURLWithPath: filePath))

                self.updateTask(id: id) { task in
                    task.status = DownloadStatus.completed.rawValue
                    task.progress = 100
                    task.speed = "0 B/s"
                    task.downloadURL = nil
                    task.sinfs = nil
                    task.iTunesMetadata = nil
                    task.sha256 = sha256
                    task.errorCode = nil
                    task.decryptCheckpoint = nil
                    task.sessionFieldsCleared()
                    self.appendLogLocked(to: &task, phase: "verify", message: "sha256 \(sha256)")
                    self.appendLogLocked(to: &task, phase: "download", message: "completed")
                }
                self.persistTasks()
            } catch {
                if self.isPaused(id: id) {
                    self.persistTasks()
                    return
                }
                let failureMessage = "\(stage) failed: \(self.errorDescription(error))"
                let failureCode = DecryptFailureClassifier.code(for: error, message: failureMessage)
                let failurePhase = self.logPhase(forStage: stage)
                self.updateTask(id: id) { task in
                    task.status = DownloadStatus.failed.rawValue
                    task.error = failureMessage
                    task.errorCode = failureCode
                    task.speed = "0 B/s"
                    task.sessionFieldsCleared()
                    self.appendLogLocked(to: &task, phase: failurePhase, message: "failed: \(self.errorDescription(error))")
                }
                self.persistTasks()
            }
        }
    }

    private func download(urlString: String, to destination: URL, taskID: String) throws {
        guard let url = URL(string: urlString) else {
            throw Abort(.badRequest, reason: "invalid download URL")
        }

        let delegate = WebDownloadDelegate(
            destination: destination,
            maxBytes: WebConfig.maxDownloadBytes,
            progress: { [weak self] written, expected, elapsed, delta in
                self?.reportProgress(id: taskID, downloaded: written, total: expected, elapsed: elapsed, delta: delta)
            }
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = TimeInterval(WebConfig.downloadTimeoutSeconds)
        let operationQueue = OperationQueue()
        operationQueue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: operationQueue)
        defer {
            session.invalidateAndCancel()
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        let task = session.downloadTask(with: request)
        lock.lock()
        tasks[taskID]?.sessionTask = task
        lock.unlock()
        defer {
            lock.lock()
            tasks[taskID]?.sessionTask = nil
            lock.unlock()
        }
        task.resume()
        try delegate.wait()
        appendLog(id: taskID, phase: "download", message: "download complete")
    }

    private func decryptInPlace(_ ipaURL: URL, taskID: String) throws {
        let cancellation = PosixSpawnCancellation()
        lock.lock()
        guard tasks[taskID]?.task.status == DownloadStatus.decrypting.rawValue else {
            lock.unlock()
            throw Abort(.conflict, reason: "decrypt cancelled")
        }
        tasks[taskID]?.processCancellation = cancellation
        lock.unlock()
        defer {
            lock.lock()
            if tasks[taskID]?.processCancellation === cancellation {
                tasks[taskID]?.processCancellation = nil
            }
            lock.unlock()
        }
        let decryptID = UUID(uuidString: taskID) ?? UUID()
        let jobsRoot = URL(fileURLWithPath: "/var/tmp/unfaird/jobs", isDirectory: true)
        let jobDirectory = jobsRoot.appendingPathComponent(decryptID.uuidString, isDirectory: true)
        let packageWorkingDirectory = try PackageRunnerSandbox.packageWorkingDirectory(for: decryptID)
        let outputURL = ipaURL.deletingLastPathComponent()
            .appendingPathComponent(".\(taskID).decrypted.ipa")

        try FileManager.default.createDirectory(at: jobDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: packageWorkingDirectory, withIntermediateDirectories: true)
        var completedSuccessfully = false
        defer {
            try? FileManager.default.removeItem(at: jobDirectory)
            try? FileManager.default.removeItem(at: packageWorkingDirectory)
            try? FileManager.default.removeItem(at: outputURL)
            if completedSuccessfully {
                try? FileManager.default.removeItem(at: checkpointURL(for: taskID))
            }
        }

        let sandboxProfileURL = try PackageRunnerSandbox.writeProfile(jobDirectory: jobDirectory)
        let fileSize = ((try? FileManager.default.attributesOfItem(atPath: ipaURL.path)[.size]) as? NSNumber)?.int64Value ?? 0
        let timeoutSeconds = DecryptTimeoutPolicy.seconds(fileSize: fileSize)
        appendLog(id: taskID, phase: "decrypt", message: "timeout budget \(timeoutSeconds) seconds")
        let currentRunnerPath = currentExecutablePath()
        let runnerPath = PackageRunnerResolver.executablePath(
            currentExecutablePath: currentRunnerPath
        )
        lock.lock()
        let storedPolicy = tasks[taskID]?.task.extensionDecryptionPolicy
        let legacyForce = tasks[taskID]?.task.forceExtensionDecryption
        lock.unlock()
        let extensionPolicy = ExtensionDecryptionPolicy.resolved(explicit: storedPolicy, legacyForce: legacyForce)
        let supportsResumableBatches = PackageRunnerResolver.supportsResumableBatches()
        let inputSize = ((try? FileManager.default.attributesOfItem(atPath: ipaURL.path)[.size]) as? NSNumber)?.int64Value ?? 0
        let loadedCheckpoint = loadCheckpoint(taskID: taskID)
        var checkpoint = (loadedCheckpoint?.schemaVersion == DecryptCheckpoint.currentSchemaVersion &&
            loadedCheckpoint?.inputSize == inputSize) ? loadedCheckpoint! : DecryptCheckpoint(
            phase: .preparing,
            inputSize: inputSize,
            attempt: 1,
            batchSize: AdaptiveBatchPolicy.initialBatchSize,
            completedMachOCount: 0,
            totalMachOCount: nil,
            currentPath: nil,
            updatedAt: currentTimestampString()
        )
        saveCheckpoint(checkpoint, taskID: taskID)
        appendLog(id: taskID, phase: "decrypt", message: "package runner: \(runnerPath)")
        var result: PosixSpawnResult
        while true {
            checkpoint.phase = .decrypting
            checkpoint.updatedAt = currentTimestampString()
            saveCheckpoint(checkpoint, taskID: taskID)
            result = try PosixSpawn.run(
                executablePath: runnerPath,
                arguments: PackageRunnerResolver.arguments(
                    inputPath: ipaURL.path,
                    outputPath: outputURL.path,
                    workingDirectoryPath: packageWorkingDirectory.path,
                    extensionPolicy: extensionPolicy,
                    supportsExtensionPolicy: runnerPath != currentRunnerPath,
                    batchSize: checkpoint.batchSize,
                    checkpointPath: checkpointURL(for: taskID).path,
                    supportsResumableBatches: supportsResumableBatches
                ),
                workingDirectory: jobDirectory,
                sandboxProfileURL: sandboxProfileURL,
                timeoutSeconds: timeoutSeconds,
                cancellation: cancellation,
                onOutputLine: { [weak self] stream, line in
                    self?.recordRunnerOutput(taskID: taskID, stream: stream, line: line)
                }
            )
            guard result.exitCode == 137,
                  supportsResumableBatches,
                  let smallerBatch = AdaptiveBatchPolicy.nextBatchSize(afterMemoryPressure: checkpoint.batchSize)
            else { break }
            checkpoint.attempt += 1
            checkpoint.batchSize = smallerBatch
            checkpoint.updatedAt = currentTimestampString()
            saveCheckpoint(checkpoint, taskID: taskID)
            appendLog(id: taskID, phase: "decrypt", message: "helper exit 137; retrying with batch size \(smallerBatch)")
        }

        if cancellation.isCancelled {
            throw Abort(.conflict, reason: "decrypt cancelled")
        }

        guard result.exitCode == 0, fileExists(outputURL.path) else {
            let message = result.stderrString.isEmpty ? "decrypt runner exited with code \(result.exitCode)" : result.stderrString
            appendLog(id: taskID, phase: "decrypt", message: "failed: \(message)")
            throw Abort(.internalServerError, reason: message)
        }

        let verification = try DecryptVerifier.verify(
            outputURL: outputURL,
            sourceURL: ipaURL,
            extensionPolicy: extensionPolicy
        )
        updateTask(id: taskID) { task in
            task.verification = verification
        }
        appendLog(
            id: taskID,
            phase: "verify",
            message: "verified \(verification.verifiedMachOCount)/\(verification.scannedMachOCount) Mach-O files"
        )
        try replacePackageFile(at: ipaURL, with: outputURL)
        completedSuccessfully = true
        appendLog(id: taskID, phase: "decrypt", message: "complete")
    }

    private func checkpointURL(for taskID: String) -> URL {
        config.dataDirectory
            .appendingPathComponent("checkpoints", isDirectory: true)
            .appendingPathComponent("\(taskID).json")
    }

    private func loadCheckpoint(taskID: String) -> DecryptCheckpoint? {
        let url = checkpointURL(for: taskID)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(DecryptCheckpoint.self, from: data)
    }

    private func saveCheckpoint(_ checkpoint: DecryptCheckpoint, taskID: String) {
        let url = checkpointURL(for: taskID)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(checkpoint).write(to: url, options: .atomic)
            updateTask(id: taskID) { task in task.decryptCheckpoint = checkpoint }
            persistTasks()
        } catch {
            appendLog(id: taskID, phase: "decrypt", message: "checkpoint write failed: \(errorDescription(error))")
        }
    }

    private func recordRunnerOutput(taskID: String, stream: PosixSpawn.OutputStream, line: String) {
        appendLog(id: taskID, phase: "decrypt", message: "\(outputStreamLabel(stream)): \(line)")
        guard stream == .stdout else { return }
        var checkpoint = loadCheckpoint(taskID: taskID) ?? DecryptCheckpoint(
            phase: .decrypting,
            attempt: 1,
            batchSize: AdaptiveBatchPolicy.initialBatchSize,
            completedMachOCount: 0,
            totalMachOCount: nil,
            currentPath: nil,
            updatedAt: currentTimestampString()
        )
        if let value = line.split(separator: ":").last,
           line.contains("mach-o binaries scanned:"),
           let total = Int(value.trimmingCharacters(in: .whitespaces)) {
            checkpoint.totalMachOCount = total
        } else if line.hasPrefix("decrypted: ") || line.hasPrefix("skipped: ") {
            checkpoint.completedMachOCount += 1
            checkpoint.currentPath = String(line.dropFirst(line.firstIndex(of: ":").map { line.distance(from: line.startIndex, to: $0) + 2 } ?? 0))
        } else {
            return
        }
        checkpoint.updatedAt = currentTimestampString()
        saveCheckpoint(checkpoint, taskID: taskID)
    }

    private func reportProgress(id: String, downloaded: Int64, total: Int64, elapsed: TimeInterval, delta: Int64) {
        let speed = elapsed > 0 && delta > 0 ? formatSpeed(bytesPerSecond: Double(delta) / elapsed) : "0 B/s"
        let progress = total > 0 ? Int(Double(downloaded) / Double(total) * 100) : 0
        lock.lock()
        if let record = tasks[id] {
            record.task.progress = progress
            record.task.speed = speed
        }
        lock.unlock()
    }

    private func updateTask(id: String, _ update: (inout DownloadTask) -> Void) {
        lock.lock()
        if let record = tasks[id] {
            update(&record.task)
        }
        lock.unlock()
    }

    private func appendLog(id: String, phase: String, message: String) {
        lock.lock()
        if let record = tasks[id] {
            appendLogLocked(to: &record.task, phase: phase, message: message)
        }
        lock.unlock()
    }

    private func appendLogLocked(to task: inout DownloadTask, phase: String, message: String) {
        var logs = task.logs ?? []
        logs.append("[\(logTimestamp())] \(phase): \(message)")
        if logs.count > Self.maxTaskLogLines {
            logs = Array(logs.suffix(Self.maxTaskLogLines))
        }
        task.logs = logs
    }

    private func logTimestamp() -> String {
        let components = Calendar.current.dateComponents([.hour, .minute, .second, .nanosecond], from: Date())
        return String(
            format: "%02d:%02d:%02d.%03d",
            components.hour!,
            components.minute!,
            components.second!,
            components.nanosecond! / 1_000_000
        )
    }

    private func logPhase(forStage stage: String) -> String {
        if stage.lowercased().contains("decrypt") {
            return "decrypt"
        }
        return "download"
    }

    private func outputStreamLabel(_ stream: PosixSpawn.OutputStream) -> String {
        switch stream {
        case .stdout:
            return "stdout"
        case .stderr:
            return "stderr"
        }
    }

    private func isPaused(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return tasks[id]?.task.status == DownloadStatus.paused.rawValue
    }

    private func sanitized(_ task: DownloadTask) -> DownloadTask {
        var output = task
        output.downloadURL = nil
        output.sinfs = nil
        output.iTunesMetadata = nil
        output.filePath = nil
        if let path = task.filePath {
            output.hasFile = fileExists(path)
        }
        return output
    }

    private func taskFileURL(for task: DownloadTask) throws -> URL {
        packagesDirectory
            .appendingPathComponent(try sanitizePathSegment(task.accountHash, label: "accountHash"), isDirectory: true)
            .appendingPathComponent(try sanitizePathSegment(task.software.bundleID, label: "bundleID"), isDirectory: true)
            .appendingPathComponent(try sanitizePathSegment(task.software.version, label: "version"), isDirectory: true)
            .appendingPathComponent("\(task.id).ipa")
    }

    private func loadPersistedTasks() throws {
        guard FileManager.default.fileExists(atPath: tasksFile.path) else {
            return
        }
        let data = try Data(contentsOf: tasksFile)
        let persisted = try JSONDecoder().decode([DownloadTask].self, from: data)
        var needsPersist = false
        for var task in persisted {
            task.sessionFieldsCleared()
            task.speed = "0 B/s"

            if task.status == DownloadStatus.completed.rawValue,
               let path = task.filePath,
               fileExists(path) {
                task.progress = 100
                task.speed = "0 B/s"
                tasks[task.id] = TaskRecord(task: task)
                continue
            }

            if task.status == DownloadStatus.completed.rawValue {
                task.status = DownloadStatus.failed.rawValue
                task.error = "Package file is missing."
                appendLogLocked(to: &task, phase: "download", message: "package file is missing")
                tasks[task.id] = TaskRecord(task: task)
                needsPersist = true
                continue
            }

            if task.status == DownloadStatus.failed.rawValue {
                tasks[task.id] = TaskRecord(task: task)
                continue
            }

            if task.status == DownloadStatus.decrypting.rawValue,
               task.decryptCheckpoint != nil,
               let path = task.filePath,
               fileExists(path) {
                task.status = DownloadStatus.paused.rawValue
                task.error = nil
                appendLogLocked(to: &task, phase: "decrypt", message: "checkpoint recovered; waiting to resume")
                tasks[task.id] = TaskRecord(task: task)
                needsPersist = true
                continue
            }

            if DownloadStatus(rawValue: task.status) != nil {
                let previousStatus = task.status
                task.status = DownloadStatus.failed.rawValue
                task.error = "Task interrupted while \(previousStatus)."
                appendLogLocked(to: &task, phase: logPhase(forStage: previousStatus.capitalized), message: "interrupted while \(previousStatus)")
                tasks[task.id] = TaskRecord(task: task)
                needsPersist = true
            }
        }
        if needsPersist {
            persistTasks()
        }
    }

    private func persistTasks() {
        lock.lock()
        let persisted = tasks.values.compactMap { record -> DownloadTask? in
            guard shouldPersist(record.task) else {
                return nil
            }
            var task = record.task
            task.downloadURL = nil
            task.sinfs = nil
            task.iTunesMetadata = nil
            return task
        }
        lock.unlock()

        do {
            let data = try JSONEncoder().encode(persisted)
            try data.write(to: tasksFile, options: .atomic)
        } catch {
            fputs("unfaird persist download tasks failed: \(error)\n", stderr)
        }
    }

    private func shouldPersist(_ task: DownloadTask) -> Bool {
        guard DownloadStatus(rawValue: task.status) != nil else {
            return false
        }
        return task.status != DownloadStatus.pending.rawValue || task.filePath != nil
    }

    private func cleanOrphanedPackages() {
        var known = Set<String>()
        for filePath in tasks.values.compactMap({ $0.task.filePath }) {
            let sourceURL = URL(fileURLWithPath: filePath).standardizedFileURL
            known.insert(sourceURL.path)
            known.insert(SimulatorIPABuilder.simulatorIpaURL(for: sourceURL).standardizedFileURL.path)
        }
        guard let enumerator = FileManager.default.enumerator(at: packagesDirectory, includingPropertiesForKeys: [.isDirectoryKey]) else {
            return
        }
        for case let url as URL in enumerator {
            guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == false else {
                continue
            }
            if known.contains(url.standardizedFileURL.path) == false {
                try? FileManager.default.removeItem(at: url)
            }
        }
        removeEmptyPackageDirectories()
    }

    private func removeEmptyPackageDirectories() {
        guard let enumerator = FileManager.default.enumerator(at: packagesDirectory, includingPropertiesForKeys: [.isDirectoryKey]) else {
            return
        }
        let directories = enumerator.compactMap { item -> URL? in
            guard let url = item as? URL,
                  (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            else {
                return nil
            }
            return url
        }.sorted { $0.path.count > $1.path.count }

        for directory in directories where directory.standardizedFileURL.path != packagesDirectory.standardizedFileURL.path {
            if (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)).map({ $0.isEmpty }) == true {
                try? FileManager.default.removeItem(at: directory)
            }
        }
    }

    private func runTimeCleanup() {
        guard config.autoCleanupDays > 0 else {
            return
        }
        let cutoff = Date().addingTimeInterval(-TimeInterval(config.autoCleanupDays) * 24 * 60 * 60)
        for task in completedTaskSnapshots() {
            guard let path = task.filePath,
                  let attributes = try? FileManager.default.attributesOfItem(atPath: path),
                  let modificationDate = attributes[.modificationDate] as? Date,
                  modificationDate < cutoff
            else {
                continue
            }
            _ = deleteTask(id: task.id)
        }
    }

    private func runSpaceCleanup() {
        guard config.autoCleanupMaxMB > 0 else {
            return
        }

        let limit = Int64(config.autoCleanupMaxMB) * 1024 * 1024
        let files = completedTaskSnapshots().compactMap { task -> (id: String, size: Int64, modificationDate: Date)? in
            guard let path = task.filePath,
                  let attributes = try? FileManager.default.attributesOfItem(atPath: path),
                  let size = attributes[.size] as? NSNumber,
                  let modificationDate = attributes[.modificationDate] as? Date
            else {
                return nil
            }
            let sourceURL = URL(fileURLWithPath: path)
            let simulatorURL = SimulatorIPABuilder.simulatorIpaURL(for: sourceURL)
            var totalSize = size.int64Value
            var latestModificationDate = modificationDate
            if let simulatorAttributes = try? FileManager.default.attributesOfItem(atPath: simulatorURL.path),
               let simulatorSize = simulatorAttributes[.size] as? NSNumber,
               let simulatorModificationDate = simulatorAttributes[.modificationDate] as? Date {
                totalSize += simulatorSize.int64Value
                latestModificationDate = max(latestModificationDate, simulatorModificationDate)
            }
            return (task.id, totalSize, latestModificationDate)
        }.sorted { $0.modificationDate < $1.modificationDate }

        var total = files.reduce(Int64(0)) { $0 + $1.size }
        for file in files where total > limit {
            _ = deleteTask(id: file.id)
            total -= file.size
        }
    }

    private func completedTaskSnapshots() -> [DownloadTask] {
        lock.lock()
        defer { lock.unlock() }
        return tasks.values.map(\.task).filter { $0.status == DownloadStatus.completed.rawValue && $0.filePath != nil }
    }

    private func deletePackageFile(path: String?) {
        guard let path = path else {
            return
        }
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
        let base = packagesDirectory.resolvingSymlinksInPath().standardizedFileURL
        guard resolved.path.hasPrefix(base.path + "/") else {
            return
        }
        let simulatorURL = SimulatorIPABuilder.simulatorIpaURL(for: resolved).standardizedFileURL
        if simulatorURL.path.hasPrefix(base.path + "/") {
            try? FileManager.default.removeItem(at: simulatorURL)
        }
        try? FileManager.default.removeItem(at: resolved)
    }

    private func replacePackageFile(at destination: URL, with source: URL) throws {
        _ = try FileManager.default.replaceItemAt(destination, withItemAt: source)
    }

    private func validateDownloadURL(_ rawValue: String) throws {
        guard let components = URLComponents(string: rawValue),
              components.scheme == "https",
              let host = components.host,
              host.isEmpty == false,
              URL(string: rawValue) != nil
        else {
            throw Abort(.badRequest, reason: "invalid download URL")
        }
        guard isIPAddressHost(host) == false else {
            throw Abort(.badRequest, reason: "download URL must use a hostname")
        }
        guard host.lowercased().hasSuffix(".apple.com") else {
            throw Abort(.badRequest, reason: "download URL must be from an Apple domain (*.apple.com)")
        }
    }

    private func validateExternalSourceURL(_ rawValue: String) throws {
        guard let components = URLComponents(string: rawValue),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(),
              host.isEmpty == false
        else {
            throw Abort(.badRequest, reason: "invalid external IPA URL")
        }
        guard isPrivateNetworkHost(host) else {
            throw Abort(.badRequest, reason: "external IPA URL must use a private LAN host")
        }
    }

    private func isPrivateNetworkHost(_ host: String) -> Bool {
        if host == "localhost" { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 ||
            (parts[0] == 172 && (16...31).contains(parts[1])) ||
            (parts[0] == 192 && parts[1] == 168) ||
            (parts[0] == 169 && parts[1] == 254)
    }

    private func fetchDownloadSizeBytes(_ rawValue: String) throws -> Int64 {
        guard let url = URL(string: rawValue) else {
            throw Abort(.badRequest, reason: "invalid download URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        let response = try HTTPSyncClient.shared.send(request)
        guard (200...299).contains(response.statusCode) else {
            throw Abort(.badGateway, reason: "Failed to verify file size from Apple")
        }
        return response.response.expectedContentLength
    }

    private func errorDescription(_ error: Error) -> String {
        if let abort = error as? AbortError {
            return abort.reason
        }
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return String(describing: error)
    }
}

private enum DownloadStatus: String {
    case pending
    case downloading
    case paused
    case injecting
    case decrypting
    case completed
    case failed
}

private extension DownloadTask {
    mutating func sessionFieldsCleared() {
        downloadURL = nil
        sinfs = nil
        iTunesMetadata = nil
    }
}

private final class WebDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let destination: URL
    private let maxBytes: Int64
    private let progress: (Int64, Int64, TimeInterval, Int64) -> Void
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var result: Result<Void, Error>?
    private var pendingError: Error?
    private var completed = false
    private var lastTime = Date()
    private var lastBytes: Int64 = 0

    init(destination: URL, maxBytes: Int64, progress: @escaping (Int64, Int64, TimeInterval, Int64) -> Void) {
        self.destination = destination
        self.maxBytes = maxBytes
        self.progress = progress
    }

    func wait() throws {
        semaphore.wait()
        switch result {
        case .success:
            return
        case .failure(let error):
            throw error
        case nil:
            throw Abort(.internalServerError, reason: "download finished without result")
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        if totalBytesWritten > maxBytes {
            pendingError = Abort(.payloadTooLarge, reason: "remote ipa limit is 8GB")
            downloadTask.cancel()
            return
        }
        let now = Date()
        let elapsed = now.timeIntervalSince(lastTime)
        if elapsed >= 0.5 {
            progress(totalBytesWritten, totalBytesExpectedToWrite, elapsed, totalBytesWritten - lastBytes)
            lastTime = now
            lastBytes = totalBytesWritten
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: location, to: destination)
        } catch {
            pendingError = error
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let http = task.response as? HTTPURLResponse,
           (200...299).contains(http.statusCode) == false {
            cleanupDestination()
            finish(.failure(Abort(.badGateway, reason: "IPA download returned HTTP \(http.statusCode)")))
            return
        }
        if let expectedLength = task.response?.expectedContentLength,
           expectedLength > maxBytes {
            cleanupDestination()
            finish(.failure(Abort(.payloadTooLarge, reason: "remote ipa limit is 8GB")))
            return
        }
        if let pendingError = pendingError {
            cleanupDestination()
            finish(.failure(pendingError))
            return
        }
        if let error = error {
            cleanupDestination()
            finish(.failure(error))
            return
        }
        finish(.success(()))
    }

    private func finish(_ result: Result<Void, Error>) {
        lock.lock()
        defer { lock.unlock() }
        guard completed == false else {
            return
        }
        completed = true
        self.result = result
        semaphore.signal()
    }

    private func cleanupDestination() {
        try? FileManager.default.removeItem(at: destination)
    }
}

final class HTTPSyncClient {
    static let shared = HTTPSyncClient()

    struct Result {
        let response: URLResponse
        let data: Data

        var statusCode: Int {
            (response as? HTTPURLResponse)?.statusCode ?? 0
        }
    }

    func send(_ request: URLRequest, timeout: TimeInterval = 30) throws -> Result {
        let semaphore = DispatchSemaphore(value: 0)
        var output: Swift.Result<Result, Error>?
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: configuration)
        let task = session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error = error {
                output = .failure(error)
                return
            }
            guard let response = response else {
                output = .failure(Abort(.badGateway, reason: "empty upstream response"))
                return
            }
            output = .success(Result(response: response, data: data ?? Data()))
        }
        task.resume()
        semaphore.wait()
        session.invalidateAndCancel()
        guard let output = output else {
            throw Abort(.requestTimeout, reason: "upstream request timed out")
        }
        return try output.get()
    }
}
