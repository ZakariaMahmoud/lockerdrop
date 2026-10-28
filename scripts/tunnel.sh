#!/bin/sh
# Expose the receiver pages through a Cloudflare quick tunnel.
# The admin page/API stay blocked for tunnel traffic (local network only).
set -eu

PORT="${PORT:-8080}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
fi

if ! curl -fsS -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then
  echo "Lockerdrop is not running on port ${PORT}. Start it first with: npm start" >&2
  exit 1
fi

echo "Opening a Cloudflare tunnel to http://localhost:${PORT} ..."
echo "Look for the https://<random>.trycloudflare.com URL below and share it with receivers."
echo "Tip: paste that URL into Admin → Share links & storage → Tunnel URL to add it to copied links."
exec cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}"
