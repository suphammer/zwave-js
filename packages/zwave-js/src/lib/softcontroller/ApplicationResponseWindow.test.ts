/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { Bytes } from "@zwave-js/shared";
import { afterEach, expect, test, vi } from "vitest";

import {
	APPLICATION_RESPONSE_WINDOW_MS,
	ApplicationResponseWindow,
	shouldHoldApplicationResponse,
} from "./ApplicationResponseWindow.js";

afterEach(() => vi.useRealTimers());

test("holds ordinary direct acknowledged traffic without guessing which CC expects a response", () => {
	for (const command of [
		[0x72, 0x04],
		[0x86, 0x11],
		[0x25, 0x01, 0xff],
		[0x98, 0x40],
	]) {
		expect(
			shouldHoldApplicationResponse(Bytes.from(command), true, false),
		).toBe(true);
	}
});

test("does not borrow response placement from routed, broadcast, unacknowledged, or atomic beam traffic", () => {
	const command = Bytes.from([0x72, 0x04]);
	expect(shouldHoldApplicationResponse(command, false, false)).toBe(false);
	expect(shouldHoldApplicationResponse(command, true, true)).toBe(false);
});

test("leaves NOP, Protocol CC, and malformed commands to their existing transaction policy", () => {
	for (const command of [[], [0x00], [0x00, 0x00], [0x01, 0x02], [0x72]]) {
		expect(
			shouldHoldApplicationResponse(Bytes.from(command), true, false),
		).toBe(false);
	}
});

test("restores an unanswered idle lease once after the bounded window", async () => {
	vi.useFakeTimers();
	const expire = vi.fn();
	const window = new ApplicationResponseWindow(expire);
	window.retain();
	await vi.advanceTimersByTimeAsync(999);
	expect(expire).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(expire).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(1_000);
	expect(expire).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

test("a subsequent transmit replaces the old deadline instead of restoring its active channel", async () => {
	vi.useFakeTimers();
	const expire = vi.fn();
	const window = new ApplicationResponseWindow(expire);
	window.retain();
	await vi.advanceTimersByTimeAsync(100);
	window.cancel();
	window.retain();
	await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_WINDOW_MS - 100);
	expect(expire).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(100);
	expect(expire).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

test("management, shutdown, or fault cancellation cannot leave a delayed RX restore", async () => {
	vi.useFakeTimers();
	const expire = vi.fn();
	const window = new ApplicationResponseWindow(expire);
	window.retain();
	await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_WINDOW_MS - 1);
	window.cancel();
	window.cancel();
	await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_WINDOW_MS);
	expect(expire).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

test("an expiry callback can transfer ownership to a new deadline", async () => {
	vi.useFakeTimers();
	let expirations = 0;
	const window = new ApplicationResponseWindow(() => {
		expirations++;
		if (expirations === 1) window.retain();
	});
	window.retain();
	await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_WINDOW_MS);
	expect(expirations).toBe(1);
	expect(vi.getTimerCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_WINDOW_MS);
	expect(expirations).toBe(2);
	expect(vi.getTimerCount()).toBe(0);
});
