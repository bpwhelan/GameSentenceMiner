from __future__ import annotations

from PyQt6.QtCore import QSignalBlocker
from PyQt6.QtGui import QKeySequence
from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QKeySequenceEdit,
    QLineEdit,
    QListWidget,
    QSpinBox,
    QTextEdit,
    QWidget,
)
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Tuple, Type

Path = Tuple[str, ...]


@dataclass(frozen=True)
class ValueTransform:
    to_model: Callable[[Any], Any] = lambda value: value
    from_model: Callable[[Any], Any] = lambda value: value


@dataclass(frozen=True)
class WidgetAdapter:
    get: Callable[[QWidget], Any]
    set: Callable[[QWidget, Any], None]
    connect: Callable[[QWidget, Callable[[], None]], None]


def _connect_signal(signal, callback: Callable[[], None]) -> None:
    signal.connect(lambda *_: callback())


ADAPTERS: Dict[Type[QWidget], WidgetAdapter] = {
    QLineEdit: WidgetAdapter(
        get=lambda w: w.text(),
        set=lambda w, v: w.setText("" if v is None else str(v)),
        connect=lambda w, cb: _connect_signal(w.textChanged, cb),
    ),
    QCheckBox: WidgetAdapter(
        get=lambda w: w.isChecked(),
        set=lambda w, v: w.setChecked(bool(v)),
        connect=lambda w, cb: _connect_signal(w.stateChanged, cb),
    ),
    QComboBox: WidgetAdapter(
        get=lambda w: w.currentText(),
        set=lambda w, v: w.setCurrentText("" if v is None else str(v)),
        connect=lambda w, cb: _connect_signal(w.currentTextChanged, cb),
    ),
    QSpinBox: WidgetAdapter(
        get=lambda w: w.value(),
        set=lambda w, v: w.setValue(int(v) if v is not None else w.minimum()),
        connect=lambda w, cb: _connect_signal(w.valueChanged, cb),
    ),
    QTextEdit: WidgetAdapter(
        get=lambda w: w.toPlainText(),
        set=lambda w, v: w.setPlainText("" if v is None else str(v)),
        connect=lambda w, cb: _connect_signal(w.textChanged, cb),
    ),
    QKeySequenceEdit: WidgetAdapter(
        get=lambda w: w.keySequence().toString(),
        set=lambda w, v: w.setKeySequence(QKeySequence("" if v is None else str(v))),
        connect=lambda w, cb: _connect_signal(w.keySequenceChanged, cb),
    ),
    QListWidget: WidgetAdapter(
        get=lambda w: [item.text() for item in w.selectedItems()],
        set=lambda w, v: _set_list_selection(w, v),
        connect=lambda w, cb: _connect_signal(w.itemSelectionChanged, cb),
    ),
}


def _set_list_selection(widget: QListWidget, values: Any) -> None:
    target = set(values or [])
    for index in range(widget.count()):
        item = widget.item(index)
        item.setSelected(item.text() in target)


@dataclass(frozen=True)
class Binding:
    path: Path
    widget: QWidget
    adapter: WidgetAdapter
    transform: ValueTransform


class BindingManager:
    def __init__(self, editor):
        self._editor = editor
        self._bindings: List[Binding] = []

    def bind(
        self,
        path: Path,
        widget: QWidget,
        adapter: WidgetAdapter | None = None,
        transform: ValueTransform | None = None,
    ) -> None:
        resolved_adapter = adapter or ADAPTERS.get(type(widget))
        if not resolved_adapter:
            raise ValueError(f"No adapter registered for widget type {type(widget).__name__}")
        resolved_transform = transform or ValueTransform()
        binding = Binding(path=path, widget=widget, adapter=resolved_adapter, transform=resolved_transform)
        self._bindings.append(binding)

        def on_change() -> None:
            raw_value = resolved_adapter.get(widget)
            value = resolved_transform.to_model(raw_value)
            self._editor.set_value(path, value)

        resolved_adapter.connect(widget, on_change)
        self._editor.subscribe(path, lambda value: self._apply(binding, value))
        self._apply(binding, self._editor.get_value(path))

    def refresh_all(self) -> None:
        for binding in self._bindings:
            self._apply(binding, self._editor.get_value(binding.path))

    def _apply(self, binding: Binding, value: Any) -> None:
        with QSignalBlocker(binding.widget):
            raw_value = binding.transform.from_model(value)
            binding.adapter.set(binding.widget, raw_value)
