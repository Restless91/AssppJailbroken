import Foundation

enum DecryptTimeoutPolicy {
    private static let gibibyte: Int64 = 1024 * 1024 * 1024

    static func seconds(fileSize: Int64) -> Int {
        let normalized = max(0, fileSize)
        let gibibytes = max(1, (normalized + gibibyte - 1) / gibibyte)
        return min(60 * 60, max(15 * 60, Int(gibibytes) * 10 * 60))
    }
}
