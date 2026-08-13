import Foundation

enum AppleAccountCollectionStore {
    static func accountsURL(config: WebConfig) -> URL {
        config.dataDirectory
            .appendingPathComponent("accounts", isDirectory: true)
            .appendingPathComponent("all.json")
    }

    static func replaceAccounts(_ accounts: [AppleAccount], config: WebConfig) throws -> [AppleAccount] {
        var seenEmails = Set<String>()
        let uniqueAccounts = accounts.filter { account in
            let email = account.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard email.isEmpty == false, seenEmails.contains(email) == false else {
                return false
            }
            seenEmails.insert(email)
            return true
        }
        let url = accountsURL(config: config)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(uniqueAccounts)
        try data.write(to: url, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return uniqueAccounts
    }

    static func readAccounts(config: WebConfig) throws -> [AppleAccount] {
        let url = accountsURL(config: config)
        if fileExists(url.path) {
            let accounts = try JSONDecoder().decode([AppleAccount].self, from: Data(contentsOf: url))
            if accounts.isEmpty == false {
                return accounts
            }
        }
        return [try DefaultAppleAccountStore.readAccount(config: config).account]
    }
}
