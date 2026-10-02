// A minimal stand-in for a Servicely instance. Each test sets `server.handler` to decide the response
// and can inspect `server.requests` afterwards.
const http = require("node:http");

function createMockServer() {
    const server = http.createServer((req, res) => {
        let text = "";
        req.on("data", chunk => text += chunk);
        req.on("end", () => {
            let body;
            try {
                body = text ? JSON.parse(text) : undefined;
            } catch {
                body = text;
            }
            const request = { method: req.method, url: req.url, headers: req.headers, body: body };
            server.requests.push(request);
            // Not kept alive: fetch pools connections by host and port, which a later test's server may reuse
            res.setHeader("Connection", "close");
            server.handler(request, res);
        });
    });

    server.requests = [];
    server.handler = (req, res) => json(res, 200, { data: [] });

    server.start = () => new Promise(resolve => server.listen(0, "127.0.0.1", () => {
        server.baseUrl = "http://127.0.0.1:" + server.address().port + "/";
        resolve(server);
    }));
    // Close kept-alive connections too: clients pool them, and could reach this server again through a
    // later server given the same port
    server.stop = () => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    });
    server.reset = () => {
        server.requests = [];
        server.handler = (req, res) => json(res, 200, { data: [] });
    };

    return server;
}

function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

function text(res, status, body, contentType) {
    res.writeHead(status, { "Content-Type": contentType || "text/plain" });
    res.end(body);
}

/** A local URL nothing listens on: a port just released by a server of our own. */
function closedUrl() {
    const probe = http.createServer();
    return new Promise(resolve => probe.listen(0, "127.0.0.1", () => {
        const port = probe.address().port;
        probe.close(() => resolve("http://127.0.0.1:" + port + "/x"));
    }));
}

module.exports = { createMockServer, closedUrl, json, text };
