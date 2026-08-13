import Foundation
import Vapor

struct Software: Content {
    var id: Int64
    var rank: Int?
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

struct Sinf: Content, Equatable {
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
    var decryptEvents: [DecryptEvent]?
    var forceExtensionDecryption: Bool?
    var filePath: String?
    var createdAt: String
    var hasFile: Bool?
    var verification: DecryptVerificationReport? = nil
    var sha256: String? = nil
    var errorCode: DecryptFailureCode? = nil
    var forceExtensionDecryption: Bool? = nil
    var extensionDecryptionPolicy: ExtensionDecryptionPolicy? = nil
    var decryptCheckpoint: DecryptCheckpoint? = nil
    var queuePosition: Int? = nil
    var canRetry: Bool? = nil
}

struct DecryptEvent: Content {
    var kind: String
    var status: String
   var path: String?
    var reportTotal: Int?
    var reportDecrypted: Int?
    var reportRemaining: Int?
    var reportMainRemaining: Int?
    var reportFrameworkRemaining: Int?
    var reportExtensionRemaining: Int?
   var message: String
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
    var forceExtensionDecryption: Bool?
    var preflightLogs: [String]?
}

struct CreateExternalURLDownloadRequest: Content {
    var software: Software
    var accountHash: String
    var sourceURL: String
    var sinfs: [Sinf]
    var iTunesMetadata: String?
    var forceExtensionDecryption: Bool?
}

struct CreateExternalURLDownloadRequest: Content {
    var software: Software
    var accountHash: String
    var sourceURL: String
    var sinfs: [Sinf]
    var iTunesMetadata: String?
    var forceExtensionDecryption: Bool?
    var extensionDecryptionPolicy: ExtensionDecryptionPolicy?
    var initialBatchSize: Int?
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
            rank: nil,
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

struct TopAppsRSSResponse: Decodable {
    var feed: TopAppsFeed
}

struct TopAppsFeed: Decodable {
    var entry: [TopAppsEntry]?
}

struct TopAppsEntry: Decodable {
    var name: TopAppsLabel?
    var title: TopAppsLabel?
    var summary: TopAppsLabel?
    var images: [TopAppsLabel]?
    var price: TopAppsPrice?
    var artist: TopAppsLabel?
    var id: TopAppsID?
    var category: TopAppsCategory?
    var releaseDate: TopAppsLabel?

    enum CodingKeys: String, CodingKey {
        case name = "im:name"
        case title
        case summary
        case images = "im:image"
        case price = "im:price"
        case artist = "im:artist"
        case id
        case category
        case releaseDate = "im:releaseDate"
    }

    func fallbackSoftware(rank: Int) -> Software {
        Software(
            id: Int64(id?.attributes.imID ?? "") ?? 0,
            rank: rank,
            bundleID: "",
            name: name?.label ?? title?.label ?? "App \(id?.attributes.imID ?? "")",
            version: "",
            price: Double(price?.attributes.amount ?? "0"),
            artistName: artist?.label ?? "",
            sellerName: artist?.label ?? "",
            description: summary?.label ?? "",
            averageUserRating: 0,
            userRatingCount: 0,
            artworkUrl: images?.last?.label ?? "",
            screenshotUrls: [],
            minimumOsVersion: "",
            fileSizeBytes: nil,
            releaseDate: releaseDate?.label ?? "",
            releaseNotes: nil,
            formattedPrice: price?.label,
            primaryGenreName: category?.attributes.label ?? ""
        )
    }
}

struct TopAppsLabel: Decodable {
    var label: String
}

struct TopAppsPrice: Decodable {
    var label: String?
    var attributes: TopAppsPriceAttributes
}

struct TopAppsPriceAttributes: Decodable {
    var amount: String?
}

struct TopAppsID: Decodable {
    var attributes: TopAppsIDAttributes
}

struct TopAppsIDAttributes: Decodable {
    var imID: String

    enum CodingKeys: String, CodingKey {
        case imID = "im:id"
    }
}

struct TopAppsCategory: Decodable {
    var attributes: TopAppsCategoryAttributes
}

struct TopAppsCategoryAttributes: Decodable {
    var label: String?
}
