import Foundation
import CryptoKit
@testable import UnfairDaemonCore
import XCTest

final class ResumableFileDownloaderTests: XCTestCase {
    override func tearDown() {
        RangeURLProtocol.handler = nil
        super.tearDown()
    }

    func testContinuesFromStablePartialFile() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("unfaird-range-download-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("app.ipa")
        let url = URL(string: "https://example.apple.com/app.ipa")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RangeURLProtocol.self]
        let downloader = ResumableFileDownloader(configuration: configuration)
        try Data("hello ".utf8).write(to: ResumableFileDownloader.partialURL(for: destination))
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
            .map { String(format: "%02x", $0) }.joined()
        try JSONSerialization.data(withJSONObject: [
            "sourceDigest": digest,
            "entityTag": "\"v1\"",
        ]).write(to: ResumableFileDownloader.metadataURL(for: destination))
        RangeURLProtocol.handler = { request, transport in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=6-")
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-Range"), "\"v1\"")
            transport.respond(
                status: 206,
                headers: ["Content-Length": "5", "Content-Range": "bytes 6-10/11", "ETag": "\"v1\""],
                data: Data("world".utf8)
            )
        }

        try downloader.download(
            url: url,
            destination: destination,
            maxBytes: 1024,
            timeout: 5,
            progress: { _, _, _, _ in },
            taskStarted: { _ in }
        )

        XCTAssertEqual(try Data(contentsOf: destination), Data("hello world".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: ResumableFileDownloader.partialURL(for: destination).path))
    }
}

private final class RangeURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest, RangeURLProtocol) -> Void)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        handler(request, self)
    }

    override func stopLoading() {}

    func respond(status: Int, headers: [String: String], data: Data, error: Error? = nil) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) { [self] in
            client?.urlProtocol(self, didLoad: data)
            if let error {
                client?.urlProtocol(self, didFailWithError: error)
            } else {
                client?.urlProtocolDidFinishLoading(self)
            }
        }
    }
}
