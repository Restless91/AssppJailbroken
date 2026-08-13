import Vapor

public func configure(_ app: Application, hostname: String = "127.0.0.1", port: Int = 8080) throws {
    try DecryptService.prepareWorkDirectoryForStartup()
    DecryptService.startExpiredJobCleanup()

    let webConfig = WebConfig.load(port: port)
    let settingsStore = try RuntimeSettingsStore(config: webConfig)
    let downloadManager = try WebDownloadManager(config: webConfig, settingsStore: settingsStore)

    app.http.server.configuration.hostname = hostname
    app.http.server.configuration.port = port
    app.routes.defaultMaxBodySize = "8gb"

    try routes(app, config: webConfig, settingsStore: settingsStore)
    try webRoutes(app, config: webConfig, settingsStore: settingsStore, manager: downloadManager)
}
