# Copyright: Ren Tatsumoto <tatsu at autistici.org> and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import dataclasses
import enum
import typing
from typing import Optional


class Separators:
    # Separators that are passed as command line arguments to mecab and used to parse mecab's output.
    component = "<ajt__component_separator>"
    node = "<ajt__node_separator>"
    footer = "<ajt__footer>"


class MecabAnalysis(typing.NamedTuple):
    # What info about each word mecab should output to the user.
    word: str
    headword: str
    katakana_reading: str
    part_of_speech: str
    inflection_type: str


COMPONENTS: typing.Final[MecabAnalysis] = MecabAnalysis(
    word="%m",
    headword="%f[6]",
    katakana_reading="%f[7]",
    part_of_speech="%f[0]",
    inflection_type="%f[5]",
)


class PartOfSpeech(enum.Enum):
    """
    Parts of speech that mecab can output.
    """

    unknown = None
    other = "その他"  # e.g. よ, ァ
    filler = "フィラー"  # e.g. なんか, あのー, ま, えーと
    adverb = "副詞"  # e.g. たちまち, やや, あたかも, どんどん, 飽くまで
    bound_auxiliary = "助動詞"  # e.g らしい, です, ない, ます, たい, だ
    particle = "助詞"  # e.g. は, から, を, て
    verb = "動詞"  # e.g. 出る, 見せる, あげる, 雇う, 患う
    noun = "名詞"  # e.g. 全員, 国, 言語学, 代金. Note: non-i adjectives (e.g. 綺麗, 静か) are classified as nouns too.
    i_adjective = "形容詞"  # e.g. 広い, づらい, 近い, 深い, 怖い
    interjection = "感動詞"  # e.g. おはよう, ありがとう, お疲れ様
    conjunction = "接続詞"  # e.g. それなら, それより, ですけれど, ただし
    prefix = "接頭詞"  # e.g. 超, 無, 御, 前, 初
    symbol = "記号"  # e.g. (-_-;), ■, (^.^)/~~~, ￥, ＊
    adnominal_adjective = "連体詞"  # e.g. いかなる, ろくな, この, いろんな, 小さな

    @classmethod
    def _missing_(cls, value):
        """
        If mecab for some reason outputs something that's not a member of this enum,
        fall back to "unknown".
        """
        return cls.unknown


ANY_ATTACHING = "接続"


@enum.unique
class Inflection(enum.Enum):
    unknown = None
    garu_attached = "ガル接続"  # e.g 苦し (+ がる)
    hypothetical = "仮定形"  # e.g. 出かけれ (+ ば)
    contraction_1 = "仮定縮約１"  # e.g. 来れば => 来りゃ, ていれば => てりゃ
    contraction_2 = "仮定縮約２"  # e.g. なければ => なきゃ
    nominal_connection = "体言接続"  # たり => たる, 良い => 良き, らしい => らしき
    nominal_connection_special = "体言接続特殊"  # 負ける => 負けん, 戻れる => 戻れん, する => すん
    nominal_connection_2 = "体言接続特殊２"  # 変わる => 変わ, とちる => とち, 携わる => 携わ
    imperative_e = "命令ｅ"  # に+なれ, (で+)あれ, (と+)思え, (ください+)ませ
    imperative_i = "命令ｉ"  # (ご覧+)ください
    imperative_ro = "命令ｒｏ"  # (信用+)しろ, (を+)見せろ
    imperative_yo = "命令ｙｏ"  # (を+)助けよ, 与えよ, せよ
    dictionary_form = "基本形"  # する, 言う
    modern_dictionary_form = "現代基本形"
    classical_dictionary_form = "文語基本形"
    sound_change_dictionary_form = "音便基本形"
    dictionary_form_geminate_contraction = "基本形 - 促音便"
    irrealis_u = "未然ウ接続"
    irrealis_nu = "未然ヌ接続"  # よから(+ぬ), (感謝+)せ(+ざる), 少なから(+ぬ)
    irrealis_reru = "未然レル接続"  # (解消+)さ(+れる), (失礼+)さ(+せ)
    irrealis = "未然形"  # (に+)持ち込ま(+れる), (しか+)知ら(+なかっ), (言葉+)行か(+なく)
    irrealis_special = "未然特殊"  # わかん+ない
    continuative_gozai = "連用ゴザイ接続"  # 有難う(+御座い)
    continuative_ta = "連用タ接続"  # 聞い(+て), (が+)分かっ(+て), (一度+)読ん(+で)
    continuative_te = "連用テ接続"  # (見え+)なく, (問題+)なく, 美味しく, 熱く
    continuative_de = "連用デ接続"  # (寝+)ない(+で), (変え+)ない(+で), (忘れ+)ない(+で)
    continuative_ni = "連用ニ接続"  # (消さ+)ず(+に)
    continuative = "連用形"  # 見つかり, 教わり, いただき, 探し(+た), (弄ば+)れ(+て)

    @classmethod
    def _missing_(cls, value):
        """
        If mecab for some reason outputs something that's not a member of this enum,
        fall back to "unknown".
        """
        return cls.unknown


@dataclasses.dataclass(frozen=True)
class MecabParsedToken:
    word: str
    headword: str
    katakana_reading: Optional[str]  # inflected reading
    part_of_speech: PartOfSpeech
    inflection_type: Inflection


assert tuple(field.name for field in dataclasses.fields(MecabParsedToken)) == tuple(COMPONENTS.__annotations__)


def main():
    for k in COMPONENTS:
        print(k)
    print(PartOfSpeech("invalid"))
    print(PartOfSpeech("副詞"))
    print(PartOfSpeech("感動詞"))


if __name__ == "__main__":
    main()
