import Foundation
import Vapor

func registerAppleProtocolRoutes(
    _ app: Application,
    config: WebConfig,
    settingsStore: RuntimeSettingsStore,
    manager: WebDownloadManager
) {
    app.get("api", "account", "default", "status") { req -> Response in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try jsonEncodableResponse(DefaultAppleAccountStore.status(config: config))
    }

    app.post("api", "account", "default", "import") { req -> Response in
        try requireAdminAccess(req, config: config, settingsStore: settingsStore)
        let body = try req.content.decode(AppleAccountResponse.self)
        return try jsonEncodableResponse(DefaultAppleAccountStore.importAccount(body.account, config: config))
    }

    app.get("api", "account", "default", "export") { req -> Response in
        try requireConfiguredAdminAccess(req, config: config, settingsStore: settingsStore)
        let (account, _) = try DefaultAppleAccountStore.readAccount(config: config)
        return try jsonEncodableResponse(AppleAccountResponse(account: account))
    }

    app.post("api", "account", "all", "import") { req -> Response in
        try requireAdminAccess(req, config: config, settingsStore: settingsStore)
        let body = try req.content.decode(AppleAccountListResponse.self)
        let accounts = try AppleAccountCollectionStore.replaceAccounts(body.accounts, config: config)
        return try jsonEncodableResponse(AppleAccountListResponse(accounts: accounts))
    }

    app.get("api", "account", "all", "export") { req -> Response in
        try requireConfiguredAdminAccess(req, config: config, settingsStore: settingsStore)
        let accounts = try AppleAccountCollectionStore.readAccounts(config: config)
        return try jsonEncodableResponse(AppleAccountListResponse(accounts: accounts))
    }

    app.post("api", "apple", "authenticate") { req -> EventLoopFuture<Response> in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleAuthenticateRequest.self) { body in
            let account = try await AppleProtocolService.authenticate(body)
            return try jsonEncodableResponse(AppleAccountResponse(account: account))
        }
    }

    app.post("api", "apple", "purchase") { req -> EventLoopFuture<Response> in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleAccountRequest.self) { body in
            let account = try await AppleProtocolService.purchase(account: body.account, software: body.software)
            return try jsonEncodableResponse(AppleAccountResponse(account: account))
        }
    }

    app.post("api", "apple", "versions") { req -> EventLoopFuture<Response> in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleVersionListRequest.self) { body in
            let result = try await AppleProtocolService.listVersions(account: body.account, software: body.software)
            return try jsonEncodableResponse(AppleVersionListResponse(account: result.account, versions: result.versions))
        }
    }

    app.post("api", "apple", "historical-versions") { req -> EventLoopFuture<Response> in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleHistoricalVersionsRequest.self) { body in
            let appId = String(body.software.id)
            let result = await HistoricalVersionProvider.fetch(appId: appId, provider: body.provider)
            return try jsonEncodableResponse(AppleHistoricalVersionsResponse(
                provider: result.provider,
                records: result.records,
                versions: result.records.map(\.versionId),
                errors: result.errors,
                cached: result.cached
            ))
        }
    }

    app.post("api", "apple", "version-metadata") { req -> EventLoopFuture<Response> in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleVersionMetadataRequest.self) { body in
            let result = try await AppleProtocolService.versionMetadata(
                account: body.account,
                software: body.software,
                versionId: body.versionId
            )
            return try jsonEncodableResponse(AppleVersionMetadataResponse(account: result.account, metadata: result.metadata))
        }
    }

    app.post("api", "downloads", "apple") { req -> EventLoopFuture<Response> in
        let actor = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleDownloadRequest.self) { body in
            guard body.accountHash.count >= WebConfig.minAccountHashLength else {
                throw AppleProtocolError(status: .badRequest, message: "Missing or invalid accountHash")
            }

            let result = try await AppleProtocolService.compatibleDownloadInfo(
                account: body.account,
                software: body.software,
                externalVersionId: body.externalVersionId
            )
            var software = body.software
            software.version = result.output.bundleShortVersionString
            software.minimumOsVersion = result.minimumOSVersion
            let task = try manager.createTask(CreateDownloadRequest(
                software: software,
                accountHash: body.accountHash,
                downloadURL: result.output.downloadURL,
                sinfs: result.output.sinfs,
                iTunesMetadata: result.output.iTunesMetadata,
                forceExtensionDecryption: body.forceExtensionDecryption,
                preflightLogs: result.preflightLogs
            ))
            try settingsStore.consumeUse(for: actor)
            return try jsonEncodableResponse(AppleDownloadResponse(account: result.account, task: task), status: .created)
        }
    }

    app.post("api", "downloads", "apple", "default") { req -> EventLoopFuture<Response> in
        let actor = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleDefaultDownloadRequest.self) { body in
            var (account, accountHash) = try DefaultAppleAccountStore.readAccount(config: config)
            let software = body.software

            if (software.price ?? 0) <= 0 {
                do {
                    account = try await AppleProtocolService.purchase(account: account, software: software)
                    try DefaultAppleAccountStore.updateAccount(account, config: config)
                    accountHash = try DefaultAppleAccountStore.readAccount(config: config).accountHash
                } catch {
                    if isAlreadyPurchasedError(error) == false {
                        throw error
                    }
                }
            }

            let result = try await AppleProtocolService.compatibleDownloadInfo(
                account: account,
                software: software,
                externalVersionId: body.externalVersionId
            )
            try DefaultAppleAccountStore.updateAccount(result.account, config: config)
            accountHash = try DefaultAppleAccountStore.readAccount(config: config).accountHash

            var resolvedSoftware = software
            resolvedSoftware.version = result.output.bundleShortVersionString
            resolvedSoftware.minimumOsVersion = result.minimumOSVersion
            let task = try manager.createTask(CreateDownloadRequest(
                software: resolvedSoftware,
                accountHash: accountHash,
                downloadURL: result.output.downloadURL,
                sinfs: result.output.sinfs,
                iTunesMetadata: result.output.iTunesMetadata,
                forceExtensionDecryption: body.forceExtensionDecryption,
                preflightLogs: result.preflightLogs
            ))
            try settingsStore.consumeUse(for: actor)
            return try jsonEncodableResponse(AppleDefaultDownloadResponse(task: task, accountHash: accountHash), status: .created)
        }
    }

    app.post("api", "downloads", "apple", "default", "materials") { req -> EventLoopFuture<Response> in
        _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        return try appleProtocolFuture(for: req, as: AppleDefaultDownloadRequest.self) { body in
            var (account, accountHash) = try DefaultAppleAccountStore.readAccount(config: config)
            let software = body.software

            if (software.price ?? 0) <= 0 {
                do {
                    account = try await AppleProtocolService.purchase(account: account, software: software)
                    try DefaultAppleAccountStore.updateAccount(account, config: config)
                    accountHash = try DefaultAppleAccountStore.readAccount(config: config).accountHash
                } catch {
                    if isAlreadyPurchasedError(error) == false {
                        throw error
                    }
                }
            }

            let result = try await AppleProtocolService.compatibleDownloadInfo(
                account: account,
                software: software,
                externalVersionId: body.externalVersionId
            )
            try DefaultAppleAccountStore.updateAccount(result.account, config: config)
            accountHash = try DefaultAppleAccountStore.readAccount(config: config).accountHash

            var resolvedSoftware = software
            resolvedSoftware.version = result.output.bundleShortVersionString
            resolvedSoftware.minimumOsVersion = result.minimumOSVersion
            return try jsonEncodableResponse(AppleDefaultDownloadMaterialsResponse(
                accountHash: accountHash,
                software: resolvedSoftware,
                downloadURL: result.output.downloadURL,
                sinfs: result.output.sinfs,
                iTunesMetadata: result.output.iTunesMetadata,
                forceExtensionDecryption: body.forceExtensionDecryption
            ))
        }
    }
}

private func isAlreadyPurchasedError(_ error: Error) -> Bool {
    let message = String(describing: error).lowercased()
    return message.contains("already purchased") || message.contains("failuretype: 5002")
}

private func appleProtocolFuture<T: Decodable>(
    for req: Request,
    as type: T.Type,
    _ body: @Sendable @escaping (T) async throws -> Response
) throws -> EventLoopFuture<Response> {
    do {
        let decoded = try req.content.decode(type)
        return appleProtocolFuture(on: req.eventLoop) {
            try await body(decoded)
        }
    } catch let error as DecodingError {
        return req.eventLoop.makeSucceededFuture(
            try appleErrorResponse(AppleProtocolError(status: .badRequest, message: String(describing: error)))
        )
    }
}

private func appleProtocolFuture(
    on eventLoop: EventLoop,
    _ body: @Sendable @escaping () async throws -> Response
) -> EventLoopFuture<Response> {
    eventLoop.makeFutureWithTask {
        try await appleProtocolResponse(body)
    }
}

private func appleProtocolResponse(_ body: () async throws -> Response) async throws -> Response {
    do {
        return try await body()
    } catch let error as AppleProtocolError {
        return try appleErrorResponse(error)
    } catch {
        return try appleErrorResponse(AppleProtocolError(message: String(describing: error)))
    }
}

private func appleErrorResponse(_ error: AppleProtocolError) throws -> Response {
    var payload: [String: Any] = ["error": error.message]
    if let code = error.code {
        payload["code"] = code
    }
    if error.codeRequired {
        payload["codeRequired"] = true
    }
    return try jsonResponse(payload, status: error.status)
}
