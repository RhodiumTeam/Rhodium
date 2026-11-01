// What a slot keeps of what you changed in the terminal Rhodium launched by its settings (product
// §4.2): the router's decision alone, from what the Herdr bridge read of the transcript.
import { expect, test } from "bun:test";
import { carriedBack, codexCarriedBack, piCarriedBack } from "../src/router";

// The last handshake's models, as the meta row keeps them: default and opus are one model.
const ALL = ["low", "medium", "high", "xhigh", "max"];
const INFO = {
  default: { resolved: "claude-opus-5-5", levels: ALL },
  opus: { resolved: "claude-opus-5-5", levels: ALL },
  sonnet: { resolved: "claude-sonnet-5-5", levels: ALL },
  "claude-opus-4-6": { resolved: "claude-opus-4-6", levels: ["low", "medium", "high", "max"] },
};
const OPUS = "claude-opus-5-5";
const slot = (model: string | null, effort: string | null, ultracode: 0 | 1 | null = null) => ({ model, effort, ultracode });

test("a level you set in the terminal is kept; one it already had, or nothing told, is not", () => {
  expect(carriedBack(slot(null, "high"), INFO, { effort: "xhigh", model: OPUS }, { effort: "high", model: OPUS })).toEqual({ effort: "xhigh" });
  expect(carriedBack(slot(null, "high"), INFO, { effort: "high", model: OPUS }, { effort: "medium", model: OPUS })).toEqual({});
  expect(carriedBack(slot(null, "high"), INFO, undefined, { effort: "medium", model: OPUS })).toEqual({});
  expect(carriedBack(slot(null, "high"), INFO, { model: OPUS }, { effort: "high", model: OPUS })).toEqual({});
});

test("ultracode turned on or off in the terminal is kept apart from the level, each as it changed", () => {
  expect(carriedBack(slot(null, "high"), INFO, { effort: "high", model: OPUS, ultra: true }, undefined)).toEqual({ ultracode: 1 });
  expect(carriedBack(slot("opus", "high", 1), INFO, { effort: "max", model: OPUS, ultra: false }, undefined)).toEqual({ effort: "max", ultracode: 0 });
  expect(carriedBack(slot("opus", "high", 1), INFO, { effort: "high", model: OPUS, ultra: true }, undefined)).toEqual({});
  // Never set by the slot, it follows your own settings, which may have it on: turned off there, it is kept off.
  expect(carriedBack(slot(null, "high"), INFO, { effort: "high", model: OPUS, ultra: false }, undefined)).toEqual({ ultracode: 0 });
  // Claude marks only turning it on or off: with no marker it ran as launched.
  expect(carriedBack(slot("opus", "high", 1), INFO, { effort: "high", model: OPUS }, undefined)).toEqual({});
  // With a model switched there too.
  expect(carriedBack(slot("opus", "high"), INFO, { effort: "medium", model: "claude-sonnet-5-5", ultra: true }, undefined)).toEqual({ model: "sonnet", ultracode: 1 });
});

test("nothing remembered: changed only against the turn before the terminal, which must be there to tell", () => {
  expect(carriedBack(slot(null, null), INFO, { effort: "xhigh", model: OPUS }, { effort: "high", model: OPUS })).toEqual({ effort: "xhigh" });
  // As before: your own default, which stays yours.
  expect(carriedBack(slot(null, null), INFO, { effort: "high", model: OPUS }, { effort: "high", model: OPUS })).toEqual({});
  expect(carriedBack(slot(null, null), INFO, { effort: "xhigh", model: OPUS }, undefined)).toEqual({});
  // No model on either side: whether it changed cannot be told, nor so whether the level is the new model's default.
  expect(carriedBack(slot(null, null), INFO, { effort: "xhigh" }, { effort: "high" })).toEqual({});
  // The turn before ran on another model (IM /model, or /resume to an old conversation): its level is not where the terminal started.
  expect(carriedBack(slot("sonnet", null), INFO, { effort: "medium", model: "claude-sonnet-5-5" }, { effort: "high", model: OPUS })).toEqual({});
  expect(carriedBack(slot("sonnet", null), INFO, { effort: "low", model: "claude-sonnet-5-5" }, { effort: "medium", model: "claude-sonnet-5-5" })).toEqual({ effort: "low" });
});

test("a model switched in the terminal is kept by the handshake's name for it, and the level left alone: it is that model's default, not yours", () => {
  expect(carriedBack(slot("opus", "high"), INFO, { effort: "medium", model: "claude-sonnet-5-5" }, undefined)).toEqual({ model: "sonnet" });
  expect(carriedBack(slot(null, "high"), INFO, { effort: "medium", model: "claude-sonnet-5-5" }, { model: OPUS })).toEqual({ model: "sonnet" });
  expect(carriedBack(slot(null, null), INFO, { effort: "medium", model: "claude-sonnet-5-5" }, { effort: "high", model: OPUS })).toEqual({ model: "sonnet" });
  // Opus by the name other than default that resolves to it.
  expect(carriedBack(slot("sonnet", null), INFO, { effort: "high", model: OPUS }, { effort: "medium", model: "claude-sonnet-5-5" })).toEqual({ model: "opus" });
});

test("a model switched to that only your default names is your default; one the handshake has no name for, or a start not known, leaves the slot as it was", () => {
  const solo = { default: { resolved: OPUS, levels: ALL }, sonnet: INFO.sonnet };
  expect(carriedBack(slot("sonnet", "high"), solo, { effort: "high", model: OPUS }, undefined)).toEqual({ model: null });
  // A [1m] variant, or a model a newer Claude dropped.
  expect(carriedBack(slot("opus", "high"), INFO, { effort: "high", model: "claude-opus-5-5[1m]" }, undefined)).toEqual({});
  // Nothing remembered, and no turn before the terminal: what it started on is not known.
  expect(carriedBack(slot(null, null), INFO, { effort: "medium", model: "claude-sonnet-5-5" }, undefined)).toEqual({});
});

test("a remembered model by its alias is the model the terminal ran; one the handshake no longer lists cannot be told", () => {
  expect(carriedBack(slot("opus", "high"), INFO, { effort: "max", model: OPUS }, undefined)).toEqual({ effort: "max" });
  expect(carriedBack(slot("opus[1m]", "high"), INFO, { effort: "max", model: OPUS }, undefined)).toEqual({});
});

test("a remembered level the model lacks, which Claude narrowed, is not taken for your change", () => {
  // ultracode needs xhigh, which Opus 4.6 has not: Claude ran without it and marked nothing, so the slot keeps it on.
  expect(carriedBack(slot(null, "high", 1), INFO, { effort: "high", model: "claude-opus-4-6" }, { model: "claude-opus-4-6" })).toEqual({});
  expect(carriedBack(slot(null, "xhigh"), INFO, { effort: "high", model: "claude-opus-4-6" }, { model: "claude-opus-4-6" })).toEqual({});
  expect(carriedBack(slot(null, "max"), INFO, { effort: "high", model: "claude-opus-4-6" }, { model: "claude-opus-4-6" })).toEqual({ effort: "high" });
});

// pi's, from the newest change lines of its session file: models as provider/modelId, as the slot keeps them.
const FLASH = "deepseek/deepseek-flash";
const PRO = "deepseek/deepseek-v4-pro";

test("pi: a level you set in the terminal is kept; none set there, or the one it started on, is not", () => {
  expect(piCarriedBack({ effort: "off" }, { effort: "high", model: FLASH })).toEqual({ effort: "off" });
  expect(piCarriedBack({ effort: "high" }, { effort: "high", model: FLASH })).toEqual({});
  expect(piCarriedBack({}, { effort: "high", model: FLASH })).toEqual({});
  expect(piCarriedBack(undefined, { effort: "high", model: FLASH })).toEqual({});
});

test("pi: the terminal started on the newest change lines before it, which it resumed, whatever the slot remembers; with none, nothing is kept", () => {
  // A session first written down in the terminal (IM /model, /new, then rh tui before a word): pi
  // started there on your defaults and wrote them down, which are not your change.
  expect(piCarriedBack({ effort: "high", model: FLASH }, {})).toEqual({});
  expect(piCarriedBack({ effort: "off", model: PRO }, {})).toEqual({});
  expect(piCarriedBack({ effort: "off" }, {})).toEqual({});
  expect(piCarriedBack({ effort: "off" }, undefined)).toEqual({});
});

test("pi: a model switched in the terminal is kept, and the level it reset to is not", () => {
  expect(piCarriedBack({ effort: "high", model: PRO }, { effort: "low", model: FLASH })).toEqual({ model: PRO });
  // Switched there and back: the model it started on, so not a switch.
  expect(piCarriedBack({ model: FLASH }, { effort: "low", model: FLASH })).toEqual({});
});

test("Codex, as Claude: against what the slot set, else the turn before the terminal; a model by its id, without its level; nothing where the start is not known", () => {
  const cx = (model: string | null, effort: string | null) => ({ model, effort });
  expect(codexCarriedBack(cx("gpt-a", "low"), { model: "gpt-a", effort: "high" }, undefined)).toEqual({ effort: "high" });
  expect(codexCarriedBack(cx("gpt-a", "low"), { model: "gpt-a", effort: "low" }, { model: "gpt-b", effort: "high" })).toEqual({});
  expect(codexCarriedBack(cx("gpt-a", null), { model: "gpt-b", effort: "medium" }, { model: "gpt-a", effort: "low" })).toEqual({ model: "gpt-b" });
  expect(codexCarriedBack(cx(null, null), { model: "gpt-a", effort: "high" }, { model: "gpt-a", effort: "low" })).toEqual({ effort: "high" });
  expect(codexCarriedBack(cx(null, null), { model: "gpt-a", effort: "low" }, { model: "gpt-a", effort: "low" })).toEqual({});
  // The turn before ran on another model than the slot's: its level is not where the terminal started.
  expect(codexCarriedBack(cx("gpt-a", null), { model: "gpt-a", effort: "high" }, { model: "gpt-b", effort: "low" })).toEqual({});
  expect(codexCarriedBack(cx(null, null), { model: "gpt-a", effort: "high" }, undefined)).toEqual({});
  expect(codexCarriedBack(cx("gpt-a", "low"), undefined, undefined)).toEqual({});
});
