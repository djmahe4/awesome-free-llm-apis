import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getIntelligentSystemPrompt } from '../../src/pipeline/middlewares/prompts.js';
import { ShortTermMemory } from '../../src/memory/short-term.js';
import { WorkspaceContextMiddleware } from '../../src/pipeline/middlewares/WorkspaceContextMiddleware.js';

const AVST_ROOT = 'C:/dev/AVST';

interface ObservationResult {
    archetype: string;
    prompt: string;
    assembledLengthChars: number;
    estimatedTokens: number;
    hasGuidelinesBlock: boolean;
    extractedHeaders: string[];
    matchedKeywords: string[];
    loopholes: string[];
}

async function runObservation() {
    console.log(`======================================================================`);
    console.log(`🔍 [AVST AGENTS.md Context Injection & Memory Observation Probe]`);
    console.log(`   Target Workspace: ${AVST_ROOT}`);
    console.log(`======================================================================\n`);

    // Verify AVST AGENTS.md existence
    const agentsMdPath = path.join(AVST_ROOT, '.agents', 'AGENTS.md');
    try {
        const stat = await fs.stat(agentsMdPath);
        console.log(`📄 Found target AGENTS.md (${stat.size} bytes)\n`);
    } catch {
        console.error(`❌ Cannot find ${agentsMdPath}`);
        process.exit(1);
    }

    const stm = new ShortTermMemory(60000);

    const testPrompts = [
        {
            archetype: '1. Persona/Role Execution (Adhil)',
            prompt: 'Adhil needs to audit docstrings and update LaTeX sync mappings with @doc annotations',
            expectedKeywords: ['Adhil', 'docstring', 'LaTeX', 'code-documentation-architect']
        },
        {
            archetype: '2. Git & Commit Cadence Rules',
            prompt: 'How often should we push git commits to remote origin and what is the diary format?',
            expectedKeywords: ['2 commits', 'push', 'DAILY_DIARY', 'cadence']
        },
        {
            archetype: '3. Tool & Sandbox Battery',
            prompt: 'Run triage binary tool battery on ELF artifact with container-first execution',
            expectedKeywords: ['triage', 'ctf-tools:latest', 'binary', 'sandbox']
        },
        {
            archetype: '4. Memory & Blackboard Relay',
            prompt: 'How does relay.py handoff session state between laptops via blackboard without cloud?',
            expectedKeywords: ['blackboard', 'relay.py', 'handoff', 'shared.jsonl']
        },
        {
            archetype: '5. Multi-turn Follow-up Turn',
            prompt: 'Now check what is Arunima branch rule and mentor UI port',
            expectedKeywords: ['arunima/dev-week-X', '8080', 'mentor-ui']
        }
    ];

    const results: ObservationResult[] = [];

    for (let i = 0; i < testPrompts.length; i++) {
        const item = testPrompts[i];
        console.log(`▶ Evaluating: ${item.archetype}`);
        console.log(`  Prompt: "${item.prompt}"`);

        // Record into short term memory
        stm.set(`turn_${i}_query`, item.prompt);

        const assembled = await getIntelligentSystemPrompt({
            context: item.prompt,
            workspaceRoot: AVST_ROOT
        });

        const hasGuidelines = assembled.includes('TARGET PROJECT GUIDELINES');
        const extractedHeaders = [...assembled.matchAll(/#{2,4}\s+([^\n]+)/g)].map(m => m[1]);
        const matched = item.expectedKeywords.filter(kw => assembled.toLowerCase().includes(kw.toLowerCase()));

        const loopholes: string[] = [];
        if (!hasGuidelines) {
            loopholes.push('TARGET PROJECT GUIDELINES gate completely missing');
        }
        if (assembled.length > 15000) {
            loopholes.push(`Context bloat: ${assembled.length} chars (>15k limit)`);
        }
        if (matched.length === 0) {
            loopholes.push(`Zero expected keywords retrieved from AGENTS.md`);
        }

        // Check if nested subsection was fetched vs top intro
        if (item.archetype.includes('Git') && !assembled.includes('1.4 Frequent Commits') && !assembled.includes('2 commits')) {
            loopholes.push('Failed to retrieve nested subsection §1.4 for push cadence');
        }

        results.push({
            archetype: item.archetype,
            prompt: item.prompt,
            assembledLengthChars: assembled.length,
            estimatedTokens: Math.ceil(assembled.length / 3.8),
            hasGuidelinesBlock: hasGuidelines,
            extractedHeaders,
            matchedKeywords: matched,
            loopholes
        });

        console.log(`  Chars: ${assembled.length} (~${Math.ceil(assembled.length / 3.8)} tokens)`);
        console.log(`  Guidelines block: ${hasGuidelines ? '✅ YES' : '❌ NO'}`);
        console.log(`  Headers captured: ${extractedHeaders.slice(0, 4).join(' | ')}`);
        console.log(`  Keywords matched: ${matched.join(', ') || 'None'}`);
        if (loopholes.length > 0) {
            console.log(`  ⚠️ Loopholes: ${loopholes.join('; ')}`);
        }
        console.log('');
    }

    // Pipeline Middleware Test (Checking whether WorkspaceContextMiddleware passes workspaceRoot)
    console.log(`▶ Evaluating: WorkspaceContextMiddleware -> getIntelligentSystemPrompt wiring`);
    const middleware = new WorkspaceContextMiddleware();
    const mockCtx: any = {
        request: {
            messages: [{ role: 'user', content: 'What is the git push cadence in AVST?' }],
            model: 'gpt-4o'
        },
        workspaceRoot: AVST_ROOT,
        sessionId: 'obs-session-1'
    };

    await middleware.execute(mockCtx, async () => {});
    const fullPrompt = mockCtx.telemetry?.steeringTelemetry?.fullAssembledSystemPrompt || '';
    const middlewareInjectedGuidelines = fullPrompt.includes('TARGET PROJECT GUIDELINES');
    console.log(`  Middleware Injected Guidelines: ${middlewareInjectedGuidelines ? '✅ YES' : '❌ NO (LOOPHOLE 1 CONFIRMED)'}\n`);

    console.log(`======================================================================`);
    console.log(`📊 SUMMARY OBSERVATION REPORT`);
    console.log(`======================================================================`);
    results.forEach(r => {
        console.log(`[${r.archetype}]`);
        console.log(`  Tokens: ~${r.estimatedTokens} | Guidelines: ${r.hasGuidelinesBlock}`);
        console.log(`  Matched: ${r.matchedKeywords.length} keywords`);
        console.log(`  Loopholes: ${r.loopholes.length > 0 ? r.loopholes.join(' | ') : 'None'}`);
    });

    console.log(`\nShortTermMemory entries: ${stm.size()}`);
    const turns = stm.getByPrefix('turn_');
    console.log(`  stm.getByPrefix('turn_') count: ${turns.length} (expected 5)`);
    const recent = stm.getRecentEntries(3);
    console.log(`  stm.getRecentEntries(3) count: ${recent.length} (expected 3, newest: "${(recent[0].value as string).slice(0, 30)}...")`);
}

runObservation().catch(console.error);
