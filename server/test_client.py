"""Standalone end-to-end test client for the backend (no VS Code needed).

Reproduces the plugin flow:
  1. POST the chat request to the Proxy Service -> requestId
  2. open a WebSocket to the Request Service -> receive the completion

Usage:
  pip install httpx websockets
  python test_client.py                       # connect-before (default)
  python test_client.py --delay 5             # connect-after (response waits in DB)
  python test_client.py --model openai/gpt-5.2 --prompt "Write a haiku"
"""

import argparse
import asyncio
import json

import httpx
import websockets


async def main() -> None:
    parser = argparse.ArgumentParser(description="AI-plugin backend test client")
    parser.add_argument("--http", default="http://localhost:8000")
    parser.add_argument("--ws", default="ws://localhost:8090")
    parser.add_argument("--token", default="dev-secret-token-123")
    parser.add_argument("--model", default="mock/echo")
    parser.add_argument("--prompt", default="Hello from the test client")
    parser.add_argument(
        "--delay",
        type=float,
        default=0.0,
        help="seconds to wait before opening the WS (tests the connect-after path)",
    )
    args = parser.parse_args()

    body = {
        "model": args.model,
        "messages": [{"role": "user", "content": args.prompt}],
        "tools": [],
        "tool_choice": "auto",
        "temperature": 0.1,
        "stream": False,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{args.http}/v1/requests",
            json=body,
            headers={"Authorization": f"Bearer {args.token}"},
        )
        resp.raise_for_status()
        request_id = resp.json()["requestId"]
    print(f"requestId: {request_id}")

    if args.delay:
        print(f"waiting {args.delay}s before connecting (connect-after test)...")
        await asyncio.sleep(args.delay)

    uri = f"{args.ws}/ws/{request_id}?token={args.token}"
    async with websockets.connect(uri) as ws:
        message = await ws.recv()
        data = json.loads(message)
        print("WS message:")
        print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
