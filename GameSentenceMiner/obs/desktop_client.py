"""Request shapes for legacy Python callers using the desktop's existing OBS socket."""

from obsws_python import ReqClient
from obsws_python.error import OBSSDKRequestError
from obsws_python.util import as_dataclass

from GameSentenceMiner.obs import desktop_session
from GameSentenceMiner.util.communication import bus_client


class DesktopClient(ReqClient):
    def __init__(self):
        # ReqClient's generated methods only construct request dictionaries. Its
        # constructor opens a socket, which the desktop already owns.
        pass

    def send(self, param, data=None, raw=False):
        bus = desktop_session.reader_bus() if desktop_session.reader_enabled() else bus_client.get_bus()
        reply = bus.request(bus_client.MAIN, "obs.request", {"method": param, "data": data}, timeout=36)
        if error := reply.get("error"):
            raise OBSSDKRequestError(param, error["code"], error["message"])
        if "transfer" in reply:
            parts = []
            offset = 0
            while offset < reply["size"]:
                part = bus.request(bus_client.MAIN, "obs.imageChunk", {"id": reply["transfer"], "offset": offset})
                if not part:
                    raise ValueError("Incomplete OBS screenshot")
                parts.append(part)
                offset += len(part)
            response = {"imageData": "".join(parts)}
        else:
            response = reply["response"]
        if raw:
            return response
        if response:
            return as_dataclass(param, response)


client = DesktopClient()
