from __future__ import annotations

from PyQt6.QtWidgets import QStyle, QProxyStyle


class FastToolTipStyle(QProxyStyle):
    def styleHint(self, hint, option=None, widget=None, returnData=None):
        if hint == QStyle.StyleHint.SH_ToolTip_WakeUpDelay:
            return 0  # ms
        if hint == QStyle.StyleHint.SH_ToolTip_FallAsleepDelay:
            return 10_000  # optional: keep “awake” longer so moving between widgets is instant
        return super().styleHint(hint, option, widget, returnData)
