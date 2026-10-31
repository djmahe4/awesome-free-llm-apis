export function requiredExports(goal: string): string[] {
    const sentences = goal.split(/(?<=[.!?])\s+(?=[a-zA-Z])/);
    const filteredSentences = sentences.filter(sentence => /\bexports?\b/i.test(sentence));
    const codeSpans = filteredSentences.flatMap(sentence => sentence.split(/`/).filter((_, index) => index % 2 !== 0));
    const names = new Set<string>();
    for (const span of codeSpans) {
        const match = span.match(/^(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
        if (match) {
            names.add(match[1]);
        } else if (/^[A-Za-z_$][\w$]*$/.test(span)) {
            names.add(span);
        }
    }
    return Array.from(names);
}

export function missingExports(content: string, names: string[]): string[] {
    content = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const exportedNames = new Set<string>();
    const exportRegex = /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|interface|type|enum)\s+(\w+)/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
        exportedNames.add(match[1]);
    }
    const exportListRegex = /export\s*\{([^}]*)\}/g;
    while ((match = exportListRegex.exec(content)) !== null) {
        const list = match[1].split(',').map(item => item.trim());
        for (const item of list) {
            const [name, alias] = item.split(' as ');
            const exportName = alias || name;
            exportedNames.add(exportName);
        }
    }
    return names.filter(name => !exportedNames.has(name));
}

export function exportGaps(goal: string, files: Array<{ filePath: string; content: string }>): string[] {
    const names = requiredExports(goal);
    if (names.length === 0) return [];
    const filteredFiles = files.filter(file => /\.(?:[cm]?[jt]sx?)$/i.test(file.filePath));
    if (filteredFiles.length === 0) return [];
    return names.filter(name => filteredFiles.every(file => missingExports(file.content, [name]).length > 0));
}
