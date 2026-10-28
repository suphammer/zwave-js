/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

export const MAX_ROUTE_REPEATERS = 4;
export const MAX_RETURN_ROUTES = 4;

export interface RouteTopology {
	readonly neighbors: ReadonlyMap<number, readonly number[]>;
	readonly repeaters: ReadonlySet<number>;
}

function compareRoutes(
	left: readonly number[],
	right: readonly number[],
): number {
	if (left.length !== right.length) return left.length - right.length;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

/**
 * Finds evidence-backed directed paths. Each intermediate hop must be a known
 * routing node and every edge must occur in the transmitting node's neighbor
 * row. Returned arrays contain repeaters only, never the endpoints.
 */
export function findRoutes(
	sourceNodeId: number,
	destinationNodeId: number,
	topology: RouteTopology,
	maximumRoutes = MAX_RETURN_ROUTES,
): readonly (readonly number[])[] {
	if (sourceNodeId === destinationNodeId || maximumRoutes < 1) return [];

	const completed: number[][] = [];
	const queue: number[][] = [[sourceNodeId]];
	while (queue.length > 0) {
		const path = queue.shift()!;
		const current = path.at(-1)!;
		if (path.length - 2 >= MAX_ROUTE_REPEATERS) continue;

		const candidates = [
			...new Set(topology.neighbors.get(current) ?? []),
		].toSorted((left, right) => left - right);
		for (const candidate of candidates) {
			if (path.includes(candidate)) continue;
			if (candidate === destinationNodeId) {
				completed.push([...path.slice(1), candidate].slice(0, -1));
				continue;
			}
			if (!topology.repeaters.has(candidate)) continue;
			queue.push([...path, candidate]);
		}
	}

	return completed
		.toSorted(compareRoutes)
		.slice(0, maximumRoutes)
		.map((route) => Object.freeze([...route]));
}
