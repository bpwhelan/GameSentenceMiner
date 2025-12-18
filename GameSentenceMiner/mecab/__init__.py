# Copyright: Ren Tatsumoto <tatsu at autistici.org> and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

from .format import format_output
from .kana_conv import is_kana_str, kana_to_moras, to_hiragana, to_katakana
from .mecab_controller import BasicMecabController, MecabController


mecab = MecabController()