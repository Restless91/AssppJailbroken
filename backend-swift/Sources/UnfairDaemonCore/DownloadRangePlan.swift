import Foundation

enum DownloadRangePlan: Equatable {
    case append(expectedTotalBytes: Int64)
    case replace(expectedTotalBytes: Int64)

    static func response(
        statusCode: Int,
        contentRange: String?,
        localBytes: Int64,
        responseBytes: Int64
    ) throws -> DownloadRangePlan {
        if statusCode == 200 {
            return .replace(expectedTotalBytes: responseBytes)
        }
        guard statusCode == 206,
              let contentRange,
              let parsed = parseContentRange(contentRange),
              parsed.start == localBytes
        else {
            throw DownloadRangeError.invalidResponse(statusCode: statusCode)
        }
        return .append(expectedTotalBytes: parsed.total)
    }

    private static func parseContentRange(_ value: String) -> (start: Int64, total: Int64)? {
        let pattern = #"^bytes ([0-9]+)-([0-9]+)/([0-9]+)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              let startRange = Range(match.range(at: 1), in: value),
              let endRange = Range(match.range(at: 2), in: value),
              let totalRange = Range(match.range(at: 3), in: value),
              let start = Int64(value[startRange]),
              let end = Int64(value[endRange]),
              let total = Int64(value[totalRange]),
              start <= end,
              end < total
        else { return nil }
        return (start, total)
    }
}

enum DownloadRangeError: LocalizedError {
    case invalidResponse(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse(let statusCode):
            return "download resume returned an invalid HTTP \(statusCode) range response"
        }
    }
}
