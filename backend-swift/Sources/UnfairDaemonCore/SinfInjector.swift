import Foundation
import Vapor
import ZIPFoundation

struct SinfInjector {
    struct IPAMetadata {
        var bundleName: String
        var sinfPaths: [String]
        var bundleExecutable: String
    }

    static func inject(sinfs: [Sinf], ipaURL: URL, iTunesMetadata: String?) throws {
        let metadata = try readIPAMetadata(ipaURL)
        var files: [(path: String, data: Data)] = []

        if metadata.sinfPaths.isEmpty == false {
            for (index, path) in metadata.sinfPaths.enumerated() where index < sinfs.count {
                guard let data = Data(base64Encoded: sinfs[index].sinf) else {
                    throw Abort(.badRequest, reason: "invalid sinf payload")
                }
                files.append(("Payload/\(metadata.bundleName).app/\(path)", data))
            }
        } else if metadata.bundleExecutable.isEmpty == false, let first = sinfs.first {
            guard let data = Data(base64Encoded: first.sinf) else {
                throw Abort(.badRequest, reason: "invalid sinf payload")
            }
            files.append(("Payload/\(metadata.bundleName).app/SC_Info/\(metadata.bundleExecutable).sinf", data))
        } else {
            throw Abort(.badRequest, reason: "could not read manifest or info plist")
        }

        if let iTunesMetadata = iTunesMetadata, iTunesMetadata.isEmpty == false {
            guard let data = Data(base64Encoded: iTunesMetadata) else {
                throw Abort(.badRequest, reason: "invalid iTunesMetadata payload")
            }
            files.append(("iTunesMetadata.plist", normalizeMetadataPlist(data)))
        }

        guard files.isEmpty == false else {
            throw Abort(.badRequest, reason: "no SINF files available")
        }
        try append(files: files, to: ipaURL)
    }

    private static func readIPAMetadata(_ ipaURL: URL) throws -> IPAMetadata {
        let archive = try Archive(url: ipaURL, accessMode: .read)

        var bundleName = ""
        var manifestData: Data?
        var infoData: Data?

        for entry in archive {
            guard let appPath = splitRootAppPath(entry.path) else {
                continue
            }
            if bundleName.isEmpty {
                bundleName = appPath.bundleName
            }
            if manifestData == nil, appPath.innerPath == "SC_Info/Manifest.plist" {
                manifestData = try read(entry: entry, from: archive)
            }
            if infoData == nil, appPath.innerPath == "Info.plist" {
                infoData = try read(entry: entry, from: archive)
            }
        }

        guard bundleName.isEmpty == false else {
            throw Abort(.badRequest, reason: "could not read bundle name")
        }

        return IPAMetadata(
            bundleName: bundleName,
            sinfPaths: sinfPaths(from: manifestData),
            bundleExecutable: bundleExecutable(from: infoData)
        )
    }

    private static func read(entry: Entry, from archive: Archive) throws -> Data {
        var data = Data()
        _ = try archive.extract(entry) { chunk in
            data.append(chunk)
        }
        return data
    }

    private static func splitRootAppPath(_ path: String) -> (bundleName: String, innerPath: String)? {
        let prefix = "Payload/"
        guard path.hasPrefix(prefix) else {
            return nil
        }
        let rest = String(path.dropFirst(prefix.count))
        guard let slash = rest.firstIndex(of: "/") else {
            return nil
        }
        let appName = String(rest[..<slash])
        guard appName.hasSuffix(".app") else {
            return nil
        }
        let innerPath = String(rest[rest.index(after: slash)...])
        return (String(appName.dropLast(4)), innerPath)
    }

    private static func sinfPaths(from data: Data?) -> [String] {
        guard let data = data,
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = plist as? [String: Any],
              let values = dict["SinfPaths"] as? [Any]
        else {
            return []
        }
        return values.compactMap { $0 as? String }
    }

    private static func bundleExecutable(from data: Data?) -> String {
        guard let data = data,
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = plist as? [String: Any],
              let value = dict["CFBundleExecutable"] as? String
        else {
            return ""
        }
        return value
    }

    private static func normalizeMetadataPlist(_ data: Data) -> Data {
        guard let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let normalized = try? PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0)
        else {
            return data
        }
        return normalized
    }

    private static func append(files: [(path: String, data: Data)], to ipaURL: URL) throws {
        let archive = try Archive(url: ipaURL, accessMode: .update)

        for file in files {
            let data = file.data
            try archive.addEntry(
                with: file.path,
                type: .file,
                uncompressedSize: Int64(data.count),
                compressionMethod: .none,
                provider: { position, size -> Data in
                    data.subdata(in: Int(position)..<Int(position) + size)
                }
            )
        }
    }
}
