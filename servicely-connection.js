module.exports = function (RED) {
    function ServicelyInstance(n) {
        RED.nodes.createNode(this, n);

        this.name = n.name;
        this.baseUrl = n.baseUrl;
        this.queue = n.queue;
        this.username = n.username;
        this.password = n.password;
    }

    RED.nodes.registerType("servicely-connection", ServicelyInstance);
};
