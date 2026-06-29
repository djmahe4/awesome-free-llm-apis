import { chromium } from 'playwright';
import fetch from 'node-fetch';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { CapabilityExtractor } from '../src/utils/capability-extractor.js';

// Utility for paths since we are in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');
const PROVIDERS_DIR = path.join(PROJECT_ROOT, 'src/providers');
const ROUTER_FILE = path.join(PROJECT_ROOT, 'src/pipeline/middlewares/IntelligentRouterMiddleware.ts');

interface ScrapedModel {
  id: string;
  name: string;
  isVision: boolean;
}

// Global list of models that must always be retained because they are hardcoded in IntelligentRouterMiddleware.ts
let requiredRouterModels = new Set<string>();

/**
 * Parses IntelligentRouterMiddleware.ts to extract all hardcoded model IDs in the taskRouteMap.
 */
async function loadRequiredRouterModels() {
  try {
    if (await fs.pathExists(ROUTER_FILE)) {
      const content = await fs.readFile(ROUTER_FILE, 'utf-8');
      const modelRegex = /'([^'\n]+?\b[^'\n]*?)'/g;
      let match;
      while ((match = modelRegex.exec(content)) !== null) {
        const modelId = match[1].trim();
        if (modelId.includes('/') || modelId.includes('-') || /\d/.test(modelId)) {
          requiredRouterModels.add(modelId);
        }
      }
    }
  } catch (err: any) {
    console.error(`[Init] Warning: Could not parse IntelligentRouterMiddleware: ${err.message}`);
  }
}

// Vision/Multimodal signature detection rules
const VISION_KEYWORDS = [
  'vision', 'vl', 'vlm', 'multimodal', 'ocr', 'paligemma', 'glm-4.1v', 'glm-4.6v', 'glm-5v', 
  'gpt-4o', 'gemini-2.5', 'gemini-3.1', 'gemma-4-', 'scout', 'maverick', 'kimi-k', 'dola-seed', 
  'grok-build', 'kilo-auto/free', 'openrouter/free'
];

function detectVisionCapability(id: string, name: string): boolean {
  const normalizedId = id.toLowerCase();
  const normalizedName = name.toLowerCase();
  
  // Specific checks for known vision/multimodal models
  if (
    normalizedId.includes('gemini-3.1') || 
    normalizedId.includes('gemma-4-') || 
    normalizedId.includes('phi-4-multimodal') || 
    normalizedId.includes('nemotron-nano-2-vl') || 
    normalizedId.includes('nemotron-nano-12b-v2-vl') ||
    normalizedId.includes('cosmos-reason2') ||
    normalizedId.includes('paligemma') ||
    normalizedId.includes('glm-4.1v') ||
    normalizedId.includes('glm-4.6v') ||
    normalizedId.includes('glm-5v') ||
    normalizedId.includes('deepseek-ocr') ||
    normalizedId.includes('kimi-k2') ||
    normalizedId.includes('dola-seed') ||
    normalizedId.includes('grok-build') ||
    normalizedId.includes('kilo-auto/free') ||
    normalizedId.includes('openrouter/free') ||
    normalizedId.includes('gpt-4o') ||
    normalizedId.includes('llama-3.2-11b-vision') ||
    normalizedId.includes('llama-3.2-90b-vision')
  ) {
    return true;
  }

  return VISION_KEYWORDS.some(kw => normalizedId.includes(kw) || normalizedName.includes(kw));
}

function formatModelName(id: string, name: string): string {
  let text = name ? name.trim() : '';
  const slug = id.split('/').pop() || id;

  if (!text || text.toLowerCase() === slug.toLowerCase() || text.includes('/') || text.includes('@cf/')) {
    text = slug
      .split(/[-_]/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .replace(/\b(It|Asr|Tts|Llm|Mo|Moe|Api|Ocr|Vlm|Vl|Pii|Bnr|Gpu|Gpus)\b/gi, m => m.toUpperCase())
      .replace(/\b3n\b/gi, '3N')
      .replace(/\b3\.1\b/gi, '3.1')
      .replace(/\b2\.5\b/gi, '2.5')
      .replace(/\b3\.2\b/gi, '3.2')
      .replace(/\b4b\b/gi, '4B')
      .replace(/\b8b\b/gi, '8B')
      .replace(/\b1b\b/gi, '1B')
      .replace(/\b3b\b/gi, '3B')
      .replace(/\b7b\b/gi, '7B')
      .replace(/\b11b\b/gi, '11B')
      .replace(/\b12b\b/gi, '12B')
      .replace(/\b90b\b/gi, '90B');
  }

  return text.trim();
}

/**
 * Filter to verify if a model belongs in our free catalogs.
 */
function isFreeModel(providerId: string, modelId: string): boolean {
  if (providerId === 'kilocode') {
    return modelId.endsWith('/free') || modelId.endsWith(':free') || modelId.includes('/free') || modelId.includes(':free');
  }
  if (providerId === 'openrouter') {
    return modelId.endsWith(':free') || modelId.includes(':free');
  }
  return true;
}

/**
 * Cleanly updates the `models` array inside a provider file.
 * Preserves text models, adds scraped vision models, and drops deprecated ones.
 */
async function updateProviderFile(providerId: string, scrapedVisionModels: ScrapedModel[]) {
  if (providerId === 'gemini') {
    // Preserve gemini.ts in its pristine state as explicitly instructed
    return;
  }

  const filePath = path.join(PROVIDERS_DIR, `${providerId}.ts`);
  if (!(await fs.pathExists(filePath))) {
    console.error(`[Vision Writer] Provider file not found: ${filePath}`);
    return;
  }

  const existingContent = await fs.readFile(filePath, 'utf-8');

  // Load existing models
  const existingModels: { id: string; name: string }[] = [];
  const modelMatchRegex = /\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'\s*\}/g;
  let match;
  while ((match = modelMatchRegex.exec(existingContent)) !== null) {
    existingModels.push({
      id: match[1],
      name: match[2]
    });
  }

  const combinedMap = new Map<string, { id: string; name: string }>();

  // 1. Preserves text models and only keeps existing vision models if they are required by router
  for (const m of existingModels) {
    const isVision = detectVisionCapability(m.id, m.name);
    const isRequired = requiredRouterModels.has(m.id);

    if (!isVision || isRequired) {
      if (isFreeModel(providerId, m.id)) {
        combinedMap.set(m.id, { id: m.id, name: formatModelName(m.id, m.name) });
      }
    }
  }

  // 2. Add scraped vision models
  for (const m of scrapedVisionModels) {
    if (isFreeModel(providerId, m.id)) {
      combinedMap.set(m.id, { id: m.id, name: formatModelName(m.id, m.name) });
    }
  }

  const finalModels = Array.from(combinedMap.values());

  // Generate the TypeScript object array representation with strictly { id, name, capabilities, score }
  const arrayString = finalModels.map(m => {
    const text = `${m.name} ${m.id}`;
    const caps = CapabilityExtractor.extractCapabilities(text, []);
    const score = CapabilityExtractor.calculateScore(caps);
    
    const capsStr = caps.length > 0 ? `capabilities: [${caps.map(c => `'${c}'`).join(', ')}],` : '';
    const scoreStr = score > 0 ? `score: ${score},` : '';
    
    return `    { id: '${m.id}', name: '${m.name}', ${capsStr}${scoreStr} }`;
  }).join('\n');

  // Replace in file
  const unifiedRegex = /((?:readonly\s+)?models:\s*ProviderModel\[\]\s*=\s*\[)([^]*?)(\];)/;
  if (unifiedRegex.test(existingContent)) {
    const updatedContent = existingContent.replace(unifiedRegex, `$1\n${arrayString}\n  $3`);
    await fs.writeFile(filePath, updatedContent, 'utf-8');
    console.log(`[Vision Writer] Successfully updated ${providerId}.ts with ${finalModels.length} models.`);
  } else {
    console.error(`[Vision Writer] Could not locate models array format in ${providerId}.ts`);
  }
}

/**
 * Scrapes NVIDIA NIM Vision/VL Models Catalog in Free / Preview Tier.
 */
async function scrapeNvidiaVision(browser: any): Promise<ScrapedModel[]> {
  console.log('[Vision Scraper] Crawling NVIDIA NIM Vision/VL Catalog...');
  const page = await browser.newPage();
  const models: ScrapedModel[] = [];

  try {
    await page.goto('https://build.nvidia.com/models?filters=nimType%3Anim_type_preview', { timeout: 30000 });
    await page.waitForSelector('a[href*="/"]', { timeout: 15000 });

    let hasNext = true;
    let pageNum = 1;

    while (hasNext && pageNum <= 5) {
      console.log(`[NVIDIA-Vision] Processing page ${pageNum}...`);
      await page.waitForTimeout(2000); 

      // Remove OneTrust cookie overlays that block interaction
      await page.evaluate(() => {
        const overlay = document.getElementById('onetrust-consent-sdk') || document.querySelector('.onetrust-pc-dark-filter');
        if (overlay) overlay.remove();
      });

      const cards = await page.evaluate(() => {
        const items: Array<{ id: string; name: string }> = [];
        const cardElements = document.querySelectorAll('a[href*="/"]');
        
        cardElements.forEach(el => {
          const href = el.getAttribute('href') || '';
          const parts = href.split('/').filter(Boolean);
          if (parts.length >= 2) {
            const id = parts.slice(-2).join('/');
            const name = el.textContent?.trim() || parts[parts.length - 1];
            if (id && id.includes('/') && !items.some(x => x.id === id)) {
              items.push({ id, name });
            }
          }
        });
        return items;
      });

      for (const c of cards) {
        if (detectVisionCapability(c.id, c.name)) {
          models.push({ id: c.id, name: formatModelName(c.id, c.name), isVision: true });
        }
      }

      const nextButton = await page.$('button[aria-label="Go to next page"], button:has-text("Go to next page")');
      if (nextButton) {
        const isDisabled = await nextButton.evaluate((el: any) => el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (!isDisabled) {
          await nextButton.click({ force: true });
          pageNum++;
        } else {
          hasNext = false;
        }
      } else {
        hasNext = false;
      }
    }
  } catch (err: any) {
    console.error(`[NVIDIA-Vision] Scrape failed: ${err.message}`);
  } finally {
    await page.close();
  }

  return models;
}

/**
 * Fetches OpenRouter free vision models.
 */
async function scrapeOpenRouterVision(): Promise<ScrapedModel[]> {
  console.log('[Vision Scraper] Fetching OpenRouter free vision models...');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const json = (await res.json()) as any;
    if (json && Array.isArray(json.data)) {
      return json.data
        .filter((m: any) => (m.id.endsWith(':free') || m.id.includes(':free')) && detectVisionCapability(m.id, m.name))
        .map((m: any) => ({
          id: m.id,
          name: m.name,
          isVision: true
        }));
    }
  } catch (err: any) {
    console.error(`[OpenRouter-Vision] Failed to fetch: ${err.message}`);
  }
  return [];
}

/**
 * Fetches Kilo Code free vision models.
 */
async function scrapeKiloCodeVision(): Promise<ScrapedModel[]> {
  console.log('[Vision Scraper] Fetching Kilo Code free vision models...');
  try {
    const res = await fetch('https://api.kilo.ai/api/gateway/models');
    const json = (await res.json()) as any;
    if (json && Array.isArray(json.data)) {
      return json.data
        .filter((m: any) => (m.id.endsWith('/free') || m.id.endsWith(':free')) && detectVisionCapability(m.id, m.name || ''))
        .map((m: any) => ({
          id: m.id,
          name: m.name || m.id.split('/').pop() || m.id,
          isVision: true
        }));
    }
  } catch (err: any) {
    console.error(`[KiloCode-Vision] Failed to fetch: ${err.message}`);
  }
  return [];
}

/**
 * Fetches LLM7 free vision models.
 */
async function scrapeLLM7Vision(): Promise<ScrapedModel[]> {
  console.log('[Vision Scraper] Fetching LLM7 free vision models...');
  try {
    const res = await fetch('https://api.llm7.io/v1/models');
    const json = (await res.json()) as any;
    const array = Array.isArray(json) ? json : json?.data || [];
    if (Array.isArray(array)) {
      return array
        .filter((m: any) => detectVisionCapability(m.id, m.name || ''))
        .map((m: any) => ({
          id: m.id,
          name: m.name || m.id.split('/').pop() || m.id,
          isVision: true
        }));
    }
  } catch (err: any) {
    console.error(`[LLM7-Vision] Failed to fetch: ${err.message}`);
  }
  return [];
}

/**
 * Scrapes Cloudflare Workers AI free vision models.
 */
async function scrapeCloudflareVision(browser: any): Promise<ScrapedModel[]> {
  console.log('[Vision Scraper] Scraping Cloudflare Workers AI free vision models...');
  const page = await browser.newPage();
  const models: ScrapedModel[] = [];

  try {
    await page.goto('https://developers.cloudflare.com/workers-ai/models/', { timeout: 30000 });
    await page.waitForSelector('a[href*="@cf/"], code', { timeout: 15000 });

    const pageModels = await page.evaluate(() => {
      const items: Array<{ id: string; name: string }> = [];
      const codes = document.querySelectorAll('code');
      codes.forEach(el => {
        const text = el.textContent?.trim() || '';
        if (text.startsWith('@cf/')) {
          const id = text.split(' ')[0];
          const name = id.split('/').pop() || id;
          if (!items.some(x => x.id === id)) {
            items.push({ id, name });
          }
        }
      });
      return items;
    });

    for (const m of pageModels) {
      if (detectVisionCapability(m.id, m.name)) {
        models.push({ id: m.id, name: formatModelName(m.id, m.name), isVision: true });
      }
    }
  } catch (err: any) {
    console.error(`[Cloudflare-Vision] Web scraping failed: ${err.message}. Falling back to static llms.txt...`);
    try {
      const res = await fetch('https://developers.cloudflare.com/workers-ai/models/llms.txt');
      const text = await res.text();
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.includes('@cf/')) {
          const match = line.match(/@cf\/[^\s)\]]+/);
          if (match) {
            const id = match[0];
            const name = id.split('/').pop() || id;
            if (detectVisionCapability(id, name)) {
              models.push({ id, name, isVision: true });
            }
          }
        }
      }
    } catch (e: any) {
      console.error(`[Cloudflare-Vision] Fallback failed: ${e.message}`);
    }
  } finally {
    await page.close();
  }

  return models;
}

/**
 * Scrapes SiliconFlow free vision models.
 */
async function scrapeSiliconFlowVision(): Promise<ScrapedModel[]> {
  console.log('[Vision Scraper] Scraping SiliconFlow free vision models...');
  try {
    const res = await fetch('https://docs.siliconflow.com/llms.txt');
    const text = await res.text();
    const models: ScrapedModel[] = [];
    
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.includes('/') && !line.startsWith('http') && line.trim().length > 3) {
        const cleanLine = line.replace(/^[-\*\s]+/, '').trim();
        const id = cleanLine.split(' ')[0].trim();
        if (id.includes('/') && !id.includes('.') && !id.includes('(')) {
          const name = id.split('/').pop() || id;
          if (detectVisionCapability(id, name)) {
            models.push({ id, name: formatModelName(id, name), isVision: true });
          }
        }
      }
    }
    return models;
  } catch (err: any) {
    console.error(`[SiliconFlow-Vision] Failed to parse: ${err.message}`);
  }
  return [];
}

/**
 * Main execution orchestration.
 */
async function main() {
  console.log('\n=== Vision Model Scraper (v0.1) ===');
  console.log('Targeting only free vision (image-to-text / multimodal) models.');
  
  // 1. Initial setups
  await loadRequiredRouterModels();

  // 2. Initialize Browser
  const browser = await chromium.launch({ headless: true });
  const results: Record<string, ScrapedModel[]> = {};

  try {
    results['nvidia'] = await scrapeNvidiaVision(browser);
    results['openrouter'] = await scrapeOpenRouterVision();
    results['kilocode'] = await scrapeKiloCodeVision();
    results['llm7'] = await scrapeLLM7Vision();
    results['cloudflare'] = await scrapeCloudflareVision(browser);
    results['siliconflow'] = await scrapeSiliconFlowVision();
    
    // Google Gemini (preserves original pristine file gemini.ts)
    // results['gemini'] = [
    //   { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite Preview', isVision: true },
    //   { id: 'gemma-4-31b-it', name: 'Gemma 4 31B', isVision: true },
    //   { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B', isVision: true }
    // ];

    console.log('\n=== VISION SCRAPE REPORT ===');
    for (const [provider, models] of Object.entries(results)) {
      console.log(`Provider: ${provider.toUpperCase()} (${models.length} vision models)`);
      if (models.length > 0) {
        await updateProviderFile(provider, models);
      }
    }

    console.log(`\n======================================================`);
    console.log(`Success! Scraping and vision model updates complete.`);
    console.log(`======================================================\n`);
  } catch (err: any) {
    console.error('[Vision Scraper] Master job failed:', err.message);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[Vision Scraper] Critical error:', err);
  process.exit(1);
});
