# Nutshell Demo mint image for the Railway deployment (Issue #39).
#
# Pins the same verified Nutshell 0.21.0 image used by compose.local.yml.
# The upstream CMD is ["python3"], so Railway must run:
#   poetry run mint
#
# Mint state lives on the Railway volume mounted at /app/data
# (MINT_DATABASE=/app/data/mint).

FROM cashubtc/nutshell:0.22.1@sha256:05b536e0e3d6beee75417ece319a3f89a687d34cfb3cc12c6b19d253104b450e
