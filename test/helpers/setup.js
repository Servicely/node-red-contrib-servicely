// Test requests to the editor admin API (helper.request()) start a server on a new ephemeral port each time.
// Node's default agent keeps connections alive, so a later request to a reused port could reach an earlier
// test's server. Don't keep them.
const http = require("node:http");
http.globalAgent = new http.Agent({ keepAlive: false });
