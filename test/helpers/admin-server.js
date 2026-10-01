// Serves the editor's admin routes (RED.httpAdmin) on one port for a whole spec file. helper.request() starts
// and closes a server on a new ephemeral port for every request, and under load a request could reach another
// server that had just been given that port.
const http = require("node:http");
const supertest = require("supertest");

function createAdminServer(helper) {
    // The test helper creates a new admin app each time a flow is loaded, so look it up per request
    const server = http.createServer((req, res) => helper._httpAdmin(req, res));
    return {
        start: () => new Promise(resolve => server.listen(0, "127.0.0.1", resolve)),
        stop: () => new Promise(resolve => {
            server.close(resolve);
            server.closeAllConnections();
        }),
        request: () => supertest("http://127.0.0.1:" + server.address().port)
    };
}

module.exports = { createAdminServer };
