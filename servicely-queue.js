const common = require("./servicely-common.js");

module.exports = function (RED) {
    "use strict";

    const MAX_INTERVAL_SECONDS = 2147483;
    const DEFAULT_REQUEST_COUNT = 10;
    const DEFAULT_IDENTIFIER = "node-red";

    function QueueInputNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        // Setup the polling interval
        node.repeat = Number(config.pollingInterval || 10); // Seconds

        if (isNaN(node.repeat) || node.repeat > MAX_INTERVAL_SECONDS) {
            node.error("Polling interval must be a number of seconds no greater than " + MAX_INTERVAL_SECONDS);
            node.repeat = 0;
        }

        node.subject = config.subject;
        node.requestCount = parseInt(config.requestCount, 10) || DEFAULT_REQUEST_COUNT;
        node.identifier = config.identifier || DEFAULT_IDENTIFIER;

        // Retrieve the node containing the connection information
        node.connection = RED.nodes.getNode(config.connection);

        if (node.connection == null) {
            node.status({fill:"red",shape:"ring",text: "Servicely connection is not configured"});
            node.error("Servicely connection is not configured");
            return;
        }

        node.on('input', function (msg, send, done) {
            // Only one dequeue at a time; a poll that fires while one is in flight is skipped
            if (node._inFlight) {
                done();
                return;
            }
            node._inFlight = true;

            msg.payload = {};

            // Add the Node ID of the connection we used to obtain the tasks, so that the reply nodes
            // can respond back to the correct location.
            msg._connectionNode = config.connection;

            // Execute the 'dequeue' API call
            performDequeueRequest(msg, node, send, function (err, receivedCount) {
                node._inFlight = false;
                done(err);
                node.scheduleNextPoll(receivedCount >= node.requestCount ? 0 : node.repeat * 1000);
            });
        });

        // Polls again after the given delay, once the previous dequeue has completed. A full batch is
        // followed by an immediate poll so a backlog drains quickly.
        node.scheduleNextPoll = function (delay) {
            if (node._closed || !(node.repeat > 0)) {
                return;
            }
            clearTimeout(node.timeout_id);
            node.timeout_id = setTimeout(function () {
                node.receive({});
            }, delay);
        };

        // Start polling after a random delay, so several Queue nodes don't all poll at the same moment
        node.scheduleNextPoll(Math.random() * 2000);
    }

    /**
     * Allows the Queue Input Node to cancel the periodic callback on node update/redeploy.
     */
    QueueInputNode.prototype.close = function () {
        this._closed = true;
        clearTimeout(this.timeout_id);
        if (RED.settings.verbose) {
            this.log("Stopped polling");
        }
    };

    /**
     * Dequeues a batch of actions, sending one message per action. Calls back with (err, receivedCount).
     */
    function performDequeueRequest(msg, node, send, callback) {
        let url = generateQueueUrl(msg._connectionNode);
        let headers = generateHeaders(msg._connectionNode);

        let message = {
            "action": "dequeue",
            "identifier": node.identifier,
            "queue": node.connection.queue,
            "subject": node.subject,
            "request_count": node.requestCount
        };

        node.status({fill:"blue",shape:"dot",text:""});

        common.sendRequest({url: url, method: "POST", json: message, headers: headers }, (err, res, body) => {
            node.status({});

            if (err) {
                callback(reportDequeueError(node, msg, err.message));
                return;
            }

            if (res.statusCode == 401) {
                callback(reportDequeueError(node, msg, "Authentication failure: " + common.describeHttpError(res.statusCode, body), res.statusCode));
                return;
            }

            if (res.statusCode >= 400) {
                callback(reportDequeueError(node, msg, common.describeHttpError(res.statusCode, body), res.statusCode));
                return;
            }

            // Check for invalid state
            if (body == null || body.data == null || body.data.length == null) {
                callback(reportDequeueError(node, msg, "Invalid body data: Status: " + res.statusCode, res.statusCode));
                return;
            }

            let data = body.data;

            // Because the messages can come in batches, we want to split each request into a single event
            // in the format that Node-RED uses for Joins etc.
            msg.parts = {
                id: RED.util.generateId(),
                type: "array",
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
                        node.error("Invalid JSON payload: " + e.message, RED.util.cloneMessage(msg));
                        continue;
                    }

                    // Keep the original payload fields so that they can be used in 'Change' nodes to set
                    // properties for downstream nodes.
                    msg.original_payload_fields = msg.payload;
                } else {
                    msg.payload = payload;
                }

                // Send the message
                send(RED.util.cloneMessage(msg));
            }

            callback(null, data.length);
        });
    }

    /**
     * Records a failed dequeue on the polling message and returns the error text, which the caller
     * passes to done() so Catch nodes receive it.
     */
    function reportDequeueError(node, msg, error, statusCode) {
        msg.payload = error;
        if (statusCode !== undefined) {
            msg.statusCode = statusCode;
        }
        node.status({fill:"red",shape:"dot",text: error});
        return error;
    }

    function generateQueueUrl(connectionNodeIdentifier) {
        let connection = RED.nodes.getNode(connectionNodeIdentifier);
        return common.generateStandardURL(connection, 'controller/AsyncIntegration');
    }

    function generateHeaders(connectionNodeIdentifier) {
        let connection = RED.nodes.getNode(connectionNodeIdentifier);
        return common.generateHeaders(connection);
    }

    /**
     * Creates the input handler shared by the Success, Failure and Progress nodes.
     */
    function replyHandler(node, config, action, status) {
        node._action = action;
        node._status = status;

        return function (msg, send, done) {
            node.status({});
            if (typeof msg._connectionNode != 'string' || RED.nodes.getNode(msg._connectionNode) == null) {
                reportReplyError(node, msg, done, "Connection node is missing. Did you use the Servicely Queue node?");
                return;
            }

            if (action === "status") {
                let replyMessage = RED.util.cloneMessage(msg);
                replyMessage.payload = (msg.progress != null) ? msg.progress : config.progressMessage;

                // Keep the message going; the status update is sent alongside it
                send(msg);
                performReply(replyMessage, node, done);
            } else {
                performReply(msg, node, done);
            }
        };
    }

    function QueueSuccessResponseNode(config) {
        RED.nodes.createNode(this, config);
        this.on('input', replyHandler(this, config, "success", "ok"));
    }

    function QueueFailureResponseNode(config) {
        RED.nodes.createNode(this, config);
        this.on('input', replyHandler(this, config, "fail", "error"));
    }

    function QueueStatusResponseNode(config) {
        RED.nodes.createNode(this, config);
        this.on('input', replyHandler(this, config, "status", "ok"));
    }

    /**
     * Reports an error against the message being replied to, so Catch nodes receive it.
     */
    function reportReplyError(node, msg, done, error, statusCode) {
        msg.payload = error;
        if (statusCode !== undefined) {
            msg.statusCode = statusCode;
        }
        node.status({fill:"red",shape:"dot",text: error});
        done(error);
    }

    function performReply(msg, node, done) {
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
            identifier: DEFAULT_IDENTIFIER,
            status: node._status,
            payload: responseObj
        };

        node.status({fill:"blue",shape:"dot",text: ""});

        common.sendRequest({url: url, method: "POST", json: message, headers: headers }, (err, res, body) => {
            if (err) {
                reportReplyError(node, msg, done, "Error on reply: " + err.message);
                return;
            }
            if (res.statusCode >= 400) {
                reportReplyError(node, msg, done, "Error on reply: " + common.describeHttpError(res.statusCode, body), res.statusCode);
                return;
            }
            node.status({});
            done();
        });
    }

    RED.nodes.registerType("servicely-queue", QueueInputNode);
    RED.nodes.registerType("servicely-success", QueueSuccessResponseNode);
    RED.nodes.registerType("servicely-failure", QueueFailureResponseNode);
    RED.nodes.registerType("servicely-progress", QueueStatusResponseNode);
};
