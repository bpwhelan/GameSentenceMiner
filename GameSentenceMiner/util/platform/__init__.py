import sys

from GameSentenceMiner.util.platform.hotkey import *  # noqa: F401,F403
from GameSentenceMiner.util.platform.notification import *  # noqa: F401,F403
from GameSentenceMiner.util.platform.window_state_monitor import *  # noqa: F401,F403

if sys.platform == "win32":
    from GameSentenceMiner.util.platform.magpie_compat import *  # noqa: F401,F403
