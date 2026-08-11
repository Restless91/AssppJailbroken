import Foundation

enum DecryptFailureCode: String, Codable, Equatable {
    case encryptedMappingDenied = "encrypted_mapping_denied"
    case fairPlayAuthorization = "fairplay_authorization"
    case memoryPressure = "memory_pressure"
    case invalidSignature = "invalid_signature"
    case deviceLocked = "device_locked"
    case bundleBusy = "bundle_busy"
    case verificationFailed = "verification_failed"
    case insufficientStorage = "insufficient_storage"
    case unknown
}

enum DecryptFailureClassifier {
    static func code(for error: Error, message: String) -> DecryptFailureCode {
        if error is DecryptVerificationError { return .verificationFailed }
        return code(message: message)
    }

    static func code(message: String) -> DecryptFailureCode {
        let value = message.lowercased()
        if value.contains("mremap_encrypted") && value.contains("operation not permitted") {
            return .encryptedMappingDenied
        }
        if value.contains("-42004") || value.contains("fairplayopen") {
            return .fairPlayAuthorization
        }
        if value.contains("exit 137") || value.contains("exited with code 137") || value.contains("jetsam") {
            return .memoryPressure
        }
        if value.contains("bad executable") || value.contains("error 85") {
            return .invalidSignature
        }
        if value.contains("device") && value.contains("unlock") {
            return .deviceLocked
        }
        if value.contains("another task") && value.contains("bundle") {
            return .bundleBusy
        }
        if value.contains("insufficient storage") || value.contains("free space") {
            return .insufficientStorage
        }
        return .unknown
    }
}
