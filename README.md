# Servicely connector for Node-RED

A beta implementation of a set of Node-RED nodes to facilitate integration with the Servicely Asynchronous
Queue/Actions.
 
## Development

ls servicely-* | entr -r ./docker_run.sh

# Install

docker exec -it servicely-nodered /bin/bash

cd /data
npm i --save node-red-contrib-servicely
