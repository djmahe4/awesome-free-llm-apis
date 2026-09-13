export interface DocumentNode {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
}

export class VectorStore {
  private docs: Map<string, { tfidf: Map<string, number>; magnitude: number }> = new Map();
  private docFrequencies: Map<string, number> = new Map();
  private totalDocs = 0;

  async index(nodes: DocumentNode[]): Promise<void> {
    this.docs.clear();
    this.docFrequencies.clear();
    this.totalDocs = nodes.length;

    if (this.totalDocs === 0) return;

    // Phase 1: Compute TF per doc and document frequency for corpus
    const docTermCounts: Array<{ id: string; terms: Map<string, number>; totalTokens: number }> = [];

    for (const node of nodes) {
      const tokens = this.tokenize(node.text);
      const counts = new Map<string, number>();
      for (const token of tokens) {
        counts.set(token, (counts.get(token) || 0) + 1);
      }
      docTermCounts.push({ id: node.id, terms: counts, totalTokens: tokens.length });

      // Unique terms for DF
      for (const term of counts.keys()) {
        this.docFrequencies.set(term, (this.docFrequencies.get(term) || 0) + 1);
      }
    }

    // Phase 2: Compute TF-IDF vectors
    for (const doc of docTermCounts) {
      const vec = new Map<string, number>();
      let sumSquares = 0;

      for (const [term, count] of doc.terms.entries()) {
        const tf = count / Math.max(1, doc.totalTokens);
        const df = this.docFrequencies.get(term) || 1;
        const idf = Math.log(1 + this.totalDocs / df);
        const weight = tf * idf;
        vec.set(term, weight);
        sumSquares += weight * weight;
      }

      const magnitude = Math.sqrt(sumSquares);
      this.docs.set(doc.id, { tfidf: vec, magnitude: magnitude || 1 });
    }
  }

  async query(queryText: string, topK = 5): Promise<VectorSearchResult[]> {
    if (this.docs.size === 0 || !queryText?.trim()) return [];

    const queryTokens = this.tokenize(queryText);
    if (queryTokens.length === 0) return [];

    const qCounts = new Map<string, number>();
    for (const t of queryTokens) {
      qCounts.set(t, (qCounts.get(t) || 0) + 1);
    }

    const qVec = new Map<string, number>();
    let qSumSquares = 0;

    for (const [term, count] of qCounts.entries()) {
      const tf = count / queryTokens.length;
      const df = this.docFrequencies.get(term) || 1;
      const idf = Math.log(1 + Math.max(1, this.totalDocs) / df);
      const weight = tf * idf;
      qVec.set(term, weight);
      qSumSquares += weight * weight;
    }

    const qMagnitude = Math.sqrt(qSumSquares) || 1;
    const scores: VectorSearchResult[] = [];

    for (const [docId, { tfidf, magnitude }] of this.docs.entries()) {
      let dotProduct = 0;
      for (const [term, qWeight] of qVec.entries()) {
        const docWeight = tfidf.get(term);
        if (docWeight !== undefined) {
          dotProduct += qWeight * docWeight;
        }
      }

      const cosine = dotProduct / (qMagnitude * magnitude);
      if (cosine > 0) {
        scores.push({ id: docId, score: cosine });
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}
