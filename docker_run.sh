#!/usr/bin/env bash

WORKINGDIR="`pwd`/_docker_config_volume"
PLUGINDIR="`pwd`/"

mkdir -p _docker_config_volume

docker rm -f nodered 

docker run \
  -p 1880:1880 \
  -v "${WORKINGDIR}:/data" \
  -v "${PLUGINDIR}:/plugin" \
  --name nodered \
  nodered/node-red
