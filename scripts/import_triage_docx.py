"""Import the approved TCM triage consensus DOCX into deterministic frontend JSON."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from docx import Document


CATEGORY_RE = re.compile(r"^(\d+)\s*[.．、]\s*(.+)$")
BRANCH_RE = re.compile(r"^([A-F])\s*[.．、:：\s]+(.+)$", re.S)
SYNDROME_RE = re.compile(r"^(?:UC\s*|CD\s*)?([A-F]\d+(?:（\d+）)?)\s*[：:\s]+(.+)$", re.I | re.S)
SYNDROME_NAME_RE = re.compile(r"([\u4e00-\u9fff（）()、/]+?证(?:\s*/\s*[\u4e00-\u9fff（）()]+?证)?)")
EMERGENCY_WORDS = ("危重", "急危", "紧急就医", "昏迷", "不省人事", "神志不清", "脱证", "视力骤降")


def clean(text: str) -> str:
    return " ".join(text.replace("\u3000", " ").split()).strip()


def next_nonempty(paragraphs: list[str], start: int) -> str:
    for text in paragraphs[start + 1 :]:
        if text:
            return text
    return ""


def disease_title(text: str) -> tuple[str, str]:
    match = re.search(r"[A-Za-z]", text)
    if not match:
        return text.strip(), ""
    return text[: match.start()].strip(" \t/"), text[match.start() :].strip()


def branch_label(text: str) -> str:
    for separator in ("：", ":", "——", "—"):
        head = text.split(separator, 1)[0].strip()
        if 2 <= len(head) <= 34:
            return head
    return text[:34].rstrip("，。；; ")


def split_syndrome(text: str) -> tuple[str, list[str], str]:
    name_match = SYNDROME_NAME_RE.search(text)
    label = name_match.group(1).replace(" ", "") if name_match else "待医师辨证"
    symptom_part = text[: name_match.start()] if name_match else text
    symptom_part = re.split(r"——|—{2,}", symptom_part, maxsplit=1)[0]
    symptoms = []
    for item in re.split(r"[，、；;。]", symptom_part):
        item = item.strip(" ：:（）()")
        if 2 <= len(item) <= 36 and item not in symptoms:
            symptoms.append(item)
    rationale = text[name_match.end() :].strip(" ：:；;———") if name_match else ""
    return label, symptoms[:12], rationale


def import_docx(source: Path) -> dict:
    doc = Document(source)
    paragraphs = [clean(paragraph.text) for paragraph in doc.paragraphs]

    categories: list[tuple[int, str, str]] = []
    for index, text in enumerate(paragraphs):
        match = CATEGORY_RE.match(text)
        if match and len(text) < 48:
            categories.append((index, match.group(1), match.group(2).strip()))

    disease_positions: list[int] = []
    for index, text in enumerate(paragraphs):
        if not text or CATEGORY_RE.match(text) or text.startswith(("第一级", "第二级", "第三级", "一级", "二级", "三级", "根据")):
            continue
        if len(text) < 100 and re.search(r"[A-Za-z]{4,}", text) and not re.match(r"^(?:UC|CD)?\s*[A-F]\d?", text, re.I):
            disease_positions.append(index)

    result_categories = []
    for category_index, category_number, category_name in categories:
        next_category = next((item[0] for item in categories if item[0] > category_index), len(paragraphs))
        positions = [position for position in disease_positions if category_index < position < next_category]
        diseases = []
        for position_index, position in enumerate(positions):
            end = positions[position_index + 1] if position_index + 1 < len(positions) else next_category
            block = [text for text in paragraphs[position + 1 : end] if text]
            name, name_en = disease_title(paragraphs[position])

            level1_index = next((i for i, text in enumerate(block) if text.startswith("第一级")), None)
            level2_index = next((i for i, text in enumerate(block) if text.startswith(("第二级", "二级"))), None)
            level3_index = next((i for i, text in enumerate(block) if text.startswith(("第三级", "三级"))), None)

            department = ""
            if level1_index is not None:
                department = re.sub(r"^第一级\s*[：:]?\s*", "", block[level1_index]).strip()

            consensus_end = level1_index if level1_index is not None else level2_index
            consensus = "\n".join(block[: consensus_end or 0]).strip()
            context_start = (level1_index + 1) if level1_index is not None else 0
            context_end = level2_index if level2_index is not None else context_start
            context = "\n".join(block[context_start:context_end]).strip()

            branches = []
            if level2_index is not None:
                end_index = level3_index if level3_index is not None else len(block)
                for text in block[level2_index + 1 : end_index]:
                    match = BRANCH_RE.match(text)
                    if match:
                        branches.append({"id": match.group(1), "label": branch_label(match.group(2)), "description": match.group(2)})

            syndromes = []
            if level3_index is not None:
                for text in block[level3_index + 1 :]:
                    match = SYNDROME_RE.match(text)
                    if not match:
                        continue
                    code, description = match.group(1).upper(), match.group(2).strip()
                    label, symptoms, rationale = split_syndrome(description)
                    syndromes.append({
                        "id": code,
                        "branch": code[0],
                        "label": label,
                        "description": description,
                        "symptoms": symptoms,
                        "rationale": rationale,
                        "emergency": any(word in description for word in EMERGENCY_WORDS),
                    })

            diseases.append({
                "id": f"c{category_number}-d{position_index + 1}",
                "name": name,
                "nameEn": name_en,
                "department": department,
                "consensus": consensus,
                "context": context,
                "branches": branches,
                "syndromes": syndromes,
            })

        result_categories.append({"id": f"category-{category_number}", "name": category_name, "diseases": diseases})

    return {
        "sourceDocument": source.name,
        "categories": result_categories,
        "stats": {
            "categoryCount": len(result_categories),
            "diseaseCount": sum(len(category["diseases"]) for category in result_categories),
            "syndromeCount": sum(len(disease["syndromes"]) for category in result_categories for disease in category["diseases"]),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = import_docx(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(data["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
