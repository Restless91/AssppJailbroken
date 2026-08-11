import Darwin
import Foundation
import Vapor

let webStartedAt = Date()

func jsonResponse(_ value: Any, status: HTTPResponseStatus = .ok) throws -> Response {
    let data = try JSONSerialization.data(withJSONObject: value)
    return Response(
        status: status,
        headers: HTTPHeaders([("Content-Type", "application/json")]),
        body: .init(data: data)
    )
}

func jsonEncodableResponse<T: Encodable>(_ value: T, status: HTTPResponseStatus = .ok) throws -> Response {
    let data = try JSONEncoder().encode(value)
    return Response(
        status: status,
        headers: HTTPHeaders([("Content-Type", "application/json")]),
        body: .init(data: data)
    )
}

func jsonNullResponse() -> Response {
    Response(
        status: .ok,
        headers: HTTPHeaders([("Content-Type", "application/json")]),
        body: .init(string: "null")
    )
}

func textResponse(_ text: String, contentType: String, status: HTTPResponseStatus = .ok) -> Response {
    Response(
        status: status,
        headers: HTTPHeaders([("Content-Type", contentType)]),
        body: .init(string: text)
    )
}

func dataResponse(_ data: Data, contentType: String, status: HTTPResponseStatus = .ok) -> Response {
    Response(
        status: status,
        headers: HTTPHeaders([("Content-Type", contentType)]),
        body: .init(data: data)
    )
}

func requireAccess(_ req: Request, config: WebConfig) throws {
    let headerToken = req.headers.first(name: "X-Access-Token")
    let queryToken = req.query[String.self, at: "accessToken"]
    guard config.verifyAccessToken(headerToken) || config.verifyAccessToken(queryToken) else {
        throw Abort(.unauthorized, reason: "Unauthorized")
    }
}

func requireAccountHash(_ req: Request) throws -> String {
    guard let accountHash = req.query[String.self, at: "accountHash"],
          accountHash.count >= WebConfig.minAccountHashLength
    else {
        throw Abort(.badRequest, reason: "Missing or invalid accountHash")
    }
    return accountHash
}

func verifyTaskOwnership(taskAccountHash: String, accountHash: String) throws {
    guard taskAccountHash == accountHash else {
        throw Abort(.forbidden, reason: "Access denied")
    }
}

func currentExecutablePath() -> String {
    let path = CommandLine.arguments[0]
    if path.hasPrefix("/") {
        return path
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent(path)
        .standardizedFileURL
        .path
}

func currentTimestampString() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func fileExists(_ path: String) -> Bool {
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue == false
}

func isIPAddressHost(_ host: String) -> Bool {
    var ipv4 = in_addr()
    if inet_pton(AF_INET, host, &ipv4) == 1 {
        return true
    }

    var ipv6 = in6_addr()
    if inet_pton(AF_INET6, host, &ipv6) == 1 {
        return true
    }

    return false
}

func availableBytes(at url: URL) throws -> Int64 {
    var stats = statfs()
    guard statfs(url.path, &stats) == 0 else {
        throw Abort(.internalServerError, reason: "free space check failed: \(String(cString: strerror(errno)))")
    }
    return Int64(stats.f_bavail) * Int64(stats.f_bsize)
}

func sanitizePathSegment(_ value: String, label: String) throws -> String {
    guard value.isEmpty == false, value != ".", value != ".." else {
        throw Abort(.badRequest, reason: "invalid \(label)")
    }

    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    if value.unicodeScalars.allSatisfy({ allowed.contains($0) }) {
        return value
    }

    let cleaned = String(value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
    guard cleaned.isEmpty == false, cleaned != ".", cleaned != ".." else {
        throw Abort(.badRequest, reason: "invalid \(label)")
    }
    return cleaned
}

func sanitizeFilename(_ value: String) -> String {
    let cleaned = value.map { ch -> Character in
        if ch == "\"" || ch == "\\" || ch == "\r" || ch == "\n" {
            return "_"
        }
        for scalar in String(ch).unicodeScalars {
            if scalar.value < 0x20 || scalar.value > 0x7e {
                return "_"
            }
        }
        return ch
    }
    let value = String(cleaned)
    if value.count <= 200 {
        return value
    }
    return String(value.prefix(200))
}

func attachmentContentDisposition(displayName: String, fallbackName: String) -> String {
    let fallback = sanitizeFilename(fallbackName)
    let attrCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&+-.^_`|~")
    let encoded = displayName.addingPercentEncoding(withAllowedCharacters: attrCharacters) ?? fallback
    return "attachment; filename=\"\(fallback)\"; filename*=UTF-8''\(encoded)"
}

func formatSpeed(bytesPerSecond: Double) -> String {
    if bytesPerSecond < 1024 {
        return String(format: "%.0f B/s", bytesPerSecond)
    }
    if bytesPerSecond < 1024 * 1024 {
        return String(format: "%.1f KB/s", bytesPerSecond / 1024)
    }
    return String(format: "%.1f MB/s", bytesPerSecond / (1024 * 1024))
}

func escapeXML(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&apos;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}

func safeBaseURL(for req: Request, config: WebConfig) -> String {
    let configured = config.publicBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if configured.isEmpty == false {
        return configured
    }

    let forwardedProto = req.headers.first(name: "X-Forwarded-Proto")
    let proto = forwardedProto == "https" ? "https" : "http"
    let host = sanitizeHost(req.headers.first(name: .host) ?? "127.0.0.1:\(config.port)")
    return "\(proto)://\(host)"
}

func sanitizeHost(_ host: String) -> String {
    String(host.unicodeScalars.filter { scalar in
        scalar == ":" || scalar == "." || scalar == "-" || scalar == "_" ||
            (scalar.value >= 48 && scalar.value <= 57) ||
            (scalar.value >= 65 && scalar.value <= 90) ||
            (scalar.value >= 97 && scalar.value <= 122)
    })
}

func joinURL(_ base: String, _ path: String) -> String {
    base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}
