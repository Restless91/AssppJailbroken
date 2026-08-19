SHELL := /bin/zsh

DEVICE_HOST ?=
DEVICE_VARIANT ?= iphone15
THEOS ?= $(HOME)/theos

RELEASE_MANIFEST_TOOL := scripts/release-manifest.mjs
RELEASE_PROFILE_ENV := $(shell node "$(RELEASE_MANIFEST_TOOL)" env "$(DEVICE_VARIANT)")

ifeq ($(strip $(RELEASE_PROFILE_ENV)),)
$(error Unable to load release profile '$(DEVICE_VARIANT)' from $(RELEASE_MANIFEST_TOOL))
endif

manifest_value = $(patsubst $(1)=%,%,$(filter $(1)=%,$(RELEASE_PROFILE_ENV)))
RELEASE_VERSION := $(call manifest_value,RELEASE_VERSION)
DEVICE_PROFILE := $(call manifest_value,DEVICE_PROFILE)
DEB_ARCHITECTURE := $(call manifest_value,DEB_ARCHITECTURE)
MIN_IOS := $(call manifest_value,MIN_IOS)

PACKAGE_BASENAME := wiki.qaq.unfaird_$(RELEASE_VERSION)_$(DEVICE_VARIANT)_$(DEB_ARCHITECTURE).deb
PACKAGE_PATH := release/$(PACKAGE_BASENAME)
VERSIONED_PACKAGE_PATH = release/wiki.qaq.unfaird_$(1)_$(DEVICE_VARIANT)_$(DEB_ARCHITECTURE).deb
PACKAGE_GLOB := release/wiki.qaq.unfaird_*_$(DEVICE_VARIANT)_$(DEB_ARCHITECTURE).deb
BACKEND_PACKAGE_GLOB := backend-swift/debs/wiki.qaq.unfaird_$(RELEASE_VERSION)*_$(DEB_ARCHITECTURE).deb
TAURINE_RUNTIME_RUNNER ?= $(CURDIR)/backend-swift/vendor/taurine/bootstrap/UnfairRuntimeRunner
TAURINE_RUNTIME_DUMPER ?= $(CURDIR)/backend-swift/vendor/taurine/bootstrap/UnfairRuntimeDumper.dylib

.PHONY: build package package-iphone8 package-iphone11 package-iphone15 audit install install-version test clean-package list-releases show-profile

show-profile:
	@echo "version=$(RELEASE_VERSION) variant=$(DEVICE_VARIANT) profile=$(DEVICE_PROFILE) debArchitecture=$(DEB_ARCHITECTURE) minIOS=$(MIN_IOS)"
	@echo "package=$(PACKAGE_PATH)"

build:
	@set -euo pipefail; \
	node "$(RELEASE_MANIFEST_TOOL)" validate; \
	scripts/prepare-applepackage-dependency.sh --min-ios "$(MIN_IOS)"; \
	$(MAKE) -C backend-swift package \
		FINALPACKAGE=1 \
		THEOS="$(THEOS)" \
		ASSPPWEB_DIR=.. \
		DEVICE_VARIANT="$(DEVICE_VARIANT)" \
		TAURINE_RUNTIME_RUNNER="$(TAURINE_RUNTIME_RUNNER)" \
		TAURINE_RUNTIME_DUMPER="$(TAURINE_RUNTIME_DUMPER)"; \
	source_deb="$$(ls -t $(BACKEND_PACKAGE_GLOB) 2>/dev/null | head -n 1)"; \
	if [[ -z "$$source_deb" || ! -f "$$source_deb" ]]; then echo "built DEB not found: $(BACKEND_PACKAGE_GLOB)" >&2; exit 1; fi; \
	mkdir -p release; \
	cp "$$source_deb" "$(PACKAGE_PATH)"; \
	scripts/audit-deb.sh --variant "$(DEVICE_VARIANT)" "$(PACKAGE_PATH)"; \
	shasum -a 256 "$(PACKAGE_PATH)" > "$(PACKAGE_PATH).sha256"; \
	echo "$(PACKAGE_PATH)"

package: build

package-iphone8:
	@$(MAKE) build DEVICE_VARIANT=iphone8

package-iphone11:
	@$(MAKE) build DEVICE_VARIANT=iphone11

package-iphone15:
	@$(MAKE) build DEVICE_VARIANT=iphone15

audit:
	@set -euo pipefail; \
	deb="$(DEB)"; \
	if [[ -z "$$deb" ]]; then deb="$(PACKAGE_PATH)"; fi; \
	scripts/audit-deb.sh --variant "$(DEVICE_VARIANT)" "$$deb"

test:
	node --test scripts/test-release-manifest.mjs scripts/test-audit-deb.mjs
	cd backend-swift && swift test
	cd frontend && npm test

install: build
	@set -euo pipefail; \
	host="$(DEVICE_HOST)"; \
	device_ip="$(THEOS_DEVICE_IP)"; \
	device_user="$(THEOS_DEVICE_USER)"; \
	device_port="$(THEOS_DEVICE_PORT)"; \
	if [[ -z "$$device_user" ]]; then device_user="root"; fi; \
	if [[ -z "$$host" && -n "$$device_ip" ]]; then \
		if [[ "$$device_ip" == *@* ]]; then host="$$device_ip"; else host="$${device_user}@$$device_ip"; fi; \
	fi; \
	if [[ -z "$$host" ]]; then echo "DEVICE_HOST or THEOS_DEVICE_IP is required" >&2; exit 1; fi; \
	scp_args=(); ssh_args=(); \
	if [[ -n "$$device_port" ]]; then scp_args=(-P "$$device_port"); ssh_args=(-p "$$device_port"); fi; \
	remote="/var/tmp/$(PACKAGE_BASENAME)"; \
	scp "$${scp_args[@]}" "$(PACKAGE_PATH)" "$$host:$$remote"; \
	ssh "$${ssh_args[@]}" "$$host" "apt install -y '$$remote'"; \
	health_host="$${host#*@}"; \
	if [[ "$$health_host" == \[*\]* ]]; then health_host="$${health_host#\[}"; health_host="$${health_host%\]}"; fi; \
	if [[ "$$health_host" == *:* ]]; then health_host="[$$health_host]"; fi; \
	curl -fsS "http://$$health_host:8080/health"

# Example: make install-version VERSION=0.1.16 DEVICE_VARIANT=iphone11 DEVICE_HOST=root@192.168.1.122
install-version:
	@set -euo pipefail; \
	if [[ -z "$(VERSION)" ]]; then echo "VERSION is required" >&2; exit 1; fi; \
	deb="$(call VERSIONED_PACKAGE_PATH,$(VERSION))"; \
	if [[ ! -f "$$deb" ]]; then echo "release not found for $(DEVICE_VARIANT): $$deb" >&2; exit 1; fi; \
	scripts/audit-deb.sh --variant "$(DEVICE_VARIANT)" "$$deb"; \
	host="$(DEVICE_HOST)"; \
	device_ip="$(THEOS_DEVICE_IP)"; \
	device_user="$(THEOS_DEVICE_USER)"; \
	device_port="$(THEOS_DEVICE_PORT)"; \
	if [[ -z "$$device_user" ]]; then device_user="root"; fi; \
	if [[ -z "$$host" && -n "$$device_ip" ]]; then \
		if [[ "$$device_ip" == *@* ]]; then host="$$device_ip"; else host="$${device_user}@$$device_ip"; fi; \
	fi; \
	if [[ -z "$$host" ]]; then echo "DEVICE_HOST or THEOS_DEVICE_IP is required" >&2; exit 1; fi; \
	scp_args=(); ssh_args=(); \
	if [[ -n "$$device_port" ]]; then scp_args=(-P "$$device_port"); ssh_args=(-p "$$device_port"); fi; \
	remote="/var/tmp/$${deb:t}"; \
	scp "$${scp_args[@]}" "$$deb" "$$host:$$remote"; \
	ssh "$${ssh_args[@]}" "$$host" "apt install -y --allow-downgrades '$$remote'"

list-releases:
	@setopt null_glob; releases=($(PACKAGE_GLOB)); \
	if (( $${#releases[@]} == 0 )); then echo "No local releases for $(DEVICE_VARIANT) ($(DEB_ARCHITECTURE))"; else printf '%s\n' "$${releases[@]}"; fi

clean-package:
	rm -rf backend-swift/.theos backend-swift/.build/ios-release
	@echo "Preserved versioned release packages in release/"
