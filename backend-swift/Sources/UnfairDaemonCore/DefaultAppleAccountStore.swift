import CryptoKit
import Foundation
import Vapor

struct DefaultAppleAccountStatusResponse: Content {
    var configured: Bool
    var emailMasked: String?
    var store: String?
    var pod: String?
    var accountHash: String?
    var updatedAt: String?
}

struct AppleDefaultDownloadRequest: Content {
    var software: Software
    var externalVersionId: String?
    var forceExtensionDecryption: Bool?
}

struct AppleDefaultDownloadResponse: Content {
    var task: DownloadTask
    var accountHash: String
}

struct AppleDefaultDownloadMaterialsResponse: Content {
    var accountHash: String
    var software: Software
    var downloadURL: String
    var sinfs: [Sinf]
    var iTunesMetadata: String?
    var forceExtensionDecryption: Bool?
}

enum DefaultAppleAccountStore {
    static func accountURL(config: WebConfig) -> URL {
        config.dataDirectory
            .appendingPathComponent("accounts", isDirectory: true)
            .appendingPathComponent("default.json")
    }

    static func status(config: WebConfig) throws -> DefaultAppleAccountStatusResponse {
        guard var record = try readRecord(config: config) else {
            return DefaultAppleAccountStatusResponse(
                configured: false,
                emailMasked: nil,
                store: nil,
                pod: nil,
                accountHash: nil,
                updatedAt: nil
            )
        }
        let hash = record.accountHash ?? accountHash(record.account)
        if record.accountHash == nil {
            record.accountHash = hash
            try writeRecord(record, config: config)
        }
        return DefaultAppleAccountStatusResponse(
            configured: true,
            emailMasked: maskEmail(record.account.email),
            store: record.account.store,
            pod: record.account.pod,
            accountHash: hash,
            updatedAt: record.updatedAt
        )
    }

    static func importAccount(_ account: AppleAccount, config: WebConfig) throws -> DefaultAppleAccountStatusResponse {
        let record = DefaultAppleAccountRecord(
            account: account,
            accountHash: accountHash(account),
            updatedAt: currentTimestampString()
        )
        try writeRecord(record, config: config)
        return try status(config: config)
    }

    static func readAccount(config: WebConfig) throws -> (account: AppleAccount, accountHash: String) {
        guard var record = try readRecord(config: config) else {
            throw AppleProtocolError(
                status: .preconditionFailed,
                message: "Default Apple account is not configured"
            )
        }
        let hash = record.accountHash ?? accountHash(record.account)
        if record.accountHash == nil {
            record.accountHash = hash
            try writeRecord(record, config: config)
        }
        return (record.account, hash)
    }

    static func updateAccount(_ account: AppleAccount, config: WebConfig) throws {
        let record = DefaultAppleAccountRecord(
            account: account,
            accountHash: accountHash(account),
            updatedAt: currentTimestampString()
        )
        try writeRecord(record, config: config)
    }

    private static func readRecord(config: WebConfig) throws -> DefaultAppleAccountRecord? {
        let url = accountURL(config: config)
        guard fileExists(url.path) else {
            return nil
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(DefaultAppleAccountRecord.self, from: data)
    }

    private static func writeRecord(_ record: DefaultAppleAccountRecord, config: WebConfig) throws {
        let url = accountURL(config: config)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(record)
        try data.write(to: url, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func accountHash(_ account: AppleAccount) -> String {
        let source = account.directoryServicesIdentifier.isEmpty == false
            ? account.directoryServicesIdentifier
            : (account.appleId.isEmpty == false ? account.appleId : account.email)
        return SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func maskEmail(_ email: String) -> String {
        guard let atIndex = email.firstIndex(of: "@") else {
            return email.isEmpty ? "" : "\(email.prefix(2))***"
        }
        let local = String(email[..<atIndex])
        let domain = String(email[atIndex...])
        if local.count <= 4 {
            return "\(local.prefix(1))***\(domain)"
        }
        return "\(local.prefix(3))***\(local.suffix(2))\(domain)"
    }
}

private struct DefaultAppleAccountRecord: Codable {
    var account: AppleAccount
    var accountHash: String?
    var updatedAt: String
}
