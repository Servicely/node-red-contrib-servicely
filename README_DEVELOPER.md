# Developing node-red-contrib-servicely

## Tests and lint

```sh
npm install
npm test                                   # all specs (mocha + node-red-node-test-helper)
npx mocha test/rest_spec.js                # one spec file
npx mocha test/rest_spec.js -g "webhook"   # tests whose name matches
npm run lint                               # ESLint, including the editor <script> blocks in *.html
```

The specs run the nodes in a real Node-RED runtime against a local mock server (`test/helpers/mock-server.js`),
so they need no Servicely instance.

## Running in Node-RED

`docker_run.sh` starts Node-RED in Docker with this repository mounted at `/plugin`. It restarts on changes when
combined with `entr`:

```sh
ls servicely-* | entr -r ./docker_run.sh
NR_VERSION=4.1.2 ./docker_run.sh           # a different Node-RED version
```

The first time, install the local copy into the container's Node-RED:

```sh
docker exec -it nodered /bin/bash
cd /data
npm i --save node-red-contrib-servicely@/plugin
```

From inside the container, a Servicely instance running on the host is reachable at `http://host.docker.internal:<port>/`.

## Publishing

Check the package contents, then publish:

```sh
npm pack --dry-run
npm publish .
```
