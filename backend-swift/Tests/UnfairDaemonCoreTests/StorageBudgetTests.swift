@testable import UnfairDaemonCore
import XCTest

final class StorageBudgetTests: XCTestCase {
    func testRequiredSpaceScalesWithPackageSizeAndKeepsAFloor() {
        XCTAssertEqual(StorageBudget.requiredBytes(packageSize: 500 * 1024 * 1024), 2 * 1024 * 1024 * 1024)
        XCTAssertEqual(StorageBudget.requiredBytes(packageSize: 2 * 1024 * 1024 * 1024), 6_979_321_856)
    }

    func testReservationsAccountForDifferentTaskSizes() throws {
        let gate = DecryptTaskGate(availableBytes: { _ in 10 })
        let first = try gate.reserve(workDirectory: URL(fileURLWithPath: "/tmp"), bytesPerTask: 6)

        XCTAssertThrowsError(try gate.reserve(workDirectory: URL(fileURLWithPath: "/tmp"), bytesPerTask: 5))

        first.release()
        XCTAssertNoThrow(try gate.reserve(workDirectory: URL(fileURLWithPath: "/tmp"), bytesPerTask: 5))
    }
}
