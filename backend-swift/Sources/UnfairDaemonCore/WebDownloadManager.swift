import Foundation
import Vapor

final class WebDownloadManager {
    private final class TaskRecord {
        var task: DownloadTask
        var sessionTasks: [URLSessionTask] = []

        init(task: DownloadTask) {
            self.task = task
        }
    }

    private static let maxTaskLogLines = 200

    private let config: WebConfig
    private let settingsStore: RuntimeSettingsStore
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "wiki.qaq.unfaird.assppweb-downloads")
    private let rangeQueue = DispatchQueue(label: "wiki.qaq.unfaird.assppweb-range-downloads", attributes: .concurrent)
    private var tasks: [String: TaskRecord] = [:]

    init(config: WebConfig, settingsStore: RuntimeSettingsStore) throws {
        self.config = config
        self.settingsStore = settingsStore
        try FileManager.default.createDirectory(at: packagesDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: config.dataDirectory, withIntermediateDirectories: true)
        try loadPersistedTasks()
        cleanOrphanedPackages()
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

    func createTask(_ request: CreateDownloadRequest) throws -> DownloadTask {
        try validateDownloadURL(request.downloadURL)
        return try createTask(
            software: request.software,
            accountHash: request.accountHash,
            downloadURL: request.downloadURL,
            sinfs: request.sinfs,
            iTunesMetadata: request.iTunesMetadata,
            forceExtensionDecryption: request.forceExtensionDecryption,
            preflightLogs: request.preflightLogs ?? [],
            sourceDescription: "queued \(request.software.name) \(request.software.version)",
            verifyAppleSize: true
        )
    }

    func createExternalURLTask(_ request: CreateExternalURLDownloadRequest) throws -> DownloadTask {
        try validateExternalSourceURL(request.sourceURL)
        return try createTask(
            software: request.software,
            accountHash: request.accountHash,
            downloadURL: request.sourceURL,
            sinfs: request.sinfs,
            iTunesMetadata: request.iTunesMetadata,
            forceExtensionDecryption: request.forceExtensionDecryption,
            preflightLogs: [],
            sourceDescription: "queued external IPA \(request.software.name) \(request.software.version)",
            verifyAppleSize: false
        )
    }

    private func createTask(
        software: Software,
        accountHash: String,
        downloadURL: String,
        sinfs: [Sinf],
        iTunesMetadata: String?,
        forceExtensionDecryption: Bool?,
        preflightLogs: [String],
        sourceDescription: String,
        verifyAppleSize: Bool
    ) throws -> DownloadTask {
        _ = try sanitizePathSegment(accountHash, label: "accountHash")
        _ = try sanitizePathSegment(software.bundleID, label: "bundleID")
        _ = try sanitizePathSegment(software.version, label: "version")

        let effectiveSettings = settingsStore.effectiveSettings()
        let maxDownloadMB = effectiveSettings.maxDownloadMB
        if verifyAppleSize, maxDownloadMB > 0 {
            let size = try fetchDownloadSizeBytes(downloadURL)
            guard size > 0 else {
                throw Abort(.badRequest, reason: "Unable to verify file size from Apple")
            }
            guard size <= Int64(maxDownloadMB) * 1024 * 1024 else {
                throw Abort(.payloadTooLarge, reason: "File size exceeds the maximum limit of \(maxDownloadMB) MB")
            }
        }

        let id = UUID().uuidString
        let task = DownloadTask(
            id: id,
            software: software,
            accountHash: accountHash,
            downloadURL: downloadURL,
            sinfs: sinfs,
            iTunesMetadata: iTunesMetadata,
            status: DownloadStatus.pending.rawValue,
            progress: 0,
            speed: "0 B/s",
            error: nil,
            logs: nil,
            decryptEvents: nil,
            forceExtensionDecryption: forceExtensionDecryption ?? effectiveSettings.forceExtensionDecryption,
            filePath: nil,
            createdAt: currentTimestampString(),
            hasFile: nil
        )
        var loggedTask = task
        appendLogLocked(to: &loggedTask, phase: "download", message: sourceDescription)
        for message in preflightLogs {
            appendLogLocked(to: &loggedTask, phase: "compatibility", message: message)
        }

        lock.lock()
        tasks[id] = TaskRecord(task: loggedTask)
        lock.unlock()

        startDownload(id: id)
        return self.task(id: id) ?? loggedTask
    }

    func deleteTask(id: String) -> Bool {
        lock.lock()
        guard let record = tasks[id] else {
            lock.unlock()
            return false
        }
        record.sessionTasks.forEach { $0.cancel() }
        record.sessionTasks.removeAll()
        let filePath = record.task.filePath
        tasks.removeValue(forKey: id)
        lock.unlock()

        deletePackageFile(path: filePath)
        persistTasks()
        return true
    }

    func pauseTask(id: String) -> Bool {
        lock.lock()
        guard let record = tasks[id],
              record.task.status == DownloadStatus.downloading.rawValue
        else {
            lock.unlock()
            return false
        }
        record.sessionTasks.forEach { $0.cancel() }
        record.sessionTasks.removeAll()
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
        lock.unlock()
        startDownload(id: id)
        return true
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

        do {
            record.task.status = DownloadStatus.downloading.rawValue
            record.task.progress = 0
            record.task.speed = "0 B/s"
            record.task.error = nil
            record.task.filePath = try taskFileURL(for: record.task).path
            appendLogLocked(to: &record.task, phase: "download", message: "starting IPA download")
        } catch {
            record.task.status = DownloadStatus.failed.rawValue
            record.task.error = String(describing: error)
            appendLogLocked(to: &record.task, phase: "download", message: "failed: \(errorDescription(error))")
            lock.unlock()
            persistTasks()
            return
        }

        let filePath = record.task.filePath ?? ""
        let sinfs = record.task.sinfs ?? []
        let iTunesMetadata = record.task.iTunesMetadata
        lock.unlock()
        persistTasks()

        queue.async {
            var stage = "Download"
            do {
                self.appendLog(id: id, phase: "download", message: "download worker started")
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
                    task.decryptEvents = nil
                    self.appendLogLocked(to: &task, phase: "decrypt", message: "running unfaird package processor")
                }
                self.persistTasks()
                try self.decryptInPlace(URL(fileURLWithPath: filePath), taskID: id)
                self.updateTask(id: id) { task in
                    task.status = DownloadStatus.completed.rawValue
                    task.progress = 100
                    task.speed = "0 B/s"
                    task.downloadURL = nil
                    task.sinfs = nil
                    task.iTunesMetadata = nil
                    task.sessionFieldsCleared()
                    self.appendLogLocked(to: &task, phase: "download", message: "completed")
                }
                self.persistTasks()
            } catch {
                if self.isPaused(id: id) {
                    self.persistTasks()
                    return
                }
                let failureMessage = "\(stage) failed: \(self.errorDescription(error))"
                let failurePhase = self.logPhase(forStage: stage)
                self.updateTask(id: id) { task in
                    task.status = DownloadStatus.failed.rawValue
                    task.error = failureMessage
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

        let expectedBytes = expectedDownloadBytes(taskID: taskID)
        let configuredThreads = settingsStore.effectiveSettings().downloadThreads
        let threads = Self.effectiveDownloadThreadCount(
            configuredThreads: configuredThreads,
            expectedBytes: expectedBytes
        )
        if threads == 1, expectedBytes > WebConfig.parallelRangeMaximumBytes {
            appendLog(
                id: taskID,
                phase: "download",
                message: "large IPA detected (\(expectedBytes) bytes); using single connection to reduce device pressure"
            )
        } else if threads == 1, expectedBytes <= 0 {
            appendLog(
                id: taskID,
                phase: "download",
                message: "download size unavailable; using single connection"
            )
        }

        if threads > 1, expectedBytes > 0, expectedBytes <= WebConfig.parallelRangeMaximumBytes {
            appendLog(
                id: taskID,
                phase: "download",
                message: "parallel range download: size=\(expectedBytes) bytes threads=\(threads)"
            )
            do {
                try parallelRangeDownload(
                    url: url,
                    to: destination,
                    taskID: taskID,
                    totalBytes: expectedBytes,
                    threads: threads
                )
                appendLog(id: taskID, phase: "download", message: "download complete")
                return
            } catch {
                if isPaused(id: taskID) {
                    throw error
                }
                appendLog(
                    id: taskID,
                    phase: "download",
                    message: "parallel range failed, falling back to single connection: \(errorDescription(error))"
                )
                try? FileManager.default.removeItem(at: destination)
            }
        }

        appendLog(id: taskID, phase: "download", message: "single connection download")
        try singleConnectionDownload(url: url, to: destination, taskID: taskID)
        appendLog(id: taskID, phase: "download", message: "download complete")
    }

    static func effectiveDownloadThreadCount(configuredThreads: Int, expectedBytes: Int64) -> Int {
        let boundedThreads = min(max(configuredThreads, 1), 2)
        guard expectedBytes > 0, expectedBytes <= WebConfig.parallelRangeMaximumBytes else {
            return 1
        }
        return boundedThreads
    }

    private func singleConnectionDownload(url: URL, to destination: URL, taskID: String) throws {
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
        registerSessionTask(task, taskID: taskID)
        defer {
            unregisterSessionTask(task, taskID: taskID)
        }
        task.resume()
        try delegate.wait()
    }

    private func parallelRangeDownload(
        url: URL,
        to destination: URL,
        taskID: String,
        totalBytes: Int64,
        threads: Int
    ) throws {
        let partDirectory = destination.deletingLastPathComponent()
            .appendingPathComponent(".\(taskID).parts", isDirectory: true)
        try? FileManager.default.removeItem(at: partDirectory)
        try FileManager.default.createDirectory(at: partDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: partDirectory)
        }

        let actualThreads = max(1, min(threads, Int(totalBytes)))
        let chunkSize = Int64(ceil(Double(totalBytes) / Double(actualThreads)))
        let progress = ParallelDownloadProgress(totalBytes: totalBytes) { [weak self] downloaded, total, elapsed, delta in
            self?.reportProgress(id: taskID, downloaded: downloaded, total: total, elapsed: elapsed, delta: delta)
        }

        let group = DispatchGroup()
        let errorLock = NSLock()
        var firstError: Error?

        for index in 0..<actualThreads {
            let start = Int64(index) * chunkSize
            if start >= totalBytes {
                continue
            }
            let end = min(totalBytes - 1, start + chunkSize - 1)
            let partURL = partDirectory.appendingPathComponent(String(format: "%04d.part", index))

            group.enter()
            rangeQueue.async {
                defer { group.leave() }
                errorLock.lock()
                let shouldSkip = firstError != nil
                errorLock.unlock()
                if shouldSkip {
                    return
                }

                do {
                    try self.downloadRangeWithRetry(
                        url: url,
                        to: partURL,
                        taskID: taskID,
                        index: index,
                        start: start,
                        end: end,
                        progress: progress
                    )
                } catch {
                    errorLock.lock()
                    if firstError == nil {
                        firstError = error
                        self.cancelSessionTasks(taskID: taskID)
                    }
                    errorLock.unlock()
                }
            }
        }

        group.wait()

        if let firstError = firstError {
            throw firstError
        }

        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer {
            try? output.close()
        }
        // Do not let the merged IPA fill the page cache; on low-memory
        // jailbroken devices this can push the system into a Jetsam kill.
        fcntl(output.fileDescriptor, F_NOCACHE, 1)

        for index in 0..<actualThreads {
            let partURL = partDirectory.appendingPathComponent(String(format: "%04d.part", index))
            let input = try FileHandle(forReadingFrom: partURL)
            defer {
                try? input.close()
            }
            while true {
                let data = try input.read(upToCount: 1024 * 1024) ?? Data()
                if data.isEmpty {
                    break
                }
                try output.write(contentsOf: data)
            }
        }

        progress.finish()
    }

    private func downloadRangeWithRetry(
        url: URL,
        to destination: URL,
        taskID: String,
        index: Int,
        start: Int64,
        end: Int64,
        progress: ParallelDownloadProgress
    ) throws {
        var lastError: Error?
        for attempt in 1...3 {
            do {
                try downloadRange(
                    url: url,
                    to: destination,
                    taskID: taskID,
                    index: index,
                    start: start,
                    end: end,
                    progress: progress
                )
                return
            } catch {
                lastError = error
                try? FileManager.default.removeItem(at: destination)
                progress.update(index: index, written: 0, force: true)
                if attempt < 3 {
                    appendLog(id: taskID, phase: "download", message: "range part \(index + 1) retry \(attempt + 1)/3")
                    Thread.sleep(forTimeInterval: Double(attempt))
                }
            }
        }
        throw lastError ?? Abort(.badGateway, reason: "range part \(index + 1) failed")
    }

    private func downloadRange(
        url: URL,
        to destination: URL,
        taskID: String,
        index: Int,
        start: Int64,
        end: Int64,
        progress: ParallelDownloadProgress
    ) throws {
        let expectedBytes = end - start + 1
        let delegate = WebDownloadDelegate(
            destination: destination,
            maxBytes: expectedBytes,
            acceptedStatusCodes: [206],
            progress: { written, _, _, _ in
                progress.update(index: index, written: written)
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
        request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
        let task = session.downloadTask(with: request)
        registerSessionTask(task, taskID: taskID)
        defer {
            unregisterSessionTask(task, taskID: taskID)
        }
        task.resume()
        try delegate.wait()
        progress.update(index: index, written: expectedBytes, force: true)
    }

    private func decryptInPlace(_ ipaURL: URL, taskID: String) throws {
        let decryptID = UUID()
        let jobsRoot = URL(fileURLWithPath: "/var/tmp/unfaird/jobs", isDirectory: true)
        let jobDirectory = jobsRoot.appendingPathComponent(decryptID.uuidString, isDirectory: true)
        let packageWorkingDirectory = try PackageRunnerSandbox.packageWorkingDirectory(for: decryptID)
        let outputURL = ipaURL.deletingLastPathComponent()
            .appendingPathComponent(".\(taskID).decrypted.ipa")
        let sourceBytes = ipaFileSize(at: ipaURL)
        let stabilityPolicy = decryptStabilityPolicy(for: sourceBytes)
        let requestedForceExtensions = taskForceExtensionDecryption(taskID)
        let forceExtensions = requestedForceExtensions && stabilityPolicy.allowsExtensionDecryption

        try FileManager.default.createDirectory(at: jobDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: packageWorkingDirectory, withIntermediateDirectories: true)
        // Skip staging - the original ipaURL is on the real filesystem
        // (downloaded by URLSession outside RootHide namespace).
        // Any copy we make would land in the RootHide-remapped location
        // where appinst/installd cannot see it.
        appendLog(
            id: taskID,
            phase: "decrypt",
            message: "input: \(ipaURL.path)"
        )
        defer {
            try? FileManager.default.removeItem(at: jobDirectory)
            try? FileManager.default.removeItem(at: packageWorkingDirectory)
            try? FileManager.default.removeItem(at: outputURL)
        }

        let sandboxProfileURL = try PackageRunnerSandbox.writeProfile(jobDirectory: jobDirectory)
        appendLog(
            id: taskID,
            phase: "decrypt",
            message: "stability guard: \(stabilityPolicy.label), IPA \(formatMemoryBytes(sourceBytes)); requires \(formatMemoryBytes(stabilityPolicy.minimumAvailableBytes)) available memory before package processing"
        )
        if requestedForceExtensions && !forceExtensions {
            appendLog(
                id: taskID,
                phase: "decrypt",
                message: "warning: force Extension decryption was disabled for this large IPA to prevent SpringBoard restart"
            )
        }
        purgeFileCacheIfAvailable()
        try waitForMemoryHeadroom(
            taskID: taskID,
            minimumAvailableBytes: stabilityPolicy.minimumAvailableBytes,
            timeout: stabilityPolicy.waitSeconds
        )
        let result = try PosixSpawn.run(
            executablePath: currentExecutablePath(),
           arguments: [
           "package",
            "--input", ipaURL.path,
           "--output", outputURL.path,
           "--working-directory", packageWorkingDirectory.path,
            "--verbose",
        ] + (forceExtensions ? ["--force-extensions"] : []),
            workingDirectory: jobDirectory,
            sandboxProfileURL: sandboxProfileURL,
            timeoutSeconds: WebConfig.decryptTimeoutSeconds,
            onOutputLine: { [weak self] stream, line in
                self?.appendLog(
                    id: taskID,
                    phase: "decrypt",
                    message: "\(self?.outputStreamLabel(stream) ?? "output"): \(line)"
                )
                self?.appendDecryptEvent(id: taskID, line: line)
            }
        )

        guard result.exitCode == 0, fileExists(outputURL.path) else {
            let message = result.stderrString.isEmpty ? "decrypt runner exited with code \(result.exitCode)" : result.stderrString
            appendLog(id: taskID, phase: "decrypt", message: "failed: \(message)")
            throw Abort(.internalServerError, reason: message)
        }

        try replacePackageFile(at: ipaURL, with: outputURL)
        appendLog(id: taskID, phase: "decrypt", message: "complete")
    }

    private func taskForceExtensionDecryption(_ taskID: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return tasks[taskID]?.task.forceExtensionDecryption == true
    }

    private func expectedDownloadBytes(taskID: String) -> Int64 {
        lock.lock()
        let value = tasks[taskID]?.task.software.fileSizeBytes
        lock.unlock()
        guard let value = value else {
            return 0
        }
        return Int64(value) ?? 0
    }

    private func purgeFileCacheIfAvailable() {
        let candidates = [
            "/var/jb/usr/bin/purge",
            "/usr/bin/purge",
            "/bin/purge",
        ]
        for path in candidates where access(path, X_OK) == 0 {
            _ = try? PosixSpawn.run(
                executablePath: path,
                arguments: [],
                workingDirectory: FileManager.default.temporaryDirectory,
                timeoutSeconds: 30
            )
            return
        }
    }

    private func waitForMemoryHeadroom(taskID: String, minimumFreeBytes: UInt64 = 300 * 1024 * 1024, timeout: TimeInterval = 60) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let free = freeMemoryBytes(), free >= minimumFreeBytes {
                return
            }
            purgeFileCacheIfAvailable()
            Thread.sleep(forTimeInterval: 5)
        }
        appendLog(id: taskID, phase: "decrypt", message: "warning: free memory did not recover before decrypt")
    }

    private func freeMemoryBytes() -> UInt64? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(
            MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size
        )
        let result = withUnsafeMutablePointer(to: &stats) { statsPtr in
            statsPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, intPtr, &count)
            }
        }
        guard result == KERN_SUCCESS else {
            return nil
        }
        let pageSize = UInt64(vm_kernel_page_size)
        return UInt64(stats.free_count) * pageSize
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

    private func registerSessionTask(_ task: URLSessionTask, taskID: String) {
        lock.lock()
        tasks[taskID]?.sessionTasks.append(task)
        lock.unlock()
    }

    private func unregisterSessionTask(_ task: URLSessionTask, taskID: String) {
        lock.lock()
        if let record = tasks[taskID] {
            record.sessionTasks.removeAll { $0.taskIdentifier == task.taskIdentifier }
        }
        lock.unlock()
    }

    private func cancelSessionTasks(taskID: String) {
        lock.lock()
        let activeTasks = tasks[taskID]?.sessionTasks ?? []
        lock.unlock()
        activeTasks.forEach { $0.cancel() }
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

    private func appendDecryptEvent(id: String, line: String) {
        guard let event = decryptEvent(from: line) else {
            return
        }
        lock.lock()
        if let record = tasks[id] {
            var events = record.task.decryptEvents ?? []
            events.append(event)
            if events.count > 300 {
                events = Array(events.suffix(300))
            }
            record.task.decryptEvents = events
        }
        lock.unlock()
    }

    private func decryptEvent(from line: String) -> DecryptEvent? {
        if let path = suffix(after: "task-memory decrypted: ", in: line) {
            return DecryptEvent(kind: decryptKind(for: path), status: "decrypted", path: path, message: line)
        }
        if let path = suffix(after: "decrypted: ", in: line) {
            return DecryptEvent(kind: decryptKind(for: path), status: "decrypted", path: path, message: line)
        }
        if let path = suffix(after: "warning: skipped encrypted extension: ", in: line) {
            let cleanPath = path.split(separator: ":", maxSplits: 1).first.map(String.init) ?? path
            return DecryptEvent(kind: "extension", status: "skipped", path: cleanPath, message: line)
        }
        if let path = suffix(after: "warning: extension decryption failed: ", in: line) {
            let cleanPath = path.split(separator: ":", maxSplits: 1).first.map(String.init) ?? path
            return DecryptEvent(kind: "extension", status: "failed", path: cleanPath, message: line)
        }
        if let path = suffix(after: "warning: skipped encrypted framework: ", in: line) {
            let cleanPath = path.split(separator: ":", maxSplits: 1).first.map(String.init) ?? path
            return DecryptEvent(kind: "framework", status: "skipped", path: cleanPath, message: line)
        }
        if let path = suffix(after: "warning: encrypted extension remains: ", in: line) {
            return DecryptEvent(kind: "extension", status: "skipped", path: path, message: line)
        }
        if let path = suffix(after: "warning: encrypted framework remains: ", in: line) {
            return DecryptEvent(kind: "framework", status: "skipped", path: path, message: line)
        }
       if line.contains("cryptid-report:") {
            var event = DecryptEvent(kind: "report", status: "info", path: nil, message: line)
            event.reportTotal = extractInt("total=", in: line)
            event.reportDecrypted = extractInt("decrypted=", in: line)
            event.reportRemaining = extractInt("remaining=", in: line)
            event.reportMainRemaining = extractInt("mainRemaining=", in: line)
            event.reportFrameworkRemaining = extractInt("frameworkRemaining=", in: line)
            event.reportExtensionRemaining = extractInt("extensionRemaining=", in: line)
            return event
       }
        return nil
    }

    private func suffix(after marker: String, in line: String) -> String? {
        guard let range = line.range(of: marker) else {
            return nil
        }
        return String(line[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func extractInt(_ key: String, in line: String) -> Int? {
        guard let range = line.range(of: key) else { return nil }
        let rest = String(line[range.upperBound...])
        let digits = rest.prefix(while: { $0.isNumber })
        return Int(digits)
    }

        private func decryptKind(for path: String) -> String {
        if path.contains(".appex/") || path.contains("/Watch/") {
            return "extension"
        }
        if path.contains("/Frameworks/") {
            return "framework"
        }
        return "main"
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
        let autoCleanupDays = settingsStore.effectiveSettings().autoCleanupDays
        guard autoCleanupDays > 0 else {
            return
        }
        let cutoff = Date().addingTimeInterval(-TimeInterval(autoCleanupDays) * 24 * 60 * 60)
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
        let autoCleanupMaxMB = settingsStore.effectiveSettings().autoCleanupMaxMB
        guard autoCleanupMaxMB > 0 else {
            return
        }

        let limit = Int64(autoCleanupMaxMB) * 1024 * 1024
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
              ["http", "https"].contains(scheme),
              let host = components.host?.lowercased(),
              host.isEmpty == false,
              URL(string: rawValue) != nil
        else {
            throw Abort(.badRequest, reason: "invalid external IPA URL")
        }

        guard isPrivateNetworkHost(host) else {
            throw Abort(.badRequest, reason: "external IPA URL must use a private LAN host")
        }
    }

    private func isPrivateNetworkHost(_ host: String) -> Bool {
        if host == "localhost" {
            return true
        }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else {
            return false
        }
        if parts[0] == 10 {
            return true
        }
        if parts[0] == 172, (16...31).contains(parts[1]) {
            return true
        }
        if parts[0] == 192, parts[1] == 168 {
            return true
        }
        if parts[0] == 169, parts[1] == 254 {
            return true
        }
        return false
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

    private struct RangeDownloadProbe {
        let contentLength: Int64
        let rangeSupported: Bool
    }

    private func probeRangeDownload(url: URL) throws -> RangeDownloadProbe {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        let response = try HTTPSyncClient.shared.send(request, timeout: 20)
        guard (200...299).contains(response.statusCode) else {
            throw Abort(.badGateway, reason: "Failed to probe IPA download")
        }
        guard let http = response.response as? HTTPURLResponse else {
            return RangeDownloadProbe(contentLength: response.response.expectedContentLength, rangeSupported: false)
        }
        let acceptRanges = (http.value(forHTTPHeaderField: "Accept-Ranges") ?? "").lowercased()
        let contentLength = response.response.expectedContentLength
        if acceptRanges.contains("bytes"), contentLength > 0 {
            return RangeDownloadProbe(contentLength: contentLength, rangeSupported: true)
        }

        var rangeRequest = URLRequest(url: url)
        rangeRequest.httpMethod = "GET"
        rangeRequest.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        rangeRequest.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        let rangeResponse = try HTTPSyncClient.shared.send(rangeRequest, timeout: 20)
        guard let rangeHTTP = rangeResponse.response as? HTTPURLResponse,
              rangeHTTP.statusCode == 206
        else {
            return RangeDownloadProbe(contentLength: contentLength, rangeSupported: false)
        }

        let rangeTotal = Self.totalBytes(fromContentRange: rangeHTTP.value(forHTTPHeaderField: "Content-Range"))
        return RangeDownloadProbe(contentLength: rangeTotal ?? contentLength, rangeSupported: true)
    }

    private static func totalBytes(fromContentRange value: String?) -> Int64? {
        guard let value = value,
              let slash = value.lastIndex(of: "/")
        else {
            return nil
        }
        let suffix = value[value.index(after: slash)...]
        return Int64(suffix)
    }

    private func errorDescription(_ error: Error) -> String {
        if let abort = error as? AbortError {
            return abort.reason
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

private final class ParallelDownloadProgress {
    private let totalBytes: Int64
    private let report: (Int64, Int64, TimeInterval, Int64) -> Void
    private let lock = NSLock()
    private var chunkBytes: [Int: Int64] = [:]
    private var lastReportTime = Date()
    private var lastReportedBytes: Int64 = 0

    init(totalBytes: Int64, report: @escaping (Int64, Int64, TimeInterval, Int64) -> Void) {
        self.totalBytes = totalBytes
        self.report = report
    }

    func update(index: Int, written: Int64, force: Bool = false) {
        lock.lock()
        chunkBytes[index] = max(0, written)
        let downloaded = min(totalBytes, chunkBytes.values.reduce(0, +))
        let now = Date()
        let elapsed = now.timeIntervalSince(lastReportTime)
        let delta = downloaded - lastReportedBytes
        guard force || elapsed >= 0.5 else {
            lock.unlock()
            return
        }
        lastReportTime = now
        lastReportedBytes = downloaded
        lock.unlock()

        report(downloaded, totalBytes, max(elapsed, 0.001), max(delta, 0))
    }

    func finish() {
        lock.lock()
        let now = Date()
        let elapsed = now.timeIntervalSince(lastReportTime)
        let delta = totalBytes - lastReportedBytes
        lastReportTime = now
        lastReportedBytes = totalBytes
        lock.unlock()

        report(totalBytes, totalBytes, max(elapsed, 0.001), max(delta, 0))
    }
}

private final class WebDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let destination: URL
    private let maxBytes: Int64
    private let acceptedStatusCodes: Set<Int>
    private let progress: (Int64, Int64, TimeInterval, Int64) -> Void
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var result: Result<Void, Error>?
    private var pendingError: Error?
    private var completed = false
    private var lastTime = Date()
    private var lastBytes: Int64 = 0

    init(
        destination: URL,
        maxBytes: Int64,
        acceptedStatusCodes: Set<Int> = Set(200...299),
        progress: @escaping (Int64, Int64, TimeInterval, Int64) -> Void
    ) {
        self.destination = destination
        self.maxBytes = maxBytes
        self.acceptedStatusCodes = acceptedStatusCodes
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
           acceptedStatusCodes.contains(http.statusCode) == false {
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
