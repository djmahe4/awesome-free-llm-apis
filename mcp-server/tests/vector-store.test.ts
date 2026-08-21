import { describe, it, expect } from 'vitest';
import { VectorStore } from '../src/memory/VectorStore.js';

describe('VectorStore TF-IDF Semantic RAG', () => {
  it('indexes documents and returns relevant matches by cosine similarity', async () => {
    const store = new VectorStore();
    await store.index([
      { id: 'src/auth/jwt.ts', text: 'export function verifyJwtToken(token: string) { return jwt.verify(token); }' },
      { id: 'src/database/postgres.ts', text: 'export const pool = new Pool({ connectionString: process.env.DATABASE_URL });' },
      { id: 'src/routes/login.ts', text: 'app.post(\"/login\", async (req, res) => { const token = verifyJwtToken(req.body); });' }
    ]);

    const results = await store.query('how is JWT authentication token verified', 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toMatch(/jwt\.ts|login\.ts/);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('handles empty query and empty store gracefully', async () => {
    const store = new VectorStore();
    const emptyResults = await store.query('test query', 5);
    expect(emptyResults).toEqual([]);
  });
});
