"use strict";

/*
    Document reader supervisor: one long-lived worker thread that starts a reader child process
    (documentWorker.js) for each document, enforces its time limit and kills it when needed.

    Why a thread in between: on Windows, starting a process blocks the calling thread (~0.6 s
    measured on the development laptop). Started from this thread, that pause never reaches the
    server's main thread, where chat requests are answered. This thread never loads pdf.js or
    mammoth (only the child process does) and is not terminated while working, so stopping a
    reader cannot crash the server (terminating a worker thread that was loading pdf.js did).

    Messages in:  { id, fileType, data (Uint8Array), limits, timeoutMs, memoryMb }
    Messages out: { id, started: true, readerPid } when the reader process exists, then
                  { id, readerPid, outcome } with outcome.kind "ok" | "error" | "timeout" |
                  "memory" | "crash".
*/

const path = require("path");
const { fork } = require("child_process");
const { parentPort } = require("worker_threads");

function runJob({ id, fileType, data, limits, timeoutMs, memoryMb }) {
    const child = fork(path.join(__dirname, "documentWorker.js"), ["--document-job"], {
        execArgv: [`--max-old-space-size=${memoryMb}`],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    // The reader's process ID as soon as it exists (logging, tests).
    parentPort.postMessage({ id, started: true, readerPid: child.pid });
    let stderr = "";
    child.stderr.on("data", chunk => {
        if (stderr.length < 4000) stderr += chunk;
    });
    let done = false;
    const reply = outcome => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        parentPort.postMessage({ id, readerPid: child.pid, outcome });
    };
    const timer = setTimeout(() => reply({ kind: "timeout" }), timeoutMs);
    child.on("message", message => reply(message.ok ? { kind: "ok", result: message.result } : { kind: "error", error: message.error }));
    child.on("error", error => reply({ kind: "crash", detail: `could not start: ${error.message}` }));
    // A reader that ends without an answer ran out of memory or crashed. "close" (not "exit"):
    // it fires after stderr has been read completely, where V8 reports "heap out of memory".
    child.on("close", (code, signal) => reply(/heap out of memory|Allocation failed/i.test(stderr)
        ? { kind: "memory" }
        : { kind: "crash", detail: `exit code ${code}${signal ? `, signal ${signal}` : ""}` }));
    child.send({ fileType, data, limits }, error => {
        if (error) reply({ kind: "crash", detail: `could not receive the file: ${error.message}` });
    });
}

if (parentPort) {
    parentPort.on("message", job => {
        try {
            runJob(job);
        } catch (error) {
            parentPort.postMessage({ id: job.id, readerPid: null, outcome: { kind: "crash", detail: error.message } });
        }
    });
}
