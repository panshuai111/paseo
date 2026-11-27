#!/bin/sh
# Only needed on Ubuntu systems that restrict unprivileged user namespaces.
set -eu
artifact_scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sudo install -d -m 755 /usr/local/libexec
sudo install -o root -g root -m 755 /usr/bin/bwrap /usr/local/libexec/paseo-artifacts-bwrap
sudo install -o root -g root -m 644 "$artifact_scripts/paseo-artifacts-bwrap.apparmor" /etc/apparmor.d/paseo-artifacts-bwrap
sudo apparmor_parser -r /etc/apparmor.d/paseo-artifacts-bwrap
/usr/local/libexec/paseo-artifacts-bwrap --unshare-all --ro-bind / / -- /usr/bin/true
