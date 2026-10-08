import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureSpec } from "../src/worker/pipeline/docs.ts";
import {
  docsDirectory,
  featureBranch,
  implementPrompt,
  isVerdictReminder,
  PROMPT_MARKER,
  parseUserMessage,
  parseVerdict,
  promptStep,
  reviewPrompt,
  testPrompt,
  USER_MESSAGE_MARKER,
  userMessagePrompt,
  VERDICT,
  verdictReminder,
} from "../src/worker/pipeline/roles.ts";

const SPEC: FeatureSpec = {
  name: "feature-a-b-c",
  repo: "https://example.com/project.git",
  ref: "main",
  task: "Add a thing.",
  rootSetup: "",
  userSetup: "",
  env: {},
};

test("reads the verdict line of an answer", () => {
  assert.equal(parseVerdict("All good.\nVERDICT: PASS"), VERDICT.pass);
  assert.equal(parseVerdict("Two failures.\n  verdict: fail\n"), VERDICT.fail);
  assert.equal(parseVerdict("No line here."), undefined);
});

test("reads a verdict line with Markdown marks", () => {
  assert.equal(parseVerdict("**VERDICT: PASS**"), VERDICT.pass);
  assert.equal(parseVerdict("- VERDICT: FAIL"), VERDICT.fail);
  assert.equal(parseVerdict("> `VERDICT:` **PASS**"), VERDICT.pass);
});

test("takes the last verdict line when an answer has more than one", () => {
  assert.equal(parseVerdict("VERDICT: PASS\nOn a second look:\nVERDICT: FAIL"), VERDICT.fail);
});

test("does not read a verdict in the middle of a sentence", () => {
  assert.equal(parseVerdict("The rule says to write VERDICT: PASS at the end."), undefined);
});

test("derives the branch and the documents folder from the feature name", () => {
  assert.equal(featureBranch(SPEC.name), "feature/feature-a-b-c");
  assert.equal(docsDirectory(SPEC.name), "docs/features/feature-a-b-c");
});

test("starts each prompt with the markers of its role and step", () => {
  const prompt = testPrompt(SPEC, 2);
  assert.ok(prompt.startsWith(`${PROMPT_MARKER.role} tester\n${PROMPT_MARKER.feature} feature-a-b-c\n`));
  assert.ok(prompt.includes(`${PROMPT_MARKER.step} test-2`));
});

test("gives the findings to the implementer in a later round", () => {
  assert.ok(!implementPrompt(SPEC, 1, "").includes("was not accepted"));
  const repair = implementPrompt(SPEC, 2, "The function has no docstring.");
  assert.ok(repair.includes("This is round 2."));
  assert.ok(repair.includes("The function has no docstring."));
});

test("wraps a message of the user and reads it back", () => {
  const prompt = userMessagePrompt("  Use a keyword argument.\nKeep the old name.  ", true);
  assert.ok(prompt.startsWith(`${USER_MESSAGE_MARKER}\n`));
  assert.equal(parseUserMessage(prompt), "Use a keyword argument.\nKeep the old name.");
  assert.match(prompt, /finish the step/);
  assert.match(userMessagePrompt("Why this name?", false), /Do not change a file/);
  assert.equal(parseUserMessage(testPrompt(SPEC, 1)), undefined);
});

test("reads the step of a pipeline prompt", () => {
  assert.equal(promptStep(implementPrompt(SPEC, 2, "A finding.")), "implement-2");
  assert.equal(promptStep(userMessagePrompt("Hello", true)), undefined);
  assert.ok(isVerdictReminder(verdictReminder()));
  assert.ok(!isVerdictReminder(testPrompt(SPEC, 1)));
});

test("puts the request of a follow-up into the prompts of its rounds", () => {
  const request = "Add a default of zero for the time.";
  const first = implementPrompt(SPEC, 3, "", request);
  assert.match(first, /STEP: implement-3/);
  assert.match(first, /The user now asks for this change:\n\nAdd a default of zero/);
  const repair = implementPrompt(SPEC, 4, "The default has no test.", request);
  assert.match(repair, /The user asked for this change after the earlier rounds:\n\nAdd a default of zero/);
  assert.match(repair, /Fix each of these findings/);
  assert.match(testPrompt(SPEC, 3, request), /Add a default of zero/);
  assert.match(reviewPrompt(SPEC, 3, request), /Add a default of zero/);
  // The first pipeline of a feature has no request, and its prompts do not change.
  assert.ok(!testPrompt(SPEC, 1).includes("after the earlier rounds"));
  assert.ok(!reviewPrompt(SPEC, 1).includes("after the earlier rounds"));
});
