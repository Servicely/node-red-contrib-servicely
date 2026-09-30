#!/usr/bin/env bash
# Runs Node-RED in Docker with this repository mounted at /plugin.
#   NR_VERSION=4.1.2 ./docker_run.sh     # choose the Node-RED image version (default below)
#   NR_PORT=1881 ./docker_run.sh         # choose the host port

set -e

NR_VERSION="${NR_VERSION:-5.0.7}"
NR_PORT="${NR_PORT:-1880}"

WORKINGDIR="$(pwd)/_docker_config_volume"
PLUGINDIR="$(pwd)/"

mkdir -p _docker_config_volume

docker rm -f nodered >/dev/null 2>&1 || true

docker run \
  -p "${NR_PORT}:1880" \
  -v "${WORKINGDIR}:/data" \
  -v "${PLUGINDIR}:/plugin" \
  --add-host=host.docker.internal:host-gateway \
  --name nodered \
  "nodered/node-red:${NR_VERSION}"
