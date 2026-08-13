#!/bin/sh
#
# RootHide-safe AppSync removal hook. The installed tweak payload owns the
# actual injection; restarting installd is sufficient after removal.

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
