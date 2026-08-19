import Foundation

enum PackageRunnerResolver {
    static let environmentKey = "UNFAIR_PACKAGE_RUNNER"
    static let resumableRunnerEnvironmentKey = "UNFAIR_PACKAGE_RUNNER_RESUMABLE"

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
        extensionPolicy: ExtensionDecryptionPolicy,
        supportsExtensionPolicy: Bool,
        batchSize: Int? = nil,
        checkpointPath: String? = nil,
        supportsResumableBatches: Bool = false,
        verbose: Bool = false
    ) -> [String] {
        var values = [
            "package",
            "--input", inputPath,
            "--output", outputPath,
            "--working-directory", workingDirectoryPath,
        ]
        if verbose {
            values.append("--verbose")
        }
        if extensionPolicy == .strict && supportsExtensionPolicy {
            values.append("--force-extensions")
        }
        if supportsResumableBatches, let batchSize, let checkpointPath {
            values.append(contentsOf: ["--batch-size", String(batchSize), "--checkpoint", checkpointPath])
        }
        return values
    }

    static func supportsResumableBatches(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Bool {
        let value = environment[resumableRunnerEnvironmentKey]?.lowercased()
        return value == "1" || value == "true" || value == "yes"
    }
}
