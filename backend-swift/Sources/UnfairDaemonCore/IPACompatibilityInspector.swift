import Foundation
import UnfairDaemonSupport

enum IPACompatibilityError: Error, LocalizedError {
    case invalidURL
    case invalidResponse(String)
    case invalidArchive(String)
    case unsupportedCompression(UInt16)
    case missingMinimumOSVersion

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "invalid IPA URL"
        case .invalidResponse(let message), .invalidArchive(let message):
            return message
        case .unsupportedCompression(let method):
            return "unsupported ZIP compression method \(method)"
        case .missingMinimumOSVersion:
            return "MinimumOSVersion is missing from the IPA"
        }
    }
}

enum OSVersionCompatibility {
    static func isCompatible(minimumOSVersion: String, current: OperatingSystemVersion) -> Bool {
        compare(parse(minimumOSVersion), current) != .orderedDescending
    }

    static func compare(_ left: OperatingSystemVersion, _ right: OperatingSystemVersion) -> ComparisonResult {
        let lhs = [left.majorVersion, left.minorVersion, left.patchVersion]
        let rhs = [right.majorVersion, right.minorVersion, right.patchVersion]
        for index in lhs.indices {
            if lhs[index] < rhs[index] {
                return .orderedAscending
            }
            if lhs[index] > rhs[index] {
                return .orderedDescending
            }
        }
        return .orderedSame
    }

    static func parse(_ value: String) -> OperatingSystemVersion {
        let components = value.split(separator: ".").map { component in
            Int(component.prefix { $0.isNumber }) ?? 0
        }
        return OperatingSystemVersion(
            majorVersion: components.indices.contains(0) ? components[0] : 0,
            minorVersion: components.indices.contains(1) ? components[1] : 0,
            patchVersion: components.indices.contains(2) ? components[2] : 0
        )
    }

    static func display(_ value: OperatingSystemVersion) -> String {
        "\(value.majorVersion).\(value.minorVersion).\(value.patchVersion)"
    }
}

enum IPACompatibilityInspector {
    private static let maximumInfoPlistSize = 4 * 1024 * 1024
    private static let endOfCentralDirectorySearchSize: Int64 = 65_557

    static func minimumOSVersion(
        downloadURL: String,
        iTunesMetadataBase64: String?
    ) throws -> String {
        if let value = minimumOSVersion(inMetadataBase64: iTunesMetadataBase64) {
            return value
        }
        return try minimumOSVersion(inRemoteIPA: downloadURL)
    }

    static func minimumOSVersion(inMetadataBase64 value: String?) -> String? {
        guard let value,
              let data = Data(base64Encoded: value),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        else {
            return nil
        }
        return findMinimumOSVersion(in: plist)
    }

    private static func findMinimumOSVersion(in value: Any) -> String? {
        if let dictionary = value as? [String: Any] {
            let acceptedKeys = [
                "MinimumOSVersion",
                "minimumOSVersion",
                "minimumOsVersion",
                "softwareMinimumOSVersion",
            ]
            for key in acceptedKeys {
                if let version = dictionary[key] as? String, version.isEmpty == false {
                    return version
                }
            }
            for nested in dictionary.values {
                if let version = findMinimumOSVersion(in: nested) {
                    return version
                }
            }
        } else if let array = value as? [Any] {
            for nested in array {
                if let version = findMinimumOSVersion(in: nested) {
                    return version
                }
            }
        }
        return nil
    }

    private static func minimumOSVersion(inRemoteIPA rawURL: String) throws -> String {
        guard let url = URL(string: rawURL) else {
            throw IPACompatibilityError.invalidURL
        }
        let totalSize = try contentLength(url)
        guard totalSize > 22 else {
            throw IPACompatibilityError.invalidArchive("IPA is too small")
        }

        let tailStart = max(0, totalSize - endOfCentralDirectorySearchSize)
        let tail = try fetchRange(url, start: tailStart, end: totalSize - 1)
        guard let eocdOffset = tail.lastOffset(ofLittleEndianUInt32: 0x0605_4b50),
              eocdOffset + 22 <= tail.count
        else {
            throw IPACompatibilityError.invalidArchive("ZIP end-of-central-directory record not found")
        }

        let centralDirectorySize = Int64(tail.littleEndianUInt32(at: eocdOffset + 12))
        let centralDirectoryOffset = Int64(tail.littleEndianUInt32(at: eocdOffset + 16))
        guard centralDirectorySize > 0,
              centralDirectoryOffset >= 0,
              centralDirectoryOffset + centralDirectorySize <= totalSize
        else {
            throw IPACompatibilityError.invalidArchive("invalid ZIP central directory")
        }

        let centralDirectory = try fetchRange(
            url,
            start: centralDirectoryOffset,
            end: centralDirectoryOffset + centralDirectorySize - 1
        )
        let entry = try rootInfoPlistEntry(in: centralDirectory)
        guard entry.uncompressedSize > 0, entry.uncompressedSize <= maximumInfoPlistSize else {
            throw IPACompatibilityError.invalidArchive("Info.plist exceeds the inspection limit")
        }

        let localHeader = try fetchRange(
            url,
            start: entry.localHeaderOffset,
            end: entry.localHeaderOffset + 29
        )
        guard localHeader.count == 30, localHeader.littleEndianUInt32(at: 0) == 0x0403_4b50 else {
            throw IPACompatibilityError.invalidArchive("invalid ZIP local header")
        }
        let fileNameLength = Int64(localHeader.littleEndianUInt16(at: 26))
        let extraLength = Int64(localHeader.littleEndianUInt16(at: 28))
        let compressedDataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength
        let compressed = try fetchRange(
            url,
            start: compressedDataStart,
            end: compressedDataStart + Int64(entry.compressedSize) - 1
        )

        let plistData: Data
        switch entry.compressionMethod {
        case 0:
            plistData = compressed
        case 8:
            plistData = try inflateRaw(compressed, uncompressedSize: entry.uncompressedSize)
        default:
            throw IPACompatibilityError.unsupportedCompression(entry.compressionMethod)
        }

        guard let plist = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil),
              let dictionary = plist as? [String: Any],
              let minimumOSVersion = dictionary["MinimumOSVersion"] as? String,
              minimumOSVersion.isEmpty == false
        else {
            throw IPACompatibilityError.missingMinimumOSVersion
        }
        return minimumOSVersion
    }

    private struct CentralDirectoryEntry {
        var compressionMethod: UInt16
        var compressedSize: Int
        var uncompressedSize: Int
        var localHeaderOffset: Int64
    }

    private static func rootInfoPlistEntry(in data: Data) throws -> CentralDirectoryEntry {
        var cursor = 0
        while cursor + 46 <= data.count {
            guard data.littleEndianUInt32(at: cursor) == 0x0201_4b50 else {
                break
            }
            let fileNameLength = Int(data.littleEndianUInt16(at: cursor + 28))
            let extraLength = Int(data.littleEndianUInt16(at: cursor + 30))
            let commentLength = Int(data.littleEndianUInt16(at: cursor + 32))
            let next = cursor + 46 + fileNameLength + extraLength + commentLength
            guard next <= data.count else {
                throw IPACompatibilityError.invalidArchive("truncated ZIP central directory")
            }

            let nameRange = (cursor + 46)..<(cursor + 46 + fileNameLength)
            let name = String(data: data.subdata(in: nameRange), encoding: .utf8) ?? ""
            let parts = name.split(separator: "/", omittingEmptySubsequences: false)
            if parts.count == 3,
               parts[0] == "Payload",
               parts[1].hasSuffix(".app"),
               parts[2] == "Info.plist" {
                return CentralDirectoryEntry(
                    compressionMethod: data.littleEndianUInt16(at: cursor + 10),
                    compressedSize: Int(data.littleEndianUInt32(at: cursor + 20)),
                    uncompressedSize: Int(data.littleEndianUInt32(at: cursor + 24)),
                    localHeaderOffset: Int64(data.littleEndianUInt32(at: cursor + 42))
                )
            }
            cursor = next
        }
        throw IPACompatibilityError.invalidArchive("Payload/*.app/Info.plist not found")
    }

    private static func contentLength(_ url: URL) throws -> Int64 {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        let result = try HTTPSyncClient.shared.send(request, timeout: 20)
        guard (200...299).contains(result.statusCode),
              result.response.expectedContentLength > 0
        else {
            throw IPACompatibilityError.invalidResponse("failed to read IPA size")
        }
        return result.response.expectedContentLength
    }

    private static func fetchRange(_ url: URL, start: Int64, end: Int64) throws -> Data {
        guard start >= 0, end >= start else {
            throw IPACompatibilityError.invalidArchive("invalid IPA byte range")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
        let result = try HTTPSyncClient.shared.send(request, timeout: 30)
        guard result.statusCode == 206 else {
            throw IPACompatibilityError.invalidResponse("Apple CDN did not honor IPA range inspection")
        }
        let expectedCount = Int(end - start + 1)
        guard result.data.count == expectedCount else {
            throw IPACompatibilityError.invalidResponse(
                "incomplete IPA range: expected \(expectedCount), received \(result.data.count)"
            )
        }
        return result.data
    }

    private static func inflateRaw(_ source: Data, uncompressedSize: Int) throws -> Data {
        var destination = Data(count: uncompressedSize)
        let destinationSize = destination.count
        var written = 0
        var error = [CChar](repeating: 0, count: 256)
        let status = source.withUnsafeBytes { sourceBytes in
            destination.withUnsafeMutableBytes { destinationBytes in
                unfaird_inflate_raw(
                    sourceBytes.bindMemory(to: UInt8.self).baseAddress,
                    source.count,
                    destinationBytes.bindMemory(to: UInt8.self).baseAddress,
                    destinationSize,
                    &written,
                    &error,
                    error.count
                )
            }
        }
        guard status == 0 else {
            throw IPACompatibilityError.invalidArchive(
                "failed to decompress Info.plist: \(String(cString: error))"
            )
        }
        destination.count = written
        return destination
    }
}

private extension Data {
    func littleEndianUInt16(at offset: Int) -> UInt16 {
        UInt16(self[index(startIndex, offsetBy: offset)])
            | (UInt16(self[index(startIndex, offsetBy: offset + 1)]) << 8)
    }

    func littleEndianUInt32(at offset: Int) -> UInt32 {
        UInt32(littleEndianUInt16(at: offset))
            | (UInt32(littleEndianUInt16(at: offset + 2)) << 16)
    }

    func lastOffset(ofLittleEndianUInt32 value: UInt32) -> Int? {
        guard count >= 4 else {
            return nil
        }
        for offset in stride(from: count - 4, through: 0, by: -1) {
            if littleEndianUInt32(at: offset) == value {
                return offset
            }
        }
        return nil
    }
}
