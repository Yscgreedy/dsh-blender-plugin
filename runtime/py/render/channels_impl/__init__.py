# -*- coding: utf-8 -*-
"""render 通道指标实现包（render / alpha / mask / ink）。

不是公开 preload 模块：队列渲染作业的收尾片段按 __file__ 定位 channels_impl/metrics.py 并 exec。
import 安全：不 eager import 子模块（metrics 需要 numpy，只在收尾/单测里加载）。
"""
__all__ = ["metrics"]
