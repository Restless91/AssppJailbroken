import Foundation
@testable import UnfairDaemonCore
import Vapor
import XCTest

final class AppleProtocolServiceTests: XCTestCase {
    func testApplePackageRateLimitErrorMapsToProtocolError() {
        let source = NSError(
            domain: "ApplePackage",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Rate limit exceeded"]
        )

        let error = AppleProtocolService.protocolErrorForTesting(source)

        XCTAssertEqual(error.status, .tooManyRequests)
        XCTAssertEqual(error.code, "rate_limited")
        XCTAssertEqual(error.message, "Apple rate limit reached. Wait before trying again.")
    }

    func testApplePackageVerificationErrorMapsToCodeRequired() {
        let source = NSError(
            domain: "ApplePackage",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Authentication requires verification code\nOpen Apple account settings."]
        )

        let error = AppleProtocolService.protocolErrorForTesting(source)

        XCTAssertEqual(error.status, .conflict)
        XCTAssertTrue(error.message.contains("manually get a verification code"))
        XCTAssertTrue(error.codeRequired)
    }

    func testAppleEmptyAuthenticationResponseRequestsCodeForCompatibility() {
        let source = NSError(
            domain: "ApplePackage",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "authentication failed: Apple returned an empty authentication response before a verification challenge was confirmed (code: 204). The password may be incorrect, Apple may be rate-limiting, or the account may need confirmation at account.apple.com."]
        )

        let error = AppleProtocolService.protocolErrorForTesting(source)

        XCTAssertEqual(error.status, .conflict)
        XCTAssertTrue(error.codeRequired)
        XCTAssertTrue(error.message.contains("manually get a verification code"))
    }

    func testLegacyAppleEmptyBody204RequestsCodeForCompatibility() {
        let source = NSError(
            domain: "ApplePackage",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "authentication failed: response body is empty (code: 204)"]
        )

        let error = AppleProtocolService.protocolErrorForTesting(source)

        XCTAssertEqual(error.status, .conflict)
        XCTAssertTrue(error.codeRequired)
        XCTAssertTrue(error.message.contains("manually get a verification code"))
    }

    func testAppleHtmlAuthenticationResponseDoesNotRequestCode() {
        let source = NSError(
            domain: "ApplePackage",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "authentication failed: Apple returned an HTML authentication response instead of native login data (code: 302). Apple did not create a native 2FA challenge; keep the same device identifier, confirm the account at account.apple.com, then retry."]
        )

        let error = AppleProtocolService.protocolErrorForTesting(source)

        XCTAssertEqual(error.status, .conflict)
        XCTAssertFalse(error.codeRequired)
        XCTAssertTrue(error.message.contains("did not create a trusted-device verification challenge"))
    }

    func testAppleAuthenticationServerErrorDoesNotRequestCode() {
        let source = NSError(
            domain: "ApplePackage",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "authentication failed: Apple authentication service returned 503. Wait a few minutes and retry with the same device identifier."]
        )

        let error = AppleProtocolService.protocolErrorForTesting(source)

        XCTAssertEqual(error.status, .badGateway)
        XCTAssertFalse(error.codeRequired)
        XCTAssertTrue(error.message.contains("temporary server error"))
    }

    func testPasswordTokenExpiredErrorDetection() {
        let expiredBy2034 = AppleProtocolError(status: .unauthorized, message: "password token is expired", code: "2034")
        let expiredBy2042 = AppleProtocolError(status: .unauthorized, message: "password token is expired", code: "2042")
        let expiredByMessage = AppleProtocolError(status: .unauthorized, message: "password token is expired", code: "5002")
        let otherError = AppleProtocolError(status: .conflict, message: "purchase failed", code: "5002")

        XCTAssertTrue(expiredBy2034.isPasswordTokenExpired)
        XCTAssertTrue(expiredBy2042.isPasswordTokenExpired)
        XCTAssertTrue(expiredByMessage.isPasswordTokenExpired)
        XCTAssertFalse(otherError.isPasswordTokenExpired)
    }
}
