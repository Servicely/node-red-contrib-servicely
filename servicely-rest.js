const common = require("./servicely-common.js");
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
            let method = config.method;

            switch (method) {
                case "GET":
                    performRequest(method, url, node, null, msg);
                    break;
                case "POST":
                    performRequest(method, url, node, msg.payload, msg);
                    break;
            }
        });
    }

    function performRequest(method, url, node, message, msg) {
        node.status({fill:"blue",shape:"dot",text: ""});

        request({url: url, method: method, json: message, headers: {'User-Agent': 'node.js' }}, (err, res, body) => {
            if (err) {
                setErrorMessage(node, msg, err);

            } else if (res.statusCode >= 400) {
                console.error(body);
                console.error(res.statusCode);

                if (typeof body == "string") {
                    body = JSON.parse(body);
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
                console.log(JSON.stringify(body));

                msg.payload = (typeof body == "string") ? JSON.parse(body).data : body.data;
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

                performRequest("POST", url, node, message, msg);
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

                performRequest("POST", url, node, message, msg);
            }
        });
    }

    RED.nodes.registerType("servicely-rest", RestRequestNode);
    RED.nodes.registerType("servicely-import", ImportNode);
    RED.nodes.registerType("servicely-transform", TransformNode);
};
