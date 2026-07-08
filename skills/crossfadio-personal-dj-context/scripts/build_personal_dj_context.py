#!/usr/bin/env python3
"""Build a strict Crossfadio Personal DJ Context payload from a LifeMesh bundle."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_TASK = (
    "为 Crossfadio AI DJ 生成当前个人上下文摘要，用于今天的音乐选择、播放能量控制、"
    "避免项和两首歌之间的自然过渡语气。只提取对选歌和口播有帮助的低敏/Private 以内信息，"
    "不包含原始私密内容、完整日记、账号、地址、健康细节。"
)
DEFAULT_PRIVACY_RULE = (
    "Acknowledge broad state only; do not reveal concrete private details."
)
ALLOWED_EVIDENCE_ROLES = {"fact", "raw", "context", "lead"}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build Crossfadio Personal DJ Context JSON from LifeMesh."
    )
    parser.add_argument("--out", required=True, help="Output JSON file path.")
    parser.add_argument("--task", help="LifeMesh bundle task. Defaults to the DJ task template.")
    parser.add_argument(
        "--task-file",
        help="Read task text from a file. Ignored when --task is provided.",
    )
    parser.add_argument(
        "--bundle-file",
        help="Use an existing LifeMesh bundle JSON instead of calling lifemesh.",
    )
    parser.add_argument(
        "--lifemesh-bin",
        default=os.environ.get("LIFEMESH_BIN") or default_lifemesh_bin(),
        help="Path to the LifeMesh CLI.",
    )
    parser.add_argument("--source", default="all", help="LifeMesh source selector.")
    parser.add_argument("--max-slices", type=int, default=12, help="LifeMesh max slices.")
    parser.add_argument(
        "--sensitivity-cap",
        default="Private",
        help="LifeMesh sensitivity cap. Default: Private.",
    )
    parser.add_argument(
        "--include-unverified",
        action="store_true",
        help="Pass through unverified LifeMesh content. Off by default.",
    )
    args = parser.parse_args()

    task = resolve_task(args.task, args.task_file)
    bundle = load_or_build_bundle(args, task)
    payload = build_payload(bundle)

    out_path = Path(args.out).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(
        "generated Personal DJ Context: "
        f"path={out_path} bundleId={payload['source']['bundleId']} "
        f"sliceCount={len(payload['source']['sliceRefs'])} "
        f"summary={payload['summary']}"
    )
    print("retention: latest upload stays current; older records expire after 24h")
    return 0


def resolve_task(task_arg: str | None, task_file: str | None) -> str:
    if task_arg and task_arg.strip():
        return task_arg.strip()
    if task_file:
        text = Path(task_file).expanduser().read_text(encoding="utf-8").strip()
        if text:
            return text
    template_path = Path(__file__).resolve().parent.parent / "templates" / "default-task.txt"
    if template_path.exists():
        text = template_path.read_text(encoding="utf-8").strip()
        if text:
            return text
    return DEFAULT_TASK


def default_lifemesh_bin() -> str:
    repo_root = Path(__file__).resolve().parents[3]
    sibling = repo_root.parent / "life-mesh" / "bin" / "lifemesh"
    return str(sibling)


def load_or_build_bundle(args: argparse.Namespace, task: str) -> dict[str, Any]:
    if args.bundle_file:
        return read_json(Path(args.bundle_file).expanduser())

    with tempfile.TemporaryDirectory(prefix="crossfadio-lifemesh-") as tmpdir:
        bundle_path = Path(tmpdir) / "bundle.json"
        cmd = [
            args.lifemesh_bin,
            "bundle",
            task,
            "--source",
            args.source,
            "--sensitivity-cap",
            args.sensitivity_cap,
            "--max-slices",
            str(args.max_slices),
            "--out",
            str(bundle_path),
        ]
        if args.include_unverified:
            cmd.append("--include-unverified")
        subprocess.run(cmd, check=True)
        return read_json(bundle_path)


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return data


def build_payload(bundle: dict[str, Any]) -> dict[str, Any]:
    slices = [item for item in bundle.get("slices", []) if isinstance(item, dict)]
    task_description = extract_task_description(bundle)
    features = classify_features(task_description, slices)
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "summary": build_summary(features, len(slices)),
        "currentState": {
            "activity": features["activity"],
            "energy": features["energy"],
            "attention": features["attention"],
            "mood": features["mood"],
        },
        "musicGuidance": {
            "energyCurve": features["energy_curve"],
            "preferredTextures": features["preferred_textures"],
            "avoidTextures": features["avoid_textures"],
            "vocalPreference": features["vocal_preference"],
            "novelty": features["novelty"],
        },
        "musicHints": build_music_hints(features),
        "segueGuidance": {
            "tone": features["segue_tone"],
            "privacyRule": DEFAULT_PRIVACY_RULE,
        },
        "source": {
            "kind": "lifemesh_bundle",
            "bundleId": coerce_short_string(bundle.get("bundle_id") or bundle.get("bundleId"), "unknown-bundle", 200),
            "sliceRefs": build_slice_refs(slices),
        },
    }


def extract_task_description(bundle: dict[str, Any]) -> str:
    task = bundle.get("task")
    if isinstance(task, dict):
        description = task.get("description")
        if isinstance(description, str):
            return description
    if isinstance(task, str):
        return task
    return ""


def classify_features(task_description: str, slices: list[dict[str, Any]]) -> dict[str, Any]:
    text = " ".join(
        [task_description]
        + [str(item.get("heading") or "") for item in slices]
        + [str(item.get("content") or "") for item in slices]
    ).lower()

    focus = any(token in text for token in ["coding", "代码", "开发", "写作", "工作", "专注", "debug"])
    tired = any(token in text for token in ["疲惫", "低能量", "累", "晚间", "休息", "焦虑"])
    social = any(token in text for token in ["朋友", "聚会", "出门", "social"])
    exercise = any(token in text for token in ["运动", "健身", "跑步", "训练", "exercise"])
    explore = any(token in text for token in ["探索", "新歌", "发现", "research", "调研"])

    if exercise:
        return {
            "activity": "exercise",
            "energy": "high",
            "attention": "high_stimulation",
            "mood": "active",
            "energy_curve": "uplift",
            "preferred_textures": ["driving rhythm", "bright hook", "clean percussion"],
            "avoid_textures": ["too sleepy", "loose pacing"],
            "vocal_preference": "mixed",
            "novelty": "balanced",
            "scene_label": "active momentum",
            "segue_tone": "brisk and discreet",
        }
    if social:
        return {
            "activity": "social",
            "energy": "medium",
            "attention": "normal",
            "mood": "open",
            "energy_curve": "mixed",
            "preferred_textures": ["warm vocal", "light groove", "familiar melody"],
            "avoid_textures": ["too abrasive", "high drama"],
            "vocal_preference": "mixed",
            "novelty": "balanced",
            "scene_label": "social warmup",
            "segue_tone": "casual and warm",
        }
    if tired:
        return {
            "activity": "recovery",
            "energy": "low",
            "attention": "low_distraction",
            "mood": "settling",
            "energy_curve": "downshift",
            "preferred_textures": ["soft rhythm", "warm pads", "gentle vocal"],
            "avoid_textures": ["too noisy", "high bpm", "sharp percussion"],
            "vocal_preference": "mixed",
            "novelty": "comfort",
            "scene_label": "low-energy recovery",
            "segue_tone": "calm and discreet",
        }
    if focus:
        return {
            "activity": "coding",
            "energy": "medium",
            "attention": "low_distraction",
            "mood": "focused",
            "energy_curve": "steady",
            "preferred_textures": ["steady rhythm", "warm vocal", "clean mix"],
            "avoid_textures": ["too noisy", "high drama", "jarring drops"],
            "vocal_preference": "mixed",
            "novelty": "balanced" if explore else "comfort",
            "scene_label": "low-distraction focus",
            "segue_tone": "familiar but discreet",
        }
    return {
        "activity": "general",
        "energy": "medium",
        "attention": "normal",
        "mood": "neutral",
        "energy_curve": "steady",
        "preferred_textures": ["steady rhythm", "clear melody"],
        "avoid_textures": ["too noisy", "high drama"],
        "vocal_preference": "mixed",
        "novelty": "balanced" if explore else "comfort",
        "scene_label": "general daily context",
        "segue_tone": "familiar but discreet",
    }


def build_summary(features: dict[str, Any], slice_count: int) -> str:
    scene = features["scene_label"]
    curve = features["energy_curve"]
    return (
        f"LifeMesh 当前上下文聚合为 {scene}，适合 {curve} 的播放能量；"
        f"参考了 {slice_count} 条本地上下文切片，但不包含原始内容。"
    )


def build_music_hints(features: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "kind": "scene",
            "label": features["scene_label"],
            "strength": "medium",
            "reason": "derived from current LifeMesh context",
        },
        {
            "kind": "style",
            "label": features["preferred_textures"][0],
            "strength": "medium",
            "reason": "matches the desired playback energy",
        },
    ]


def build_slice_refs(slices: list[dict[str, Any]]) -> list[dict[str, str]]:
    refs: list[dict[str, str]] = []
    for item in slices[:20]:
        slice_id = coerce_short_string(
            item.get("slice_id") or item.get("sliceId") or item.get("id"),
            "",
            160,
        )
        if not slice_id:
            continue
        evidence_role = item.get("evidence_role") or item.get("evidenceRole") or item.get("role")
        if evidence_role not in ALLOWED_EVIDENCE_ROLES:
            evidence_role = "context"
        ref = {
            "sliceId": slice_id,
            "evidenceRole": str(evidence_role),
        }
        citation_label = extract_citation_label(item)
        if citation_label:
            ref["citationLabel"] = citation_label
        refs.append(ref)
    return refs


def extract_citation_label(item: dict[str, Any]) -> str:
    citation = item.get("citation")
    if isinstance(citation, dict):
        label = citation.get("label")
        if isinstance(label, str):
            return coerce_short_string(label, "", 240)
    label = item.get("citation_label") or item.get("citationLabel")
    if isinstance(label, str):
        return coerce_short_string(label, "", 240)
    provenance = item.get("provenance")
    if isinstance(provenance, dict):
        source = provenance.get("source")
        note_path = provenance.get("note_path") or provenance.get("path")
        joined = " / ".join(str(part) for part in [source, note_path] if part)
        return coerce_short_string(joined, "", 240)
    return ""


def coerce_short_string(value: Any, fallback: str, max_length: int) -> str:
    if value is None:
        text = fallback
    else:
        text = str(value).strip() or fallback
    return text[:max_length]


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"lifemesh command failed with exit code {exc.returncode}", file=sys.stderr)
        raise SystemExit(exc.returncode)
