import Foundation
import Vapor

func webRoutes(_ app: Application, config: WebConfig, manager: WebDownloadManager) throws {
    registerAuthRoutes(app, config: config)
    registerSettingsRoutes(app, config: config)
    registerAppleProtocolRoutes(app, config: config, manager: manager)
    registerAppleProxyRoutes(app, config: config)
    registerDownloadRoutes(app, config: config, manager: manager)
    registerPackageRoutes(app, config: config, manager: manager)
    registerInstallRoutes(app, config: config, manager: manager)
    registerStaticRoutes(app, config: config)
}

private func registerAuthRoutes(_ app: Application, config: WebConfig) {
    app.get("api", "auth", "status") { _ -> Response in
        try jsonResponse(["required": config.accessPasswordHash.isEmpty == false])
    }

    app.post("api", "auth", "verify") { req -> Response in
        struct VerifyBody: Content {
            var token: String?
        }
        let body = (try? req.content.decode(VerifyBody.self)) ?? VerifyBody(token: nil)
        return try jsonResponse(["ok": config.verifyAccessToken(body.token)])
    }
}

private func registerSettingsRoutes(_ app: Application, config: WebConfig) {
    app.get("api", "settings") { req -> Response in
        try requireAccess(req, config: config)
        return try jsonResponse([
            "uptime": Int(Date().timeIntervalSince(webStartedAt)),
            "buildCommit": BuildInfo.commit,
            "buildDate": BuildInfo.timestamp,
            "port": config.port,
            "dataDir": config.dataDirectory.path,
            "publicBaseUrl": config.publicBaseURL,
            "disableHttpsRedirect": config.disableHTTPSRedirect,
            "autoCleanupDays": config.autoCleanupDays,
            "autoCleanupMaxMB": config.autoCleanupMaxMB,
            "maxDownloadMB": config.maxDownloadMB,
            "downloadThreads": config.downloadThreads,
            "unfairdBaseUrl": "",
            "unfairdPollSeconds": 1,
        ])
    }
}

private func registerAppleProxyRoutes(_ app: Application, config: WebConfig) {
    app.get("api", "bag") { req -> Response in
        try requireAccess(req, config: config)
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
        try requireAccess(req, config: config)
        let query = req.url.query ?? ""
        let response = try fetchITunes("https://itunes.apple.com/search?\(query)")
        return try jsonEncodableResponse(response.results.map { $0.software() })
    }

    app.get("api", "lookup") { req -> Response in
        try requireAccess(req, config: config)
        let query = lookupQuery(from: req)
        let response = try fetchITunes("https://itunes.apple.com/lookup?\(query)")
        guard response.resultCount > 0, let first = response.results.first else {
            return jsonNullResponse()
        }
        return try jsonEncodableResponse(first.software())
    }

    app.get("api", "recommendations") { req -> Response in
        try requireAccess(req, config: config)
        let country = req.query[String.self, at: "country"] ?? "US"
        let limit = req.query[Int.self, at: "limit"] ?? 8
        return try jsonEncodableResponse(AppRecommendationProvider.fetch(country: country, limit: limit))
    }
}

private func registerDownloadRoutes(_ app: Application, config: WebConfig, manager: WebDownloadManager) {
    app.get("api", "downloads") { req -> Response in
        try requireAccess(req, config: config)
        let accountHashes = accountHashSet(req.query[String.self, at: "accountHashes"] ?? "")
        let tasks = manager.allTasks().filter { accountHashes.contains($0.accountHash) }
        return try jsonEncodableResponse(tasks)
    }

    app.post("api", "downloads") { req -> Response in
        try requireAccess(req, config: config)
        let body = try req.content.decode(CreateDownloadRequest.self)
        guard body.software.id != 0,
              body.accountHash.isEmpty == false,
              body.downloadURL.isEmpty == false
        else {
            throw Abort(.badRequest, reason: "Missing required fields: software, accountHash, downloadURL, sinfs")
        }
        let task = try manager.createTask(body)
        return try jsonEncodableResponse(task, status: .created)
    }

    app.post("api", "downloads", "external-url") { req -> Response in
        try requireAccess(req, config: config)
        let body = try req.content.decode(CreateExternalURLDownloadRequest.self)
        guard body.software.id != 0,
              body.accountHash.isEmpty == false,
              body.sourceURL.isEmpty == false
        else {
            throw Abort(.badRequest, reason: "Missing required fields: software, accountHash, sourceURL, sinfs")
        }
        return try jsonEncodableResponse(manager.createExternalURLTask(body), status: .created)
    }

    app.get("api", "downloads", ":id") { req -> Response in
        try requireAccess(req, config: config)
        let accountHash = try requireAccountHash(req)
        let task = try taskByID(req, manager: manager)
        try verifyTaskOwnership(taskAccountHash: task.accountHash, accountHash: accountHash)
        return try jsonEncodableResponse(task)
    }

    app.delete("api", "downloads", ":id") { req -> Response in
        try requireAccess(req, config: config)
        let accountHash = try requireAccountHash(req)
        let task = try taskByID(req, manager: manager)
        try verifyTaskOwnership(taskAccountHash: task.accountHash, accountHash: accountHash)
        _ = manager.deleteTask(id: task.id)
        return try jsonResponse(["success": true])
    }

    app.post("api", "downloads", ":id", "pause") { req -> Response in
        try requireAccess(req, config: config)
        return try changeDownloadState(req, manager: manager, failure: "Cannot pause this download") { id in
            manager.pauseTask(id: id)
        }
    }

    app.post("api", "downloads", ":id", "resume") { req -> Response in
        try requireAccess(req, config: config)
        return try changeDownloadState(req, manager: manager, failure: "Cannot resume this download") { id in
            manager.resumeTask(id: id)
        }
    }
}

private func registerPackageRoutes(_ app: Application, config: WebConfig, manager: WebDownloadManager) {
    app.get("api", "packages") { req -> Response in
        try requireAccess(req, config: config)
        let hashes = accountHashSet(req.query[String.self, at: "accountHashes"] ?? "")
        guard hashes.isEmpty == false else {
            return try jsonEncodableResponse([PackageInfo]())
        }
        return try jsonEncodableResponse(manager.packageInfos(accountHashes: hashes))
    }

    app.get("api", "packages", ":id", "file") { req -> Response in
        try requireAccess(req, config: config)
        let task = try completedPackage(req, manager: manager)
        let version = sanitizeFilename(task.software.version)
        let displayName = "\(task.software.name)-\(version).ipa"
        let fallbackName = "\(task.software.bundleID)-\(version).ipa"
        let response = req.fileio.streamFile(at: task.filePath ?? "")
        response.headers.replaceOrAdd(
            name: "Content-Disposition",
            value: attachmentContentDisposition(displayName: displayName, fallbackName: fallbackName)
        )
        response.headers.replaceOrAdd(name: "Content-Type", value: "application/octet-stream")
        if let sha256 = task.sha256 {
            response.headers.replaceOrAdd(name: "X-Artifact-SHA256", value: sha256)
            response.headers.replaceOrAdd(name: "ETag", value: "\"sha256:\(sha256)\"")
        }
        return response
    }

    app.get("api", "packages", ":id", "simulator-file") { req -> Response in
        try requireAccess(req, config: config)
        let task = try completedPackage(req, manager: manager)
        guard task.filePath != nil else {
            throw Abort(.notFound, reason: "Package not found")
        }
        let simulatorURL = try manager.ensureSimulatorIpa(taskID: task.id)
        guard pathInPackages(simulatorURL.path, manager: manager) else {
            throw Abort(.forbidden, reason: "Access denied")
        }
        let version = sanitizeFilename(task.software.version)
        let displayName = "\(task.software.name)-\(version)-Simulator.ipa"
        let fallbackName = "\(task.software.bundleID)-\(version)-Simulator.ipa"
        let response = req.fileio.streamFile(at: simulatorURL.path)
        response.headers.replaceOrAdd(
            name: "Content-Disposition",
            value: attachmentContentDisposition(displayName: displayName, fallbackName: fallbackName)
        )
        response.headers.replaceOrAdd(name: "Content-Type", value: "application/octet-stream")
        return response
    }

    app.delete("api", "packages", ":id") { req -> Response in
        try requireAccess(req, config: config)
        let task = try completedPackage(req, manager: manager)
        _ = manager.deletePackageFile(id: task.id)
        return try jsonResponse(["success": true])
    }
}

private func registerInstallRoutes(_ app: Application, config: WebConfig, manager: WebDownloadManager) {
    app.get("api", "install", ":id", "manifest.plist") { req -> Response in
        let task = try completedInstallTask(req, manager: manager)
        let baseURL = safeBaseURL(for: req, config: config)
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
        let manifestURL = joinURL(safeBaseURL(for: req, config: config), "/api/install/\(task.id)/manifest.plist")
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "url", value: manifestURL)]
        let escaped = components.percentEncodedQuery?.dropFirst("url=".count) ?? Substring(manifestURL)
        return try jsonResponse([
            "installUrl": "itms-services://?action=download-manifest&url=\(String(escaped))",
            "manifestUrl": manifestURL,
        ])
    }
}

private func registerStaticRoutes(_ app: Application, config: WebConfig) {
    app.get { req -> Response in
        try staticResponse(for: req, config: config)
    }

    app.get(.catchall) { req -> Response in
        try staticResponse(for: req, config: config)
    }
}

private func staticResponse(for req: Request, config: WebConfig) throws -> Response {
    let path = req.url.path
    if path.hasPrefix("/api/") {
        throw Abort(.notFound)
    }
    if path.hasPrefix("/assets/") || (path as NSString).pathExtension.isEmpty == false {
        let relative = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let candidate = config.publicDirectory.appendingPathComponent(relative).standardizedFileURL
        let base = config.publicDirectory.standardizedFileURL
        guard (candidate.path == base.path || candidate.path.hasPrefix(base.path + "/")),
              fileExists(candidate.path)
        else {
            throw Abort(.notFound)
        }
        return staticFile(req, path: candidate.path)
    }

    let relative = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let candidate = config.publicDirectory.appendingPathComponent(relative).standardizedFileURL
    let base = config.publicDirectory.standardizedFileURL
    if (candidate.path == base.path || candidate.path.hasPrefix(base.path + "/")),
       fileExists(candidate.path) {
        return staticFile(req, path: candidate.path)
    }

    let index = config.publicDirectory.appendingPathComponent("index.html")
    guard fileExists(index.path) else {
        throw Abort(.notFound)
    }
    let response = staticFile(req, path: index.path)
    response.headers.replaceOrAdd(name: .cacheControl, value: "no-cache")
    return response
}

private func staticFile(_ req: Request, path: String) -> Response {
    let response = req.fileio.streamFile(at: path)
    switch (path as NSString).pathExtension.lowercased() {
    case "js", "mjs":
        response.headers.replaceOrAdd(name: .contentType, value: "text/javascript; charset=utf-8")
    case "css":
        response.headers.replaceOrAdd(name: .contentType, value: "text/css; charset=utf-8")
    case "json":
        response.headers.replaceOrAdd(name: .contentType, value: "application/json; charset=utf-8")
    case "wasm":
        response.headers.replaceOrAdd(name: .contentType, value: "application/wasm")
    case "png":
        response.headers.replaceOrAdd(name: .contentType, value: "image/png")
    case "ico":
        response.headers.replaceOrAdd(name: .contentType, value: "image/x-icon")
    case "html":
        response.headers.replaceOrAdd(name: .contentType, value: "text/html; charset=utf-8")
    default:
        break
    }
    return response
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
