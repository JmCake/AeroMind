"""Parcel handoff readiness, evaluated at simulation time, before a dock receipt."""

from dataclasses import dataclass

from .panels import Reading


@dataclass(frozen=True)
class Decision:
    state: str
    reason: str
    evidence_ns: tuple[int, ...]


class HandoffCheck:
    def __init__(self, station, max_gap_ns=500_000_000, min_confidence=0.80):
        self.station = station
        self.max_gap_ns = max_gap_ns
        self.min_confidence = min_confidence
        self.last_frame = -1
        self.recent = []

    def observe(self, stamp: int, readings: list[Reading]) -> Decision:
        if stamp < 0:
            raise ValueError("Negative simulation time")
        if stamp <= self.last_frame:
            return Decision("ignored", "重复或乱序帧", (stamp,))
        if stamp - self.last_frame > self.max_gap_ns:
            self.recent.clear()
        self.last_frame = stamp
        matches = [r for r in readings if r.station == self.station]
        if len(matches) != 1:
            reason = "未看清订单指定站点" if not matches else "同一站号出现多次"
        elif matches[0].state == "unreadable" or matches[0].confidence < self.min_confidence:
            reason = "面板不清晰，等待新观测"
        elif matches[0].state == "occupied":
            reason = "站点显示占用"
        elif matches[0].state == "available":
            self.recent = [*self.recent[-1:], stamp]
            if len(self.recent) == 2:
                return Decision("ready", "连续两帧确认指定站点可交接", tuple(self.recent))
            return Decision("wait", "第一次读到可交接，等待下一帧", (stamp,))
        else:
            raise ValueError("Unknown display state")
        self.recent.clear()
        return Decision("wait", reason, (stamp,))

    def at_time(self, now: int) -> bool:
        return (len(self.recent) == 2 and self.last_frame <= now
                and now - self.last_frame <= self.max_gap_ns)
