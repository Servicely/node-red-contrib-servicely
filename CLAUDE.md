# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Node-RED plugin (`node-red-contrib-servicely`, published to npm and the Node-RED palette) giving nodes for integrating with Servicely.ai: the asynchronous queue/actions API, data imports/transforms, the REST API and Inbound Webhooks. Plain CommonJS JavaScript with no build step and **no runtime dependencies** (HTTP uses the built-in `fetch`, hashing uses `node:crypto`). Requires Node >= 18 and Node-RED >= 3. User docs: https://docs-servicely.atlassian.net/wiki/spaces/SD/pages/2247196673/Node-RED

## Public repository

This repository is **public** (it is mirrored to GitHub and published to npm). Everything committed here must be safe to publish. That applies to code, docs, commit messages and branch names. Never include:
- internal ticket or issue-tracker IDs or links;
- customer or partner names;
- internal wiki or Confluence links, other than the public user docs linked above;
- hostnames, credentials or tokens, including ephemeral test ones;
- names or emails of individuals.

Describe changes by what they do, e.g. "Replace request with fetch", not by ticket. Internal notes or handoff documents belong outside the repo, or under a path excluded in `.git/info/exclude` (such as `docs/internal/`), never in a tracked file.

## Development

```sh
npm test                                   # mocha specs in test/ (node-red-node-test-helper, real Node-RED runtime)
npx mocha test/rest_spec.js -g "webhook"   # a single spec file / tests matching a name
npm run lint                               # ESLint (flat config), including inline <script> in *.html
```

Specs run the nodes against a local mock server (`test/helpers/mock-server.js`); they never need a Servicely instance. CI (`.github/workflows/test.yml`) runs lint + tests on Node 20-24 against Node-RED 4 and 5.

For manual testing, `docker_run.sh` starts `nodered/node-red` (version via `NR_VERSION`, default pinned) with the repo mounted at `/plugin`; install it once with `docker exec -it nodered bash -c "cd /data && npm i --save node-red-contrib-servicely@/plugin"`. See README_DEVELOPER.md. Release: bump `version`, update CHANGELOG.md, `npm pack --dry-run` (the `files` whitelist controls what is published), then `npm publish .`.

## Architecture

Each `servicely-*.js` runtime file is paired with a `servicely-*.html` editor file (node definitions, edit forms, help text). The `node-red.nodes` map in `package.json` registers the three runtime modules, and each module registers several node types:

- **servicely-connection.js**: `servicely-connection` config node (`baseUrl`, `queue`, `authtype`: `password` | `token_hmac_header` | `bearer`). Secrets are Node-RED **credentials** named `user`, `pass`, `apiToken`, `apiSecret`, and the runtime exposes them as `username`/`password`/`token`/`secret`. `servicely-connection-injector` sets `msg._connectionNode`.
- **servicely-queue.js** (palette `servicely`): `servicely-queue` dequeues from `controller/AsyncIntegration`. A poll is scheduled with `setTimeout` only after the previous one completes (`_inFlight` guard), with an immediate re-poll after a full batch. Each action becomes a message carrying `msg.parts` (`id`/`type: "array"`/`index`/`count`, so it is Join-compatible). `servicely-success` / `-failure` / `-progress` share `replyHandler` and post replies correlated by `msg._reply_to`. Progress passes the message on and sends `msg.progress` or the configured message; a non-zero `msg.rc.code` replies with `msg.rc.message`.
- **servicely-rest.js** (palette `servicely-rest`): `servicely-rest` calls `baseUrl + renderUri(uri, msg)`. `output_mode` `auto` returns `body.data` when present, otherwise the whole body (Inbound Webhook v2 responses aren't wrapped in `data`). `servicely-import` / `servicely-transform` POST to `controller/ImportManager` and write results to `msg.import_result` / `msg.transform_result`, leaving `msg.payload` untouched. They are skipped when `msg.import_enabled` / `msg.transform_enabled` is `false`.
- **servicely-common.js**:
  - `sendRequest`: a `fetch` wrapper with an `(err, res, body)` callback. It has a 30s timeout and no cookie jar. The body is parsed JSON or the raw text, and parsing never throws.
  - `describeHttpError`: turns an error response into text, including `_error` / `_errorId`.
  - `generateHeaders`: Basic, HMAC (`Authorization: HMAC <token>:<base64 HMAC-SHA256 of the Date header>` plus `Date`) or Bearer.
  - `resolveAuthType`: infers the auth type for legacy connections saved without one.
  - `renderUri`: `${msg.x}` / `<%= msg.x %>` substitution. Values are URL-encoded, and only plain property paths are allowed.

### Conventions that span files

- Errors go through `done(err)` (or `node.error(text, msg)` where no input message exists) with the message attached, so **Catch** nodes receive them. HTTP errors also set `msg.statusCode`. Every HTTP callback must be crash-safe: an exception inside an async callback terminates the whole Node-RED runtime.
- Nodes share context through underscore-prefixed `msg` fields, which must survive intermediate nodes: `_connectionNode` (connection config node id), `_reply_to` (queue action id), `_original_payload` (the raw dequeued item).
- Never put credentials in URLs (`fetch` rejects them anyway). Auth only goes in headers.
- **Legacy-flow compatibility.** The editor only keeps properties listed in `defaults` when it re-saves a node, so the legacy plain-text `username` / `password` / `token` / `secret` stay declared (hidden) in `servicely-connection.html`. `oneditprepare` copies them into the credential inputs, and `oneditsave` clears them. Don't remove those defaults, or existing flows lose their credentials on the next full deploy.
