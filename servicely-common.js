module.exports = {
    generateUrl: function(connection, path) {
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
