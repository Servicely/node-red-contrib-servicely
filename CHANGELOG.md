# Changelog

## 0.1.0 (not yet released)

Requires **Node.js 18 or later** and **Node-RED 3.0 or later**. Tested with Node-RED 5 on Node.js 24.

### Added
- **Bearer Token** authentication on the Servicely connection.
- The REST node's new **Output** option: *Automatic* (default) returns the response's `data` field for REST API
  responses and the whole body for responses without one, such as Inbound Webhooks. *"data" field* and
  *Whole response body* can also be chosen explicitly. `msg.statusCode` is set on every response.
- Queue node **Batch size** and **Identifier** settings.
- Optional **Connection** on the Import and Transform nodes, a **Data prop.** on Import and a **Result prop.**
  on both.
- The Progress node sends `msg.progress` when set.
- Example flows (*Import → Examples* in the editor), full help text for every node, tests, linting and CI.

### Changed
- Passwords, tokens and secrets are stored as Node-RED **credentials**: encrypted, and not included in flow exports.
  Existing connections keep working, and are migrated the next time they are opened and saved in the editor.
- Errors are delivered to **Catch** nodes (`msg.error`, plus `msg.statusCode` for HTTP errors), including errors
  from the Success, Failure and Progress replies, which were previously ignored.
- The Queue node waits for each poll to finish before scheduling the next, and polls again immediately after a
  full batch. Messages carry `msg.parts.id` so a Join node can recombine a batch.
- **Import and Transform** write their result to `msg.import_result` / `msg.transform_result` (previously
  `msg["undefined"]`); `msg.payload` is unchanged.
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
- The Progress node's unused *Submit activity log* and *Template* fields have been removed.

## 0.0.20

- Initial Progress (status update) node.
