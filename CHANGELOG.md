# Changelog

## 0.1.2 (2026-10-03)

### Fixed
- Queue nodes saved by 0.0.20 or earlier are no longer marked as invalid (*Invalid properties: requestCount*). Those
  versions had no *Batch size* setting, so the nodes have none saved; they use the default of 10, as they already
  did at runtime.

## 0.1.1 (2026-10-03)

### Fixed
- **Success**, **Failure** and **Progress** no longer call the instance when the message has no action to reply to
  (`msg._reply_to` is not set), such as a Queue node's failed poll passed on by a Catch node. They show *no action to
  reply to* and log a warning at most once a minute, and Progress passes the message on. Before, a Catch → Failure
  flow sent a failing reply for each failed poll and caught its own error again, repeating each failed poll many
  times over.

### Added
- A Queue node's failed poll sets `msg._dequeue_error` to `true`, so a flow can tell it apart from an error while
  processing an action.

## 0.1.0 (2026-10-03)

Requires **Node.js 18 or later** and **Node-RED 3.0 or later**. Tested with Node-RED 5 on Node.js 24.

### Added
- **Combined Queue polling.** Queue nodes that share a connection and polling interval now poll together: one
  dequeue per interval claims the actions for all their action names, each up to its own batch size, instead of
  one call per node. A call claims at most 1,000 actions for at most 50 action names, so larger sets are split
  over several calls. This needs Servicely 1.11.122 or later. Earlier versions are detected automatically, and
  the nodes then poll one call each as before, trying the combined call again every hour. Stopping or
  redeploying waits for a poll in flight, so the actions it claimed are still sent on.
- **Webhook** node for Inbound Webhooks (V2). It takes the webhook's Key or id (or `msg.webhook_key`), query
  parameters from `msg.webhook_params`, and extra headers from `msg.headers`. It can use its own Bearer or HMAC
  token for webhooks locked to one API token. It returns the whole response, with a `msg.webhook` summary
  (operation, table, record id, warnings), an optional second output for skipped responses, and clear 401/404
  errors. In the editor, the refresh button lists the instance's webhooks and shows the selected one's
  configuration and mappings (this needs Servicely 1.11.122 or later).
  The details are saved with the node, so they stay visible in the dialog and the Info sidebar as documentation.
  **Test auth** checks that the webhook accepts the node's credentials without running it, and the node is marked
  as misconfigured when a token override is missing its token or secret, or a setting is invalid. Token overrides
  support **HMAC Body** signing, the token's **hash method** (MD5, SHA-1, SHA-256, SHA-512) and its **signed
  headers**. *Use token settings* fills these in from the selected webhook's token.
- **Import** and **Transform** node lookups: the refresh buttons list the instance's import tables (with their
  fields and the transforms that use them by default), import sources, and import transforms (with their target
  table, load options and field mappings). *Copy sample payload* copies a JSON skeleton of an import row. The nodes
  warn about names used more than once, which make runs fail, and about import sources that ignore the posted rows.
  The Transform node warns when its Import table is blank or isn't the transform's default. As on the Webhook node, the details are saved with the node as documentation, and
  lookups need Servicely 1.11.122 or later.
- **Import** and **Transform** nodes can use their own Bearer, HMAC Header or HMAC Body token instead of the
  connection's, with **Test auth** to check the credentials and whether the import table and transform entered
  exist, without importing or transforming anything.
- **Bearer Token** authentication on the Servicely connection.
- The REST node's new **Output** option: *Automatic* (default) returns the response's `data` field for REST API
  responses and the whole body for responses without one, such as Inbound Webhooks. *"data" field* and
  *Whole response body* can also be chosen explicitly. `msg.statusCode` is set on every response.
- Queue node **Batch size** and **Identifier** settings.
- Optional **Connection** on the Import and Transform nodes, a **Data prop.** on Import and a **Result prop.**
  on both.
- The Progress node sends `msg.progress` when set.
- The Failure node sends a failure description: the error caught by a Catch node, or else the payload.
- Example flows (*Import → Examples* in the editor), full help text for every node, tests, linting and CI.

### Changed
- The **Progress** node passes the message on only once the instance has accepted the update, and not at all when
  the update fails. Before, a Success straight after it could reach the instance first, and the late update then set
  the finished action back to pending.
- **Success**, **Failure** and **Progress** send an object or array payload as JSON text, which Intelligent Actions
  need, and reply with the identifier the Queue node claimed the action with.
- Passwords, tokens and secrets are stored as Node-RED **credentials**: encrypted, and not included in flow exports.
  Existing connections keep working, and are migrated the next time they are opened and saved in the editor.
- Errors are delivered to **Catch** nodes (`msg.error`, plus `msg.statusCode` for HTTP errors), including errors
  from the Success, Failure and Progress replies, which were previously ignored.
- The Queue node waits for each poll to finish before scheduling the next, and polls again immediately after a
  full batch. Messages carry `msg.parts.id` so a Join node can recombine a batch.
- **Import and Transform** write their result to `msg.import_result` / `msg.transform_result` (previously
  `msg["undefined"]`); `msg.payload` is unchanged.
- The **Import** node has a *Transform* field, filled in when the chosen import table has only one transform. It
  passes it on as `msg.transform_name`, with the table it imported into as `msg.import_table`, so a **Transform**
  node after it can be left with no settings. The Transform node reports an error without calling the instance
  when either name is missing.
- The edit dialogs show a short prompt under each field, and nodes with invalid settings are marked as
  misconfigured. The palette uses current Font Awesome icons, and node labels show what each node does.
- The Queue node checks at startup that it has a connection, and starts polling after a short random delay.
- The edit dialogs' lookups, *Test auth* and combined Queue polling need **Servicely 1.11.122** or later. On an
  earlier version the dialogs show a note saying so instead of an error, and the nodes work as before.
- Every node's help now describes its properties, inputs and outputs, including what the instance returns, what an
  import source changes, which rows a transform processes, and why every queue action needs a reply.
- The **Transform** node reports an error without calling the instance when neither the node nor
  `msg.import_table` gives an import table. The instance requires one, and doesn't use the transform's default.
- **URI templates** only substitute message properties (`${msg.payload.id}` or `<%= msg.payload.id %>`), and the
  values are URL-encoded. Expressions that aren't plain message properties are rejected.
- HTTP requests use the built-in `fetch`, with a 30 second timeout. The `request`, `crypto-js` and `lodash`
  dependencies have been removed, so the module has no runtime dependencies.

### Fixed
- Malformed, non-JSON, empty or `null` responses, and `null`, object or malformed queue payloads, no longer crash
  the Node-RED runtime.
- Credentials are no longer embedded in request URLs. Passwords containing characters such as `@`, `:` or `#`
  work with Basic authentication.
- Connections saved without an authentication type no longer fall back to username/password when they only have
  a token and secret.
- A REST node added with the default method now performs a GET instead of doing nothing.
- The Name field on the Success and Failure nodes is saved, and the Progress node's help is shown.
- A base URL without a trailing slash is handled.
- A failed dequeue reports the HTTP status and the instance's error, instead of *Invalid body data*.
- Connections no longer share cookies: requests used a process-wide cookie jar.
- The Progress node's unused *Submit activity log* and *Template* fields have been removed.
- A failed import or transform is reported to **Catch** nodes. The instance answers these with `success: false`
  in a 200 response, which the nodes treated as success. Rows that fail to transform are reported the same way,
  with the load's number, and the result stays on the message.
- The Import node imports a single object as one row. The instance only accepts an array, and failed.
- An import or transform that fails because the instance doesn't know a name now says which names to check,
  since the instance's error doesn't.

## 0.0.20

- Initial Progress (status update) node.
