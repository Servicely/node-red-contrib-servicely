const common = require("./servicely-common.js");

module.exports = function (RED) {
    "use strict";

    const METHODS_WITH_BODY = ["POST", "PATCH", "PUT"];
    const METHODS = ["GET", "DELETE"].concat(METHODS_WITH_BODY);

    function getConnection(config, msg) {
        return common.getConnection(RED, config, msg);
    }

    function propertyName(value, fallback) {
        return (value && value.trim() !== "") ? value.trim() : fallback;
    }

    function RestRequestNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg, send, done) {
            node.status({});

            let connection = getConnection(config, msg);

            if (connection == null) {
                setErrorMessage(node, msg, done, "Servicely Connection is not specified");
                return;
            }

            let method = (config.method || "GET").toUpperCase();
            if (METHODS.indexOf(method) < 0) {
                setErrorMessage(node, msg, done, "Unsupported method: " + config.method);
                return;
            }

            let url;
            try {
                url = common.generateStandardURL(connection, common.renderUri(config.uri, msg));
            } catch (e) {
                setErrorMessage(node, msg, done, e);
                return;
            }

            let inputProperty = propertyName(config.input_property, "payload");
            let outputProperty = propertyName(config.output_property, "payload");
            let message = METHODS_WITH_BODY.indexOf(method) >= 0 ? RED.util.getMessageProperty(msg, inputProperty) : null;

            performRequest(method, url, node, message, msg, common.generateHeaders(connection), send, done, function (body) {
                RED.util.setMessageProperty(msg, outputProperty, selectOutput(config.output_mode, body), true);
            });
        });
    }

    /**
     * Picks what the REST node outputs from a successful response body:
     *  - "data": the body's "data" field (the REST API wraps results in it)
     *  - "body": the whole body (e.g. Inbound Webhook v2 responses, which are not wrapped)
     *  - "auto" (default): "data" when the body has one, otherwise the whole body
     */
    function selectOutput(mode, body) {
        if (body == null || body === "") {
            return undefined;
        }
        switch (mode) {
            case "data":
                return body.data;
            case "body":
                return body;
            default:
                return (typeof body == "object" && Object.prototype.hasOwnProperty.call(body, "data")) ? body.data : body;
        }
    }

    function performRequest(method, url, node, message, msg, headers, send, done, onSuccess) {
        common.performRequest(node, { url: url, method: method, json: message, headers: headers }, msg, send, done, onSuccess);
    }

    const setErrorMessage = common.reportError;

    /**
     * Posts an ImportManager action with the node's authentication: its token override, otherwise the
     * connection's. The body is serialised once, so that HMAC body signing covers exactly the bytes sent.
     * Signed headers other than Date are taken from msg.headers.
     */
    function importManagerRequest(node, config, connection, msg, message, send, done, onSuccess, describe500) {
        let auth;
        let url;
        let body = JSON.stringify(message);
        let headers;
        try {
            auth = common.nodeAuth(node, config, connection);
            url = common.generateStandardURL(connection, "controller/ImportManager");
            headers = common.signedExtraHeaders(auth, msg.headers);
            Object.assign(headers, common.generateHeaders(auth, { method: "POST", url: url, body: body, headers: headers }));
        } catch (e) {
            setErrorMessage(node, msg, done, e.signedHeader ? e.message + ": add it to msg.headers" : e);
            return;
        }
        common.performRequest(node, {
            url: url, method: "POST", body: body, headers: headers,
            // The instance answers a name it doesn't know with a script error that doesn't say which name
            describeHttpError: (statusCode, responseBody) => (statusCode === 500 ? describe500 + ": " : "") + common.describeHttpError(statusCode, responseBody)
        }, msg, send, done, onSuccess);
    }

    /**
     * Writes an ImportManager result to the node's output property. The instance reports a failed import or
     * transform with success: false in a 200 response, which is thrown so the message goes to Catch nodes,
     * with the result still on it.
     */
    function storeResult(msg, config, fallback, body, describeFailure) {
        let result = selectOutput("auto", body);
        RED.util.setMessageProperty(msg, propertyName(config.output_property, fallback), result, true);
        if (result != null && typeof result == "object" && result.success === false) {
            throw new Error(describeFailure(result));
        }
    }

    /** The rows to import: the instance only accepts an array of objects, so a single object becomes one row. */
    function importRows(value) {
        return (value != null && typeof value == "object" && !Array.isArray(value)) ? [value] : value;
    }

    function ImportNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg, send, done) {
            node.status({});

            let connection = getConnection(config, msg);

            if (connection == null) {
                setErrorMessage(node, msg, done, "Servicely Connection is not specified");
                return;
            }

            if (msg.import_enabled === false) {
                send(msg);
                done();
                return;
            }

            let importMetadata = [Object.assign({
                "lastImportTimestamp": new Date().getTime().toString()
            }, msg.import_metadata)];

            let message = {
                action: "import",
                import_name: config.import_name || msg.import_name,
                import_table: config.import_table || msg.import_table,
                import_data: JSON.stringify(importRows(RED.util.getMessageProperty(msg, propertyName(config.input_property, "payload")))),
                import_metadata: JSON.stringify(importMetadata)
            };

            importManagerRequest(node, config, connection, msg, message, send, done, function (body) {
                storeResult(msg, config, "import_result", body, result => "Import failed: " + (result.error || "the instance reported success: false"));
                // So a Transform node after this one needs no settings of its own: it transforms the same table,
                // with the transform chosen here
                if (message.import_table) {
                    msg.import_table = message.import_table;
                }
                if (config.transform_name) {
                    msg.transform_name = config.transform_name;
                }
            }, "Import failed on the instance (an unknown import table or import source gives this error too: Test auth tells which)");
        });
    }

    function TransformNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg, send, done) {
            node.status({});

            let connection = getConnection(config, msg);

            if (connection == null) {
                setErrorMessage(node, msg, done, "Servicely Connection is not specified");
                return;
            }

            if (msg.transform_enabled === false) {
                send(msg);
                done();
                return;
            }

            let message = {
                action: "transform",
                transform_name: config.transform_name || msg.transform_name,
                import_table: config.import_table || msg.import_table
            };
            // The instance runs the transform against the import table sent, and fails without one: it doesn't
            // fall back to the transform's default
            if (!message.import_table) {
                setErrorMessage(node, msg, done, "The import table is not set: set Import table on the node, or msg.import_table");
                return;
            }
            if (!message.transform_name) {
                setErrorMessage(node, msg, done, "The transform is not set: set Import transform on the node, msg.transform_name, or Transform on the Import node before it");
                return;
            }

            importManagerRequest(node, config, connection, msg, message, send, done, function (body) {
                storeResult(msg, config, "transform_result", body, function (result) {
                    let load = result.importLoad && result.importLoad.Number ? " (" + result.importLoad.Number + ")" : "";
                    return "Transform failed" + load + ": " + (result.error || "the instance reported success: false") +
                        (result.rowFailures ? ". Each row's reason is in the result's importLoad.Log" : "");
                });
            }, "Transform failed on the instance (an unknown transform or import table gives this error too: Test auth tells which)");
        });
    }

    RED.nodes.registerType("servicely-rest", RestRequestNode);
    // The token override's credentials, as for the Webhook node
    const OVERRIDE_CREDENTIALS = {
        credentials: {
            apiToken: { type: "password" },
            apiSecret: { type: "password" }
        }
    };

    RED.nodes.registerType("servicely-import", ImportNode, OVERRIDE_CREDENTIALS);
    RED.nodes.registerType("servicely-transform", TransformNode, OVERRIDE_CREDENTIALS);

    /** A path of the instance's import discovery API, e.g. _import_admin/v1/transforms?import_table=x */
    function importAdminPath(path, params) {
        let query = [];
        Object.keys(params || {}).forEach(name => {
            let value = params[name];
            if (value != null && String(value).trim() !== "") {
                query.push(encodeURIComponent(name) + "=" + encodeURIComponent(String(value).trim()));
            }
        });
        return "_import_admin/v1/" + path + (query.length ? "?" + query.join("&") : "");
    }

    // Editor lookups: import tables with their fields, import transforms with their field mappings, and import
    // sources. Tables and transforms are read by id or name; names are unique across the instance, or the
    // instance answers 409.
    const UNSUPPORTED = common.requiresVersion("Looking up import tables, sources and transforms", "Type the names instead: the node works without lookups.");
    common.registerDiscoveryRoute(RED, "import-tables", () => importAdminPath("tables"), UNSUPPORTED);
    common.registerDiscoveryRoute(RED, "import-tables/:name", params => importAdminPath("tables/" + encodeURIComponent(params.name)), UNSUPPORTED);
    common.registerDiscoveryRoute(RED, "transforms", (params, query) => importAdminPath("transforms", { import_table: query.import_table }), UNSUPPORTED);
    common.registerDiscoveryRoute(RED, "transforms/:name", params => importAdminPath("transforms/" + encodeURIComponent(params.name)), UNSUPPORTED);
    common.registerDiscoveryRoute(RED, "import-sources", () => importAdminPath("sources"), UNSUPPORTED);

    function describeAuthCheckError(statusCode, body) {
        if (statusCode === 401) {
            return "Unauthorized: check the token and secret, and for HMAC that the clock is within 5 minutes of the instance's";
        }
        return common.describeHttpError(statusCode, body);
    }

    /**
     * Editor "Test auth": checks the dialog's credentials, and whether the import table (and transform)
     * entered resolve, without importing or transforming anything. Both are optional, since they can come
     * from the message. The instance evaluates a token's URL Allowed Paths for the check as
     * controller/ImportManager, so a token limited to imports can run it.
     */
    function registerImportAuthTest(route, permission) {
        common.registerAuthTest(RED, route, permission, function (body) {
            let params = { import_table: body.import_table, transform_name: body.transform_name };
            return { path: importAdminPath("auth-check", params), describeHttpError: describeAuthCheckError };
        }, common.requiresVersion("Test auth", "The node itself works on earlier versions."));
    }

    // The Import node's Transform is checked too, since the node passes it on
    registerImportAuthTest("import-auth-test", "servicely-import.write");
    registerImportAuthTest("transform-auth-test", "servicely-transform.write");
};
