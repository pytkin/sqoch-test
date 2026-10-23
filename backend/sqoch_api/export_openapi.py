"""Export the Pydantic-owned contract to stdout without starting an HTTP server."""

import json

from sqoch_api.app import create_app

if __name__ == "__main__":
    print(json.dumps(create_app().openapi(), ensure_ascii=False, indent=2, sort_keys=True))
