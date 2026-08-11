import CryptoKit
import Foundation

struct WebConfig {
    static let maxDownloadBytes: Int64 = 8 * 1024 * 1024 * 1024
    static let downloadTimeoutSeconds = 8 * 60 * 60
    static let decryptTimeoutSeconds = 15 * 60
    static let bagTimeoutSeconds = 15
    static let bagMaxBytes = 1024 * 1024
    static let minAccountHashLength = 8

    let port: Int
    let dataDirectory: URL
    let publicDirectory: URL
    let publicBaseURL: String
    let disableHTTPSRedirect: Bool
    let autoCleanupDays: Int
    let autoCleanupMaxMB: Int
    let maxDownloadMB: Int
    let downloadThreads: Int
    let accessPasswordHash: String

    static func load(port: Int) -> WebConfig {
        let env = ProcessInfo.processInfo.environment
        let password = env["ACCESS_PASSWORD"] ?? ""
        return WebConfig(
            port: port,
            dataDirectory: URL(fileURLWithPath: env["DATA_DIR"] ?? "/var/mobile/AssppWebData", isDirectory: true),
            publicDirectory: URL(fileURLWithPath: env["PUBLIC_DIR"] ?? "/var/jb/usr/share/assppweb/public", isDirectory: true),
            publicBaseURL: env["PUBLIC_BASE_URL"] ?? "",
            disableHTTPSRedirect: env["UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT"] == "true",
            autoCleanupDays: Int(env["AUTO_CLEANUP_DAYS"] ?? "") ?? 0,
            autoCleanupMaxMB: Int(env["AUTO_CLEANUP_MAX_MB"] ?? "") ?? 0,
            maxDownloadMB: Int(env["MAX_DOWNLOAD_MB"] ?? "") ?? 0,
            downloadThreads: min(max(Int(env["DOWNLOAD_THREADS"] ?? "") ?? 8, 1), 32),
            accessPasswordHash: Self.hash(password)
        )
    }

    func verifyAccessToken(_ token: String?) -> Bool {
        guard accessPasswordHash.isEmpty == false else {
            return true
        }
        return token == accessPasswordHash
    }

    private static func hash(_ password: String) -> String {
        guard password.isEmpty == false else {
            return ""
        }
        return SHA256.hash(data: Data(password.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
