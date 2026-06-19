#!/bin/sh
# wormdrive provision — bootstrap a fresh Debian/Ubuntu VPS, run as root.
# Invoked by `make provision` (streamed over ssh), or by hand:
#   sh provision.sh --domain wormdrive.app --port 8787 --app-dir /opt/wormdrive
#
# Tuned for a small box (Njalla VPS 15: 1 core / 1.5 GB RAM / 15 GB disk):
#   - never builds here; `make deploy` ships prebuilt artifacts
#   - 1 GB swapfile as OOM headroom, swappiness 10
#   - Node heap capped at 256 MB, unit hard-capped at 512 MB
#   - journald capped at 100 MB so logs can't eat the disk
# Idempotent: every step is guarded or an atomic overwrite (tmp + rename).
set -eu

DOMAIN=wormdrive.app
PORT=8787
APP_DIR=/opt/wormdrive

while [ $# -gt 0 ]; do
	case $1 in
		--domain)    DOMAIN=$2;       shift 2 ;;
		--domain=*)  DOMAIN=${1#*=};  shift ;;
		--port)      PORT=$2;         shift 2 ;;
		--port=*)    PORT=${1#*=};    shift ;;
		--app-dir)   APP_DIR=$2;      shift 2 ;;
		--app-dir=*) APP_DIR=${1#*=}; shift ;;
		*) printf 'provision: unknown option: %s\n' "$1" >&2; exit 1 ;;
	esac
done

# Validate inputs before they are spliced into the Caddyfile / systemd unit
# (the by-hand path skips configure's guards, so re-do them here): an
# unsanitized --domain would inject directives into the Caddyfile heredoc.
case $DOMAIN in
	''|.*|*.|*[!a-zA-Z0-9.-]*) printf 'provision: invalid --domain: %s\n' "$DOMAIN" >&2; exit 1 ;;
esac
case $PORT in
	''|*[!0-9]*) printf 'provision: --port must be numeric: %s\n' "$PORT" >&2; exit 1 ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { printf 'provision: --port out of range: %s\n' "$PORT" >&2; exit 1; }
case $APP_DIR in
	/*) ;; *) printf 'provision: --app-dir must be an absolute path: %s\n' "$APP_DIR" >&2; exit 1 ;;
esac
case $APP_DIR in
	*[!a-zA-Z0-9._/-]*) printf 'provision: --app-dir has invalid characters: %s\n' "$APP_DIR" >&2; exit 1 ;;
esac

[ "$(id -u)" -eq 0 ] || { printf 'provision: must run as root\n' >&2; exit 1; }
command -v apt-get >/dev/null 2>&1 || {
	printf 'provision: apt-get not found — this script targets Debian/Ubuntu\n' >&2
	exit 1
}

say() { printf '\n==> %s\n' "$1"; }
# Atomic file install: write to tmp on the same filesystem, then rename.
put() { cat > "$1.tmp" && mv "$1.tmp" "$1"; }

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq --no-install-recommends ca-certificates curl rsync ufw caddy

say "node 22"
have=0
command -v node >/dev/null 2>&1 && have=$(node -p 'process.versions.node.split(".")[0]')
if [ "$have" -lt 20 ]; then
	# Download-then-run (not curl|bash): a failed download must fail the
	# step, not feed bash empty input that "succeeds".
	curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh
	bash /tmp/nodesource-setup.sh
	rm -f /tmp/nodesource-setup.sh
	apt-get install -yq nodejs
fi
have=$(node -p 'process.versions.node.split(".")[0]')
[ "$have" -ge 20 ] || { printf 'provision: node >=20 required, got %s\n' "$(node --version)" >&2; exit 1; }
node --version

say "swap (OOM headroom on a 1.5 GB box)"
if [ "$(awk '/SwapTotal/{print $2}' /proc/meminfo)" -eq 0 ]; then
	fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024
	chmod 600 /swapfile
	mkswap /swapfile
	if swapon /swapfile 2>/dev/null; then
		grep -q '^/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
	else
		# Container-virtualized hosts often forbid swapon at the kernel level.
		# Swap is OOM headroom, not a requirement -- the unit's MemoryHigh/
		# MemoryMax fences still apply. Continue without it.
		printf '  (host kernel refused swapon -- continuing without swap)\n'
		rm -f /swapfile
	fi
fi
# Swappiness tuning is independent of whether we just created the swapfile: a
# box that already had swap still needs it, so apply it unconditionally (keeps
# this step idempotent, as the header promises).
printf 'vm.swappiness = 10\n' | put /etc/sysctl.d/99-wormdrive.conf
sysctl -q -p /etc/sysctl.d/99-wormdrive.conf 2>/dev/null \
	|| printf '  (sysctl vm.swappiness not permitted -- skipping)\n'

say "journald cap (15 GB disk)"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' | put /etc/systemd/journald.conf.d/wormdrive.conf
systemctl restart systemd-journald

say "service user + app dir"
id -u wormdrive >/dev/null 2>&1 || useradd -r -d "$APP_DIR" -s /usr/sbin/nologin wormdrive
mkdir -p "$APP_DIR"
chown wormdrive: "$APP_DIR"

say "systemd unit"
put /etc/systemd/system/wormdrive.service <<UNIT
[Unit]
Description=wormdrive signaling + static server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wormdrive
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=/usr/bin/node server/signaling.mjs
Restart=always
RestartSec=2
LimitNOFILE=8192

# Resource fences for a 1.5 GB host sharing RAM with Caddy + kernel
MemoryHigh=384M
MemoryMax=512M

# Hardening — needs a socket and read access to \$APP_DIR, nothing else
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable wormdrive
# Re-provision while running: apply unit changes now; no-op if inactive.
systemctl try-restart wormdrive

say "caddy (TLS + reverse proxy)"
put /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
CADDY
systemctl enable caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'

say "provisioned"
cat <<DONE
  domain:   $DOMAIN
  app dir:  $APP_DIR
  service:  wormdrive (enabled; starts on first deploy)

next, from your machine:
  1. point A/AAAA for $DOMAIN at this box (Caddy fetches the cert
     once DNS resolves; it retries on its own until then)
  2. make deploy
DONE