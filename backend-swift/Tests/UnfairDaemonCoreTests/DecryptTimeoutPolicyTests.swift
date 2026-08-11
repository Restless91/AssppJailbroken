@testable import UnfairDaemonCore
import XCTest

final class DecryptTimeoutPolicyTests: XCTestCase {
    func testTimeoutScalesForLargePackagesAndIsCapped() {
        XCTAssertEqual(DecryptTimeoutPolicy.seconds(fileSize: 500 * 1024 * 1024), 15 * 60)
        XCTAssertEqual(DecryptTimeoutPolicy.seconds(fileSize: 2 * 1024 * 1024 * 1024), 20 * 60)
        XCTAssertEqual(DecryptTimeoutPolicy.seconds(fileSize: 8 * 1024 * 1024 * 1024), 60 * 60)
    }
}
