export type Capability = 
  | 'Classification' 
  | 'Moderation' 
  | 'Summarization' 
  | 'EntityExtraction' 
  | 'SemanticSearch' 
  | 'Reasoning' 
  | 'Coding' 
  | 'UserIntent'
  | 'Chat' 
  | 'Vision';

const CAPABILITY_WEIGHTS: Record<Capability, number> = {
  'Reasoning': 0.2,
  'Coding': 0.2,
  'Vision': 0.15,
  'Summarization': 0.1,
  'EntityExtraction': 0.1,
  'Classification': 0.05,
  'Moderation': 0.05,
  'SemanticSearch': 0.05,
  'UserIntent': 0.05,
  'Chat': 0.05,
};

const KEYWORDS: Record<Capability, string[]> = {
  'Classification': ['classify', 'sentiment', 'categorize'],
  'Moderation': ['moderate', 'safety', 'policy', 'violation'],
  'Summarization': ['summarize', 'summarization', 'tldr', 'tl;dr', 'concise'],
  'EntityExtraction': ['extract', 'entities', 'json', 'fields'],
  'SemanticSearch': ['search', 'find', 'lookup'],
  'Reasoning': ['think', 'reason', 'logic', 'step by step', 'deepseek-r1', 'o1', 'thought'],
  'Coding': ['coding', 'programming', 'python', 'javascript', 'typescript', 'cpp', 'rust', 'sql', 'code generation', 'debug', 'implement', 'function', 'class', '```'],
  'UserIntent': ['who are you', 'what can you do', 'help', 'capabilities'],
  'Chat': ['chat', 'conversation', 'assistant', 'dialogue'],
  'Vision': ['vision', 'image', 'multimodal', 'ocr', 'visual', 'picture'],
};

const EXCLUSIONS: Partial<Record<Capability, string[]>> = {
  'Vision': ['video', 'animation', 'generate', 'text-to-image', 'text-to-video', 'sora', 'runway', 'luma', 'pika'],
};

export class CapabilityExtractor {
  /**
   * Extracts capabilities based on provided metadata (description, tags, etc.)
   */
  static extractCapabilities(text: string, tags: string[] = []): Capability[] {
    const content = (text + ' ' + tags.join(' ')).toLowerCase();
    const capabilities: Capability[] = [];

    for (const [capability, keywords] of Object.entries(KEYWORDS)) {
      const cap = capability as Capability;
      const hasKeyword = keywords.some(keyword => content.includes(keyword));
      const hasExclusion = EXCLUSIONS[cap]?.some(ex => content.includes(ex));

      if (hasKeyword && !hasExclusion) {
        capabilities.push(cap);
      }
    }

    return capabilities;
  }

  /**
   * Calculates a performance score based on extracted capabilities and defined weights.
   */
  static calculateScore(capabilities: Capability[]): number {
    let score = 0;
    for (const cap of capabilities) {
      score += CAPABILITY_WEIGHTS[cap] || 0;
    }
    return parseFloat(score.toFixed(2));
  }
}
