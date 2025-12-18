# Copyright: Ajatt-Tools and contributors; https://github.com/Ajatt-Tools
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
import dataclasses
from collections.abc import Iterable, Sequence
from typing import Optional

try:
    from .basic_types import Inflection, MecabParsedToken, PartOfSpeech
except ImportError:
    from basic_types import Inflection, MecabParsedToken, PartOfSpeech


@dataclasses.dataclass
class WrappedToken:
    token: MecabParsedToken
    skip: bool = False


def replace_mistakes(tokens: Iterable[MecabParsedToken]) -> Iterable[MecabParsedToken]:
    consumed = tuple(WrappedToken(token) for token in tokens)
    for idx, wrapped in enumerate(consumed):
        if wrapped.skip:
            continue
        yield from replace_mistake(wrapped.token, consumed, idx)


def slice_headwords(context: Sequence[WrappedToken], start: int, end: int) -> Optional[tuple[str, ...]]:
    try:
        return tuple(context[idx].token.headword for idx in range(start, end))
    except IndexError:
        return None


def take_headword(context: Sequence[WrappedToken], pos: int) -> Optional[str]:
    try:
        return context[pos].token.headword
    except IndexError:
        return None


def replace_mistake(token: MecabParsedToken, context: Sequence[WrappedToken], pos: int) -> Iterable[MecabParsedToken]:
    if token.word == "放っ" and slice_headwords(context, pos + 1, pos + 3) in (("て", "おく"), ("て", "おける")):
        yield dataclasses.replace(token, headword="放る", katakana_reading="ホウッ")
    elif token.word == "温玉" and token.headword == "オンセンタマゴ":
        yield dataclasses.replace(
            token,
            headword="温玉",
        )
    elif token.headword == "打付ける":
        yield dataclasses.replace(
            token,
            katakana_reading=token.katakana_reading.replace("ウチツケ", "ブツケ"),
        )
    elif token.word == "拗ら" and token.headword == "拗る" and take_headword(context, pos + 1).startswith("せ"):
        yield dataclasses.replace(
            token,
            headword="拗らせる",
        )
    elif token.word == "弄っ" and token.headword == "弄う" and "てる" == take_headword(context, pos + 1):
        yield dataclasses.replace(
            token,
            headword="弄る",
            katakana_reading="イジッ",
        )
    elif token.word == "荒ん" and token.headword == "荒ぶ" and "だ" == take_headword(context, pos + 1):
        yield dataclasses.replace(
            token,
            headword="荒む",
        )
    elif token.word == "歩いた" and token.headword == "歩み板":
        yield dataclasses.replace(
            token,
            headword="歩く",
            katakana_reading="アルイタ",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.continuative_ta,
        )
    elif token.word == "しろっ" and "て" == take_headword(context, pos + 1):
        # しろって
        yield MecabParsedToken(
            word="しろ",
            headword="する",
            katakana_reading="シロ",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.imperative_ro,
        )
        yield MecabParsedToken(
            word="って",
            headword="って",
            katakana_reading="ッテ",
            part_of_speech=PartOfSpeech.particle,
            inflection_type=Inflection.unknown,
        )
    elif token.word == "はおら" and token.headword == "はおる" and "ぬ" == take_headword(context, pos + 1):
        # Xはおらぬ
        yield MecabParsedToken(
            word="は",
            headword="は",
            katakana_reading="ハ",
            part_of_speech=PartOfSpeech.particle,
            inflection_type=Inflection.unknown,
        )
        yield MecabParsedToken(
            word="おら",
            headword="おる",
            katakana_reading="オラ",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.irrealis,
        )
    elif token.word == "降り" and token.katakana_reading == "オリ" and "が" == take_headword(context, pos - 1):
        # 雪が降りました: オ=>フ
        yield dataclasses.replace(
            token,
            headword="降る",
            katakana_reading="フリ",
        )
    elif token.word == "旅立て" and token.headword == "旅立てる":
        # 旅立てる isn't listed in the pitch accent database; replace it with 旅立つ
        yield dataclasses.replace(
            token,
            headword="旅立つ",
        )
    elif token.word == "羽" and take_headword(context, pos + 1) == "撃":
        context[pos + 1].skip = True
        yield MecabParsedToken(
            word="羽撃",
            headword="羽撃く",
            katakana_reading="ハバタ",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.irrealis,
        )
    elif token.word == "阿良" and slice_headwords(context, pos + 1, pos + 3) == ("々", "木"):
        context[pos + 1].skip = True
        context[pos + 2].skip = True
        yield MecabParsedToken(
            word="阿良々木",
            headword="阿良々木",
            katakana_reading="アララギ",
            part_of_speech=PartOfSpeech.noun,
            inflection_type=Inflection.dictionary_form,
        )
    elif token.word == "乗り" and slice_headwords(context, pos + 1, pos + 3) == ("込", "え"):
        context[pos + 1].skip = True
        context[pos + 2].skip = True
        yield MecabParsedToken(
            word="乗り込え",
            headword="乗り込える",
            katakana_reading="ノリコエ",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.continuative,
        )
    elif (
        token.word == "助"
        and token.katakana_reading == "スケ"
        and slice_headwords(context, pos + 1, pos + 3) == ("から", "ない")
    ):
        context[pos + 1].skip = True
        yield MecabParsedToken(
            word="助から",
            headword="助かる",
            katakana_reading="タスカラ",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.irrealis,
        )
    elif token.word == "いい気" and take_headword(context, pos + 1) == "分":
        context[pos + 1].skip = True
        yield MecabParsedToken(
            word="いい",
            headword="いい",
            katakana_reading="イイ",
            part_of_speech=PartOfSpeech.i_adjective,
            inflection_type=Inflection.dictionary_form,
        )
        yield MecabParsedToken(
            word="気分",
            headword="気分",
            katakana_reading="キブン",
            part_of_speech=PartOfSpeech.noun,
            inflection_type=Inflection.dictionary_form,
        )
    elif token.word == "しや" and token.headword == "視野":
        yield dataclasses.replace(
            token,
            headword="してやる",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.nominal_connection_2,
        )
    elif token.word == "いいっ" and token.headword == "いい":
        yield MecabParsedToken(
            word="いい",
            headword="いい",
            katakana_reading="イイ",
            part_of_speech=PartOfSpeech.i_adjective,
            inflection_type=Inflection.dictionary_form,
        )
        yield MecabParsedToken(
            word="っ",
            headword="っ",
            katakana_reading="ッ",
            part_of_speech=PartOfSpeech.unknown,
            inflection_type=Inflection.unknown,
        )
    elif token.word == "本当のところ":
        yield MecabParsedToken(
            word="本当",
            headword="本当",
            katakana_reading="ホントウ",
            part_of_speech=PartOfSpeech.noun,
            inflection_type=Inflection.dictionary_form,
        )
        yield MecabParsedToken(
            word="の",
            headword="の",
            katakana_reading="ノ",
            part_of_speech=PartOfSpeech.particle,
            inflection_type=Inflection.unknown,
        )
        yield MecabParsedToken(
            word="ところ",
            headword="ところ",
            katakana_reading="トコロ",
            part_of_speech=PartOfSpeech.noun,
            inflection_type=Inflection.dictionary_form,
        )
    elif token.word == "有り難う" and token.katakana_reading == "アリガタウ":
        yield dataclasses.replace(token, katakana_reading="アリガトウ")
    elif token.word == "出て" and token.headword == "出し手" and token.katakana_reading == "ダシテ":
        yield dataclasses.replace(token, headword="出る", katakana_reading="デテ")
    elif token.word == "悪い" and token.katakana_reading == "アクイ" and token.headword == "悪意":
        yield dataclasses.replace(token, headword="悪い", katakana_reading="ワルイ")
    elif token.word == "では" and token.katakana_reading == "デハ" and token.headword == "出端":
        yield MecabParsedToken(
            word="で",
            headword="で",
            katakana_reading="デ",
            part_of_speech=PartOfSpeech.particle,
            inflection_type=Inflection.unknown,
        )
        yield MecabParsedToken(
            word="は",
            headword="は",
            katakana_reading="ハ",
            part_of_speech=PartOfSpeech.particle,
            inflection_type=Inflection.unknown,
        )
    elif token.word == "いた目" and token.katakana_reading == "イタメ" and token.headword == "板目":
        yield MecabParsedToken(
            word="い",
            headword="いる",
            katakana_reading="イ",
            part_of_speech=PartOfSpeech.verb,
            inflection_type=Inflection.continuative,
        )
        yield MecabParsedToken(
            word="た",
            headword="た",
            katakana_reading="タ",
            part_of_speech=PartOfSpeech.bound_auxiliary,
            inflection_type=Inflection.continuative,
        )
        yield MecabParsedToken(
            word="目",
            headword="目",
            katakana_reading="メ",
            part_of_speech=PartOfSpeech.noun,
            inflection_type=Inflection.unknown,
        )
    elif token.word == "軽そう" and token.katakana_reading == "ケイソウ" and token.headword == "軽装":
        yield MecabParsedToken(
            word="軽",
            headword="軽い",
            katakana_reading="カル",
            part_of_speech=PartOfSpeech.i_adjective,
            inflection_type=Inflection.garu_attached,
        )
        yield MecabParsedToken(
            word="そう",
            headword="そう",
            katakana_reading="ソウ",
            part_of_speech=PartOfSpeech.adverb,
            inflection_type=Inflection.unknown,
        )
    else:
        yield token
