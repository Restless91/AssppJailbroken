import Foundation

enum StorageBudget {
    private static let minimumBytes: Int64 = 2 * 1024 * 1024 * 1024
    private static let overheadBytes: Int64 = 512 * 1024 * 1024

    static func requiredBytes(packageSize: Int64) -> Int64 {
        let size = max(0, packageSize)
        let (tripled, overflow) = size.multipliedReportingOverflow(by: 3)
        guard overflow == false, tripled <= Int64.max - overheadBytes else {
            return Int64.max
        }
        return max(minimumBytes, tripled + overheadBytes)
    }
}
