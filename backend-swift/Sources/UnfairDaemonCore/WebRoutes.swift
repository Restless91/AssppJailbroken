import Foundation
import Vapor

func webRoutes(_ app: Application, config: WebConfig, settingsStore: RuntimeSettingsStore, manager: WebDownloadManager) throws {
    registerAuthRoutes(app, config: config, settingsStore: settingsStore)
    registerSettingsRoutes(app, config: config, settingsStore: settingsStore)
    registerAppleProtocolRoutes(app, config: config, settingsStore: settingsStore, manager: manager)
    registerAppleProxyRoutes(app, config: config, settingsStore: settingsStore)
    registerDownloadRoutes(app, config: config, settingsStore: settingsStore, manager: manager)
    registerPackageRoutes(app, config: config, settingsStore: settingsStore, manager: manager)
    registerInstallRoutes(app, config: config, settingsStore: settingsStore, manager: manager)
    registerStaticRoutes(app, config: config)
}

private func registerAuthRoutes(_ app: Application, config: WebConfig, settingsStore: RuntimeSettingsStore) {
    app.get("api", "auth", "status") { _ -> Response in
        try jsonResponse(["required": settingsStore.shouldRequireAccess()])
    }

    app.post("api", "auth", "verify") { req -> Response in
        struct VerifyBody: Content {
            var token: String?
        }
        let body = (try? req.content.decode(VerifyBody.self)) ?? VerifyBody(token: nil)
        return try jsonResponse(["ok": settingsStore.authenticate(token: body.token) != nil])
    }
}

private func registerSettingsRoutes(_ app: Application, config: WebConfig, settingsStore: RuntimeSettingsStore) {
    app.get("api", "settings") { req -> Response in
        let actor: AccessActor = config.accessPasswordHash.isEmpty
            ? .open
            : try requireAccess(req, config: config, settingsStore: settingsStore)
        var payload = settingsStore.currentSettingsPayload()
        payload["uptime"] = Int(Date().timeIntervalSince(webStartedAt))
        payload["buildCommit"] = BuildInfo.commit
        payload["buildDate"] = BuildInfo.timestamp
        payload["port"] = config.port
        payload["dataDir"] = config.dataDirectory.path
        payload["unfairdBaseUrl"] = ""
        payload["unfairdPollSeconds"] = 1
        payload["canEditSettings"] = canEditSettings(actor: actor, config: config)
        return try jsonResponse(payload)
    }

    app.post("api", "settings") { req -> Response in
        try requireAdminAccess(req, config: config, settingsStore: settingsStore)
        let body = try req.content.decode(RuntimeSettings.self)
        try settingsStore.updateSettings(body)
        var payload = settingsStore.currentSettingsPayload()
        payload["success"] = true
        return try jsonResponse(payload)
    }

    app.post("api", "access-tokens") { req -> Response in
        try requireAdminAccess(req, config: config, settingsStore: settingsStore)
        struct CreateTokenBody: Content {
            var name: String?
            var uses: Int?
        }
        let body = (try? req.content.decode(CreateTokenBody.self)) ?? CreateTokenBody(name: nil, uses: nil)
        let generated = try settingsStore.generateToken(name: body.name, uses: body.uses ?? 5)
        return try jsonEncodableResponse(generated, status: .created)
    }

    app.delete("api", "access-tokens", ":id") { req -> Response in
        try requireAdminAccess(req, config: config, settingsStore: settingsStore)
        guard let id = req.parameters.get("id") else {
            throw Abort(.badRequest, reason: "token id required")
        }
        let revoked = try settingsStore.revokeToken(id: id)
        return try jsonResponse(["success": revoked])
    }
}

private func registerAppleProxyRoutes(_ app: Application, config: WebConfig, settingsStore: RuntimeSettingsStore) {
    app.get("api", "bag") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let guid = req.query[String.self, at: "guid"] ?? ""
        guard guid.isEmpty == false else {
            throw Abort(.badRequest, reason: "Missing guid parameter")
        }
        guard guid.range(of: "^[A-Fa-f0-9]+$", options: .regularExpression) != nil else {
            throw Abort(.badRequest, reason: "Invalid guid format")
        }

        guard let url = URL(string: "https://init.itunes.apple.com/bag.xml?guid=\(guid)") else {
            throw Abort(.internalServerError, reason: "Bag request failed")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(
            "Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6",
            forHTTPHeaderField: "User-Agent"
        )
        request.setValue("application/xml", forHTTPHeaderField: "Accept")
        let response = try HTTPSyncClient.shared.send(request, timeout: TimeInterval(WebConfig.bagTimeoutSeconds))
        guard response.statusCode < 400 else {
            throw Abort(.badGateway, reason: "Bag request failed")
        }
        guard response.data.count <= WebConfig.bagMaxBytes else {
            throw Abort(.badGateway, reason: "Bag request failed")
        }
        guard let body = String(data: response.data, encoding: .utf8),
              let plist = body.range(of: "<plist[\\s\\S]*</plist>", options: .regularExpression)
        else {
            throw Abort(.badGateway, reason: "No plist found in bag response")
        }
        return textResponse(String(body[plist]), contentType: "text/xml")
    }

    app.get("api", "search") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let query = req.url.query ?? ""
        let response = try fetchITunes("https://itunes.apple.com/search?\(query)")
        return try jsonEncodableResponse(response.results.map { $0.software() })
    }

    app.get("api", "top-apps") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let country = (req.query[String.self, at: "country"] ?? "cn")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let rawLimit = req.query[Int.self, at: "limit"] ?? 24
        let limit = max(1, min(50, rawLimit))
        let apps = try fetchTopApps(country: country.isEmpty ? "cn" : country, limit: limit)
        return try jsonEncodableResponse(apps)
    }

    app.get("api", "lookup") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let query = lookupQuery(from: req)
        let response = try fetchITunes("https://itunes.apple.com/lookup?\(query)")
        guard response.resultCount > 0, let first = response.results.first else {
            return jsonNullResponse()
        }
        return try jsonEncodableResponse(first.software())
    }
}

private func registerDownloadRoutes(
    _ app: Application,
    config: WebConfig,
    settingsStore: RuntimeSettingsStore,
    manager: WebDownloadManager
) {
    app.get("api", "downloads") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let accountHashes = accountHashSet(req.query[String.self, at: "accountHashes"] ?? "")
        let tasks = manager.allTasks().filter { accountHashes.contains($0.accountHash) }
        return try jsonEncodableResponse(tasks)
    }

    app.post("api", "downloads") { req -> Response in
        let actor = try requireAccess(req, config: config, settingsStore: settingsStore)
        let body = try req.content.decode(CreateDownloadRequest.self)
        guard body.software.id != 0,
              body.accountHash.isEmpty == false,
              body.downloadURL.isEmpty == false
        else {
            throw Abort(.badRequest, reason: "Missing required fields: software, accountHash, downloadURL, sinfs")
        }
        let task = try manager.createTask(body)
        try settingsStore.consumeUse(for: actor)
        return try jsonEncodableResponse(task, status: .created)
    }

    app.post("api", "downloads", "external-url") { req -> Response in
        let actor = try requireAccess(req, config: config, settingsStore: settingsStore)
        let body = try req.content.decode(CreateExternalURLDownloadRequest.self)
        guard body.software.id != 0,
              body.accountHash.isEmpty == false,
              body.sourceURL.isEmpty == false
        else {
            throw Abort(.badRequest, reason: "Missing required fields: software, accountHash, sourceURL, sinfs")
        }
        let task = try manager.createExternalURLTask(body)
        try settingsStore.consumeUse(for: actor)
        return try jsonEncodableResponse(task, status: .created)
    }

    app.get("api", "downloads", ":id") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let accountHash = try requireAccountHash(req)
        let task = try taskByID(req, manager: manager)
        try verifyTaskOwnership(taskAccountHash: task.accountHash, accountHash: accountHash)
        return try jsonEncodableResponse(task)
    }

    app.delete("api", "downloads", ":id") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let accountHash = try requireAccountHash(req)
        let task = try taskByID(req, manager: manager)
        try verifyTaskOwnership(taskAccountHash: task.accountHash, accountHash: accountHash)
        _ = manager.deleteTask(id: task.id)
        return try jsonResponse(["success": true])
    }

    app.post("api", "downloads", ":id", "pause") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try changeDownloadState(req, manager: manager, failure: "Cannot pause this download") { id in
            manager.pauseTask(id: id)
        }
    }

    app.post("api", "downloads", ":id", "resume") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try changeDownloadState(req, manager: manager, failure: "Cannot resume this download") { id in
            manager.resumeTask(id: id)
        }
    }
}

private func registerPackageRoutes(
    _ app: Application,
    config: WebConfig,
    settingsStore: RuntimeSettingsStore,
    manager: WebDownloadManager
) {
    app.get("api", "packages") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let hashes = accountHashSet(req.query[String.self, at: "accountHashes"] ?? "")
        guard hashes.isEmpty == false else {
            return try jsonEncodableResponse([PackageInfo]())
        }
        return try jsonEncodableResponse(manager.packageInfos(accountHashes: hashes))
    }

    app.get("api", "packages", ":id", "file") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let task = try completedPackage(req, manager: manager)
        let name = sanitizeFilename(task.software.name)
        let version = sanitizeFilename(task.software.version)
        let filename = "\(name)_\(version).ipa"
        let response = req.fileio.streamFile(at: task.filePath ?? "")
        response.headers.replaceOrAdd(name: "Content-Disposition", value: contentDispositionAttachment(filename: filename))
        response.headers.replaceOrAdd(name: "Content-Type", value: "application/octet-stream")
        return response
    }

    app.get("api", "packages", ":id", "simulator-file") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let task = try completedPackage(req, manager: manager)
        guard task.filePath != nil else {
            throw Abort(.notFound, reason: "Package not found")
        }
        let simulatorURL = try manager.ensureSimulatorIpa(taskID: task.id)
        guard pathInPackages(simulatorURL.path, manager: manager) else {
            throw Abort(.forbidden, reason: "Access denied")
        }
        let name = sanitizeFilename(task.software.name)
        let version = sanitizeFilename(task.software.version)
        let filename = "\(name)_\(version)_Simulator.ipa"
        let response = req.fileio.streamFile(at: simulatorURL.path)
        response.headers.replaceOrAdd(name: "Content-Disposition", value: contentDispositionAttachment(filename: filename))
        response.headers.replaceOrAdd(name: "Content-Type", value: "application/octet-stream")
        return response
    }

    app.delete("api", "packages", ":id") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        let task = try completedPackage(req, manager: manager)
        _ = manager.deletePackageFile(id: task.id)
        return try jsonResponse(["success": true])
    }
}

private func registerInstallRoutes(
    _ app: Application,
    config: WebConfig,
    settingsStore: RuntimeSettingsStore,
    manager: WebDownloadManager
) {
    app.get("api", "install", ":id", "manifest.plist") { req -> Response in
        let task = try completedInstallTask(req, manager: manager)
        let baseURL = safeBaseURL(for: req, config: config, settingsStore: settingsStore)
        let manifest = buildManifest(
            software: task.software,
            payloadURL: joinURL(baseURL, "/api/install/\(task.id)/payload.ipa"),
            smallIconURL: joinURL(baseURL, "/api/install/\(task.id)/icon-small.png"),
            largeIconURL: joinURL(baseURL, "/api/install/\(task.id)/icon-large.png")
        )
        return textResponse(manifest, contentType: "application/xml")
    }

    app.get("api", "install", ":id", "payload.ipa") { req -> Response in
        let task = try completedInstallTask(req, manager: manager)
        guard let path = task.filePath,
              pathInPackages(path, manager: manager)
        else {
            throw Abort(.forbidden, reason: "Access denied")
        }
        return req.fileio.streamFile(at: path)
    }

    app.get("api", "install", ":id", "icon-small.png") { _ -> Response in
        dataResponse(whitePNG(), contentType: "image/png")
    }

    app.get("api", "install", ":id", "icon-large.png") { _ -> Response in
        dataResponse(whitePNG(), contentType: "image/png")
    }

    app.get("api", "install", ":id", "url") { req -> Response in
        let task = try completedInstallTask(req, manager: manager)
        let manifestURL = joinURL(safeBaseURL(for: req, config: config, settingsStore: settingsStore), "/api/install/\(task.id)/manifest.plist")
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "url", value: manifestURL)]
        let escaped = components.percentEncodedQuery?.dropFirst("url=".count) ?? Substring(manifestURL)
        return try jsonResponse([
            "installUrl": "itms-services://?action=download-manifest&url=\(String(escaped))",
            "manifestUrl": manifestURL,
        ])
    }

    app.post("api", "install", ":id", "direct") { req -> Response in
        let task = try completedInstallTask(req, manager: manager)
        guard let ipaPath = task.filePath, pathInPackages(ipaPath, manager: manager) else {
            throw Abort(.notFound, reason: "IPA file not found")
        }
        return try await installViaURLSession(task: task, config: config)
    }

    app.post("api", "downloads", ":id", "appstore-install") { req -> Response in
        let task = try completedInstallTask(req, manager: manager)
        let adamID = String(task.software.id)
        let versionId = "0"
        let logger: (String) -> Void = { msg in print("[AppStoreInstall] \(msg)") }
        do {
            try await AppStoreInstallService.triggerPurchase(
                adamID: adamID,
                appExtVrsId: versionId,
                logger: logger
            )
            return try jsonResponse(["status": "triggered", "adamId": adamID, "versionId": versionId])
        } catch {
            throw Abort(.internalServerError, reason: "AppStore purchase failed: \(error.localizedDescription)")
        }
    }
}

private func installViaURLSession(task: DownloadTask, config: WebConfig) async throws -> Response {
    let ipaURL = URL(string: "http://127.0.0.1:\(config.port)/api/packages/\(task.id)/file")!
    let result: [String: String] = try await withCheckedThrowingContinuation { continuation in
        let delegate = DirectInstallDelegate(continuation: continuation)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: OperationQueue())
        let downloadTask = session.downloadTask(with: ipaURL)
        delegate.session = session
        delegate.downloadTask = downloadTask
        downloadTask.resume()
    }
    return try jsonResponse(result)
}

private final class DirectInstallDelegate: NSObject, URLSessionDownloadDelegate {
    let continuation: CheckedContinuation<[String: String], Error>
    var session: URLSession?
    var downloadTask: URLSessionDownloadTask?

    init(continuation: CheckedContinuation<[String: String], Error>) {
        self.continuation = continuation
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // nsurlsessiond wrote this file to the REAL filesystem.
        // Pass the temp path directly to trollstorehelper.
        let tempPath = location.path
        guard let helper = findTrollStoreHelper() else {
            continuation.resume(throwing: Abort(.internalServerError, reason: "trollstorehelper not found"))
            return
        }
        do {
            let result = try PosixSpawn.run(
                executablePath: helper,
                arguments: ["install-appstore", tempPath],
                workingDirectory: URL(fileURLWithPath: NSTemporaryDirectory()),
                sandboxProfileURL: nil,
                timeoutSeconds: 120,
                onOutputLine: nil
            )
            self.session?.invalidateAndCancel()
            if result.exitCode == 0 {
                continuation.resume(returning: ["status": "installed", "path": tempPath])
            } else {
                let msg = result.stdoutString.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500)
                continuation.resume(throwing: Abort(.internalServerError, reason: "install-appstore failed (exit \(result.exitCode)): \(msg)"))
            }
        } catch {
            self.session?.invalidateAndCancel()
            continuation.resume(throwing: error)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            session.invalidateAndCancel()
            continuation.resume(throwing: error)
        }
    }
}

private func findTrollStoreHelper() -> String? {
    let candidates = [
        "/var/jb/Applications/TrollStoreLite.app/trollstorehelper",
        "/Applications/TrollStoreLite.app/trollstorehelper",
    ]
    return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
}

private func canEditSettings(actor: AccessActor, config: WebConfig) -> Bool {
    if config.accessPasswordHash.isEmpty {
        return true
    }
    if case .admin = actor {
        return true
    }
    return false
}

private func registerStaticRoutes(_ app: Application, config: WebConfig) {
    app.get { req -> Response in
        try staticResponse(for: req)
    }

    app.get(.catchall) { req -> Response in
        try staticResponse(for: req)
    }
}

/// Serve static files from in-memory embedded resources (bypasses RootHide filesystem sandbox)
private func staticResponse(for req: Request) throws -> Response {
    let path = req.url.path
    if path.hasPrefix("/api/") {
        throw Abort(.notFound)
    }

    guard let resource = EmbeddedWebResources.resource(for: path) else {
        throw Abort(.notFound)
    }

    var headers = HTTPHeaders()
    headers.add(name: .contentType, value: resource.contentType)
    headers.add(name: .cacheControl, value: "no-cache")
    return Response(
        status: .ok,
        headers: headers,
        body: .init(data: resource.data)
    )
}


private func fetchITunes(_ rawURL: String) throws -> ITunesSearchResponse {
    guard let url = URL(string: rawURL) else {
        throw Abort(.badRequest, reason: "invalid iTunes URL")
    }
    let response = try HTTPSyncClient.shared.send(URLRequest(url: url))
    guard (200...299).contains(response.statusCode) else {
        throw Abort(.badGateway, reason: "iTunes request failed")
    }
    return try JSONDecoder().decode(ITunesSearchResponse.self, from: response.data)
}

private func fetchTopApps(country: String, limit: Int) throws -> [Software] {
    guard country.range(of: #"^[A-Za-z]{2}$"#, options: .regularExpression) != nil else {
        throw Abort(.badRequest, reason: "invalid country")
    }
    let rssURL = "https://itunes.apple.com/\(country.lowercased())/rss/topfreeapplications/limit/\(limit)/json"
    guard let url = URL(string: rssURL) else {
        throw Abort(.badRequest, reason: "invalid RSS URL")
    }
    let response = try HTTPSyncClient.shared.send(URLRequest(url: url), timeout: 10)
    guard (200...299).contains(response.statusCode) else {
        throw Abort(.badGateway, reason: "App Store ranking request failed")
    }
    let rss = try JSONDecoder().decode(TopAppsRSSResponse.self, from: response.data)
    let entries = Array((rss.feed.entry ?? []).prefix(limit))
    var apps: [Software] = []

    for entry in entries {
        let rank = apps.count + 1
        let appID = entry.id?.attributes.imID ?? ""
        if appID.isEmpty == false {
            do {
                let lookup = try fetchITunes("https://itunes.apple.com/lookup?id=\(appID)&country=\(country.lowercased())")
                if var software = lookup.results.first?.software(), software.id != 0 {
                    software.rank = rank
                    apps.append(software)
                    continue
                }
            } catch {
                // Fall back to the RSS payload below. The ranking should still render
                // even when a detail lookup fails for a single app.
            }
        }
        apps.append(entry.fallbackSoftware(rank: rank))
    }

    return apps
}

private func lookupQuery(from req: Request) -> String {
    var components = URLComponents()
    components.percentEncodedQuery = req.url.query
    let items = components.queryItems ?? []
    let bundleID = items.first { $0.name == "bundleId" }?.value ?? ""
    guard bundleID.range(of: #"^[0-9]+$"#, options: .regularExpression) != nil else {
        return req.url.query ?? ""
    }

    components.queryItems = items.map { item in
        if item.name == "bundleId" {
            return URLQueryItem(name: "id", value: item.value)
        }
        return item
    }
    return components.percentEncodedQuery ?? req.url.query ?? ""
}

private func taskByID(_ req: Request, manager: WebDownloadManager) throws -> DownloadTask {
    guard let id = req.parameters.get("id"),
          let task = manager.task(id: id)
    else {
        throw Abort(.notFound, reason: "Download not found")
    }
    return task
}

private func changeDownloadState(
    _ req: Request,
    manager: WebDownloadManager,
    failure: String,
    change: (String) -> Bool
) throws -> Response {
    let accountHash = try requireAccountHash(req)
    let task = try taskByID(req, manager: manager)
    try verifyTaskOwnership(taskAccountHash: task.accountHash, accountHash: accountHash)
    guard change(task.id) else {
        throw Abort(.badRequest, reason: failure)
    }
    guard let updated = manager.task(id: task.id) else {
        return try jsonResponse(["success": true])
    }
    return try jsonEncodableResponse(updated)
}

private func completedPackage(_ req: Request, manager: WebDownloadManager) throws -> DownloadTask {
    let accountHash = try requireAccountHash(req)
    let task = try completedInstallTask(req, manager: manager)
    try verifyTaskOwnership(taskAccountHash: task.accountHash, accountHash: accountHash)
    guard let path = task.filePath,
          pathInPackages(path, manager: manager)
    else {
        throw Abort(.forbidden, reason: "Access denied")
    }
    return task
}

private func completedInstallTask(_ req: Request, manager: WebDownloadManager) throws -> DownloadTask {
    guard let id = req.parameters.get("id"),
          let task = manager.completedTask(id: id)
    else {
        throw Abort(.notFound, reason: "Package not found")
    }
    return task
}

private func pathInPackages(_ path: String, manager: WebDownloadManager) -> Bool {
    let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    let base = manager.packagesDirectory.resolvingSymlinksInPath().standardizedFileURL
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory) &&
        isDirectory.boolValue == false &&
        resolved.path.hasPrefix(base.path + "/")
}

private func accountHashSet(_ value: String) -> Set<String> {
    Set(value.split(separator: ",").map(String.init).filter { $0.isEmpty == false })
}

private func buildManifest(software: Software, payloadURL: String, smallIconURL: String, largeIconURL: String) -> String {
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>items</key>
        <array>
            <dict>
                <key>assets</key>
                <array>
                    <dict>
                        <key>kind</key>
                        <string>software-package</string>
                        <key>url</key>
                        <string>\(escapeXML(payloadURL))</string>
                    </dict>
                    <dict>
                        <key>kind</key>
                        <string>display-image</string>
                        <key>url</key>
                        <string>\(escapeXML(smallIconURL))</string>
                    </dict>
                    <dict>
                        <key>kind</key>
                        <string>full-size-image</string>
                        <key>url</key>
                        <string>\(escapeXML(largeIconURL))</string>
                    </dict>
                </array>
                <key>metadata</key>
                <dict>
                    <key>bundle-identifier</key>
                    <string>\(escapeXML(software.bundleID))</string>
                    <key>bundle-version</key>
                    <string>\(escapeXML(software.version))</string>
                    <key>kind</key>
                    <string>software</string>
                    <key>title</key>
                    <string>\(escapeXML(software.name))</string>
                </dict>
            </dict>
        </array>
    </dict>
    </plist>
    """
}

private func whitePNG() -> Data {
    Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4////DwAJBgMBMHREuwAAAABJRU5ErkJggg==") ?? Data()
}
