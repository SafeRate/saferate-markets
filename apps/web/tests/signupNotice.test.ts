import { describe, expect, test } from "bun:test";
import {
	shouldNotifySignup,
	signupNoticeEmail,
} from "../app/services/authEmail";

describe("shouldNotifySignup", () => {
	test("an outside address on production is a lead", () => {
		expect(
			shouldNotifySignup({
				email: "jared@quantconnect.com",
				environment: "production",
			}),
		).toBe(true);
	});

	test("a saferate.com address is the team's own, in any case", () => {
		expect(
			shouldNotifySignup({
				email: "dylan+test@saferate.com",
				environment: "production",
			}),
		).toBe(false);
		expect(
			shouldNotifySignup({
				email: "Team@SafeRate.com ",
				environment: "production",
			}),
		).toBe(false);
	});

	test("a lookalike domain is not saferate.com", () => {
		expect(
			shouldNotifySignup({
				email: "x@notsaferate.com",
				environment: "production",
			}),
		).toBe(true);
		expect(
			shouldNotifySignup({
				email: "x@saferate.com.evil.io",
				environment: "production",
			}),
		).toBe(true);
	});

	test("staging and development never notify", () => {
		expect(shouldNotifySignup({ email: "a@b.com", environment: "staging" })).toBe(
			false,
		);
		expect(
			shouldNotifySignup({ email: "a@b.com", environment: "development" }),
		).toBe(false);
	});
});

test("the notice names the address, the time in Eastern and the host, escaping the address", () => {
	const notice = signupNoticeEmail({
		email: "a<b>@example.com",
		createdAt: new Date("2026-10-05T16:16:59Z"),
		siteAddress: "https://markets.saferate.com",
	});
	expect(notice.subject).toBe("New Safe Rate Markets sign-up: a<b>@example.com");
	expect(notice.text).toContain("Oct 5, 2026, 12:16 PM Eastern");
	expect(notice.text).toContain("Signed up on: markets.saferate.com");
	expect(notice.text).toContain(
		"Plan: 30-day Team trial, no card, through November 4.",
	);
	expect(notice.html).toContain("a&lt;b&gt;@example.com");
	expect(notice.html).not.toContain("a<b>");
});
