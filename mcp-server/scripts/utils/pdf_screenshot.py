import sys
import json
import os
import fitz  # PyMuPDF

def render_page(pdf_path, physical_page_num):
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        return {"error": f"Failed to open PDF: {str(e)}"}

    total_pages = len(doc)
    if physical_page_num < 1 or physical_page_num > total_pages:
        return {"error": f"Page number {physical_page_num} out of range (1-{total_pages})"}

    # physical page is 0-indexed
    page = doc[physical_page_num - 1]
    
    # Render page to Pixmap
    pix = page.get_pixmap(dpi=150)
    
    # Find root directory containing package.json
    curr = os.path.dirname(os.path.abspath(__file__))
    while curr:
        if os.path.exists(os.path.join(curr, "package.json")):
            break
        parent = os.path.dirname(curr)
        if parent == curr:
            break
        curr = parent
    
    # Save to temp directory
    temp_dir = os.path.join(curr, "scratch", "temp_pdf")
    os.makedirs(temp_dir, exist_ok=True)
    
    pdf_name = os.path.splitext(os.path.basename(pdf_path))[0]
    image_name = f"{pdf_name}_page_{physical_page_num}.png"
    image_path = os.path.join(temp_dir, image_name)
    
    pix.save(image_path)
    text = page.get_text()

    return {
        "image_path": image_path.replace("\\", "/"),
        "text": text,
        "total_pages": total_pages
    }

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python pdf_screenshot.py <pdf_path> <page_num>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    try:
        page_num = int(sys.argv[2])
    except ValueError:
        print(json.dumps({"error": "Page number must be an integer"}))
        sys.exit(1)

    result = render_page(pdf_path, page_num)
    print(json.dumps(result, indent=2))
