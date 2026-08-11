import Foundation
import Vapor

struct Software: Content {
    var id: Int64
    var bundleID: String
    var name: String
    var version: String
    var price: Double?
    var artistName: String
    var sellerName: String
    var description: String
    var averageUserRating: Double
    var userRatingCount: Int64
    var artworkUrl: String
    var screenshotUrls: [String]
    var minimumOsVersion: String
    var fileSizeBytes: String?
    var releaseDate: String
    var releaseNotes: String?
    var formattedPrice: String?
    var primaryGenreName: String
}

struct Sinf: Content {
    var id: Int64
    var sinf: String
}

struct DownloadTask: Content {
    var id: String
    var software: Software
    var accountHash: String
    var downloadURL: String?
    var sinfs: [Sinf]?
    var iTunesMetadata: String?
    var status: String
    var progress: Int
    var speed: String
    var error: String?
    var logs: [String]?
    var filePath: String?
    var createdAt: String
    var hasFile: Bool?
    var verification: DecryptVerificationReport? = nil
    var sha256: String? = nil
    var errorCode: DecryptFailureCode? = nil
    var forceExtensionDecryption: Bool? = nil
}

struct PackageInfo: Content {
    var id: String
    var software: Software
    var accountHash: String
    var fileSize: Int64
    var createdAt: String
}

struct CreateDownloadRequest: Content {
    var software: Software
    var accountHash: String
    var downloadURL: String
    var sinfs: [Sinf]
    var iTunesMetadata: String?
}

struct CreateExternalURLDownloadRequest: Content {
    var software: Software
    var accountHash: String
    var sourceURL: String
    var sinfs: [Sinf]
    var iTunesMetadata: String?
    var forceExtensionDecryption: Bool?
}

struct ITunesSearchResponse: Decodable {
    var resultCount: Int
    var results: [ITunesItem]
}

struct ITunesItem: Decodable {
    var trackId: Int64?
    var bundleId: String?
    var trackName: String?
    var version: String?
    var price: Double?
    var artistName: String?
    var sellerName: String?
    var description: String?
    var averageUserRating: Double?
    var userRatingCount: Int64?
    var artworkUrl512: String?
    var screenshotUrls: [String]?
    var minimumOsVersion: String?
    var fileSizeBytes: String?
    var currentVersionReleaseDate: String?
    var releaseDate: String?
    var releaseNotes: String?
    var formattedPrice: String?
    var primaryGenreName: String?

    func software() -> Software {
        Software(
            id: trackId ?? 0,
            bundleID: bundleId ?? "",
            name: trackName ?? "",
            version: version ?? "",
            price: price,
            artistName: artistName ?? "",
            sellerName: sellerName ?? "",
            description: description ?? "",
            averageUserRating: averageUserRating ?? 0,
            userRatingCount: userRatingCount ?? 0,
            artworkUrl: artworkUrl512 ?? "",
            screenshotUrls: screenshotUrls ?? [],
            minimumOsVersion: minimumOsVersion ?? "",
            fileSizeBytes: fileSizeBytes,
            releaseDate: currentVersionReleaseDate ?? releaseDate ?? "",
            releaseNotes: releaseNotes,
            formattedPrice: formattedPrice,
            primaryGenreName: primaryGenreName ?? ""
        )
    }
}
