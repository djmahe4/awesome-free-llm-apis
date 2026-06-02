import * as fs from 'fs/promises';
import { TaskType } from '../../src/pipeline/middleware.js';

export class RouterUpdater {
    constructor(private filePath: string) {}

    private getTaskTypeKey(taskType: string): string {
        const key = Object.keys(TaskType).find(k => TaskType[k as keyof typeof TaskType] === taskType);
        if (!key) {
            console.log(`TaskType values:`, TaskType);
            throw new Error(`Invalid TaskType value: ${taskType}`);
        }
        return key;
    }

    async updateCapability(modelId: string, score: number, isVision: boolean = false): Promise<void> {
        const content = await fs.readFile(this.filePath, 'utf-8');
        const capabilityKey = isVision ? 'imageModelCapabilities' : 'modelCapabilities';
        
        const regex = new RegExp(`(${capabilityKey}:\\s*Record<string, number>\\s*=\\s*\\{)([\\s\\S]*?)(\\n\\s*\\});`, 'g');
        const match = regex.exec(content);

        if (!match) {
            throw new Error(`Could not find ${capabilityKey} in ${this.filePath}`);
        }

        let block = match[2];
        const modelRegex = new RegExp(`('${modelId}'\\s*:\\s*)\\d*\\.?\\d*`, 'g');

        if (modelRegex.test(block)) {
            block = block.replace(modelRegex, `$1${score}`);
        } else {
            block += `\n        '${modelId}': ${score}`;
        }

        const updatedContent = content.replace(match[0], `${match[1]}${block}${match[3]}`);
        await fs.writeFile(this.filePath, updatedContent);
    }

    async addTaskModel(taskType: string, modelId: string): Promise<void> {
        const content = await fs.readFile(this.filePath, 'utf-8');
        const taskTypeKey = this.getTaskTypeKey(taskType);
        const taskTypeEscaped = taskTypeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(\\[TaskType\\.${taskTypeEscaped}\\]\\s*:\\s*\\[)([\\s\\S]*?)(\\]\\s*,?)`);
        
        const match = regex.exec(content);
        if (!match) {
            throw new Error(`Could not find task type ${taskType} in taskRouteMap in ${this.filePath}`);
        }
        
        const prefix = match[1];
        const modelsList = match[2];
        const suffix = match[3];

        const models = modelsList
            .split(',')
            .map(m => m.trim().replace(/^'|'$/g, ''))
            .filter(m => m.length > 0);
        
        if (!models.includes(modelId)) {
            models.push(modelId);
            const formattedModels = models.map(m => `'${m}'`).join(',\n            ');
            const updatedList = `\n            ${formattedModels}\n        `;
            
            const updatedContent = content.replace(match[0], `${prefix}${updatedList}${suffix}`);
            await fs.writeFile(this.filePath, updatedContent);
        }
    }

    async removeTaskModel(taskType: string, modelId: string): Promise<void> {
        const content = await fs.readFile(this.filePath, 'utf-8');
        const taskTypeKey = this.getTaskTypeKey(taskType);
        const taskTypeEscaped = taskTypeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(\\[TaskType\\.${taskTypeEscaped}\\]\\s*:\\s*\\[)([\\s\\S]*?)(\\]\\s*,?)`);
        const match = regex.exec(content);
        if (!match) {
            throw new Error(`Could not find task type ${taskType} in taskRouteMap in ${this.filePath}`);
        }
        
        const prefix = match[1];
        const modelsList = match[2];
        const suffix = match[3];

        const models = modelsList
            .split(',')
            .map(m => m.trim().replace(/^'|'$/g, ''))
            .filter(m => m.length > 0);
        
        if (models.includes(modelId)) {
            const filteredModels = models.filter(m => m !== modelId);
            const formattedModels = filteredModels.map(m => `'${m}'`).join(',\n            ');
            const updatedList = `\n            ${formattedModels}\n        `;
            
            const updatedContent = content.replace(match[0], `${prefix}${updatedList}${suffix}`);
            await fs.writeFile(this.filePath, updatedContent);
        }
    }
}
