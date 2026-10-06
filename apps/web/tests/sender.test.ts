import { expect, test } from "bun:test";
import {
	SENDER_ADDRESS,
	SENDER_ADDRESS_SAFERATE_COM,
	senderFor,
} from "@markets/schema";

test("markets.saferate.com sends from saferate.com's domain", () => {
	expect(senderFor("https://markets.saferate.com")).toBe(
		SENDER_ADDRESS_SAFERATE_COM,
	);
	expect(SENDER_ADDRESS_SAFERATE_COM).toBe("noreply@notifications.saferate.com");
});

test("saferate.markets, staging and development keep the Markets sender", () => {
	for (const site of [
		"https://saferate.markets",
		"https://staging.saferate.markets",
		"http://localhost:3020",
	])
		expect(senderFor(site)).toBe(SENDER_ADDRESS);
});

test("a lookalike host is not saferate.com", () => {
	expect(senderFor("https://saferate.com.evil.io")).toBe(SENDER_ADDRESS);
	expect(senderFor("https://notsaferate.com")).toBe(SENDER_ADDRESS);
	expect(senderFor("not a url")).toBe(SENDER_ADDRESS);
});
