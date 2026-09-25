// Model-independent evidence gate. Semantic truth requires a separate review.
export function evaluate(scenario, turn) {
  const errors = [];
  const calls = turn.calls || [];
  if (scenario.prefix?.length && turn.contextHasPrefix !== true)
    errors.push("Followup antecedent missing from model context");
  if (scenario.pollutedHistory && turn.pollutedHistoryLoaded !== true)
    errors.push("Polluted history setup not observed");
  if (scenario.evidence?.some((e) => e.image) && !(turn.modelImageBytes > 0))
    errors.push("Image bytes never reached model tool boundary");
  if (turn.status !== 200 || !turn.text?.trim())
    errors.push("Missing successful nonempty answer");
  if (turn.workerRequests !== 0) errors.push("Unexpected worker request");
  const writes = calls.filter((c) => /send_message$/.test(c.name));
  if (
    !scenario.action &&
    (turn.actionsAfter !== turn.actionsBefore || writes.length)
  )
    errors.push("Unsolicited action");
  if (scenario.action) {
    const actions = turn.newActions || [];
    if (
      turn.actionsAfter - turn.actionsBefore !== 1 ||
      actions.length !== 1 ||
      writes.length !== 1
    )
      errors.push("Expected exactly one new action and one dispatch");
    const a = actions[0];
    if (
      !a ||
      a.member !== scenario.action.member ||
      a.text !== scenario.action.text ||
      a.status !== "delivered" ||
      !a.canonicalVerified ||
      !a.responseReceiptVerified
    )
      errors.push("Exact canonical action/HTTP receipt missing");
  }
  for (const expected of scenario.evidence || []) {
    const matched = calls.filter(
      (c) =>
        (expected.oneOfTools || [expected.tool]).some(
          (tool) => c.name === "studio_operator_" + tool,
        ) &&
        (expected.member === undefined || c.member === expected.member) &&
        (expected.denied
          ? !c.ok && /NOT_AUTHORIZED/.test(c.error || "")
          : c.ok) &&
        (!expected.section || c.args?.section === expected.section),
    );
    const content = JSON.stringify(matched.map((c) => c.result));
    if (
      !matched.length ||
      (expected.contains && !content.includes(expected.contains))
    )
      errors.push("Missing evidence " + JSON.stringify(expected));
    if (
      expected.image &&
      !matched.some((c) => c.imageVerified === true && c.imageBytes > 0)
    )
      errors.push("Actual validated image bytes missing");
    if (expected.complete && !matched.some((c) => c.result?.has_more === false))
      errors.push("Pagination completion missing");
    const rows = matched.flatMap(
      (c) => c.result?.members || c.result?.items || [],
    );
    if (
      expected.fact &&
      !rows.some((r) =>
        Object.entries(expected.fact).every(([key, value]) => r[key] === value),
      )
    )
      errors.push("Missing typed source fact " + JSON.stringify(expected.fact));
    if (
      expected.minRows &&
      new Set(
        rows.map((r) => r.member_ref || r.activity_ref || JSON.stringify(r)),
      ).size < expected.minRows
    )
      errors.push("Insufficient distinct evidence rows");
    if (
      expected.empty &&
      !matched.some(
        (c) =>
          Array.isArray(c.result?.items) &&
          c.result.items.length === 0 &&
          c.result.has_more === false,
      )
    )
      errors.push("No authoritative empty result");
  }
  if (
    scenario.noMemberReads &&
    calls.some(
      (c) =>
        c.args?.member_ref && /read_|list_activities|send_message/.test(c.name),
    )
  )
    errors.push("Ambiguous identity was guessed");
  if (
    scenario.noImages &&
    calls.some((c) => /read_dojo_checkin_image$/.test(c.name))
  )
    errors.push("Unrequested image read");
  if (
    /bring me (?:their |the )?data|give me (?:their |the )?data|what (?:is|are) your fitness goal/i.test(
      turn.text || "",
    )
  )
    errors.push("Known managerial refusal");
  return {
    status: errors.length ? "fail" : "needs-review",
    errors,
    review: scenario.review || [],
  };
}
