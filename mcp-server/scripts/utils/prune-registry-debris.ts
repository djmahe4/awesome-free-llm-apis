/**
 * Removes leaked `test-tool-<timestamp>` entries from the cyber-tools registry.
 *
 *   npx tsx scripts/utils/prune-registry-debris.ts           # dry-run (default): lists what would go
 *   npx tsx scripts/utils/prune-registry-debris.ts --apply   # writes a .bak-<timestamp> copy first, then prunes
 *
 * Only entries matching `test-tool-<digits>` pointing at the fake github.com/example/ origin
 * are touched; every real tool is kept verbatim.
 */
import { CyberToolsRegistry } from '../../src/utils/CyberToolsRegistry.js';

const apply = process.argv.includes('--apply');
const result = await CyberToolsRegistry.pruneTestDebris({ dryRun: !apply });

console.error(`registry : ${CyberToolsRegistry.getRegistryFilePath()}`);
console.error(`${apply ? 'removed' : 'would remove'} ${result.removed.length} test-debris entr${result.removed.length === 1 ? 'y' : 'ies'}; ${result.kept} kept`);
if (result.backupPath) console.error(`backup   : ${result.backupPath}`);
if (!apply && result.removed.length > 0) console.error('re-run with --apply to write the change (a backup is made first).');
