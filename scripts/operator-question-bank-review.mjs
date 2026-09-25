// Explicit human/adjudicator review, separate from the tested model.
// node ...-review.mjs RECEIPT REVIEW_JSON OUTPUT; --template emits unsigned form.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cases } from "./operator-question-bank-cases.mjs";
const [receiptPath, reviewPath, output] = process.argv.slice(2);
if (!receiptPath || !reviewPath || !output)
  throw new Error("Usage: RECEIPT REVIEW_JSON|--template OUTPUT");
const raw = await readFile(receiptPath),
  receipt = JSON.parse(raw),
  digest = createHash("sha256").update(raw).digest("hex");
if (reviewPath === "--template") {
  await writeFile(
    output,
    JSON.stringify(
      {
        receiptSha256: digest,
        reviewer: "",
        turns: receipt.turns.map((t) => ({
          id: t.id,
          repeat: t.repeat,
          checks: (t.review || []).map((criterion) => ({
            criterion,
            pass: null,
            answerQuote: "",
            evidence: "",
            reason: "",
          })),
        })),
      },
      null,
      2,
    ) + "\n",
  );
} else {
  const review = JSON.parse(await readFile(reviewPath, "utf8")),
    errors = [];
  if (receipt.mode !== "live-pi")
    errors.push("Scripted wiring is not live acceptance");
  if (receipt.status !== "needs-review")
    errors.push("Receipt has failing/incomplete automatic gates");
  if (review.receiptSha256 !== digest)
    errors.push("Review does not bind to exact receipt SHA");
  if (!review.reviewer?.trim()) errors.push("Named reviewer required");
  if (
    receipt.coverage.length !== cases.length ||
    cases.some((c) => !receipt.coverage.includes(c.id))
  )
    errors.push("Full bank coverage required");
  for (const c of cases) {
    const turns = receipt.turns.filter((t) => t.id === c.id);
    const minimum = /^exact-comparison$|^comparison-/.test(c.id) ? 3 : 1;
    if (
      turns.length < minimum ||
      new Set(turns.map((t) => t.repeat)).size !== turns.length
    )
      errors.push("Missing/duplicate required repetitions: " + c.id);
  }
  if (review.turns?.length !== receipt.turns.length)
    errors.push("Missing/extra reviewed turns");
  for (const t of receipt.turns) {
    const matches =
      review.turns?.filter((r) => r.id === t.id && r.repeat === t.repeat) || [];
    if (matches.length !== 1) {
      errors.push(`Missing/duplicate review ${t.id}/${t.repeat}`);
      continue;
    }
    const r = matches[0];
    if (r.checks?.length !== t.review.length)
      errors.push(`Wrong criteria count ${t.id}/${t.repeat}`);
    for (const criterion of t.review) {
      const checks = r.checks?.filter((c) => c.criterion === criterion) || [];
      const c = checks[0];
      if (
        checks.length !== 1 ||
        c.pass !== true ||
        !c.answerQuote?.trim() ||
        !t.text?.includes(c.answerQuote) ||
        !c.evidence?.trim() ||
        !c.reason?.trim()
      )
        errors.push(
          `Unverified semantic criterion ${t.id}/${t.repeat}: ${criterion}`,
        );
    }
  }
  const report = {
    status: errors.length ? "fail" : "pass",
    scope:
      "Finite synthetic question-bank acceptance; not universal reliability or deployed UI proof",
    receiptSha256: digest,
    reviewer: review.reviewer,
    errors,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  process.exitCode = errors.length ? 1 : 0;
}
