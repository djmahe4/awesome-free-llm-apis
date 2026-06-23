import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { RepositoryGraph, WorkspaceDependencyScanner, semanticScore } from '../src/memory/dependency-scanner.js';
import { WorkspaceIndexer } from '../src/memory/indexer.js';
import { enrichWithGraph } from '../src/middleware/agentic/context-gatherer.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { memoryManager } from '../src/memory/index.js';

describe('Semantic Graph & Vector Profiling', () => {
    const testWs = path.join(process.cwd(), 'temp_test_semantic_ws');

    beforeEach(async () => {
        rmSync(testWs, { recursive: true, force: true });
        mkdirSync(testWs, { recursive: true });
        
        const scanner = new (await import('../src/cache/workspace.js')).WorkspaceScanner(testWs);
        const wsHash = await scanner.getWorkspaceHash(testWs);
        await memoryManager.clear(wsHash);
    });

    afterAll(() => {
        rmSync(testWs, { recursive: true, force: true });
    });

    it('should generate a semantic profile with exports, imports, and docstring', () => {
        const fileContent = `
/**
 * This is a test module that coordinates tasks.
 * It provides core agentic planning.
 */
import { foo } from './foo.js';
import express from 'express';

export class PlannerService {
    plan() {}
}

export function executePlan() {}
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(fileContent, '.ts');

        expect(profile.docstring).toContain('coordinates tasks');
        expect(profile.exports).toContain('PlannerService');
        expect(profile.exports).toContain('executePlan');
        expect(profile.imports).toContain('./foo.js');
        expect(profile.imports).toContain('express');
    });

    it('should support Solidity semantic profiling', () => {
        const content = `
/** @title Voting contract
 * @notice Provides secure voting mechanism
 */
import "./Ownable.sol";
import { Member } from "./Members.sol";

contract Voting {
    function vote() public {}
}
interface IVoter {}
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, '.sol');
        expect(profile.docstring).toContain('Voting contract');
        expect(profile.imports).toContain('./Ownable.sol');
        expect(profile.imports).toContain('./Members.sol');
        expect(profile.exports).toContain('Voting');
        expect(profile.exports).toContain('IVoter');
    });

    it('should support Rust semantic profiling', () => {
        const content = `
/// Handles parsing workflows.
/// Extremely fast.
use std::collections::HashMap;
use crate::ast::Node;

pub struct Parser {}
pub enum Token { Ident }
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, '.rs');
        expect(profile.docstring).toContain('Handles parsing workflows.');
        expect(profile.imports).toContain('std::collections::HashMap');
        expect(profile.exports).toContain('Parser');
        expect(profile.exports).toContain('Token');
    });

    it('should support Java semantic profiling', () => {
        const content = `
/**
 * Core database service class.
 */
import java.sql.Connection;
import javax.sql.DataSource;

public class DatabaseService {
    public void connect() {}
}
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, '.java');
        expect(profile.docstring).toContain('Core database service class.');
        expect(profile.imports).toContain('java.sql.Connection');
        expect(profile.exports).toContain('DatabaseService');
    });

    it('should support Dart semantic profiling', () => {
        const content = `
/// Renders standard buttons.
import 'package:flutter/material.dart';
import 'button_theme.dart';

class CustomButton extends StatelessWidget {}
enum ButtonState { idle }
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, '.dart');
        expect(profile.docstring).toContain('Renders standard buttons.');
        expect(profile.imports).toContain('package:flutter/material.dart');
        expect(profile.exports).toContain('CustomButton');
        expect(profile.exports).toContain('ButtonState');
    });

    it('should support Go semantic profiling', () => {
        const content = `
// Package logger provides structured logging.
package logger

import (
    "fmt"
    "os"
)

type LogManager struct {}
func NewLogger() *LogManager { return &LogManager{} }
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, '.go');
        expect(profile.docstring).toContain('Package logger provides structured logging.');
        expect(profile.imports).toContain('fmt');
        expect(profile.imports).toContain('os');
        expect(profile.exports).toContain('LogManager');
        expect(profile.exports).toContain('NewLogger');
    });

    it('should support C++ semantic profiling', () => {
        const content = `
/**
 * Vector processor.
 */
#include <iostream>
#include "processor.h"

class VectorProcessor {};
struct ProcessingNode {};
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, '.cpp');
        expect(profile.docstring).toContain('Vector processor.');
        expect(profile.imports).toContain('iostream');
        expect(profile.imports).toContain('processor.h');
        expect(profile.exports).toContain('VectorProcessor');
        expect(profile.exports).toContain('ProcessingNode');
    });

    it('should support Kotlin semantic profiling', () => {
        const content = `
/**
 * Main application service.
 */
import kotlinx.coroutines.flow
import com.example.Config

class AppService {}
fun initializeApp() {}
        `;
        const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, '.kt');
        expect(profile.docstring).toContain('Main application service.');
        expect(profile.imports).toContain('kotlinx.coroutines.flow');
        expect(profile.exports).toContain('AppService');
        expect(profile.exports).toContain('initializeApp');
    });

    it('should score semantic nodes correctly in RepositoryGraph', () => {
        const graph = new RepositoryGraph(testWs);
        
        graph.addNode('src/planner.ts', 'code', { language: 'typescript', size: 100, commands: [] });
        graph.addNode('src/executor.ts', 'code', { language: 'typescript', size: 100, commands: [] });
        graph.addNode('docs/architecture.md', 'doc', { size: 100 });

        // Connect them (planner imports executor)
        graph.addEdge('src/planner.ts', 'src/executor.ts', 'imports');
        
        // Match planner keyword without docs
        const scoredNoDocs = semanticScore('planner query', graph, false);
        expect(scoredNoDocs.length).toBe(1);
        expect(scoredNoDocs[0].node.id).toBe('src/planner.ts');

        // Match with docs
        const scoredWithDocs = semanticScore('architecture planner', graph, true);
        expect(scoredWithDocs.length).toBe(2);
        const ids = scoredWithDocs.map(s => s.node.id);
        expect(ids).toContain('docs/architecture.md');
        expect(ids).toContain('src/planner.ts');
    });

    it('should inject graph context if file matches', async () => {
        writeFileSync(path.join(testWs, 'test_executor.ts'), `
export class WorkflowExecutor {}
        `);
        writeFileSync(path.join(testWs, 'test_planner.ts'), `
import { WorkflowExecutor } from './test_executor.js';
/**
 * Handles agentic workflows.
 */
export class WorkflowManager {}
        `);

        // Index the workspace to create graph
        const indexer = new WorkspaceIndexer(testWs);
        await indexer.indexWorkspace(testWs, true);

        // Verify graph exists
        const mcpDir = path.join(testWs, '.free-llm-mcp');
        const graphPath = path.join(mcpDir, 'repo_graph.json');
        expect(existsSync(graphPath)).toBe(true);

        const results: string[] = [];
        await enrichWithGraph(testWs, ['test_planner.ts'], 'workflow manager', results);

        expect(results.some(r => r.includes('[Graph-Context]') && r.includes('test_executor.ts'))).toBe(true);
    });
});
