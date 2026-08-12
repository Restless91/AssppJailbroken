import Foundation
import Vapor

enum ExtensionDecryptionPolicy: String, Content, CaseIterable {
    case mainOnly = "main_only"
    case compatible
    case strict

    static func resolved(explicit: ExtensionDecryptionPolicy?, legacyForce: Bool?) -> ExtensionDecryptionPolicy {
        if let explicit { return explicit }
        return legacyForce == true ? .strict : .compatible
    }

    var requiresEncryptedExtensionsToFailVerification: Bool {
        self == .strict
    }
}

struct DecryptCheckpoint: Content, Equatable {
    static let currentSchemaVersion = 1

    enum Phase: String, Content {
        case queued
        case preparing
        case scanning
        case decrypting
        case packaging
        case verifying
        case completed
    }

    var phase: Phase
    var schemaVersion: Int? = currentSchemaVersion
    var inputSize: Int64? = nil
    var attempt: Int
    var batchSize: Int
    var completedMachOCount: Int
    var totalMachOCount: Int?
    var currentPath: String?
    var updatedAt: String
}

enum AdaptiveBatchPolicy {
    static let initialBatchSize = 8

    static func clampedInitialBatchSize(_ requested: Int) -> Int {
        min(16, max(1, requested))
    }

    static func nextBatchSize(afterMemoryPressure current: Int) -> Int? {
        guard current > 1 else { return nil }
        return max(1, current / 2)
    }
}
