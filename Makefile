SHELL := /bin/zsh

DEVICE_HOST ?=
# Dopamine rootless on iPhone 15 is arm64e.  Keep deployment pointed at the
# rootless arm64e artifact; otherwise `make install` can silently select an
# older arm64 package left in the debs directory.
PACKAGE_GLOB := backend-swift/debs/wiki.qaq.unfaird_*_iphoneos-arm64e.deb

.PHONY: build package package-rootless package-roothide package-rootful install test clean-package

build:
	$(MAKE) -C backend-swift package FINALPACKAGE=1 ASSPPWEB_DIR=.. DEVICE_HOST="$(DEVICE_HOST)"
	@ls -t $(PACKAGE_GLOB) | head -n 1

package: build

package-rootless: build

package-roothide:
	./scripts/package-iphone-roothide.sh

package-rootful:
	./scripts/package-iphone-rootful.sh

test:
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
	scp_args=(); \
	ssh_args=(); \
	if [[ -n "$$device_port" ]]; then scp_args=(-P "$$device_port"); ssh_args=(-p "$$device_port"); fi; \
	deb=$$(ls -t $(PACKAGE_GLOB) | head -n 1); \
	remote="/var/tmp/$${deb:t}"; \
	scp "$${scp_args[@]}" "$$deb" "$$host:$$remote"; \
	ssh "$${ssh_args[@]}" "$$host" "apt install -y '$$remote'"; \
	health_host="$${host#*@}"; \
	if [[ "$$health_host" == \[*\]* ]]; then health_host="$${health_host#\[}"; health_host="$${health_host%\]}"; fi; \
	if [[ "$$health_host" == *:* ]]; then health_host="[$$health_host]"; fi; \
	curl -fsS "http://$$health_host:8080/health"

clean-package:
	rm -rf backend-swift/debs backend-swift/.theos backend-swift/.build/ios-release
