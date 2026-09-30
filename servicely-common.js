let Base64 = require('crypto-js/enc-base64');
let HmacSHA256 = require('crypto-js/hmac-sha256');
let Utf8 = require('crypto-js/enc-utf8');

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Parses a response body as JSON where possible, otherwise returns the raw text (e.g. an HTML error page).
 */
function parseBody(text) {
    if (text === "") {
        return "";
    }
    try {
        return JSON.parse(text);
    } catch (e) {
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

module.exports = {
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

    generateStandardURL: function(connection, path) {
        if (connection == null) {
            throw new Error("connection should not be null");
        }
        let baseUrl = connection.baseUrl;

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
        let authType = connection.authtype || "password";

        let token = connection.token;
        let secret = connection.secret;

        let username = connection.username || "";
        let password = connection.password || "";

        let headers = {
            'User-Agent': 'node.js'
        };

        switch (authType) {
            case "token_hmac_header":
                // Set the date as the UTC String format
                let formattedDate = (new Date()).toUTCString();

                // Hash the date with Hmac256 and Base64 the result
                let hashedDate = Base64.stringify(HmacSHA256(formattedDate, secret));

                headers["Authorization"] = "HMAC " + token + ":" + hashedDate;
                headers["Date"] = formattedDate;

                break;
            default:
                headers["Authorization"] = 'Basic ' + Base64.stringify(Utf8.parse(username + ":" + password));
        }
        return headers;
    }
};
