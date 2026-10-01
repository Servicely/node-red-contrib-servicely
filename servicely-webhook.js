const common = require("./servicely-common.js");

module.exports = function (RED) {
    "use strict";

    const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    const METHODS_WITH_BODY = ["POST", "PUT", "PATCH", "DELETE"];

    // Headers from msg.headers that must not override what the node sets itself
    const RESERVED_HEADERS = ["authorization", "date", "content-md5", "content-type", "content-length", "host"];

    function propertyName(value, fallback) {
        return (value && value.trim() !== "") ? value.trim() : fallback;
    }

    /**
     * The webhook Key (or id) to call: the node's setting, which may contain ${msg.x} placeholders,
     * otherwise msg.webhook_key.
     */
    function webhookKey(config, msg) {
        let key = (config.webhook && config.webhook.trim() !== "") ? common.renderUri(config.webhook.trim(), msg, String) : msg.webhook_key;
        return key == null ? "" : String(key);
    }

    /**
     * Builds a query string from msg.webhook_params, which scripted webhooks receive as `params`. Array
     * values repeat the parameter. Spaces are encoded as %20, not "+", so the URL-decoded query that HMAC
     * body signing covers is the same whichever decoder the instance uses.
     */
    function queryString(params) {
        if (params == null || typeof params != "object") {
            return "";
        }
        let pairs = [];
        Object.keys(params).forEach(name => {
            [].concat(params[name]).forEach(value => {
                if (value != null) {
                    pairs.push(encodeURIComponent(name) + "=" + encodeURIComponent(typeof value == "object" ? JSON.stringify(value) : String(value)));
                }
            });
        });
        return pairs.length ? "?" + pairs.join("&") : "";
    }

    function extraHeaders(headers) {
        let result = {};
        if (headers != null && typeof headers == "object") {
            Object.keys(headers).forEach(name => {
                if (RESERVED_HEADERS.indexOf(name.toLowerCase()) < 0 && headers[name] != null) {
                    result[name] = String(headers[name]);
                }
            });
        }
        return result;
    }

    /**
     * Summarises a V2 response in msg.webhook: the skip outcome, and for Transform webhooks the
     * operation, target table and record id ("standard" and "simple" formats). Custom and scripted
     * responses only get the key and skip flag.
     */
    function describeResponse(key, body) {
        let meta = { key: key, skipped: false };
        if (body == null || typeof body != "object" || Array.isArray(body)) {
            return meta;
        }
        if (typeof body.webhookKey == "string") {
            meta.key = body.webhookKey;
        }
        if (body.skipped === true) {
            meta.skipped = true;
            meta.reason = body.reason;
        }
        if (body.webhookOperation !== undefined) {
            meta.operation = body.webhookOperation;
            meta.table = body.webhookTable;
            meta.recordId = body.record != null ? body.record.id : undefined;
        } else if (body.id !== undefined) {
            meta.recordId = body.id;
        }
        if (Array.isArray(body.warnings)) {
            meta.warnings = body.warnings;
        }
        return meta;
    }

    function describeWebhookError(key) {
        return function (statusCode, body) {
            if (statusCode === 401) {
                return "Unauthorized: the token must match the webhook's API token, include the Webhook scope, " +
                    "and for HMAC the clock must be within 5 minutes of the instance's";
            }
            if (statusCode === 404) {
                return "Webhook '" + key + "' not found or inactive";
            }
            return common.describeHttpError(statusCode, body);
        };
    }

    function WebhookNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg, send, done) {
            node.status({});

            let connection = common.getConnection(RED, config, msg);
            if (connection == null) {
                common.reportError(node, msg, done, "Servicely Connection is not specified");
                return;
            }

            let method = (config.method || "POST").toUpperCase();
            if (METHODS.indexOf(method) < 0) {
                common.reportError(node, msg, done, "Unsupported method: " + config.method);
                return;
            }

            let key;
            try {
                key = webhookKey(config, msg);
            } catch (e) {
                common.reportError(node, msg, done, e);
                return;
            }
            if (key === "") {
                common.reportError(node, msg, done, "Webhook is not specified: set it on the node or in msg.webhook_key");
                return;
            }

            let auth;
            try {
                auth = common.nodeAuth(node, config, connection);
            } catch (e) {
                common.reportError(node, msg, done, e);
                return;
            }

            let body = METHODS_WITH_BODY.indexOf(method) >= 0 ? RED.util.getMessageProperty(msg, propertyName(config.input_property, "payload")) : null;
            // Serialised once, so that HMAC body signing covers exactly the bytes sent
            let bodyText = body == null ? null : JSON.stringify(body);
            let url = common.generateStandardURL(connection, "_webhook/v2/" + encodeURIComponent(key)) + queryString(msg.webhook_params);
            let headers = extraHeaders(msg.headers);

            try {
                Object.assign(headers, common.generateHeaders(auth, { method: method, url: url, body: bodyText, headers: headers }));
            } catch (e) {
                common.reportError(node, msg, done, e.signedHeader ? e.message + ": add it to msg.headers" : e);
                return;
            }

            let options = {
                url: url,
                method: method,
                body: bodyText,
                headers: headers,
                describeHttpError: describeWebhookError(key),
                // Scripted webhooks may return a plain string, which is serialised as JSON
                allowText: true
            };

            common.performRequest(node, options, msg, send, done, function (responseBody) {
                let meta = describeResponse(key, responseBody);
                msg.webhook = meta;
                RED.util.setMessageProperty(msg, propertyName(config.output_property, "payload"), responseBody === "" ? undefined : responseBody, true);

                if (meta.warnings && meta.warnings.length > 0) {
                    node.warn("Webhook '" + meta.key + "' returned warnings: " + JSON.stringify(meta.warnings));
                }
                if (config.skip_output) {
                    return meta.skipped ? [null, msg] : [msg, null];
                }
                return msg;
            });
        });
    }

    RED.nodes.registerType("servicely-webhook", WebhookNode, {
        credentials: {
            apiToken: { type: "password" },
            apiSecret: { type: "password" }
        }
    });

    // Editor lookups: the list of inbound webhooks, and one webhook's configuration and mappings
    const UNSUPPORTED = common.requiresVersion("Looking up webhooks", "Type the webhook's Key instead: the node works without lookups.");
    common.registerDiscoveryRoute(RED, "webhooks", () => "_webhook_admin/v2/inbound", UNSUPPORTED);
    common.registerDiscoveryRoute(RED, "webhooks/:id", params => "_webhook_admin/v2/inbound/" + encodeURIComponent(params.id), UNSUPPORTED);

    // Editor "Test auth": checks that the webhook would accept the dialog's credentials, without running it
    common.registerAuthTest(RED, "webhook-auth-test", "servicely-webhook.write", function (body) {
        let key = body.webhook == null ? "" : String(body.webhook).trim();
        if (key === "") {
            throw new Error("Enter the webhook's Key or id to test");
        }
        if (key.indexOf("${") >= 0 || key.indexOf("<%") >= 0) {
            throw new Error("The webhook is set from the message: enter a literal Key or id to test");
        }
        return {
            path: "_webhook_admin/v2/inbound/" + encodeURIComponent(key) + "/auth-check",
            describeHttpError: describeWebhookError(key)
        };
    }, common.requiresVersion("Test auth", "The node itself works on earlier versions."));
};
