import Foundation
@testable import UnfairDaemonCore
import XCTest

final class DownloadRecoveryStoreTests: XCTestCase {
    func testSavedRecoveryMaterialSurvivesStoreRecreation() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("unfaird-recovery-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let material = DownloadRecoveryMaterial(
            downloadURL: "https://example.apple.com/app.ipa",
            sinfs: [Sinf(id: 7, sinf: "ticket")],
            iTunesMetadata: "metadata"
        )

        try DownloadRecoveryStore(directory: directory).save(material, taskID: "task-1")
        let reopened = try DownloadRecoveryStore(directory: directory)

        XCTAssertEqual(try reopened.load(taskID: "task-1"), material)
    }
}
