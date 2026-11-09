# Strfry relay image for the Railway deployment (Issue #39).
#
# Pins the same verified image/version used by compose.local.yml and
# compose.hosted.yml, layers the hosted relay configuration into the image,
# and replaces the upstream process-group broadcast with a bounded, single-child
# shutdown wrapper (B39-01: normal Railway restart recovery).
#
# Data lives on the Railway volume mounted at /app/strfry-db.

FROM dockurr/strfry@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d

# The pinned image includes Python 3. Verify the sole runtime dependency at
# build time instead of fetching unpinned packages into the relay image.
RUN python3 -c "import sqlite3"
COPY local/strfry-hosted.conf /etc/strfry.conf
COPY deploy/strfry-entrypoint.sh /app/entrypoint.sh
COPY deploy/strfry-write-policy.py /app/strfry-write-policy.py
RUN chmod 0555 /app/strfry-write-policy.py /app/entrypoint.sh

ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
CMD []
