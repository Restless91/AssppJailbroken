@testable import UnfairDaemonCore
import XCTest

final class DecryptExecutionStateTests: XCTestCase {
    func testLegacyExtensionPolicyMigration() {
        XCTAssertEqual(ExtensionDecryptionPolicy.resolved(explicit: nil, legacyForce: false), .compatible)
        XCTAssertEqual(ExtensionDecryptionPolicy.resolved(explicit: nil, legacyForce: true), .strict)
        XCTAssertEqual(ExtensionDecryptionPolicy.resolved(explicit: .mainOnly, legacyForce: true), .mainOnly)
    }

    func testAdaptiveBatchSequence() {
        XCTAssertEqual(AdaptiveBatchPolicy.clampedInitialBatchSize(0), 1)
        XCTAssertEqual(AdaptiveBatchPolicy.clampedInitialBatchSize(4), 4)
        XCTAssertEqual(AdaptiveBatchPolicy.clampedInitialBatchSize(99), 16)
        XCTAssertEqual(AdaptiveBatchPolicy.nextBatchSize(afterMemoryPressure: 8), 4)
        XCTAssertEqual(AdaptiveBatchPolicy.nextBatchSize(afterMemoryPressure: 4), 2)
        XCTAssertEqual(AdaptiveBatchPolicy.nextBatchSize(afterMemoryPressure: 2), 1)
        XCTAssertNil(AdaptiveBatchPolicy.nextBatchSize(afterMemoryPressure: 1))
    }
}
