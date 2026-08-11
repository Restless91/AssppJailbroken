import Foundation

enum PackageRunnerResolver {
    static let environmentKey = "UNFAIR_PACKAGE_RUNNER"

    static func executablePath(
        currentExecutablePath: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> String {
        guard let configured = environment[environmentKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            configured.isEmpty == false,
            configured.hasPrefix("/"),
            isExecutable(configured)
        else {
            return currentExecutablePath
        }
        return configured
    }

    static func arguments(
        inputPath: String,
        outputPath: String,
        workingDirectoryPath: String,
        forceExtensionDecryption: Bool,
        supportsForceExtensions: Bool
    ) -> [String] {
        var values = [
            "package",
            "--input", inputPath,
            "--output", outputPath,
            "--working-directory", workingDirectoryPath,
            "--verbose",
        ]
        if forceExtensionDecryption && supportsForceExtensions {
            values.append("--force-extensions")
        }
        return values
    }
}
