import Foundation
import Vapor

enum HistoricalVersionProvider {
    static let supported = ["auto", "timbrd", "agzy", "bilin", "apple"]
    private static let cacheTTL: TimeInterval = 6 * 60 * 60

    static func normalize(_ value: String?) -> String {
        let provider = (value ?? "auto").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return supported.contains(provider) ? provider : "auto"
    }

    static func fetch(appId: String, provider: String?) async -> HistoricalVersionProviderResult {
        let normalized = normalize(provider)
        let cacheKey = "\(normalized):\(appId)"
        if let cached = await HistoricalVersionCache.shared.get(cacheKey) {
            return cached.withCached(true)
        }

        let result: HistoricalVersionProviderResult
        if normalized == "auto" {
            result = await fetchAuto(appId: appId)
        } else if normalized == "apple" {
            result = HistoricalVersionProviderResult(provider: normalized, records: [], errors: [], cached: false)
        } else {
            result = await fetchSingle(appId: appId, provider: normalized)
        }

        if result.records.isEmpty == false {
            await HistoricalVersionCache.shared.set(result, for: cacheKey, ttl: cacheTTL)
        }
        return result
    }

    private static func fetchAuto(appId: String) async -> HistoricalVersionProviderResult {
        let providers = ["timbrd", "agzy", "bilin"]
        var errors: [String] = []

        return await withTaskGroup(of: HistoricalVersionProviderAttempt.self) { group in
            for provider in providers {
                group.addTask {
                    await fetchAttempt(appId: appId, provider: provider)
                }
            }

            for await attempt in group {
                if attempt.records.isEmpty == false {
                    group.cancelAll()
                    return HistoricalVersionProviderResult(
                        provider: attempt.provider,
                        records: dedupe(attempt.records),
                        errors: errors + attempt.errors,
                        cached: false
                    )
                }
                errors.append(contentsOf: attempt.errors)
            }

            return HistoricalVersionProviderResult(provider: "auto", records: [], errors: errors, cached: false)
        }
    }

    private static func fetchSingle(appId: String, provider: String) async -> HistoricalVersionProviderResult {
        let attempt = await fetchAttempt(appId: appId, provider: provider)
        return HistoricalVersionProviderResult(
            provider: attempt.provider,
            records: dedupe(attempt.records),
            errors: attempt.errors,
            cached: false
        )
    }

    private static func fetchAttempt(appId: String, provider: String) async -> HistoricalVersionProviderAttempt {
        do {
            let records = try await fetchProvider(appId: appId, provider: provider)
            if records.isEmpty {
                return HistoricalVersionProviderAttempt(provider: provider, records: [], errors: ["\(provider): 没有返回历史版本"])
            }
            return HistoricalVersionProviderAttempt(provider: provider, records: records, errors: [])
        } catch {
            return HistoricalVersionProviderAttempt(provider: provider, records: [], errors: ["\(provider): \(error.localizedDescription)"])
        }
    }

    private static func fetchProvider(appId: String, provider: String) async throws -> [HistoricalVersionRecord] {
        let urlString: String
        switch provider {
        case "timbrd":
            urlString = "https://api.timbrd.com/apple/app-version/index.php?id=\(urlEncode(appId))"
        case "agzy":
            urlString = "https://app.agzy.cn/searchVersion?appid=\(urlEncode(appId))"
        case "bilin":
            urlString = "https://apis.bilin.eu.org/history/\(urlEncode(appId))"
        default:
            return []
        }

        guard let url = URL(string: urlString) else {
            throw AppleProtocolError(status: .badRequest, message: "Invalid historical version provider URL")
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("Asspp Web/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json,text/plain,*/*", forHTTPHeaderField: "Accept")

        let (data, response) = try await urlSessionData(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode < 200 || http.statusCode >= 300 {
            throw AppleProtocolError(status: .badGateway, message: "HTTP \(http.statusCode)")
        }

        let json = try JSONSerialization.jsonObject(with: data)
        let items: [Any]
        if let array = json as? [Any] {
            items = array
        } else if let object = json as? [String: Any], let data = object["data"] as? [Any] {
            items = data
        } else {
            items = []
        }

        var records = items.compactMap { normalizeRecord($0, source: provider) }
        if provider == "timbrd" {
            records.sort { compareVersions($0.version, $1.version) > 0 }
        }
        return records
    }

    private static func urlSessionData(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let task = URLSession.shared.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let data, let response else {
                    continuation.resume(throwing: AppleProtocolError(status: .badGateway, message: "历史版本源响应为空"))
                    return
                }
                continuation.resume(returning: (data, response))
            }
            task.resume()
        }
    }

    private static func normalizeRecord(_ item: Any, source: String) -> HistoricalVersionRecord? {
        guard let object = item as? [String: Any] else { return nil }
        let versionId = firstString(
            object["external_identifier"],
            object["versionId"],
            object["version_id"],
            object["id"]
        )
        let version = firstString(
            object["bundle_version"],
            object["version"],
            object["bundleShortVersionString"]
        )
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"^v"#, with: "", options: .regularExpression) ?? ""
        let date = firstString(object["created_at"], object["createTime"], object["updateTime"], object["date"], object["time"])
        let sizeText = normalizeSizeText(object["size"] ?? object["fileSize"] ?? object["fileSizeBytes"])

        guard versionId.isEmpty == false, version.isEmpty == false, version.rangeOfCharacter(from: .decimalDigits) != nil else {
            return nil
        }
        return HistoricalVersionRecord(versionId: versionId, version: version, date: date.isEmpty ? nil : date, sizeText: sizeText, source: source)
    }

    private static func dedupe(_ records: [HistoricalVersionRecord]) -> [HistoricalVersionRecord] {
        var seen = Set<String>()
        var result: [HistoricalVersionRecord] = []
        for record in records.sorted(by: { compareVersions($0.version, $1.version) > 0 }) {
            let key = "\(record.versionId):\(record.version)"
            if seen.contains(key) { continue }
            seen.insert(key)
            result.append(record)
        }
        return result
    }

    private static func firstString(_ values: Any?...) -> String {
        for value in values {
            guard let value else { continue }
            let text = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty == false, text != "<null>" {
                return text
            }
        }
        return ""
    }

    private static func normalizeSizeText(_ value: Any?) -> String? {
        guard let value else { return nil }
        if let number = value as? NSNumber {
            return formatBytes(number.doubleValue)
        }
        let text = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private static func formatBytes(_ bytes: Double) -> String {
        if bytes <= 0 { return "" }
        let units = ["B", "KB", "MB", "GB"]
        var value = bytes
        var index = 0
        while value >= 1024, index < units.count - 1 {
            value /= 1024
            index += 1
        }
        return String(format: index == 0 ? "%.0f %@" : "%.1f %@", value, units[index])
    }

    private static func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    private static func compareVersions(_ left: String, _ right: String) -> Int {
        let leftParts = left.split(separator: ".").map { Int($0) ?? 0 }
        let rightParts = right.split(separator: ".").map { Int($0) ?? 0 }
        let count = max(leftParts.count, rightParts.count)
        for index in 0..<count {
            let leftValue = index < leftParts.count ? leftParts[index] : 0
            let rightValue = index < rightParts.count ? rightParts[index] : 0
            if leftValue != rightValue {
                return leftValue > rightValue ? 1 : -1
            }
        }
        return 0
    }
}

struct HistoricalVersionProviderResult: Sendable {
    var provider: String
    var records: [HistoricalVersionRecord]
    var errors: [String]
    var cached: Bool

    func withCached(_ value: Bool) -> HistoricalVersionProviderResult {
        HistoricalVersionProviderResult(provider: provider, records: records, errors: errors, cached: value)
    }
}

private struct HistoricalVersionProviderAttempt: Sendable {
    var provider: String
    var records: [HistoricalVersionRecord]
    var errors: [String]
}

private actor HistoricalVersionCache {
    static let shared = HistoricalVersionCache()

    private struct Entry {
        var expiresAt: Date
        var result: HistoricalVersionProviderResult
    }

    private var entries: [String: Entry] = [:]

    func get(_ key: String) -> HistoricalVersionProviderResult? {
        guard let entry = entries[key] else { return nil }
        if entry.expiresAt < Date() {
            entries.removeValue(forKey: key)
            return nil
        }
        return entry.result
    }

    func set(_ result: HistoricalVersionProviderResult, for key: String, ttl: TimeInterval) {
        entries[key] = Entry(expiresAt: Date().addingTimeInterval(ttl), result: result.withCached(false))
    }
}
