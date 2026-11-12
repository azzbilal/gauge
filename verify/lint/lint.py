"""M7 Packet Lint entry point.

    from lint import lint
    findings = lint(packet_dict)

Each finding is {"rule": str, "severity": "info" | "warning" | "critical", "detail": str},
the same fields as the LintFinding model. Standard library only.
"""
try:
    from .packet import PacketError, TaskPacket
    from .rules import RULES
except ImportError:  # imported from inside verify/lint rather than as a package
    from packet import PacketError, TaskPacket
    from rules import RULES

SEVERITIES = ("info", "warning", "critical")


def lint(packet: dict) -> list:
    """Run every lint rule over a task packet and return the findings.

    Raises PacketError (a ValueError) when the packet is not shaped like a task packet."""
    parsed = TaskPacket.from_dict(packet)
    findings = []
    for rule in RULES:
        for name, severity, detail in rule(parsed):
            if severity not in SEVERITIES:
                raise ValueError(f"rule {name} returned unknown severity {severity!r}")
            findings.append({"rule": name, "severity": severity, "detail": detail})
    return findings


__all__ = ["lint", "PacketError", "SEVERITIES"]
