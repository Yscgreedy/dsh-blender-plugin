# -*- coding: utf-8 -*-
"""runtime.py.core.local_op —— 无 GUI 本地车道的作业驱动（私有实现包）。

公开入口只有 driver；回执语义见 driver.py 的模块文档。包本身 import 安全：
不 eager 触碰 bpy，也不参与 modules.json 的公开模块清单。
"""
__all__ = ["driver", "dumps", "parse_result", "verdict_of", "receipt", "failure_receipt"]

from . import driver
from .driver import dumps, failure_receipt, parse_result, receipt, verdict_of
