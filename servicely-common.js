let Base64 = require('crypto-js/enc-base64');
let HmacSHA256 = require('crypto-js/hmac-sha256');
let Utf8 = require('crypto-js/enc-utf8');

module.exports = {
    generateUrl: function(connection, path) {
        if (connection == null) {
            throw new Error("connection should not be null");
        }
        let baseUrl = connection.baseUrl;
        let username = connection.username;
        let password = connection.password;

        // Fix path
        path = path || "";
        if (path.startsWith("/")) {
            path = path.substr(1)
        }

        return baseUrl.replace("://", "://" + username + ":" + password + "@") + path;
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
