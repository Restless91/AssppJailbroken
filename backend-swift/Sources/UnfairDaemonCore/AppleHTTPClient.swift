import AsyncHTTPClient
import Foundation

struct AppleHTTPResponse {
    var statusCode: UInt
    var headers: [(String, String)]
    var cookies: [HTTPClient.Cookie]
    var data: Data

    func firstHeader(_ name: String) -> String? {
        headers.first { header in
            header.0.caseInsensitiveCompare(name) == .orderedSame
        }?.1
    }
}

enum AppleHTTPClient {
    private static let standardClient = makeClient(followsRedirects: false)
    private static let redirectClient = makeClient(followsRedirects: true)

    static func send(_ request: HTTPClient.Request, followsRedirects: Bool = false) async throws -> AppleHTTPResponse {
        let client = followsRedirects ? redirectClient : standardClient
        let response = try await client.execute(request: request).get()
        var body = response.body
        let readableBytes = body?.readableBytes ?? 0
        let data = body?.readData(length: readableBytes) ?? Data()
        return AppleHTTPResponse(
            statusCode: response.status.code,
            headers: response.headers.map { ($0.name, $0.value) },
            cookies: response.cookies,
            data: data
        )
    }

    private static func makeClient(followsRedirects: Bool) -> HTTPClient {
        var configuration = HTTPClient.Configuration(
            redirectConfiguration: followsRedirects ? .follow(max: 8, allowCycles: false) : .disallow,
            timeout: .init(
                connect: .seconds(10),
                read: .seconds(30)
            )
        )
        configuration.httpVersion = .http1Only

        return HTTPClient(eventLoopGroupProvider: .singleton, configuration: configuration)
    }
}
