#!/usr/bin/env node
// Cut a training set and a held-out set from build-dataset.mjs output.
//
// Chat lines outnumber votes five to one in the raw dump, and one chatty
// player can contribute hundreds of near-identical examples. Keep every vote,
// unvote and special speech action, sample ordinary chat down to --say-ratio
// times the kept-action count, cap any one seat, and hold out whole games.
//
//   node scripts/sample-dataset.mjs --in data/train-full.jsonl \
//        --train data/train.jsonl --eval data/eval.jsonl \
//        [--say-ratio 2] [--max-per-seat 40] [--holdout 0.05] [--max-train 30000] [--seed 7]

import fs from "node:fs";
import readline from "node:readline";
import { parseArgs } from "../src/agent.js";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const inPath = flags.in || "data/train-full.jsonl";
  const trainPath = flags.train || "data/train.jsonl";
  const evalPath = flags.eval || "data/eval.jsonl";
  const sayRatio = Number(flags["say-ratio"] || 2);
  const maxPerSeat = Number(flags["max-per-seat"] || 40);
  const holdout = Number(flags.holdout || 0.05);
  const maxTrain = Number(flags["max-train"] || 0); // 0 = no cap
  const rand = rng(Number(flags.seed || 7));

  // Pass 1: index lines by game/seat/action without holding the text.
  const index = []; // {offset, len, game, seat, action}
  let offset = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
  for await (const line of rl) {
    const len = Buffer.byteLength(line) + 1;
    if (line.trim()) {
      const m = JSON.parse(line).meta;
      index.push({ offset, len, game: m.game, seat: `${m.game}/${m.player}`, action: m.action });
    }
    offset += len;
  }

  const games = [...new Set(index.map((x) => x.game))];
  const evalGames = new Set(games.filter(() => rand() < holdout));

  const perSeat = {};
  const chosen = [];
  const mustKeep = index.filter((x) => x.action !== "say");
  const says = index.filter((x) => x.action === "say");
  for (const x of mustKeep) chosen.push(x);
  // Shuffle chat and take up to the ratio, respecting the per-seat cap.
  const shuffled = says.slice().sort(() => rand() - 0.5);
  const sayBudget = Math.round(mustKeep.length * sayRatio);
  let taken = 0;
  for (const x of shuffled) {
    if (taken >= sayBudget) break;
    perSeat[x.seat] = (perSeat[x.seat] || 0) + 1;
    if (perSeat[x.seat] > maxPerSeat) continue;
    chosen.push(x);
    taken++;
  }
  // A T4 session trains roughly 30k examples of this size in five hours, so
  // cap the training side at random while keeping the held-out games whole.
  let trainPick = chosen.filter((x) => !evalGames.has(x.game));
  const evalPick = chosen.filter((x) => evalGames.has(x.game));
  if (maxTrain > 0 && trainPick.length > maxTrain) {
    trainPick = trainPick.sort(() => rand() - 0.5).slice(0, maxTrain);
  }
  chosen.length = 0;
  chosen.push(...trainPick, ...evalPick);
  chosen.sort((a, b) => a.offset - b.offset);

  const fd = fs.openSync(inPath, "r");
  const train = fs.createWriteStream(trainPath);
  const evals = fs.createWriteStream(evalPath);
  const stats = { train: 0, eval: 0, byAction: {} };
  for (const x of chosen) {
    const buf = Buffer.alloc(x.len);
    fs.readSync(fd, buf, 0, x.len, x.offset);
    const line = buf.toString("utf8").replace(/\n$/, "") + "\n";
    if (evalGames.has(x.game)) {
      evals.write(line);
      stats.eval++;
    } else {
      train.write(line);
      stats.train++;
    }
    stats.byAction[x.action] = (stats.byAction[x.action] || 0) + 1;
  }
  train.end();
  evals.end();
  console.log(JSON.stringify({ ...stats, games: games.length, evalGames: evalGames.size, from: index.length }, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
