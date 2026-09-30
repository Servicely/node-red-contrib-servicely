const common = require("./servicely-common.js");

module.exports = function (RED) {
    "use strict";

    const METHODS_WITH_BODY = ["POST", "PATCH", "PUT"];
    const METHODS = ["GET", "DELETE"].concat(METHODS_WITH_BODY);

    /**
     * Returns the connection configured on the node, falling back to the one carried on the message.
     */
    function getConnection(config, msg) {
        return RED.nodes.getNode(config.connection || msg._connectionNode);
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
        node.status({fill:"blue",shape:"dot",text: ""});

        let requestOptions = {
            url: url,
            method: method,
            json: message,
            headers: headers
        };

        common.sendRequest(requestOptions, (err, res, body) => {
            if (err) {
                setErrorMessage(node, msg, done, err);
            } else if (res.statusCode >= 400) {
                setErrorMessage(node, msg, done, common.describeHttpError(res.statusCode, body), res.statusCode);
            } else if (typeof body == "string" && body !== "") {
                setErrorMessage(node, msg, done, "Unexpected non-JSON response (" + res.statusCode + "): " + body.substring(0, 200), res.statusCode);
            } else {
                msg.statusCode = res.statusCode;
                onSuccess(body);

                send(msg);
                node.status({});
                done();
            }
        });
    }

    /**
     * Reports an error against the message so that Catch nodes receive it (msg.error), with the
     * HTTP status in msg.statusCode when the error came from a response.
     */
    function setErrorMessage(node, msg, done, error, statusCode) {
        if (error instanceof Error) {
            error = error.message;
        }
        error = String(error);

        node.status({fill: "red", shape: "dot", text: error});
        msg.payload = error;
        if (statusCode !== undefined) {
            msg.statusCode = statusCode;
        }
        done(error);
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

            let url = common.generateStandardURL(connection, "controller/ImportManager");
            let headers = common.generateHeaders(connection);

            let importMetadata = [Object.assign({
                "lastImportTimestamp": new Date().getTime().toString()
            }, msg.import_metadata)];

            let message = {
                action: "import",
                import_name: config.import_name || msg.import_name,
                import_table: config.import_table || msg.import_table,
                import_data: JSON.stringify(RED.util.getMessageProperty(msg, propertyName(config.input_property, "payload"))),
                import_metadata: JSON.stringify(importMetadata)
            };

            performRequest("POST", url, node, message, msg, headers, send, done, function (body) {
                RED.util.setMessageProperty(msg, propertyName(config.output_property, "import_result"), selectOutput("auto", body), true);
            });
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

            let url = common.generateStandardURL(connection, "controller/ImportManager");
            let headers = common.generateHeaders(connection);

            let message = {
                action: "transform",
                transform_name: config.transform_name || msg.transform_name,
                import_table: config.import_table || msg.import_table
            };

            performRequest("POST", url, node, message, msg, headers, send, done, function (body) {
                RED.util.setMessageProperty(msg, propertyName(config.output_property, "transform_result"), selectOutput("auto", body), true);
            });
        });
    }

    RED.nodes.registerType("servicely-rest", RestRequestNode);
    RED.nodes.registerType("servicely-import", ImportNode);
    RED.nodes.registerType("servicely-transform", TransformNode);
};
