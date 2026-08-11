import Foundation
@testable import UnfairDaemonCore
import XCTest

final class SimulatorIPABuilderTests: XCTestCase {
    func testPatchesBuildVersionAndPreservesCodeSignatureReference() throws {
        let input = minimalMachO64()

        let result = try SimulatorIPABuilder.patchedMachODataForTesting(input)

        XCTAssertEqual(result.patchedSlices, 1)
        XCTAssertEqual(result.data.uint32LE(at: 40), 7)
        XCTAssertEqual(result.data.uint32LE(at: 44), 0x0010_0000)
        XCTAssertEqual(result.data.uint32LE(at: 48), 0x0010_0000)
        XCTAssertEqual(result.data.uint32LE(at: 64), 1234)
        XCTAssertEqual(result.data.uint32LE(at: 68), 5678)
    }

    func testMigratesLegacyVersionMinCommandToBuildVersion() throws {
        let input = legacyVersionMinMachO64()

        let result = try SimulatorIPABuilder.patchedMachODataForTesting(input)

        XCTAssertEqual(result.patchedSlices, 1)
        XCTAssertEqual(result.data.uint32LE(at: 20), 40)
        XCTAssertEqual(result.data.uint32LE(at: 32), 0x32)
        XCTAssertEqual(result.data.uint32LE(at: 36), 24)
        XCTAssertEqual(result.data.uint32LE(at: 40), 7)
        XCTAssertEqual(result.data.uint32LE(at: 44), 0x0010_0000)
        XCTAssertEqual(result.data.uint32LE(at: 48), 0x0010_0000)
        XCTAssertEqual(result.data.uint32LE(at: 52), 0)
        XCTAssertEqual(result.data.uint32LE(at: 56), 0x1d)
        XCTAssertEqual(result.data.uint32LE(at: 60), 16)
        XCTAssertEqual(result.data.uint32LE(at: 64), 1234)
        XCTAssertEqual(result.data.uint32LE(at: 68), 5678)
    }

    func testPatchesMachOFileInPlace() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("asspp-simulator-test-\(UUID().uuidString)")
        try minimalMachO64().write(to: url)
        defer {
            try? FileManager.default.removeItem(at: url)
        }

        XCTAssertTrue(try SimulatorIPABuilder.patchMachOFileForTesting(url))

        let data = try Data(contentsOf: url)
        XCTAssertEqual(data.uint32LE(at: 40), 7)
        XCTAssertEqual(data.uint32LE(at: 44), 0x0010_0000)
        XCTAssertEqual(data.uint32LE(at: 48), 0x0010_0000)
    }

    func testMigratesLegacyMachOFileInPlace() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("asspp-simulator-test-\(UUID().uuidString)")
        try legacyVersionMinMachO64().write(to: url)
        defer {
            try? FileManager.default.removeItem(at: url)
        }

        XCTAssertTrue(try SimulatorIPABuilder.patchMachOFileForTesting(url))

        let data = try Data(contentsOf: url)
        XCTAssertEqual(data.uint32LE(at: 20), 40)
        XCTAssertEqual(data.uint32LE(at: 32), 0x32)
        XCTAssertEqual(data.uint32LE(at: 36), 24)
        XCTAssertEqual(data.uint32LE(at: 40), 7)
        XCTAssertEqual(data.uint32LE(at: 56), 0x1d)
    }

    func testEnsureSimulatorIpaLogsCachedOutput() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("asspp-simulator-cache-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: directory)
        }

        let sourceURL = directory.appendingPathComponent("Source.ipa")
        let outputURL = SimulatorIPABuilder.simulatorIpaURL(for: sourceURL)
        try Data("source".utf8).write(to: sourceURL)
        try Data("cached".utf8).write(to: outputURL)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: sourceURL.path)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 2)], ofItemAtPath: outputURL.path)

        var logs: [String] = []
        let result = try SimulatorIPABuilder.ensureSimulatorIpa(sourceURL: sourceURL) { message in
            logs.append(message)
        }

        XCTAssertEqual(result.path, outputURL.path)
        XCTAssertEqual(logs, ["using cached simulator IPA"])
    }

    private func minimalMachO64() -> Data {
        var data = Data()
        data.appendUInt32LE(0xfeedfacf) // magic
        data.appendUInt32LE(0x0100_000c) // CPU_TYPE_ARM64
        data.appendUInt32LE(0)
        data.appendUInt32LE(2)
        data.appendUInt32LE(2) // ncmds
        data.appendUInt32LE(40) // sizeofcmds
        data.appendUInt32LE(0)
        data.appendUInt32LE(0)

        data.appendUInt32LE(0x32) // LC_BUILD_VERSION
        data.appendUInt32LE(24)
        data.appendUInt32LE(2) // PLATFORM_IOS
        data.appendUInt32LE(0x000f_0000)
        data.appendUInt32LE(0x000f_0000)
        data.appendUInt32LE(0)

        data.appendUInt32LE(0x1d) // LC_CODE_SIGNATURE
        data.appendUInt32LE(16)
        data.appendUInt32LE(1234)
        data.appendUInt32LE(5678)
        return data
    }

    private func legacyVersionMinMachO64() -> Data {
        var data = Data()
        data.appendUInt32LE(0xfeedfacf) // magic
        data.appendUInt32LE(0x0100_000c) // CPU_TYPE_ARM64
        data.appendUInt32LE(0)
        data.appendUInt32LE(2)
        data.appendUInt32LE(2) // ncmds
        data.appendUInt32LE(32) // sizeofcmds: 16 + 16, followed by 8 bytes of padding
        data.appendUInt32LE(0)
        data.appendUInt32LE(0)

        data.appendUInt32LE(0x25) // LC_VERSION_MIN_IPHONEOS
        data.appendUInt32LE(16)
        data.appendUInt32LE(0x000f_0000)
        data.appendUInt32LE(0x000f_0000)

        data.appendUInt32LE(0x1d) // LC_CODE_SIGNATURE
        data.appendUInt32LE(16)
        data.appendUInt32LE(1234)
        data.appendUInt32LE(5678)

        data.appendUInt32LE(0)
        data.appendUInt32LE(0)
        return data
    }
}

private extension Data {
    mutating func appendUInt32LE(_ value: UInt32) {
        append(UInt8(value & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 24) & 0xff))
    }

    func uint32LE(at offset: Int) -> UInt32 {
        UInt32(self[offset]) |
            UInt32(self[offset + 1]) << 8 |
            UInt32(self[offset + 2]) << 16 |
            UInt32(self[offset + 3]) << 24
    }
}
