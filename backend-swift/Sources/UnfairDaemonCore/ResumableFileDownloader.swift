import CryptoKit
import Foundation
import Vapor

final class ResumableFileDownloader {
    private struct PartialMetadata: Codable {
        var sourceDigest: String
        var entityTag: String?
    }

    private let configuration: URLSessionConfiguration

    init(configuration: URLSessionConfiguration = .ephemeral) {
        self.configuration = configuration
    }

    func download(
        url: URL,
        destination: URL,
        maxBytes: Int64,
        timeout: TimeInterval,
        progress: @escaping (Int64, Int64, TimeInterval, Int64) -> Void,
        taskStarted: (URLSessionDataTask) -> Void
    ) throws {
        var mayRestartRange = true
        while true {
            do {
                try downloadOnce(
                    url: url,
                    destination: destination,
                    maxBytes: maxBytes,
                    timeout: timeout,
                    progress: progress,
                    taskStarted: taskStarted
                )
                return
            } catch DownloadRangeError.invalidResponse where mayRestartRange {
                mayRestartRange = false
                removePartialFiles(destination: destination)
            }
        }
    }

    static func partialURL(for destination: URL) -> URL {
        destination.deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).download.part")
    }

    static func metadataURL(for destination: URL) -> URL {
        partialURL(for: destination).appendingPathExtension("json")
    }

    static func removePartialFiles(for destination: URL) {
        try? FileManager.default.removeItem(at: partialURL(for: destination))
        try? FileManager.default.removeItem(at: metadataURL(for: destination))
    }

    private func downloadOnce(
        url: URL,
        destination: URL,
        maxBytes: Int64,
        timeout: TimeInterval,
        progress: @escaping (Int64, Int64, TimeInterval, Int64) -> Void,
        taskStarted: (URLSessionDataTask) -> Void
    ) throws {
        let partialURL = Self.partialURL(for: destination)
        let metadataURL = Self.metadataURL(for: destination)
        let sourceDigest = Self.digest(url.absoluteString)
        let metadata = (try? Data(contentsOf: metadataURL))
            .flatMap { try? JSONDecoder().decode(PartialMetadata.self, from: $0) }
        if metadata?.sourceDigest != sourceDigest {
            removePartialFiles(destination: destination)
        }
        let localBytes = Self.fileSize(partialURL)
        if localBytes > maxBytes {
            removePartialFiles(destination: destination)
            throw Abort(.payloadTooLarge, reason: "remote ipa limit is 8GB")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        if localBytes > 0 {
            request.setValue("bytes=\(localBytes)-", forHTTPHeaderField: "Range")
            if let entityTag = metadata?.entityTag {
                request.setValue(entityTag, forHTTPHeaderField: "If-Range")
            }
        }

        let delegate = ResumableDownloadDelegate(
            destination: destination,
            partialURL: partialURL,
            metadataURL: metadataURL,
            sourceDigest: sourceDigest,
            localBytes: localBytes,
            maxBytes: maxBytes,
            progress: progress
        )
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = timeout
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: delegateQueue)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: request)
        taskStarted(task)
        task.resume()
        try delegate.wait()
    }

    private func removePartialFiles(destination: URL) {
        Self.removePartialFiles(for: destination)
    }

    private static func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

private final class ResumableDownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private struct PartialMetadata: Codable {
        var sourceDigest: String
        var entityTag: String?
    }

    private let destination: URL
    private let partialURL: URL
    private let metadataURL: URL
    private let sourceDigest: String
    private let localBytes: Int64
    private let maxBytes: Int64
    private let progress: (Int64, Int64, TimeInterval, Int64) -> Void
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var result: Result<Void, Error>?
    private var pendingError: Error?
    private var completed = false
    private var fileHandle: FileHandle?
    private var expectedTotalBytes: Int64 = -1
    private var receivedBytes: Int64 = 0
    private var effectiveBaseBytes: Int64 = 0
    private var lastTime = Date()
    private var lastReportedBytes: Int64 = 0

    init(
        destination: URL,
        partialURL: URL,
        metadataURL: URL,
        sourceDigest: String,
        localBytes: Int64,
        maxBytes: Int64,
        progress: @escaping (Int64, Int64, TimeInterval, Int64) -> Void
    ) {
        self.destination = destination
        self.partialURL = partialURL
        self.metadataURL = metadataURL
        self.sourceDigest = sourceDigest
        self.localBytes = localBytes
        self.maxBytes = maxBytes
        self.progress = progress
    }

    func wait() throws {
        semaphore.wait()
        switch result {
        case .success: return
        case .failure(let error): throw error
        case nil: throw Abort(.internalServerError, reason: "download finished without result")
        }
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        do {
            guard let http = response as? HTTPURLResponse else {
                throw Abort(.badGateway, reason: "IPA download returned an invalid response")
            }
            guard (200...299).contains(http.statusCode) else {
                throw Abort(.badGateway, reason: "IPA download returned HTTP \(http.statusCode)")
            }
            let plan = try DownloadRangePlan.response(
                statusCode: http.statusCode,
                contentRange: http.value(forHTTPHeaderField: "Content-Range"),
                localBytes: localBytes,
                responseBytes: max(response.expectedContentLength, 0)
            )
            switch plan {
            case .append(let total):
                effectiveBaseBytes = localBytes
                expectedTotalBytes = total
                fileHandle = try Self.openForAppend(partialURL)
            case .replace(let total):
                effectiveBaseBytes = 0
                expectedTotalBytes = total
                fileHandle = try Self.openForReplace(partialURL)
            }
            guard expectedTotalBytes <= maxBytes else {
                throw Abort(.payloadTooLarge, reason: "remote ipa limit is 8GB")
            }
            let metadata = PartialMetadata(
                sourceDigest: sourceDigest,
                entityTag: http.value(forHTTPHeaderField: "ETag")
            )
            let data = try JSONEncoder().encode(metadata)
            try data.write(to: metadataURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: metadataURL.path)
            completionHandler(.allow)
        } catch {
            pendingError = error
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard pendingError == nil else { return }
        do {
            try fileHandle?.write(contentsOf: data)
            receivedBytes += Int64(data.count)
            let total = effectiveBaseBytes + receivedBytes
            guard total <= maxBytes else {
                throw Abort(.payloadTooLarge, reason: "remote ipa limit is 8GB")
            }
            let now = Date()
            let elapsed = now.timeIntervalSince(lastTime)
            if elapsed >= 0.5 {
                progress(total, expectedTotalBytes, elapsed, total - lastReportedBytes)
                lastTime = now
                lastReportedBytes = total
            }
        } catch {
            pendingError = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        try? fileHandle?.synchronize()
        try? fileHandle?.close()
        fileHandle = nil
        if let pendingError {
            finish(.failure(pendingError))
            return
        }
        if let error {
            finish(.failure(error))
            return
        }
        let finalBytes = effectiveBaseBytes + receivedBytes
        if expectedTotalBytes > 0, finalBytes != expectedTotalBytes {
            finish(.failure(Abort(.badGateway, reason: "IPA download ended at \(finalBytes) of \(expectedTotalBytes) bytes")))
            return
        }
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: partialURL, to: destination)
            try? FileManager.default.removeItem(at: metadataURL)
            finish(.success(()))
        } catch {
            finish(.failure(error))
        }
    }

    private func finish(_ result: Result<Void, Error>) {
        lock.lock()
        defer { lock.unlock() }
        guard completed == false else { return }
        completed = true
        self.result = result
        semaphore.signal()
    }

    private static func openForAppend(_ url: URL) throws -> FileHandle {
        if FileManager.default.fileExists(atPath: url.path) == false {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try handle.seekToEnd()
        return handle
    }

    private static func openForReplace(_ url: URL) throws -> FileHandle {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try handle.truncate(atOffset: 0)
        return handle
    }
}
