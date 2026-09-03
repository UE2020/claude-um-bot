#!/usr/bin/env python3
"""Validate and fine-tune an UltiMafia chat model with Unsloth + TRL.

This is designed to run from a Colab checkout while the private JSONL files
and all checkpoints live in Google Drive. It never uploads to a model hub,
enables experiment trackers, or prints example text.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


ALLOWED_ACTIONS = {"say", "vote", "unvote", "wait"}
SECRET_PATTERNS = (
    ("UltiMafia session cookie", re.compile(r"connect\.sid=(?!<|\.{3})[^\s\"']{12,}", re.I)),
    ("authorization bearer token", re.compile(r"authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}", re.I)),
    ("private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("OpenAI-style API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate UltiMafia JSONL and fine-tune a 4-bit LoRA model."
    )
    parser.add_argument("--train", default="data/train.jsonl")
    parser.add_argument("--eval", default="data/eval.jsonl")
    parser.add_argument("--model", default="unsloth/Qwen3-4B-Instruct-2507")
    parser.add_argument("--output-dir", default="training-output/checkpoints")
    parser.add_argument("--adapter-dir", default=None)
    parser.add_argument("--gguf-dir", default=None)
    parser.add_argument("--save-gguf", action="store_true")
    parser.add_argument("--gguf-quant", default="q4_k_m")
    parser.add_argument("--max-length", type=int, default=3072)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--warmup-steps", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--eval-batch-size", type=int, default=2)
    parser.add_argument("--gradient-accumulation", type=int, default=8)
    parser.add_argument("--logging-steps", type=int, default=20)
    parser.add_argument("--eval-steps", type=int, default=200)
    parser.add_argument("--save-steps", type=int, default=200)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--resume",
        nargs="?",
        const="auto",
        default=None,
        help="Resume from the last checkpoint, or from the supplied checkpoint path.",
    )
    parser.add_argument("--max-train-samples", type=int, default=None)
    parser.add_argument("--max-eval-samples", type=int, default=None)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate both files and print aggregate statistics; do not load a model.",
    )
    return parser.parse_args()


def fail(message: str) -> None:
    raise ValueError(message)


def find_secret(value: str) -> str | None:
    for label, pattern in SECRET_PATTERNS:
        if pattern.search(value):
            return label
    return None


def validate_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail(f"Dataset not found: {path}")

    games: set[str] = set()
    actions: Counter[str] = Counter()
    roles: Counter[str] = Counter()
    count = 0

    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                fail(f"{path}:{line_number}: invalid JSON ({exc.msg})")

            messages = row.get("messages")
            if not isinstance(messages, list) or len(messages) != 3:
                fail(f"{path}:{line_number}: expected exactly three messages")
            expected_roles = ["system", "user", "assistant"]
            actual_roles = [message.get("role") if isinstance(message, dict) else None for message in messages]
            if actual_roles != expected_roles:
                fail(f"{path}:{line_number}: expected roles {expected_roles}, got {actual_roles}")

            for message in messages:
                content = message.get("content")
                if not isinstance(content, str):
                    fail(f"{path}:{line_number}: message content must be text")
                secret_type = find_secret(content)
                if secret_type:
                    # Deliberately do not print the matching value.
                    fail(f"{path}:{line_number}: possible {secret_type}; refusing to train")

            try:
                answer = json.loads(messages[2]["content"])
            except json.JSONDecodeError as exc:
                fail(f"{path}:{line_number}: assistant content is not JSON ({exc.msg})")
            if not isinstance(answer, dict) or answer.get("action") not in ALLOWED_ACTIONS:
                fail(f"{path}:{line_number}: assistant action must be one of {sorted(ALLOWED_ACTIONS)}")

            meta = row.get("meta")
            if not isinstance(meta, dict) or meta.get("game") is None:
                fail(f"{path}:{line_number}: meta.game is required for leakage checks")
            if meta.get("action") != answer.get("action"):
                fail(f"{path}:{line_number}: meta.action disagrees with the assistant action")

            games.add(str(meta["game"]))
            actions[str(answer["action"])] += 1
            if meta.get("role"):
                roles[str(meta["role"])] += 1
            count += 1

    if count == 0:
        fail(f"Dataset is empty: {path}")
    return {"examples": count, "games": games, "actions": actions, "roles": roles}


def print_stats(label: str, stats: dict[str, Any]) -> None:
    print(f"{label}: {stats['examples']:,} examples across {len(stats['games']):,} games")
    print(f"  actions: {dict(sorted(stats['actions'].items()))}")
    print(f"  roles: {len(stats['roles']):,} distinct")


def validate_datasets(train_path: Path, eval_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    train_stats = validate_file(train_path)
    eval_stats = validate_file(eval_path)
    overlap = train_stats["games"] & eval_stats["games"]
    if overlap:
        fail(
            f"Train/eval leakage: {len(overlap)} game(s) occur in both files. "
            "Re-run scripts/sample-dataset.mjs."
        )
    print_stats("train", train_stats)
    print_stats("eval", eval_stats)
    print("privacy: no credential patterns found in message text")
    print("split: train and eval game IDs are disjoint")
    return train_stats, eval_stats


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "not installed"


def resolve_resume(value: str | None, output_dir: Path) -> str | None:
    if value is None:
        return None
    if value != "auto":
        checkpoint = Path(value).expanduser()
        if not checkpoint.is_dir():
            fail(f"Resume checkpoint does not exist: {checkpoint}")
        return str(checkpoint)

    from transformers.trainer_utils import get_last_checkpoint

    checkpoint = get_last_checkpoint(str(output_dir)) if output_dir.is_dir() else None
    if checkpoint is None:
        fail(f"--resume requested, but no checkpoint exists under {output_dir}")
    return checkpoint


def main() -> int:
    args = parse_args()
    train_path = Path(args.train).expanduser().resolve()
    eval_path = Path(args.eval).expanduser().resolve()
    validate_datasets(train_path, eval_path)
    if args.dry_run:
        print("dry run complete; model libraries were not loaded")
        return 0

    # Import Unsloth before Transformers so it can apply its runtime patches.
    try:
        from unsloth import FastLanguageModel, is_bfloat16_supported
        from datasets import load_dataset
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:
        print(
            "Training dependencies are missing. Run: "
            "pip install -U -r requirements-train.txt",
            file=sys.stderr,
        )
        raise exc

    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("PyTorch is required for training") from exc
    if not torch.cuda.is_available():
        fail("No CUDA GPU is visible. In Colab select Runtime > Change runtime type > GPU.")

    output_dir = Path(args.output_dir).expanduser().resolve()
    adapter_dir = Path(args.adapter_dir).expanduser().resolve() if args.adapter_dir else output_dir / "adapter"
    gguf_dir = Path(args.gguf_dir).expanduser().resolve() if args.gguf_dir else output_dir / "gguf"
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"python: {platform.python_version()}")
    print(f"gpu: {torch.cuda.get_device_name(0)}")
    print(
        "packages: "
        + ", ".join(
            f"{name}={package_version(name)}"
            for name in ("unsloth", "trl", "transformers", "datasets", "torch")
        )
    )
    print(f"model: {args.model}")
    print(f"checkpoints: {output_dir}")

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_length,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        use_gradient_checkpointing="unsloth",
        random_state=args.seed,
    )

    dataset = load_dataset(
        "json",
        data_files={"train": str(train_path), "eval": str(eval_path)},
    )
    # TRL natively accepts a `messages` column, but some Unsloth-patched TRL
    # versions still require either a formatting_func or prompt/completion
    # columns. Use conversational prompt/completion records: they preserve the
    # model's chat template and give the trainer an exact completion mask.
    def to_prompt_completion(example: dict[str, Any]) -> dict[str, Any]:
        messages = example["messages"]
        return {"prompt": messages[:-1], "completion": messages[-1:]}

    for split in ("train", "eval"):
        dataset[split] = dataset[split].map(
            to_prompt_completion,
            remove_columns=dataset[split].column_names,
            desc=f"Preparing {split} prompts and completions",
        )
    if args.max_train_samples:
        dataset["train"] = dataset["train"].select(
            range(min(args.max_train_samples, len(dataset["train"])))
        )
    if args.max_eval_samples:
        dataset["eval"] = dataset["eval"].select(
            range(min(args.max_eval_samples, len(dataset["eval"])))
        )

    bf16 = bool(is_bfloat16_supported())
    config = SFTConfig(
        output_dir=str(output_dir),
        max_length=args.max_length,
        completion_only_loss=True,
        packing=False,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        warmup_steps=args.warmup_steps,
        lr_scheduler_type="cosine",
        optim="adamw_8bit",
        logging_steps=args.logging_steps,
        eval_strategy="steps",
        eval_steps=args.eval_steps,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=2,
        fp16=not bf16,
        bf16=bf16,
        report_to="none",
        seed=args.seed,
        data_seed=args.seed,
    )
    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=dataset["train"],
        eval_dataset=dataset["eval"],
        args=config,
    )
    checkpoint = resolve_resume(args.resume, output_dir)
    trainer.train(resume_from_checkpoint=checkpoint)

    adapter_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))
    print(f"saved LoRA adapter: {adapter_dir}")

    if args.save_gguf:
        gguf_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained_gguf(
            str(gguf_dir), tokenizer, quantization_method=args.gguf_quant
        )
        print(f"saved {args.gguf_quant} GGUF: {gguf_dir}")
    else:
        print("GGUF export skipped; pass --save-gguf when you want an Ollama artifact")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)
