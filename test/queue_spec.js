const assert = require("node:assert");
const path = require("node:path");
const helper = require("node-red-node-test-helper");
const connectionNode = require("../servicely-connection.js");
const queueNodes = require("../servicely-queue.js");
const catchNode = require(require.resolve("@node-red/nodes/core/common/25-catch.js", { paths: [path.dirname(require.resolve("node-red"))] }));
const { createMockServer, json, text } = require("./helpers/mock-server");

helper.init(require.resolve("node-red"));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const COMBINED = "__node-red-combined__";

describe("servicely-queue", function () {
    const server = createMockServer();

    before(() => server.start());
    after(() => server.stop());
    afterEach(() => {
        server.reset();
        return helper.unload();
    });

    function loadFlow(nodes) {
        const flow = [{ id: "conn", type: "servicely-connection", baseUrl: server.baseUrl, queue: "node-red.default.queue", authtype: "token_hmac_header" }].concat(nodes);
        return new Promise(resolve => helper.load([connectionNode, queueNodes, catchNode], flow, { conn: { apiToken: "tok", apiSecret: "sec" } }, resolve));
    }

    /** A queue node with polling disabled (interval far in the future); tests trigger polls explicitly. */
    async function loadQueue(extra) {
        await loadFlow([
            Object.assign({ id: "q", type: "servicely-queue", connection: "conn", subject: "ping", pollingInterval: 3600, wires: [["out"]] }, extra),
            { id: "out", type: "helper" }
        ]);
        const q = helper.getNode("q");
        clearTimeout(q.poller.timeoutId);
        return { q, out: helper.getNode("out") };
    }

    /**
     * An instance without combined dequeues: it ignores "subjects", needs an identifier, and claims nothing for the
     * reserved subject.
     */
    function dequeueReturns(items) {
        server.handler = (req, res) => {
            if (req.body.action === "dequeue" && req.body.identifier == null) {
                json(res, 400, { _error: "identifier can not be null" });
                return;
            }
            json(res, 200, { data: req.body.action !== "dequeue" ? {} : req.body.subject === COMBINED ? [] : items });
        };
    }

    /** An instance with combined dequeues, returning the given actions for whatever is asked. */
    function combinedReturns(items) {
        server.handler = (req, res) => {
            const counts = {};
            (req.body.subjects || []).forEach(s => { counts[s.subject] = items.filter(i => i.subject === s.subject).length; });
            json(res, 200, { data: items, subjects: counts });
        };
    }

    const dequeues = () => server.requests.filter(r => r.body && r.body.action === "dequeue");

    function collect(out, count) {
        return new Promise(resolve => {
            const messages = [];
            out.on("input", msg => {
                messages.push(msg);
                if (messages.length === count) {
                    resolve(messages);
                }
            });
        });
    }

    describe("Queue", function () {
        it("tries a combined dequeue, then falls back to its own on an older instance", async function () {
            const { q } = await loadQueue({ requestCount: 5, identifier: "nr-1" });
            q.receive({});
            await wait(200);
            assert.deepStrictEqual(server.requests[0].body, {
                action: "dequeue", queue: "node-red.default.queue", subject: COMBINED, identifier: "nr-1",
                subjects: [{ subject: "ping", request_count: 5, identifier: "nr-1" }]
            });
            assert.deepStrictEqual(server.requests[1].body, {
                action: "dequeue", identifier: "nr-1", queue: "node-red.default.queue", subject: "ping", request_count: 5
            });
            assert.strictEqual(server.requests[1].url, "/controller/AsyncIntegration");
            assert.strictEqual(server.requests.length, 2);
            assert.strictEqual(q.poller.mode, "legacy");
        });

        it("sends one message per action with reply details and Join-compatible parts", async function () {
            dequeueReturns([{ id: "a1", payload: '{"x":1}' }, { id: "a2", payload: "plain" }, { id: "a3", payload: null }]);
            const { q, out } = await loadQueue();
            const received = collect(out, 3);
            q.receive({});
            const [m1, m2, m3] = await received;

            assert.deepStrictEqual(m1.payload, { x: 1 });
            assert.deepStrictEqual(m1.original_payload_fields, { x: 1 });
            assert.strictEqual(m1._reply_to, "a1");
            assert.strictEqual(m1._connectionNode, "conn");
            assert.strictEqual(m2.payload, "plain");
            assert.strictEqual(m2.original_payload_fields, undefined);
            assert.strictEqual(m3.payload, null);

            assert.ok(m1.parts.id);
            assert.strictEqual(m1.parts.id, m3.parts.id);
            assert.strictEqual(m1.parts.type, "array");
            assert.deepStrictEqual([m1.parts.index, m2.parts.index, m3.parts.index], [0, 1, 2]);
            assert.strictEqual(m1.parts.count, 3);
        });

        it("reports a malformed JSON payload against its message instead of crashing", async function () {
            dequeueReturns([{ id: "bad", payload: "{not json" }, { id: "good", payload: '{"ok":true}' }]);
            const { q, out } = await loadQueue();
            const received = collect(out, 1);
            q.receive({});
            const [good] = await received;

            assert.strictEqual(good._reply_to, "good");
            const call = q.error.getCalls().find(c => /Invalid JSON payload/.test(c.args[0]));
            assert.ok(call, "expected an error for the malformed payload");
            assert.strictEqual(call.args[1]._reply_to, "bad");
        });

        it("reports HTTP errors with the status and backend message", async function () {
            server.handler = (req, res) => json(res, 403, { _error: "Forbidden" });
            const { q } = await loadQueue();
            q.receive({});
            await wait(200);
            const call = q.error.lastCall;
            assert.strictEqual(call.args[0], "Forbidden");
            assert.strictEqual(call.args[1].statusCode, 403);
        });

        it("reports HTML error pages without crashing", async function () {
            server.handler = (req, res) => text(res, 502, "<html>Bad Gateway</html>", "text/html");
            const { q } = await loadQueue();
            q.receive({});
            await wait(200);
            assert.match(q.error.lastCall.args[0], /^502: <html>Bad Gateway/);
        });

        it("never has more than one dequeue in flight", async function () {
            let release;
            server.handler = (req, res) => {
                if (release) {
                    json(res, 200, { data: [] });
                } else {
                    release = () => json(res, 200, { data: [] });
                }
            };
            const { q } = await loadQueue();
            q.receive({});
            q.receive({});
            q.receive({});
            await wait(200);
            assert.strictEqual(server.requests.length, 1);
            release();
            await wait(100);
            clearTimeout(q.poller.timeoutId);
        });

        it("polls again straight away after a full batch", async function () {
            dequeueReturns([{ id: "a", payload: "1" }, { id: "b", payload: "2" }]);
            const { q } = await loadQueue({ requestCount: 2 });
            q.poller.mode = "legacy";
            q.poller.legacySince = Date.now();
            q.receive({});
            await wait(300);
            q.poller.repeat = 0;
            clearTimeout(q.poller.timeoutId);
            assert.ok(server.requests.length >= 2, "expected an immediate follow-up poll, got " + server.requests.length);
        });

        it("stops polling when closed", async function () {
            const { q } = await loadQueue({ pollingInterval: 0.05 });
            q.poller.schedule(0);
            await wait(200);
            await helper.unload();
            const count = server.requests.length;
            await wait(200);
            assert.ok(count >= 1);
            assert.strictEqual(server.requests.length, count);
        });

        it("reports a missing connection at startup", async function () {
            await loadFlow([{ id: "q", type: "servicely-queue", connection: "nope", subject: "ping", pollingInterval: 5, wires: [] }]);
            assert.match(helper.getNode("q").error.lastCall.args[0], /connection is not configured/);
        });
    });

    describe("Combined polling", function () {
        /** Queue nodes q1..qn with polling disabled, each wired to its own helper o1..on. */
        async function loadQueues(specs, extraNodes) {
            const nodes = [];
            specs.forEach((spec, i) => {
                nodes.push(Object.assign({ id: "q" + (i + 1), type: "servicely-queue", connection: "conn", pollingInterval: 3600, wires: [["o" + (i + 1)]] }, spec));
                nodes.push({ id: "o" + (i + 1), type: "helper" });
            });
            await loadFlow(nodes.concat(extraNodes || []));
            const queues = specs.map((spec, i) => helper.getNode("q" + (i + 1)));
            queues.forEach(q => clearTimeout(q.poller.timeoutId));
            return { queues, outs: specs.map((spec, i) => helper.getNode("o" + (i + 1))) };
        }

        it("claims every subject on a connection and interval with one dequeue", async function () {
            combinedReturns([]);
            const { queues } = await loadQueues([
                { subject: "ping" }, { subject: "orders", requestCount: 5, identifier: "nr-2" }, { subject: "sync", requestCount: 1 }
            ]);
            assert.strictEqual(queues[0].poller, queues[2].poller);
            queues[0].receive({});
            await wait(200);
            assert.strictEqual(server.requests.length, 1);
            assert.deepStrictEqual(server.requests[0].body, {
                action: "dequeue", queue: "node-red.default.queue", subject: COMBINED, identifier: "node-red",
                subjects: [
                    { subject: "ping", request_count: 10, identifier: "node-red" },
                    { subject: "orders", request_count: 5, identifier: "nr-2" },
                    { subject: "sync", request_count: 1, identifier: "node-red" }
                ]
            });
            assert.strictEqual(queues[0].poller.mode, "combined");
        });

        it("sends each node only its own subject's actions, as their own Join group", async function () {
            combinedReturns([
                { id: "p1", subject: "ping", payload: "1" },
                { id: "o1", subject: "orders", payload: '{"n":1}' },
                { id: "p2", subject: "ping", payload: "2" }
            ]);
            const { queues, outs } = await loadQueues([{ subject: "ping" }, { subject: "orders" }]);
            const pings = collect(outs[0], 2);
            const orders = collect(outs[1], 1);
            queues[0].receive({});
            const [p1, p2] = await pings;
            const [o1] = await orders;

            assert.deepStrictEqual([p1._reply_to, p2._reply_to], ["p1", "p2"]);
            assert.deepStrictEqual([p1.parts.index, p2.parts.index, p1.parts.count], [0, 1, 2]);
            assert.strictEqual(p1.parts.id, p2.parts.id);
            assert.strictEqual(o1._reply_to, "o1");
            assert.deepStrictEqual(o1.payload, { n: 1 });
            assert.strictEqual(o1.parts.count, 1);
            assert.notStrictEqual(o1.parts.id, p1.parts.id);
            assert.strictEqual(o1._connectionNode, "conn");
        });

        it("shares a subject's batch between nodes that listen for it", async function () {
            combinedReturns([{ id: "a", subject: "ping" }, { id: "b", subject: "ping" }, { id: "c", subject: "ping" }]);
            const { queues, outs } = await loadQueues([{ subject: "ping", requestCount: 2 }, { subject: "ping", requestCount: 3, identifier: "nr-2" }]);
            const first = collect(outs[0], 2);
            const second = collect(outs[1], 1);
            queues[0].receive({});
            assert.deepStrictEqual((await first).map(m => m._reply_to), ["a", "b"]);
            assert.deepStrictEqual((await second).map(m => m._reply_to), ["c"]);
            assert.deepStrictEqual(server.requests[0].body.subjects, [{ subject: "ping", request_count: 5, identifier: "node-red" }]);
            queues.forEach(q => { q.poller.repeat = 0; clearTimeout(q.poller.timeoutId); });
        });

        it("polls separately for a different interval or connection", async function () {
            combinedReturns([]);
            const conn2 = { id: "conn2", type: "servicely-connection", baseUrl: server.baseUrl, queue: "other.queue", authtype: "token_hmac_header" };
            const { queues } = await loadQueues([
                { subject: "a" }, { subject: "b", pollingInterval: 1800 }, { subject: "c", connection: "conn2" }
            ], [conn2]);
            assert.notStrictEqual(queues[0].poller, queues[1].poller);
            assert.notStrictEqual(queues[0].poller, queues[2].poller);
            queues.forEach(q => q.receive({}));
            await wait(200);
            const subjects = dequeues().map(r => r.body.queue + ":" + r.body.subjects.map(s => s.subject).join()).sort();
            assert.deepStrictEqual(subjects, ["node-red.default.queue:a", "node-red.default.queue:b", "other.queue:c"]);
        });

        it("falls back to one dequeue per node in the same round, and stays there", async function () {
            dequeueReturns([]);
            const { queues } = await loadQueues([{ subject: "ping" }, { subject: "orders" }]);
            queues[0].receive({});
            await wait(200);
            assert.deepStrictEqual(dequeues().map(r => r.body.subject).sort(), [COMBINED, "orders", "ping"]);
            server.requests = [];
            queues[0].receive({});
            await wait(200);
            assert.deepStrictEqual(dequeues().map(r => r.body.subject).sort(), ["orders", "ping"]);
        });

        it("tries a combined dequeue again after the retry period", async function () {
            dequeueReturns([]);
            const { queues } = await loadQueues([{ subject: "ping" }]);
            queues[0].receive({});
            await wait(200);
            assert.strictEqual(queues[0].poller.mode, "legacy");
            queues[0].poller.retryCombinedAfter = 0;
            combinedReturns([]);
            server.requests = [];
            queues[0].receive({});
            await wait(200);
            assert.deepStrictEqual(dequeues().map(r => r.body.subject), [COMBINED]);
            assert.strictEqual(queues[0].poller.mode, "combined");
        });

        it("polls straight away only the nodes that received a full batch", async function () {
            let rounds = 0;
            server.handler = (req, res) => {
                rounds++;
                const data = rounds === 1 ? [{ id: "a", subject: "ping" }, { id: "b", subject: "ping" }, { id: "c", subject: "orders" }] : [];
                json(res, 200, { data: data, subjects: {} });
            };
            const { queues } = await loadQueues([{ subject: "ping", requestCount: 2 }, { subject: "orders", requestCount: 5 }]);
            queues[0].receive({});
            await wait(300);
            queues[0].poller.repeat = 0;
            clearTimeout(queues[0].poller.timeoutId);
            assert.strictEqual(dequeues().length, 2);
            assert.deepStrictEqual(dequeues()[1].body.subjects, [{ subject: "ping", request_count: 2, identifier: "node-red" }]);
        });

        it("splits a round into requests within the instance's limits", async function () {
            combinedReturns([]);
            const specs = [];
            for (let i = 0; i < 52; i++) {
                specs.push({ subject: "s" + i, requestCount: 1 });
            }
            specs.push({ subject: "big1", requestCount: 600 }, { subject: "big2", requestCount: 600 }, { subject: "huge", requestCount: 1500 });
            const { queues } = await loadQueues(specs);
            queues[0].receive({});
            await wait(300);
            const requests = dequeues().map(r => r.body.subjects);
            assert.ok(requests.every(subjects => subjects.length <= 50), "at most 50 subjects per request");
            assert.ok(requests.every(subjects => subjects.reduce((t, e) => t + e.request_count, 0) <= 1000), "at most 1000 actions per request");
            assert.strictEqual(requests.flat().length, 55);
            assert.strictEqual(requests.flat().find(e => e.subject === "huge").request_count, 1000);
            assert.ok(dequeues().every(r => r.body.identifier === "node-red"));
        });

        it("falls back for older builds that need an identifier", async function () {
            dequeueReturns([{ id: "a", subject: "ping" }]);
            const { queues, outs } = await loadQueues([{ subject: "ping" }]);
            const received = collect(outs[0], 1);
            queues[0].receive({});
            assert.strictEqual((await received)[0]._reply_to, "a");
            assert.ok(queues[0].error.notCalled);
            assert.strictEqual(queues[0].poller.mode, "legacy");
        });

        it("reports a failed combined dequeue on every node", async function () {
            server.handler = (req, res) => json(res, 403, { _error: "Forbidden" });
            const { queues } = await loadQueues([{ subject: "ping" }, { subject: "orders" }]);
            queues[0].receive({});
            await wait(200);
            assert.strictEqual(server.requests.length, 1);
            queues.forEach(q => {
                assert.strictEqual(q.error.lastCall.args[0], "Forbidden");
                assert.strictEqual(q.error.lastCall.args[1].statusCode, 403);
            });
            assert.strictEqual(queues[0].poller.mode, "unknown");
        });

        it("drops a closed node's subject, and stops when the last node closes", async function () {
            combinedReturns([]);
            const { queues } = await loadQueues([{ subject: "ping" }, { subject: "orders" }]);
            const poller = queues[0].poller;
            await new Promise(resolve => queues[1].close().then(resolve));
            queues[0].receive({});
            await wait(200);
            assert.deepStrictEqual(server.requests[0].body.subjects.map(s => s.subject), ["ping"]);
            await new Promise(resolve => queues[0].close().then(resolve));
            assert.strictEqual(poller.members.length, 0);
            assert.strictEqual(poller.poll(), false);
        });

        it("waits for a dequeue in flight before closing", async function () {
            let release;
            server.handler = (req, res) => { release = () => json(res, 200, { data: [{ id: "a", subject: "ping" }], subjects: { ping: 1 } }); };
            const { queues, outs } = await loadQueues([{ subject: "ping" }]);
            const received = collect(outs[0], 1);
            queues[0].receive({});
            await wait(100);
            let closed = false;
            const closing = queues[0].close().then(() => { closed = true; });
            await wait(100);
            assert.strictEqual(closed, false);
            release();
            await closing;
            assert.strictEqual((await received)[0]._reply_to, "a");
        });
    });

    describe("Success, Failure and Progress", function () {
        const queueMsg = { _connectionNode: "conn", _reply_to: "a1", payload: { result: 1 } };

        async function loadReply(type, extra) {
            await loadFlow([Object.assign({ id: "r", type: type, wires: [["out"]] }, extra), { id: "out", type: "helper" }]);
            return helper.getNode("r");
        }

        it("Success replies with the payload", async function () {
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg));
            await wait(200);
            assert.deepStrictEqual(server.requests[0].body, { reply_to: "a1", action: "success", identifier: "node-red", status: "ok", payload: "{\"result\":1}" });
            assert.ok(r.error.notCalled);
        });

        it("Failure replies with msg.rc.message when a command failed", async function () {
            const r = await loadReply("servicely-failure");
            r.receive(Object.assign({}, queueMsg, { rc: { code: 1, message: "exit 1" } }));
            await wait(200);
            assert.strictEqual(server.requests[0].body.action, "fail");
            assert.strictEqual(server.requests[0].body.status, "error");
            assert.strictEqual(server.requests[0].body.payload, "exit 1");
            assert.strictEqual(server.requests[0].body.error, "exit 1");
        });

        it("Progress sends msg.progress (or the configured message) and passes the message on", async function () {
            const r = await loadReply("servicely-progress", { progressMessage: "configured" });
            const out = helper.getNode("out");
            const passed = new Promise(resolve => out.on("input", resolve));
            r.receive(Object.assign({}, queueMsg, { progress: "50% done" }));
            const msg = await passed;
            await wait(200);
            assert.strictEqual(server.requests[0].body.action, "status");
            assert.strictEqual(server.requests[0].body.payload, "50% done");
            assert.deepStrictEqual(msg.payload, { result: 1 });
        });

        it("Progress passes the message on only once the instance has the update", async function () {
            let respond;
            server.handler = (req, res) => { respond = () => json(res, 200, { data: {} }); };
            const r = await loadReply("servicely-progress");
            const out = helper.getNode("out");
            let passed = false;
            out.on("input", () => { passed = true; });
            r.receive(Object.assign({}, queueMsg, { progress: "step 1" }));
            await wait(200);
            assert.strictEqual(passed, false);
            respond();
            await wait(200);
            assert.strictEqual(passed, true);
        });

        it("Progress doesn't pass the message on when the update fails", async function () {
            server.handler = (req, res) => json(res, 400, { _error: "bad" });
            const r = await loadReply("servicely-progress", { progressMessage: "configured" });
            const out = helper.getNode("out");
            let passed = false;
            out.on("input", () => { passed = true; });
            r.receive(Object.assign({}, queueMsg));
            await wait(200);
            assert.strictEqual(passed, false);
            assert.strictEqual(server.requests[0].body.payload, "configured");
            assert.strictEqual(r.error.lastCall.args[0], "Error on reply: bad");
        });

        it("sends an object or array as JSON text, which Intelligent Actions need", async function () {
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg, { payload: { a: [1, 2] } }));
            await wait(200);
            assert.strictEqual(server.requests[0].body.payload, '{"a":[1,2]}');
            assert.strictEqual(server.requests[0].body.error, undefined);
        });

        it("replies with the identifier the action was claimed by", async function () {
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg, { _original_payload: { id: "a1", claimed_by: "nr-2" } }));
            await wait(200);
            assert.strictEqual(server.requests[0].body.identifier, "nr-2");
        });

        it("Failure sends its description as error: the caught error, else the payload", async function () {
            const r = await loadReply("servicely-failure");
            r.receive(Object.assign({}, queueMsg, { payload: { code: 7 } }));
            r.receive(Object.assign({}, queueMsg, { payload: "original", error: { message: "boom", source: {} } }));
            await wait(200);
            assert.deepStrictEqual(server.requests.map(q => [q.body.payload, q.body.error]), [['{"code":7}', '{"code":7}'], ["original", "boom"]]);
        });

        it("reports HTTP errors from the reply to Catch nodes", async function () {
            server.handler = (req, res) => json(res, 500, { _error: "boom" });
            const r = await loadReply("servicely-success");
            r.receive(Object.assign({}, queueMsg));
            await wait(200);
            assert.strictEqual(r.error.lastCall.args[0], "Error on reply (is msg._reply_to an action on this queue?): boom");
            assert.strictEqual(r.error.lastCall.args[1]._reply_to, "a1");
            assert.strictEqual(r.error.lastCall.args[1].statusCode, 500);
        });

        it("reports a missing connection", async function () {
            const r = await loadReply("servicely-failure");
            r.receive({ _reply_to: "a1", payload: "x" });
            await wait(50);
            assert.match(r.error.lastCall.args[0], /Connection node is missing/);
            assert.strictEqual(server.requests.length, 0);
        });

        it("doesn't reply to a Queue node's failed poll passed on by a Catch node", async function () {
            server.handler = (req, res) => json(res, 503, { _error: "Service Unavailable" });
            await loadFlow([
                { id: "q1", type: "servicely-queue", connection: "conn", subject: "ping", pollingInterval: 3600, wires: [[]] },
                { id: "q2", type: "servicely-queue", connection: "conn", subject: "orders", pollingInterval: 3600, wires: [[]] },
                { id: "c", type: "catch", scope: null, uncaught: false, wires: [["r", "caught"]] },
                { id: "r", type: "servicely-failure", wires: [] },
                { id: "caught", type: "helper" }
            ]);
            const q1 = helper.getNode("q1");
            clearTimeout(q1.poller.timeoutId);
            const r = helper.getNode("r");
            const caught = [];
            helper.getNode("caught").on("input", msg => caught.push(msg));

            q1.receive({});
            await wait(300);
            assert.deepStrictEqual(server.requests.map(q => q.body.action), ["dequeue"]);
            assert.deepStrictEqual(caught.map(m => m.error.source.id).sort(), ["q1", "q2"]);
            caught.forEach(m => {
                assert.strictEqual(m._dequeue_error, true);
                assert.strictEqual(m.statusCode, 503);
            });
            // The test helper spies on Node.prototype, so the calls are shared by every node
            const calls = spy => spy.getCalls().filter(c => c.thisValue === r);
            assert.strictEqual(calls(r.error).length, 0);
            assert.strictEqual(calls(r.warn).length, 1, "the warning is logged at most once a minute");
            assert.match(calls(r.warn)[0].args[0], /No action to reply to/);
        });

        for (const type of ["servicely-success", "servicely-failure"]) {
            it(type.replace("servicely-", "") + " skips a message without msg._reply_to", async function () {
                const r = await loadReply(type);
                for (const replyTo of [undefined, null, ""]) {
                    r.receive({ _connectionNode: "conn", _reply_to: replyTo, payload: "x" });
                }
                await wait(100);
                assert.strictEqual(server.requests.length, 0);
                assert.ok(r.error.notCalled);
                assert.strictEqual(r.warn.callCount, 1);
            });
        }

        it("Progress skips a message without msg._reply_to and passes it on", async function () {
            const r = await loadReply("servicely-progress", { progressMessage: "configured" });
            const out = helper.getNode("out");
            const passed = new Promise(resolve => out.on("input", resolve));
            r.receive({ _connectionNode: "conn", payload: "x" });
            assert.strictEqual((await passed).payload, "x");
            await wait(100);
            assert.strictEqual(server.requests.length, 0);
            assert.ok(r.error.notCalled);
        });
    });
});
