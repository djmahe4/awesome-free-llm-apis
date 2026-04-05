import { ProviderRegistry } from '../src/providers/registry.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { TaskType } from '../src/pipeline/middleware.js';

/**
 * Diagnostic tool to identify missing model-provider mappings 
 * and visualize provider-to-task coverage.
 */
async function run() {
    const registry = ProviderRegistry.getInstance();
    const allProviders = registry.getAllProviders();
    const routerMap = IntelligentRouterMiddleware.taskRouteMap;

    const registeredModels = new Set<string>();
    const providerModelMap: Record<string, string[]> = {};

    allProviders.forEach(p => {
        providerModelMap[p.id] = p.models.map(m => m.id);
        p.models.forEach(m => registeredModels.add(m.id));
    });

    console.log('\n=================================================');
    console.log('   INTELLIGENT ROUTER MODEL DIAGNOSTICS');
    console.log('=================================================\n');

    const routerModels = new Set<string>();
    const modelToTasks: Record<string, string[]> = {};
    
    for (const [task, models] of Object.entries(routerMap)) {
        models.forEach(m => {
            routerModels.add(m);
            if (!modelToTasks[m]) modelToTasks[m] = [];
            modelToTasks[m].push(task);
        });
    }

    console.log('--- 1. ORPHANED MODELS ---');
    console.log('(In Router but NOT in any Provider - These will always fail)\n');
    const orphaned = [...routerModels].filter(m => !registeredModels.has(m));
    if (orphaned.length > 0) {
        orphaned.forEach(m => {
            console.log(`  [!] ${m.padEnd(40)} used in: ${modelToTasks[m].join(', ')}`);
        });
    } else {
        console.log('  ✅ None! All router models are registered in providers.');
    }

    console.log('\n--- 2. UNDERUTILIZED MODELS ---');
    console.log('(In Providers but NOT used by Router - Potential opportunities)\n');
    const missing = [...registeredModels].filter(m => !routerModels.has(m));
    if (missing.length > 0) {
        missing.forEach(m => {
            const provider = allProviders.find(p => p.models.some(pm => pm.id === m));
            console.log(`  [ ] ${m.padEnd(40)} (Provider: ${provider?.id})`);
        });
    } else {
        console.log('  ✅ None! All provider models are utilized by the router.');
    }

    console.log('\n--- 3. PROVIDER -> TASK COVERAGE MATRIX ---');
    console.log('(X = Provider has at least one model assigned to this task)\n');
    
    const taskTypes = Object.values(TaskType);
    const header = 'Provider'.padEnd(20) + ' | ' + taskTypes.map(t => t.substring(0, 4).toUpperCase()).join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));

    allProviders.forEach(p => {
        let row = p.id.padEnd(20) + ' | ';
        taskTypes.forEach(t => {
            const modelsInTask = routerMap[t] || [];
            const hasModelForTask = modelsInTask.some(mId => p.models.some(m => m.id === mId));
            row += (hasModelForTask ? '  X ' : '    ') + ' | ';
        });
        console.log(row);
    });

    console.log('\nLegend:');
    taskTypes.forEach(t => {
        console.log(`  ${t.substring(0, 4).toUpperCase()}: ${t}`);
    });
    console.log('\n');
}

run().catch(console.error);
