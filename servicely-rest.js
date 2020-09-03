module.exports = function (RED) {
    "use strict";

    const request = require("request").defaults({jar: true});
    const common = require("./servicely-common.js");

    function RestRequestNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;
        let connection = RED.nodes.getNode(config.connection);
        let uri = config.uri;
        let url = common.generateUrl(connection, uri);
        let method = config.method;

        node.on('input', function (msg) {
            node.status({});

            let message = {
                url: common.generateUrl(connection, uri)
            };

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

        request({url: url, method: "POST", json: message, headers: {'User-Agent': 'node.js' }}, (err, res, body) => {
            console.log(res.statusCode);
            if (err || res.statusCode >= 400) {
                let error = (res.statusCode >= 400) ? body._error : err;
                console.log(error);
                node.status({fill:"red",shape:"dot",text: error});
                msg.payload = error;
                node.error(RED.util.cloneMessage(msg));
                return;
            } else {
                console.log(body);
                msg.payload = (typeof body == "string") ? JSON.parse(body).data : body.data;
                node.send(RED.util.cloneMessage(msg));
                node.status({});
            }
        });
    }

    function TransformNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;
        let connection = RED.nodes.getNode(config.connection);

        let url = common.generateUrl(connection, "controller/ImportManager");

        node.on('input', function (msg) {
            node.status({});

            let message = {
                action: "transform",
                transform_name: config.transform_name,
                import_table: config.import_table
            };

            performRequest("POST", url, node, message, msg);
        });
    }

    RED.nodes.registerType("servicely-rest", RestRequestNode);
    RED.nodes.registerType("servicely-transform", TransformNode);
};
