# node-red-contrib-servicely

Node-RED nodes for integrating with [Servicely.ai](https://www.servicely.ai/): the asynchronous queue (Actions),
data imports and transforms, the REST API and Inbound Webhooks.

## Requirements

- Node-RED 3.0 or later (tested with Node-RED 5)
- Node.js 18 or later (Node-RED 5 requires 22.9 or later)
- Servicely 1.11.125 or later for the edit dialogs' lookups (webhooks, import tables, import sources and
  transforms) and *Test auth*. On earlier versions the dialogs say so, and names are typed instead.
- Servicely 1.11.125 or later for combined Queue polling. On earlier versions each Queue node polls on its own.

## Install

From the Node-RED editor: **Menu → Manage palette → Install**, and search for `node-red-contrib-servicely`.

Or from your Node-RED user directory (usually `~/.node-red`):

```sh
npm install node-red-contrib-servicely
```

## Upgrading from 0.0.x

Version 0.1.0 needs Node.js 18 and Node-RED 3.0 or later. You don't have to upgrade Servicely: the nodes work as
before on any version. Only the edit dialogs' lookups, *Test auth* and combined Queue polling need Servicely
1.11.125 or later. On an earlier version, the dialogs show a note saying so, you type names in as before, and each
Queue node polls on its own.

After upgrading, check your flows for these changes:

- **Credentials.** Passwords, tokens and secrets are now stored as Node-RED credentials. Existing connections
  keep working. Open each connection, click *Update* and deploy to migrate it. After that, flow exports no longer
  include the secrets, so re-enter them wherever you import the flow.
- **Import and Transform results.** These now go to `msg.import_result` / `msg.transform_result`, not
  `msg["undefined"]`. A failed import or transform, including row failures, is now reported to **Catch** nodes,
  where it used to pass as a success.
- **Errors reach Catch.** Errors from the Success, Failure and Progress replies used to be ignored. They now reach
  **Catch** nodes.
- **Progress.** The Progress node passes the message on only after the instance accepts the update, and not at all
  when the update fails.
- **Reply payloads.** Success, Failure and Progress now send an object or array payload as JSON text.
- **URI templates.** The REST node only substitutes message properties (`${msg.payload.id}`) and now URL-encodes
  the values. Templates that use expressions, or that insert values you have already encoded, need changing.
- **REST default method.** A REST node saved with the default method now performs a GET. Before, it did nothing.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Nodes

| Node | Purpose |
|---|---|
| **Queue** | Claims actions from a Servicely asynchronous queue, one message per action. |
| **Success** / **Failure** | Reply to an action claimed by the Queue node. |
| **Progress** | Sends a progress update for an action, and passes the message on. |
| **REST** | Calls the Servicely REST API. |
| **Webhook** | Calls an Inbound Webhook (V2), with a picker for the instance's webhooks and their mappings. |
| **Import** / **Transform** | Load data into an Import Table and run the transform, with pickers for the instance's import tables, import sources and transforms. |
| **Connector** | Adds a connection to the message for the nodes that follow. |

Each node has full help in the editor's help sidebar. Example flows are available from **Menu → Import → Examples**.

### Connection

A Servicely connection holds the instance URL and credentials, stored as encrypted Node-RED credentials. Three
authentication types are supported:

- **Username/Password** (HTTP Basic)
- **HMAC Header Token**: a System API Token and its secret sign each request
- **Bearer Token**: a System API Token sent as `Authorization: Bearer`

### Handling errors

All nodes report errors, including HTTP error responses, to **Catch** nodes. The message carries `msg.error`,
`msg.statusCode` (for HTTP errors) and the error text in `msg.payload`. For queue actions, a Catch node wired to a
**Failure** node reports any processing error back to Servicely. A Queue node's failed poll also reaches Catch, with
`msg._dequeue_error` set and no `msg._reply_to`; the Failure node skips such a message with a warning, since no
action was claimed.

## Documentation

Usage documentation: https://docs-servicely.atlassian.net/wiki/spaces/SD/pages/2247196673/Node-RED

## Links

- Servicely.ai: https://www.servicely.ai/
- Node-RED library: https://flows.nodered.org/node/node-red-contrib-servicely
- Changes: [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0
