import json
import os
import re
from datetime import datetime

def extract_main_prompt(txt, marker):
    startIndex = txt.find(marker)
    if startIndex == -1:
        return None

    # Find the nearest surrounding code block
    preContent = txt[:startIndex]
    postContent = txt[startIndex:]

    blockStart = preContent.rfind('```')
    blockEnd = postContent.find('```')

    if blockStart != -1 and blockEnd != -1:
        # Extract content between ``` and ```
        fullBlock = txt[blockStart : startIndex + blockEnd + 3]
        match = re.search(r'```(?:text|markdown|prompt)?\s*([\s\S]*?)\s*```', fullBlock, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None

def parse_sections(prompt_text):
    """
    Intelligently splits the prompt into sections based on ALL CAPS headers.
    """
    lines = prompt_text.split('\n')
    sections = []
    current_section = {
        "id": "introduction",
        "title": "INTRODUCTION",
        "content": [],
        "level": 0
    }
    
    # Header regex: Line that is mostly ALL CAPS and doesn't look like a list item
    header_regex = re.compile(r'^[A-Z0-9][A-Z0-9 \-_,“”]{3,}$')

    for line in lines:
        clean_line = line.strip()
        if header_regex.match(clean_line):
            # Save previous section
            if current_section["content"]:
                current_section["content"] = "\n".join(current_section["content"]).strip()
                sections.append(current_section)
            
            # Start new section
            current_section = {
                "id": clean_line.lower().replace(" ", "_").replace("“", "").replace("”", "").replace(",", ""),
                "title": clean_line,
                "content": [],
                "level": 1 if "RELIABILITY" in clean_line or "MOMENTUM" in clean_line else 2
            }
        else:
            current_section["content"].append(line)
            
    # Add last section
    if current_section["content"]:
        current_section["content"] = "\n".join(current_section["content"]).strip()
        sections.append(current_section)
        
    return sections

def generate_keywords(title, content):
    """
    Simple keyword extraction for matching.
    """
    # Use title words and some common terms from content
    words = re.findall(r'\b\w{4,}\b', (title + " " + content).lower())
    # Filer out common stop words if needed, but for now just unique set
    return sorted(list(set(words)))

def main():
    # Use environment variable or derive relative path from script location.
    # Select the first candidate that actually contains README.md.
    env_base_dir = os.environ.get('AGENT_PROMPT_PATH')
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # Check local external/ (if mcp-server is standalone)
    local_external = os.path.abspath(os.path.join(script_dir, '../external/agent-prompt'))
    # Check repo-root external/ (normal monorepo case)
    root_external = os.path.abspath(os.path.join(script_dir, '../../external/agent-prompt'))

    candidate_dirs = [env_base_dir] if env_base_dir else [local_external, root_external]
    candidate_dirs = [d for d in candidate_dirs if d]

    base_dir = None
    for candidate in candidate_dirs:
        candidate_readme = os.path.join(candidate, 'README.md')
        if os.path.exists(candidate_readme):
            base_dir = candidate
            break

    if not base_dir:
        checked = '\n  - '.join(candidate_dirs)
        print('Error: README.md not found in any expected agent-prompt path:')
        print(f'  - {checked}')
        return

    readme_path = os.path.join(base_dir, 'README.md')
    json_path = os.path.join(base_dir, 'prompt.json')

    with open(readme_path, 'r', encoding='utf-8') as f:
        content = f.read()

    marker = "You are the principal architect and builder"
    prompt_text = extract_main_prompt(content, marker)
    
    if not prompt_text:
        print(f"Warning: Could not find prompt block in README.md")
        return

    raw_sections = parse_sections(prompt_text)
    
    # NEW: Extract Reference Sections from full README content
    ref_sections = extract_reference_sections(content)
    
    final_data = {
        "metadata": {
            "version": "1.2.0",
            "source": "README.md",
            "generated_at": datetime.now().isoformat()
        },
        "introduction": "",
        "sections": []
    }

    for section in raw_sections:
        if section["id"] == "introduction":
            final_data["introduction"] = section["content"]
        else:
            section["keywords"] = generate_keywords(section["title"], section["content"])
            final_data["sections"].append(section)
            
    # Add extracted references as valid PromptSections
    for ref_sec in ref_sections:
        ref_sec["keywords"] = generate_keywords(ref_sec["title"], ref_sec["content"])
        final_data["sections"].append(ref_sec)

    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(final_data, f, indent=2)
    
    print(f"Successfully processed {len(final_data['sections'])} sections (including references) into {json_path}")

def extract_reference_sections(text):
    """
    Parses ## Research Appendix and ## Subsystem Reference Map headers.
    """
    sections = []
    
    # 1. Research Appendix
    appendix_match = re.search(r'## Research Appendix\s*(.*?)(?=\n##|$)', text, re.DOTALL)
    if appendix_match:
        content = appendix_match.group(1).strip()
        sections.append({
            "id": "research_appendix",
            "title": "RESEARCH APPENDIX",
            "content": content,
            "level": 2
        })

    # 2. Subsystem Reference Map
    map_match = re.search(r'## Subsystem Reference Map\s*(.*?)(?=\n##|$)', text, re.DOTALL)
    if map_match:
        content = map_match.group(1).strip()
        sections.append({
            "id": "subsystem_reference_map",
            "title": "SUBSYSTEM REFERENCE MAP",
            "content": content,
            "level": 2
        })
        
    return sections

if __name__ == "__main__":
    main()
