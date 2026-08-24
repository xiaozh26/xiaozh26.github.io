#!/usr/bin/env python3
"""Local preview that mimics GitHub Pages: /experience serves experience.html.

    python3 tools/serve.py        # http://localhost:8899
"""
import os, sys, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        full = super().translate_path(path)
        if not os.path.exists(full) and not path.endswith('/'):
            if os.path.exists(full + '.html'):
                return full + '.html'
        return full

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    os.chdir(ROOT)
    print(f'serving {ROOT} on http://localhost:{port}')
    ThreadingHTTPServer(('', port), Handler).serve_forever()
