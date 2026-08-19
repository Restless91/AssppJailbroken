SHELL := /bin/bash

DEVICE_HOST ?=
DEVICE_VARIANT ?= iphone15
THEOS ?= $(HOME)/theos
THEOS_PACKAGE_DIR_NAME ?= debs
RELEASE_MANIFEST_TOOL := ../scripts/release-manifest.mjs
REQUESTED_DEVICE_PROFILE := $(strip $(DEVICE_PROFILE))
RELEASE_PROFILE_ENV := $(shell node "$(RELEASE_MANIFEST_TOOL)" env "$(DEVICE_VARIANT)")

ifeq ($(strip $(RELEASE_PROFILE_ENV)),)
$(error Unable to load release profile '$(DEVICE_VARIANT)' from $(RELEASE_MANIFEST_TOOL))
endif

manifest_value = $(patsubst $(1)=%,%,$(filter $(1)=%,$(RELEASE_PROFILE_ENV)))
RELEASE_VERSION := $(call manifest_value,RELEASE_VERSION)
MANIFEST_DEVICE_PROFILE := $(call manifest_value,DEVICE_PROFILE)
DEVICE_ARCHITECTURE := $(call manifest_value,DEVICE_ARCHITECTURE)
DEB_ARCHITECTURE := $(call manifest_value,DEB_ARCHITECTURE)
MACH_O_ARCH := $(call manifest_value,MACH_O_ARCH)
SWIFT_TARGET := $(call manifest_value,SWIFT_TARGET)
MIN_IOS := $(call manifest_value,MIN_IOS)

ifneq ($(REQUESTED_DEVICE_PROFILE),)
ifneq ($(REQUESTED_DEVICE_PROFILE),$(MANIFEST_DEVICE_PROFILE))
$(error DEVICE_PROFILE=$(REQUESTED_DEVICE_PROFILE) does not match $(DEVICE_VARIANT) manifest profile $(MANIFEST_DEVICE_PROFILE))
endif
endif

override DEVICE_PROFILE := $(MANIFEST_DEVICE_PROFILE)
override THEOS_PACKAGE_ARCH := $(DEB_ARCHITECTURE)
ARCHS := $(MACH_O_ARCH)
TARGET := iphone:clang:latest:$(MIN_IOS)
IOS_TARGET := $(SWIFT_TARGET)

ifeq ($(DEVICE_PROFILE),rootless)
override THEOS_PACKAGE_SCHEME := rootless
else ifeq ($(DEVICE_PROFILE),taurine)
override THEOS_PACKAGE_SCHEME :=
else
$(error Unsupported release profile layout: $(DEVICE_PROFILE))
endif

export RELEASE_VERSION DEVICE_VARIANT DEVICE_PROFILE
export DEVICE_ARCHITECTURE DEB_ARCHITECTURE MACH_O_ARCH SWIFT_TARGET IOS_TARGET MIN_IOS
export THEOS_PACKAGE_SCHEME THEOS_PACKAGE_ARCH

PACKAGE_NAME := wiki.qaq.unfaird
EXECUTABLE_NAME := UnfairDaemon
BUILD_INFO := Sources/UnfairDaemonCore/BuildInfo.swift
IOS_BUILD_DIR := .build/ios-release
ASSPPWEB_DIR ?= ..
ASSPPWEB_FRONTEND_DIST := $(ASSPPWEB_DIR)/frontend/dist
IPHONEOS_SDK_PATH := $(shell xcrun --sdk iphoneos --show-sdk-path 2>/dev/null)
LDID ?= $(shell command -v ldid 2>/dev/null)
ifeq ($(LDID),)
LDID := $(THEOS)/bin/ldid
endif
SWIFT_STDLIB_TOOL ?= $(shell xcrun --find swift-stdlib-tool 2>/dev/null)
SWIFT_55_IPHONEOS_LIB_DIR ?= $(shell dirname "$$(xcrun --find swiftc 2>/dev/null)")/../lib/swift-5.5/iphoneos
TAURINE_RUNTIME_RUNNER ?=
TAURINE_RUNTIME_DUMPER ?=
PROFILE_CONTROL := packaging/control.$(DEVICE_VARIANT)

IOS_SWIFT_FLAGS := --triple $(IOS_TARGET) --sdk "$(IPHONEOS_SDK_PATH)"

.PHONY: all build release ios-release prepare-profile-dependencies assppweb-frontend mac-install mac-uninstall generate-build-info validate-profile-control clean-package

all:: ios-release

build:
	@set -euo pipefail; \
	original="$$(mktemp)"; \
	cp "$(BUILD_INFO)" "$$original"; \
	package_original="$$(mktemp)"; cp Package.swift "$$package_original"; \
	unfair_original="$$(mktemp)"; cp ../../unfair/Package.swift "$$unfair_original"; \
	if [[ "$(MIN_IOS)" == "14.0" ]]; then perl -0pi -e 's/\\.iOS\\(\\.v15\\)/.iOS(.v14)/' Package.swift ../../unfair/Package.swift; else perl -0pi -e 's/\\.iOS\\(\\.v14\\)/.iOS(.v15)/' Package.swift ../../unfair/Package.swift; fi; \
	restore() { cp "$$original" "$(BUILD_INFO)"; cp "$$package_original" Package.swift; cp "$$unfair_original" ../../unfair/Package.swift; rm -f "$$original" "$$package_original" "$$unfair_original"; }; \
	trap restore EXIT; \
	$(MAKE) generate-build-info; \
	swift build

	release:
		@set -euo pipefail; \
		original="$$(mktemp)"; \
		cp "$(BUILD_INFO)" "$$original"; \
		package_original="$$(mktemp)"; cp Package.swift "$$package_original"; \
	if [[ "$(MIN_IOS)" == "14.0" ]]; then perl -0pi -e 's/\.iOS\(\.v15\)/.iOS(.v14)/' Package.swift; else perl -0pi -e 's/\.iOS\(\.v14\)/.iOS(.v15)/' Package.swift; fi; \
		restore() { cp "$$original" "$(BUILD_INFO)"; cp "$$package_original" Package.swift; rm -f "$$original" "$$package_original"; }; \
	trap restore EXIT; \
	$(MAKE) generate-build-info; \
	swift build -c release

mac-install: release
	bash deploy/install-launchdaemon.sh

mac-uninstall:
	bash deploy/uninstall-launchdaemon.sh

prepare-profile-dependencies:
	bash ../scripts/prepare-applepackage-dependency.sh --backend-dir . --min-ios "$(MIN_IOS)"

ios-release: prepare-profile-dependencies
	@set -euo pipefail; \
	if [[ -z "$(IPHONEOS_SDK_PATH)" ]]; then echo "iphoneos SDK missing" >&2; exit 1; fi; \
	if [[ ! -x "$(LDID)" ]]; then echo "ldid missing: $(LDID)" >&2; exit 1; fi; \
	if [[ ! -x "$(SWIFT_STDLIB_TOOL)" ]]; then echo "swift-stdlib-tool missing: $(SWIFT_STDLIB_TOOL)" >&2; exit 1; fi; \
	original="$$(mktemp)"; \
	cp "$(BUILD_INFO)" "$$original"; \
	package_original="$$(mktemp)"; cp Package.swift "$$package_original"; \
	unfair_original="$$(mktemp)"; cp ../../unfair/Package.swift "$$unfair_original"; \
	if [[ "$(MIN_IOS)" == "14.0" ]]; then perl -0pi -e 's/\.iOS\(\.v15\)/.iOS(.v14)/' Package.swift ../../unfair/Package.swift; else perl -0pi -e 's/\.iOS\(\.v14\)/.iOS(.v15)/' Package.swift ../../unfair/Package.swift; fi; \
	restore() { cp "$$original" "$(BUILD_INFO)"; cp "$$package_original" Package.swift; cp "$$unfair_original" ../../unfair/Package.swift; rm -f "$$original" "$$package_original" "$$unfair_original"; }; \
	trap restore EXIT; \
	$(MAKE) generate-build-info; \
	if [[ "$(MIN_IOS)" == "14.0" ]]; then swift package clean; fi; \
	bin_dir="$$(swift build -c release --product "$(EXECUTABLE_NAME)" --show-bin-path $(IOS_SWIFT_FLAGS))"; \
	swift build -c release --product "$(EXECUTABLE_NAME)" $(IOS_SWIFT_FLAGS); \
	rm -rf "$(IOS_BUILD_DIR)"; \
	install -d "$(IOS_BUILD_DIR)"; \
	install -m 0755 "$$bin_dir/$(EXECUTABLE_NAME)" "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)"; \
	"$(SWIFT_STDLIB_TOOL)" --copy --scan-executable "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)" --destination "$(IOS_BUILD_DIR)" --platform iphoneos; \
	"$(LDID)" -Spackaging/unfaird.entitlements "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)"; \
	shopt -s nullglob; \
	for dylib in "$(IOS_BUILD_DIR)"/libswift*.dylib; do "$(LDID)" -S "$$dylib"; done

assppweb-frontend:
	@set -euo pipefail; \
	if [[ ! -d "$(ASSPPWEB_DIR)" ]]; then echo "AssppWeb directory missing: $(ASSPPWEB_DIR)" >&2; exit 1; fi; \
	cd "$(ASSPPWEB_DIR)/frontend"; \
	npm ci; \
	npm run build; \
	cd - >/dev/null; \
	test -f "$(ASSPPWEB_FRONTEND_DIST)/index.html"

generate-build-info:
	@commit="$$(git rev-parse --short=12 HEAD 2>/dev/null || awk -F'\"' '/static let commit/ { print $$2; exit }' "$(BUILD_INFO)" 2>/dev/null || echo unknown)"; \
	if [[ -z "$$commit" ]]; then commit="unknown"; fi; \
	timestamp="$$(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
	printf 'enum BuildInfo {\n    static let commit = "%s"\n    static let timestamp = "%s"\n    static let version = "%s"\n    static let variant = "%s"\n    static let profile = "%s"\n    static let deviceArchitecture = "%s"\n    static let machOArch = "%s"\n    static let debArchitecture = "%s"\n    static let minIOS = "%s"\n    static let swiftTarget = "%s"\n}\n' \
		"$$commit" "$$timestamp" "$(RELEASE_VERSION)" "$(DEVICE_VARIANT)" "$(DEVICE_PROFILE)" "$(DEVICE_ARCHITECTURE)" \
		"$(MACH_O_ARCH)" "$(DEB_ARCHITECTURE)" "$(MIN_IOS)" "$(SWIFT_TARGET)" > "$(BUILD_INFO)"

validate-profile-control:
	@set -euo pipefail; \
	if [[ ! -f "$(PROFILE_CONTROL)" ]]; then echo "unknown DEVICE_VARIANT: $(DEVICE_VARIANT)" >&2; exit 1; fi; \
	control_version="$$(awk '/^Version:/ { print $$2; exit }' "$(PROFILE_CONTROL)")"; \
	control_architecture="$$(awk '/^Architecture:/ { print $$2; exit }' "$(PROFILE_CONTROL)")"; \
	if [[ "$$control_version" != "$(RELEASE_VERSION)" ]]; then echo "$(PROFILE_CONTROL) version $$control_version does not match release manifest $(RELEASE_VERSION)" >&2; exit 1; fi; \
	if [[ "$$control_architecture" != "$(DEB_ARCHITECTURE)" ]]; then echo "$(PROFILE_CONTROL) architecture $$control_architecture does not match release manifest $(DEB_ARCHITECTURE)" >&2; exit 1; fi

clean-package:
	rm -rf "$(IOS_BUILD_DIR)" ".theos"
	@echo "Preserved versioned release packages in $(THEOS_PACKAGE_DIR_NAME)"

THEOS_GOALS := package stage install show uninstall before-stage internal-stage after-stage before-package internal-package after-package
ifneq ($(filter $(THEOS_GOALS),$(MAKECMDGOALS)),)
include $(THEOS)/makefiles/common.mk
include $(THEOS_MAKE_PATH)/rules.mk

after-stage:: validate-profile-control ios-release assppweb-frontend
	@set -euo pipefail; \
	prefix="$(THEOS_PACKAGE_INSTALL_PREFIX)"; \
	package_runner=""; \
	if [[ -n "$$prefix" ]]; then \
		dyld_library_path="$$prefix/usr/lib:$$prefix/basebin:$$prefix/usr/lib/swift:/usr/lib:/usr/lib/swift:/basebin"; \
		launchd_path="$$prefix/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin"; \
	else \
		dyld_library_path="/usr/lib:/usr/lib/swift:/basebin"; \
		launchd_path="/usr/bin:/bin:/usr/sbin:/sbin"; \
	fi; \
	install -d "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird"; \
	install -m 0755 "$(IOS_BUILD_DIR)/$(EXECUTABLE_NAME)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/$(EXECUTABLE_NAME)"; \
	if [[ "$(DEVICE_PROFILE)" == "taurine" ]]; then \
		if [[ "$(DEVICE_PROFILE)" == "taurine" && ! -x "$(TAURINE_RUNTIME_RUNNER)" ]]; then echo "Taurine runtime runner missing or not executable: $(TAURINE_RUNTIME_RUNNER)" >&2; exit 1; fi; \
		if [[ ! -f "$(TAURINE_RUNTIME_DUMPER)" ]]; then echo "Taurine runtime dumper missing: $(TAURINE_RUNTIME_DUMPER)" >&2; exit 1; fi; \
		if [[ "$(DEVICE_PROFILE)" == "taurine" ]]; then package_runner="/usr/local/lib/unfaird/UnfairRuntimeRunner"; install -m 0755 "$(TAURINE_RUNTIME_RUNNER)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeRunner"; "$(LDID)" -Spackaging/unfaird.entitlements "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeRunner"; fi; \
		install -m 0755 "$(TAURINE_RUNTIME_DUMPER)" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeDumper.dylib"; \
		"$(LDID)" -S "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/UnfairRuntimeDumper.dylib"; \
		install -m 0755 vendor/taurine/fouldecrypt.kernrw "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/fouldecrypt.kernrw"; \
		install -m 0755 vendor/taurine/libkernrw.0.dylib "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/libkernrw.0.dylib"; \
		if [[ ! -f "$(SWIFT_55_IPHONEOS_LIB_DIR)/libswift_Concurrency.dylib" ]]; then \
			echo "Swift 5.5 iPhoneOS concurrency runtime missing" >&2; exit 1; \
		fi; \
		install -d "$(THEOS_STAGING_DIR)/usr/lib/swift"; \
		install -m 0755 "$(SWIFT_55_IPHONEOS_LIB_DIR)/libswift_Concurrency.dylib" "$(THEOS_STAGING_DIR)/usr/lib/swift/libswift_Concurrency.dylib"; \
		"$(LDID)" -S "$(THEOS_STAGING_DIR)/usr/lib/swift/libswift_Concurrency.dylib"; \
	fi; \
	shopt -s nullglob; \
	for dylib in "$(IOS_BUILD_DIR)"/libswift*.dylib; do install -m 0755 "$$dylib" "$(THEOS_STAGING_DIR)/usr/local/lib/unfaird/"; done; \
	install -d "$(THEOS_STAGING_DIR)/usr/bin" "$(THEOS_STAGING_DIR)/usr/share/assppweb/public"; \
	rsync -a --delete "$(ASSPPWEB_FRONTEND_DIST)/" "$(THEOS_STAGING_DIR)/usr/share/assppweb/public/"; \
	install -d "$(THEOS_STAGING_DIR)/Library/LaunchDaemons"; \
	sed \
		-e "s|@INSTALL_PREFIX@|$$prefix|g" \
		-e "s|@DYLD_LIBRARY_PATH@|$$dyld_library_path|g" \
		-e "s|@LAUNCHD_PATH@|$$launchd_path|g" \
		-e "s|@PACKAGE_RUNNER@|$$package_runner|g" \
		packaging/wiki.qaq.unfaird.plist.in > "$(THEOS_STAGING_DIR)/Library/LaunchDaemons/$(PACKAGE_NAME).plist"; \
	chmod 0644 "$(THEOS_STAGING_DIR)/Library/LaunchDaemons/$(PACKAGE_NAME).plist"

before-package:: validate-profile-control
	@set -euo pipefail; \
	install -d "$(THEOS_STAGING_DIR)/DEBIAN"; \
	install -m 0644 "$(PROFILE_CONTROL)" "$(THEOS_STAGING_DIR)/DEBIAN/control"
endif
