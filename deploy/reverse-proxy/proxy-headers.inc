# Shared upstream settings for the reverse proxy.
#
# The proxy sets the forwarded headers itself, overwriting anything a client
# sent. Both Node services list the compose network in `TRUSTED_PROXIES`, so a
# header from anywhere else is ignored — which is what makes "trust
# X-Forwarded-* only from configured proxies" true rather than aspirational
# (Phase 6 §49).

proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
