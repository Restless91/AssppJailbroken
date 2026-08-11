@testable import UnfairDaemonCore
import XCTest

final class DownloadRangePlanTests: XCTestCase {
    func testContinuesAtMatchingContentRangeOffset() throws {
        let plan = try DownloadRangePlan.response(
            statusCode: 206,
            contentRange: "bytes 1024-4095/4096",
            localBytes: 1024,
            responseBytes: 3072
        )

        XCTAssertEqual(plan, .append(expectedTotalBytes: 4096))
    }

    func testRestartsWhenServerIgnoresRangeAndReturnsFullResponse() throws {
        XCTAssertEqual(
            try DownloadRangePlan.response(
                statusCode: 200,
                contentRange: nil,
                localBytes: 1024,
                responseBytes: 4096
            ),
            .replace(expectedTotalBytes: 4096)
        )
    }

    func testRejectsMismatchedRangeToAvoidCorruptingPackage() {
        XCTAssertThrowsError(try DownloadRangePlan.response(
            statusCode: 206,
            contentRange: "bytes 2048-4095/4096",
            localBytes: 1024,
            responseBytes: 2048
        ))
    }
}
