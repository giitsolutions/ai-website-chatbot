// Isolated test environment for integration tests that write data:
//   - PostgreSQL: a separate database "<name>_test" on the same server (created if missing, schema
//     applied with db/schema.sql); the shared database is never written to.
//   - Qdrant:     a separate collection "website_content_test" (created if missing).
//   - Files:      a temporary upload folder (UPLOAD_DIR), never data/uploads.
//   - Email:      EMAIL_TRANSPORT=test (kept in memory, never sent); startup recovery off.
// The connection string and every other .env value are only used, never printed.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");

const projectDir = path.join(__dirname, "..", "..");
const TEST_COLLECTION = "website_content_test";
const QDRANT = "http://localhost:6333/collections";
// postgres://user:password@host:port/database?options (the password may contain "@").
const URL_PATTERN = /^(postgres(?:ql)?:\/\/.*@[^@/]+\/)([^/?]+)(\?.*)?$/;

function sharedDatabaseUrl() {
    const env = require(path.join(projectDir, "node_modules", "dotenv")).parse(fs.readFileSync(path.join(projectDir, ".env")));
    if (!URL_PATTERN.test(env.DATABASE_URL || "")) throw new Error("DATABASE_URL in .env has an unexpected format.");
    return env.DATABASE_URL;
}

function withDatabase(url, name) {
    const [, prefix, , options = ""] = url.match(URL_PATTERN);
    return `${prefix}${name}${options}`;
}

// Environment variables for a test process (merge into process.env of the child).
function isolatedEnv() {
    const shared = sharedDatabaseUrl();
    const sharedName = shared.match(URL_PATTERN)[2];
    return {
        DATABASE_URL: withDatabase(shared, `${sharedName}_test`),
        TEST_DATABASE_NAME: `${sharedName}_test`,
        QDRANT_COLLECTION: TEST_COLLECTION,
        UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "chatbot-test-uploads-")),
        EMAIL_TRANSPORT: "test",
        STARTUP_RECOVERY: "off"
    };
}

// Refuses to continue unless this process points at the isolated database, collection and folder.
async function assertIsolated(pool) {
    const problems = [];
    if (!/_test$/.test(process.env.QDRANT_COLLECTION || "")) problems.push("QDRANT_COLLECTION is not a *_test collection");
    const uploads = path.resolve(process.env.UPLOAD_DIR || path.join(projectDir, "data", "uploads"));
    if (uploads.toLowerCase().startsWith(path.resolve(projectDir).toLowerCase() + path.sep)) problems.push("UPLOAD_DIR is inside the project");
    if (process.env.EMAIL_TRANSPORT !== "test") problems.push("EMAIL_TRANSPORT is not test");
    if (String(process.env.STARTUP_RECOVERY).toLowerCase() !== "off") problems.push("startup recovery is not off");
    const database = (await pool.query("SELECT current_database() AS name")).rows[0].name;
    if (!/_test$/.test(database)) problems.push("connected database is not a *_test database");
    if (problems.length) throw new Error(`Not an isolated test environment: ${problems.join("; ")}. Run through tests/run-isolated.js.`);
    return { database, collection: process.env.QDRANT_COLLECTION, uploads };
}

// Creates the test database (schema from db/schema.sql) and the test collection if missing.
async function prepare(env) {
    const { Client } = require(path.join(projectDir, "node_modules", "pg"));
    const shared = sharedDatabaseUrl();
    const admin = new Client({ connectionString: withDatabase(shared, "postgres") });
    await admin.connect();
    try {
        const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [env.TEST_DATABASE_NAME])).rowCount > 0;
        if (!exists) {
            if (!/^[a-z0-9_]+_test$/.test(env.TEST_DATABASE_NAME)) throw new Error("Unexpected test database name.");
            await admin.query(`CREATE DATABASE "${env.TEST_DATABASE_NAME}"`);
        }
    } finally {
        await admin.end();
    }
    const test = new Client({ connectionString: env.DATABASE_URL });
    await test.connect();
    try {
        await test.query(fs.readFileSync(path.join(projectDir, "db", "schema.sql"), "utf8"));
    } finally {
        await test.end();
    }
    const collection = await fetch(`${QDRANT}/${TEST_COLLECTION}`);
    if (collection.status === 404) {
        const created = await fetch(`${QDRANT}/${TEST_COLLECTION}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vectors: { size: 768, distance: "Cosine" } })
        });
        if (!created.ok) throw new Error(`Could not create the test collection (HTTP ${created.status}).`);
    } else if (!collection.ok) {
        throw new Error(`Qdrant is not reachable (HTTP ${collection.status}).`);
    }
}

// Read-only counts of the SHARED database and collection (to prove a test did not touch them).
async function sharedSnapshot() {
    const { Client } = require(path.join(projectDir, "node_modules", "pg"));
    const client = new Client({ connectionString: sharedDatabaseUrl() });
    await client.connect();
    try {
        await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
        const row = (await client.query(`SELECT
            (SELECT count(*)::int FROM chatbots) AS chatbots, (SELECT count(*)::int FROM crawl_urls) AS crawl_urls,
            (SELECT count(*)::int FROM documents) AS documents,
            (SELECT md5(string_agg(t::text, '' ORDER BY t::text)) FROM chatbots t) AS chatbots_md5`)).rows[0];
        const points = (await (await fetch(`${QDRANT}/website_content/points/count`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true })
        })).json()).result.count;
        const uploads = path.join(projectDir, "data", "uploads");
        return { ...row, points, uploadFolders: fs.existsSync(uploads) ? fs.readdirSync(uploads).length : 0 };
    } finally {
        await client.end();
    }
}

module.exports = { isolatedEnv, assertIsolated, prepare, sharedSnapshot, TEST_COLLECTION };
