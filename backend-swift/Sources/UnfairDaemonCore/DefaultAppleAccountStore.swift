import CryptoKit
import Foundation
import Vapor

struct DefaultAppleAccountStatusResponse: Content {
    let configured: Bool
    let emailMasked: String?
    let store: String?
    let pod: String?
    let accountHash: String?
    let updatedAt: String?
}

struct AppleDefaultDownloadRequest: Content {
    let software: Software
    let externalVersionId: String?
}

struct AppleDefaultDownloadMaterialsResponse: Content {
    let accountHash: String
    let software: Software
    let downloadURL: String
    let sinfs: [Sinf]
    let iTunesMetadata: String?
}

enum DefaultAppleAccountStore {
    private struct Record: Codable {
        var account: AppleAccount
        var accountHash: String
        var updatedAt: String
    }

    static func status(config: WebConfig) throws -> DefaultAppleAccountStatusResponse {
        guard let record = try read(config: config) else {
            return DefaultAppleAccountStatusResponse(
                configured: false, emailMasked: nil, store: nil, pod: nil,
                accountHash: nil, updatedAt: nil
            )
        }
        return DefaultAppleAccountStatusResponse(
            configured: true,
            emailMasked: mask(record.account.email),
            store: record.account.store,
            pod: record.account.pod,
            accountHash: record.accountHash,
            updatedAt: record.updatedAt
        )
    }

    static func importAccount(_ account: AppleAccount, config: WebConfig) throws -> DefaultAppleAccountStatusResponse {
        try write(account, config: config)
        return try status(config: config)
    }

    static func readAccount(config: WebConfig) throws -> (AppleAccount, String) {
        guard let record = try read(config: config) else {
            throw Abort(.preconditionFailed, reason: "Default Apple account is not configured")
        }
        return (record.account, record.accountHash)
    }

    static func updateAccount(_ account: AppleAccount, config: WebConfig) throws {
        try write(account, config: config)
    }

    private static func url(config: WebConfig) -> URL {
        config.dataDirectory.appendingPathComponent("accounts/default.json")
    }

    private static func read(config: WebConfig) throws -> Record? {
        let fileURL = url(config: config)
        guard fileExists(fileURL.path) else { return nil }
        return try JSONDecoder().decode(Record.self, from: Data(contentsOf: fileURL))
    }

    private static func write(_ account: AppleAccount, config: WebConfig) throws {
        let fileURL = url(config: config)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let source = account.directoryServicesIdentifier.isEmpty == false
            ? account.directoryServicesIdentifier
            : (account.appleId.isEmpty == false ? account.appleId : account.email)
        let hash = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
        let record = Record(account: account, accountHash: hash, updatedAt: currentTimestampString())
        try JSONEncoder().encode(record).write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    private static func mask(_ email: String) -> String {
        guard let at = email.firstIndex(of: "@") else { return email.isEmpty ? "" : "\(email.prefix(2))***" }
        let local = String(email[..<at])
        return "\(local.prefix(min(3, local.count)))***\(email[at...])"
    }
}
