import Foundation
import Vapor

struct AppRecommendation: Content, Equatable {
    var id: Int64
    var name: String
    var artistName: String
    var artworkUrl: String
    var genreName: String
    var rank: Int
}

enum AppRecommendationProvider {
    private struct FeedResponse: Decodable {
        struct Feed: Decodable {
            struct Result: Decodable {
                struct Genre: Decodable { var name: String }
                var artistName: String
                var id: String
                var name: String
                var artworkUrl100: String
                var genres: [Genre]
            }
            var results: [Result]
        }
        var feed: Feed
    }

    static func fetch(country: String, limit: Int) throws -> [AppRecommendation] {
        let normalizedCountry = country.lowercased()
        guard normalizedCountry.range(of: "^[a-z]{2}$", options: .regularExpression) != nil else {
            throw Abort(.badRequest, reason: "Invalid country parameter")
        }
        let normalizedLimit = min(max(limit, 1), 20)
        guard let url = URL(string: "https://rss.applemarketingtools.com/api/v2/\(normalizedCountry)/apps/top-free/\(normalizedLimit)/apps.json") else {
            throw Abort(.internalServerError, reason: "Recommendation request failed")
        }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("unfaird/1.0", forHTTPHeaderField: "User-Agent")
        let response = try HTTPSyncClient.shared.send(request, timeout: 12)
        guard (200...299).contains(response.statusCode), response.data.count <= 2 * 1024 * 1024 else {
            throw Abort(.badGateway, reason: "App Store recommendations unavailable")
        }
        return try decode(response.data)
    }

    static func decode(_ data: Data) throws -> [AppRecommendation] {
        let response = try JSONDecoder().decode(FeedResponse.self, from: data)
        return response.feed.results.enumerated().compactMap { index, item in
            guard let id = Int64(item.id) else { return nil }
            return AppRecommendation(
                id: id,
                name: item.name,
                artistName: item.artistName,
                artworkUrl: item.artworkUrl100,
                genreName: item.genres.first?.name ?? "",
                rank: index + 1
            )
        }
    }
}
