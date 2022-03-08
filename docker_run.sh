#!/usr/bin/env bash

WORKINGDIR="`pwd`/_docker_config_volume"
PLUGINDIR="`pwd`/"

mkdir -p _docker_config_volume

/Applications/Docker.app/Contents/Resources/bin/com.docker.cli rm -f nodered

/Applications/Docker.app/Contents/Resources/bin/com.docker.cli run \
  --tty \
  -p 1880:1880 \
  -v "${WORKINGDIR}:/data" \
  -v "${PLUGINDIR}:/plugin" \
  --name nodered \
  nodered/node-red
