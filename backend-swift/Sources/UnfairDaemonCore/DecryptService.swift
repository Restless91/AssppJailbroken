import Darwin
import Dispatch
import Foundation
import Vapor
import UnfairKit
import ZIPFoundation

struct DecryptService {
    typealias ProcessRunner = (String, [String], URL, URL?, Int?) throws -> PosixSpawnResult
    typealias JobScheduler = (@escaping () -> Void) -> Void

    struct Dependencies {
        let workDirectory: () -> URL
        let packageWorkingDirectory: (UUID) throws -> URL
        let sandboxProfileURL: (URL) throws -> URL?
        let currentExecutablePath: () -> String
        let currentTimestamp: () -> Int
        let runProcess: ProcessRunner
        let reserveTask: (URL, Int64) throws -> (() -> Void)
        let scheduleJob: JobScheduler

        static let live = Dependencies(
            workDirectory: { DecryptService.workDirectory() },
            packageWorkingDirectory: { try PackageRunnerSandbox.packageWorkingDirectory(for: $0) },
            sandboxProfileURL: { try PackageRunnerSandbox.writeProfile(jobDirectory: $0) },
            currentExecutablePath: { DecryptService.currentExecutablePath() },
            currentTimestamp: { DecryptService.currentTimestamp() },
            runProcess: { executablePath, arguments, workingDirectory, sandboxProfileURL, timeoutSeconds in
                try PosixSpawn.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    workingDirectory: workingDirectory,
                    sandboxProfileURL: sandboxProfileURL,
                    timeoutSeconds: timeoutSeconds
                )
            },
            reserveTask: { workDirectory, bytesPerTask in
                let reservation = try DecryptTaskGate.shared.reserve(
                    workDirectory: workDirectory,
                    bytesPerTask: bytesPerTask
                )
                return { reservation.release() }
            },
            scheduleJob: { work in DecryptService.decryptQueue.async(execute: work) }
        )
    }

    static let maxUploadBytes: Int64 = 8 * 1024 * 1024 * 1024
    private static let downloadTTLSeconds = 3600
    private static let cleanupIntervalSeconds = 60
    private static let diskReserveBytes: Int64 = 16 * 1024 * 1024 * 1024
    private static let memoryFloorBytes: UInt64 = 400 * 1024 * 1024
    private static let memoryRecoveryTimeout: TimeInterval = 60
    private static let workDirectoryPath = "/var/tmp/unfaird-jobs"
    private static let runnerTimeoutSeconds = 30 * 60
    private static let cleanupLock = NSLock()
    private static let decryptQueue = DispatchQueue(label: "wiki.qaq.unfaird.decrypt-queue")
    private static var cleanupTimer: DispatchSourceTimer?

    private let dependencies: Dependencies

    init(dependencies: Dependencies = .live) {
        self.dependencies = dependencies
    }

    static func prepareWorkDirectoryForStartup() throws {
        try FileManager.default.createDirectory(
            at: workDirectory(),
            withIntermediateDirectories: true
        )
        try removeJobDirectories()
    }

    static func startExpiredJobCleanup() {
        cleanupLock.lock()
        defer { cleanupLock.unlock() }
        guard cleanupTimer == nil else {
            return
        }

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "wiki.qaq.unfaird.job-cleanup"))
        timer.schedule(
            deadline: .now() + .seconds(cleanupIntervalSeconds),
            repeating: .seconds(cleanupIntervalSeconds)
        )
        timer.setEventHandler {
            cleanupExpiredJobs()
        }
        cleanupTimer = timer
        timer.resume()
    }

    /// Free memory on this device, falling back to nil when the Mach call fails.
    private static func freeMemoryBytes() -> UInt64? {
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

    /// Drop inactive file-backed pages before a heavy install/decrypt cycle.
    private func purgeFileCacheIfAvailable() {
        let candidates = [
            "/var/jb/usr/bin/purge",
            "/usr/bin/purge",
            "/bin/purge",
        ]
        for path in candidates where access(path, X_OK) == 0 {
            _ = try? dependencies.runProcess(
                path,
                [],
                FileManager.default.temporaryDirectory,
                nil,
                30
            )
            return
        }
    }

    private func ensureMemoryHeadroom() throws {
        let deadline = Date().addingTimeInterval(Self.memoryRecoveryTimeout)
        var free = Self.freeMemoryBytes()
        if free == nil {
            return
        }
        if free! >= Self.memoryFloorBytes {
            return
        }
        purgeFileCacheIfAvailable()
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 3)
            free = Self.freeMemoryBytes()
            if let current = free, current >= Self.memoryFloorBytes {
                return
            }
        }
        fputs(
            "unfaird: refusing decrypt because free memory is \(free.map { String($0 / 1024 / 1024) } ?? "unknown") MB; run purge and retry\n",
            stderr
        )
        throw Abort(
            .serviceUnavailable,
            reason: "device memory is too low for a safe decrypt; free memory did not recover after purge"
        )
    }

    private func cleanupStalePackageFiles() {
        let root = URL(fileURLWithPath: "/var/mobile/AssppWebData/packages", isDirectory: true)
        guard let children = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) else {
            return
        }
        let now = Date()
        for child in children {
            let age = (try? child.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                .map { now.timeIntervalSince($0) } ?? .greatestFiniteMagnitude
            if age > TimeInterval(Self.downloadTTLSeconds) {
                try? FileManager.default.removeItem(at: child)
            }
        }
    }

    func enqueue(_ upload: DecryptUpload) throws -> DecryptQueueResponse {
        try validate(upload)

        if let file = upload.ipa {
            let preparedUpload = try prepareFileUpload()
            try write(file, to: preparedUpload.inputURL)
            return try enqueuePreparedFileUpload(preparedUpload)
        }

        if let urlString = upload.sourceURLString {
            return try enqueueRemoteURL(RemoteIPAURL.parse(urlString))
        }

        throw Abort(.badRequest, reason: "ipa source required")
    }

    func enqueueStreamingMultipart(_ req: Request) throws -> EventLoopFuture<DecryptQueueResponse> {
        let boundary = try multipartBoundary(from: req)
        let preparedUpload = try prepareFileUpload()
        let fileHandle = try FileHandle(forWritingTo: preparedUpload.inputURL)
        let receiver = StreamingDecryptUploadReceiver(
            boundary: boundary,
            fileHandle: fileHandle,
            maxUploadBytes: Self.maxUploadBytes
        )
        let promise = req.eventLoop.makePromise(of: DecryptQueueResponse.self)
        var didCompleteResponse = false

        func cleanupAfterFailure(_ error: Error) {
            guard didCompleteResponse == false else {
                return
            }
            didCompleteResponse = true
            fileHandle.closeFile()
            discardPreparedFileUpload(preparedUpload)
            promise.fail(error)
        }

        req.body.drain { part in
            switch part {
            case .buffer(var buffer):
                do {
                    try receiver.consume(&buffer)
                    return req.eventLoop.makeSucceededFuture(())
                } catch {
                    cleanupAfterFailure(error)
                    return req.eventLoop.makeFailedFuture(error)
                }
            case .error(let error):
                cleanupAfterFailure(error)
                return req.eventLoop.makeSucceededFuture(())
            case .end:
                do {
                    let source = try receiver.finish()
                    fileHandle.closeFile()
                    switch source {
                    case .uploadedFile:
                        if didCompleteResponse == false {
                            didCompleteResponse = true
                            promise.succeed(try enqueuePreparedFileUpload(preparedUpload))
                        }
                    case .remoteURL(let url):
                        discardPreparedFileUpload(preparedUpload)
                        if didCompleteResponse == false {
                            didCompleteResponse = true
                            promise.succeed(try enqueueRemoteURL(url))
                        }
                    }
                } catch {
                    cleanupAfterFailure(error)
                }
                return req.eventLoop.makeSucceededFuture(())
            }
        }

        return promise.futureResult
    }

    func readyResponse(for id: UUID) throws -> DecryptReadyResponse {
        let (metadata, job) = try loadActiveJob(for: id)
        return DecryptReadyResponse(
            queue: queueInfo(for: metadata, job: job),
            exit: metadata.exit,
            error: metadata.error
        )
    }

    func validatedReadyOutputURL(for id: UUID) throws -> URL {
        let (metadata, job) = try loadActiveJob(for: id)
        guard isReady(metadata, job: job) else {
            if metadata.status == .failed {
                throw Abort(.conflict, reason: metadata.error ?? "job failed")
            }
            throw Abort(.conflict, reason: "job is not ready")
        }
        return job.outputURL
    }

    private func runQueuedJob(
        job: DecryptJob,
        inputSource: QueuedInputSource,
        packageWorkingDirectory: URL
    ) {
        do {
            try writeMetadata(
                job.metadata(status: .running, updatedAt: dependencies.currentTimestamp()),
                in: job.directoryURL
            )

            let releaseReservation = try dependencies.reserveTask(
                dependencies.workDirectory(),
                Self.diskReserveBytes
            )
            defer { releaseReservation() }

            cleanupStalePackageFiles()
            try ensureMemoryHeadroom()
            let packageInputURL = try packageInputURL(
                from: inputSource,
                packageWorkingDirectory: packageWorkingDirectory
            )
            // The download itself leaves hundreds of MB of file-backed cache
            // behind; drop it before installd unpacks the IPA.
            purgeFileCacheIfAvailable()
            try ensureMemoryHeadroom()
            let sandboxProfileURL = try dependencies.sandboxProfileURL(job.directoryURL)

            // Primary: unfaird native decryption
            let unfairdResult: PosixSpawnResult
            let nativeSpawnFailed: Bool
            do {
                unfairdResult = try runDecryptRunner(
                    for: job,
                    inputURL: packageInputURL,
                    packageWorkingDirectory: packageWorkingDirectory,
                    sandboxProfileURL: sandboxProfileURL
                )
                nativeSpawnFailed = false
            } catch {
                fputs("unfaird native spawn failed: \(error), skipping to Frida fallback\n", stderr)
                unfairdResult = PosixSpawnResult(exitCode: -1, stdout: Data(), stderr: Data("\(error)".utf8))
                nativeSpawnFailed = true
            }

            let unfairdSuccess = !nativeSpawnFailed && unfairdResult.exitCode == 0 &&
                FileManager.default.fileExists(atPath: job.outputURL.path)

            if unfairdSuccess {
                try finalize(job: job, result: unfairdResult)
                return
            }

            // Fallback: Frida-based decryption (works better on arm64e / iPhone 15+)
            fputs("unfaird decrypt failed (exit \(unfairdResult.exitCode)), trying Frida fallback...\n", stderr)
            let fridaResult = try runFridaFallback(
                for: job,
                inputURL: packageInputURL,
                packageWorkingDirectory: packageWorkingDirectory
            )
            try finalize(job: job, result: fridaResult)
        } catch {
            markFailed(job: job, exit: nil, error: errorDescription(error))
        }
    }

    private func enqueuePreparedFileUpload(_ upload: DecryptPreparedFileUpload) throws -> DecryptQueueResponse {
        try enqueueJob(
            upload.job,
            inputSource: .uploadedFile(upload.inputURL),
            packageWorkingDirectory: upload.packageWorkingDirectory
        )
    }

    private func enqueueRemoteURL(_ url: URL) throws -> DecryptQueueResponse {
        let job = try createJob()
        let packageWorkingDirectory = try dependencies.packageWorkingDirectory(job.id)
        try FileManager.default.createDirectory(at: packageWorkingDirectory, withIntermediateDirectories: true)
        return try enqueueJob(
            job,
            inputSource: .remoteURL(url),
            packageWorkingDirectory: packageWorkingDirectory
        )
    }

    private func enqueueJob(
        _ job: DecryptJob,
        inputSource: QueuedInputSource,
        packageWorkingDirectory: URL
    ) throws -> DecryptQueueResponse {
        let metadata = job.metadata(
            status: .queued,
            updatedAt: dependencies.currentTimestamp()
        )

        try writeMetadata(metadata, in: job.directoryURL)
        dependencies.scheduleJob {
            self.runQueuedJob(
                job: job,
                inputSource: inputSource,
                packageWorkingDirectory: packageWorkingDirectory
            )
        }

        return DecryptQueueResponse(queue: queueInfo(for: metadata, job: job))
    }

    private func prepareFileUpload() throws -> DecryptPreparedFileUpload {
        let job = try createJob()
        let packageWorkingDirectory = try dependencies.packageWorkingDirectory(job.id)
        try FileManager.default.createDirectory(at: packageWorkingDirectory, withIntermediateDirectories: true)
        let inputURL = packageWorkingDirectory.appendingPathComponent("input.ipa")
        FileManager.default.createFile(
            atPath: inputURL.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        )
        return DecryptPreparedFileUpload(
            job: job,
            packageWorkingDirectory: packageWorkingDirectory,
            inputURL: inputURL
        )
    }

    private func discardPreparedFileUpload(_ upload: DecryptPreparedFileUpload) {
        Self.removeJobDirectory(upload.job.directoryURL)
        try? FileManager.default.removeItem(at: upload.packageWorkingDirectory)
    }

    private func packageInputURL(
        from inputSource: QueuedInputSource,
        packageWorkingDirectory: URL
    ) throws -> URL {
        switch inputSource {
        case .uploadedFile(let url):
            return url
        case .remoteURL(let sourceURL):
            let inputURL = packageWorkingDirectory.appendingPathComponent("input.ipa")
            try downloadIPA(from: sourceURL, to: inputURL)
            return inputURL
        }
    }

    /// In-process decryption using UnfairKit's PackageProcessor.
    /// No posix_spawn needed — works on RootHide / rootless jailbreaks.
    private func runDecryptRunner(
        for job: DecryptJob,
        inputURL: URL,
        packageWorkingDirectory: URL,
        sandboxProfileURL: URL?
    ) throws -> PosixSpawnResult {
        var stdoutLines: [String] = []
        var stderrLines: [String] = []
        let logger = UnfairLogger(verbose: true) { message in
            stdoutLines.append(message)
        }

        do {
            let processor = PackageProcessor(logger: logger)
            try processor.process(
                input: inputURL,
                output: job.outputURL,
                workingDirectory: packageWorkingDirectory,
                forceExtensions: false
            )
            let stdoutData = Data(stdoutLines.joined(separator: "\n").utf8)
            return PosixSpawnResult(exitCode: 0, stdout: stdoutData, stderr: Data())
        } catch {
            let errorMsg = "PackageProcessor failed: \(error)"
            stderrLines.append(errorMsg)
            fputs("\(errorMsg)\n", stderr)
            let stderrData = Data(stderrLines.joined(separator: "\n").utf8)
            return PosixSpawnResult(exitCode: 1, stdout: Data(), stderr: stderrData)
        }
    }

    // MARK: - Frida Fallback Decryption

    /// Frida-based decryption entirely on-device via linked libfrida-core.
    /// Connects to local frida-server (127.0.0.1:27042) — no Mac dependency,
    /// no posix_spawn. Works on RootHide / iOS 17+.
    private func runFridaFallback(
        for job: DecryptJob,
        inputURL: URL,
        packageWorkingDirectory: URL
    ) throws -> PosixSpawnResult {
        let bundleID = try extractBundleIDFromIPA(inputURL, workingDirectory: packageWorkingDirectory)
        let fridaHost = ProcessInfo.processInfo.environment["UNFAIRD_FRIDA_HOST"] ?? "127.0.0.1:27042"

        fputs("Frida fallback: on-device Frida dump via \(fridaHost) for \(bundleID)\n", stderr)

        let service = FridaService(fridaHost: fridaHost)
        defer { /* service cleans up on deinit */ }

        do {
            let success = try service.decrypt(
                inputIPA: inputURL,
                outputIPA: job.outputURL,
                workingDirectory: packageWorkingDirectory,
                bundleID: bundleID
            )

            if success {
                fputs("Frida fallback: dump succeeded\n", stderr)
                return PosixSpawnResult(exitCode: 0, stdout: Data("frida dump ok".utf8), stderr: Data())
            } else {
                let msg = "Frida fallback: output IPA not created"
                fputs("\(msg)\n", stderr)
                return PosixSpawnResult(exitCode: 1, stdout: Data(), stderr: Data(msg.utf8))
            }
        } catch {
            let msg = "Frida fallback failed: \(error.localizedDescription)"
            fputs("\(msg)\n", stderr)
            return PosixSpawnResult(exitCode: 1, stdout: Data(), stderr: Data(msg.utf8))
        }
    }

    /// Extract CFBundleIdentifier from an IPA file using ZIPFoundation (in-process, no spawn)
    private func extractBundleIDFromIPA(_ ipaPath: URL, workingDirectory: URL) throws -> String {

        let archive: Archive
        do {
            archive = try Archive(url: ipaPath, accessMode: .read)
        } catch {
            throw Abort(.internalServerError, reason: "cannot open IPA archive: \(error)")
        }

        // Find Info.plist inside Payload/*.app/
        guard let infoEntry = archive.first(where: { entry in
            let path = entry.path
            return path.contains("Payload/") && path.hasSuffix(".app/Info.plist")
        }) else {
            throw Abort(.internalServerError, reason: "Info.plist not found in IPA")
        }

        let tempDir = workingDirectory.appendingPathComponent("bundleid_extract")
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        let infoURL = tempDir.appendingPathComponent("Info.plist")
        _ = try archive.extract(infoEntry, to: infoURL)

        guard let infoPlist = NSDictionary(contentsOf: infoURL),
              let bundleID = infoPlist["CFBundleIdentifier"] as? String else {
            throw Abort(.internalServerError, reason: "cannot read CFBundleIdentifier from Info.plist")
        }

        return bundleID
    }

    /// Synchronous HTTP POST with JSON body
    private func postJSONSync(urlString: String, body: Data, timeout: Double = 1800) throws -> Data {
        guard let url = URL(string: urlString) else {
            throw Abort(.badRequest, reason: "invalid URL: \(urlString)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = timeout

        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<Data, Error>?

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                result = .failure(error)
            } else if let httpResponse = response as? HTTPURLResponse,
                      (200...299).contains(httpResponse.statusCode) == false {
                result = .failure(Abort(.badGateway, reason: "Mac Frida service HTTP \(httpResponse.statusCode)"))
            } else if let data = data {
                result = .success(data)
            } else {
                result = .failure(Abort(.internalServerError, reason: "no data from Mac Frida service"))
            }
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()

        switch result {
        case .success(let data): return data
        case .failure(let error): throw error
        case .none: throw Abort(.internalServerError, reason: "HTTP request returned no result")
        }
    }

    private func finalize(job: DecryptJob, result: PosixSpawnResult) throws {
        let exit = exit(for: result, job: job)
        if result.exitCode == 0,
           FileManager.default.fileExists(atPath: job.outputURL.path) {
            try writeMetadata(
                job.metadata(
                    status: .succeeded,
                    updatedAt: dependencies.currentTimestamp(),
                    exit: exit
                ),
                in: job.directoryURL
            )
            return
        }

        let message = FileManager.default.fileExists(atPath: job.outputURL.path)
            ? "decrypt runner exited with code \(result.exitCode)"
            : "output ipa missing"
        try writeMetadata(
            job.metadata(
                status: .failed,
                updatedAt: dependencies.currentTimestamp(),
                exit: exit,
                error: message
            ),
            in: job.directoryURL
        )
    }

    private func markFailed(job: DecryptJob, exit: DecryptExit?, error: String) {
        do {
            try writeMetadata(
                job.metadata(
                    status: .failed,
                    updatedAt: dependencies.currentTimestamp(),
                    exit: exit,
                    error: error
                ),
                in: job.directoryURL
            )
        } catch {
            fputs("unfaird failed to update job \(job.id.uuidString): \(error)\n", stderr)
        }
        fputs("unfaird decrypt job \(job.id.uuidString) failed: \(error)\n", stderr)
    }

    private func exit(for result: PosixSpawnResult, job: DecryptJob) -> DecryptExit {
        DecryptExit(
            code: result.exitCode,
            stdout: result.stdoutString,
            stderr: result.stderrString,
            downloadURL: job.downloadURL,
            validateUntil: job.validateUntil
        )
    }

    private func createJob() throws -> DecryptJob {
        let id = UUID()
        let workDirectory = dependencies.workDirectory()
        try FileManager.default.createDirectory(
            at: workDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let directory = workDirectory.appendingPathComponent(id.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return DecryptJob(
            id: id,
            directoryURL: directory,
            validateUntil: validateUntilTimestamp()
        )
    }

    private func loadActiveJob(for id: UUID) throws -> (DecryptJobMetadata, DecryptJob) {
        let directory = try existingJobDirectory(for: id)
        let metadata = try Self.readMetadata(in: directory)
        guard metadata.id == id else {
            throw Abort(.internalServerError, reason: "job metadata id mismatch")
        }
        guard metadata.validateUntil >= dependencies.currentTimestamp() else {
            Self.removeJobDirectory(directory)
            throw Abort(.gone, reason: "download url expired")
        }
        return (
            metadata,
            DecryptJob(
                id: id,
                directoryURL: directory,
                validateUntil: metadata.validateUntil
            )
        )
    }

    private func existingJobDirectory(for id: UUID) throws -> URL {
        let directory = dependencies.workDirectory().appendingPathComponent(id.uuidString, isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else {
            throw Abort(.notFound, reason: "job missing")
        }
        return directory
    }

    private func queueInfo(for metadata: DecryptJobMetadata, job: DecryptJob) -> DecryptQueueInfo {
        DecryptQueueInfo(
            id: metadata.id,
            status: metadata.status,
            ready: isReady(metadata, job: job),
            readyURL: job.readyURL,
            downloadURL: job.downloadURL,
            validateUntil: metadata.validateUntil
        )
    }

    private func isReady(_ metadata: DecryptJobMetadata, job: DecryptJob) -> Bool {
        metadata.status == .succeeded && FileManager.default.fileExists(atPath: job.outputURL.path)
    }

    private static func workDirectory() -> URL {
        URL(fileURLWithPath: workDirectoryPath, isDirectory: true)
    }

    private static func cleanupExpiredJobs() {
        do {
            try cleanupExpiredJobDirectories(now: currentTimestamp())
        } catch {
            fputs("unfaird job cleanup failed: \(error)\n", stderr)
        }
    }

    private static func cleanupExpiredJobDirectories(now: Int) throws {
        try FileManager.default.createDirectory(
            at: workDirectory(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        let directories = try FileManager.default.contentsOfDirectory(
            at: workDirectory(),
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        for directory in directories where try isDirectory(directory) {
            guard let metadata = try? readMetadata(in: directory) else {
                continue
            }
            if metadata.validateUntil < now {
                removeJobDirectory(directory)
            }
        }
    }

    private static func removeJobDirectories() throws {
        let directories = try FileManager.default.contentsOfDirectory(
            at: workDirectory(),
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        for directory in directories where try isDirectory(directory) {
            removeJobDirectory(directory)
        }
    }

    private static func isDirectory(_ url: URL) throws -> Bool {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey])
        return values.isDirectory == true
    }

    private static func removeJobDirectory(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
    }

    private func validateUntilTimestamp() -> Int {
        dependencies.currentTimestamp() + Self.downloadTTLSeconds
    }

    private static func currentTimestamp() -> Int {
        Int(Date().timeIntervalSince1970)
    }

    private static func currentExecutablePath() -> String {
        // Support UNFAIRD_EXECUTABLE_PATH override for RootHide compatibility
        if let envPath = ProcessInfo.processInfo.environment["UNFAIRD_EXECUTABLE_PATH"],
           !envPath.isEmpty {
            return envPath
        }
        let path = CommandLine.arguments[0]
        if path.hasPrefix("/") {
            return path
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(path)
            .standardizedFileURL
            .path
    }

    private func validate(_ upload: DecryptUpload) throws {
        let fileCount = upload.ipa == nil ? 0 : 1
        let urlCount = upload.sourceURLString == nil ? 0 : 1
        guard fileCount + urlCount == 1 else {
            throw Abort(.badRequest, reason: "provide one ipa file or one ipa_url")
        }

        if let file = upload.ipa {
            try validateIPA(filename: file.filename)
            guard Int64(file.data.readableBytes) <= Self.maxUploadBytes else {
                throw Abort(.payloadTooLarge, reason: "upload limit is 8GB")
            }
        }

        if let urlString = upload.sourceURLString {
            _ = try RemoteIPAURL.parse(urlString)
        }
    }

    private func validateIPA(filename: String) throws {
        guard filename.lowercased().hasSuffix(".ipa") else {
            throw Abort(.badRequest, reason: "ipa file required")
        }
    }

    private func write(_ file: File, to url: URL) throws {
        var buffer = file.data
        guard let data = buffer.readData(length: buffer.readableBytes) else {
            throw Abort(.badRequest, reason: "empty upload")
        }
        guard Int64(data.count) <= Self.maxUploadBytes else {
            throw Abort(.payloadTooLarge, reason: "upload limit is 8GB")
        }
        try data.write(to: url, options: .atomic)
    }

    private func downloadIPA(from sourceURL: URL, to destination: URL) throws {
        let delegate = LimitedDownloadDelegate(destination: destination, maxBytes: Self.maxUploadBytes)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = TimeInterval(Self.runnerTimeoutSeconds)
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: delegateQueue)
        defer {
            session.invalidateAndCancel()
        }

        var request = URLRequest(url: sourceURL)
        request.httpMethod = "GET"
        request.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        session.downloadTask(with: request).resume()
        try delegate.wait()
    }

    private func writeMetadata(_ metadata: DecryptJobMetadata, in directory: URL) throws {
        let data = try JSONEncoder().encode(metadata)
        try data.write(to: Self.metadataURL(in: directory), options: .atomic)
    }

    private static func readMetadata(in directory: URL) throws -> DecryptJobMetadata {
        let data = try Data(contentsOf: metadataURL(in: directory))
        return try JSONDecoder().decode(DecryptJobMetadata.self, from: data)
    }

    private static func metadataURL(in directory: URL) -> URL {
        directory.appendingPathComponent("metadata.json")
    }

    private func errorDescription(_ error: Error) -> String {
        if let abort = error as? AbortError {
            return abort.reason
        }
        return String(describing: error)
    }

    private func multipartBoundary(from req: Request) throws -> String {
        guard let contentType = req.headers.contentType,
              contentType.type.lowercased() == "multipart",
              contentType.subType.lowercased() == "form-data",
              let boundary = contentType.parameters["boundary"],
              boundary.isEmpty == false
        else {
            throw Abort(.badRequest, reason: "multipart/form-data boundary required")
        }
        return boundary
    }
}

enum RemoteIPAURL {
    static func parse(_ rawValue: String) throws -> URL {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.isEmpty == false,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              components.host?.isEmpty == false,
              let url = components.url,
              url.isFileURL == false
        else {
            throw Abort(.badRequest, reason: "valid http or https ipa_url required")
        }
        return url
    }
}

private enum QueuedInputSource {
    case uploadedFile(URL)
    case remoteURL(URL)
}

private enum StreamingDecryptSource {
    case uploadedFile
    case remoteURL(URL)
}

private struct DecryptPreparedFileUpload {
    let job: DecryptJob
    let packageWorkingDirectory: URL
    let inputURL: URL
}

private final class StreamingDecryptUploadReceiver {
    private let parser: MultipartParser
    private let fileHandle: FileHandle
    private let maxUploadBytes: Int64
    private var currentHeaders = HTTPHeaders()
    private var currentFieldBuffer = ByteBufferAllocator().buffer(capacity: 0)
    private var uploadedFilePartCount = 0
    private var uploadedFileBytes: Int64 = 0
    private var remoteURLString: String?
    private var parseError: Error?

    init(boundary: String, fileHandle: FileHandle, maxUploadBytes: Int64) {
        self.parser = MultipartParser(boundary: boundary)
        self.fileHandle = fileHandle
        self.maxUploadBytes = maxUploadBytes

        parser.onHeader = { [weak self] field, value in
            self?.currentHeaders.replaceOrAdd(name: field, value: value)
        }
        parser.onBody = { [weak self] body in
            self?.handleBody(&body)
        }
        parser.onPartComplete = { [weak self] in
            self?.completePart()
        }
    }

    func consume(_ buffer: inout ByteBuffer) throws {
        try parser.execute(buffer)
        if let parseError = parseError {
            throw parseError
        }
    }

    func finish() throws -> StreamingDecryptSource {
        if let parseError = parseError {
            throw parseError
        }

        let sourceCount = uploadedFilePartCount + (remoteURLString == nil ? 0 : 1)
        guard sourceCount == 1 else {
            throw Abort(.badRequest, reason: "provide one ipa file or one ipa_url")
        }

        if uploadedFilePartCount == 1 {
            return .uploadedFile
        }

        return .remoteURL(try RemoteIPAURL.parse(remoteURLString ?? ""))
    }

    private func handleBody(_ body: inout ByteBuffer) {
        guard parseError == nil else {
            return
        }

        switch currentHeaders.contentDisposition?.name {
        case "ipa":
            writeFileBody(&body)
        case "url", "ipa_url":
            appendFieldBody(&body)
        default:
            return
        }
    }

    private func completePart() {
        guard parseError == nil else {
            resetPart()
            return
        }

        switch currentHeaders.contentDisposition?.name {
        case "ipa":
            completeFilePart()
        case "url", "ipa_url":
            completeURLPart()
        default:
            break
        }

        resetPart()
    }

    private func writeFileBody(_ body: inout ByteBuffer) {
        uploadedFileBytes += Int64(body.readableBytes)
        guard uploadedFileBytes <= maxUploadBytes else {
            parseError = Abort(.payloadTooLarge, reason: "upload limit is 8GB")
            return
        }
        guard let data = body.readData(length: body.readableBytes) else {
            parseError = Abort(.badRequest, reason: "empty upload")
            return
        }
        fileHandle.write(data)
    }

    private func appendFieldBody(_ body: inout ByteBuffer) {
        guard currentFieldBuffer.readableBytes + body.readableBytes <= 8192 else {
            parseError = Abort(.payloadTooLarge, reason: "ipa_url field too large")
            return
        }
        currentFieldBuffer.writeBuffer(&body)
    }

    private func completeFilePart() {
        guard let filename = currentHeaders.contentDisposition?.filename,
              filename.lowercased().hasSuffix(".ipa")
        else {
            parseError = Abort(.badRequest, reason: "ipa file required")
            return
        }
        uploadedFilePartCount += 1
        if uploadedFilePartCount > 1 {
            parseError = Abort(.badRequest, reason: "provide one ipa file or one ipa_url")
        }
    }

    private func completeURLPart() {
        var buffer = currentFieldBuffer
        guard let value = buffer.readString(length: buffer.readableBytes) else {
            parseError = Abort(.badRequest, reason: "valid http or https ipa_url required")
            return
        }
        if remoteURLString != nil {
            parseError = Abort(.badRequest, reason: "provide one ipa file or one ipa_url")
            return
        }
        remoteURLString = value
    }

    private func resetPart() {
        currentHeaders = HTTPHeaders()
        currentFieldBuffer = ByteBufferAllocator().buffer(capacity: 0)
    }
}

private final class DecryptTaskGate {
    static let shared = DecryptTaskGate()

    private let lock = NSLock()
    private var runningTasks = 0

    func reserve(workDirectory: URL, bytesPerTask: Int64) throws -> DecryptTaskReservation {
        lock.lock()
        defer { lock.unlock() }

        let available = try Self.availableBytes(at: workDirectory)
        let required = Int64(runningTasks + 1) * bytesPerTask
        guard available >= required else {
            throw Abort(.insufficientStorage, reason: "need 16GB free per running decrypt task")
        }

        runningTasks += 1
        return DecryptTaskReservation(gate: self)
    }

    fileprivate func release() {
        lock.lock()
        runningTasks = max(0, runningTasks - 1)
        lock.unlock()
    }

    private static func availableBytes(at url: URL) throws -> Int64 {
        var stats = statfs()
        guard statfs(url.path, &stats) == 0 else {
            throw Abort(.internalServerError, reason: "free space check failed: \(String(cString: strerror(errno)))")
        }
        return Int64(stats.f_bavail) * Int64(stats.f_bsize)
    }
}

private struct DecryptTaskReservation {
    private weak var gate: DecryptTaskGate?

    fileprivate init(gate: DecryptTaskGate) {
        self.gate = gate
    }

    fileprivate func release() {
        gate?.release()
    }
}

private final class LimitedDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let destination: URL
    private let maxBytes: Int64
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var completed = false
    private var result: Result<Void, Error>?
    private var pendingError: Error?

    init(destination: URL, maxBytes: Int64) {
        self.destination = destination
        self.maxBytes = maxBytes
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
            finish(.failure(Abort(.badGateway, reason: "ipa_url returned HTTP \(http.statusCode)")))
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

private struct DecryptJob {
    let id: UUID
    let directoryURL: URL
    let validateUntil: Int

    var outputURL: URL {
        directoryURL.appendingPathComponent("output.ipa")
    }

    var downloadURL: String {
        "/api/v1/decrypt/\(id.uuidString)/output"
    }

    var readyURL: String {
        "/api/v1/decrypt/\(id.uuidString)/ready"
    }

    func metadata(
        status: DecryptJobStatus,
        updatedAt: Int,
        exit: DecryptExit? = nil,
        error: String? = nil
    ) -> DecryptJobMetadata {
        DecryptJobMetadata(
            id: id,
            status: status,
            validateUntil: validateUntil,
            updatedAt: updatedAt,
            exit: exit,
            error: error
        )
    }
}
