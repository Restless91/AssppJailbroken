import Foundation
@testable import UnfairDaemonCore
import XCTest

final class DeviceTaskQueueTests: XCTestCase {
    func testSecondTaskWaitsUntilFirstTaskFinishes() {
        let queue = DeviceTaskQueue(label: "wiki.qaq.unfaird.device-task-queue-tests.\(UUID().uuidString)")
        let firstStarted = expectation(description: "first task started")
        let releaseFirst = DispatchSemaphore(value: 0)
        let secondStarted = DispatchSemaphore(value: 0)
        let order = LockedOrder()

        queue.async {
            order.append("first-start")
            firstStarted.fulfill()
            releaseFirst.wait()
            order.append("first-end")
        }
        queue.async {
            order.append("second-start")
            secondStarted.signal()
        }

        wait(for: [firstStarted], timeout: 1)
        XCTAssertEqual(secondStarted.wait(timeout: .now() + 0.1), .timedOut)
        releaseFirst.signal()
        XCTAssertEqual(secondStarted.wait(timeout: .now() + 1), .success)

        XCTAssertEqual(order.values, ["first-start", "first-end", "second-start"])
    }
}

private final class LockedOrder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ value: String) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
