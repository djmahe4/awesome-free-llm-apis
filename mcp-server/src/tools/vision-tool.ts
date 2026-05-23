import path from 'node:path';
import fs from 'node:fs/promises';
import { useFreeLLM } from './use-free-llm.js';
import { toMarkdownResponse } from '../utils/markdown.js';

export interface VisionToolInput {
  workspace_root: string;
  image_path: string; // file:/// absolute URI
  prompt?: string;
  model?: string;
}

export async function visionTool(input: VisionToolInput): Promise<{ response: string; model: string }> {
  const { workspace_root, image_path, prompt, model = 'gemini-2.5-flash' } = input;

  if (!workspace_root || !image_path) {
    throw new Error('vision_tool requires both workspace_root and image_path.');
  }
  if (!image_path.startsWith('file:///')) {
    throw new Error('image_path must use file:/// scheme.');
  }

  const decodedPath = decodeURIComponent(image_path.replace(/^file:\/\//, ''));
  const imageFsPath = path.resolve(decodedPath);
  const ws = path.resolve(workspace_root);

  if (!imageFsPath.startsWith(ws)) {
    throw new Error('image_path must be inside workspace_root boundaries.');
  }

  const stat = await fs.stat(imageFsPath);
  if (!stat.isFile()) {
    throw new Error('image_path does not point to a file.');
  }

  const userPrompt = prompt || 'Analyze this image and provide a concise technical markdown report.';

  const response = await useFreeLLM({
    model,
    workspace_root,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: image_path } }
        ]
      }
    ]
  });

  const content = response?.choices?.[0]?.message?.content || '';
  return {
    response: toMarkdownResponse(typeof content === 'string' ? content : JSON.stringify(content, null, 2)),
    model: response.model || model
  };
}

