import Foundation
@testable import UnfairDaemonCore
import XCTest

final class ArtifactDigestTests: XCTestCase {
    func testSHA256ReturnsLowercaseDigestForFile() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("artifact-digest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("abc".utf8).write(to: url)

        XCTAssertEqual(
            try ArtifactDigest.sha256(of: url),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
    }
}
