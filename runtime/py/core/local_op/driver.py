# -*- coding: utf-8 -*-
"""无 GUI 本地车道的作业驱动（纯逻辑；由 Gateway 内联进 headless 作业脚本）。

分工：runtime/execution/local-op/ 把 op 名解析成「preload 模块 + K 上的 API 属性 +
子操作名」，再把本文件源码内联进 job.py；调用 bpy 的是作业脚本里那几行，本文件只负责
**回执语义** —— 把 op 的返回值或异常变成一行 HEADLESS JSON。

为什么不登记进 modules.json：那张清单只允许 runtime/py/<domain>/<name>.py 的公开模块
（布局契约测试按目录对拍），而本文件是作业驱动的实现细节，挂在子包里。

import 时零副作用、不 import bpy —— tests/unit/python/test_local_op_receipt.py 直接
import 本文件；真实 bpy 行为由带 file 的 headless 作业验收。
"""
import json

TRACEBACK_LIMIT = 2000
SUMMARY_LIMIT = 160
RAW_LIMIT = 400
VERDICTS = ("pass", "fail", "degraded")


def dumps(value):
    """一行 JSON：中文不转义，未知类型退回 str（回执绝不因为值怪而炸）。"""
    return json.dumps(value, ensure_ascii=False, default=str)


def _clip(value, limit):
    if value is None:
        return ''
    text = value if isinstance(value, str) else str(value)
    return text[:limit]


def parse_result(raw):
    """op 返回值 → dict。dispatch 类回 JSON 字符串，montage 类直接回 dict。"""
    if isinstance(raw, dict):
        return dict(raw)
    if raw is None:
        return {}
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8", "replace")
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            return {"ok": False, "error": "结果不是合法 JSON：%s" % exc, "raw": _clip(raw, RAW_LIMIT)}
        return dict(parsed) if isinstance(parsed, dict) else {"value": parsed}
    return {"value": raw}


def verdict_of(result):
    """三态判定：显式 verdict/state 优先；不知道就不算通过（降级）。"""
    if not isinstance(result, dict):
        return "degraded"
    explicit = result.get("verdict") or result.get("state")
    if isinstance(explicit, str) and explicit in VERDICTS:
        return explicit
    if result.get("ok") is False:
        return "fail"
    if result.get("ok") is True:
        return "degraded" if result.get("clean") is False else "pass"
    return "degraded"


def _summary_of(result):
    for key in ("summary", "note", "message", "error", "hint"):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            return _clip(value.strip(), SUMMARY_LIMIT)
    return ""


def evidence_for(op, file, verdict, extra=None):
    """evidence 三件套（op/file/verdict）+ 调用方给的具体细节。"""
    evidence = {"op": op, "file": file, "verdict": verdict}
    if isinstance(extra, dict):
        evidence.update(extra)
    return evidence


def receipt(op, file, result):
    """作业回执：ok 只等于 verdict==pass —— degraded/fail 都不许伪装成成功。"""
    parsed = parse_result(result)
    verdict = verdict_of(parsed)
    out = {
        "ok": verdict == "pass",
        "verdict": verdict,
        "degraded": verdict != "pass",
        "stage": "op",
        "op": op,
        "file": file,
        "summary": _summary_of(parsed),
        "evidence": evidence_for(op, file, verdict),
        "result": parsed,
    }
    for key in ("offenders", "counts", "totals", "images", "next"):
        if key in parsed:
            out[key] = parsed[key]
    return out


def describe_error(error):
    """异常/字符串 → 一行错误摘要（回执里只留第一行，栈另有字段）。"""
    if isinstance(error, BaseException):
        return "%s: %s" % (type(error).__name__, error)
    return _clip(error, SUMMARY_LIMIT) or "unknown error"


def failure_receipt(op, file, error, traceback_text=None):
    """驱动自己崩了：verdict 只能是 degraded，且必须带 op/file/stage/错误摘要。"""
    detail = {
        "error": describe_error(error),
        "traceback": _clip(traceback_text, TRACEBACK_LIMIT),
    }
    return {
        "ok": False,
        "verdict": "degraded",
        "degraded": True,
        "stage": "op",
        "op": op,
        "file": file,
        "summary": detail["error"],
        "evidence": evidence_for(op, file, "degraded", detail),
    }
