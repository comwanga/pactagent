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

FROM caddy@sha256:4e2425f6009577e7c651010f16679c28f7d12df3e7b1914f941a7a3370746b3c

COPY local/Caddyfile-railway /etc/caddy/Caddyfile
