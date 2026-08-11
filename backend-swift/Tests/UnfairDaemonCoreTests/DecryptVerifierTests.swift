import Foundation
@testable import UnfairDaemonCore
import XCTest
import ZIPFoundation

final class DecryptVerifierTests: XCTestCase {
    func testRejectsIPAWhenAnyMachOIsStillEncrypted() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("decrypt-verifier-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let ipa = root.appendingPathComponent("encrypted.ipa")
        try makeIPA(at: ipa, entries: [
            "Payload/Test.app/Test": makeMachO(cryptid: 1, encryptedByte: 0x41),
        ])

        XCTAssertThrowsError(try DecryptVerifier.verify(outputURL: ipa)) { error in
            guard let failure = error as? DecryptVerificationError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(failure.code, .stillEncrypted)
            XCTAssertEqual(failure.paths, ["Payload/Test.app/Test"])
        }
    }

    func testAllowsEncryptedAppExtensionsWhenExtensionDecryptionIsDisabled() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let source = context.root.appendingPathComponent("source.ipa")
        let output = context.root.appendingPathComponent("output.ipa")
        let mainPath = "Payload/Test.app/Test"
        let extensionPath = "Payload/Test.app/PlugIns/Widget.appex/Widget"
        try makeIPA(at: source, entries: [
            mainPath: makeMachO(cryptid: 1, encryptedByte: 0x41),
            extensionPath: makeMachO(cryptid: 1, encryptedByte: 0x42),
        ])
        try makeIPA(at: output, entries: [
            mainPath: makeMachO(cryptid: 0, encryptedByte: 0x71),
            extensionPath: makeMachO(cryptid: 1, encryptedByte: 0x42),
        ])

        let report = try DecryptVerifier.verify(
            outputURL: output,
            sourceURL: source,
            allowEncryptedExtensions: true
        )

        XCTAssertEqual(report, DecryptVerificationReport(scannedMachOCount: 2, verifiedMachOCount: 1))
    }

    func testStillRejectsEncryptedMainBinaryWhenExtensionsAreAllowed() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let ipa = context.root.appendingPathComponent("encrypted-main.ipa")
        try makeIPA(at: ipa, entries: [
            "Payload/Test.app/Test": makeMachO(cryptid: 1, encryptedByte: 0x41),
        ])

        XCTAssertThrowsError(try DecryptVerifier.verify(
            outputURL: ipa,
            allowEncryptedExtensions: true
        )) { error in
            XCTAssertEqual((error as? DecryptVerificationError)?.code, .stillEncrypted)
        }
    }

    func testMainOnlyAllowsEncryptedFrameworkButCompatibleRejectsIt() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let ipa = context.root.appendingPathComponent("encrypted-framework.ipa")
        try makeIPA(at: ipa, entries: [
            "Payload/Test.app/Test": makeMachO(cryptid: 0, encryptedByte: 0x71),
            "Payload/Test.app/Frameworks/Optional.framework/Optional": makeMachO(cryptid: 1, encryptedByte: 0x42),
        ])

        XCTAssertNoThrow(try DecryptVerifier.verify(outputURL: ipa, extensionPolicy: .mainOnly))
        XCTAssertThrowsError(try DecryptVerifier.verify(outputURL: ipa, extensionPolicy: .compatible)) { error in
            XCTAssertEqual((error as? DecryptVerificationError)?.code, .stillEncrypted)
        }
    }

    func testRejectsZeroFilledEncryptedRegion() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let ipa = context.root.appendingPathComponent("zero.ipa")
        try makeIPA(at: ipa, entries: [
            "Payload/Test.app/Test": makeMachO(cryptid: 0, encryptedByte: 0),
        ])

        XCTAssertThrowsError(try DecryptVerifier.verify(outputURL: ipa)) { error in
            XCTAssertEqual(
                error as? DecryptVerificationError,
                DecryptVerificationError(
                    code: .zeroFilledEncryptedRegion,
                    paths: ["Payload/Test.app/Test"]
                )
            )
        }
    }

    func testAcceptsFullyDecryptedIPA() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let ipa = context.root.appendingPathComponent("valid.ipa")
        try makeIPA(at: ipa, entries: [
            "Payload/Test.app/Test": makeMachO(cryptid: 0, encryptedByte: 0x7a),
        ])

        let report = try DecryptVerifier.verify(outputURL: ipa)

        XCTAssertEqual(report, DecryptVerificationReport(scannedMachOCount: 1, verifiedMachOCount: 1))
    }

    func testRejectsOutputThatOmitsSourceMachO() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let source = context.root.appendingPathComponent("source.ipa")
        let output = context.root.appendingPathComponent("output.ipa")
        try makeIPA(at: source, entries: [
            "Payload/Test.app/Test": makeMachO(cryptid: 1, encryptedByte: 0x41),
            "Payload/Test.app/Frameworks/Required.framework/Required": makeMachO(cryptid: 1, encryptedByte: 0x42),
        ])
        try makeIPA(at: output, entries: [
            "Payload/Test.app/Test": makeMachO(cryptid: 0, encryptedByte: 0x71),
        ])

        XCTAssertThrowsError(try DecryptVerifier.verify(outputURL: output, sourceURL: source)) { error in
            XCTAssertEqual(
                error as? DecryptVerificationError,
                DecryptVerificationError(
                    code: .missingMachO,
                    paths: ["Payload/Test.app/Frameworks/Required.framework/Required"]
                )
            )
        }
    }

    func testRejectsMutationOutsideEncryptedRegion() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let source = context.root.appendingPathComponent("source.ipa")
        let output = context.root.appendingPathComponent("output.ipa")
        let path = "Payload/Test.app/Test"
        let sourceMachO = makeMachO(cryptid: 1, encryptedByte: 0x41)
        var mutatedMachO = makeMachO(cryptid: 0, encryptedByte: 0x71)
        mutatedMachO[0x80] = 0xff
        try makeIPA(at: source, entries: [path: sourceMachO])
        try makeIPA(at: output, entries: [path: mutatedMachO])

        XCTAssertThrowsError(try DecryptVerifier.verify(outputURL: output, sourceURL: source)) { error in
            XCTAssertEqual(
                error as? DecryptVerificationError,
                DecryptVerificationError(code: .unexpectedBinaryMutation, paths: [path])
            )
        }
    }

    func testAcceptsExpectedCryptRegionAndCryptidChanges() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let source = context.root.appendingPathComponent("source.ipa")
        let output = context.root.appendingPathComponent("output.ipa")
        let path = "Payload/Test.app/Test"
        try makeIPA(at: source, entries: [path: makeMachO(cryptid: 1, encryptedByte: 0x41)])
        try makeIPA(at: output, entries: [path: makeMachO(cryptid: 0, encryptedByte: 0x71)])

        XCTAssertNoThrow(try DecryptVerifier.verify(outputURL: output, sourceURL: source))
    }

    func testAcceptsEncryptedArm64_32WatchSliceWhenIPhoneArm64SliceIsDecrypted() throws {
        let context = try FixtureContext()
        defer { context.cleanup() }
        let source = context.root.appendingPathComponent("source.ipa")
        let output = context.root.appendingPathComponent("output.ipa")
        let path = "Payload/Test.app/Watch/TestWatch.app/PlugIns/TestWatchExtension.appex/TestWatchExtension"
        try makeIPA(at: source, entries: [path: makeWatchFatMachO(iPhoneCryptid: 1)])
        try makeIPA(at: output, entries: [path: makeWatchFatMachO(iPhoneCryptid: 0)])

        XCTAssertNoThrow(try DecryptVerifier.verify(outputURL: output, sourceURL: source))
    }

    private func makeIPA(at url: URL, entries: [String: Data]) throws {
        let archive = try Archive(url: url, accessMode: .create)
        for (path, data) in entries {
            try archive.addEntry(
                with: path,
                type: .file,
                uncompressedSize: Int64(data.count),
                compressionMethod: .none,
                provider: { position, size in
                    data.subdata(in: Int(position)..<Int(position) + size)
                }
            )
        }
    }

    private func makeMachO(cryptid: UInt32, encryptedByte: UInt8, cpuType: UInt32 = 0x0100000c) -> Data {
        var data = Data(repeating: 0, count: 0x120)
        data.writeLE(UInt32(0xfeedfacf), at: 0)
        data.writeLE(cpuType, at: 4)
        data.writeLE(UInt32(0), at: 8)
        data.writeLE(UInt32(2), at: 12)
        data.writeLE(UInt32(1), at: 16)
        data.writeLE(UInt32(24), at: 20)
        data.writeLE(UInt32(0), at: 24)
        data.writeLE(UInt32(0), at: 28)
        data.writeLE(UInt32(0x2c), at: 32)
        data.writeLE(UInt32(24), at: 36)
        data.writeLE(UInt32(0x100), at: 40)
        data.writeLE(UInt32(0x20), at: 44)
        data.writeLE(cryptid, at: 48)
        data.replaceSubrange(0x100..<0x120, with: repeatElement(encryptedByte, count: 0x20))
        return data
    }

    private func makeWatchFatMachO(iPhoneCryptid: UInt32) -> Data {
        let watch = makeMachO(cryptid: 1, encryptedByte: 0x41, cpuType: 0x0200000c)
        let phone = makeMachO(cryptid: iPhoneCryptid, encryptedByte: iPhoneCryptid == 0 ? 0x71 : 0x42)
        var data = Data(repeating: 0, count: 0x500)
        data.writeBE(UInt32(0xcafebabe), at: 0)
        data.writeBE(UInt32(2), at: 4)
        data.writeBE(UInt32(0x0200000c), at: 8)
        data.writeBE(UInt32(1), at: 12)
        data.writeBE(UInt32(0x100), at: 16)
        data.writeBE(UInt32(watch.count), at: 20)
        data.writeBE(UInt32(8), at: 24)
        data.writeBE(UInt32(0x0100000c), at: 28)
        data.writeBE(UInt32(0), at: 32)
        data.writeBE(UInt32(0x300), at: 36)
        data.writeBE(UInt32(phone.count), at: 40)
        data.writeBE(UInt32(8), at: 44)
        data.replaceSubrange(0x100..<(0x100 + watch.count), with: watch)
        data.replaceSubrange(0x300..<(0x300 + phone.count), with: phone)
        return data
    }
}

private final class FixtureContext {
    let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("decrypt-verifier-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: root)
    }
}

private extension Data {
    mutating func writeLE<T: FixedWidthInteger>(_ value: T, at offset: Int) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { bytes in
            replaceSubrange(offset..<(offset + bytes.count), with: bytes)
        }
    }

    mutating func writeBE<T: FixedWidthInteger>(_ value: T, at offset: Int) {
        var bigEndian = value.bigEndian
        Swift.withUnsafeBytes(of: &bigEndian) { bytes in
            replaceSubrange(offset..<(offset + bytes.count), with: bytes)
        }
    }
}
