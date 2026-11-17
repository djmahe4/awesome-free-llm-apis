import { handleReverseTool } from '../../src/tools/reverse-tool.js';

async function runSmoke() {
  console.log('=== Running Concept Animator Live Smoke ===');
  const res = await handleReverseTool({
    action: 'animate_concept',
    target: 'Transformer Multi-Head Attention',
    options: {
      style: 'cyber',
      offlineOnly: true,
    },
  });

  console.log('Success:', res.success);
  console.log('Action:', res.action);
  const data = res.data as any;
  console.log('Artifact ID:', data?.artifactId);
  console.log('Concept:', data?.concept);
  console.log('Style:', data?.style);
  console.log('HTML Bundle Length:', data?.htmlBundle?.length);
  const hasThree = data?.htmlBundle?.includes('https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js');
  const hasControls = data?.htmlBundle?.includes('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js');
  const hasErrorBoundary = data?.htmlBundle?.includes('error-boundary');
  const hasCanvas = data?.htmlBundle?.includes('canvas-container');

  console.log('Three.js CDN Present:', hasThree);
  console.log('OrbitControls Present:', hasControls);
  console.log('Error Boundary Present:', hasErrorBoundary);
  console.log('Canvas Container Present:', hasCanvas);

  if (!res.success || !hasThree || !hasControls || !hasErrorBoundary || !hasCanvas) {
    throw new Error('Smoke assertions failed for Concept Animator bundle validation');
  }
  console.log('=== Smoke Check Complete ===');
  process.exit(0);
}

runSmoke().catch(err => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
