import Foundation
@testable import UnfairDaemonCore
import XCTVapor

final class WebRoutesTests: XCTestCase {
    func testAuthSettingsAndStaticRoutesShareOneVaporService() throws {
        let context = try WebTestContext()
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let settingsStore = try RuntimeSettingsStore(config: context.config)
        let manager = try WebDownloadManager(config: context.config, settingsStore: settingsStore)
        try webRoutes(app, config: context.config, settingsStore: settingsStore, manager: manager)

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
            XCTAssertEqual(json?["forceExtensionDecryption"] as? Bool, false)
        }

        try app.testable().test(.POST, "/api/settings", beforeRequest: { request in
            try request.content.encode(RuntimeSettings(
                publicBaseURL: nil,
                disableHTTPSRedirect: nil,
                autoCleanupDays: nil,
                autoCleanupMaxMB: nil,
                maxDownloadMB: nil,
                downloadThreads: nil,
                forceExtensionDecryption: true
            ))
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let json = try response.jsonObject()
            XCTAssertEqual(json["forceExtensionDecryption"] as? Bool, true)
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
        let settingsStore = try RuntimeSettingsStore(config: context.config)
        let manager = try WebDownloadManager(config: context.config, settingsStore: settingsStore)
        try webRoutes(app, config: context.config, settingsStore: settingsStore, manager: manager)

        try app.testable().test(.POST, "/api/apple/versions", beforeRequest: { request in
            try request.content.encode([String: String]())
        }) { response in
            XCTAssertEqual(response.status, .badRequest)
            XCTAssertTrue(response.body.string.contains("account"))
        }
    }

    func testDefaultAppleAccountCanBeImportedAndReadWithoutLeakingRawEmail() throws {
        let context = try WebTestContext(
            accessPasswordHash: "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0"
        )
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let settingsStore = try RuntimeSettingsStore(config: context.config)
        let manager = try WebDownloadManager(config: context.config, settingsStore: settingsStore)
        try webRoutes(app, config: context.config, settingsStore: settingsStore, manager: manager)

        try app.testable().test(.GET, "/api/account/default/status", beforeRequest: {
            $0.headers.add(name: "X-Access-Token", value: "token")
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let json = try response.jsonObject()
            XCTAssertEqual(json["configured"] as? Bool, false)
            XCTAssertNil(json["accountHash"] as? String)
        }

        let account = AppleAccount(
            email: "person@example.com",
            password: "",
            appleId: "123456789",
            store: "143465-19,29",
            firstName: "Test",
            lastName: "User",
            passwordToken: "token",
            directoryServicesIdentifier: "dsid-1",
            cookies: [],
            deviceIdentifier: "device-1",
            pod: "pod1"
        )

        try app.testable().test(.POST, "/api/account/default/import", beforeRequest: { request in
            request.headers.add(name: "X-Access-Token", value: "token")
            try request.content.encode(AppleAccountResponse(account: account))
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let json = try response.jsonObject()
            XCTAssertEqual(json["configured"] as? Bool, true)
            XCTAssertEqual(json["emailMasked"] as? String, "per***on@example.com")
            XCTAssertEqual(json["store"] as? String, "143465-19,29")
            XCTAssertEqual(json["pod"] as? String, "pod1")
            XCTAssertNotNil(json["accountHash"] as? String)
            XCTAssertFalse(response.body.string.contains("person@example.com"))
            XCTAssertFalse(response.body.string.contains("token"))
        }

        try app.testable().test(.GET, "/api/account/default/status", beforeRequest: {
            $0.headers.add(name: "X-Access-Token", value: "token")
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let json = try response.jsonObject()
            XCTAssertEqual(json["configured"] as? Bool, true)
            XCTAssertEqual(json["emailMasked"] as? String, "per***on@example.com")
            XCTAssertNotNil(json["accountHash"] as? String)
        }

        try app.testable().test(.GET, "/api/account/default/export", beforeRequest: {
            $0.headers.add(name: "X-Access-Token", value: "token")
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let json = try response.jsonObject()
            let exported = json["account"] as? [String: Any]
            XCTAssertEqual(exported?["email"] as? String, "person@example.com")
            XCTAssertEqual(exported?["passwordToken"] as? String, "token")
        }
    }

    func testDefaultAppleAccountExportRequiresAnExplicitAccessPassword() throws {
        let context = try WebTestContext()
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let settingsStore = try RuntimeSettingsStore(config: context.config)
        let manager = try WebDownloadManager(config: context.config, settingsStore: settingsStore)
        try webRoutes(app, config: context.config, settingsStore: settingsStore, manager: manager)

        try app.testable().test(.GET, "/api/account/default/export") { response in
            XCTAssertEqual(response.status, .serviceUnavailable)
            XCTAssertTrue(response.body.string.contains("ACCESS_PASSWORD"))
        }
    }

    func testAllAppleAccountsCanBeMirroredAndExported() throws {
        let context = try WebTestContext(
            accessPasswordHash: "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0"
        )
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let settingsStore = try RuntimeSettingsStore(config: context.config)
        let manager = try WebDownloadManager(config: context.config, settingsStore: settingsStore)
        try webRoutes(app, config: context.config, settingsStore: settingsStore, manager: manager)

        let first = AppleAccount(
            email: "first@example.com",
            password: "password-1",
            appleId: "apple-1",
            store: "143465-19,29",
            firstName: "First",
            lastName: "User",
            passwordToken: "token-1",
            directoryServicesIdentifier: "dsid-1",
            cookies: [],
            deviceIdentifier: "device-1",
            pod: "pod1"
        )
        let second = AppleAccount(
            email: "second@example.com",
            password: "password-2",
            appleId: "apple-2",
            store: "143441-1,29",
            firstName: "Second",
            lastName: "User",
            passwordToken: "token-2",
            directoryServicesIdentifier: "dsid-2",
            cookies: [],
            deviceIdentifier: "device-2",
            pod: "pod2"
        )

        try app.testable().test(.POST, "/api/account/all/import", beforeRequest: { request in
            request.headers.add(name: "X-Access-Token", value: "token")
            try request.content.encode(AppleAccountListResponse(accounts: [first, second]))
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let json = try response.jsonObject()
            XCTAssertEqual((json["accounts"] as? [[String: Any]])?.count, 2)
        }

        try app.testable().test(.GET, "/api/account/all/export", beforeRequest: {
            $0.headers.add(name: "X-Access-Token", value: "token")
        }) { response in
            XCTAssertEqual(response.status, .ok)
            let json = try response.jsonObject()
            let accounts = json["accounts"] as? [[String: Any]]
            XCTAssertEqual(accounts?.count, 2)
            XCTAssertEqual(accounts?.map { $0["email"] as? String }, [
                "first@example.com",
                "second@example.com"
            ])
        }
    }

    func testAccessTokenQueryAuthorizesBrowserDownloads() throws {
        let context = try WebTestContext(
            accessPasswordHash: "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0"
        )
        defer { context.cleanup() }

        let app = Application(.testing)
        defer { app.shutdown() }
        let settingsStore = try RuntimeSettingsStore(config: context.config)
        let manager = try WebDownloadManager(config: context.config, settingsStore: settingsStore)
        try webRoutes(app, config: context.config, settingsStore: settingsStore, manager: manager)

        try app.testable().test(.GET, "/api/settings") { response in
            XCTAssertEqual(response.status, .unauthorized)
        }

        try app.testable().test(.GET, "/api/settings?accessToken=token") { response in
            XCTAssertEqual(response.status, .ok)
        }
    }
}

private extension XCTHTTPResponse {
    func jsonObject() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.string.utf8), options: []) as? [String: Any])
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
            forceExtensionDecryption: false,
            accessPasswordHash: accessPasswordHash
        )
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: root)
    }
}
