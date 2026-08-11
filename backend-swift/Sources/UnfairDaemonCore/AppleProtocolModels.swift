import AsyncHTTPClient
import Foundation
import Vapor

struct WebCookie: Content, Hashable {
    var name: String
    var value: String
    var path: String
    var domain: String?
    var expiresAt: TimeInterval?
    var httpOnly: Bool
    var secure: Bool

    init(
        name: String,
        value: String,
        path: String,
        domain: String? = nil,
        expiresAt: TimeInterval? = nil,
        httpOnly: Bool,
        secure: Bool
    ) {
        self.name = name
        self.value = value
        self.path = path
        self.domain = domain
        self.expiresAt = expiresAt
        self.httpOnly = httpOnly
        self.secure = secure
    }

    init(httpCookie cookie: HTTPClient.Cookie) {
        let expiresAt = cookie.maxAge.map { Date().addingTimeInterval(TimeInterval($0)).timeIntervalSince1970 }
        let domain: String?
        if let cookieDomain = cookie.domain, cookieDomain.hasPrefix(".") {
            domain = String(cookieDomain.dropFirst())
        } else {
            domain = cookie.domain
        }
        self.init(
            name: cookie.name,
            value: cookie.value,
            path: cookie.path.isEmpty ? "/" : cookie.path,
            domain: domain,
            expiresAt: expiresAt,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure
        )
    }
}

struct AppleAccount: Content, Hashable {
    var email: String
    var password: String
    var appleId: String
    var store: String
    var firstName: String
    var lastName: String
    var passwordToken: String
    var directoryServicesIdentifier: String
    var cookies: [WebCookie]
    var deviceIdentifier: String
    var pod: String?
}

struct VersionMetadata: Content, Hashable {
    var displayVersion: String
    var releaseDate: String
}

struct HistoricalVersionRecord: Content, Hashable, Sendable {
    var versionId: String
    var version: String
    var date: String?
    var sizeText: String?
    var source: String
}

struct AppleDownloadOutput: Content {
    var downloadURL: String
    var sinfs: [Sinf]
    var bundleShortVersionString: String
    var bundleVersion: String
    var iTunesMetadata: String
}

struct AppleAuthenticateRequest: Content {
    var email: String
    var password: String
    var code: String?
    var existingCookies: [WebCookie]?
    var deviceIdentifier: String
}

struct AppleAccountRequest: Content {
    var account: AppleAccount
    var software: Software
}

struct AppleVersionListRequest: Content {
    var account: AppleAccount
    var software: Software
}

struct AppleVersionMetadataRequest: Content {
    var account: AppleAccount
    var software: Software
    var versionId: String
}

struct AppleHistoricalVersionsRequest: Content {
    var software: Software
    var provider: String?
}

struct AppleDownloadRequest: Content {
    var account: AppleAccount
    var software: Software
    var accountHash: String
    var externalVersionId: String?
}

struct AppleAccountResponse: Content {
    var account: AppleAccount
}

struct AppleVersionListResponse: Content {
    var account: AppleAccount
    var versions: [String]
}

struct AppleVersionMetadataResponse: Content {
    var account: AppleAccount
    var metadata: VersionMetadata
}

struct AppleHistoricalVersionsResponse: Content {
    var provider: String
    var records: [HistoricalVersionRecord]
    var versions: [String]
    var errors: [String]
    var cached: Bool?
}

struct AppleDownloadResponse: Content {
    var account: AppleAccount
    var task: DownloadTask
}

struct AppleProtocolError: Error {
    var status: HTTPResponseStatus
    var message: String
    var code: String?
    var codeRequired: Bool

    init(
        status: HTTPResponseStatus = .badGateway,
        message: String,
        code: String? = nil,
        codeRequired: Bool = false
    ) {
        self.status = status
        self.message = message
        self.code = code
        self.codeRequired = codeRequired
    }
}

extension AppleProtocolError {
    var isPasswordTokenExpired: Bool {
        code == "2034" || code == "2042" || message == "password token is expired"
    }
}

extension Array where Element == WebCookie {
    mutating func merge(_ cookies: [HTTPClient.Cookie]) {
        var valuesByName: [String: WebCookie] = [:]
        for cookie in self {
            valuesByName[cookie.name] = cookie
        }
        for cookie in cookies {
            let webCookie = WebCookie(httpCookie: cookie)
            valuesByName[webCookie.name] = webCookie
        }
        self = Array(valuesByName.values)
    }

    func cookieHeaders(for endpoint: URL) -> [(String, String)] {
        guard let components = URLComponents(url: endpoint, resolvingAgainstBaseURL: true),
              let host = components.host
        else {
            return []
        }

        let path = components.path.isEmpty ? "/" : components.path
        let now = Date().timeIntervalSince1970
        let values = compactMap { cookie -> String? in
            guard cookie.name.isEmpty == false, cookie.value.isEmpty == false else {
                return nil
            }
            if let domain = cookie.domain, matchesDomain(domain, host) == false {
                return nil
            }
            if matchesPath(cookie.path, path) == false {
                return nil
            }
            if let expiresAt = cookie.expiresAt, expiresAt <= now {
                return nil
            }
            if cookie.secure, components.scheme != "https" {
                return nil
            }
            return "\(cookie.name)=\(cookie.value)"
        }

        guard values.isEmpty == false else {
            return []
        }
        return [("Cookie", values.joined(separator: "; "))]
    }
}

private func matchesDomain(_ cookieDomain: String, _ requestHost: String) -> Bool {
    let domain = cookieDomain.lowercased()
    let host = requestHost.lowercased()
    return host == domain || host.hasSuffix("." + domain)
}

private func matchesPath(_ cookiePath: String, _ requestPath: String) -> Bool {
    if cookiePath == "/" {
        return true
    }
    if requestPath == cookiePath {
        return true
    }
    guard requestPath.hasPrefix(cookiePath) else {
        return false
    }
    let nextIndex = requestPath.index(requestPath.startIndex, offsetBy: cookiePath.count)
    if nextIndex < requestPath.endIndex {
        return cookiePath.hasSuffix("/") || requestPath[nextIndex] == "/"
    }
    return true
}
