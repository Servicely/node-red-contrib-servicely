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
    }
};
