@testable import UnfairDaemonCore
import XCTest

final class DecryptFailureClassifierTests: XCTestCase {
    func testClassifiesKnownDeviceFailures() {
        XCTAssertEqual(DecryptFailureClassifier.code(message: "mremap_encrypted failed: Operation not permitted"), .encryptedMappingDenied)
        XCTAssertEqual(DecryptFailureClassifier.code(message: "fairplayOpen() failed, error -42004"), .fairPlayAuthorization)
        XCTAssertEqual(DecryptFailureClassifier.code(message: "helper exit 137"), .memoryPressure)
        XCTAssertEqual(DecryptFailureClassifier.code(message: "Bad executable (or shared library) error 85"), .invalidSignature)
        XCTAssertEqual(DecryptFailureClassifier.code(message: "device must be unlocked"), .deviceLocked)
        XCTAssertEqual(DecryptFailureClassifier.code(message: "another task is processing this bundle"), .bundleBusy)
        XCTAssertEqual(DecryptFailureClassifier.code(message: "insufficient storage: need 20 bytes"), .insufficientStorage)
        XCTAssertEqual(DecryptFailureClassifier.code(message: "unexpected"), .unknown)
    }
}
