import Foundation
import Vapor
import ZIPFoundation

enum SimulatorIPABuilder {
    private typealias FileLoadCommand = (offset: UInt64, localOffset: Int, command: UInt32, size: Int)

    private static let fatMagic: UInt32 = 0xcafebabe
    private static let fatMagic64: UInt32 = 0xcafebabf
    private static let machMagic64: UInt32 = 0xfeedfacf
    private static let lcCodeSignature: UInt32 = 0x1d
    private static let lcSegment64: UInt32 = 0x19
    private static let lcSymtab: UInt32 = 0x2
    private static let lcDysymtab: UInt32 = 0xb
    private static let lcDyldInfo: UInt32 = 0x22
    private static let lcDyldInfoOnly: UInt32 = 0x80000022
    private static let lcEncryptionInfo64: UInt32 = 0x2c
    private static let lcBuildVersion: UInt32 = 0x32
    private static let lcVersionMinIPhoneOS: UInt32 = 0x25
    private static let platformIOSSimulator: UInt32 = 7
    private static let version16: UInt32 = (16 << 16)
    private static let buildVersionCommandSize = 24
    private static let versionMinCommandSize = 16
    private static let buildVersionExpansionSize = buildVersionCommandSize - versionMinCommandSize
    private static let commandTimeoutSeconds = 15 * 60
    private static let ldidCandidates = [
        "/usr/bin/ldid",
        "/usr/local/bin/ldid",
        "/opt/procursus/bin/ldid",
        "/var/jb/usr/bin/ldid",
        "/var/jb/usr/local/bin/ldid",
        "/var/jb/opt/procursus/bin/ldid",
    ]

    static func simulatorIpaURL(for sourceURL: URL) -> URL {
        let baseName = sourceURL.deletingPathExtension().lastPathComponent
        let fileExtension = sourceURL.pathExtension.isEmpty ? "ipa" : sourceURL.pathExtension
        return sourceURL
            .deletingLastPathComponent()
            .appendingPathComponent("\(baseName).simulator.\(fileExtension)")
    }

    static func ensureSimulatorIpa(sourceURL: URL, log: (String) -> Void = { _ in }) throws -> URL {
        let outputURL = simulatorIpaURL(for: sourceURL)
        if try isFresh(outputURL: outputURL, sourceURL: sourceURL) {
            log("using cached simulator IPA")
            return outputURL
        }

        log("building simulator IPA")
        try buildSimulatorIpa(sourceURL: sourceURL, outputURL: outputURL, log: log)
        return outputURL
    }

    static func patchedMachODataForTesting(_ data: Data) throws -> (data: Data, patchedSlices: Int) {
        try patchMachOData(data)
    }

    static func patchMachOFileForTesting(_ fileURL: URL) throws -> Bool {
        try patchMachOFile(fileURL)
    }

    private static func isFresh(outputURL: URL, sourceURL: URL) throws -> Bool {
        guard fileExists(outputURL.path) else {
            return false
        }
        let sourceAttributes = try FileManager.default.attributesOfItem(atPath: sourceURL.path)
        let outputAttributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        guard let sourceDate = sourceAttributes[.modificationDate] as? Date,
              let outputDate = outputAttributes[.modificationDate] as? Date
        else {
            return false
        }
        return outputDate >= sourceDate
    }

    private static func buildSimulatorIpa(sourceURL: URL, outputURL: URL, log: (String) -> Void) throws {
        let temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("asspp-simulator-\(UUID().uuidString)", isDirectory: true)
        let extractionURL = temporaryRoot.appendingPathComponent("extracted", isDirectory: true)
        let outputTempURL = outputURL
            .deletingLastPathComponent()
            .appendingPathComponent(".\(outputURL.lastPathComponent).\(UUID().uuidString).tmp")

        try FileManager.default.createDirectory(at: extractionURL, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: temporaryRoot)
            try? FileManager.default.removeItem(at: outputTempURL)
        }

        log("extracting IPA payload")
        try FileManager.default.unzipItem(at: sourceURL, to: extractionURL, skipCRC32: true)

        let appURL = try singlePayloadAppDirectory(in: extractionURL)
        log("preparing app bundle \(appURL.lastPathComponent)")
        try prepareAppBundle(appURL)

        log("patching Mach-O load commands")
        let patchedFiles = try patchMachOFiles(in: appURL)
        guard patchedFiles.isEmpty == false else {
            throw Abort(.internalServerError, reason: "No Mach-O files with LC_BUILD_VERSION or LC_VERSION_MIN_IPHONEOS found in IPA")
        }
        log("patched \(patchedFiles.count) Mach-O file\(patchedFiles.count == 1 ? "" : "s")")

        let ldidPath = try resolveLdidPath()
        for fileURL in patchedFiles {
            log("signing \(fileURL.lastPathComponent)")
            try signMachOFile(fileURL, ldidPath: ldidPath, workingDirectory: temporaryRoot)
        }

        log("packaging simulator IPA")
        try? FileManager.default.removeItem(at: outputTempURL)
        try FileManager.default.zipItem(
            at: extractionURL,
            to: outputTempURL,
            shouldKeepParent: false,
            compressionMethod: .none
        )
        try? FileManager.default.removeItem(at: outputURL)
        try FileManager.default.moveItem(at: outputTempURL, to: outputURL)
        log("simulator IPA packaged")
    }

    private static func singlePayloadAppDirectory(in extractionURL: URL) throws -> URL {
        let payloadURL = extractionURL.appendingPathComponent("Payload", isDirectory: true)
        let entries = try FileManager.default.contentsOfDirectory(
            at: payloadURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        )
        let apps = entries.filter { url in
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) &&
                isDirectory.boolValue &&
                url.pathExtension == "app"
        }
        guard apps.count == 1, let app = apps.first else {
            throw Abort(.badRequest, reason: "IPA must contain exactly one Payload/*.app bundle")
        }
        return app
    }

    private static func prepareAppBundle(_ appURL: URL) throws {
        for name in ["embedded.mobileprovision", "_CodeSignature", "PlugIns", "SC_Info"] {
            let url = appURL.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }
    }

    private static func patchMachOFiles(in appURL: URL) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: appURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: []
        ) else {
            throw Abort(.internalServerError, reason: "Failed to scan app bundle")
        }

        var patchedFiles: [URL] = []
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey])
            guard values.isRegularFile == true else {
                continue
            }
            if try patchMachOFile(fileURL) {
                patchedFiles.append(fileURL)
            }
        }
        return patchedFiles
    }

    private static func patchMachOFile(_ fileURL: URL) throws -> Bool {
        let patchedSlices = try patchMachOFileInPlace(fileURL)
        guard patchedSlices > 0 else {
            return false
        }

        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: fileURL.path)
        return true
    }

    private static func patchMachOFileInPlace(_ fileURL: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        guard let fileSize = (attributes[.size] as? NSNumber)?.uint64Value else {
            throw Abort(.badRequest, reason: "Missing Mach-O file size")
        }
        guard fileSize >= 4 else {
            return 0
        }

        let fileHandle = try FileHandle(forUpdating: fileURL)
        defer {
            fileHandle.closeFile()
        }

        let magic = try readData(from: fileHandle, at: 0, length: 4)
        let magicBE = try magic.uint32BE(at: 0)
        if magicBE == fatMagic {
            return try patchFatMachOFile(fileHandle, fileSize: fileSize, archSize: 20, is64BitFat: false)
        }
        if magicBE == fatMagic64 {
            return try patchFatMachOFile(fileHandle, fileSize: fileSize, archSize: 32, is64BitFat: true)
        }
        if try magic.uint32LE(at: 0) == machMagic64 {
            return try patchMachO64Slice(fileHandle, fileSize: fileSize, sliceOffset: 0, sliceSize: fileSize) ? 1 : 0
        }
        return 0
    }

    private static func patchFatMachOFile(
        _ fileHandle: FileHandle,
        fileSize: UInt64,
        archSize: UInt64,
        is64BitFat: Bool
    ) throws -> Int {
        let archCountData = try readData(from: fileHandle, at: 4, length: 4)
        let archCount = UInt64(try archCountData.uint32BE(at: 0))
        let archTableOffset: UInt64 = 8
        guard archTableOffset + archCount * archSize <= fileSize else {
            throw Abort(.badRequest, reason: "Malformed fat Mach-O header")
        }

        var patchedSlices = 0
        for index in 0..<archCount {
            let offset = archTableOffset + index * archSize
            let sliceOffset: UInt64
            let sliceSize: UInt64
            if is64BitFat {
                let arch = try readData(from: fileHandle, at: offset, length: Int(archSize))
                sliceOffset = try arch.uint64BE(at: 8)
                sliceSize = try arch.uint64BE(at: 16)
            } else {
                let arch = try readData(from: fileHandle, at: offset, length: Int(archSize))
                sliceOffset = UInt64(try arch.uint32BE(at: 8))
                sliceSize = UInt64(try arch.uint32BE(at: 12))
            }
            guard sliceOffset + sliceSize <= fileSize else {
                throw Abort(.badRequest, reason: "Malformed fat Mach-O slice")
            }
            if try patchMachO64Slice(fileHandle, fileSize: fileSize, sliceOffset: sliceOffset, sliceSize: sliceSize) {
                patchedSlices += 1
            }
        }
        return patchedSlices
    }

    private static func patchMachO64Slice(
        _ fileHandle: FileHandle,
        fileSize: UInt64,
        sliceOffset: UInt64,
        sliceSize: UInt64
    ) throws -> Bool {
        guard sliceSize >= 32,
              sliceOffset + sliceSize <= fileSize
        else {
            return false
        }

        let header = try readData(from: fileHandle, at: sliceOffset, length: 32)
        guard try header.uint32LE(at: 0) == machMagic64 else {
            return false
        }

        let commandCount = Int(try header.uint32LE(at: 16))
        let commandsSize = Int(try header.uint32LE(at: 20))
        let commandsOffset = sliceOffset + 32
        let commandsEnd = commandsOffset + UInt64(commandsSize)
        let sliceEnd = sliceOffset + sliceSize
        guard commandCount >= 0,
              commandsOffset <= commandsEnd,
              commandsEnd <= sliceEnd
        else {
            throw Abort(.badRequest, reason: "Malformed Mach-O load command table")
        }

        let commandsData = try readData(from: fileHandle, at: commandsOffset, length: commandsSize)
        let commands = try loadFileCommands(
            in: commandsData,
            absoluteOffset: commandsOffset,
            count: commandCount
        )

        if commands.contains(where: { $0.command == lcBuildVersion }) {
            try patchExistingBuildVersionCommands(fileHandle, commands: commands)
            return true
        }

        guard let versionMinCommand = commands.first(where: { $0.command == lcVersionMinIPhoneOS }) else {
            return false
        }
        try convertVersionMinToBuildVersion(
            fileHandle,
            sliceOffset: sliceOffset,
            sliceSize: sliceSize,
            commandsData: commandsData,
            commands: commands,
            commandsEnd: commandsEnd,
            versionMinCommand: versionMinCommand
        )
        return try patchMachO64Slice(fileHandle, fileSize: fileSize, sliceOffset: sliceOffset, sliceSize: sliceSize)
    }

    private static func loadFileCommands(
        in data: Data,
        absoluteOffset: UInt64,
        count: Int
    ) throws -> [FileLoadCommand] {
        var commands: [FileLoadCommand] = []
        var commandOffset = 0
        for _ in 0..<count {
            guard commandOffset + 8 <= data.count else {
                throw Abort(.badRequest, reason: "Malformed Mach-O load command")
            }
            let command = try data.uint32LE(at: commandOffset)
            let commandSize = Int(try data.uint32LE(at: commandOffset + 4))
            guard commandSize >= 8,
                  commandOffset + commandSize <= data.count
            else {
                throw Abort(.badRequest, reason: "Malformed Mach-O load command size")
            }
            commands.append((
                offset: absoluteOffset + UInt64(commandOffset),
                localOffset: commandOffset,
                command: command,
                size: commandSize
            ))
            commandOffset += commandSize
        }
        guard commandOffset <= data.count else {
            throw Abort(.badRequest, reason: "Malformed Mach-O load command table")
        }
        return commands
    }

    private static func patchExistingBuildVersionCommands(
        _ fileHandle: FileHandle,
        commands: [FileLoadCommand]
    ) throws {
        for command in commands {
            if command.command == lcBuildVersion {
                guard command.size >= buildVersionCommandSize else {
                    throw Abort(.badRequest, reason: "Malformed LC_BUILD_VERSION command")
                }
                try writeUInt32LE(platformIOSSimulator, to: fileHandle, at: command.offset + 8)
                try writeUInt32LE(version16, to: fileHandle, at: command.offset + 12)
                try writeUInt32LE(version16, to: fileHandle, at: command.offset + 16)
            }
        }
    }

    private static func convertVersionMinToBuildVersion(
        _ fileHandle: FileHandle,
        sliceOffset: UInt64,
        sliceSize: UInt64,
        commandsData: Data,
        commands: [FileLoadCommand],
        commandsEnd: UInt64,
        versionMinCommand: FileLoadCommand
    ) throws {
        guard versionMinCommand.size == versionMinCommandSize else {
            throw Abort(.badRequest, reason: "Malformed LC_VERSION_MIN_IPHONEOS command")
        }

        let sliceEnd = sliceOffset + sliceSize
        let firstContentOffset = try firstReferencedContentOffset(
            in: commandsData,
            sliceSize: sliceSize,
            commands: commands
        )
        guard commandsEnd + UInt64(buildVersionExpansionSize) <= sliceEnd,
              commandsEnd + UInt64(buildVersionExpansionSize) <= sliceOffset + firstContentOffset
        else {
            throw Abort(.badRequest, reason: "Mach-O load command padding is too small to migrate LC_VERSION_MIN_IPHONEOS")
        }

        let oldTailStart = versionMinCommand.offset + UInt64(versionMinCommandSize)
        let tailLength = Int(commandsEnd - oldTailStart)
        let tail = try readData(from: fileHandle, at: oldTailStart, length: tailLength)
        try writeData(tail, to: fileHandle, at: oldTailStart + UInt64(buildVersionExpansionSize))

        try writeUInt32LE(lcBuildVersion, to: fileHandle, at: versionMinCommand.offset)
        try writeUInt32LE(UInt32(buildVersionCommandSize), to: fileHandle, at: versionMinCommand.offset + 4)
        try writeUInt32LE(platformIOSSimulator, to: fileHandle, at: versionMinCommand.offset + 8)
        try writeUInt32LE(version16, to: fileHandle, at: versionMinCommand.offset + 12)
        try writeUInt32LE(version16, to: fileHandle, at: versionMinCommand.offset + 16)
        try writeUInt32LE(0, to: fileHandle, at: versionMinCommand.offset + 20)

        let oldCommandsSize = try readData(from: fileHandle, at: sliceOffset + 20, length: 4).uint32LE(at: 0)
        try writeUInt32LE(oldCommandsSize + UInt32(buildVersionExpansionSize), to: fileHandle, at: sliceOffset + 20)
    }

    private static func patchMachOData(_ input: Data) throws -> (data: Data, patchedSlices: Int) {
        guard input.count >= 4 else {
            return (input, 0)
        }

        var data = input
        let magicBE = try data.uint32BE(at: 0)
        if magicBE == fatMagic {
            return try patchFatMachOData(&data, archSize: 20, is64BitFat: false)
        }
        if magicBE == fatMagic64 {
            return try patchFatMachOData(&data, archSize: 32, is64BitFat: true)
        }
        if try data.uint32LE(at: 0) == machMagic64 {
            let patched = try patchMachO64Slice(&data, sliceOffset: 0, sliceSize: data.count)
            return (data, patched ? 1 : 0)
        }
        return (input, 0)
    }

    private static func patchFatMachOData(
        _ data: inout Data,
        archSize: Int,
        is64BitFat: Bool
    ) throws -> (data: Data, patchedSlices: Int) {
        let archCount = Int(try data.uint32BE(at: 4))
        let archTableOffset = 8
        guard archCount >= 0,
              archTableOffset + archCount * archSize <= data.count
        else {
            throw Abort(.badRequest, reason: "Malformed fat Mach-O header")
        }

        var patchedSlices = 0
        for index in 0..<archCount {
            let offset = archTableOffset + index * archSize
            let sliceOffset: Int
            let sliceSize: Int
            if is64BitFat {
                sliceOffset = Int(try data.uint64BE(at: offset + 8))
                sliceSize = Int(try data.uint64BE(at: offset + 16))
            } else {
                sliceOffset = Int(try data.uint32BE(at: offset + 8))
                sliceSize = Int(try data.uint32BE(at: offset + 12))
            }
            guard sliceOffset >= 0,
                  sliceSize >= 0,
                  sliceOffset + sliceSize <= data.count
            else {
                throw Abort(.badRequest, reason: "Malformed fat Mach-O slice")
            }
            if try patchMachO64Slice(&data, sliceOffset: sliceOffset, sliceSize: sliceSize) {
                patchedSlices += 1
            }
        }
        return (data, patchedSlices)
    }

    private static func patchMachO64Slice(
        _ data: inout Data,
        sliceOffset: Int,
        sliceSize: Int
    ) throws -> Bool {
        guard sliceSize >= 32,
              try data.uint32LE(at: sliceOffset) == machMagic64
        else {
            return false
        }

        let commandCount = Int(try data.uint32LE(at: sliceOffset + 16))
        let commandsSize = Int(try data.uint32LE(at: sliceOffset + 20))
        let commandsOffset = sliceOffset + 32
        let commandsEnd = commandsOffset + commandsSize
        let sliceEnd = sliceOffset + sliceSize
        guard commandCount >= 0,
              commandsOffset <= commandsEnd,
              commandsEnd <= sliceEnd
        else {
            throw Abort(.badRequest, reason: "Malformed Mach-O load command table")
        }

        let commands = try loadCommands(
            in: data,
            offset: commandsOffset,
            end: commandsEnd,
            count: commandCount
        )

        if commands.contains(where: { $0.command == lcBuildVersion }) {
            try patchExistingBuildVersionCommands(&data, commands: commands)
            return true
        }

        guard let versionMinCommand = commands.first(where: { $0.command == lcVersionMinIPhoneOS }) else {
            return false
        }
        try convertVersionMinToBuildVersion(
            &data,
            sliceOffset: sliceOffset,
            sliceSize: sliceSize,
            commands: commands,
            commandsEnd: commandsEnd,
            versionMinCommand: versionMinCommand
        )
        return try patchMachO64Slice(&data, sliceOffset: sliceOffset, sliceSize: sliceSize)
    }

    private static func loadCommands(
        in data: Data,
        offset: Int,
        end: Int,
        count: Int
    ) throws -> [(offset: Int, command: UInt32, size: Int)] {
        var commands: [(offset: Int, command: UInt32, size: Int)] = []
        var commandOffset = offset
        for _ in 0..<count {
            guard commandOffset + 8 <= end else {
                throw Abort(.badRequest, reason: "Malformed Mach-O load command")
            }
            let command = try data.uint32LE(at: commandOffset)
            let commandSize = Int(try data.uint32LE(at: commandOffset + 4))
            guard commandSize >= 8,
                  commandOffset + commandSize <= end
            else {
                throw Abort(.badRequest, reason: "Malformed Mach-O load command size")
            }
            commands.append((commandOffset, command, commandSize))
            commandOffset += commandSize
        }
        guard commandOffset <= end else {
            throw Abort(.badRequest, reason: "Malformed Mach-O load command table")
        }
        return commands
    }

    private static func patchExistingBuildVersionCommands(
        _ data: inout Data,
        commands: [(offset: Int, command: UInt32, size: Int)]
    ) throws {
        // ldid uses the existing LC_CODE_SIGNATURE dataoff as the signed content boundary.
        // Keeping it intact lets ldid replace the old signature after the platform patch.
        for command in commands {
            if command.command == lcBuildVersion {
                guard command.size >= buildVersionCommandSize else {
                    throw Abort(.badRequest, reason: "Malformed LC_BUILD_VERSION command")
                }
                data.setUInt32LE(platformIOSSimulator, at: command.offset + 8)
                data.setUInt32LE(version16, at: command.offset + 12)
                data.setUInt32LE(version16, at: command.offset + 16)
            }
        }
    }

    private static func convertVersionMinToBuildVersion(
        _ data: inout Data,
        sliceOffset: Int,
        sliceSize: Int,
        commands: [(offset: Int, command: UInt32, size: Int)],
        commandsEnd: Int,
        versionMinCommand: (offset: Int, command: UInt32, size: Int)
    ) throws {
        guard versionMinCommand.size == versionMinCommandSize else {
            throw Abort(.badRequest, reason: "Malformed LC_VERSION_MIN_IPHONEOS command")
        }

        let sliceEnd = sliceOffset + sliceSize
        let firstContentOffset = try firstReferencedContentOffset(
            in: data,
            sliceOffset: sliceOffset,
            sliceSize: sliceSize,
            commands: commands
        )
        guard commandsEnd + buildVersionExpansionSize <= sliceEnd,
              commandsEnd + buildVersionExpansionSize <= sliceOffset + firstContentOffset
        else {
            throw Abort(.badRequest, reason: "Mach-O load command padding is too small to migrate LC_VERSION_MIN_IPHONEOS")
        }

        let oldTailStart = versionMinCommand.offset + versionMinCommandSize
        let tail = data.subdata(in: oldTailStart..<commandsEnd)
        data.replaceSubrange(
            oldTailStart + buildVersionExpansionSize..<commandsEnd + buildVersionExpansionSize,
            with: tail
        )

        data.setUInt32LE(lcBuildVersion, at: versionMinCommand.offset)
        data.setUInt32LE(UInt32(buildVersionCommandSize), at: versionMinCommand.offset + 4)
        data.setUInt32LE(platformIOSSimulator, at: versionMinCommand.offset + 8)
        data.setUInt32LE(version16, at: versionMinCommand.offset + 12)
        data.setUInt32LE(version16, at: versionMinCommand.offset + 16)
        data.setUInt32LE(0, at: versionMinCommand.offset + 20)
        let oldCommandsSize = try data.uint32LE(at: sliceOffset + 20)
        data.setUInt32LE(oldCommandsSize + UInt32(buildVersionExpansionSize), at: sliceOffset + 20)
    }

    private static func firstReferencedContentOffset(
        in data: Data,
        sliceOffset: Int,
        sliceSize: Int,
        commands: [(offset: Int, command: UInt32, size: Int)]
    ) throws -> Int {
        var firstOffset = sliceSize
        func record(_ offset: Int) {
            if offset > 0 {
                firstOffset = min(firstOffset, offset)
            }
        }

        for command in commands {
            switch command.command {
            case lcSegment64:
                guard command.size >= 72 else {
                    throw Abort(.badRequest, reason: "Malformed LC_SEGMENT_64 command")
                }
                let fileOffset = Int(try data.uint64LE(at: command.offset + 32))
                let fileSize = try data.uint64LE(at: command.offset + 40)
                if fileSize > 0, fileOffset > 0 {
                    record(fileOffset)
                }
                let sectionCount = Int(try data.uint32LE(at: command.offset + 64))
                let sectionStart = command.offset + 72
                guard sectionCount >= 0,
                      sectionStart + sectionCount * 80 <= command.offset + command.size
                else {
                    throw Abort(.badRequest, reason: "Malformed LC_SEGMENT_64 sections")
                }
                for sectionIndex in 0..<sectionCount {
                    let sectionOffset = sectionStart + sectionIndex * 80
                    record(Int(try data.uint32LE(at: sectionOffset + 48)))
                    record(Int(try data.uint32LE(at: sectionOffset + 56)))
                }
            case lcSymtab:
                guard command.size >= 24 else {
                    throw Abort(.badRequest, reason: "Malformed LC_SYMTAB command")
                }
                record(Int(try data.uint32LE(at: command.offset + 8)))
                record(Int(try data.uint32LE(at: command.offset + 16)))
            case lcDysymtab:
                guard command.size >= 80 else {
                    throw Abort(.badRequest, reason: "Malformed LC_DYSYMTAB command")
                }
                for relativeOffset in [32, 40, 48, 56, 64, 72] {
                    record(Int(try data.uint32LE(at: command.offset + relativeOffset)))
                }
            case lcDyldInfo, lcDyldInfoOnly:
                guard command.size >= 48 else {
                    throw Abort(.badRequest, reason: "Malformed LC_DYLD_INFO command")
                }
                for relativeOffset in [8, 16, 24, 32, 40] {
                    record(Int(try data.uint32LE(at: command.offset + relativeOffset)))
                }
            case lcCodeSignature:
                guard command.size >= 16 else {
                    throw Abort(.badRequest, reason: "Malformed LC_CODE_SIGNATURE command")
                }
                record(Int(try data.uint32LE(at: command.offset + 8)))
            case lcEncryptionInfo64:
                guard command.size >= 24 else {
                    throw Abort(.badRequest, reason: "Malformed LC_ENCRYPTION_INFO_64 command")
                }
                record(Int(try data.uint32LE(at: command.offset + 8)))
            default:
                break
            }
        }

        return firstOffset
    }

    private static func firstReferencedContentOffset(
        in data: Data,
        sliceSize: UInt64,
        commands: [FileLoadCommand]
    ) throws -> UInt64 {
        var firstOffset = sliceSize
        func record(_ offset: UInt64) {
            if offset > 0 {
                firstOffset = min(firstOffset, offset)
            }
        }

        for command in commands {
            let offset = command.localOffset
            switch command.command {
            case lcSegment64:
                guard command.size >= 72 else {
                    throw Abort(.badRequest, reason: "Malformed LC_SEGMENT_64 command")
                }
                let fileOffset = try data.uint64LE(at: offset + 32)
                let fileSize = try data.uint64LE(at: offset + 40)
                if fileSize > 0, fileOffset > 0 {
                    record(fileOffset)
                }
                let sectionCount = Int(try data.uint32LE(at: offset + 64))
                let sectionStart = offset + 72
                guard sectionCount >= 0,
                      sectionStart + sectionCount * 80 <= offset + command.size
                else {
                    throw Abort(.badRequest, reason: "Malformed LC_SEGMENT_64 sections")
                }
                for sectionIndex in 0..<sectionCount {
                    let sectionOffset = sectionStart + sectionIndex * 80
                    record(UInt64(try data.uint32LE(at: sectionOffset + 48)))
                    record(UInt64(try data.uint32LE(at: sectionOffset + 56)))
                }
            case lcSymtab:
                guard command.size >= 24 else {
                    throw Abort(.badRequest, reason: "Malformed LC_SYMTAB command")
                }
                record(UInt64(try data.uint32LE(at: offset + 8)))
                record(UInt64(try data.uint32LE(at: offset + 16)))
            case lcDysymtab:
                guard command.size >= 80 else {
                    throw Abort(.badRequest, reason: "Malformed LC_DYSYMTAB command")
                }
                for relativeOffset in [32, 40, 48, 56, 64, 72] {
                    record(UInt64(try data.uint32LE(at: offset + relativeOffset)))
                }
            case lcDyldInfo, lcDyldInfoOnly:
                guard command.size >= 48 else {
                    throw Abort(.badRequest, reason: "Malformed LC_DYLD_INFO command")
                }
                for relativeOffset in [8, 16, 24, 32, 40] {
                    record(UInt64(try data.uint32LE(at: offset + relativeOffset)))
                }
            case lcCodeSignature:
                guard command.size >= 16 else {
                    throw Abort(.badRequest, reason: "Malformed LC_CODE_SIGNATURE command")
                }
                record(UInt64(try data.uint32LE(at: offset + 8)))
            case lcEncryptionInfo64:
                guard command.size >= 24 else {
                    throw Abort(.badRequest, reason: "Malformed LC_ENCRYPTION_INFO_64 command")
                }
                record(UInt64(try data.uint32LE(at: offset + 8)))
            default:
                break
            }
        }

        return firstOffset
    }

    private static func readData(from fileHandle: FileHandle, at offset: UInt64, length: Int) throws -> Data {
        guard length >= 0 else {
            throw Abort(.badRequest, reason: "Invalid Mach-O read length")
        }
        fileHandle.seek(toFileOffset: offset)
        let data = fileHandle.readData(ofLength: length)
        guard data.count == length else {
            throw Abort(.badRequest, reason: "Unexpected end of Mach-O data")
        }
        return data
    }

    private static func writeData(_ data: Data, to fileHandle: FileHandle, at offset: UInt64) throws {
        fileHandle.seek(toFileOffset: offset)
        fileHandle.write(data)
    }

    private static func writeUInt32LE(_ value: UInt32, to fileHandle: FileHandle, at offset: UInt64) throws {
        var data = Data()
        data.append(UInt8(value & 0xff))
        data.append(UInt8((value >> 8) & 0xff))
        data.append(UInt8((value >> 16) & 0xff))
        data.append(UInt8((value >> 24) & 0xff))
        try writeData(data, to: fileHandle, at: offset)
    }

    private static func resolveLdidPath() throws -> String {
        for path in ldidCandidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        throw Abort(.internalServerError, reason: "ldid is required to sign simulator IPA Mach-O files")
    }

    private static func signMachOFile(_ fileURL: URL, ldidPath: String, workingDirectory: URL) throws {
        let result = try PosixSpawn.run(
            executablePath: ldidPath,
            arguments: ["-S", fileURL.path],
            workingDirectory: workingDirectory,
            timeoutSeconds: commandTimeoutSeconds
        )
        guard result.exitCode == 0 else {
            let message = result.stderrString.isEmpty ? "ldid exited with code \(result.exitCode)" : result.stderrString
            throw Abort(.internalServerError, reason: message)
        }
    }
}

private extension Data {
    func uint32LE(at offset: Int) throws -> UInt32 {
        guard offset >= 0, offset + 4 <= count else {
            throw Abort(.badRequest, reason: "Unexpected end of Mach-O data")
        }
        return UInt32(byte(at: offset)) |
            UInt32(byte(at: offset + 1)) << 8 |
            UInt32(byte(at: offset + 2)) << 16 |
            UInt32(byte(at: offset + 3)) << 24
    }

    func uint32BE(at offset: Int) throws -> UInt32 {
        guard offset >= 0, offset + 4 <= count else {
            throw Abort(.badRequest, reason: "Unexpected end of Mach-O data")
        }
        return UInt32(byte(at: offset)) << 24 |
            UInt32(byte(at: offset + 1)) << 16 |
            UInt32(byte(at: offset + 2)) << 8 |
            UInt32(byte(at: offset + 3))
    }

    func uint64BE(at offset: Int) throws -> UInt64 {
        guard offset >= 0, offset + 8 <= count else {
            throw Abort(.badRequest, reason: "Unexpected end of Mach-O data")
        }
        var value: UInt64 = 0
        for index in 0..<8 {
            value = (value << 8) | UInt64(byte(at: offset + index))
        }
        return value
    }

    func uint64LE(at offset: Int) throws -> UInt64 {
        guard offset >= 0, offset + 8 <= count else {
            throw Abort(.badRequest, reason: "Unexpected end of Mach-O data")
        }
        var value: UInt64 = 0
        for index in 0..<8 {
            value |= UInt64(byte(at: offset + index)) << UInt64(index * 8)
        }
        return value
    }

    mutating func setUInt32LE(_ value: UInt32, at offset: Int) {
        self[index(startIndex, offsetBy: offset)] = UInt8(value & 0xff)
        self[index(startIndex, offsetBy: offset + 1)] = UInt8((value >> 8) & 0xff)
        self[index(startIndex, offsetBy: offset + 2)] = UInt8((value >> 16) & 0xff)
        self[index(startIndex, offsetBy: offset + 3)] = UInt8((value >> 24) & 0xff)
    }

    private func byte(at offset: Int) -> UInt8 {
        self[index(startIndex, offsetBy: offset)]
    }
}
