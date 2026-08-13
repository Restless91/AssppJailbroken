#!/bin/sh
#
# RootHide-safe AppSync maintainer script.
#
# RootHide-patched Mach-O maintainer scripts resolve @loader_path from
# /Library/dpkg/info after dpkg moves them there, so their .jbroot link no
# longer points at libroothide. Keep this script dependency-free and restart
# only installd so AppSync is picked up without rebooting the device.

plist=/System/Library/LaunchDaemons/com.apple.mobile.installd.plist

if [ -x /bin/launchctl ]; then
    launchctl_bin=/bin/launchctl
elif [ -x /usr/bin/launchctl ]; then
    launchctl_bin=/usr/bin/launchctl
else
    exit 0
fi

"$launchctl_bin" unload "$plist" >/dev/null 2>&1 || true
"$launchctl_bin" load "$plist" >/dev/null 2>&1 || true

exit 0
