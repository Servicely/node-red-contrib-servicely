# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Node-RED plugin (`node-red-contrib-servicely`, published to npm and the Node-RED palette) giving nodes for integrating with Servicely.ai: the asynchronous queue/actions API, data imports/transforms, and the REST API. It is plain CommonJS JavaScript with no build step, linter, or tests (`npm test` is a no-op). User docs: https://docs-servicely.atlassian.net/wiki/spaces/SD/pages/2247196673/Node-RED

## Public repository

This repository is **public** (it is mirrored to GitHub and published to npm). Everything committed here must be safe to publish. That applies to code, docs, commit messages and branch names. Never include:
- internal ticket or issue-tracker IDs or links;
- customer or partner names;
- internal wiki or Confluence links, other than the public user docs linked below;
- hostnames, credentials or tokens, including ephemeral test ones;
- names or emails of individuals.

Describe changes by what they do, e.g. "Replace request with fetch", not by ticket. Internal notes or handoff documents belong outside the repo, or under a path excluded in `.git/info/exclude` (such as `docs/internal/`), never in a tracked file.

## Development

Local testing runs inside the `nodered/node-red` Docker image. `docker_run.sh` starts a container called `nodered` on port 1880. It mounts `./_docker_config_volume` as `/data` (the Node-RED user dir, which is gitignored) and the repo as `/plugin`.

```sh
ls servicely-* | entr -r ./docker_run.sh      # restart the container whenever a node file changes

# first time only: install the local plugin into the container's Node-RED
docker exec -it nodered /bin/bash
cd /data && npm i --save node-red-contrib-servicely@/plugin
```

`docker_run.sh` hardcodes the macOS Docker Desktop binary path (`/Applications/Docker.app/...`).

Release: bump `version` in `package.json`, then run `npm publish .`.

## Architecture

Each `servicely-*.js` runtime file is paired with a `servicely-*.html` editor file (node definitions, edit forms, help text). The `node-red.nodes` map in `package.json` registers the three runtime modules, and each module registers several node types:

- **servicely-connection.js**: `servicely-connection` is a config node holding `baseUrl`, `queue`, `authtype`, username/password, and token/secret. `servicely-connection-injector` sets `msg._connectionNode` so that downstream nodes know which connection to use.
- **servicely-queue.js** (palette category `servicely`): `servicely-queue` polls `controller/AsyncIntegration` with `action: "dequeue"` on a `setInterval`. Each poll starts after a random 0–2s delay, and the node's `close()` clears the interval on redeploy. It splits each returned batch into separate messages using `msg.parts`. `servicely-success`, `servicely-failure`, and `servicely-progress` post a reply to the same endpoint, correlated by `msg._reply_to`. `servicely-progress` also passes the message through. A message whose `msg.rc.code` is non-zero replies with `msg.rc.message` instead of the payload.
- **servicely-rest.js** (palette category `servicely-rest`): `servicely-rest` makes a GET/POST/PUT/PATCH/DELETE request to `baseUrl + uri`. The URL is a lodash template rendered with `{ msg }`, and the node returns `body.data` in the configured output property. `servicely-import` and `servicely-transform` POST to `controller/ImportManager`. They can be skipped by setting `msg.import_enabled === false` or `msg.transform_enabled === false`.
- **servicely-common.js**: builds URLs and auth headers. `generateHeaders` sends either `Authorization: HMAC <token>:<base64(HmacSHA256(date, secret))>` with a matching `Date` header (`token_hmac_header`), or HTTP Basic auth (the default).

### How messages carry state between nodes

Nodes share context through underscore-prefixed `msg` fields, so these must survive intermediate nodes in a flow:
- `msg._connectionNode` is the ID of the connection config node. The queue node sets it; so does the injector. Reply, import, and transform nodes require it. The REST node uses its own configured connection first and falls back to this field.
- `msg._reply_to` is the queue item ID used for success/failure/progress replies.
- `msg._original_payload` is the raw dequeued item. When the item's payload was JSON, `msg.original_payload_fields` holds the parsed object.

### Quirks to be aware of

- Two URL helpers exist. `generateStandardURL` (used by the queue nodes) is just `baseUrl + path`. `generateUrl` (used by the REST, import, and transform nodes) also embeds `username:password@` in the URL, alongside the auth headers.
- In `ServicelyInstance`, the `authtype` inference block is overwritten by the line after it, which falls back to `"password"`. The editor's default is `token_hmac_header`.
- Connection secrets are stored in the node's `defaults`, not in Node-RED `credentials` (which is empty). As a result they are included when flows are exported.
- HTTP calls use the deprecated `request` library, with a cookie jar enabled.
