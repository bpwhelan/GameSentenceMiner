# Mecab controller

Mecab controller is a simple wrapper around
[mecab](https://github.com/taku910/mecab) ([AUR](https://aur.archlinux.org/packages/mecab-git)).
It was created primarily to be used in
[AJT Japanese](https://ankiweb.net/shared/info/1344485230),
an [Anki](https://wiki.archlinux.org/title/Anki) add-on
that generates furigana for Japanese text.
Originally based on code from
[Japanese support](https://github.com/ankitects/anki-addons/tree/main/code/japanese).

## Usage with AJT Japanese

This repository is already included with AJT Japanese.
You don't need to do anything extra.

## Standalone usage

```
>>> import mecab_controller
>>> mecab = mecab_controller.MecabController()
>>> print(mecab.reading('昨日すき焼きを食べました'))
昨日[きのう]すき 焼[や]きを 食[た]べました
```

```
python -m mecab_controller 昨日すき焼きを食べました
昨日[きのう]すき 焼[や]きを 食[た]べました
```
