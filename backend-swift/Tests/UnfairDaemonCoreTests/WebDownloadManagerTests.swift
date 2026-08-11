import Foundation
@testable import UnfairDaemonCore
import XCTest

final class WebDownloadManagerTests: XCTestCase {
    func testLoadsFailedTasksFromPersistence() throws {
        let context = try DownloadManagerTestContext()
        defer { context.cleanup() }

        let task = context.task(status: "failed", error: "Decrypt failed: test")
        try context.writeTasks([task])

        let manager = try WebDownloadManager(config: context.config)

        let tasks = manager.allTasks()
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].id, task.id)
        XCTAssertEqual(tasks[0].status, "failed")
        XCTAssertEqual(tasks[0].error, "Decrypt failed: test")
    }

    func testMarksInterruptedTasksAsFailedOnLoad() throws {
        let context = try DownloadManagerTestContext()
        defer { context.cleanup() }

        var task = context.task(status: "decrypting", error: nil)
        task.progress = 100
        try context.writePackageFile(for: task)
        try context.writeTasks([task])

        let manager = try WebDownloadManager(config: context.config)

        let tasks = manager.allTasks()
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].status, "failed")
        XCTAssertEqual(tasks[0].progress, 100)
        XCTAssertEqual(tasks[0].error, "Task interrupted while decrypting.")
        XCTAssertEqual(tasks[0].hasFile, true)
        XCTAssertTrue(tasks[0].logs?.last?.contains("decrypt: interrupted while decrypting") == true)

        let persisted = try context.readTasks()
        XCTAssertEqual(persisted.count, 1)
        XCTAssertEqual(persisted[0].status, "failed")
        XCTAssertEqual(persisted[0].error, "Task interrupted while decrypting.")
        XCTAssertTrue(persisted[0].logs?.last?.contains("decrypt: interrupted while decrypting") == true)
    }

    func testMarksCompletedTaskWithMissingFileAsFailedOnLoad() throws {
        let context = try DownloadManagerTestContext()
        defer { context.cleanup() }

        let task = context.task(status: "completed", error: nil)
        try context.writeTasks([task])

        let manager = try WebDownloadManager(config: context.config)

        let tasks = manager.allTasks()
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks[0].status, "failed")
        XCTAssertEqual(tasks[0].error, "Package file is missing.")
        XCTAssertEqual(tasks[0].hasFile, false)
        XCTAssertTrue(tasks[0].logs?.last?.contains("download: package file is missing") == true)

        let persisted = try context.readTasks()
        XCTAssertEqual(persisted.count, 1)
        XCTAssertEqual(persisted[0].status, "failed")
        XCTAssertEqual(persisted[0].error, "Package file is missing.")
        XCTAssertTrue(persisted[0].logs?.last?.contains("download: package file is missing") == true)
    }

    func testRemovesEmptyOrphanPackageDirectoriesOnLoad() throws {
        let context = try DownloadManagerTestContext()
        defer { context.cleanup() }

        let emptyVersionDirectory = context.dataDirectory
            .appendingPathComponent("packages", isDirectory: true)
            .appendingPathComponent("account", isDirectory: true)
            .appendingPathComponent("bundle", isDirectory: true)
            .appendingPathComponent("1.0", isDirectory: true)
        try FileManager.default.createDirectory(at: emptyVersionDirectory, withIntermediateDirectories: true)

        _ = try WebDownloadManager(config: context.config)

        XCTAssertFalse(FileManager.default.fileExists(atPath: emptyVersionDirectory.path))
    }
}

private final class DownloadManagerTestContext {
    let root: URL
    let dataDirectory: URL
    let publicDirectory: URL
    let config: WebConfig

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("unfaird-download-manager-tests-\(UUID().uuidString)", isDirectory: true)
        dataDirectory = root.appendingPathComponent("data", isDirectory: true)
        publicDirectory = root.appendingPathComponent("public", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: publicDirectory, withIntermediateDirectories: true)

        config = WebConfig(
            port: 18080,
            dataDirectory: dataDirectory,
            publicDirectory: publicDirectory,
            publicBaseURL: "",
            disableHTTPSRedirect: true,
            autoCleanupDays: 0,
            autoCleanupMaxMB: 0,
            maxDownloadMB: 0,
            downloadThreads: 8,
            accessPasswordHash: ""
        )
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: root)
    }

    func task(status: String, error: String?) -> DownloadTask {
        let id = UUID().uuidString
        let software = Software(
            id: 1,
            bundleID: "com.example.X",
            name: "X",
            version: "11.96",
            price: 0,
            artistName: "X Corp.",
            sellerName: "X Corp.",
            description: "",
            averageUserRating: 0,
            userRatingCount: 0,
            artworkUrl: "",
            screenshotUrls: [],
            minimumOsVersion: "16.0",
            fileSizeBytes: nil,
            releaseDate: "2026-06-02T00:00:00Z",
            releaseNotes: nil,
            formattedPrice: nil,
            primaryGenreName: "Social Networking"
        )
        return DownloadTask(
            id: id,
            software: software,
            accountHash: "7af9806aca7c1ede",
            downloadURL: "https://example.apple.com/app.ipa",
            sinfs: [],
            iTunesMetadata: nil,
            status: status,
            progress: 0,
            speed: "0 B/s",
            error: error,
            filePath: packageURL(for: id).path,
            createdAt: "2026-06-02T00:00:00Z",
            hasFile: nil
        )
    }

    func writePackageFile(for task: DownloadTask) throws {
        guard let path = task.filePath else {
            return
        }
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("ipa".utf8).write(to: url)
    }

    func writeTasks(_ tasks: [DownloadTask]) throws {
        let data = try JSONEncoder().encode(tasks)
        try data.write(to: tasksFile)
    }

    func readTasks() throws -> [DownloadTask] {
        let data = try Data(contentsOf: tasksFile)
        return try JSONDecoder().decode([DownloadTask].self, from: data)
    }

    private var tasksFile: URL {
        dataDirectory.appendingPathComponent("tasks.json")
    }

    private func packageURL(for id: String) -> URL {
        dataDirectory
            .appendingPathComponent("packages", isDirectory: true)
            .appendingPathComponent("7af9806aca7c1ede", isDirectory: true)
            .appendingPathComponent("com.example.X", isDirectory: true)
            .appendingPathComponent("11.96", isDirectory: true)
            .appendingPathComponent("\(id).ipa")
    }
}
