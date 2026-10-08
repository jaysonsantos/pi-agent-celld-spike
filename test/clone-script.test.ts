import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SETUP_DIRECTORY } from "../src/worker/pipeline/roles.ts";
import { CLONE_SCRIPT } from "../src/worker/sandbox/provision.ts";

const BRANCH = "feature/demo";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let root: string;
let origin: string;
let workspace: string;
let setupDirectory: string;
let script: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();
}

/** Runs the script as the sandbox does: in the workspace, with the lock file that the bootstrap made. */
function runClone(ref: string): void {
  execFileSync("bash", ["-c", script], {
    cwd: workspace,
    env: { ...process.env, REPO_URL: origin, BRANCH, REF: ref },
    stdio: "pipe",
  });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "clone-script-"));
  origin = join(root, "origin");
  workspace = join(root, "workspace");
  setupDirectory = join(workspace, ".pi");
  mkdirSync(origin);
  mkdirSync(setupDirectory, { recursive: true });
  writeFileSync(join(setupDirectory, "setup.lock"), "");
  // The sandbox has the setup folder at a fixed path; the test puts it in a temporary folder.
  script = CLONE_SCRIPT.replaceAll(SETUP_DIRECTORY, setupDirectory);
  git(origin, "init", "--quiet", "--initial-branch", "main");
  writeFileSync(join(origin, "a.txt"), "one\n");
  git(origin, "add", "a.txt");
  git(origin, "commit", "--quiet", "--message", "first");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("clones the repository onto the feature branch and records the start commit", () => {
  runClone("main");
  const repo = join(workspace, "repo");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), BRANCH);
  assert.equal(readFileSync(join(setupDirectory, "base-commit"), "utf8").trim(), git(origin, "rev-parse", "HEAD"));
});

test("keeps the work of the agents when the script runs again", () => {
  const repo = join(workspace, "repo");
  writeFileSync(join(repo, "new.txt"), "work in progress\n");
  runClone("main");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "work in progress\n");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), BRANCH);
});

test("makes a clone again when an earlier clone stopped in the middle", () => {
  const repo = join(workspace, "repo");
  rmSync(repo, { recursive: true, force: true });
  rmSync(join(setupDirectory, "base-commit"));
  // What a killed `git clone` leaves: a folder with a repository that has no commit.
  mkdirSync(repo);
  git(repo, "init", "--quiet");
  mkdirSync(join(workspace, "repo.partial"));
  runClone("");
  assert.ok(existsSync(join(repo, "a.txt")));
  assert.ok(!existsSync(join(workspace, "repo.partial")));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), BRANCH);
  assert.equal(readFileSync(join(setupDirectory, "base-commit"), "utf8").trim(), git(origin, "rev-parse", "HEAD"));
});
