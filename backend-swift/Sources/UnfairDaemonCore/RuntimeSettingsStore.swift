import CryptoKit
import Foundation
import Vapor

struct RuntimeSettings: Content {
    var publicBaseURL: String?
    var disableHTTPSRedirect: Bool?
    var autoCleanupDays: Int?
    var autoCleanupMaxMB: Int?
    var maxDownloadMB: Int?
    var downloadThreads: Int?
    var forceExtensionDecryption: Bool?

    static let empty = RuntimeSettings(
        publicBaseURL: nil,
        disableHTTPSRedirect: nil,
        autoCleanupDays: nil,
        autoCleanupMaxMB: nil,
        maxDownloadMB: nil,
        downloadThreads: nil,
        forceExtensionDecryption: nil
    )

    private enum CodingKeys: String, CodingKey {
        case publicBaseUrl
        case publicBaseURL
        case disableHttpsRedirect
        case disableHTTPSRedirect
        case autoCleanupDays
        case autoCleanupMaxMB
        case maxDownloadMB
        case downloadThreads
        case forceExtensionDecryption
    }

    init(
        publicBaseURL: String?,
        disableHTTPSRedirect: Bool?,
        autoCleanupDays: Int?,
        autoCleanupMaxMB: Int?,
        maxDownloadMB: Int?,
        downloadThreads: Int?,
        forceExtensionDecryption: Bool?
    ) {
        self.publicBaseURL = publicBaseURL
        self.disableHTTPSRedirect = disableHTTPSRedirect
        self.autoCleanupDays = autoCleanupDays
        self.autoCleanupMaxMB = autoCleanupMaxMB
        self.maxDownloadMB = maxDownloadMB
        self.downloadThreads = downloadThreads
        self.forceExtensionDecryption = forceExtensionDecryption
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        publicBaseURL = try container.decodeIfPresent(String.self, forKey: .publicBaseUrl)
            ?? container.decodeIfPresent(String.self, forKey: .publicBaseURL)
        disableHTTPSRedirect = try container.decodeIfPresent(Bool.self, forKey: .disableHttpsRedirect)
            ?? container.decodeIfPresent(Bool.self, forKey: .disableHTTPSRedirect)
        autoCleanupDays = try container.decodeIfPresent(Int.self, forKey: .autoCleanupDays)
        autoCleanupMaxMB = try container.decodeIfPresent(Int.self, forKey: .autoCleanupMaxMB)
        maxDownloadMB = try container.decodeIfPresent(Int.self, forKey: .maxDownloadMB)
        downloadThreads = try container.decodeIfPresent(Int.self, forKey: .downloadThreads)
        forceExtensionDecryption = try container.decodeIfPresent(Bool.self, forKey: .forceExtensionDecryption)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(publicBaseURL, forKey: .publicBaseUrl)
        try container.encodeIfPresent(disableHTTPSRedirect, forKey: .disableHttpsRedirect)
        try container.encodeIfPresent(autoCleanupDays, forKey: .autoCleanupDays)
        try container.encodeIfPresent(autoCleanupMaxMB, forKey: .autoCleanupMaxMB)
        try container.encodeIfPresent(maxDownloadMB, forKey: .maxDownloadMB)
        try container.encodeIfPresent(downloadThreads, forKey: .downloadThreads)
        try container.encodeIfPresent(forceExtensionDecryption, forKey: .forceExtensionDecryption)
    }
}

struct EffectiveRuntimeSettings {
    let publicBaseURL: String
    let disableHTTPSRedirect: Bool
    let autoCleanupDays: Int
    let autoCleanupMaxMB: Int
    let maxDownloadMB: Int
    let downloadThreads: Int
    let forceExtensionDecryption: Bool
}

struct AccessTokenInfo: Codable {
    let id: String
    var name: String
    var tokenHash: String
    var totalUses: Int
    var remainingUses: Int
    var createdAt: String
    var lastUsedAt: String?
    var revokedAt: String?

    var isActive: Bool {
        revokedAt == nil && remainingUses > 0
    }
}

struct PublicAccessTokenInfo: Codable {
    let id: String
    let name: String
    let totalUses: Int
    let remainingUses: Int
    let createdAt: String
    let lastUsedAt: String?
    let revokedAt: String?
    let isActive: Bool
}

struct GeneratedAccessToken: Codable {
    let token: String
    let record: PublicAccessTokenInfo
}

enum AccessActor {
    case open
    case admin
    case limitedToken(String)
}

final class RuntimeSettingsStore {
    private struct StoreFile: Codable {
        var settings: RuntimeSettings
        var tokens: [AccessTokenInfo]
    }

    private let config: WebConfig
    private let fileURL: URL
    private let lock = NSLock()
    private var settings: RuntimeSettings
    private var tokens: [AccessTokenInfo]

    init(config: WebConfig) throws {
        self.config = config
        self.fileURL = config.dataDirectory.appendingPathComponent("settings.json")
        self.settings = .empty
        self.tokens = []
        try FileManager.default.createDirectory(at: config.dataDirectory, withIntermediateDirectories: true)
        try load()
    }

    func effectiveSettings() -> EffectiveRuntimeSettings {
        lock.lock()
        let current = settings
        lock.unlock()

        return EffectiveRuntimeSettings(
            publicBaseURL: trimmed(current.publicBaseURL) ?? config.publicBaseURL,
            disableHTTPSRedirect: current.disableHTTPSRedirect ?? config.disableHTTPSRedirect,
            autoCleanupDays: max(0, current.autoCleanupDays ?? config.autoCleanupDays),
            autoCleanupMaxMB: max(0, current.autoCleanupMaxMB ?? config.autoCleanupMaxMB),
            maxDownloadMB: max(0, current.maxDownloadMB ?? config.maxDownloadMB),
            downloadThreads: min(max(current.downloadThreads ?? config.downloadThreads, 1), 2),
            forceExtensionDecryption: current.forceExtensionDecryption ?? config.forceExtensionDecryption
        )
    }

    func currentSettingsPayload() -> [String: Any] {
        let effective = effectiveSettings()
        return [
            "publicBaseUrl": effective.publicBaseURL,
            "disableHttpsRedirect": effective.disableHTTPSRedirect,
            "autoCleanupDays": effective.autoCleanupDays,
            "autoCleanupMaxMB": effective.autoCleanupMaxMB,
            "maxDownloadMB": effective.maxDownloadMB,
            "downloadThreads": effective.downloadThreads,
            "forceExtensionDecryption": effective.forceExtensionDecryption,
            "tokens": publicTokens().map { token in
                [
                    "id": token.id,
                    "name": token.name,
                    "totalUses": token.totalUses,
                    "remainingUses": token.remainingUses,
                    "createdAt": token.createdAt,
                    "lastUsedAt": token.lastUsedAt ?? NSNull(),
                    "revokedAt": token.revokedAt ?? NSNull(),
                    "isActive": token.isActive,
                ]
            },
        ]
    }

    func updateSettings(_ update: RuntimeSettings) throws {
        lock.lock()
        settings = RuntimeSettings(
            publicBaseURL: trimmed(update.publicBaseURL),
            disableHTTPSRedirect: update.disableHTTPSRedirect,
            autoCleanupDays: clampedNonNegative(update.autoCleanupDays),
            autoCleanupMaxMB: clampedNonNegative(update.autoCleanupMaxMB),
            maxDownloadMB: clampedNonNegative(update.maxDownloadMB),
            downloadThreads: update.downloadThreads.map { min(max($0, 1), 2) },
            forceExtensionDecryption: update.forceExtensionDecryption
        )
        let snapshot = StoreFile(settings: settings, tokens: tokens)
        lock.unlock()
        try persist(snapshot)
    }

    func shouldRequireAccess() -> Bool {
        config.accessPasswordHash.isEmpty == false
    }

    func authenticate(token: String?) -> AccessActor? {
        guard let raw = token?.trimmingCharacters(in: .whitespacesAndNewlines), raw.isEmpty == false else {
            return config.accessPasswordHash.isEmpty ? .open : nil
        }
        let digest = Self.normalizedDigest(raw)
        if config.accessPasswordHash.isEmpty == false && digest == config.accessPasswordHash {
            return .admin
        }

        lock.lock()
        defer { lock.unlock() }
        guard let record = tokens.first(where: { $0.tokenHash == digest && $0.isActive }) else {
            return config.accessPasswordHash.isEmpty ? .open : nil
        }
        return .limitedToken(record.id)
    }

    func consumeUse(for actor: AccessActor) throws {
        guard case .limitedToken(let id) = actor else {
            return
        }

        lock.lock()
        guard let index = tokens.firstIndex(where: { $0.id == id && $0.isActive }) else {
            lock.unlock()
            throw Abort(.unauthorized, reason: "Token has no remaining uses")
        }
        tokens[index].remainingUses = max(0, tokens[index].remainingUses - 1)
        tokens[index].lastUsedAt = currentTimestampString()
        let snapshot = StoreFile(settings: settings, tokens: tokens)
        lock.unlock()
        try persist(snapshot)
    }

    func publicTokens() -> [PublicAccessTokenInfo] {
        lock.lock()
        let values = tokens
        lock.unlock()
        return values.map(publicToken)
    }

    func generateToken(name: String?, uses: Int) throws -> GeneratedAccessToken {
        let rawToken = "asspp_" + Self.randomTokenSuffix()
        let now = currentTimestampString()
        let record = AccessTokenInfo(
            id: UUID().uuidString,
            name: trimmed(name) ?? "Token \(String(now.prefix(10)))",
            tokenHash: Self.hash(rawToken),
            totalUses: min(max(uses, 1), 999),
            remainingUses: min(max(uses, 1), 999),
            createdAt: now,
            lastUsedAt: nil,
            revokedAt: nil
        )

        lock.lock()
        tokens.insert(record, at: 0)
        let snapshot = StoreFile(settings: settings, tokens: tokens)
        lock.unlock()
        try persist(snapshot)

        return GeneratedAccessToken(token: rawToken, record: publicToken(record))
    }

    func revokeToken(id: String) throws -> Bool {
        lock.lock()
        guard let index = tokens.firstIndex(where: { $0.id == id }) else {
            lock.unlock()
            return false
        }
        tokens[index].revokedAt = currentTimestampString()
        let snapshot = StoreFile(settings: settings, tokens: tokens)
        lock.unlock()
        try persist(snapshot)
        return true
    }

    private func load() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return
        }
        let data = try Data(contentsOf: fileURL)
        let decoded = try JSONDecoder().decode(StoreFile.self, from: data)
        settings = decoded.settings
        tokens = decoded.tokens
    }

    private func persist(_ snapshot: StoreFile) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(snapshot)
        try data.write(to: fileURL, options: .atomic)
    }

    private func publicToken(_ token: AccessTokenInfo) -> PublicAccessTokenInfo {
        PublicAccessTokenInfo(
            id: token.id,
            name: token.name,
            totalUses: token.totalUses,
            remainingUses: token.remainingUses,
            createdAt: token.createdAt,
            lastUsedAt: token.lastUsedAt,
            revokedAt: token.revokedAt,
            isActive: token.isActive
        )
    }

    private static func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func normalizedDigest(_ value: String) -> String {
        if value.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil {
            return value.lowercased()
        }
        return hash(value)
    }

    private static func randomTokenSuffix() -> String {
        let seed = "\(UUID().uuidString)-\(Date().timeIntervalSince1970)-\(Int.random(in: 0...Int.max))"
        return SHA256.hash(data: Data(seed.utf8))
            .prefix(20)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

private func trimmed(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), value.isEmpty == false else {
        return nil
    }
    return value
}

private func clampedNonNegative(_ value: Int?) -> Int? {
    value.map { max(0, $0) }
}
