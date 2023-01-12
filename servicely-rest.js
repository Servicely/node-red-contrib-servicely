const common = require("./servicely-common.js");

const template = require('lodash/template');

module.exports = function (RED) {
    "use strict";

    const request = require("request").defaults({jar: true});
    const common = require("./servicely-common.js");

    function RestRequestNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg) {
            node.status({});

            let connectionNodeID = config.connection || msg._connectionNode;
            let connection = RED.nodes.getNode(connectionNodeID);

            if (connection == null) {
                setErrorMessage(node, msg, "Servicely Connection is not specified");
                return;
            }

            let uri = config.uri;
            let url = common.generateUrl(connection, uri);
            let headers = common.generateHeaders(connection);

            let method = config.method;

            let inputProperty = config.input_property || "payload";
            let outputProperty = config.input_property || "payload";


            switch (method) {
                case "GET":
                case "DELETE":
                    performRequest(method, url, node, null, msg, headers, outputProperty);
                    break;
                case "POST":
                case "PATCH":
                case "PUT":
                    performRequest(method, url, node, msg[inputProperty], msg, headers, outputProperty);
                    break;
            }
        });
    }

    function performRequest(method, url, node, message, msg, headers, outputProperty) {
        node.status({fill:"blue",shape:"dot",text: ""});

        url = template(url)({ msg: msg });

        let requestOptions = {
            url: url,
            method: method,
            json: message,
            headers: headers
        };

        request(requestOptions, (err, res, body) => {
            if (err) {
                setErrorMessage(node, msg, err);

            } else if (res.statusCode >= 400) {
                console.error(body);
                console.error(res.statusCode);

                if (typeof body == "string" && body != "") {
                    body = JSON.parse(body);
                } else if (typeof body == "string" && body == "") {
                    body = null;
                }

                let error;

                if (body == null) {
                    error = res.statusCode
                } else if (body._error != undefined) {
                    error = body._error;
                } else if (body.errors) {
                    error = JSON.stringify(body.errors)
                } else {
                    error = "Unknown error:" + JSON.stringify(body)
                }
                setErrorMessage(node, msg, error);
            } else {
                // console.log(JSON.stringify(body));

                msg[outputProperty] = (typeof body == "string") ? JSON.parse(body).data : body.data;

                node.send(RED.util.cloneMessage(msg));
                node.status({});
            }
        });
    }

    function setErrorMessage(node, msg, error) {
        node.status({fill: "red", shape: "dot", text: error});
        msg.payload = error;
        node.error(RED.util.cloneMessage(msg));
    }

    function ImportNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg) {
            let connectionNodeIdentifier = msg._connectionNode;

            if (connectionNodeIdentifier == null) {
                setErrorMessage(node, msg, "Servicely Connection is not specified");
                return;
            }

            let connection = RED.nodes.getNode(connectionNodeIdentifier);
            let url = common.generateUrl(connection, "controller/ImportManager");
            let headers = common.generateHeaders(connection);

            node.status({});

            if (msg.import_enabled === false) {
                node.send(RED.util.cloneMessage(msg));
                node.status({});
            } else {
                let importMetadata = [{
                    "lastImportTimestamp": new Date().getTime().toString()
                }];

                let import_data = JSON.stringify(msg.payload);
                let import_metadata = JSON.stringify(importMetadata);

                let message = {
                    action: "import",
                    import_name: config.import_name || msg.import_name,
                    import_table: config.import_table || msg.import_table,
                    import_data: import_data,
                    import_metadata: import_metadata
                };

                performRequest("POST", url, node, message, msg, headers);
            }
        });
    }

    function TransformNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg) {
            let connectionNodeIdentifier = msg._connectionNode;

            if (connectionNodeIdentifier == null) {
                setErrorMessage(node, msg, "Servicely Connection is not specified");
                return;
            }

            let connection = RED.nodes.getNode(connectionNodeIdentifier);
            let url = common.generateUrl(connection, "controller/ImportManager");
            let headers = common.generateHeaders(connection);

            node.status({});

            if (msg.transform_enabled === false) {
                node.send(RED.util.cloneMessage(msg));
                node.status({});
            } else {
                let message = {
                    action: "transform",
                    transform_name: config.transform_name || msg.transform_name,
                    import_table: config.import_table || msg.import_table
                };

                performRequest("POST", url, node, message, msg, headers);
            }
        });
    }

    RED.nodes.registerType("servicely-rest", RestRequestNode);
    RED.nodes.registerType("servicely-import", ImportNode);
    RED.nodes.registerType("servicely-transform", TransformNode);
};
