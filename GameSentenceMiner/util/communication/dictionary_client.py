"""Dictionary requests belong to the desktop, independent of overlay visibility."""

import time
import uuid

from GameSentenceMiner.util.communication import bus_client


def request(topic: str, payload: dict, timeout: float) -> dict | None:
    # Standalone deployments without a desktop bus still use the overlay transport.
    # Once a desktop request is sent, never retry it through another transport:
    # a timed-out import or settings write may already have taken effect.
    if not bus_client.is_bus_available():
        return None
    result = bus_client.get_bus().request(
        bus_client.MAIN,
        topic,
        {
            "request_id": str(uuid.uuid4()),
            "deadline": int((time.time() + timeout - min(1, timeout / 10)) * 1000),
            "data": payload,
        },
        timeout=timeout,
    )
    if not isinstance(result, dict):
        raise RuntimeError("Invalid dictionary service response.")
    if result.get("success") is not True:
        raise RuntimeError(result.get("error") or "Dictionary setup failed.")
    return result
