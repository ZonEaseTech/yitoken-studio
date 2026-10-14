# Supply the reviewed, digest-pinned Caddy runtime image (includes CA roots).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chmod=0555 download-relay /usr/local/bin/download-relay
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/download-relay"]
