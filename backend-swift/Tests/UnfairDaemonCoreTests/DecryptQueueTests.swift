import Foundation
@testable import UnfairDaemonCore
import XCTVapor

final class DecryptQueueTests: XCTestCase {
    func testReadyAndOutputRequireConfiguredAccessToken() throws {
        let context = try TestContext()
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let config = WebConfig(
            port: 18080,
            dataDirectory: context.root.appendingPathComponent("data", isDirectory: true),
            publicDirectory: context.root.appendingPathComponent("public", isDirectory: true),
            publicBaseURL: "",
            disableHTTPSRedirect: true,
            autoCleanupDays: 0,
            autoCleanupMaxMB: 0,
            maxDownloadMB: 0,
            downloadThreads: 1,
            accessPasswordHash: "test-token"
        )
        try routes(app, config: config, decryptService: context.service)
        let jobID = UUID().uuidString

        try app.testable().test(.GET, "/api/v1/decrypt/\(jobID)/ready") { response in
            XCTAssertEqual(response.status, .unauthorized)
        }
        try app.testable().test(.GET, "/api/v1/decrypt/\(jobID)/output") { response in
            XCTAssertEqual(response.status, .unauthorized)
        }
    }

    func testDecryptRequestReturnsQueueBeforeWorkerRuns() throws {
        let context = try TestContext()
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        try routes(app, decryptService: context.service)

        var queued: DecryptQueueInfo?
        try app.testable().test(
            .POST,
            "/api/v1/decrypt",
            headers: ["Content-Type": "multipart/form-data; boundary=123"],
            body: multipartIPA()
        ) { response in
            XCTAssertEqual(response.status, .ok)
            let content = try response.content.decode(DecryptQueueResponse.self)
            queued = content.queue
            XCTAssertEqual(content.queue.status, .queued)
            XCTAssertFalse(content.queue.ready)
            XCTAssertEqual(content.queue.readyURL, "/api/v1/decrypt/\(content.queue.id.uuidString)/ready")
            XCTAssertEqual(content.queue.downloadURL, "/api/v1/decrypt/\(content.queue.id.uuidString)/output")
        }

        let queue = try XCTUnwrap(queued)
        XCTAssertEqual(context.scheduler.jobs.count, 1)

        try app.testable().test(.GET, queue.readyURL) { response in
            XCTAssertEqual(response.status, .ok)
            let content = try response.content.decode(DecryptReadyResponse.self)
            XCTAssertEqual(content.queue.status, .queued)
            XCTAssertFalse(content.queue.ready)
            XCTAssertNil(content.exit)
            XCTAssertNil(content.error)
        }

        try app.testable().test(.GET, queue.downloadURL) { response in
            XCTAssertEqual(response.status, .conflict)
        }
    }

    func testReadyEndpointAllowsDownloadAfterWorkerSucceeds() throws {
        let context = try TestContext()
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        try routes(app, decryptService: context.service)

        var queued: DecryptQueueInfo?
        try app.testable().test(
            .POST,
            "/api/v1/decrypt",
            headers: ["Content-Type": "multipart/form-data; boundary=123"],
            body: multipartIPA()
        ) { response in
            queued = try response.content.decode(DecryptQueueResponse.self).queue
        }

        let queue = try XCTUnwrap(queued)
        try context.scheduler.runNext()

        try app.testable().test(.GET, queue.readyURL) { response in
            XCTAssertEqual(response.status, .ok)
            let content = try response.content.decode(DecryptReadyResponse.self)
            XCTAssertEqual(content.queue.status, .succeeded)
            XCTAssertTrue(content.queue.ready)
            XCTAssertEqual(content.exit?.code, 0)
            XCTAssertEqual(content.exit?.stdout, "runner ok")
            XCTAssertNil(content.error)
        }

        try app.testable().test(.GET, queue.downloadURL) { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertEqual(response.body.string, "decrypted ipa")
        }
    }

    func testReadyEndpointReportsFailedWorkerLogs() throws {
        let context = try TestContext(
            runProcess: { _, _, _, _, _ in
                PosixSpawnResult(
                    exitCode: 1,
                    stdout: Data("runner stdout".utf8),
                    stderr: Data("runner stderr".utf8)
                )
            }
        )
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        try routes(app, decryptService: context.service)

        var queued: DecryptQueueInfo?
        try app.testable().test(
            .POST,
            "/api/v1/decrypt",
            headers: ["Content-Type": "multipart/form-data; boundary=123"],
            body: multipartIPA()
        ) { response in
            queued = try response.content.decode(DecryptQueueResponse.self).queue
        }

        let queue = try XCTUnwrap(queued)
        try context.scheduler.runNext()

        try app.testable().test(.GET, queue.readyURL) { response in
            XCTAssertEqual(response.status, .ok)
            let content = try response.content.decode(DecryptReadyResponse.self)
            XCTAssertEqual(content.queue.status, .failed)
            XCTAssertFalse(content.queue.ready)
            XCTAssertEqual(content.exit?.code, 1)
            XCTAssertEqual(content.exit?.stdout, "runner stdout")
            XCTAssertEqual(content.exit?.stderr, "runner stderr")
            XCTAssertEqual(content.error, "output ipa missing")
        }

        try app.testable().test(.GET, queue.downloadURL) { response in
            XCTAssertEqual(response.status, .conflict)
        }
    }

    func testExitZeroWithInvalidPackageIsStillReportedAsFailed() throws {
        let context = try TestContext(
            verifyPackage: { _, _ in
                throw DecryptVerificationError(code: .stillEncrypted, paths: ["Payload/Test.app/Test"])
            }
        )
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        try routes(app, decryptService: context.service)
        var queued: DecryptQueueInfo?
        try app.testable().test(
            .POST,
            "/api/v1/decrypt",
            headers: ["Content-Type": "multipart/form-data; boundary=123"],
            body: multipartIPA()
        ) { response in
            queued = try response.content.decode(DecryptQueueResponse.self).queue
        }

        let queue = try XCTUnwrap(queued)
        try context.scheduler.runNext()
        try app.testable().test(.GET, queue.readyURL) { response in
            let content = try response.content.decode(DecryptReadyResponse.self)
            XCTAssertEqual(content.queue.status, .failed)
            XCTAssertFalse(content.queue.ready)
            XCTAssertEqual(content.error, "decrypt verification failed (still_encrypted): Payload/Test.app/Test")
        }
        try app.testable().test(.GET, queue.downloadURL) { response in
            XCTAssertEqual(response.status, .conflict)
        }
    }

    private func multipartIPA() -> ByteBuffer {
        var buffer = ByteBufferAllocator().buffer(capacity: 0)
        buffer.writeString("--123\r\n")
        buffer.writeString("Content-Disposition: form-data; name=\"ipa\"; filename=\"app.ipa\"\r\n")
        buffer.writeString("Content-Type: application/octet-stream\r\n")
        buffer.writeString("\r\n")
        buffer.writeString("fake ipa\r\n")
        buffer.writeString("--123--\r\n")
        return buffer
    }
}

private final class TestContext {
    let root: URL
    let scheduler: ManualJobScheduler
    let service: DecryptService

    init(
        runProcess: DecryptService.ProcessRunner? = nil,
        verifyPackage: @escaping DecryptService.PackageVerifier = { _, _ in }
    ) throws {
        let scheduler = ManualJobScheduler()
        self.scheduler = scheduler
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("unfaird-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let workDirectory = root.appendingPathComponent("jobs", isDirectory: true)
        let packageRoot = root.appendingPathComponent("packages", isDirectory: true)

        service = DecryptService(
            dependencies: DecryptService.Dependencies(
                workDirectory: { workDirectory },
                packageWorkingDirectory: { jobID in
                    packageRoot.appendingPathComponent(jobID.uuidString, isDirectory: true)
                },
                sandboxProfileURL: { _ in nil },
                currentExecutablePath: { "/usr/bin/false" },
                currentTimestamp: { 1_700_000_000 },
                runProcess: runProcess ?? Self.successfulRunProcess,
                reserveTask: { _, _ in {} },
                scheduleJob: scheduler.schedule,
                verifyPackage: verifyPackage
            )
        )
    }

    private static func successfulRunProcess(
        executablePath: String,
        arguments: [String],
        workingDirectory: URL,
        sandboxProfileURL: URL?,
        timeoutSeconds: Int?
    ) throws -> PosixSpawnResult {
        let outputIndex = try XCTUnwrap(arguments.firstIndex(of: "--output"))
        let outputPath = arguments[arguments.index(after: outputIndex)]
        try Data("decrypted ipa".utf8).write(to: URL(fileURLWithPath: outputPath))
        return PosixSpawnResult(
            exitCode: 0,
            stdout: Data("runner ok".utf8),
            stderr: Data()
        )
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: root)
    }
}

private final class ManualJobScheduler {
    private(set) var jobs: [() -> Void] = []

    func schedule(_ job: @escaping () -> Void) {
        jobs.append(job)
    }

    func runNext() throws {
        let job = jobs.removeFirst()
        job()
    }
}
