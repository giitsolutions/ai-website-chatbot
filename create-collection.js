// Creates the Qdrant collection "website_content" if it does not exist yet.
// Safe to re-run: an existing collection (and its data) is never deleted or recreated;
// its vector settings are only checked. Run: npm run setup:qdrant
const { QdrantClient } = require("@qdrant/js-client-rest");

// QDRANT_COLLECTION (optional): another collection, e.g. an isolated one for tests.
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "website_content";
const VECTOR_SIZE = 768; // nomic-embed-text
const DISTANCE = "Cosine";

const client = new QdrantClient({
    url: "http://localhost:6333"
});

async function createCollection() {
    try {
        const { exists } = await client.collectionExists(COLLECTION_NAME);

        if (exists) {
            const info = await client.getCollection(COLLECTION_NAME);
            const vectors = info.config.params.vectors;
            const ok = vectors.size === VECTOR_SIZE && vectors.distance === DISTANCE;
            console.log(
                `Collection "${COLLECTION_NAME}" already exists (${info.points_count} points, ` +
                `${vectors.size}-dim ${vectors.distance}). ${ok ? "Settings OK; nothing changed." : "WARNING: unexpected vector settings."}`
            );
            if (!ok) process.exitCode = 1;
            return;
        }

        await client.createCollection(COLLECTION_NAME, {
            vectors: {
                size: VECTOR_SIZE,
                distance: DISTANCE
            }
        });

        console.log(`Qdrant collection "${COLLECTION_NAME}" created successfully.`);
    } catch (error) {
        console.error("Error setting up the Qdrant collection:", error.message);
        process.exitCode = 1;
    }
}

createCollection();
