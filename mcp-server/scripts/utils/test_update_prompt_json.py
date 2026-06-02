import unittest
import sys
import os

# Add the directory to sys.path so we can import the utility
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..')))
# The script is in mcp-server/scripts/utils/
# We want to import from mcp-server/scripts/utils/update_prompt_json.py
# So we need to add mcp-server/scripts/utils to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../mcp-server/scripts/utils')))

from update_prompt_json import generate_keywords

class TestUpdatePromptJson(unittest.TestCase):
    def test_keyword_overmatching(self):
        """
        Tests if generate_keywords includes low-signal stop words.
        """
        title = "THE MISSION"
        content = "This is a mission about work and writing."
        
        keywords = generate_keywords(title, content)
        
        # Expected keywords based on the current implementation (words >= 4 chars)
        # 'the' (3) -> skip
        # 'mission' (7) -> keep
        # 'this' (4) -> keep (noise)
        # 'mission' (7) -> keep
        # 'about' (5) -> keep (noise)
        # 'work' (4) -> keep (noise)
        # 'and' (3) -> skip
        # 'writing' (7) -> keep
        
        noise_words = {'this', 'about', 'work'}
        
        found_noise = [word for word in keywords if word in noise_words]
        
        print(f"\nGenerated keywords: {keywords}")
        print(f"Noise words found: {found_noise}")
        
        # If we find noise, the test "succeeds" in demonstrating the bug.
        # In a real test, we'd want this to fail if we expect no noise.
        # For a reproduction script, we assert that noise IS present.
        self.assertEqual(len(found_noise), 0, f"Expected to find NO noise words in {keywords}, but found {found_noise}")

if __name__ == "__main__":
    unittest.main()
