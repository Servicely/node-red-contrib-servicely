const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 30000;

const AUTH_PASSWORD = "password";
const AUTH_HMAC = "token_hmac_header";
const AUTH_BEARER = "bearer";

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
    AUTH_PASSWORD: AUTH_PASSWORD,
    AUTH_HMAC: AUTH_HMAC,
    AUTH_BEARER: AUTH_BEARER,

    /**
     * Performs an HTTP request with the global fetch API, calling back with (err, res, body) like the
     * 'request' library did. The body is parsed JSON when the response is JSON, otherwise the raw text.
     * No cookies are stored between requests.
     */
    sendRequest: function(options, callback) {
        let timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;

        let fetchOptions = {
            method: options.method,
            headers: Object.assign({ 'Accept': 'application/json' }, options.headers),
            signal: AbortSignal.timeout(timeoutMs)
        };

        if (options.json != null) {
            fetchOptions.headers["Content-Type"] = "application/json";
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
     * Only plain property paths are allowed - no code is evaluated.
     */
    renderUri: function(uri, msg) {
        return (uri || "").replace(TEMPLATE_PATTERN, (match, es, interpolate, evaluate) => {
            let expression = (es !== undefined ? es : interpolate !== undefined ? interpolate : evaluate).trim();
            if (evaluate !== undefined || !PROPERTY_PATH.test(expression)) {
                throw new Error("Unsupported URI template expression '" + match + "': only message properties such as ${msg.payload.id} are allowed");
            }
            let value = resolvePath({ msg: msg }, expression);
            return encodeURIComponent(value == null ? "" : (typeof value == "object" ? JSON.stringify(value) : String(value)));
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

    generateHeaders: function(connection) {
        if (connection == null) {
            throw new Error("connection should not be null");
        }
        let authType = connection.authtype || AUTH_PASSWORD;

        let token = connection.token || "";
        let secret = connection.secret || "";

        let username = connection.username || "";
        let password = connection.password || "";

        let headers = {
            'User-Agent': 'node-red-contrib-servicely'
        };

        switch (authType) {
            case AUTH_HMAC: {
                // Set the date as the UTC String format
                let formattedDate = (new Date()).toUTCString();

                // Hash the date with Hmac256 and Base64 the result
                let hashedDate = crypto.createHmac('sha256', secret).update(formattedDate).digest('base64');

                headers["Authorization"] = "HMAC " + token + ":" + hashedDate;
                headers["Date"] = formattedDate;

                break;
            }
            case AUTH_BEARER:
                headers["Authorization"] = "Bearer " + token;
                break;
            default:
                headers["Authorization"] = 'Basic ' + Buffer.from(username + ":" + password, 'utf8').toString('base64');
        }
        return headers;
    }
};
