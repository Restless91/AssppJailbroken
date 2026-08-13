import XCTest
@testable import UnfairDaemonCore

final class PackageRunnerSandboxTests: XCTestCase {
    func testStagedInputSurvivesRemovalOfOriginalPath() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("package-runner-sandbox-\(UUID().uuidString)", isDirectory: true)
        let sourceDirectory = root.appendingPathComponent("source", isDirectory: true)
        let workingDirectory = root.appendingPathComponent("working", isDirectory: true)
        let sourceURL = sourceDirectory.appendingPathComponent("download.ipa")
        let expected = Data("signed ipa bytes".utf8)
        defer {
            try? FileManager.default.removeItem(at: root)
        }

        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        try expected.write(to: sourceURL)

        let stagedURL = try PackageRunnerSandbox.stageInput(sourceURL, in: workingDirectory)
        try FileManager.default.removeItem(at: sourceURL)

        XCTAssertEqual(stagedURL.lastPathComponent, "input.ipa")
        XCTAssertEqual(try Data(contentsOf: stagedURL), expected)
    }

    func testStagingAnInputAlreadyInsideWorkingDirectoryKeepsIt() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("package-runner-sandbox-\(UUID().uuidString)", isDirectory: true)
        let inputURL = root.appendingPathComponent("input.ipa")
        let expected = Data("already staged".utf8)
        defer {
            try? FileManager.default.removeItem(at: root)
        }

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try expected.write(to: inputURL)

        let stagedURL = try PackageRunnerSandbox.stageInput(inputURL, in: root)

        XCTAssertEqual(stagedURL, inputURL.standardizedFileURL)
        XCTAssertEqual(try Data(contentsOf: stagedURL), expected)
    }
}
