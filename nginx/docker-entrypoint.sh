#!/bin/sh
set -e

CERT_DIR=/etc/nginx/certs
AUTH_DIR=/etc/nginx/auth

if [ ! -f "$CERT_DIR/depmap.crt" ] || [ ! -f "$CERT_DIR/depmap.key" ]; then
  echo "[entrypoint] no cert in $CERT_DIR - generating a self-signed placeholder (replace with a real cert later)"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$CERT_DIR/depmap.key" -out "$CERT_DIR/depmap.crt" \
    -days 825 -subj "/CN=depmap.local"
fi

if [ ! -f "$AUTH_DIR/htpasswd" ]; then
  echo "[entrypoint] no htpasswd in $AUTH_DIR - creating default user 'admin' / 'depmap' (CHANGE THIS)"
  htpasswd -Bbc "$AUTH_DIR/htpasswd" admin depmap
fi

exec nginx -g 'daemon off;'
