import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import PurePosixPath
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from GameSentenceMiner.native.downloads import download_file


@pytest.fixture
def model_origin(tmp_path):
    files = tmp_path / "model-origin"
    files.mkdir()
    requests = []
    handler = partial(SimpleHTTPRequestHandler, directory=str(files))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()

        def download(url, destination, digest, **kwargs):
            requests.append(url)
            name = PurePosixPath(urlsplit(url).path).name
            return download_file(f"http://127.0.0.1:{server.server_port}/{name}", destination, digest, **kwargs)

        try:
            yield SimpleNamespace(files=files, requests=requests, download=download)
        finally:
            server.shutdown()
            thread.join()
