import Foundation
import ZIPFoundation

enum DecryptVerificationCode: String, Codable {
    case stillEncrypted = "still_encrypted"
    case zeroFilledEncryptedRegion = "zero_filled_encrypted_region"
    case invalidArchive = "invalid_archive"
    case noMachO = "no_macho"
    case missingMachO = "missing_macho"
    case unexpectedBinaryMutation = "unexpected_binary_mutation"
}

struct DecryptVerificationError: Error, Equatable {
    let code: DecryptVerificationCode
    let paths: [String]
}

extension DecryptVerificationError: LocalizedError {
    var errorDescription: String? {
        let affected = paths.isEmpty ? "" : ": \(paths.joined(separator: ", "))"
        return "decrypt verification failed (\(code.rawValue))\(affected)"
    }
}

struct DecryptVerificationReport: Codable, Equatable {
    let scannedMachOCount: Int
    let verifiedMachOCount: Int
}

enum DecryptVerifier {
    static func verify(
        outputURL: URL,
        sourceURL: URL? = nil,
        allowEncryptedExtensions: Bool = false
    ) throws -> DecryptVerificationReport {
        let archive: Archive
        do {
            archive = try Archive(url: outputURL, accessMode: .read)
        } catch {
            throw DecryptVerificationError(code: .invalidArchive, paths: [])
        }

        var scanned = 0
        var encrypted: [String] = []
        var allowedEncryptedCount = 0
        var zeroFilled: [String] = []
        // Keep only archive paths. Retaining every decompressed Mach-O here makes
        // large apps exceed the iOS daemon's Jetsam high-water mark.
        var outputMachOPaths = Set<String>()

        for entry in archive where entry.type == .file && entry.path.hasPrefix("Payload/") {
            guard let result = try inspect(entry: entry, archive: archive) else {
                continue
            }
            outputMachOPaths.insert(entry.path)
            scanned += 1
            if result.encrypted {
                if allowEncryptedExtensions && isAppExtensionPath(entry.path) {
                    allowedEncryptedCount += 1
                } else {
                    encrypted.append(entry.path)
                }
            }
            if result.zeroFilled { zeroFilled.append(entry.path) }
        }

        if encrypted.isEmpty == false {
            throw DecryptVerificationError(code: .stillEncrypted, paths: encrypted.sorted())
        }
        if zeroFilled.isEmpty == false {
            throw DecryptVerificationError(code: .zeroFilledEncryptedRegion, paths: zeroFilled.sorted())
        }
        guard scanned > 0 else {
            throw DecryptVerificationError(code: .noMachO, paths: [])
        }
        if let sourceURL {
            try verifyUnchangedContent(
                sourceURL: sourceURL,
                outputArchive: archive,
                outputMachOPaths: outputMachOPaths
            )
        }
        return DecryptVerificationReport(
            scannedMachOCount: scanned,
            verifiedMachOCount: scanned - allowedEncryptedCount
        )
    }

    private static func isAppExtensionPath(_ path: String) -> Bool {
        path.contains(".appex/") || path.contains("/Watch/")
    }

    private static func inspect(entry: Entry, archive: Archive) throws -> (encrypted: Bool, zeroFilled: Bool)? {
        let data = try read(entry: entry, archive: archive)
        guard let slices = MachOEncryptionParser.slices(in: data)?.filter(\.isIPhoneArm64),
              slices.isEmpty == false else { return nil }
        var encrypted = false
        var zeroFilled = false
        for slice in slices {
            if slice.cryptid != 0 { encrypted = true }
            guard slice.cryptSize > 0 else { continue }
            let lower = slice.sliceOffset + slice.cryptOffset
            let upper = lower + slice.cryptSize
            if upper <= data.count && data[lower..<upper].allSatisfy({ $0 == 0 }) {
                zeroFilled = true
            }
        }
        return (encrypted, zeroFilled)
    }

    private static func verifyUnchangedContent(
        sourceURL: URL,
        outputArchive: Archive,
        outputMachOPaths: Set<String>
    ) throws {
        let sourceArchive: Archive
        do {
            sourceArchive = try Archive(url: sourceURL, accessMode: .read)
        } catch {
            throw DecryptVerificationError(code: .invalidArchive, paths: [])
        }
        var missing: [String] = []
        var mutated: [String] = []
        for entry in sourceArchive where entry.type == .file && entry.path.hasPrefix("Payload/") {
            let source = try read(entry: entry, archive: sourceArchive)
            guard let slices = MachOEncryptionParser.slices(in: source)?.filter(\.isIPhoneArm64),
                  slices.isEmpty == false else { continue }
            guard outputMachOPaths.contains(entry.path),
                  let outputEntry = outputArchive[entry.path] else {
                missing.append(entry.path)
                continue
            }
            // Decompress only the matching output while this source entry is in
            // scope; both buffers are released before advancing to the next file.
            let output = try read(entry: outputEntry, archive: outputArchive)
            guard source.count == output.count else {
                mutated.append(entry.path)
                continue
            }
            var ignored = IndexSet()
            for slice in slices {
                ignored.insert(integersIn: (slice.sliceOffset + slice.cryptOffset)..<(slice.sliceOffset + slice.cryptOffset + slice.cryptSize))
                ignored.insert(integersIn: slice.cryptidOffset..<(slice.cryptidOffset + 4))
            }
            if source.indices.contains(where: { ignored.contains($0) == false && source[$0] != output[$0] }) {
                mutated.append(entry.path)
            }
        }
        if missing.isEmpty == false {
            throw DecryptVerificationError(code: .missingMachO, paths: missing.sorted())
        }
        if mutated.isEmpty == false {
            throw DecryptVerificationError(code: .unexpectedBinaryMutation, paths: mutated.sorted())
        }
    }

    private static func read(entry: Entry, archive: Archive) throws -> Data {
        var data = Data()
        _ = try archive.extract(entry) { data.append($0) }
        return data
    }
}

private enum MachOEncryptionParser {
    struct Slice {
        let cpuType: UInt32
        let sliceOffset: Int
        let cryptOffset: Int
        let cryptSize: Int
        let cryptid: UInt32
        let cryptidOffset: Int

        var isIPhoneArm64: Bool { cpuType == 0x0100000c }
    }

    static func slices(in data: Data) -> [Slice]? {
        guard data.count >= 4 else { return nil }
        let magicLE = data.u32LE(at: 0)
        switch magicLE {
        case 0xfeedface, 0xfeedfacf:
            return parseThin(data, sliceOffset: 0).map { [$0] }
        case 0xbebafeca, 0xbfbafeca:
            return parseFat(data, is64: magicLE == 0xbfbafeca)
        default:
            return nil
        }
    }

    private static func parseFat(_ data: Data, is64: Bool) -> [Slice]? {
        guard data.count >= 8 else { return nil }
        let count = Int(data.u32BE(at: 4))
        let recordSize = is64 ? 32 : 20
        guard count >= 0, 8 + count * recordSize <= data.count else { return nil }
        var result: [Slice] = []
        for index in 0..<count {
            let record = 8 + index * recordSize
            let offset = is64 ? Int(data.u64BE(at: record + 8)) : Int(data.u32BE(at: record + 8))
            guard let slice = parseThin(data, sliceOffset: offset) else { continue }
            result.append(slice)
        }
        return result.isEmpty ? nil : result
    }

    private static func parseThin(_ data: Data, sliceOffset: Int) -> Slice? {
        guard sliceOffset >= 0, sliceOffset + 28 <= data.count else { return nil }
        let magic = data.u32LE(at: sliceOffset)
        guard magic == 0xfeedface || magic == 0xfeedfacf else { return nil }
        let headerSize = magic == 0xfeedfacf ? 32 : 28
        let commandCount = Int(data.u32LE(at: sliceOffset + 16))
        var cursor = sliceOffset + headerSize
        for _ in 0..<commandCount {
            guard cursor + 8 <= data.count else { return nil }
            let command = data.u32LE(at: cursor)
            let size = Int(data.u32LE(at: cursor + 4))
            guard size >= 8, cursor + size <= data.count else { return nil }
            if command == 0x21 || command == 0x2c {
                guard size >= 20 else { return nil }
                return Slice(
                    cpuType: data.u32LE(at: sliceOffset + 4),
                    sliceOffset: sliceOffset,
                    cryptOffset: Int(data.u32LE(at: cursor + 8)),
                    cryptSize: Int(data.u32LE(at: cursor + 12)),
                    cryptid: data.u32LE(at: cursor + 16),
                    cryptidOffset: cursor + 16
                )
            }
            cursor += size
        }
        return nil
    }
}

private extension Data {
    func u32LE(at offset: Int) -> UInt32 {
        UInt32(self[offset]) |
            UInt32(self[offset + 1]) << 8 |
            UInt32(self[offset + 2]) << 16 |
            UInt32(self[offset + 3]) << 24
    }

    func u32BE(at offset: Int) -> UInt32 {
        UInt32(self[offset]) << 24 |
            UInt32(self[offset + 1]) << 16 |
            UInt32(self[offset + 2]) << 8 |
            UInt32(self[offset + 3])
    }

    func u64BE(at offset: Int) -> UInt64 {
        var value: UInt64 = 0
        for byte in self[offset..<(offset + 8)] {
            value = (value << 8) | UInt64(byte)
        }
        return value
    }
}
