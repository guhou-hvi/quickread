import assert from "node:assert/strict";
import test from "node:test";

import {
  readerFirstInputHashes,
  readerFirstReviewContractErrors,
} from "../scripts/reader-first-review.mjs";
import { segmentClipBounds } from "../scripts/screenshot.mjs";

const inputs = {
  segments: [{ id: "S0001" }],
  claims: [{ id: "E0001" }],
  deepRead: { caseId: "qr-test" },
  readerMap: { entries: [] },
  research: { citations: [] },
  brief: { caseId: "qr-test" },
  readerMarkdown: "# test",
};

function validRecord() {
  return {
    schemaVersion: "1.0.0",
    caseId: "qr-test",
    reviewPolicyVersion: "2.3.2",
    reviewRound: 1,
    gatePolicy: "concrete_hard_errors",
    inputHashes: readerFirstInputHashes(inputs),
    reviewers: [
      { role: "source_scout", reviewerId: "source-1", status: "pass", hardErrors: [], warnings: [] },
      { role: "fidelity", reviewerId: "fidelity-1", status: "pass", hardErrors: [], warnings: [] },
      { role: "reader_advocate", reviewerId: "reader-1", status: "pass", hardErrors: [], warnings: [] },
    ],
    hardErrors: [],
    warnings: [],
    diagnostics: [],
    humanReviewRequired: true,
  };
}

test("reader-first 2.3.2 review accepts three isolated roles bound to current inputs", () => {
  const record = validRecord();
  assert.deepEqual(readerFirstReviewContractErrors(record, {
    caseId: "qr-test",
    reviewRound: 1,
    inputHashes: readerFirstInputHashes(inputs),
  }), []);
});

test("reader-first review rejects stale hashes and duplicate reviewer identities", () => {
  const record = validRecord();
  record.inputHashes.deepRead = "stale";
  record.reviewers[2].reviewerId = record.reviewers[1].reviewerId;
  const errors = readerFirstReviewContractErrors(record, {
    caseId: "qr-test",
    reviewRound: 1,
    inputHashes: readerFirstInputHashes(inputs),
  });
  assert.match(errors.join("\n"), /deepRead 已过期或不匹配/u);
  assert.match(errors.join("\n"), /reviewerId 必须唯一/u);
});

test("reader-first review requires the top-level hard error aggregate", () => {
  const record = validRecord();
  record.reviewers[0].status = "fail";
  record.reviewers[0].hardErrors.push("关键遗漏");
  assert.match(readerFirstReviewContractErrors(record, {
    caseId: "qr-test",
    reviewRound: 1,
    inputHashes: readerFirstInputHashes(inputs),
  }).join("\n"), /顶层 hardErrors/u);
});

test("mobile segment bounds retain a one-pixel Chromium safety edge", () => {
  assert.deepEqual(segmentClipBounds(5117.8, 10731, 10731), {
    start: 5117,
    end: 10730,
    height: 5613,
  });
  assert.equal(segmentClipBounds(10730, 10731, 10731), null);
});
