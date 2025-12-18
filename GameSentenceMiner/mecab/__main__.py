# Copyright: Ren Tatsumoto <tatsu at autistici.org> and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import sys

from .mecab_controller import MecabController


def main():
    mecab = MecabController(verbose=False)
    print(mecab.reading(" ".join(sys.argv[1:])))


if __name__ == "__main__":
    main()
