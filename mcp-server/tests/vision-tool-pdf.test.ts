import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';

const { renderPdfPageMock } = vi.hoisted(() => ({
  renderPdfPageMock: vi.fn(),
}));

vi.mock('../src/utils/PdfRenderer.js', () => ({
  renderPdfPage: renderPdfPageMock,
}));

const mockProvider = {
  id: 'gemini',
  name: 'Gemini',
  models: [{ id: 'gemini-3.1-flash-lite' }],
  visionModels: [{ id: 'gemini-3.1-flash-lite' }],
  isAvailable: () => true,
  chat: vi.fn().mockResolvedValue({
    id: 'test-resp',
    choices: [{ message: { role: 'assistant', content: 'This is a visual analysis of page 1.' } }],
    model: 'gemini-3.1-flash-lite'
  })
};

vi.mock('../src/providers/registry.js', () => ({
  ProviderRegistry: {
    getInstance: () => ({
      getAvailableProviders: () => [mockProvider],
      getAvailableVisionModels: () => [{ provider: mockProvider, model: { id: 'gemini-3.1-flash-lite' } }],
      getProvider: () => mockProvider,
    })
  }
}));

import { visionTool } from '../src/tools/vision-tool.js';
import { getSharedResponseCache } from '../src/pipeline/instances.js';

describe('vision_tool PDF Ingestion', () => {
  const dummyPdfPath = path.join(process.cwd(), 'scratch', 'test_doc.pdf');
  const dummyPngPath = path.join(process.cwd(), 'scratch', 'rendered_p1.png');

  beforeEach(async () => {
    await fs.mkdir(path.dirname(dummyPdfPath), { recursive: true });
    await fs.writeFile(dummyPdfPath, '%PDF-1.5 test binary');
    await fs.writeFile(dummyPngPath, 'fake-png-data');
    mockProvider.chat.mockClear();
    renderPdfPageMock.mockReset();
    getSharedResponseCache().clear();
  });

  it('renders PDF to PNG and extracts text when image_path is a .pdf', async () => {
    renderPdfPageMock.mockResolvedValue({
      text: 'Extracted PDF Page 1 Content: Ethical Hacking Report',
      image_path: dummyPngPath,
      total_pages: 5,
      image_coverage_ratio: 0.25,
      image_blocks: []
    });

    const fileUri = `file:///${dummyPdfPath.replace(/\\/g, '/')}`;
    const result = await visionTool({
      image_path: fileUri,
      prompt: `Analyze visual charts on this page ${Date.now()}`
    });

    expect(renderPdfPageMock).toHaveBeenCalledWith(
      path.resolve(dummyPdfPath),
      1,
      expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) }),
    );
    expect(result.response).toContain('This is a visual analysis of page 1.');
    expect(result.status).toBe('completed');
    expect(result.pdf).toMatchObject({ page: 1, totalPages: 5, textExtracted: true, visualPageRendered: true });
    expect(mockProvider.chat).toHaveBeenCalled();
    const chatCall = mockProvider.chat.mock.calls[0][0];
    const imageUrlItem = chatCall.messages[0].content.find((c: any) => c.type === 'image_url');
    expect(imageUrlItem).toBeDefined();
    expect(imageUrlItem.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('handles page specification suffix in PDF URI (e.g. .pdf:3)', async () => {
    renderPdfPageMock.mockResolvedValue({
      text: 'Extracted Page 3 Text',
      image_path: dummyPngPath,
      total_pages: 5,
      image_coverage_ratio: 0.10,
    });

    const fileUri = `file:///${dummyPdfPath.replace(/\\/g, '/')}:3`;
    const result = await visionTool({
      image_path: fileUri,
      prompt: 'Analyze page 3'
    });

    expect(renderPdfPageMock).toHaveBeenCalledWith(path.resolve(dummyPdfPath), 3, expect.any(Object));
    expect(result.response).toBeDefined();
    expect(result.pdf?.page).toBe(3);
  });

  it('reports an empty provider response as a failed task and can retry it with continue', async () => {
    renderPdfPageMock.mockResolvedValue({
      text: 'PDF text', image_path: dummyPngPath, total_pages: 1,
    });
    const taskId = `empty-response-${Date.now()}`;
    mockProvider.chat.mockResolvedValueOnce({
      id: 'empty', choices: [], model: 'gemini-3.1-flash-lite',
    } as any);

    const failed = await visionTool({
      image_path: `file:///${dummyPdfPath.replace(/\\/g, '/')}`,
      prompt: `check empty response ${Date.now()}`,
      taskId,
    });
    expect(failed.status).toBe('failed');
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe('VISION_EMPTY_RESPONSE');

    mockProvider.chat.mockResolvedValueOnce({
      id: 'retry',
      choices: [{ message: { role: 'assistant', content: 'Retry succeeded.' } }],
      model: 'gemini-3.1-flash-lite',
    } as any);
    const retried = await visionTool({ action: 'continue', taskId });
    expect(retried.status).toBe('completed');
    expect(retried.response).toContain('Retry succeeded.');
  });

  it('returns a task id while work is still running, then exposes task status', async () => {
    const originalWait = process.env.VISION_TOOL_RESPONSE_WAIT_MS;
    process.env.VISION_TOOL_RESPONSE_WAIT_MS = '1';
    let release!: (value: any) => void;
    mockProvider.chat.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as any);
    const taskId = `running-${Date.now()}`;
    try {
      const started = await visionTool({
        image_path: `file:///${dummyPngPath.replace(/\\/g, '/')}`,
        prompt: `slow image task ${Date.now()}`,
        taskId,
      });
      expect(started.status).toBe('running');
      expect(started.taskId).toBe(taskId);
      for (let attempt = 0; attempt < 50 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(release).toBeTypeOf('function');
      release({
        id: 'done',
        choices: [{ message: { role: 'assistant', content: 'Task finished.' } }],
        model: 'gemini-3.1-flash-lite',
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        const status = await visionTool({ action: 'status', taskId });
        if (status.status !== 'running') {
          expect(status.status).toBe('completed');
          expect(status.response).toContain('Task finished.');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Vision task did not finish after its provider response was released.');
    } finally {
      if (originalWait === undefined) delete process.env.VISION_TOOL_RESPONSE_WAIT_MS;
      else process.env.VISION_TOOL_RESPONSE_WAIT_MS = originalWait;
    }
  });
});
