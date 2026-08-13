import Vapor

struct HealthResponse: Content {
    let status: String
    let service: String
    let buildCommit: String
    let buildTimestamp: String

    enum CodingKeys: String, CodingKey {
        case status
        case service
        case buildCommit = "build_commit"
        case buildTimestamp = "build_timestamp"
    }
}

func routes(
    _ app: Application,
    config: WebConfig? = nil,
    settingsStore: RuntimeSettingsStore? = nil,
    decryptService: DecryptService = DecryptService()
) throws {
    app.get("health") { _ -> HealthResponse in
        HealthResponse.current
    }

    if let config, let settingsStore {
        app.get("api", "node", "info") { req -> NodeInfoResponse in
            try requireAdminAccess(req, config: config, settingsStore: settingsStore)
            return NodeInfoResponse.current(config: config)
        }
    }

    app.on(.POST, "api", "v1", "decrypt", body: .stream) { req -> EventLoopFuture<DecryptQueueResponse> in
        if let config = config {
            _ = try requireAccess(req, config: config, settingsStore: settingsStore)
        }
        if let contentLength = req.headers.first(name: .contentLength).flatMap(Int64.init),
           contentLength > DecryptService.maxUploadBytes {
            throw Abort(.payloadTooLarge, reason: "upload limit is 8GB")
        }
        return try decryptService.enqueueStreamingMultipart(req)
    }

    app.get("api", "v1", "decrypt", ":id", "ready") { req -> DecryptReadyResponse in
        try decryptService.readyResponse(for: jobID(from: req))
    }

    app.get("api", "v1", "decrypt", ":id", "output") { req -> Response in
        let output = try decryptService.validatedReadyOutputURL(for: jobID(from: req))

        return req.fileio.streamFile(at: output.path)
    }
}

private func jobID(from req: Request) throws -> UUID {
    guard let id = req.parameters.get("id"),
          let jobID = UUID(uuidString: id)
    else {
        throw Abort(.badRequest, reason: "valid job id required")
    }
    return jobID
}

private extension HealthResponse {
    static var current: HealthResponse {
        HealthResponse(
            status: "ok",
            service: "unfaird",
            buildCommit: BuildInfo.commit,
            buildTimestamp: BuildInfo.timestamp
        )
    }
}
