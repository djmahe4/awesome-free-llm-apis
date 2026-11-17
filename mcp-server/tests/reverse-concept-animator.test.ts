import { describe, it, expect, vi } from 'vitest';
import { ConceptAnimator, AST_DESIGN_TEMPLATES } from '../src/reverse/concept-animator.js';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('ConceptAnimator & animate_concept', () => {
  it('has all 5 marketing/educational AST design templates defined', () => {
    expect(AST_DESIGN_TEMPLATES).toHaveProperty('cyber');
    expect(AST_DESIGN_TEMPLATES).toHaveProperty('configurator');
    expect(AST_DESIGN_TEMPLATES).toHaveProperty('exploded');
    expect(AST_DESIGN_TEMPLATES).toHaveProperty('timeline');
    expect(AST_DESIGN_TEMPLATES).toHaveProperty('minimalist');

    expect(AST_DESIGN_TEMPLATES.cyber.features).toContain('particle_streams');
    expect(AST_DESIGN_TEMPLATES.configurator.features).toContain('orbit_controls');
    expect(AST_DESIGN_TEMPLATES.exploded.features).toContain('exploded_layers');
    expect(AST_DESIGN_TEMPLATES.timeline.features).toContain('spline_trajectory');
    expect(AST_DESIGN_TEMPLATES.minimalist.features).toContain('monochrome_lattice');
  });

  it('builds standalone HTML with error boundary and Three.js canvas', () => {
    const animator = ConceptAnimator.getInstance();
    const html = animator.buildStandaloneHtml({
      concept: 'Transformer Self-Attention',
      style: 'cyber',
      facts: [
        {
          title: 'Attention Is All You Need',
          url: 'https://arxiv.org/abs/1706.03762',
          snippet: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...',
          provider: 'parallel-ai',
        },
      ],
      reactThreeCode: 'console.log("initialized scene");',
    });

    expect(html).toContain('Transformer Self-Attention - 3D Visualizer');
    expect(html).toContain('id="canvas-container"');
    expect(html).toContain('id="error-boundary"');
    expect(html).toContain('Attention Is All You Need');
    expect(html).toContain('https://arxiv.org/abs/1706.03762');
    expect(html).toContain('console.log("initialized scene");');
  });

  it('generates an animation artifact through reverse_tool handleReverseTool', async () => {
    const res = await handleReverseTool({
      action: 'animate_concept',
      target: 'Diffusion Probabilistic Models',
      options: {
        style: 'timeline',
      },
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('animate_concept');
    const artifact = res.data as any;
    expect(artifact).toBeDefined();
    expect(artifact.concept).toBe('Diffusion Probabilistic Models');
    expect(artifact.style).toBe('timeline');
    expect(artifact.artifactId).toMatch(/^anim-/);
    expect(artifact.htmlBundle).toContain('Diffusion Probabilistic Models - 3D Visualizer');
  });

  it('rejects animate_concept when target concept is missing', async () => {
    const res = await handleReverseTool({
      action: 'animate_concept',
      target: '',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Target concept or methodology name is required');
  });

  it('supports followup prompt refinement with artifactId', async () => {
    const animator = ConceptAnimator.getInstance();
    const art1 = await animator.generateAnimation('RAFT Consensus', { style: 'configurator' });
    expect(art1.artifactId).toBeDefined();

    const art2 = await animator.generateAnimation('RAFT Consensus', {
      style: 'configurator',
      artifactId: art1.artifactId,
      followupPrompt: 'Speed up packet transit and highlight leader election state',
    });

    expect(art2.artifactId).toBe(art1.artifactId);
    expect(art2.htmlBundle).toContain('RAFT Consensus');
  });
});
