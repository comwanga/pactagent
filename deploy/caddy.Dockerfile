# Caddy WSS edge image for the Railway deployment (Issue #39).
#
# Pins the same verified Caddy image used by compose.hosted.yml and layers
# the Railway-specific Caddyfile into the image.
#
# On Railway the platform edge terminates trusted TLS and forwards to this
# service's PORT. Caddy runs WITHOUT automatic HTTPS (auto_https off) and
# proxies WebSocket upgrades to the private Strfry service.
#
# The upstream image CMD already runs:
#   caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

FROM caddy@sha256:14a9c00d4e833ebc2b65d36515b37bde3b73f0b323a2663aaafc88953d8c4e3f

COPY local/Caddyfile-railway /etc/caddy/Caddyfile
