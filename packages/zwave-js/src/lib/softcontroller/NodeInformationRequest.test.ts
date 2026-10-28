/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { afterEach, expect, test, vi } from "vitest";

import { NodeInformationRequest } from "./NodeInformationRequest.js";

afterEach(() => vi.useRealTimers());

test("captures the requested NIF and owns its bytes through cleanup", async () => {
	const pending = new NodeInformationRequest(2, 5_000);
	const command = Uint8Array.of(1, 1, 0x8b, 0x8c, 0, 0x10, 1, 0x20);
	expect(pending.accept({ sourceNodeId: 3, command })).toBe(false);
	expect(
		pending.accept({ sourceNodeId: 2, command: Uint8Array.of(1, 2) }),
	).toBe(false);
	expect(pending.accept({ sourceNodeId: 2, command: Uint8Array.of(1) })).toBe(
		false,
	);
	expect(pending.accept({ sourceNodeId: 2, command })).toBe(true);
	command.fill(0);
	expect((await pending.response)?.command).toEqual(
		Uint8Array.of(1, 1, 0x8b, 0x8c, 0, 0x10, 1, 0x20),
	);
	// Duplicates stay owned until the caller has restored the receiver.
	expect(
		pending.accept({ sourceNodeId: 2, command: Uint8Array.of(1, 1) }),
	).toBe(true);
});

test("ends an unanswered window at its deadline", async () => {
	vi.useFakeTimers();
	const pending = new NodeInformationRequest(2, 5_000);
	await vi.advanceTimersByTimeAsync(5_000);
	expect(await pending.response).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
});

test("cancellation releases timers and keeps late NIFs owned through cleanup", async () => {
	vi.useFakeTimers();
	const abort = new AbortController();
	const pending = new NodeInformationRequest(2, 5_000, abort.signal);
	abort.abort();
	pending.cancel();
	expect(await pending.response).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
	expect(
		pending.accept({ sourceNodeId: 2, command: Uint8Array.of(1, 1) }),
	).toBe(true);
});

test("an already canceled request cannot arm a receive window", async () => {
	vi.useFakeTimers();
	const abort = new AbortController();
	abort.abort();
	const pending = new NodeInformationRequest(2, 5_000, abort.signal);
	expect(await pending.response).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
});

test.each([0, -1, 5_001, 0.5, NaN, Infinity])(
	"rejects an unbounded or invalid deadline %s",
	(timeout) => {
		expect(() => new NodeInformationRequest(2, timeout)).toThrow(
			"1..5000 ms",
		);
	},
);
