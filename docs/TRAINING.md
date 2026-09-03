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
30 chat lines in the briefing. The sampler keeps every vote and unvote, samples
chat down to twice the vote count, caps a seat at 40 chat examples, holds out
5% of games whole, and caps the training side at 30,000 examples
(`--max-train`), which is about one T4 session.

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
`{"action":"say|vote|unvote","meeting":"...","target":"...","text":"..."}`.
Chat sent within 15 seconds is merged into one example with lines separated by
`|`, matching the harness's staggered multi-line sends.

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
one epoch, a 2e-4 learning rate, 50 warmup steps, evaluation/checkpointing every
200 steps and at most two retained checkpoints. The harness converts each
three-message example to TRL's conversational `prompt` + `completion` format
and uses `completion_only_loss=True`. This also works around Unsloth releases
whose patched trainer does not recognize a standalone `messages` column.
See the official [TRL SFTTrainer documentation](https://huggingface.co/docs/trl/sft_trainer)
and [Unsloth repository](https://github.com/unslothai/unsloth) if their APIs or
Colab installation instructions change.

## 4. Run it through the game harness

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

## 5. Measure before seating it

`data/eval.jsonl` holds whole games the model never saw. For each example, send
the prompt and compare the model's JSON to the human's: exact match on votes,
and action agreement on chat versus vote. That is a single offline number you
can run on any candidate model, base or tuned, in a few minutes on the GPU. A
tuned model that does not beat the base model on held-out votes is not ready.
