"""Fixtures used by benchmark_desktop_controls.py --areas."""

import base64
import io
import json
import statistics
import threading
from pathlib import Path

from benchmark_obs_outputs import ObsFixture
from PIL import Image, ImageDraw
from websockets.sync.server import serve

SCENE = "Area Fixture"
SOURCE = "Area fixture video"
PREFIX = "/api/ocr-area-selector"


def jpeg():
    image = Image.new("RGB", (1280, 720), (211, 218, 223))
    ImageDraw.Draw(image).rectangle((75, 100, 500, 650), fill=(22, 63, 120))
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=90)
    return out.getvalue()


def start_fixture(root, stack):
    class Fixture(ObsFixture):
        image = "data:image/jpeg;base64," + base64.b64encode(jpeg()).decode("ascii")

        def respond_request(self, method, data):
            if method == "GetCurrentProgramScene":
                return 100, {"sceneName": SCENE, "currentProgramSceneName": SCENE, "currentProgramSceneUuid": "scene"}
            if method == "GetSceneItemList":
                return 100, {
                    "sceneItems": [
                        {
                            "inputKind": "monitor_capture",
                            "sceneItemEnabled": True,
                            "sceneItemId": 1,
                            "sourceName": SOURCE,
                        }
                    ]
                }
            if method == "GetSourceScreenshot":
                if data.get("sourceName") == SOURCE:
                    return 100, {"imageData": self.image}
                return 600, {}
            return super().respond_request(method, data)

    server = stack.enter_context(serve(Fixture(root).handle, "127.0.0.1", 0))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    stack.callback(thread.join, 10)
    stack.callback(server.shutdown)
    return server.socket.getsockname()[1]


def configure_flask(app, port):
    from GameSentenceMiner import obs
    from GameSentenceMiner.obs.screenshot_capture import screenshot_capture
    from GameSentenceMiner.web import ocr_area_selector_api as areas

    obs.connection_pool = obs.OBSConnectionPool(host="127.0.0.1", port=port, password="", timeout=3)
    obs.connection_pool.connect_all()
    assert obs.connection_pool.connected_once
    screenshot_capture._get_configured_capture_backend = lambda: "obs"
    if not any(r.rule == PREFIX + "/configs" for r in app.url_map.iter_rules()):
        areas.register_ocr_area_selector_routes(app)
    return Path(areas.get_ocr_config_path())


def measure(root, servers, connections, rounds, count, batch):
    (native_profile,) = root.glob("gsm-native-smoke-*/pythonless")
    dirs = {"python": Path(servers["python"]["ocr_dir"]), "rust": native_profile / "ocr_config"}
    rect = {"x": 80, "y": 60, "w": 200, "h": 300, "is_secondary": True}
    data = {
        "coordinate_system": "pixels",
        "monitor_index": 2,
        "rects": [rect] * 8,
        "language": "ja",
        "window_geometry": {"width": 800, "height": 600},
    }
    for directory in dirs.values():
        assert directory.resolve().is_relative_to(root.resolve())
        directory.mkdir(parents=True, exist_ok=True)
        for i in range(32):
            (directory / f"areas-{i:02}.json").write_text(json.dumps(data), encoding="utf-8")

    def get(name, path):
        conn = connections[name][0]
        conn.request("GET", path)
        result = conn.getresponse()
        buf = result.read()
        assert result.status == 200, (name, path, buf)
        assert name != "rust" or result.getheader("x-gsm-handler") == "rust", path
        return json.loads(buf)

    path = PREFIX + "/config?name=areas-00"
    legacy = get("python", path)
    assert legacy == get("rust", path) and legacy["rectangles"][0]["coordinates"] == [0.1, 0.1, 0.25, 0.5]
    listed = get("python", PREFIX + "/configs")
    assert listed == get("rust", PREFIX + "/configs") and len(listed["configs"]) == 32
    expected = get("python", PREFIX + "/current-config")
    current = get("rust", PREFIX + "/current-config")
    assert expected["scene"] == "AreaFixture" and expected == current, (expected, current)
    payload = {"name": "areas-00", "rectangles": legacy["rectangles"]}
    cases = [
        (path, None, "rectangles", legacy["rectangles"]),
        (PREFIX + "/configs", None, "configs", None),
        (PREFIX + "/current-config", None, "name", expected["name"]),
        (PREFIX + "/config", payload, "config", legacy),
        (PREFIX + "/screenshot", None, None, None),
    ]
    results = {}
    for endpoint, payload, field, expected in cases:
        samples = {name: [] for name in connections}
        if endpoint.endswith("/configs"):
            listed = get("python", endpoint)
            native = get("rust", endpoint)
            assert listed == native, (listed, native)
            expected = listed[field]
        values = {name: expected for name in connections}
        if endpoint.endswith("/screenshot"):
            for name, (conn, _) in connections.items():
                conn.request("GET", endpoint)
                response = conn.getresponse()
                buf = response.read()
                assert response.status == 200 and response.getheader("Content-Type") == "image/jpeg", (
                    name,
                    response.status,
                    buf[:256],
                )
                assert "no-store" in response.getheader("Cache-Control") and (name != "rust" or buf == jpeg())
                with Image.open(io.BytesIO(buf)) as image:
                    assert image.size == (1280, 720) and all(
                        abs(a - b) < 5 for a, b in zip(image.getpixel((150, 150)), (22, 63, 120))
                    )
                values[name] = buf
        for i in range(rounds + 1):
            for name in connections if i % 2 == 0 else reversed(connections):
                sample = batch(
                    *connections[name], (endpoint, payload, 200, field, values[name]), count if i else 1, name == "rust"
                )
                if i:
                    samples[name].append(sample)
        results[endpoint] = {
            name: {k: round(statistics.median(s[k] for s in samples[name]), 4) for k in samples[name][0]}
            for name in connections
        }
    for directory in dirs.values():
        saved = json.loads((directory / "areas-00.json").read_text(encoding="utf-8"))
        assert saved["language"] == "ja" and saved["window_geometry"] == data["window_geometry"]
        assert (
            saved["rectangles"] == legacy["rectangles"]
            and "rects" not in saved
            and list((directory / "backup/areas-00").glob("*.json"))
        )
    return results
