// Creates the PostgreSQL table from db/schema.sql if it does not exist yet.
// Safe to re-run: existing tables and rows are never changed. Run: npm run setup:db
const fs = require("fs");
const path = require("path");
const pool = require("../dbPool");

(async () => {
    try {
        await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
        const { rows } = await pool.query("SELECT count(*)::int AS n FROM chatbots");
        console.log(`Database ready: table "chatbots" exists with ${rows[0].n} row(s).`);
    } catch (error) {
        console.error("Database setup failed:", error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
