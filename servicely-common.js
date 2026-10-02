const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 30000;

const AUTH_PASSWORD = "password";
const AUTH_HMAC = "token_hmac_header";
const AUTH_BEARER = "bearer";
const AUTH_HMAC_BODY = "token_hmac_body";
// A node's authentication mode that uses its connection's authentication instead of a token override
const AUTH_CONNECTION = "connection";
const OVERRIDE_AUTH_MODES = [AUTH_BEARER, AUTH_HMAC, AUTH_HMAC_BODY];
const HMAC_MODES = [AUTH_HMAC, AUTH_HMAC_BODY];

/**
 * Whether an instance's response means it doesn't have a discovery endpoint (see relayToEditor).
 */
function isUnsupported(statusCode, body) {
    let isObject = body != null && typeof body == "object";
    if (isObject && body._error === undefined && typeof body.message == "string" && /^No static resource /.test(body.message)) {
        // An older build with no route for the path, whatever status it answers with
        return true;
    }
    if (statusCode === 404 || statusCode === 405) {
        return !(isObject && body._error !== undefined);
    }
    if (statusCode === 401) {
        // An older build's web app asking for a login: discovery endpoints answer 401 with an empty body, or _error
        return isObject && body.loginRequired === true;
    }
    // A 2xx without the contract's data, e.g. an older build's web app page
    return statusCode < 400 && !(isObject && Object.prototype.hasOwnProperty.call(body, "data"));
}

// The first Servicely version with the editor's lookups and Test auth checks (webhooks, import tables and
// sources, transforms)
const DISCOVERY_MIN_VERSION = "1.11.122";

const JSON_CONTENT_TYPE = "application/json";
const HASH_METHODS = ["md5", "sha1", "sha256", "sha512"];
const DEFAULT_SIGNED_HEADERS = ["Date"];

/**
 * Parses a response body as JSON where possible, otherwise returns the raw text (e.g. an HTML error page).
 */
function parseBody(text) {
    if (text === "") {
        return "";
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Converts fetch failures into errors with a readable message, e.g. "fetch failed: ECONNREFUSED".
 */
function describeError(err, timeoutMs) {
    if (err && err.name === "TimeoutError") {
        return new Error("Request timed out after " + timeoutMs + "ms");
    }
    if (err && err.cause) {
        return new Error(err.message + ": " + (err.cause.code || err.cause.message));
    }
    return err;
}

/**
 * The value of a header to sign, matched case-insensitively. Throws when it isn't set.
 */
function headerValue(headers, name) {
    let key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
    if (key === undefined || headers[key] == null) {
        let err = new Error("Signed header '" + name + "' is not set");
        err.signedHeader = name;
        throw err;
    }
    return String(headers[key]);
}

/** "Date, X-Request-Id" → ["Date", "X-Request-Id"] */
function headerList(value) {
    return String(value || "").split(",").map(h => h.trim()).filter(Boolean);
}

/**
 * Resolves a property path such as "msg.payload.id" or "msg.items[0].name" against the given scope.
 */
function resolvePath(scope, path) {
    let parts = path.replace(/\[(\d+|"[^"]*"|'[^']*')\]/g, (m, key) => "." + key.replace(/^["']|["']$/g, "")).split(".");
    let value = scope;
    for (let i = 0; i < parts.length; i++) {
        if (value == null) {
            return undefined;
        }
        value = value[parts[i]];
    }
    return value;
}

// ${msg.a.b}, <%= msg.a.b %> and <%- msg.a.b %> - the interpolation forms previously supported via lodash/template
const TEMPLATE_PATTERN = /\$\{\s*([^}]*?)\s*\}|<%[=-]\s*([\s\S]*?)\s*%>|<%([\s\S]*?)%>/g;
const PROPERTY_PATH = /^msg(\.[A-Za-z_$][\w$]*|\[(\d+|"[^"]*"|'[^']*')\])*$/;

module.exports = {
    DISCOVERY_MIN_VERSION: DISCOVERY_MIN_VERSION,

    /**
     * The text shown when an instance doesn't have a lookup or check: `what` needs a newer version, and
     * `fallback` says what to do instead.
     */
    requiresVersion: function(what, fallback) {
        return what + " needs Servicely " + DISCOVERY_MIN_VERSION + " or later, and this instance doesn't support it." + (fallback ? " " + fallback : "");
    },

    AUTH_PASSWORD: AUTH_PASSWORD,
    AUTH_HMAC: AUTH_HMAC,
    AUTH_BEARER: AUTH_BEARER,
    AUTH_HMAC_BODY: AUTH_HMAC_BODY,
    AUTH_CONNECTION: AUTH_CONNECTION,
    HASH_METHODS: HASH_METHODS,
    headerList: headerList,

    /**
     * Performs an HTTP request with the global fetch API, calling back with (err, res, body) like the
     * 'request' library did. The body is parsed JSON when the response is JSON, otherwise the raw text.
     * No cookies are stored between requests. The request body is `json` (serialised here), or `body`, an
     * already-serialised JSON string, for when the exact bytes must match a signature.
     */
    sendRequest: function(options, callback) {
        let timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;

        let fetchOptions = {
            method: options.method,
            headers: Object.assign({ 'Accept': 'application/json' }, options.headers),
            signal: AbortSignal.timeout(timeoutMs)
        };

        if (options.body != null) {
            fetchOptions.headers["Content-Type"] = JSON_CONTENT_TYPE;
            fetchOptions.body = options.body;
        } else if (options.json != null) {
            fetchOptions.headers["Content-Type"] = JSON_CONTENT_TYPE;
            fetchOptions.body = JSON.stringify(options.json);
        }

        fetch(options.url, fetchOptions)
            .then(res => res.text().then(text => ({ res: { statusCode: res.status }, body: parseBody(text) })))
            .then(
                // Call back outside of the promise chain so errors thrown by the callback aren't swallowed
                result => setImmediate(callback, null, result.res, result.body),
                err => setImmediate(callback, describeError(err, timeoutMs))
            );
    },

    /**
     * Builds a readable error message from an HTTP error response (status >= 400).
     */
    describeHttpError: function(statusCode, body) {
        if (body == null || body === "") {
            return "HTTP " + statusCode;
        }
        if (typeof body == "string") {
            // Non-JSON error body, e.g. an HTML error page from a proxy or load balancer
            return statusCode + ": " + body.substring(0, 200);
        }
        if (body._error != undefined) {
            return body._error + (body._errorId ? " (errorId: " + body._errorId + ")" : "");
        }
        if (body.errors) {
            return JSON.stringify(body.errors);
        }
        return "Unknown error:" + JSON.stringify(body);
    },

    /**
     * Substitutes ${msg.x} (or <%= msg.x %>) placeholders in a URI with URL-encoded message properties.
     * Only plain property paths are allowed - no code is evaluated. Pass `encode` to encode values
     * differently, e.g. String when the caller encodes the whole result itself.
     */
    renderUri: function(uri, msg, encode) {
        encode = encode || encodeURIComponent;
        return (uri || "").replace(TEMPLATE_PATTERN, (match, es, interpolate, evaluate) => {
            let expression = (es !== undefined ? es : interpolate !== undefined ? interpolate : evaluate).trim();
            if (evaluate !== undefined || !PROPERTY_PATH.test(expression)) {
                throw new Error("Unsupported URI template expression '" + match + "': only message properties such as ${msg.payload.id} are allowed");
            }
            let value = resolvePath({ msg: msg }, expression);
            return encode(value == null ? "" : (typeof value == "object" ? JSON.stringify(value) : String(value)));
        });
    },

    /**
     * Works out the authentication type for a connection saved without one (flows created by older
     * versions): HMAC when a token and secret are set, otherwise username/password.
     */
    resolveAuthType: function(authtype, credentials) {
        if (authtype) {
            return authtype;
        }
        if (credentials.token && credentials.secret && !credentials.username) {
            return AUTH_HMAC;
        }
        return AUTH_PASSWORD;
    },

    generateStandardURL: function(connection, path) {
        if (connection == null) {
            throw new Error("connection should not be null");
        }
        let baseUrl = connection.baseUrl || "";
        if (!baseUrl.endsWith("/")) {
            baseUrl += "/";
        }

        // Fix path
        path = path || "";
        if (path.startsWith("/")) {
            path = path.substr(1)
        }

        return baseUrl + path;
    },

    /**
     * Builds the authentication headers for `auth`, a connection or {authtype, token, secret, username,
     * password, hashMethod, signedHeaders}:
     *  - password: HTTP Basic
     *  - bearer: Authorization: Bearer <token>
     *  - token_hmac_header: Authorization: HMAC <token>:<signature> over the values of `signedHeaders`
     *    (default ["Date"]) joined with ":". Headers other than Date are read from `request.headers`.
     *  - token_hmac_body: the same header, signing METHOD, Content-MD5, Content-Type, Date and the
     *    URL-decoded path with query, joined with newlines. Needs `request` = {method, url, body}, where
     *    body is the exact JSON string sent; its base64 MD5 is sent as Content-MD5.
     * HMAC uses `hashMethod` (default sha256). Throws when the settings can't produce a signature.
     */
    generateHeaders: function(auth, request) {
        if (auth == null) {
            throw new Error("connection should not be null");
        }
        let authType = auth.authtype || AUTH_PASSWORD;

        let token = auth.token || "";
        let secret = auth.secret || "";

        let username = auth.username || "";
        let password = auth.password || "";

        let headers = {
            'User-Agent': 'node-red-contrib-servicely'
        };

        switch (authType) {
            case AUTH_HMAC:
            case AUTH_HMAC_BODY: {
                let hashMethod = (auth.hashMethod || "sha256").toLowerCase();
                if (HASH_METHODS.indexOf(hashMethod) < 0) {
                    throw new Error("Unsupported HMAC hash method: " + auth.hashMethod);
                }

                // Set the date as the UTC String format
                let formattedDate = (new Date()).toUTCString();
                headers["Date"] = formattedDate;

                let signed;
                if (authType === AUTH_HMAC) {
                    let names = (auth.signedHeaders && auth.signedHeaders.length) ? auth.signedHeaders : DEFAULT_SIGNED_HEADERS;
                    signed = names.map(name => name.toLowerCase() === "date" ? formattedDate : headerValue(request && request.headers, name)).join(":");
                } else {
                    if (request == null || !request.method || !request.url) {
                        throw new Error("HMAC body signing needs the request");
                    }
                    let url = new URL(request.url);
                    let md5 = "";
                    let contentType = "";
                    if (request.body != null) {
                        md5 = crypto.createHash("md5").update(request.body, "utf8").digest("base64");
                        contentType = JSON_CONTENT_TYPE;
                        headers["Content-MD5"] = md5;
                    }
                    signed = [request.method.toUpperCase(), md5, contentType, formattedDate, decodeURIComponent(url.pathname + url.search)].join("\n");
                }

                let signature = crypto.createHmac(hashMethod, secret).update(signed, "utf8").digest('base64');
                headers["Authorization"] = "HMAC " + token + ":" + signature;
                break;
            }
            case AUTH_BEARER:
                headers["Authorization"] = "Bearer " + token;
                break;
            default:
                headers["Authorization"] = 'Basic ' + Buffer.from(username + ":" + password, 'utf8').toString('base64');
        }
        return headers;
    },

    /**
     * A node's own token settings for an override auth mode (`bearer`, `token_hmac_header`,
     * `token_hmac_body`), or null for "connection", which uses the connection's. Returns {error} when the
     * token (or HMAC secret) is missing.
     */
    overrideAuth: function(mode, token, secret, hashMethod, signedHeaders) {
        if (OVERRIDE_AUTH_MODES.indexOf(mode) < 0) {
            return null;
        }
        let hmac = HMAC_MODES.indexOf(mode) >= 0;
        if (!token || (hmac && !secret)) {
            return { error: hmac ? "The token and secret are not set" : "The token is not set" };
        }
        return { authtype: mode, token: token, secret: secret, hashMethod: hashMethod || "sha256", signedHeaders: headerList(signedHeaders) };
    },

    /**
     * The authentication a node uses: its token override (config `authmode`, `hash_method`,
     * `signed_headers` and credentials `apiToken` / `apiSecret`), otherwise the connection. Throws when
     * the override's token or secret is missing.
     */
    nodeAuth: function(node, config, connection) {
        let credentials = node.credentials || {};
        let override = module.exports.overrideAuth(config.authmode || AUTH_CONNECTION, credentials.apiToken, credentials.apiSecret, config.hash_method, config.signed_headers);
        if (override && override.error) {
            throw new Error(override.error + " on the node");
        }
        return override || connection;
    },

    /**
     * The headers other than Date that `auth` signs, taken from `headers` (usually msg.headers), so that
     * they are sent with the request. Names match case-insensitively; missing ones are left for
     * generateHeaders to report.
     */
    signedExtraHeaders: function(auth, headers) {
        let result = {};
        if (auth == null || auth.authtype !== AUTH_HMAC || headers == null || typeof headers != "object") {
            return result;
        }
        (auth.signedHeaders || []).forEach(name => {
            let key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
            if (name.toLowerCase() !== "date" && key !== undefined && headers[key] != null) {
                result[key] = String(headers[key]);
            }
        });
        return result;
    },

    /**
     * Returns the connection configured on the node, falling back to the one carried on the message.
     */
    getConnection: function(RED, config, msg) {
        return RED.nodes.getNode(config.connection || msg._connectionNode);
    },

    /**
     * Reports an error against the message so that Catch nodes receive it (msg.error), with the
     * HTTP status in msg.statusCode when the error came from a response.
     */
    reportError: function(node, msg, done, error, statusCode) {
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
    },

    /**
     * Sends a request on behalf of a node and completes the message. `onSuccess(body)` updates the
     * message and may return what to send (e.g. an array for several outputs); by default msg is sent.
     * Options, in addition to those of sendRequest:
     *  - describeHttpError(statusCode, body): overrides the error text for responses >= 400
     *  - allowText: accept non-JSON success bodies instead of reporting them as errors
     */
    performRequest: function(node, options, msg, send, done, onSuccess) {
        const self = module.exports;
        node.status({fill: "blue", shape: "dot", text: ""});

        self.sendRequest(options, (err, res, body) => {
            if (err) {
                self.reportError(node, msg, done, err);
            } else if (res.statusCode >= 400) {
                self.reportError(node, msg, done, (options.describeHttpError || self.describeHttpError)(res.statusCode, body), res.statusCode);
            } else if (!options.allowText && typeof body == "string" && body !== "") {
                self.reportError(node, msg, done, "Unexpected non-JSON response (" + res.statusCode + "): " + body.substring(0, 200), res.statusCode);
            } else {
                msg.statusCode = res.statusCode;
                let output;
                try {
                    output = onSuccess(body);
                } catch (e) {
                    self.reportError(node, msg, done, e, res.statusCode);
                    return;
                }
                send(output === undefined ? msg : output);
                node.status({});
                done();
            }
        });
    },

    /**
     * Registers an editor-only admin route, GET /servicely/:connection/<route>, that proxies a read-only
     * discovery request to the instance of a deployed connection. The connection's credentials stay on the
     * server; the editor only sees the instance's JSON response. `upstreamPath(params, query)` returns the
     * instance path to call, from the route's parameters and query string. An instance without the endpoint
     * is reported as {error: unsupportedMessage, unsupported: true} (see relayToEditor), so the editor can
     * fall back to manual entry.
     */
    registerDiscoveryRoute: function(RED, route, upstreamPath, unsupportedMessage) {
        const self = module.exports;

        RED.httpAdmin.get("/servicely/:connection/" + route, RED.auth.needsPermission("servicely-connection.read"), function(req, res) {
            let connection = RED.nodes.getNode(req.params.connection);
            if (connection == null || connection.type !== "servicely-connection") {
                res.status(404).json({ error: "Connection not found: deploy the connection first" });
                return;
            }

            let url;
            try {
                url = self.generateStandardURL(connection, upstreamPath(req.params, req.query || {}));
            } catch (e) {
                res.status(400).json({ error: e.message });
                return;
            }

            self.relayToEditor(RED, res, {
                method: "GET",
                url: url,
                headers: self.generateHeaders(connection),
                // The instance answers an unauthenticated request with an empty 401
                describeHttpError: (statusCode, body) => statusCode === 401 ? "Unauthorized: check the connection's credentials" : self.describeHttpError(statusCode, body)
            }, unsupportedMessage);
        });
    },

    /**
     * Sends a request to the instance on behalf of an editor admin route and relays the JSON response.
     * Upstream 400/401/403/404/409 keep their status, and other errors become 502, all as {error}. The instance
     * lacks the endpoint when it answers 404 or 405 without an `_error`, 401 {"loginRequired": true} (an older
     * build's web app), {"message": "No static resource ..."} with any status (an older build without the route),
     * or succeeds without the contract's `data`: {error: unsupportedMessage, unsupported: true},
     * with status 404. `options.describeHttpError` overrides the error text, as for performRequest.
     */
    relayToEditor: function(RED, res, options, unsupportedMessage) {
        const self = module.exports;

        self.sendRequest(options, (err, upstream, body) => {
            try {
                if (err) {
                    res.status(502).json({ error: err.message });
                } else if (isUnsupported(upstream.statusCode, body)) {
                    res.status(404).json({ error: unsupportedMessage, unsupported: true });
                } else if (upstream.statusCode >= 400) {
                    let status = [400, 401, 403, 404, 409].indexOf(upstream.statusCode) >= 0 ? upstream.statusCode : 502;
                    res.status(status).json({ error: (options.describeHttpError || self.describeHttpError)(upstream.statusCode, body) });
                } else if (typeof body != "object" || body == null) {
                    res.status(502).json({ error: "Unexpected non-JSON response from the instance" });
                } else {
                    res.json(body);
                }
            } catch (e) {
                RED.log.error("Servicely editor request failed: " + e.message);
            }
        });
    },

    /**
     * A credential sent from an edit dialog: the typed value, or for "__PWRD__" (an unchanged password
     * field) the value stored for the deployed node.
     */
    dialogCredential: function(RED, value, nodeId, name) {
        if (value === "__PWRD__") {
            let stored = nodeId ? RED.nodes.getCredentials(nodeId) : null;
            return (stored && stored[name]) || "";
        }
        return value ? String(value) : "";
    },

    /**
     * Registers an editor "Test auth" route, POST /servicely/<route>, guarded by `permission`. It checks
     * that the instance would accept the dialog's credentials: the connection's, or a token override
     * (`authmode`, `apiToken`, `apiSecret`, `hash_method`, `signed_headers`) that may be typed but not yet
     * deployed. POST, so that typed tokens and secrets travel in the body, never the URL.
     * `prepare(body)` returns {path, describeHttpError} for the instance's side-effect-free check, or
     * throws when the request is incomplete.
     */
    registerAuthTest: function(RED, route, permission, prepare, unsupportedMessage) {
        const self = module.exports;

        RED.httpAdmin.post("/servicely/" + route, RED.auth.needsPermission(permission), function(req, res) {
            let body = req.body || {};
            let target;
            try {
                target = prepare(body);
            } catch (e) {
                res.status(400).json({ error: e.message });
                return;
            }

            let connection = body.connection ? RED.nodes.getNode(body.connection) : null;
            if (connection == null || connection.type !== "servicely-connection") {
                res.status(400).json({ error: body.connection ? "Connection not found: deploy the connection first" : "Select a connection to test" });
                return;
            }

            let override = self.overrideAuth(body.authmode || AUTH_CONNECTION, self.dialogCredential(RED, body.apiToken, body.id, "apiToken"),
                self.dialogCredential(RED, body.apiSecret, body.id, "apiSecret"), body.hash_method, body.signed_headers);
            if (override && override.error) {
                res.status(400).json({ error: override.error });
                return;
            }
            let auth = override || connection;

            let url;
            let headers = {};
            try {
                url = self.generateStandardURL(connection, target.path);
                Object.assign(headers, self.generateHeaders(auth, { method: "GET", url: url, body: null, headers: headers }));
            } catch (e) {
                res.status(400).json({ error: e.signedHeader ? "Test auth can only sign Date: '" + e.signedHeader + "' comes from msg.headers when the flow runs" : e.message });
                return;
            }

            self.relayToEditor(RED, res, {
                method: "GET",
                url: url,
                headers: headers,
                describeHttpError: target.describeHttpError
            }, unsupportedMessage);
        });
    }
};
