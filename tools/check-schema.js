// READ-ONLY schema check: compares db/schema.sql with the database in DATABASE_URL (.env) and reports
// what `npm run setup:db` would add. Runs in a READ ONLY transaction and changes nothing.
// Prints the database name and object names only - never the connection string or other .env values.
// Run: node tools/check-schema.js
"use strict";
const fs = require("fs");
const path = require("path");
const pool = require("../dbPool");

const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8").replace(/--.*$/gm, "");
const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(m => m[1]);
const columns = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map(m => ({ table: m[1], column: m[2] }));

(async () => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const database = (await client.query("SELECT current_database() AS name, current_setting('transaction_read_only') AS ro")).rows[0];
        console.log(`database: ${database.name} (read-only transaction: ${database.ro})`);
        const existingTables = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map(r => r.table_name));
        const existingIndexes = new Set((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map(r => r.indexname));
        const existingColumns = new Set((await client.query("SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'")).rows.map(r => r.c));

        const missingTables = tables.filter(t => !existingTables.has(t));
        const missingIndexes = indexes.filter(i => !existingIndexes.has(i));
        // Columns of tables that do not exist yet are created with the table, not by ALTER TABLE.
        const missingColumns = columns.filter(c => existingTables.has(c.table) && !existingColumns.has(`${c.table}.${c.column}`));
        console.log(`tables in schema.sql: ${tables.join(", ")}`);
        console.log(`  missing (would be created): ${missingTables.join(", ") || "none"}`);
        console.log(`indexes in schema.sql: ${indexes.join(", ")}`);
        console.log(`  missing (would be created): ${missingIndexes.join(", ") || "none"}`);
        console.log(`ALTER TABLE ... ADD COLUMN IF NOT EXISTS: ${columns.length}`);
        console.log(`  missing (would be added): ${missingColumns.map(c => `${c.table}.${c.column}`).join(", ") || "none"}`);

        // Foreign keys and triggers that point at or live on these tables.
        const fks = (await client.query(`SELECT conrelid::regclass::text AS on_table, confrelid::regclass::text AS references_table, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY 1`)).rows;
        console.log("foreign keys now:");
        for (const fk of fks) console.log(`  ${fk.on_table} -> ${fk.references_table}: ${fk.definition}`);
        const triggers = (await client.query("SELECT event_object_table AS t, trigger_name AS n FROM information_schema.triggers WHERE trigger_schema = 'public'")).rows;
        console.log(`triggers now: ${triggers.map(t => `${t.t}.${t.n}`).join(", ") || "none"}`);

        const counts = (await client.query(`SELECT (SELECT count(*)::int FROM chatbots) AS chatbots, (SELECT count(*)::int FROM crawl_urls) AS crawl_urls,
            (SELECT count(*)::int FROM documents) AS documents`)).rows[0];
        console.log(`rows now: chatbots ${counts.chatbots}, crawl_urls ${counts.crawl_urls}, documents ${counts.documents}`);
        await client.query("ROLLBACK");
    } finally {
        client.release();
        await pool.end();
    }
})().catch(error => {
    console.error("schema check failed:", error.message);
    process.exit(1);
});
