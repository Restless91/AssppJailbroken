import Darwin
import Foundation

enum ProcessWorkingDirectory {
    private static let lock = NSLock()

    static func withCurrentDirectory<T>(_ directory: URL, _ body: () throws -> T) throws -> T {
        lockWorkingDirectory()
        defer { unlockWorkingDirectory() }

        let originalDirectory = FileManager.default.currentDirectoryPath
        try changeDirectory(to: directory.path)
        let result = Result { try body() }
        try changeDirectory(to: originalDirectory)
        return try result.get()
    }

    private static func lockWorkingDirectory() {
        // chdir is process-wide; serialize callers that temporarily change it.
        lock.lock()
    }

    private static func unlockWorkingDirectory() {
        lock.unlock()
    }

    private static func changeDirectory(to path: String) throws {
        guard chdir(path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}
