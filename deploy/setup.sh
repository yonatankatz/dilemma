#!/usr/bin/env bash
# Idempotent server setup + deploy. Runs on the Oracle VM (Ubuntu) as root.
#   sudo PUBLIC_HOST=<ip> bash setup.sh
# Expects the repo's app/ and deploy/ folders next to this script's parent dir.
# Expects /etc/dilemma.env to exist (written by the CI workflow) with ADMIN_PASSWORD=...
set -euo pipefail

RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/dilemma/app
DATA_DIR=/var/lib/dilemma
PUBLIC_HOST="${PUBLIC_HOST:?PUBLIC_HOST (server public IP) is required}"
# Free HTTPS hostname that resolves to the server IP, e.g. 1-2-3-4.sslip.io
SSLIP_DOMAIN="${PUBLIC_HOST//./-}.sslip.io"
# Optional custom domain (its DNS A record must point at PUBLIC_HOST), e.g. dilemma.example.com
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"
DOMAIN="${CUSTOM_DOMAIN:-$SSLIP_DOMAIN}"
SITE_ADDRESSES="$SSLIP_DOMAIN${CUSTOM_DOMAIN:+, $CUSTOM_DOMAIN}"

export DEBIAN_FRONTEND=noninteractive

log() { echo "==> $*"; }

# ---------- packages ----------
need_update=1
apt_update_once() { if [ "$need_update" = 1 ]; then apt-get update -q; need_update=0; fi; }

if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js"
  apt_update_once
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy"
  apt_update_once
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

if ! dpkg -s iptables-persistent >/dev/null 2>&1; then
  apt_update_once
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
  apt-get install -y -q iptables-persistent
fi

# ---------- firewall (Oracle Ubuntu images block everything except 22 in iptables) ----------
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    log "Opening port $port"
    iptables -I INPUT 5 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
  fi
done
netfilter-persistent save >/dev/null

# ---------- app ----------
id dilemma >/dev/null 2>&1 || useradd --system --home /opt/dilemma --shell /usr/sbin/nologin dilemma
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R dilemma:dilemma "$DATA_DIR"
rm -f "$DATA_DIR/votes.json"  # legacy file from the first 1/2 voting version
log "Copying app to $APP_DIR"
rm -rf "$APP_DIR.new"
cp -r "$RELEASE_DIR/app" "$APP_DIR.new"
rm -rf "$APP_DIR.new/data"
rm -rf "$APP_DIR" && mv "$APP_DIR.new" "$APP_DIR"

if [ ! -f /etc/dilemma.env ]; then
  echo "WARNING: /etc/dilemma.env missing — admin screen will be disabled" >&2
  touch /etc/dilemma.env
fi
chmod 600 /etc/dilemma.env

cat > /etc/systemd/system/dilemma.service <<EOF
[Unit]
Description=Dilemma voting app
After=network.target

[Service]
User=dilemma
Group=dilemma
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/dilemma.env
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# ---------- reverse proxy ----------
cat > /etc/caddy/Caddyfile <<EOF
# HTTPS via Let's Encrypt (sslip.io hostname + optional custom domain).
# No "encode gzip": compression can buffer the Server-Sent Events stream.
$SITE_ADDRESSES {
	reverse_proxy 127.0.0.1:3000
}

# Plain HTTP when browsing by raw IP
http://$PUBLIC_HOST {
	reverse_proxy 127.0.0.1:3000
}
EOF

systemctl daemon-reload
systemctl enable --now dilemma >/dev/null
systemctl restart dilemma
systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

# ---------- health check ----------
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null; then
    log "Deployed OK"
    echo "Vote page : https://$DOMAIN/"
    echo "Admin page: https://$DOMAIN/admin"
    exit 0
  fi
  sleep 1
done
echo "App failed health check" >&2
journalctl -u dilemma -n 50 --no-pager >&2
exit 1
