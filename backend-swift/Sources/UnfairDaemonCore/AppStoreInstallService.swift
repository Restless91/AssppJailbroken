import Foundation
import Darwin

/// Triggers App Store download + install using private StoreKitUI APIs,
/// bypassing the RootHide namespace issue entirely (App Store daemon handles it).
enum AppStoreInstallService {

    static func triggerPurchase(
        adamID: String,
        appExtVrsId: String = "0",
        logger: ((String) -> Void)? = nil
    ) async throws {
        logger?("AppStoreInstall: triggering purchase for adamId=\(adamID) versionId=\(appExtVrsId)")

        // Load StoreKitUI framework explicitly (unfaird is a daemon, no UI frameworks)
        dlopen("/System/Library/PrivateFrameworks/StoreKitUI.framework/StoreKitUI", RTLD_NOW)

        guard let centerClass = NSClassFromString("SKUIItemStateCenter") as? NSObject.Type,
              let itemClass = NSClassFromString("SKUIItem") as? NSObject.Type,
              let offerClass = NSClassFromString("SKUIItemOffer") as? NSObject.Type,
              let contextClass = NSClassFromString("SKUIClientContext") as? NSObject.Type
        else {
            throw NSError(domain: "AppStoreInstall", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "StoreKitUI classes not available"])
        }

        guard let center = centerClass.perform(NSSelectorFromString("defaultCenter"))?.takeUnretainedValue() as? NSObject else {
            throw NSError(domain: "AppStoreInstall", code: -2,
                userInfo: [NSLocalizedDescriptionKey: "SKUIItemStateCenter.defaultCenter failed"])
        }

        let pricingParameters = "pricingParameter"
        let installed = "0"
        let offerString: String
        if appExtVrsId == "0" {
            offerString = "productType=C&price=0&salableAdamId=\(adamID)&pricingParameters=\(pricingParameters)&clientBuyId=1&installed=\(installed)&trolled=1"
        } else {
            offerString = "productType=C&price=0&salableAdamId=\(adamID)&pricingParameters=\(pricingParameters)&appExtVrsId=\(appExtVrsId)&clientBuyId=1&installed=\(installed)&trolled=1"
        }
        logger?("AppStoreInstall: buyParams = \(offerString)")

        let offerDict: [String: Any] = ["buyParams": offerString]
        let itemDict: [String: Any] = ["_itemOffer": adamID]

        guard let offer = offerClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject,
              let offerInit = class_getInstanceMethod(offerClass, NSSelectorFromString("initWithLookupDictionary:")),
              let item = itemClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() as? NSObject,
              let itemInit = class_getInstanceMethod(itemClass, NSSelectorFromString("initWithLookupDictionary:"))
        else {
            throw NSError(domain: "AppStoreInstall", code: -3,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create SKUIItem/SKUIItemOffer"])
        }

        // Initialize offer and item with dictionaries
        typealias InitMethod = @convention(c) (NSObject, Selector, NSDictionary) -> NSObject
        let offerInitFn = unsafeBitCast(method_getImplementation(offerInit), to: InitMethod.self)
        let itemInitFn = unsafeBitCast(method_getImplementation(itemInit), to: InitMethod.self)

        _ = offerInitFn(offer, NSSelectorFromString("initWithLookupDictionary:"), offerDict as NSDictionary)
        _ = itemInitFn(item, NSSelectorFromString("initWithLookupDictionary:"), itemDict as NSDictionary)

        item.setValue(offer, forKey: "_itemOffer")
        item.setValue("iosSoftware", forKey: "_itemKindString")
        if appExtVrsId != "0" {
            item.setValue(Int(appExtVrsId) ?? 0, forKey: "_versionIdentifier")
        }

        let items = [item]

        // newPurchases = [center _newPurchasesWithItems:items]
        guard let newPurchases = center.perform(NSSelectorFromString("_newPurchasesWithItems:"), with: items)?.takeUnretainedValue() else {
            throw NSError(domain: "AppStoreInstall", code: -4,
                userInfo: [NSLocalizedDescriptionKey: "_newPurchasesWithItems failed"])
        }

        // context = [SKUIClientContext defaultContext]
        guard let context = contextClass.perform(NSSelectorFromString("defaultContext"))?.takeUnretainedValue() else {
            throw NSError(domain: "AppStoreInstall", code: -5,
                userInfo: [NSLocalizedDescriptionKey: "SKUIClientContext.defaultContext failed"])
        }

        // Trigger purchase
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let completion: @convention(block) (Any?) -> Void = { _ in
                logger?("AppStoreInstall: purchase completion called")
                continuation.resume()
            }

            let performSelector = NSSelectorFromString("_performPurchases:hasBundlePurchase:withClientContext:completionBlock:")
            let imp = center.method(for: performSelector)
            typealias PerformFn = @convention(c) (NSObject, Selector, Any, Bool, Any, @convention(block) (Any?) -> Void) -> Void
            let fn = unsafeBitCast(imp, to: PerformFn.self)
            fn(center, performSelector, newPurchases, false, context, completion)

            logger?("AppStoreInstall: _performPurchases dispatched")
        }
    }
}
