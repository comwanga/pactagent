# Nutshell Demo mint image for the Railway deployment (Issue #39).
#
# Pins the same verified Nutshell 0.21.0 image used by compose.local.yml.
# The upstream CMD is ["python3"], so Railway must run:
#   poetry run mint
#
# Mint state lives on the Railway volume mounted at /app/data
# (MINT_DATABASE=/app/data/mint).

FROM cashubtc/nutshell:0.21.0@sha256:beed25e291357368e35e1698bf2e4645d97ed435232a8f8ff6501c77d67c0b90
