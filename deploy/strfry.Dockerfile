# Strfry relay image for the Railway deployment (Issue #39).
#
# Pins the same verified image/version used by compose.local.yml and
# compose.hosted.yml, and layers the hosted relay configuration into the
# image so no host-file mount is required on Railway.
#
# Data lives on the Railway volume mounted at /app/strfry-db.

FROM dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d

COPY local/strfry-hosted.conf /etc/strfry.conf

# The upstream image already defines CMD ["/app/strfry.sh"].
