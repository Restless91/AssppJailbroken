import Foundation
@testable import UnfairDaemonCore
import XCTest

final class AppRecommendationProviderTests: XCTestCase {
    func testDecodesAppleMarketingFeedAndAddsStableRanking() throws {
        let data = Data(#"{"feed":{"results":[{"artistName":"Example Inc.","id":"123","name":"Example","artworkUrl100":"https://example.com/icon.png","genres":[{"name":"工具"}]}]}}"#.utf8)
        XCTAssertEqual(
            try AppRecommendationProvider.decode(data),
            [AppRecommendation(id: 123, name: "Example", artistName: "Example Inc.", artworkUrl: "https://example.com/icon.png", genreName: "工具", rank: 1)]
        )
    }
}
