import { remark } from 'remark';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';

/**
 * Universal Markdown Context Extractor (v1.0.4)
 * 
 * Instead of dumping raw markdown which causes context noise and hallucinations,
 * this utility parses the MD into an AST and extracts only the 'signal' nodes:
 * - Headings (max 8)
 * - Declarative list items (containing : or =)
 * - Code block metadata + headers
 * - Important bold key-value pairs
 * - Scaffolding comments
 * 
 * @param content The raw markdown content to compress
 * @param maxChars Maximum character budget for the extracted context
 * @returns A compressed, factual summary of the markdown structure
 */
export async function extractMdContext(content: string, maxChars: number = 1500): Promise<string> {
    if (!content || content.trim().length === 0) return '';

    const processor = remark().use(remarkParse);
    const ast = processor.parse(content);
    const sections: string[] = [];
    let currentSize = 0;
    let headingCount = 0;
    let substantiveSignalFound = false;

    // Use a Set to avoid duplicate extraction of text nested within structural nodes
    const processedNodes = new Set<any>();

    const markProcessedRecursive = (node: any) => {
        processedNodes.add(node);
        if (node.children) {
            node.children.forEach((child: any) => markProcessedRecursive(child));
        }
    };

    visit(ast, (node: any) => {
        if (currentSize >= maxChars) return;
        if (processedNodes.has(node)) return;

        let chunk = '';

        switch (node.type) {
            case 'heading':
                if (headingCount < 8) {
                    chunk = `${'#'.repeat(node.depth)} ${toString(node)}\n`;
                    headingCount++;
                    // v1.0.4 Refinement: Headings are signals but not "rich" substantive content
                    // (prevents them from blocking fallback for prose-only files)
                    markProcessedRecursive(node);
                }
                break;

            case 'listItem': {
                const text = toString(node).trim();
                // We prioritize items that look like assignments or definitions
                if (text.includes(':') || text.includes('=')) {
                    chunk = `- ${text}\n`;
                    substantiveSignalFound = true;
                    markProcessedRecursive(node);
                }
                break;
            }

            case 'code': {
                const lines = (node.value || '').split('\n');
                const header = `\`\`\`${node.lang || ''} ${node.meta || ''}\n`;
                const preview = lines.slice(0, 2).join('\n');
                chunk = `${header}${preview}\n\`\`\`\n`;
                substantiveSignalFound = true;
                markProcessedRecursive(node);
                break;
            }

            case 'html': {
                if (node.value?.includes('<!--')) {
                    const comment = node.value.replace(/<!--|-->/g, '').trim();
                    if (comment.length > 0) {
                        chunk = `[META: ${comment.substring(0, 100)}]\n`;
                        substantiveSignalFound = true;
                    }
                    markProcessedRecursive(node);
                }
                break;
            }

            case 'strong': {
                const text = toString(node).trim();
                // Catch standalone bold descriptors often used as labels
                if (text.length > 2 && text.length < 50) {
                    chunk = `**${text}** `;
                    substantiveSignalFound = true;
                }
                break;
            }
        }

        if (chunk && currentSize + chunk.length <= maxChars) {
            sections.push(chunk);
            currentSize += chunk.length;
        }
    });

    // v1.0.4 Refined Signal Logic:
    // We treat headings and metadata as structural scaffolding. If we only found 
    // basic scaffolding (like a single title) but no "rich" substantive data (lists/code),
    // and the file is primarily prose, we fallback to the raw text excerpt.
    if (!substantiveSignalFound) {
        const rawExcerpt = content.split('\n').slice(0, 10).join('\n').trim();
        
        // If we found multiple structural signals (e.g. multiple subheadings),
        // we trust the extracted structural view as a valid summary.
        if (sections.length > 1) {
            return sections.join('\n').trim();
        }

        // If we only have one signal (unpopulated scaffold) or none, 
        // we fallback to raw text if it contains prose we would have otherwise missed.
        if (rawExcerpt.length > sections.join('\n').length + 5) {
            return rawExcerpt.substring(0, maxChars).trim();
        }

        if (sections.length > 0) return sections.join('\n').trim();
        return rawExcerpt.substring(0, maxChars).trim();
    }

    return sections.join('\n').trim();
}
