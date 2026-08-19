import Foundation
@testable import UnfairDaemonCore
import XCTVapor

final class WebRoutesTests: XCTestCase {
    func testAttachmentContentDispositionPreservesUnicodeApplicationName() {
        XCTAssertEqual(
            attachmentContentDisposition(
                displayName: "微信-8.0.75.ipa",
                fallbackName: "com.tencent.xin-8.0.75.ipa"
            ),
            "attachment; filename=\"com.tencent.xin-8.0.75.ipa\"; filename*=UTF-8''%E5%BE%AE%E4%BF%A1-8.0.75.ipa"
        )
    }

    func testAuthSettingsAndStaticRoutesShareOneVaporService() throws {
        let context = try WebTestContext()
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let manager = try WebDownloadManager(config: context.config)
        try webRoutes(app, config: context.config, manager: manager)

        try app.testable().test(.GET, "/api/auth/status") { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertEqual(response.body.string, #"{"required":false}"#)
        }

        try app.testable().test(.GET, "/api/settings") { response in
            XCTAssertEqual(response.status, .ok)
            let json = try JSONSerialization.jsonObject(with: Data(response.body.string.utf8), options: []) as? [String: Any]
            XCTAssertEqual(json?["port"] as? Int, 18080)
            XCTAssertEqual(json?["dataDir"] as? String, context.dataDirectory.path)
            XCTAssertEqual(json?["unfairdBaseUrl"] as? String, "")
        }

        try app.testable().test(.GET, "/") { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertEqual(response.body.string, "index")
        }

        try app.testable().test(.GET, "/downloads/anything") { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertEqual(response.body.string, "index")
        }

        try app.testable().test(.GET, "/assets/missing.js") { response in
            XCTAssertEqual(response.status, .notFound)
        }

        try app.testable().test(.GET, "/api/missing") { response in
            XCTAssertEqual(response.status, .notFound)
        }
    }

    func testAppleRoutesReturnBadRequestForInvalidBody() throws {
        let context = try WebTestContext()
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let manager = try WebDownloadManager(config: context.config)
        try webRoutes(app, config: context.config, manager: manager)

        try app.testable().test(.POST, "/api/apple/versions", beforeRequest: { request in
            try request.content.encode([String: String]())
        }) { response in
            XCTAssertEqual(response.status, .badRequest)
            XCTAssertTrue(response.body.string.contains("account"))
        }
    }

    func testHistoricalVersionsAppleProviderReturnsFallbackSignal() throws {
        let context = try WebTestContext()
        defer { context.cleanup() }
        let app = Application(.testing)
        defer { app.shutdown() }
        let manager = try WebDownloadManager(config: context.config)
        try webRoutes(app, config: context.config, manager: manager)
        let software = Software(
            id: 414478124, bundleID: "com.tencent.xin", name: "微信", version: "8.0.75",
            price: 0, artistName: "", sellerName: "", description: "",
            averageUserRating: 0, userRatingCount: 0, artworkUrl: "", screenshotUrls: [],
            minimumOsVersion: "15.0", fileSizeBytes: nil, releaseDate: "",
            releaseNotes: nil, formattedPrice: nil, primaryGenreName: ""
        )

        try app.testable().test(.POST, "/api/apple/historical-versions", beforeRequest: { request in
            try request.content.encode(AppleHistoricalVersionsRequest(software: software, provider: "apple"))
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let result = try response.content.decode(AppleHistoricalVersionsResponse.self)
            XCTAssertEqual(result.provider, "apple")
            XCTAssertTrue(result.records.isEmpty)
            XCTAssertTrue(result.errors.isEmpty)
        }
    }

    func testAccessTokenQueryAuthorizesBrowserDownloads() throws {
        let context = try WebTestContext(accessPasswordHash: "token")
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let manager = try WebDownloadManager(config: context.config)
        try webRoutes(app, config: context.config, manager: manager)

        try app.testable().test(.GET, "/api/settings") { response in
            XCTAssertEqual(response.status, .unauthorized)
        }

        try app.testable().test(.GET, "/api/settings?accessToken=token") { response in
            XCTAssertEqual(response.status, .ok)
        }
    }

    func testIStoreOSNodeAndAccountCompatibilityRoutes() throws {
        let context = try WebTestContext()
        defer { context.cleanup() }
        let app = Application(.testing)
        defer { app.shutdown() }
        let manager = try WebDownloadManager(config: context.config)
        try routes(app, config: context.config)
        try webRoutes(app, config: context.config, manager: manager)

        try app.testable().test(.GET, "/api/node/info") { response in
            XCTAssertEqual(response.status, .ok)
            let node = try response.content.decode(NodeInfoResponse.self)
            XCTAssertEqual(node.service, "unfaird")
            XCTAssertEqual(node.build.version, BuildInfo.version)
            XCTAssertEqual(node.build.variant, BuildInfo.variant)
            XCTAssertEqual(node.build.profile, BuildInfo.profile)
            XCTAssertEqual(node.build.deviceArchitecture, BuildInfo.deviceArchitecture)
            XCTAssertEqual(node.build.machOArch, BuildInfo.machOArch)
            XCTAssertEqual(node.build.debArchitecture, BuildInfo.debArchitecture)
            XCTAssertEqual(node.build.minIOS, BuildInfo.minIOS)
            XCTAssertEqual(node.build.swiftTarget, BuildInfo.swiftTarget)
            XCTAssertTrue(node.capabilities.externalURLDownload)
            XCTAssertTrue(node.capabilities.defaultAppleAccount)
            XCTAssertFalse(node.capabilities.structuredDecryptEvents)
        }
        try app.testable().test(.GET, "/api/account/default/status") { response in
            XCTAssertEqual(response.status, .ok)
            let status = try response.content.decode(DefaultAppleAccountStatusResponse.self)
            XCTAssertFalse(status.configured)
        }
    }

    func testExternalURLDownloadRejectsPublicHosts() throws {
        let context = try WebTestContext()
        defer { context.cleanup() }
        let app = Application(.testing)
        defer { app.shutdown() }
        let manager = try WebDownloadManager(config: context.config)
        try webRoutes(app, config: context.config, manager: manager)
        let software = Software(
            id: 1, bundleID: "com.example.app", name: "Example", version: "1.0",
            price: 0, artistName: "", sellerName: "", description: "",
            averageUserRating: 0, userRatingCount: 0, artworkUrl: "", screenshotUrls: [],
            minimumOsVersion: "15.0", fileSizeBytes: nil, releaseDate: "",
            releaseNotes: nil, formattedPrice: nil, primaryGenreName: ""
        )

        try app.testable().test(.POST, "/api/downloads/external-url", beforeRequest: { request in
            try request.content.encode(CreateExternalURLDownloadRequest(
                software: software,
                accountHash: "0123456789abcdef",
                sourceURL: "https://example.com/app.ipa",
                sinfs: [],
                iTunesMetadata: nil,
                forceExtensionDecryption: nil
            ))
        }) { response in
            XCTAssertEqual(response.status, .badRequest)
            XCTAssertTrue(response.body.string.contains("private LAN host"))
        }
    }
}

private final class WebTestContext {
    let root: URL
    let dataDirectory: URL
    let publicDirectory: URL
    let config: WebConfig

    init(accessPasswordHash: String = "") throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("unfaird-web-tests-\(UUID().uuidString)", isDirectory: true)
        dataDirectory = root.appendingPathComponent("data", isDirectory: true)
        publicDirectory = root.appendingPathComponent("public", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: publicDirectory, withIntermediateDirectories: true)
        try Data("index".utf8).write(to: publicDirectory.appendingPathComponent("index.html"))

        config = WebConfig(
            port: 18080,
            dataDirectory: dataDirectory,
            publicDirectory: publicDirectory,
            publicBaseURL: "",
            disableHTTPSRedirect: true,
            autoCleanupDays: 0,
            autoCleanupMaxMB: 0,
            maxDownloadMB: 0,
            downloadThreads: 8,
            accessPasswordHash: accessPasswordHash
        )
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: root)
    }
}
