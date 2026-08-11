import Foundation
@testable import UnfairDaemonCore
import XCTest
import Vapor

final class PosixSpawnTests: XCTestCase {
    func testStreamsStdoutAndStderrLinesWhileKeepingFinalOutput() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("unfaird-posix-spawn-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
        }

        let lock = NSLock()
        var events: [String] = []
        let result = try PosixSpawn.run(
            executablePath: "/bin/sh",
            arguments: [
                "-c",
                "printf 'out-one\\n'; printf 'err-one\\n' >&2; printf 'out-two'",
            ],
            workingDirectory: directory
        ) { stream, line in
            lock.lock()
            defer { lock.unlock() }
            events.append("\(Self.label(stream)):\(line)")
        }

        lock.lock()
        let capturedEvents = events
        lock.unlock()

        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.stdoutString, "out-one\nout-two")
        XCTAssertEqual(result.stderrString, "err-one\n")
        XCTAssertEqual(capturedEvents.count, 3)
        XCTAssertTrue(capturedEvents.contains("stdout:out-one"))
        XCTAssertTrue(capturedEvents.contains("stderr:err-one"))
        XCTAssertTrue(capturedEvents.contains("stdout:out-two"))
    }

    func testCancellationTerminatesTheProcessGroupPromptly() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("unfaird-posix-cancel-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cancellation = PosixSpawnCancellation()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
            cancellation.cancel()
        }
        let started = Date()

        XCTAssertThrowsError(
            try PosixSpawn.run(
                executablePath: "/bin/sh",
                arguments: ["-c", "sleep 30"],
                workingDirectory: directory,
                timeoutSeconds: 30,
                cancellation: cancellation
            )
        ) { error in
            XCTAssertEqual((error as? AbortError)?.reason, "decrypt cancelled")
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }

    private static func label(_ stream: PosixSpawn.OutputStream) -> String {
        switch stream {
        case .stdout:
            return "stdout"
        case .stderr:
            return "stderr"
        }
    }
}
