# SPDX-License-Identifier: LGPL-3.0-only
"""Create one isolated Anki profile for the GSM/Hachidori Electron harness."""

import argparse
import json
from pathlib import Path

import anki
from aqt.profiles import ProfileManager


parser = argparse.ArgumentParser()
parser.add_argument("--base", type=Path, required=True)
parser.add_argument("--profile", required=True)
parser.add_argument("--result", type=Path, required=True)
args = parser.parse_args()

anki.lang.set_lang("en_US")
args.base.mkdir(parents=True, exist_ok=True)
manager = ProfileManager(str(args.base))
manager.setupMeta()
if args.profile not in manager.profiles():
    manager.create(args.profile)
manager.load(args.profile)
manager.profile["autoSync"] = False
manager.meta.update(
    defaultLang="en_US",
    firstRun=False,
    updates=False,
    suppressUpdate=True,
)
manager.save()
manager.db.close()
args.result.write_text(
    json.dumps(
        {
            "ankiVersion": anki.version,
            "base": str(args.base.resolve()),
            "profile": args.profile,
        },
        indent=2,
    )
    + "\n"
)
