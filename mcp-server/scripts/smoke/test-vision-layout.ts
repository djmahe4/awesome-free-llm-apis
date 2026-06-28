import { visionTool } from '../../src/tools/vision-tool.js';
import { saveFixture } from './fixture-helper.js';
import path from 'node:path';
import fs from 'fs-extra';

export async function runVisionLayoutTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case B] Running Visual Layout Analysis via vision_tool...');

    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const rawPath = path.join(workspaceRoot, 'mock_ui_screenshot.png');
    await fs.writeFile(rawPath, Buffer.from(base64Png, 'base64'));

    const imagePath = 'file:///' + rawPath.replace(/\\/g, '/');

    try {
        const result = await visionTool({
            image_path: imagePath,
            prompt: 'Please check this UI layout screenshot and describe its color palette and composition.',
            model,
            workspace_root: workspaceRoot,
            sessionId: 'smoke-session-vision-layout'
        } as any);

        await saveFixture('case-b', result);

        const responseText = result.response || '';
        const decomposed = responseText.includes("I've broken your request into");
        console.log(`[+] Case B LLM Response Snippet:\n---\n${responseText.substring(0, 500)}...\n---`);
        console.log('✅ Case B Passed: Vision tool executed successfully.');
        return { success: true, decomposed };
    } catch (err: any) {
        console.error(`[-] Case B Failed: ${err.message}`);
        return { success: false, decomposed: false };
    }
}
