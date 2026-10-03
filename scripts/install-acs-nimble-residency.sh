#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
user_bin=${HOME:?HOME must be set}/.local/bin
user_units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

install -D -m 0755 "$repo_root/scripts/acs-nimble-residency.py" "$user_bin/acs-nimble-residency.py"
install -D -m 0644 "$repo_root/systemd/user/acs-nimble-residency.service" "$user_units/acs-nimble-residency.service"

if [ -f "$user_units/acs-nimble-residency.timer" ]; then
  if systemctl --user is-enabled --quiet acs-nimble-residency.timer; then
    systemctl --user disable --now acs-nimble-residency.timer
  elif systemctl --user is-active --quiet acs-nimble-residency.timer; then
    systemctl --user stop acs-nimble-residency.timer
  fi
  rm -f "$user_units/acs-nimble-residency.timer"
fi
if systemctl --user is-active --quiet acs-nimble-residency.service; then
  systemctl --user stop acs-nimble-residency.service
fi
systemctl --user daemon-reload
systemctl --user enable --now acs-nimble-residency.service
