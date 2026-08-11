@testable import UnfairDaemonCore
import XCTest

final class PackageRunnerResolverTests: XCTestCase {
    func testUsesConfiguredExecutableRunner() {
        let result = PackageRunnerResolver.executablePath(
            currentExecutablePath: "/usr/local/lib/unfaird/UnfairDaemon",
            environment: [PackageRunnerResolver.environmentKey: "/usr/local/lib/unfaird/UnfairRuntimeRunner"],
            isExecutable: { $0.hasSuffix("UnfairRuntimeRunner") }
        )

        XCTAssertEqual(result, "/usr/local/lib/unfaird/UnfairRuntimeRunner")
    }

    func testFallsBackWhenConfiguredRunnerIsMissing() {
        let result = PackageRunnerResolver.executablePath(
            currentExecutablePath: "/usr/local/lib/unfaird/UnfairDaemon",
            environment: [PackageRunnerResolver.environmentKey: "/missing/runner"],
            isExecutable: { _ in false }
        )

        XCTAssertEqual(result, "/usr/local/lib/unfaird/UnfairDaemon")
    }

    func testRejectsRelativeRunnerPath() {
        let result = PackageRunnerResolver.executablePath(
            currentExecutablePath: "/usr/local/lib/unfaird/UnfairDaemon",
            environment: [PackageRunnerResolver.environmentKey: "./runner"],
            isExecutable: { _ in true }
        )

        XCTAssertEqual(result, "/usr/local/lib/unfaird/UnfairDaemon")
    }

    func testForceExtensionDecryptionIsForwardedToExternalRunner() {
        let arguments = PackageRunnerResolver.arguments(
            inputPath: "/input.ipa",
            outputPath: "/output.ipa",
            workingDirectoryPath: "/work",
            forceExtensionDecryption: true,
            supportsForceExtensions: true
        )

        XCTAssertEqual(arguments.last, "--force-extensions")
    }
}
