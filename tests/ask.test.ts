import assert from "node:assert/strict";
import { test } from "node:test";
import { isGroundedAnswer } from "../lib/ask";

test("isGroundedAnswer: clean answer with traced numbers passes", () => {
  const a = isGroundedAnswer(
    "Theo sự kiện 1, Fed giữ lãi suất 4.5% sau cuộc họp tháng 10, với 2 thành viên phản đối.",
    new Set([1, 4.5, 10, 2]),
  );
  assert.equal(a, true);
});

test("isGroundedAnswer: untraced number rejected", () => {
  const a = isGroundedAnswer(
    "Theo sự kiện 1, Fed giữ lãi suất 4.5% và 3 thành viên phản đối.",
    new Set([4.5]),
  );
  assert.equal(a, false);
});

test("isGroundedAnswer: advice rejected", () => {
  const a = isGroundedAnswer(
    "Nhà đầu tư nên mua vào trước khi Fed họp tiếp theo.",
    new Set(),
  );
  assert.equal(a, false);
});

test("isGroundedAnswer: abstention sentence always passes", () => {
  const a = isGroundedAnswer(
    "Dữ kiện hiện có chưa đủ để trả lời câu hỏi này.",
    new Set(),
  );
  assert.equal(a, true);
});

test("isGroundedAnswer: markdown and preambles rejected", () => {
  assert.equal(
    isGroundedAnswer("**Fed** giữ lãi suất nguyên theo sự kiện 1.", new Set()),
    false,
  );
});
