/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { test } from "vitest";

import { findRoutes } from "./RouteManager.js";

test("finds shortest evidence-backed paths with at most four repeaters", (t) => {
	const neighbors = new Map<number, readonly number[]>([
		[1, [2, 3]],
		[2, [4, 5]],
		[3, [4]],
		[4, [5]],
		[5, [6]],
		[6, [7]],
		[7, [8]],
	]);
	t.expect(
		findRoutes(1, 5, {
			neighbors,
			repeaters: new Set([2, 3, 4, 5, 6, 7]),
		}),
	).toStrictEqual([[2], [2, 4], [3, 4]]);
	t.expect(
		findRoutes(1, 8, {
			neighbors,
			repeaters: new Set([2, 3, 4, 5, 6, 7]),
		}),
	).toStrictEqual([[2, 5, 6, 7]]);
	neighbors.set(8, [9]);
	t.expect(
		findRoutes(1, 9, {
			neighbors,
			repeaters: new Set([2, 3, 4, 5, 6, 7, 8]),
		}),
	).toStrictEqual([]);
});

test("does not invent reverse links or use unconfirmed repeaters", (t) => {
	const topology = {
		neighbors: new Map<number, readonly number[]>([
			[1, [2]],
			[2, [3]],
		]),
		repeaters: new Set<number>(),
	};
	t.expect(findRoutes(1, 3, topology)).toStrictEqual([]);
	t.expect(findRoutes(3, 1, topology)).toStrictEqual([]);
});
