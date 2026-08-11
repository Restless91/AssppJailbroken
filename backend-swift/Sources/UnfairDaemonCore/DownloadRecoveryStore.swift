import CryptoKit
import Foundation

struct DownloadRecoveryMaterial: Codable, Equatable {
    var downloadURL: String
    var sinfs: [Sinf]
    var iTunesMetadata: String?
}

/// Encrypted, device-local recovery material for queued and interrupted tasks.
/// The task list stays safe to expose while this Module owns the sensitive CDN
/// URL, SINF tickets and metadata needed to restart work after daemon reloads.
final class DownloadRecoveryStore {
    private let directory: URL
    private let key: SymmetricKey
    private let fileManager: FileManager

    init(directory: URL, fileManager: FileManager = .default) throws {
        self.directory = directory
        self.fileManager = fileManager
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let keyURL = directory.appendingPathComponent("recovery.key")
        if fileManager.fileExists(atPath: keyURL.path) {
            key = SymmetricKey(data: try Data(contentsOf: keyURL))
        } else {
            let generated = SymmetricKey(size: .bits256)
            let data = generated.withUnsafeBytes { Data($0) }
            try data.write(to: keyURL, options: [.atomic])
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyURL.path)
            key = generated
        }
    }

    func save(_ material: DownloadRecoveryMaterial, taskID: String) throws {
        let plaintext = try JSONEncoder().encode(material)
        guard let combined = try AES.GCM.seal(plaintext, using: key).combined else {
            throw CocoaError(.fileWriteUnknown)
        }
        let url = materialURL(taskID: taskID)
        try combined.write(to: url, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func load(taskID: String) throws -> DownloadRecoveryMaterial? {
        let url = materialURL(taskID: taskID)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let box = try AES.GCM.SealedBox(combined: Data(contentsOf: url))
        return try JSONDecoder().decode(DownloadRecoveryMaterial.self, from: AES.GCM.open(box, using: key))
    }

    func remove(taskID: String) {
        try? fileManager.removeItem(at: materialURL(taskID: taskID))
    }

    private func materialURL(taskID: String) -> URL {
        let digest = SHA256.hash(data: Data(taskID.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(digest).recovery")
    }
}
