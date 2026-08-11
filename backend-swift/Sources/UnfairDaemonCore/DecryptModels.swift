import Vapor

struct DecryptUpload: Content {
    var ipa: File?
    var url: String?
    var ipaURL: String?

    enum CodingKeys: String, CodingKey {
        case ipa
        case url
        case ipaURL = "ipa_url"
    }

    var sourceURLString: String? {
        ipaURL ?? url
    }
}

struct DecryptQueueResponse: Content {
    let queue: DecryptQueueInfo
}

struct DecryptReadyResponse: Content {
    let queue: DecryptQueueInfo
    let exit: DecryptExit?
    let error: String?
}

struct DecryptQueueInfo: Content {
    let id: UUID
    let status: DecryptJobStatus
    let ready: Bool
    let readyURL: String
    let downloadURL: String
    let validateUntil: Int

    enum CodingKeys: String, CodingKey {
        case id
        case status
        case ready
        case readyURL = "ready_url"
        case downloadURL = "download_url"
        case validateUntil = "validate_until"
    }
}

enum DecryptJobStatus: String, Content {
    case queued
    case running
    case succeeded
    case failed
}

struct DecryptExit: Content {
    let code: Int32
    let stdout: String
    let stderr: String
    let downloadURL: String
    let validateUntil: Int

    enum CodingKeys: String, CodingKey {
        case code
        case stdout
        case stderr
        case downloadURL = "download_url"
        case validateUntil = "validate_until"
    }
}

struct DecryptJobMetadata: Codable {
    let id: UUID
    let status: DecryptJobStatus
    let validateUntil: Int
    let updatedAt: Int
    let exit: DecryptExit?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case id
        case status
        case validateUntil = "validate_until"
        case updatedAt = "updated_at"
        case exit
        case error
    }
}
