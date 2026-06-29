import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { RepositoryGraph, WorkspaceDependencyScanner } from '../src/memory/dependency-scanner.js';
import { WorkspaceIndexer } from '../src/memory/indexer.js';

describe('Dependency & Concept Cache', () => {
  let tempDir: string;
  let mcpDir: string;

  beforeEach(async () => {
    // Set up a temporary directory representing a mock workspace root
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-workspace-'));
    mcpDir = path.join(tempDir, '.free-llm-mcp');
    await fs.mkdir(mcpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Parsers & Extraction', () => {
    it('should extract TypeScript/JavaScript imports correctly', async () => {
      // Create imported files so they exist in workspace files set
      await fs.mkdir(path.join(tempDir, 'src/middleware/agentic'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'src/middleware/agentic/agentic-middleware.ts'), 'export const agenticMiddleware = {}');
      await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'config/config.json'), '{}');
      await fs.writeFile(path.join(tempDir, 'src/dynamic-import.ts'), 'export const dynamic = {}');

      const code = `
        import express from 'express';
        import { agenticMiddleware } from './middleware/agentic/agentic-middleware.js';
        const config = require('../config/config.json');
        const dynamic = await import('./dynamic-import');
      `;
      const tempFile = path.join(tempDir, 'src/server.ts');
      await fs.writeFile(tempFile, code);

      const scanner = new WorkspaceDependencyScanner(tempDir);
      const graph = new RepositoryGraph(tempDir);
      await scanner.scanWorkspace(graph); // Scan workspace to populate files set and parse files

      const node = graph.getNode('src/server.ts');
      expect(node).toBeDefined();
      expect(node?.type).toBe('code');

      const edges = graph.getEdgesFrom('src/server.ts');
      expect(edges).toContainEqual(expect.objectContaining({ target: 'express', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'src/middleware/agentic/agentic-middleware.ts', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'config/config.json', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'src/dynamic-import.ts', type: 'imports' }));
    });

    it('should extract Python imports and command docstrings', async () => {
      await fs.mkdir(path.join(tempDir, 'utils'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'utils/helper.py'), 'def helper_func(): pass');
      await fs.writeFile(path.join(tempDir, 'local_mod.py'), 'something = 1');

      const pyCode = `
\"\"\"
Usage instructions:
python run_pipeline.py --input data.json
\"\"\"
import os
import sys
from utils.helper import helper_func
from .local_mod import something
      `;
      const tempFile = path.join(tempDir, 'run_pipeline.py');
      await fs.writeFile(tempFile, pyCode);

      const scanner = new WorkspaceDependencyScanner(tempDir);
      const graph = new RepositoryGraph(tempDir);
      await scanner.scanWorkspace(graph);

      const node = graph.getNode('run_pipeline.py');
      expect(node).toBeDefined();
      expect(node?.metadata?.commands).toContain('python run_pipeline.py --input data.json');

      const edges = graph.getEdgesFrom('run_pipeline.py');
      expect(edges).toContainEqual(expect.objectContaining({ target: 'os', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'utils/helper.py', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'local_mod.py', type: 'imports' }));
    });

    it('should extract Go imports and command comments', async () => {
      await fs.writeFile(path.join(tempDir, 'localutils.go'), 'package localutils');

      const goCode = `
package main
// Execution command: go run main.go
import (
    "fmt"
    "net/http"
    "github.com/gin-gonic/gin"
    "./localutils"
)
      `;
      const tempFile = path.join(tempDir, 'main.go');
      await fs.writeFile(tempFile, goCode);

      const scanner = new WorkspaceDependencyScanner(tempDir);
      const graph = new RepositoryGraph(tempDir);
      await scanner.scanWorkspace(graph);

      const node = graph.getNode('main.go');
      expect(node).toBeDefined();
      expect(node?.metadata?.commands).toContain('go run main.go');

      const edges = graph.getEdgesFrom('main.go');
      expect(edges).toContainEqual(expect.objectContaining({ target: 'fmt', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'github.com/gin-gonic/gin', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'localutils.go', type: 'imports' }));
    });

    it('should extract Rust imports and command comments', async () => {
      await fs.mkdir(path.join(tempDir, 'models'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'models/user.rs'), 'struct User;');

      const rsCode = `
// Run using: cargo run --bin main
use std::collections::HashMap;
use crate::models::user::User;
      `;
      const tempFile = path.join(tempDir, 'main.rs');
      await fs.writeFile(tempFile, rsCode);

      const scanner = new WorkspaceDependencyScanner(tempDir);
      const graph = new RepositoryGraph(tempDir);
      await scanner.scanWorkspace(graph);

      const node = graph.getNode('main.rs');
      expect(node).toBeDefined();
      expect(node?.metadata?.commands).toContain('cargo run --bin main');

      const edges = graph.getEdgesFrom('main.rs');
      expect(edges).toContainEqual(expect.objectContaining({ target: 'std::collections::HashMap', type: 'imports' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'models/user.rs', type: 'imports' }));
    });

    it('should extract conceptual wiki links and PDF references from markdown files', async () => {
      const mdContent = `
# Developer Guide
Refer to the [[ArchitectureDesign]] concept document.
Also look at [[docs/api.pdf#page=14]] for specs.
See [[run_pipeline.py]] for invocation.
      `;
      const tempFile = path.join(tempDir, 'guide.md');
      await fs.writeFile(tempFile, mdContent);

      const scanner = new WorkspaceDependencyScanner(tempDir);
      const graph = new RepositoryGraph(tempDir);
      await scanner.scanWorkspace(graph);

      const node = graph.getNode('guide.md');
      expect(node).toBeDefined();

      const edges = graph.getEdgesFrom('guide.md');
      expect(edges).toContainEqual(expect.objectContaining({ target: 'ArchitectureDesign', type: 'links' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'docs/api.pdf#page=14', type: 'links' }));
      expect(edges).toContainEqual(expect.objectContaining({ target: 'run_pipeline.py', type: 'links' }));
    });
  });

  describe('RepositoryGraph Operations & Neighborhood Retrieval', () => {
    it('should retrieve localized neighborhood for a given node up to specified depth', () => {
      const graph = new RepositoryGraph(tempDir);
      graph.addNode('A', 'code');
      graph.addNode('B', 'code');
      graph.addNode('C', 'code');
      graph.addNode('D', 'concept');

      graph.addEdge('A', 'B', 'imports');
      graph.addEdge('B', 'C', 'imports');
      graph.addEdge('A', 'D', 'links');

      // Neighborhood of A at depth 1 should have B and D, but not C
      const n1 = graph.getNeighborhood('A', 1);
      expect(n1.nodes.map(n => n.id)).toContain('A');
      expect(n1.nodes.map(n => n.id)).toContain('B');
      expect(n1.nodes.map(n => n.id)).toContain('D');
      expect(n1.nodes.map(n => n.id)).not.toContain('C');

      // Neighborhood of A at depth 2 should include C as well
      const n2 = graph.getNeighborhood('A', 2);
      expect(n2.nodes.map(n => n.id)).toContain('C');
    });
  });

  describe('WorkspaceIndexer Integration & Caching Lifecycle', () => {
    it('should build and save repo_graph.json and wiki_links.md', async () => {
      // Setup simple files
      await fs.writeFile(path.join(tempDir, 'main.py'), 'import helper\n# python main.py');
      await fs.writeFile(path.join(tempDir, 'helper.py'), 'def help(): pass');

      const indexer = new WorkspaceIndexer(tempDir);
      await indexer.indexWorkspace(tempDir, true);

      // Check output files
      const graphPath = path.join(mcpDir, 'repo_graph.json');
      const wikiPath = path.join(mcpDir, 'wiki_links.md');

      const graphExists = await fs.access(graphPath).then(() => true).catch(() => false);
      const wikiExists = await fs.access(wikiPath).then(() => true).catch(() => false);

      expect(graphExists).toBe(true);
      expect(wikiExists).toBe(true);

      const wikiContent = await fs.readFile(wikiPath, 'utf8');
      expect(wikiContent).toContain('[[main.py]]');
      expect(wikiContent).toContain('[[helper.py]]');
      expect(wikiContent).toContain('python main.py');
    });
  });

  describe('Agentic Middleware Mocks & Performance Metrics', () => {
    it('should bypass grep calls and use neighborhood lookup for context query', async () => {
      const graph = new RepositoryGraph(tempDir);
      graph.addNode('server.ts', 'code');
      graph.addNode('agentic-middleware.ts', 'code');
      graph.addEdge('server.ts', 'agentic-middleware.ts', 'imports');
      
      const serialized = graph.serialize();
      await fs.writeFile(path.join(mcpDir, 'repo_graph.json'), JSON.stringify(serialized));

      // Mock of ContextGatherer or custom search logic that tracks grep times versus graph query times
      let grepCallsCount = 0;
      const mockGrepSearch = async (query: string) => {
        grepCallsCount++;
        // Simulate grep/rg delay
        await new Promise(r => setTimeout(r, 50)); 
        return ['mock file contents'];
      };

      // Graph search helper
      const queryContext = async (query: string) => {
        const start = Date.now();
        // Load graph from cache
        const graphData = JSON.parse(await fs.readFile(path.join(mcpDir, 'repo_graph.json'), 'utf8'));
        const loadedGraph = RepositoryGraph.deserialize(tempDir, graphData);
        
        // Find matching node
        const matchingNode = loadedGraph.findNodeByKeyword(query);
        if (matchingNode) {
          const neighborhood = loadedGraph.getNeighborhood(matchingNode.id, 2);
          const duration = Date.now() - start;
          return { source: 'graph', data: neighborhood, duration };
        }

        // Fallback to grep
        const results = await mockGrepSearch(query);
        const duration = Date.now() - start;
        return { source: 'grep', data: results, duration };
      };

      // Querying with direct match in graph
      const res1 = await queryContext('server.ts');
      expect(res1.source).toBe('graph');
      expect(res1.duration).toBeLessThan(100); // relaxed for environment compatibility
      expect(grepCallsCount).toBe(0);

      // Querying with missing concept should trigger grep fallback
      const res2 = await queryContext('unrelated_keyword');
      expect(res2.source).toBe('grep');
      expect(res2.duration).toBeGreaterThan(45);
      expect(grepCallsCount).toBe(1);
    });
  });
});
