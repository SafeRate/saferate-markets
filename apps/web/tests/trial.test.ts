import { expect, test } from "bun:test";
import {
	isTrialActive,
	TRIAL,
	TRIAL_MS,
	trialDaysLeft,
	trialLastDay,
} from "@markets/schema";

const now = Date.UTC(2026, 9, 6, 15);

test("the trial is Team for 30 days", () => {
	expect(TRIAL).toEqual({ days: 30, idPlan: "team" });
	expect(TRIAL_MS).toBe(30 * 86_400_000);
});

test("a trial runs until its end, and no trial is not a running one", () => {
	expect(isTrialActive(now + 1, now)).toBe(true);
	expect(isTrialActive(now, now)).toBe(false);
	expect(isTrialActive(now - 1, now)).toBe(false);
	expect(isTrialActive(null, now)).toBe(false);
	expect(isTrialActive(undefined, now)).toBe(false);
});

test("days left round up, so the last day reads 1", () => {
	expect(trialDaysLeft(now + TRIAL_MS, now)).toBe(30);
	expect(trialDaysLeft(now + 1, now)).toBe(1);
	expect(trialDaysLeft(now - 1, now)).toBe(0);
});

test("accounts that existed at launch run through November 5", () => {
	// migration 0007's value
	expect(trialLastDay(1_793_923_200_000)).toBe("November 5");
});
