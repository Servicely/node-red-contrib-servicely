module.exports = function (RED) {

    "use strict";

    const request = require("request").defaults({jar: true});

    function QueueInputNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        // Setup the polling interval
        node.repeat = config.pollingInterval || 10; // Seconds

        if (node.repeat > 2147483) {
            node.error(RED._("inject.errors.toolong", this));
            delete node.repeat;
        }

        // Retreive the node containing the connection information
        node.connection = RED.nodes.getNode(config.connection);

        node.on('input', function (msg) {
            msg.payload = {};

            // Add the Node ID of the connection we used to obtain the tasks, so that the reply nodes
            // can respond back to the correct location.
            msg._connectionNode = config.connection;

            // Execute the 'dequeue' API call
            performDequeueRequest(msg, node, config);
        });

        // Sets up the polling process, registering an interval based callback
        node.repeaterSetup = function () {
            if (node.repeat && !isNaN(node.repeat) && node.repeat > 0) {
                node.repeat = node.repeat * 1000;

                let high = 2000; let low = 0;
                let randomDelay = Math.random()  * (high - low) + low;

                setTimeout(() => {
                    if (RED.settings.verbose) {
                        this.log(RED._("servicely-queue.repeat", node));
                    }

                    if (this._closed == true) return;

                    node.interval_id = setInterval(function () {
                        node.emit("input", {});
                    }, node.repeat);
                }, randomDelay);
            }
        };

        node.repeaterSetup();
    }

    /**
     * Allows the Queue Input Node to cancel the periodic callback on node update/redeploy.
     */
    QueueInputNode.prototype.close = function() {
        this._closed = true;
        if (this.interval_id != null) {
            clearInterval(this.interval_id);
            if (RED.settings.verbose) { this.log(RED._("servicely-queue.stopped")); }
        }
    };

    function performDequeueRequest(msg, node, config) {
        let queue = node.connection.queue;
        let subject = config.subject;

        let url = generateUrl(config.connection)

        let message = {
            "action": "dequeue",
            "identifier": "node-red",
            "queue": queue,
            "subject": subject,
            "request_count": 10
        };

        node.status({fill:"blue",shape:"dot",text:""});
        request({url: url, method: "POST", json: message, headers: {'User-Agent': 'node.js' }}, (err, res, body) => {
            node.status({});

            if (err) {
                console.log(err);
                msg.payload = err;
                node.status({fill:"red",shape:"dot",text: "" + err});
                node.error(RED.util.cloneMessage(msg));
                return;
            }

            // Check for invalid state
            if (body == null || body.data == null || body.data.length == null) {
                msg.payload = "invalid body data";
                node.error(RED.util.cloneMessage(msg));
                return;
            }

            let data = body.data;

            // Because the messages can come in batches, we want to split each request into a single event
            // in the format that NodeRed uses for Joins etc.
            msg.parts = {
                count: data.length
            };

            let originalPayload;

            for (let i = 0; i < data.length; i++) {
                originalPayload = data[i];

                // Save the original payload, as we only want a single field from the original payload to propagate to the next node
                msg._original_payload = originalPayload;

                // Replace the payload
                if (typeof originalPayload.payload == 'string' && originalPayload.payload.charAt(0) == "{" || originalPayload.payload.charAt(0) == "[") {
                    msg.payload = JSON.parse(originalPayload.payload);
                } else {
                    msg.payload = originalPayload.payload;
                }

                // Set the part index (tracking the position of the original message)
                msg.parts.index = i;

                // Save the response ID (to reply back to Servicely)
                msg._reply_to = data[i].id;

                // Send the message
                node.send(RED.util.cloneMessage(msg));
            }
        });
    }

    function generateUrl(connectionNodeIdentifier) {
        let connection = RED.nodes.getNode(connectionNodeIdentifier);

        let baseUrl = connection.baseUrl;
        let username = connection.username;
        let password = connection.password;

        return baseUrl.replace("://", "://" + username + ":" + password + "@") + 'controller/AsyncIntegration';
    }

    function QueueSuccessResponseNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node._action = "success";
        node._status = "ok";

        node.on('input', function (msg) {
            node.status({});
            if (typeof msg._connectionNode != 'string') {
                node.status({fill:"red",shape:"dot",text: "Connection node is missing. Did you use the Servicely Queue node?"});
                node.error(RED.util.cloneMessage(msg));
                return ;
            }
            performReply(msg, node, config);
        });
    }

    function QueueFailureResponseNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node._action = "fail";
        node._status = "error";

        node.on('input', function (msg) {
            node.status({});
            if (typeof msg._connectionNode != 'string') {
                node.status({fill:"red",shape:"dot",text: "Connection node is missing. Did you use the Servicely Queue node?"});
                node.error(RED.util.cloneMessage(msg));
                return ;
            }
            performReply(msg, node, config);
        });
    }

    function performReply(msg, node, config) {
        let url = generateUrl(msg._connectionNode)

        let responseObj;

        if (msg.rc && msg.rc.code !== 0) {
            responseObj = msg.rc.message;
        } else {
            responseObj = msg.payload;
        }

        let message = {
            reply_to: msg._reply_to,
            action: node._action,
            identifier: "node-red",
            status: node._status,
            payload: responseObj
        };

        node.status({fill:"blue",shape:"dot",text: ""});

        request({url: url, method: "POST", json: message, headers: {'User-Agent': 'node.js' }}, (err, res, body) => {
            if (err) {
                console.log(err);

                node.status({fill:"red",shape:"dot",text: err});

                msg.payload = err;
                node.error(RED.util.cloneMessage(msg));
                return console.log(err);
            }
            node.status({});
        });
    }

    RED.nodes.registerType("servicely-queue", QueueInputNode);
    RED.nodes.registerType("servicely-success", QueueSuccessResponseNode);
    RED.nodes.registerType("servicely-failure", QueueFailureResponseNode);
};
