# SPDX-License-Identifier: GPL-3.0-or-later
"""Hachidori Relay, the Anki add-on.

Keeps server.py listening for as long as Anki runs, so the Hachidori installs
on this computer, and on the person's other computers when the sharing
Hachidori asks for it, can share one library. The port is the add-on's only
setting; see config.md.
"""
import functools
import threading
import time

from aqt import mw
from aqt.utils import showWarning

from .server import serve

RETRY_SECONDS = 10


def run(port):
    warned = False
    while True:
        try:
            serve(port)
        except OSError as error:
            # Another program holds the port: say so once, then keep trying. Nothing
            # goes to stderr, which Anki shows as an error.
            if not warned:
                warned = True
                text = (
                    f"Hachidori Relay could not use port {port}: {error}.\n\n"
                    "Change the port under Tools → Add-ons → Hachidori Relay → Config, and under "
                    "Settings → Sharing → Advanced in Hachidori, then restart Anki."
                )
                mw.taskman.run_on_main(functools.partial(showWarning, text, title="Hachidori Relay"))
            time.sleep(RETRY_SECONDS)


threading.Thread(target=run, args=(int(mw.addonManager.getConfig(__name__)["port"]),), name="hachidori-relay", daemon=True).start()
