import Foundation
@testable import UnfairDaemonCore
import XCTest

final class BundleTaskGateTests: XCTestCase {
    func testSameBundleCannotBeLeasedByTwoTasksAtOnce() throws {
        let gate = BundleTaskGate()
        let first = try XCTUnwrap(gate.tryAcquire(bundleID: "com.example.app"))

        XCTAssertNil(gate.tryAcquire(bundleID: "com.example.app"))

        first.release()
        XCTAssertNotNil(gate.tryAcquire(bundleID: "com.example.app"))
    }

    func testDifferentBundlesCanRunConcurrently() throws {
        let gate = BundleTaskGate()
        let first = try XCTUnwrap(gate.tryAcquire(bundleID: "com.example.one"))
        defer { first.release() }

        XCTAssertNotNil(gate.tryAcquire(bundleID: "com.example.two"))
    }
}
