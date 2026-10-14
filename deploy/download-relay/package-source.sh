#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Fixed list, fixed metadata, stable gzip: no cache, executable or archive recursion.
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  --transform='s,^,download-relay/,' -cf - \
  Dockerfile LICENSE README.md go.mod index.html main.go main_test.go \
  manifest.json package-source.sh version.json | gzip -n -9 > relay-source.tar.gz.tmp
mv relay-source.tar.gz.tmp relay-source.tar.gz
