const common = require("./servicely-common.js");

module.exports = function (RED) {
    "use strict";

    const common = require("./servicely-common.js");

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

        let url = generateQueueUrl(config.connection)
        let headers = generateHeaders(config.connection);

        let message = {
            "action": "dequeue",
            "identifier": "node-red",
            "queue": queue,
            "subject": subject,
            "request_count": 10
        };

        node.status({fill:"blue",shape:"dot",text:""});

        common.sendRequest({url: url, method: "POST", json: message, headers: headers }, (err, res, body) => {
            node.status({});

            if (err) {
                reportDequeueError(node, msg, err.message);
                return;
            }

            if (res.statusCode == 401) {
                reportDequeueError(node, msg, "Authentication failure: " + common.describeHttpError(res.statusCode, body), res.statusCode);
                return;
            }

            if (res.statusCode >= 400) {
                reportDequeueError(node, msg, common.describeHttpError(res.statusCode, body), res.statusCode);
                return;
            }

            // Check for invalid state
            if (body == null || body.data == null || body.data.length == null) {
                reportDequeueError(node, msg, "Invalid body data: Status: " + res.statusCode, res.statusCode);
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

                // Set the part index (tracking the position of the original message)
                msg.parts.index = i;

                // Save the response ID (to reply back to Servicely)
                msg._reply_to = data[i].id;

                // Replace the payload
                let payload = originalPayload.payload;
                delete msg.original_payload_fields;

                if (typeof payload == 'string' && (payload.charAt(0) == "{" || payload.charAt(0) == "[")) {
                    try {
                        msg.payload = JSON.parse(payload);
                    } catch (e) {
                        // Report against the message (with its _reply_to) so a Catch node can reply with a failure
                        msg.payload = payload;
                        node.error("[performDequeueRequest] Invalid JSON payload: " + e.message, RED.util.cloneMessage(msg));
                        continue;
                    }

                    // Keep the original payload fields so that they can be used in 'Change' nodes to set
                    // properties for downstream nodes.
                    msg.original_payload_fields = msg.payload;
                } else {
                    msg.payload = payload;
                }

                // Send the message
                node.send(RED.util.cloneMessage(msg));
            }
        });
    }

    /**
     * Reports a failed dequeue. The (empty) polling message is attached so Catch nodes receive the error.
     */
    function reportDequeueError(node, msg, error, statusCode) {
        msg.payload = error;
        if (statusCode !== undefined) {
            msg.statusCode = statusCode;
        }
        node.status({fill:"red",shape:"dot",text: error});
        node.error("[performDequeueRequest] " + error, RED.util.cloneMessage(msg));
    }

    /**
     * Reports an error against the message being replied to, so Catch nodes receive it.
     */
    function reportReplyError(node, msg, error, statusCode) {
        let errorMsg = RED.util.cloneMessage(msg);
        errorMsg.payload = error;
        if (statusCode !== undefined) {
            errorMsg.statusCode = statusCode;
        }
        node.status({fill:"red",shape:"dot",text: error});
        node.error(error, errorMsg);
    }

    function generateQueueUrl(connectionNodeIdentifier) {
        let connection = RED.nodes.getNode(connectionNodeIdentifier);
        return common.generateStandardURL(connection, 'controller/AsyncIntegration');
    }

    function generateHeaders(connectionNodeIdentifier) {
        let connection = RED.nodes.getNode(connectionNodeIdentifier);
        return common.generateHeaders(connection);
    }

    function QueueSuccessResponseNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node._action = "success";
        node._status = "ok";

        node.on('input', function (msg) {
            node.status({});
            if (typeof msg._connectionNode != 'string') {
                reportReplyError(node, msg, "Connection node is missing. Did you use the Servicely Queue node?");
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
                reportReplyError(node, msg, "Connection node is missing. Did you use the Servicely Queue node?");
                return;
            }
            performReply(msg, node, config);
        });
    }

    function QueueStatusResponseNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node._action = "status";
        node._status = "ok";

        node.on('input', function (msg) {
            node.status({});
            if (typeof msg._connectionNode != 'string') {
                reportReplyError(node, msg, "Connection node is missing. Did you use the Servicely Queue node?");
                return;
            }

            this.log(RED._("servicely-queue.status", config.progressMessage));

            let cloneMessage = RED.util.cloneMessage(msg);
            cloneMessage.payload = config.progressMessage;

            performReply(cloneMessage, node, config);

            // Keep the message going
            node.send(msg);
        });
    }

    function performReply(msg, node, config) {
        let url = generateQueueUrl(msg._connectionNode);
        let headers = generateHeaders(msg._connectionNode);

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

        common.sendRequest({url: url, method: "POST", json: message, headers: headers }, (err, res, body) => {
            if (err) {
                reportReplyError(node, msg, "Error on reply: " + err.message);
                return;
            }
            if (res.statusCode >= 400) {
                reportReplyError(node, msg, "Error on reply: " + common.describeHttpError(res.statusCode, body), res.statusCode);
                return;
            }
            node.status({});
        });
    }

    RED.nodes.registerType("servicely-queue", QueueInputNode);
    RED.nodes.registerType("servicely-success", QueueSuccessResponseNode);
    RED.nodes.registerType("servicely-failure", QueueFailureResponseNode);
    RED.nodes.registerType("servicely-progress", QueueStatusResponseNode);
};
