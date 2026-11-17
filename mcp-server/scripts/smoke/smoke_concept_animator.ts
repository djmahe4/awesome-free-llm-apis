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
  console.log('Three.js CDN Present:', data?.htmlBundle?.includes('three.js/r128/three.min.js'));
  console.log('OrbitControls Present:', data?.htmlBundle?.includes('OrbitControls.js'));
  console.log('Error Boundary Present:', data?.htmlBundle?.includes('error-boundary'));
  console.log('Canvas Container Present:', data?.htmlBundle?.includes('canvas-container'));
  console.log('=== Smoke Check Complete ===');
  process.exit(0);
}

runSmoke().catch(err => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
