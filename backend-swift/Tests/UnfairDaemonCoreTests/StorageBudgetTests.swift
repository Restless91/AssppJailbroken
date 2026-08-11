@testable import UnfairDaemonCore
import XCTest

final class StorageBudgetTests: XCTestCase {
    func testRequiredSpaceScalesWithPackageSizeAndKeepsAFloor() {
        XCTAssertEqual(StorageBudget.requiredBytes(packageSize: 500 * 1024 * 1024), 2 * 1024 * 1024 * 1024)
        XCTAssertEqual(StorageBudget.requiredBytes(packageSize: 2 * 1024 * 1024 * 1024), 6_979_321_856)
    }

    func testRequiredSpaceCreditsAnExistingPartialDownload() {
        let gibibyte: Int64 = 1024 * 1024 * 1024

        XCTAssertEqual(
            StorageBudget.requiredBytes(packageSize: 2 * gibibyte, existingBytes: gibibyte),
            5_905_580_032
        )
        XCTAssertEqual(
            StorageBudget.requiredBytes(packageSize: 500 * 1024 * 1024, existingBytes: 300 * 1024 * 1024),
            1_832_910_848
        )
        XCTAssertEqual(
            StorageBudget.requiredBytes(packageSize: 0, existingBytes: 3 * gibibyte),
            2 * gibibyte
        )
    }

    func testReservationsAccountForDifferentTaskSizes() throws {
        let gate = DecryptTaskGate(availableBytes: { _ in 10 })
        let first = try gate.reserve(workDirectory: URL(fileURLWithPath: "/tmp"), bytesPerTask: 6)

        XCTAssertThrowsError(try gate.reserve(workDirectory: URL(fileURLWithPath: "/tmp"), bytesPerTask: 5))

        first.release()
        XCTAssertNoThrow(try gate.reserve(workDirectory: URL(fileURLWithPath: "/tmp"), bytesPerTask: 5))
    }
}
