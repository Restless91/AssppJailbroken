import Foundation
@testable import UnfairDaemonCore
import XCTest

final class IPACompatibilityInspectorTests: XCTestCase {
    func testReadsMinimumOSVersionFromITunesMetadata() throws {
        let metadata: [String: Any] = [
            "bundleShortVersionString": "8.0.50",
            "MinimumOSVersion": "13.0",
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: metadata,
            format: .binary,
            options: 0
        )

        XCTAssertEqual(
            IPACompatibilityInspector.minimumOSVersion(
                inMetadataBase64: data.base64EncodedString()
            ),
            "13.0"
        )
    }

    func testReadsNestedMinimumOSVersionVariant() throws {
        let metadata: [String: Any] = [
            "software": ["minimumOsVersion": "14.2.1"],
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: metadata,
            format: .binary,
            options: 0
        )

        XCTAssertEqual(
            IPACompatibilityInspector.minimumOSVersion(
                inMetadataBase64: data.base64EncodedString()
            ),
            "14.2.1"
        )
    }

    func testOSVersionCompatibilityUsesNumericComponents() {
        let current = OperatingSystemVersion(majorVersion: 14, minorVersion: 3, patchVersion: 0)

        XCTAssertTrue(OSVersionCompatibility.isCompatible(minimumOSVersion: "14.3", current: current))
        XCTAssertTrue(OSVersionCompatibility.isCompatible(minimumOSVersion: "13.7", current: current))
        XCTAssertFalse(OSVersionCompatibility.isCompatible(minimumOSVersion: "14.3.1", current: current))
        XCTAssertFalse(OSVersionCompatibility.isCompatible(minimumOSVersion: "15.0", current: current))
    }
}
