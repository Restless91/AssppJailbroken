import ApplePackage
import Foundation
import Vapor

enum AppleProtocolService {
    private static let applePackage = ApplePackageExecutor()
    private static let compatibilityCache = CompatibilityMinimumOSCache()
    private static let rateLimitCode = "rate_limited"
    private static let rateLimitMessage = "Apple rate limit reached. Wait before trying again."

    static func authenticate(_ request: AppleAuthenticateRequest) async throws -> AppleAccount {
        do {
            try validateDeviceIdentifier(request.deviceIdentifier)
            let account = try await applePackage.authenticate(
                email: request.email,
                password: request.password,
                code: request.code ?? "",
                cookies: request.existingCookies?.applePackageCookies() ?? [],
                deviceIdentifier: request.deviceIdentifier
            )
            return account.webAccount(deviceIdentifier: request.deviceIdentifier)
        } catch let error as AppleProtocolError {
            throw error
        } catch {
            throw protocolError(from: error)
        }
    }

    static func purchase(account: AppleAccount, software: Software) async throws -> AppleAccount {
        guard (software.price ?? 0) <= 0 else {
            throw AppleProtocolError(status: .badRequest, message: "purchasing paid apps is not supported")
        }

        let result = try await runWithTokenRefresh(account: account) { packageAccount, deviceIdentifier in
            let updatedAccount = try await applePackage.purchase(
                account: packageAccount,
                app: software.applePackageSoftware(),
                deviceIdentifier: deviceIdentifier
            )
            return (updatedAccount, ())
        }
        return result.account
    }

    static func downloadInfo(
        account: AppleAccount,
        software: Software,
        externalVersionId: String?
    ) async throws -> (account: AppleAccount, output: AppleDownloadOutput) {
        let result = try await runWithTokenRefresh(account: account) { packageAccount, deviceIdentifier in
            try await applePackage.download(
                account: packageAccount,
                app: software.applePackageSoftware(),
                externalVersionId: externalVersionId,
                deviceIdentifier: deviceIdentifier
            )
        }
        return (account: result.account, output: result.value.webDownloadOutput())
    }

    struct CompatibleDownloadResult {
        var account: AppleAccount
        var output: AppleDownloadOutput
        var selectedExternalVersionId: String?
        var minimumOSVersion: String
        var preflightLogs: [String]
    }

    static func compatibleDownloadInfo(
        account: AppleAccount,
        software: Software,
        externalVersionId: String?
    ) async throws -> CompatibleDownloadResult {
        let currentOS = ProcessInfo.processInfo.operatingSystemVersion
        var initial = try await downloadInfo(
            account: account,
            software: software,
            externalVersionId: externalVersionId
        )
        let initialCacheKey = "\(software.bundleID):\(externalVersionId ?? "latest"):\(initial.output.bundleVersion)"
        let initialMinimumOS = try compatibilityCache.value(for: initialCacheKey) {
            try minimumOSVersion(
                output: initial.output,
                knownLatestMinimumOS: externalVersionId == nil ? software.minimumOsVersion : nil
            )
        }
        if OSVersionCompatibility.isCompatible(minimumOSVersion: initialMinimumOS, current: currentOS) {
            return CompatibleDownloadResult(
                account: initial.account,
                output: initial.output,
                selectedExternalVersionId: externalVersionId,
                minimumOSVersion: initialMinimumOS,
                preflightLogs: []
            )
        }

        let currentDescription = OSVersionCompatibility.display(currentOS)
        var logs = [
            "所选版本 \(initial.output.bundleShortVersionString) 要求 iOS \(initialMinimumOS)，" +
                "当前设备为 iOS \(currentDescription)，开始自动查找兼容历史版本。",
        ]
        let listed = try await listVersions(account: initial.account, software: software)
        initial.account = listed.account
        var versionIDs = Array(Set(listed.versions)).sorted(by: versionIDDescending)
        if let requested = externalVersionId,
           let requestedIndex = versionIDs.firstIndex(of: requested) {
            versionIDs = Array(versionIDs[requestedIndex...])
        }
        guard versionIDs.isEmpty == false else {
            throw AppleProtocolError(
                status: .preconditionFailed,
                message: "App requires iOS \(initialMinimumOS), and Apple returned no historical versions to check."
            )
        }

        var lowerBound = 0
        var upperBound = versionIDs.count - 1
        var best: (id: String, account: AppleAccount, output: AppleDownloadOutput, minimumOS: String)?
        var workingAccount = initial.account

        // App Store external version IDs are chronological. Binary search keeps the
        // compatibility lookup fast while still selecting the newest compatible build.
        while lowerBound <= upperBound {
            let index = lowerBound + (upperBound - lowerBound) / 2
            let candidateID = versionIDs[index]
            let candidate = try await downloadInfo(
                account: workingAccount,
                software: software,
                externalVersionId: candidateID
            )
            workingAccount = candidate.account
            let cacheKey = "\(software.bundleID):\(candidateID):\(candidate.output.bundleVersion)"
            let candidateMinimumOS = try compatibilityCache.value(for: cacheKey) {
                try minimumOSVersion(output: candidate.output, knownLatestMinimumOS: nil)
            }

            if OSVersionCompatibility.isCompatible(minimumOSVersion: candidateMinimumOS, current: currentOS) {
                best = (
                    id: candidateID,
                    account: candidate.account,
                    output: candidate.output,
                    minimumOS: candidateMinimumOS
                )
                upperBound = index - 1
            } else {
                lowerBound = index + 1
            }
        }

        guard let best else {
            throw AppleProtocolError(
                status: .preconditionFailed,
                message: "No historical version compatible with iOS \(currentDescription) was found. " +
                    "The original signed IPA was left unchanged."
            )
        }
        logs.append(
            "已自动选择兼容历史版本 \(best.output.bundleShortVersionString) " +
                "（最低 iOS \(best.minimumOS)，版本 ID \(best.id)）。"
        )
        return CompatibleDownloadResult(
            account: best.account,
            output: best.output,
            selectedExternalVersionId: best.id,
            minimumOSVersion: best.minimumOS,
            preflightLogs: logs
        )
    }

    static func listVersions(account: AppleAccount, software: Software) async throws -> (account: AppleAccount, versions: [String]) {
        let result = try await runWithTokenRefresh(account: account) { packageAccount, deviceIdentifier in
            try await applePackage.listVersions(
                account: packageAccount,
                bundleIdentifier: software.bundleID,
                deviceIdentifier: deviceIdentifier
            )
        }
        return (account: result.account, versions: result.value)
    }

    static func versionMetadata(
        account: AppleAccount,
        software: Software,
        versionId: String
    ) async throws -> (account: AppleAccount, metadata: VersionMetadata) {
        let result = try await runWithTokenRefresh(account: account) { packageAccount, deviceIdentifier in
            try await applePackage.versionMetadata(
                account: packageAccount,
                app: software.applePackageSoftware(),
                versionId: versionId,
                deviceIdentifier: deviceIdentifier
            )
        }
        return (account: result.account, metadata: result.value.webVersionMetadata())
    }

    static func protocolErrorForTesting(_ error: Error) -> AppleProtocolError {
        protocolError(from: error)
    }

    private static func minimumOSVersion(
        output: AppleDownloadOutput,
        knownLatestMinimumOS: String?
    ) throws -> String {
        if let knownLatestMinimumOS, knownLatestMinimumOS.isEmpty == false {
            return knownLatestMinimumOS
        }
        if let value = output.minimumOSVersion, value.isEmpty == false {
            return value
        }
        do {
            return try IPACompatibilityInspector.minimumOSVersion(
                downloadURL: output.downloadURL,
                iTunesMetadataBase64: output.iTunesMetadata
            )
        } catch {
            throw AppleProtocolError(
                status: .badGateway,
                message: "Unable to determine IPA compatibility without modifying its signature: " +
                    (error.localizedDescription)
            )
        }
    }

    private static func versionIDDescending(_ left: String, _ right: String) -> Bool {
        if let lhs = UInt64(left), let rhs = UInt64(right), lhs != rhs {
            return lhs > rhs
        }
        return left.localizedStandardCompare(right) == .orderedDescending
    }

    private static func runWithTokenRefresh<T>(
        account: AppleAccount,
        _ operation: (ApplePackage.Account, String) async throws -> (ApplePackage.Account, T)
    ) async throws -> (account: AppleAccount, value: T) {
        do {
            try validateDeviceIdentifier(account.deviceIdentifier)
            let result = try await operation(account.applePackageAccount(), account.deviceIdentifier)
            return (account: result.0.webAccount(deviceIdentifier: account.deviceIdentifier), value: result.1)
        } catch {
            let mappedError = protocolError(from: error)
            guard mappedError.isPasswordTokenExpired else {
                throw mappedError
            }

            let refreshedAccount = try await refreshAccount(account)
            do {
                let result = try await operation(refreshedAccount.applePackageAccount(), refreshedAccount.deviceIdentifier)
                return (account: result.0.webAccount(deviceIdentifier: refreshedAccount.deviceIdentifier), value: result.1)
            } catch {
                throw protocolError(from: error)
            }
        }
    }

    private static func refreshAccount(_ account: AppleAccount) async throws -> AppleAccount {
        try await authenticate(AppleAuthenticateRequest(
            email: account.email,
            password: account.password,
            code: nil,
            existingCookies: account.cookies,
            deviceIdentifier: account.deviceIdentifier
        ))
    }

    private static func validateDeviceIdentifier(_ deviceIdentifier: String) throws {
        guard deviceIdentifier.isEmpty == false else {
            throw AppleProtocolError(status: .badRequest, message: "deviceIdentifier is required")
        }
    }

    private static func protocolError(from error: Error) -> AppleProtocolError {
        if let error = error as? AppleProtocolError {
            return error
        }

        if case ApplePackage.ApplePackageError.licenseRequired = error {
            return AppleProtocolError(
                status: .conflict,
                message: "license required - purchase the app first",
                code: "9610"
            )
        }

        let message = (error as NSError).localizedDescription
        let code = failureCode(in: message)
        if let code {
            switch code {
            case "2034", "2042":
                return AppleProtocolError(status: .unauthorized, message: "password token is expired", code: code)
            case "5005":
                return AppleProtocolError(status: .conflict, message: "invalid or expired 2FA code", code: code)
            case "9610":
                return AppleProtocolError(
                    status: .conflict,
                    message: "license required - purchase the app first",
                    code: code
                )
            default:
                return AppleProtocolError(status: .conflict, message: message, code: code)
            }
        }

        let lowercasedMessage = message.lowercased()
        if lowercasedMessage.contains("rate limit") || lowercasedMessage.contains("too many requests") {
            return AppleProtocolError(status: .tooManyRequests, message: rateLimitMessage, code: rateLimitCode)
        }
        if lowercasedMessage.contains("response body is empty") && lowercasedMessage.contains("code: 204") {
            return AppleProtocolError(
                status: .conflict,
                message: "Authentication requires verification code. If no trusted-device prompt appears, manually get a verification code from your trusted device settings and enter it here.",
                codeRequired: true
            )
        }
        if lowercasedMessage.contains("empty authentication response") {
            return AppleProtocolError(
                status: .conflict,
                message: "Authentication requires verification code. If no trusted-device prompt appears, manually get a verification code from your trusted device settings and enter it here.",
                codeRequired: true
            )
        }
        if lowercasedMessage.contains("verification code was not accepted") ||
            lowercasedMessage.contains("authentication challenge expired")
        {
            return AppleProtocolError(
                status: .conflict,
                message: "The verification code was not accepted or the Apple login challenge expired. Get a fresh code from a trusted device and try again immediately.",
                codeRequired: true
            )
        }
        if lowercasedMessage.contains("html authentication response") ||
            lowercasedMessage.contains("redirect without a usable login location") ||
            lowercasedMessage.contains("did not create a native 2fa challenge")
        {
            return AppleProtocolError(
                status: .conflict,
                message: "Apple did not create a trusted-device verification challenge. Keep the same device identifier, stop randomizing it, sign in at account.apple.com once to confirm the account, wait a few minutes if you retried often, then try again.",
                codeRequired: false
            )
        }
        if lowercasedMessage.contains("apple authentication service returned") {
            return AppleProtocolError(
                status: .badGateway,
                message: "Apple authentication service returned a temporary server error. Wait a few minutes and retry with the same device identifier.",
                codeRequired: false
            )
        }
        if message.contains("Authentication requires verification code") {
            return AppleProtocolError(
                status: .conflict,
                message: "Authentication requires verification code. If no trusted-device prompt appears, manually get a verification code from your trusted device settings and enter it here.",
                codeRequired: true
            )
        }
        if lowercasedMessage.contains("password token is expired") ||
            message == "Your password has changed." ||
            lowercasedMessage.contains("expiredpasswordtoken")
        {
            return AppleProtocolError(status: .unauthorized, message: "password token is expired")
        }
        if lowercasedMessage.contains("correct format") ||
            lowercasedMessage.contains("property list") ||
            lowercasedMessage.contains("plist")
        {
            return AppleProtocolError(
                status: .conflict,
                message: "Apple returned a non-login response. The verification code may not match this login attempt, may be expired, or Apple may require you to confirm the account at account.apple.com first.",
                codeRequired: true
            )
        }
        if lowercasedMessage.contains("purchasing paid apps is not supported") {
            return AppleProtocolError(status: .badRequest, message: "purchasing paid apps is not supported")
        }
        if lowercasedMessage.contains("subscription required") {
            return AppleProtocolError(status: .conflict, message: "subscription required")
        }
        if lowercasedMessage.contains("accepting terms") || lowercasedMessage.contains("termspage") {
            return AppleProtocolError(status: .conflict, message: message)
        }
        if lowercasedMessage.contains("unsupported store identifier") {
            return AppleProtocolError(status: .badRequest, message: message)
        }

        return AppleProtocolError(message: message)
    }

    private static func failureCode(in message: String) -> String? {
        guard let range = message.range(of: "failureType: ") else {
            return nil
        }

        let suffix = message[range.upperBound...]
        let digits = suffix.prefix { $0.isNumber }
        return digits.isEmpty ? nil : String(digits)
    }
}

private final class CompatibilityMinimumOSCache {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func value(for key: String, loader: () throws -> String) rethrows -> String {
        lock.lock()
        let cached = values[key]
        lock.unlock()
        if let cached {
            return cached
        }

        let loaded = try loader()
        lock.lock()
        values[key] = loaded
        lock.unlock()
        return loaded
    }
}

/// ApplePackage keeps the device identifier in global configuration, so calls
/// are serialized here to preserve AssppWeb's per-account device identity.
private actor ApplePackageExecutor {
    func authenticate(
        email: String,
        password: String,
        code: String,
        cookies: [ApplePackage.Cookie],
        deviceIdentifier: String
    ) async throws -> ApplePackage.Account {
        ApplePackage.Configuration.deviceIdentifier = deviceIdentifier
        ApplePackage.APLogger.verbose = true
        ApplePackage.APLogger.logger.logLevel = .debug
        return try await ApplePackage.Authenticator.authenticate(
            email: email,
            password: password,
            code: code,
            cookies: cookies
        )
    }

    func purchase(
        account: ApplePackage.Account,
        app: ApplePackage.Software,
        deviceIdentifier: String
    ) async throws -> ApplePackage.Account {
        ApplePackage.Configuration.deviceIdentifier = deviceIdentifier
        var account = account
        try await ApplePackage.Purchase.purchase(account: &account, app: app)
        return account
    }

    func download(
        account: ApplePackage.Account,
        app: ApplePackage.Software,
        externalVersionId: String?,
        deviceIdentifier: String
    ) async throws -> (ApplePackage.Account, ApplePackage.DownloadOutput) {
        ApplePackage.Configuration.deviceIdentifier = deviceIdentifier
        var account = account
        let output = try await ApplePackage.Download.download(
            account: &account,
            app: app,
            externalVersionID: externalVersionId
        )
        return (account, output)
    }

    func listVersions(
        account: ApplePackage.Account,
        bundleIdentifier: String,
        deviceIdentifier: String
    ) async throws -> (ApplePackage.Account, [String]) {
        ApplePackage.Configuration.deviceIdentifier = deviceIdentifier
        var account = account
        let versions = try await ApplePackage.VersionFinder.list(
            account: &account,
            bundleIdentifier: bundleIdentifier
        )
        return (account, versions)
    }

    func versionMetadata(
        account: ApplePackage.Account,
        app: ApplePackage.Software,
        versionId: String,
        deviceIdentifier: String
    ) async throws -> (ApplePackage.Account, ApplePackage.VersionMetadata) {
        ApplePackage.Configuration.deviceIdentifier = deviceIdentifier
        var account = account
        let metadata = try await ApplePackage.VersionLookup.getVersionMetadata(
            account: &account,
            app: app,
            versionID: versionId
        )
        return (account, metadata)
    }
}

private extension AppleAccount {
    func applePackageAccount() -> ApplePackage.Account {
        ApplePackage.Account(
            email: email,
            password: password,
            appleId: appleId,
            store: normalizedStore,
            firstName: firstName,
            lastName: lastName,
            passwordToken: passwordToken,
            directoryServicesIdentifier: directoryServicesIdentifier,
            cookie: cookies.applePackageCookies(),
            pod: pod
        )
    }

    var normalizedStore: String {
        store.split(separator: "-", maxSplits: 1).first.map(String.init) ?? store
    }
}

private extension ApplePackage.Account {
    func webAccount(deviceIdentifier: String) -> AppleAccount {
        AppleAccount(
            email: email,
            password: password,
            appleId: appleId,
            store: store,
            firstName: firstName,
            lastName: lastName,
            passwordToken: passwordToken,
            directoryServicesIdentifier: directoryServicesIdentifier,
            cookies: cookie.webCookies(),
            deviceIdentifier: deviceIdentifier,
            pod: pod
        )
    }
}

private extension WebCookie {
    func applePackageCookie() -> ApplePackage.Cookie {
        ApplePackage.Cookie(
            name: name,
            value: value,
            path: path,
            domain: domain,
            expiresAt: expiresAt,
            httpOnly: httpOnly,
            secure: secure
        )
    }
}

private extension ApplePackage.Cookie {
    func webCookie() -> WebCookie {
        WebCookie(
            name: name,
            value: value,
            path: path.isEmpty ? "/" : path,
            domain: domain?.trimmingLeadingDot(),
            expiresAt: expiresAt,
            httpOnly: httpOnly,
            secure: secure
        )
    }
}

private extension Array where Element == WebCookie {
    func applePackageCookies() -> [ApplePackage.Cookie] {
        map { $0.applePackageCookie() }
    }
}

private extension Array where Element == ApplePackage.Cookie {
    func webCookies() -> [WebCookie] {
        map { $0.webCookie() }
    }
}

private extension Software {
    func applePackageSoftware() -> ApplePackage.Software {
        var software = ApplePackage.Software(
            id: id,
            bundleID: bundleID,
            name: name,
            version: version,
            price: price,
            artistName: artistName,
            sellerName: sellerName,
            description: description,
            averageUserRating: averageUserRating,
            userRatingCount: Int(userRatingCount),
            artworkUrl: artworkUrl,
            screenshotUrls: screenshotUrls,
            minimumOsVersion: minimumOsVersion,
            fileSizeBytes: fileSizeBytes,
            releaseDate: releaseDate,
            formattedPrice: formattedPrice,
            primaryGenreName: primaryGenreName
        )
        software.releaseNotes = releaseNotes
        return software
    }
}

private extension ApplePackage.DownloadOutput {
    func webDownloadOutput() -> AppleDownloadOutput {
        let encodedMetadata = iTunesMetadata.base64EncodedString()
        return AppleDownloadOutput(
            downloadURL: downloadURL,
            sinfs: sinfs.map { Sinf(id: $0.id, sinf: $0.sinf.base64EncodedString()) },
            bundleShortVersionString: bundleShortVersionString,
            bundleVersion: bundleVersion,
            iTunesMetadata: encodedMetadata,
            minimumOSVersion: IPACompatibilityInspector.minimumOSVersion(
                inMetadataBase64: encodedMetadata
            )
        )
    }
}

private extension ApplePackage.VersionMetadata {
    func webVersionMetadata() -> VersionMetadata {
        VersionMetadata(
            displayVersion: displayVersion,
            releaseDate: ISO8601DateFormatter().string(from: releaseDate)
        )
    }
}

private extension String {
    func trimmingLeadingDot() -> String {
        hasPrefix(".") ? String(dropFirst()) : self
    }
}
