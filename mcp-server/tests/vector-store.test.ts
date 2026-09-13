/**
 * Comprehensive integration tests for VectorStore TF-IDF engine.
 * Tests ranking correctness, edge cases, and multi-document accuracy.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VectorStore } from '../src/memory/VectorStore.js';

describe('VectorStore — TF-IDF ranking accuracy', () => {
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore();
  });

  it('ranks the most semantically similar document FIRST (not just >0)', async () => {
    await store.index([
      { id: 'src/auth/jwt.ts', text: 'export function verifyJwtToken(token: string) { return jwt.verify(token, secret); }' },
      { id: 'src/database/postgres.ts', text: 'export const pool = new Pool({ connectionString: process.env.DATABASE_URL });' },
      { id: 'src/routes/login.ts', text: 'app.post("/login", async (req, res) => { const user = await db.findUser(req.body.email); });' },
    ]);

    const results = await store.query('JWT token verification secret key', 3);
    expect(results.length).toBeGreaterThan(0);
    // jwt.ts must rank #1 — it contains the most JWT-specific terminology
    expect(results[0].id).toBe('src/auth/jwt.ts');
    expect(results[0].score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('returns topK results capped at the requested limit', async () => {
    await store.index([
      { id: 'a.ts', text: 'function add(a: number, b: number) { return a + b; }' },
      { id: 'b.ts', text: 'function subtract(a: number, b: number) { return a - b; }' },
      { id: 'c.ts', text: 'function multiply(x: number, y: number) { return x * y; }' },
      { id: 'd.ts', text: 'export class DatabasePool { connect() { return pg.connect(); } }' },
    ]);

    const results = await store.query('number arithmetic operations', 2);
    expect(results).toHaveLength(2);
  });

  it('scores decrease monotonically (results are sorted descending)', async () => {
    await store.index([
      { id: 'logger.ts', text: 'export function log(msg: string) { console.log(msg); }' },
      { id: 'auth.ts', text: 'export function authenticate(user: User) { return bcrypt.compare(user.password, hash); }' },
      { id: 'server.ts', text: 'const app = express(); app.listen(3000); app.use(cors()); app.use(json()); log("started");' },
    ]);

    const results = await store.query('express server application startup', 3);
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it('handles empty query gracefully', async () => {
    await store.index([{ id: 'a.ts', text: 'some content' }]);
    expect(await store.query('', 5)).toEqual([]);
    expect(await store.query('   ', 5)).toEqual([]);
  });

  it('handles empty store gracefully', async () => {
    expect(await store.query('any query', 5)).toEqual([]);
  });

  it('handles query with zero matching tokens gracefully', async () => {
    await store.index([{ id: 'a.ts', text: 'function foo() {}' }]);
    // Query using tokens that have zero IDF weight (not in corpus)
    const results = await store.query('zzzunknownzzztermzzznotzzzinzzzindex', 5);
    expect(results).toEqual([]);
  });

  it('re-indexing clears previous documents', async () => {
    await store.index([{ id: 'old.ts', text: 'old document content with unique xyzOld token' }]);
    await store.index([{ id: 'new.ts', text: 'new document content with unique abcNew token' }]);

    const results = await store.query('xyzOld', 5);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain('old.ts');
  });

  it('handles single-document corpus without division-by-zero', async () => {
    await store.index([{ id: 'solo.ts', text: 'export default function hello() { return "hello world"; }' }]);
    const results = await store.query('hello world function', 3);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('solo.ts');
    expect(Number.isFinite(results[0].score)).toBe(true);
  });
});
