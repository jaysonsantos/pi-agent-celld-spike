import assert from "node:assert/strict";
import { test } from "node:test";
import { joinPosixPath, resolvePosixPath } from "../src/worker/sandbox/execution-env.ts";

test("resolves a relative path against the working directory", () => {
  assert.equal(resolvePosixPath("/workspace/repo", "src/a.py"), "/workspace/repo/src/a.py");
  assert.equal(resolvePosixPath("/workspace/repo", "./src/../test/b.py"), "/workspace/repo/test/b.py");
});

test("keeps an absolute path and removes dot segments", () => {
  assert.equal(resolvePosixPath("/workspace/repo", "/tmp//x/./y/../z"), "/tmp/x/z");
  assert.equal(resolvePosixPath("/workspace/repo", "/.."), "/");
  assert.equal(resolvePosixPath("/workspace", "../../.."), "/");
});

test("joins parts as the POSIX join does", () => {
  assert.equal(joinPosixPath(["/a/b", "..", "c"]), "/a/c");
  assert.equal(joinPosixPath(["a", "", "b/"]), "a/b");
  assert.equal(joinPosixPath([]), ".");
  assert.equal(joinPosixPath(["..", "a"]), "../a");
  assert.equal(joinPosixPath(["/", "..", "a"]), "/a");
});
