#!/bin/bash

# Overrides electron-builder's default after-install.tpl
# (app-builder-lib/templates/linux/after-install.tpl). Identical to it except
# for the chrome-sandbox decision below, which upstream gets wrong on Ubuntu
# 24.04 and every derivative.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Does Chromium need the SUID sandbox helper?
#
# Upstream decides this by running `unshare --user true`. That runs AS ROOT,
# because postinst does, and root can always create a user namespace. On Ubuntu
# 24.04+ unprivileged namespaces are blocked by
# kernel.apparmor_restrict_unprivileged_userns=1, so the probe succeeds, the
# SUID bit is NOT set, and the app then has neither the namespace sandbox nor
# the SUID fallback when a normal user launches it. Chromium aborts before a
# window is drawn.
#
# Reported from the field 2026-08-05: downloads fine, installs fine, never
# opens, while the same build was fine on Linux Mint. See electron/electron#41066
# and Chromium issue 333313925.
#
# So check the restriction directly. If it is on, the root probe is meaningless
# and we need the SUID helper regardless of what it said.
needs_suid=0
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
    needs_suid=1
elif ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    needs_suid=1
fi

if [ "$needs_suid" = "1" ]; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

# Residual case, deliberately not handled here: a machine that enables the
# restriction AFTER this package is installed keeps a non-SUID helper and will
# stop launching. Reinstalling fixes it. Handling it properly needs an AppArmor
# profile shipped in the package, which is the better long-term answer but a
# larger change than this.

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
