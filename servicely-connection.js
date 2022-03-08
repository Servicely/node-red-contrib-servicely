module.exports = function (RED) {
    function ServicelyInstance(n) {
        RED.nodes.createNode(this, n);

        this.name = n.name;
        this.baseUrl = n.baseUrl;
        this.queue = n.queue;
        this.username = n.username;
        this.password = n.password;
    }

    function ServicelyConnectionInjector(config) {
        RED.nodes.createNode(this, config);

        let node = this;

        node.on('input', function (msg) {
            msg._connectionNode = config.connection;
            node.send(msg);
        });
    }

    RED.nodes.registerType("servicely-connection", ServicelyInstance);
    RED.nodes.registerType("servicely-connection-injector", ServicelyConnectionInjector);
};
