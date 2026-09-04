# Fine-tuning a local model on the UltiMafia archive

The goal is a small model that plays through `src/agent.js` the way the
site's regulars do: same shorthand, same pacing, same reflexes. It is
behaviour cloning, not reinforcement learning. The model learns to predict what
a winning human did next from exactly the prompt the harness will show it.

## 1. Build the dataset (laptop, CPU)

`mafia.db` is the site's per-game archive: every meeting with its vote record
and messages, every server alert, the role map and the winners. The builder
replays each game from each chosen seat through the client's own `GameState`
and renderer, so the prompt in every example is byte-for-byte what the harness
would have sent at that moment.

```bash
node scripts/build-dataset.mjs --out data/train-full.jsonl
node scripts/sample-dataset.mjs --in data/train-full.jsonl --train data/train.jsonl --eval data/eval.jsonl --max-train 30000
```

Defaults: Mafia-type games with 5+ players, a recorded winner and 100+ Village
messages; seats on the winning side only (`--all-seats` to include losers);
30 chat lines in the briefing. The sampler keeps every vote, unvote and special
speech action such as Cry; samples ordinary chat down to twice the kept-action
count; caps a seat at 40 ordinary-chat examples; holds out 5% of games whole;
and caps the training side at 30,000 examples (`--max-train`). A T4 is too slow
for this full run; use a smaller smoke test there or a faster local GPU.

What each seat is allowed to see is rebuilt from the archive: its own role,
faction partners, flips, public alerts, and private reports whose checked
target matches that seat's final action in the preceding Night. This separates
counterpart roles that share meetings and report syntax (Detective/Stalker,
Tracker/Scout, Watcher/Lookout, Journalist/Informant). Justice, Gramps,
Actress, Janitor and Caroler reports are also assigned from their specific
actions. If two actors made the same indistinguishable check, or no unique
recipient can be recovered, the alert is withheld from every seat.

Replay also starts each phase from the preceding phase's death snapshot and
applies instant obituaries at their recorded time. This prevents an early-day
example from seeing a player or role flip caused by a later gunshot; cleaned
deaths stay unrevealed when their obituary has no reveal message. Because the
archive also saves final meeting membership, instant victims are restored to
the Village meeting and its legal targets until the obituary event removes
them.

**Settle the system prompt before building.** It is baked into every example.
Changing `prompts/local-agent.md` afterwards means rebuilding and retraining.

Each line is `{"messages": [system, user, assistant], "meta": {...}}`. The
assistant turn is the same JSON the harness parses:
`{"action":"say|cry|vote|unvote","meeting":"...","target":"...","text":"..."}`.
Chat sent within 15 seconds is merged into one example with lines separated by
`|`, matching the harness's staggered multi-line sends.

Archived review history retains the real sender id behind anonymous Crier
messages. The builder recognizes the `cries out` marker, presents its author as
`Anonymous` in every briefing, and labels the actor's decision as `cry` rather
than the dangerous public `say`. Cry and ordinary chat are never merged.

## 2. Keep private material out of Git

Only push the code. `mafia.db`, its WAL/SHM files, `config.json`, `.env`, all
generated JSONL/ZIP datasets, checkpoints, adapters and GGUF files are ignored.
The model artifacts are excluded because they are large and can memorize parts
of their training input. Before every push, run:

```bash
npm run privacy-check
git status --short
```

The privacy check examines every tracked or non-ignored untracked file that
`git add -A` could stage. It rejects known private paths and common credential
patterns without printing a matching secret. This is a guardrail, not a reason
to paste credentials into source files.

Put `train.jsonl` and `eval.jsonl` in a private Google Drive directory, for
example `MyDrive/um-training/data/`. Do not upload `mafia.db` to Colab: the
training machine only needs the two sampled files.

## 3. Train in Colab

Pick a **dense** base model. The default is
`unsloth/Qwen3-4B-Instruct-2507`; use a smaller compatible instruct model for a
cheap first pass. In Colab, enable a GPU under **Runtime > Change runtime type**,
then run these cells. Replace the repository URL:

```python
!git clone https://github.com/YOUR_NAME/YOUR_REPO.git
%cd YOUR_REPO
!pip install -q -U -r requirements-train.txt
```

```python
from google.colab import drive
drive.mount("/content/drive")
```

Validate the format, credential scan and whole-game train/eval split before
allocating the model:

```python
!python training/train.py \
  --train /content/drive/MyDrive/um-training/data/train.jsonl \
  --eval /content/drive/MyDrive/um-training/data/eval.jsonl \
  --dry-run
```

Then train. Checkpoints and the final adapter go directly to Drive, so a Colab
disconnect does not erase them. No model-hub upload or experiment tracker is
enabled, and metadata is removed before the dataset is passed to the trainer.
Loss is computed only on the assistant response, not on the perspective-specific
briefing that precedes it.

```python
!python training/train.py \
  --train /content/drive/MyDrive/um-training/data/train.jsonl \
  --eval /content/drive/MyDrive/um-training/data/eval.jsonl \
  --output-dir /content/drive/MyDrive/um-training/qwen3-4b \
  --save-gguf
```

If Colab disconnects, repeat the setup and mount cells, then add `--resume` to
the same command. It finds the newest checkpoint under `--output-dir`. To test
the plumbing before a full run, add `--max-train-samples 64
--max-eval-samples 32 --epochs 0.05` and omit `--save-gguf`.

The defaults are a 4-bit LoRA, sequence length 3072, effective batch size 16,
one epoch, a 2e-4 learning rate, 50 warmup steps, one evaluation at the end of
the epoch, checkpointing every 200 steps and at most two retained checkpoints.
Repeatedly evaluating all 6,000+ held-out examples is expensive; opt into it
with `--eval-strategy steps --eval-steps N` only when needed. The harness
converts each three-message example to TRL's conversational `prompt` + `completion` format
and uses `completion_only_loss=True`. This also works around Unsloth releases
whose patched trainer does not recognize a standalone `messages` column.
See the official [TRL SFTTrainer documentation](https://huggingface.co/docs/trl/sft_trainer)
and [Unsloth repository](https://github.com/unslothai/unsloth) if their APIs or
Colab installation instructions change.

## 4. Train on a local RTX 4090 (24 GB)

The RTX 4090 is a much better fit for the full 4B/30,000-example run than a
Colab T4. Exact throughput depends mostly on prompt lengths, library versions
and thermals, so use the ETA after 10–20 optimizer steps rather than assuming a
fixed duration.

### System setup

Linux or WSL2 Ubuntu is the simplest path. Native Windows is also supported by
Unsloth; if using it, install a CUDA-enabled PyTorch build first and then run
the same Python commands in PowerShell. Keep the repository and dataset on an
SSD, and leave tens of gigabytes free for model downloads, checkpoints and the
temporary files used during GGUF merging.

Verify that the NVIDIA driver can see the card:

```bash
nvidia-smi
```

Clone the repository and create an isolated environment. Python 3.12 is a
conservative choice for the CUDA training stack:

```bash
git clone https://github.com/YOUR_NAME/YOUR_REPO.git
cd YOUR_REPO
python3 -m venv .venv
source .venv/bin/activate                 # PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install --upgrade -r requirements-train.txt
```

Confirm that PyTorch is using the 4090 rather than silently falling back to
the CPU:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0), torch.version.cuda)"
```

It must print `True` and identify the RTX 4090. If it does not, select the
current CUDA wheel using the official PyTorch installer and reinstall Unsloth
after PyTorch works. Unsloth's current installation guide recommends
`pip install unsloth` and supports Linux, Windows and WSL; its Windows guide
also covers Conda, Docker and WSL alternatives.

### Copy and validate the data

Send only `train.jsonl` and `eval.jsonl`, preferably over a private transfer.
They contain game chat and perspective-specific information. Put them under
`data/`; Git ignores them. The trainer does not need `mafia.db`, cookies,
`config.json`, or any other runtime state.

If you received `um-dataset.zip`, extract it from the repository root:

```bash
unzip um-dataset.zip -d data
```

In PowerShell, use:

```powershell
Expand-Archive -LiteralPath .\um-dataset.zip -DestinationPath .\data
```

The archive should create `data/train.jsonl` and `data/eval.jsonl`. You can
delete the transferred ZIP after checking that both files are present.

```bash
python training/train.py --train data/train.jsonl --eval data/eval.jsonl --dry-run
```

Run a small end-to-end smoke test before committing to the full job. The sample
limits are shuffled deterministically rather than taking the first games:

```bash
python training/train.py \
  --train data/train.jsonl \
  --eval data/eval.jsonl \
  --output-dir training-output/smoke \
  --max-train-samples 64 \
  --max-eval-samples 32 \
  --epochs 0.05
```

### Full 4090 run

Start with a per-device batch of 4 and four accumulation steps. This preserves
the default effective batch size of 16 while reducing accumulation overhead:

```bash
python training/train.py \
  --train data/train.jsonl \
  --eval data/eval.jsonl \
  --model unsloth/Qwen3-4B-Instruct-2507 \
  --output-dir training-output/qwen3-4b \
  --batch-size 4 \
  --eval-batch-size 4 \
  --gradient-accumulation 4 \
  --save-gguf
```

If that runs out of VRAM, retry with `--batch-size 2 --eval-batch-size 2
--gradient-accumulation 8`. The effective batch remains 16. Do not reduce the
sequence length merely to fix an OOM without auditing truncation: the action
JSON is at the end of each example and must remain in the tokenized sequence.

In another terminal, monitor utilization, temperature and memory with:

```bash
watch -n 2 nvidia-smi
```

The first few steps include kernel compilation. Judge speed after 10–20 steps;
the training progress line reports seconds per optimizer step. If interrupted,
rerun the full command with `--resume`. Checkpoints are written every 200 steps
and only the newest two are retained. `--save-gguf` runs after training; the
LoRA adapter is saved first under `training-output/qwen3-4b/adapter`, so a GGUF
conversion failure does not discard the trained adapter.

Official references: [Unsloth pip installation](https://unsloth.ai/docs/get-started/install-update/pip-install),
[Unsloth Windows installation](https://unsloth.ai/docs/get-started/install/windows-installation),
[Unsloth VRAM requirements](https://unsloth.ai/docs/get-started/fine-tuning-for-beginners/unsloth-requirements),
and [PyTorch's local installation selector](https://pytorch.org/get-started/locally/).

## 5. Run it through the game harness

Download the GGUF, then:

```
# Modelfile
FROM ./um-qwen3-4b-Q4_K_M.gguf
PARAMETER num_ctx 8192
```

```bash
ollama create um-qwen3-4b -f Modelfile
node src/agent.js --model um-qwen3-4b --chat 30 --tail-budget 2000
```

Nothing in the harness changes. Use the same `--chat` the dataset was built
with so the briefing matches training. On a dense model the tail budget can be
large, since the cached prefix is reused at any split point.

## 6. Measure before seating it

`data/eval.jsonl` holds whole games the model never saw. For each example, send
the prompt and compare the model's JSON to the human's: exact match on votes,
and action agreement on chat versus vote. That is a single offline number you
can run on any candidate model, base or tuned, in a few minutes on the GPU. A
tuned model that does not beat the base model on held-out votes is not ready.
