import Darwin
import Dispatch
import Foundation
import Vapor

struct DecryptService {
    typealias ProcessRunner = (String, [String], URL, URL?, Int?) throws -> PosixSpawnResult
    typealias JobScheduler = (@escaping @Sendable () -> Void) -> Void
    typealias PackageVerifier = (URL, URL) throws -> Void

    struct Dependencies {
        let workDirectory: () -> URL
        let packageWorkingDirectory: (UUID) throws -> URL
        let sandboxProfileURL: (URL) throws -> URL?
        let currentExecutablePath: () -> String
        let currentTimestamp: () -> Int
        let runProcess: ProcessRunner
        let reserveTask: (URL, Int64) throws -> (() -> Void)
        let scheduleJob: JobScheduler
        let verifyPackage: PackageVerifier

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
            scheduleJob: { work in DeviceTaskQueue.shared.async(work) },
            verifyPackage: { outputURL, sourceURL in
                _ = try DecryptVerifier.verify(
                    outputURL: outputURL,
                    sourceURL: sourceURL,
                    allowEncryptedExtensions: true
                )
            }
        )
    }

    static let maxUploadBytes: Int64 = 8 * 1024 * 1024 * 1024
    private static let downloadTTLSeconds = 3600
    private static let cleanupIntervalSeconds = 60
    private static let remoteDownloadTimeoutSeconds = 15 * 60
    private static let workDirectoryPath = "/var/tmp/unfaird/jobs"
    private static let cleanupLock = NSLock()
    private static var cleanupTimer: DispatchSourceTimer?

    private let dependencies: Dependencies

    init(dependencies: Dependencies = .live) {
        self.dependencies = dependencies
    }

    static func prepareWorkDirectoryForStartup() throws {
        try FileManager.default.createDirectory(
            at: workDirectory(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
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

            let packageInputURL = try packageInputURL(
                from: inputSource,
                packageWorkingDirectory: packageWorkingDirectory
            )
            let packageSize = ((try? FileManager.default.attributesOfItem(atPath: packageInputURL.path)[.size]) as? NSNumber)?.int64Value ?? 0
            let releaseReservation = try dependencies.reserveTask(
                dependencies.workDirectory(),
                StorageBudget.requiredBytes(packageSize: packageSize)
            )
            defer { releaseReservation() }
            let sandboxProfileURL = try dependencies.sandboxProfileURL(job.directoryURL)
            let result = try runDecryptRunner(
                for: job,
                inputURL: packageInputURL,
                packageWorkingDirectory: packageWorkingDirectory,
                sandboxProfileURL: sandboxProfileURL
            )
            try finalize(job: job, inputURL: packageInputURL, result: result)
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

    private func runDecryptRunner(
        for job: DecryptJob,
        inputURL: URL,
        packageWorkingDirectory: URL,
        sandboxProfileURL: URL?
    ) throws -> PosixSpawnResult {
        let currentExecutable = dependencies.currentExecutablePath()
        let runnerPath = PackageRunnerResolver.executablePath(
            currentExecutablePath: currentExecutable
        )
        return try dependencies.runProcess(
            runnerPath,
            PackageRunnerResolver.arguments(
                inputPath: inputURL.path,
                outputPath: job.outputURL.path,
                workingDirectoryPath: packageWorkingDirectory.path,
                extensionPolicy: .compatible,
                supportsExtensionPolicy: runnerPath != currentExecutable,
                verbose: BuildInfo.variant != "iphone15"
            ),
            job.directoryURL,
            sandboxProfileURL,
            DecryptTimeoutPolicy.seconds(
                fileSize: ((try? FileManager.default.attributesOfItem(atPath: inputURL.path)[.size]) as? NSNumber)?.int64Value ?? 0
            )
        )
    }

    private func finalize(job: DecryptJob, inputURL: URL, result: PosixSpawnResult) throws {
        let exit = exit(for: result, job: job)
        if result.exitCode == 0,
           FileManager.default.fileExists(atPath: job.outputURL.path) {
            try dependencies.verifyPackage(job.outputURL, inputURL)
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
        configuration.timeoutIntervalForResource = TimeInterval(Self.remoteDownloadTimeoutSeconds)
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
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
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

final class DecryptTaskGate {
    static let shared = DecryptTaskGate()

    private let lock = NSLock()
    private let availableBytes: (URL) throws -> Int64
    private var reservedBytes: Int64 = 0

    init(availableBytes: @escaping (URL) throws -> Int64 = DecryptTaskGate.fileSystemAvailableBytes) {
        self.availableBytes = availableBytes
    }

    func reserve(workDirectory: URL, bytesPerTask: Int64) throws -> DecryptTaskReservation {
        lock.lock()
        defer { lock.unlock() }

        let available = try availableBytes(workDirectory)
        let (required, overflow) = reservedBytes.addingReportingOverflow(bytesPerTask)
        guard overflow == false else {
            throw Abort(.insufficientStorage, reason: "decrypt storage reservation overflow")
        }
        guard available >= required else {
            throw Abort(
                .insufficientStorage,
                reason: "insufficient storage: need \(required) bytes, available \(available) bytes"
            )
        }

        reservedBytes = required
        return DecryptTaskReservation(gate: self, bytes: bytesPerTask)
    }

    fileprivate func release(bytes: Int64) {
        lock.lock()
        reservedBytes = max(0, reservedBytes - bytes)
        lock.unlock()
    }

    private static func fileSystemAvailableBytes(at url: URL) throws -> Int64 {
        var stats = statfs()
        guard statfs(url.path, &stats) == 0 else {
            throw Abort(.internalServerError, reason: "free space check failed: \(String(cString: strerror(errno)))")
        }
        return Int64(stats.f_bavail) * Int64(stats.f_bsize)
    }
}

struct DecryptTaskReservation {
    private weak var gate: DecryptTaskGate?
    private let bytes: Int64

    fileprivate init(gate: DecryptTaskGate, bytes: Int64) {
        self.gate = gate
        self.bytes = bytes
    }

    func release() {
        gate?.release(bytes: bytes)
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
