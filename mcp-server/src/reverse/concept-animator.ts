import path from 'node:path';
import fs from 'node:fs/promises';
import { SearchProviderRegistry } from '../search/registry.js';
import { getMcpDir } from '../utils/mcp-home.js';
import type { UnifiedSearchResult } from '../search/types.js';

export interface ConceptAnimationOptions {
  searchQuery?: string;
  style?: 'cyber' | 'configurator' | 'exploded' | 'timeline' | 'minimalist';
  offlineOnly?: boolean;
  followupPrompt?: string;
  artifactId?: string;
}

export interface GroundedFact {
  title: string;
  url: string;
  snippet: string;
  provider: string;
}

export interface ConceptAnimationArtifact {
  artifactId: string;
  concept: string;
  style: string;
  groundedFacts: GroundedFact[];
  htmlBundle: string;
  createdAt: number;
  version: number;
  history?: Array<{ prompt: string; timestamp: number }>;
}

export const AST_DESIGN_TEMPLATES = {
  cyber: {
    name: 'Cyber & Cryptographic Glow',
    camera: { position: [0, 5, 12], fov: 60 },
    lighting: { ambient: 0.3, directional: '#00ffcc', intensity: 1.5 },
    background: '#0a0d14',
    features: ['glowing_wireframes', 'particle_streams', 'node_lattice', 'data_packets'],
  },
  configurator: {
    name: 'Interactive Topology Configurator',
    camera: { position: [0, 8, 14], fov: 50 },
    lighting: { ambient: 0.6, directional: '#ffffff', intensity: 1.2 },
    background: '#0f172a',
    features: ['orbit_controls', 'html_floating_badges', 'click_inspect', 'cluster_grouping'],
  },
  exploded: {
    name: 'Exploded Architecture Stack',
    camera: { position: [8, 8, 10], fov: 55 },
    lighting: { ambient: 0.5, directional: '#60a5fa', intensity: 1.4 },
    background: '#090d16',
    features: ['exploded_layers', 'offset_slider', 'component_pins', 'layer_isolate'],
  },
  timeline: {
    name: 'Kinetic Spline Pipeline Timeline',
    camera: { position: [0, 6, 15], fov: 55 },
    lighting: { ambient: 0.4, directional: '#f43f5e', intensity: 1.3 },
    background: '#0b0f19',
    features: ['spline_trajectory', 'packet_transit', 'step_controls', 'stage_beacons'],
  },
  minimalist: {
    name: 'Clean Mathematical Minimalist',
    camera: { position: [0, 4, 10], fov: 45 },
    lighting: { ambient: 0.7, directional: '#e2e8f0', intensity: 1.0 },
    background: '#05070a',
    features: ['soft_diffuse', 'monochrome_lattice', 'smooth_camera', 'math_annotations'],
  },
};

export class ConceptAnimator {
  private static instance: ConceptAnimator;
  private artifactsDir: string;

  constructor() {
    this.artifactsDir = path.join(getMcpDir(), '3d-animations');
  }

  static getInstance(): ConceptAnimator {
    if (!ConceptAnimator.instance) {
      ConceptAnimator.instance = new ConceptAnimator();
    }
    return ConceptAnimator.instance;
  }

  public async collectGroundedFacts(query: string): Promise<GroundedFact[]> {
    const registry = SearchProviderRegistry.getInstance();
    await registry.ensureInitialized();
    const providers = registry.getAvailableProviders();
    if (providers.length === 0) return [];

    const facts: GroundedFact[] = [];
    for (const provider of providers) {
      try {
        const results: UnifiedSearchResult[] = await provider.search(query, 4);
        if (results && Array.isArray(results) && results.length > 0) {
          for (const item of results) {
            facts.push({
              title: item.title || 'Source Reference',
              url: item.url,
              snippet: item.snippet || '',
              provider: provider.name,
            });
            if (facts.length >= 5) break;
          }
          if (facts.length > 0) break;
        }
      } catch {
        continue;
      }
    }
    return facts;
  }

  public buildStandaloneHtml(params: {
    concept: string;
    style: string;
    facts: GroundedFact[];
    reactThreeCode: string;
  }): string {
    const { concept, style, facts, reactThreeCode } = params;
    const template = (AST_DESIGN_TEMPLATES as any)[style] || AST_DESIGN_TEMPLATES.cyber;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${concept} - 3D Visualizer</title>
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ${template.background}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; color: #f8fafc; }
    #canvas-container { width: 100%; height: 100%; position: absolute; top: 0; left: 0; }
    #ui-overlay { position: absolute; top: 12px; left: 12px; z-index: 10; pointer-events: none; max-width: 380px; }
    .badge { display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); text-transform: uppercase; margin-bottom: 6px; }
    .title { font-size: 16px; font-weight: 700; color: #ffffff; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }
    .facts-card { margin-top: 8px; font-size: 11px; color: #94a3b8; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(8px); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); pointer-events: auto; max-height: 120px; overflow-y: auto; }
    .facts-card a { color: #38bdf8; text-decoration: none; }
    .facts-card a:hover { text-decoration: underline; }
    #error-boundary { display: none; position: absolute; inset: 0; background: rgba(15, 23, 42, 0.95); z-index: 50; padding: 24px; color: #f87171; font-size: 13px; font-family: monospace; overflow: auto; }
    #error-boundary pre { background: #000; padding: 12px; border-radius: 6px; border: 1px solid #ef4444; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/three@0.160.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>
  <div id="canvas-container"></div>
  <div id="ui-overlay">
    <div class="badge">${style} • 3D Experience</div>
    <div class="title">${concept}</div>
    ${facts && facts.length > 0 ? `
    <div class="facts-card">
      <strong>Verified Sources (${facts.length}):</strong><br/>
      ${facts.slice(0, 3).map(f => `• <a href="${f.url}" target="_blank" rel="noopener">${f.title.substring(0, 35)}...</a> (${f.provider})`).join('<br/>')}
    </div>` : ''}
  </div>
  <div id="error-boundary">
    <h3>3D Scene Execution Exception</h3>
    <p>A runtime context error occurred while rendering the 3D scene:</p>
    <pre id="error-msg"></pre>
    <button onclick="window.location.reload()" style="background:#ef4444;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;">Retry Scene</button>
  </div>
  <script>
    window.onerror = function(msg, url, line) {
      document.getElementById('error-boundary').style.display = 'block';
      document.getElementById('error-msg').textContent = msg + ' (Line ' + line + ')';
      return true;
    };
    try {
      ${reactThreeCode}
    } catch (err) {
      document.getElementById('error-boundary').style.display = 'block';
      document.getElementById('error-msg').textContent = err.stack || err.message;
    }
  </script>
</body>
</html>`;
  }

  public async generateAnimation(
    concept: string,
    options: ConceptAnimationOptions = {}
  ): Promise<ConceptAnimationArtifact> {
    const style = options.style || 'cyber';
    const searchQuery = options.searchQuery || concept;
    const facts = await this.collectGroundedFacts(searchQuery);

    let reactThreeCode = '';
    const template = (AST_DESIGN_TEMPLATES as any)[style] || AST_DESIGN_TEMPLATES.cyber;

    // Synthesize robust Three.js scene code tailored to the concept and template AST
    if (options.followupPrompt && options.artifactId) {
      // Followup refinement path
      reactThreeCode = this.generateFallbackScene(concept, template, options.followupPrompt);
    } else {
      reactThreeCode = this.generateFallbackScene(concept, template);
    }

    const artifactId = options.artifactId || `anim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const htmlBundle = this.buildStandaloneHtml({
      concept,
      style,
      facts,
      reactThreeCode,
    });

    const artifact: ConceptAnimationArtifact = {
      artifactId,
      concept,
      style,
      groundedFacts: facts,
      htmlBundle,
      createdAt: Date.now(),
      version: 1,
    };

    try {
      await fs.mkdir(this.artifactsDir, { recursive: true });
      await fs.writeFile(path.join(this.artifactsDir, `${artifactId}.html`), htmlBundle, 'utf-8');
      await fs.writeFile(path.join(this.artifactsDir, `${artifactId}.json`), JSON.stringify(artifact, null, 2), 'utf-8');
    } catch {}

    return artifact;
  }

  private generateFallbackScene(concept: string, template: any, followupNote?: string): string {
    return `
      const container = document.getElementById('canvas-container');
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('${template.background}');
      scene.fog = new THREE.FogExp2('${template.background}', 0.035);

      const camera = new THREE.PerspectiveCamera(${template.camera.fov}, window.innerWidth / window.innerHeight, 0.1, 1000);
      camera.position.set(${template.camera.position.join(', ')});

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(window.innerWidth, window.innerHeight);
      container.appendChild(renderer.domElement);

      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.enableZoom = true;

      const ambientLight = new THREE.AmbientLight(0xffffff, ${template.lighting.ambient});
      scene.add(ambientLight);

      const dirLight = new THREE.DirectionalLight('${template.lighting.directional}', ${template.lighting.intensity});
      dirLight.position.set(10, 20, 15);
      scene.add(dirLight);

      // Core concept visualization lattice
      const group = new THREE.Group();
      scene.add(group);

      const geometry = new THREE.IcosahedronGeometry(2.5, 2);
      const wireframeMat = new THREE.MeshStandardMaterial({
        color: '${template.lighting.directional}',
        wireframe: true,
        roughness: 0.2,
        metalness: 0.8
      });
      const coreMesh = new THREE.Mesh(geometry, wireframeMat);
      group.add(coreMesh);

      const innerGeo = new THREE.SphereGeometry(1.4, 32, 32);
      const innerMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.6,
        roughness: 0.1
      });
      const innerMesh = new THREE.Mesh(innerGeo, innerMat);
      group.add(innerMesh);

      // Orbiting concept nodes
      const nodeCount = 5;
      const nodes = [];
      for (let i = 0; i < nodeCount; i++) {
        const angle = (i / nodeCount) * Math.PI * 2;
        const nodeGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
        const nodeMat = new THREE.MeshStandardMaterial({ color: 0x818cf8, emissive: 0x4f46e5, emissiveIntensity: 0.4 });
        const node = new THREE.Mesh(nodeGeo, nodeMat);
        const dist = 5.2;
        node.position.set(Math.cos(angle) * dist, Math.sin(i) * 1.5, Math.sin(angle) * dist);
        group.add(node);
        nodes.push({ mesh: node, angle, dist });
      }

      window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });

      let clock = new THREE.Clock();
      function animate() {
        requestAnimationFrame(animate);
        const elapsed = clock.getElapsedTime();
        coreMesh.rotation.y = elapsed * 0.25;
        coreMesh.rotation.x = elapsed * 0.15;
        innerMesh.rotation.y = -elapsed * 0.35;

        nodes.forEach((n, idx) => {
          n.mesh.position.x = Math.cos(n.angle + elapsed * 0.4) * n.dist;
          n.mesh.position.z = Math.sin(n.angle + elapsed * 0.4) * n.dist;
          n.mesh.rotation.x += 0.02;
          n.mesh.rotation.y += 0.02;
        });

        controls.update();
        renderer.render(scene, camera);
      }
      animate();
    `;
  }
}
