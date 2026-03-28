import sys
import os
import json
import asyncio
from dotenv import load_dotenv
from google import genai
from google.genai import types

# Load environment variables from .env file
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env'))

async def main():
    try:
        # Request format: {"model": "...", "messages": [...], "stream": bool, "temperature": ...}
        input_data = json.loads(sys.stdin.read())
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY not found in environment")
        
        model_id = input_data.get("model")
        messages = input_data.get("messages", [])
        stream = input_data.get("stream", False)
        temperature = input_data.get("temperature", 0.7)

        client = genai.Client(api_key=api_key)

        # Convert simple messages to SDK format
        # [{ "role": "user", "content": "..." }] -> [{ "role": "user", "parts": [{"text": "..."}] }]
        sdk_messages = []
        for m in messages:
            sdk_messages.append(types.Content(
                role=m["role"],
                parts=[types.Part(text=m["content"])]
            ))

        if stream:
            async for chunk in await client.aio.models.generate_content_stream(
                model=model_id,
                contents=sdk_messages,
                config=types.GenerateContentConfig(temperature=temperature)
            ):
                # Output chunk text immediately for streaming
                if chunk.text:
                    print(json.dumps({"type": "chunk", "text": chunk.text}), flush=True)
            print(json.dumps({"type": "done"}), flush=True)
        else:
            response = await client.aio.models.generate_content(
                model=model_id,
                contents=sdk_messages,
                config=types.GenerateContentConfig(temperature=temperature)
            )
            
            # Prepare standard response
            result = {
                "type": "response",
                "text": response.text,
                "usage": {
                    "prompt_tokens": response.usage_metadata.prompt_token_count,
                    "completion_tokens": response.usage_metadata.candidates_token_count,
                    "total_tokens": response.usage_metadata.total_token_count
                }
            }
            print(json.dumps(result), flush=True)

    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
