const common = require("./servicely-common.js");

module.exports = function (RED) {
    "use strict";

    const MAX_INTERVAL_SECONDS = 2147483;
    const DEFAULT_REQUEST_COUNT = 10;
    const DEFAULT_IDENTIFIER = "node-red";

    // A combined dequeue names its subjects in "subjects", and sends this as "subject": an instance that predates
    // combined dequeues ignores "subjects" and filters on this, so it claims nothing for us
    const COMBINED_SUBJECT = "__node-red-combined__";
    // How long a poller that fell back to one dequeue per node waits before trying a combined dequeue again
    const COMBINED_RETRY_MS = 60 * 60 * 1000;
    // The instance's limits for one combined dequeue
    const COMBINED_MAX_SUBJECTS = 50;
    const COMBINED_MAX_ACTIONS = 1000;

    // One poller per connection and polling interval, shared by the Queue nodes that use them
    const pollers = new Map();

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

        node.connectionId = config.connection;

        let key = config.connection + "|" + node.repeat;
        let poller = pollers.get(key);
        if (!poller) {
            poller = new Poller(key, config.connection, node.repeat);
            pollers.set(key, poller);
        }
        node.poller = poller;
        poller.add(node);

        // A message polls the node's group now, unless a poll is already in flight
        node.on('input', function (msg, send, done) {
            poller.poll();
            done();
        });

        // Wait for a dequeue in flight, so the actions it claims are delivered rather than stranded
        node.on('close', function (removed, done) {
            poller.remove(node, done);
            if (RED.settings.verbose) {
                node.log("Stopped polling");
            }
        });
    }

    /**
     * Polls the queue for every Queue node on one connection with one polling interval. Each round is one
     * combined dequeue for all their subjects, or, on an instance without combined dequeues, one dequeue per
     * node. The next round is scheduled once a round completes; a node that received a full batch is polled
     * again straight away, so a backlog drains quickly.
     */
    function Poller(key, connectionId, repeat) {
        this.key = key;
        this.connectionId = connectionId;
        this.repeat = repeat;
        this.members = [];
        this.mode = "unknown"; // "combined" | "legacy", once the instance has answered
        this.legacySince = 0;
        this.retryCombinedAfter = COMBINED_RETRY_MS;
        this.inFlight = false;
        this.idleWaiters = [];
        this.timeoutId = null;
    }

    Poller.prototype.add = function (node) {
        let first = this.members.length === 0;
        this.members.push(node);
        if (first) {
            // Start after a random delay, so pollers don't all poll at the same moment
            this.schedule(Math.random() * 2000);
        }
    };

    Poller.prototype.remove = function (node, done) {
        this.members = this.members.filter(m => m !== node);
        if (this.members.length === 0) {
            clearTimeout(this.timeoutId);
            if (pollers.get(this.key) === this) {
                pollers.delete(this.key);
            }
        }
        if (this.inFlight) {
            this.idleWaiters.push(done);
        } else {
            done();
        }
    };

    Poller.prototype.schedule = function (delay, members) {
        if (!(this.repeat > 0) || this.members.length === 0) {
            return;
        }
        clearTimeout(this.timeoutId);
        this.timeoutId = setTimeout(() => this.poll(members), delay);
    };

    /**
     * Runs a round for the given members (default all). Returns false when a round is already in flight.
     */
    Poller.prototype.poll = function (members) {
        if (this.inFlight) {
            return false;
        }
        members = (members || this.members).filter(m => this.members.includes(m));
        if (members.length === 0) {
            return false;
        }
        clearTimeout(this.timeoutId);
        this.inFlight = true;

        members.forEach(m => m.status({fill:"blue",shape:"dot",text:""}));

        let finish = (full) => {
            this.inFlight = false;
            let waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach(done => done());
            full = full.filter(m => this.members.includes(m));
            if (full.length > 0) {
                this.schedule(0, full);
            } else {
                this.schedule(this.repeat * 1000);
            }
        };

        let tryCombined = this.mode !== "legacy" || Date.now() - this.legacySince >= this.retryCombinedAfter;
        if (tryCombined) {
            this.pollCombined(members, finish);
        } else {
            this.pollEach(members, finish);
        }
        return true;
    };

    /**
     * One dequeue for every member's subject, split into several when the instance's limits need it. Members
     * that share a subject share its batch, each taking up to its own batch size.
     */
    Poller.prototype.pollCombined = function (members, finish) {
        let bySubject = new Map();
        members.forEach(m => {
            let group = bySubject.get(m.subject);
            if (group) {
                group.push(m);
            } else {
                bySubject.set(m.subject, [m]);
            }
        });

        // Pack the subjects into requests within the instance's limits
        let chunks = [];
        let chunk = null;
        bySubject.forEach((group, subject) => {
            let entry = {
                subject: subject,
                request_count: Math.min(group.reduce((total, m) => total + m.requestCount, 0), COMBINED_MAX_ACTIONS),
                identifier: group[0].identifier
            };
            if (!chunk || chunk.entries.length >= COMBINED_MAX_SUBJECTS || chunk.total + entry.request_count > COMBINED_MAX_ACTIONS) {
                chunk = {entries: [], total: 0};
                chunks.push(chunk);
            }
            chunk.entries.push(entry);
            chunk.total += entry.request_count;
        });

        let pending = chunks.length;
        let full = [];
        let legacy = [];
        let chunkDone = () => {
            if (--pending > 0) {
                return;
            }
            if (legacy.length > 0) {
                // An instance without combined dequeues, which filtered on COMBINED_SUBJECT: poll each node instead
                if (this.mode !== "legacy" && RED.settings.verbose) {
                    members[0].log("This instance doesn't support combined dequeues, so each Queue node polls on its own");
                }
                this.mode = "legacy";
                this.legacySince = Date.now();
                this.pollEach(legacy, more => finish(full.concat(more)));
                return;
            }
            finish(full);
        };

        chunks.forEach(chunk => {
            let chunkMembers = [];
            chunk.entries.forEach(entry => chunkMembers.push(...bySubject.get(entry.subject)));

            let message = {
                "action": "dequeue",
                "queue": members[0].connection.queue,
                // Older instances need an identifier, and then find no actions with this subject
                "subject": COMBINED_SUBJECT,
                "identifier": members[0].identifier,
                "subjects": chunk.entries
            };

            dequeue(this.connectionId, message, (error, statusCode, data, body) => {
                if (error) {
                    chunkMembers.forEach(m => reportDequeueError(m, error, statusCode));
                    chunkDone();
                    return;
                }

                let marker = body.subjects;
                if (marker == null || typeof marker !== "object" || Array.isArray(marker)) {
                    if (data.length > 0) {
                        members[0].warn("Actions with the reserved subject " + COMBINED_SUBJECT + " were claimed and can't be delivered: " + data.map(item => item && item.id).join(", "));
                    }
                    legacy.push(...chunkMembers);
                    chunkDone();
                    return;
                }
                this.mode = "combined";

                let received = new Map(chunkMembers.map(m => [m, []]));
                let unrouted = [];
                data.forEach(item => {
                    let group = bySubject.get(item && item.subject) || [];
                    let member = group.find(m => received.get(m).length < m.requestCount) || group[group.length - 1];
                    if (member && received.has(member)) {
                        received.get(member).push(item);
                    } else {
                        unrouted.push(item);
                    }
                });
                if (unrouted.length > 0) {
                    members[0].warn("The instance returned actions for subjects no Queue node asked for: " + unrouted.map(item => item && item.id).join(", "));
                }

                received.forEach((items, m) => {
                    m.status({});
                    deliver(m, items);
                });
                // A subject that filled its batch is polled again straight away, for all its nodes
                chunk.entries.forEach(entry => {
                    let group = bySubject.get(entry.subject);
                    let count = group.reduce((total, m) => total + received.get(m).length, 0);
                    if (count >= entry.request_count) {
                        full.push(...group);
                    }
                });
                chunkDone();
            });
        });
    };

    /**
     * One dequeue per member, as instances without combined dequeues need.
     */
    Poller.prototype.pollEach = function (members, finish) {
        let pending = members.length;
        let full = [];
        members.forEach(m => {
            let message = {
                "action": "dequeue",
                "identifier": m.identifier,
                "queue": m.connection.queue,
                "subject": m.subject,
                "request_count": m.requestCount
            };
            dequeue(this.connectionId, message, (error, statusCode, data) => {
                if (error) {
                    reportDequeueError(m, error, statusCode);
                } else {
                    m.status({});
                    deliver(m, data);
                    if (data.length >= m.requestCount) {
                        full.push(m);
                    }
                }
                if (--pending === 0) {
                    finish(full);
                }
            });
        });
    };

    /**
     * Posts a dequeue. Calls back with (error, statusCode, data, body): the error text, or the claimed actions.
     */
    function dequeue(connectionId, message, callback) {
        let url = generateQueueUrl(connectionId);
        let headers;
        try {
            headers = generateHeaders(connectionId);
        } catch (e) {
            callback(e.message);
            return;
        }

        common.sendRequest({url: url, method: "POST", json: message, headers: headers }, (err, res, body) => {
            if (err) {
                callback(err.message);
            } else if (res.statusCode == 401) {
                callback("Authentication failure: " + common.describeHttpError(res.statusCode, body), res.statusCode);
            } else if (res.statusCode >= 400) {
                callback(common.describeHttpError(res.statusCode, body), res.statusCode);
            } else if (body == null || body.data == null || body.data.length == null) {
                callback("Invalid body data: Status: " + res.statusCode, res.statusCode);
            } else {
                callback(null, res.statusCode, body.data, body);
            }
        });
    }

    /**
     * Sends one message per claimed action. The messages carry Join-compatible parts, the action id to reply to,
     * and the connection the reply nodes use.
     */
    function deliver(node, data) {
        if (data.length === 0) {
            return;
        }

        let msg = {
            _connectionNode: node.connectionId,
            // Because the messages can come in batches, we want to split each request into a single event
            // in the format that Node-RED uses for Joins etc.
            parts: {
                id: RED.util.generateId(),
                type: "array",
                count: data.length
            }
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
            node.send(RED.util.cloneMessage(msg));
        }
    }

    /**
     * Reports a failed dequeue to Catch nodes, with the error text in msg.payload, and shows it on the node.
     */
    function reportDequeueError(node, error, statusCode) {
        let msg = {payload: error, _connectionNode: node.connectionId};
        if (statusCode !== undefined) {
            msg.statusCode = statusCode;
        }
        node.status({fill:"red",shape:"dot",text: error});
        node.error(error, msg);
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

                // Pass the message on only once the instance has the update: the instance applies replies
                // in the order it receives them, so a Success that overtook the update would be undone by it
                performReply(replyMessage, node, function (err) {
                    if (err) {
                        done(err);
                        return;
                    }
                    send(msg);
                    done();
                });
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

    /**
     * Turns a reply value into what the instance accepts: an Intelligent Action fails on an object or array,
     * so those are sent as JSON text.
     */
    function replyValue(value) {
        return (value !== null && typeof value === "object") ? JSON.stringify(value) : value;
    }

    function performReply(msg, node, done) {
        let url = generateQueueUrl(msg._connectionNode);
        let headers = generateHeaders(msg._connectionNode);

        let failedCommand = msg.rc && msg.rc.code !== 0;
        let responseObj = replyValue(failedCommand ? msg.rc.message : msg.payload);

        // The instance records who replied, for diagnostics only: use the Queue node's identifier
        let claimedBy = msg._original_payload && msg._original_payload.claimed_by;

        let message = {
            reply_to: msg._reply_to,
            action: node._action,
            identifier: (typeof claimedBy === "string" && claimedBy) ? claimedBy : DEFAULT_IDENTIFIER,
            status: node._status,
            payload: responseObj
        };

        // The instance takes a failure's description from "error"; after a Catch node, that's the caught error
        if (node._action === "fail") {
            let caught = msg.error && typeof msg.error.message === "string" ? msg.error.message : null;
            message.error = failedCommand ? responseObj : (caught != null ? caught : responseObj);
        }

        node.status({fill:"blue",shape:"dot",text: ""});

        common.sendRequest({url: url, method: "POST", json: message, headers: headers }, (err, res, body) => {
            if (err) {
                reportReplyError(node, msg, done, "Error on reply: " + err.message);
                return;
            }
            if (res.statusCode >= 400) {
                // The instance answers an unknown action id with a 500 script error that doesn't say so
                let hint = res.statusCode === 500 ? "Error on reply (is msg._reply_to an action on this queue?): " : "Error on reply: ";
                reportReplyError(node, msg, done, hint + common.describeHttpError(res.statusCode, body), res.statusCode);
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
