import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlDB } from "@alcalzone/jsonl-db";
import { expect, test, vi } from "vitest";

import { db } from "./jsonl.js";

test("flush persists changes while retaining exclusive database ownership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-jsonl-flush-"));
	const filename = join(directory, "controller.jsonl");
	const database = db.createInstance<string>(filename, {
		throttleFS: { intervalMs: 60_000 },
	});
	try {
		await database.open();
		database.set("controller", "persisted network identity");
		await database.flush!();
		expect(await readFile(filename, "utf8")).toContain(
			"persisted network identity",
		);
		await expect(new JsonlDB(filename).open()).rejects.toThrow(
			"Failed to lock DB file",
		);
		await database.close();
		const reopened = new JsonlDB<string>(filename);
		await reopened.open();
		expect(reopened.get("controller")).toBe("persisted network identity");
		await reopened.close();
	} finally {
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("flush rejects when the database is not open without poisoning a later open", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-jsonl-not-open-"));
	const database = db.createInstance<string>(
		join(directory, "controller.jsonl"),
	);
	try {
		await expect(database.flush!()).rejects.toThrow("not open");
		await database.open();
		await expect(database.flush!()).resolves.toBeUndefined();
		await database.close();
		await expect(database.flush!()).rejects.toThrow("not open");
	} finally {
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("the same database instance can flush and release ownership after reopening", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-jsonl-reopen-"));
	const filename = join(directory, "controller.jsonl");
	const database = db.createInstance<string>(filename);
	try {
		await database.open();
		database.set("controller", "first identity");
		await database.flush!();
		await database.close();
		await database.open();
		expect(database.get("controller")).toBe("first identity");
		database.set("controller", "second identity");
		await database.flush!();
		await database.close();
		const reopened = new JsonlDB<string>(filename);
		await reopened.open();
		expect(reopened.get("controller")).toBe("second identity");
		await reopened.close();
	} finally {
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("close waits for an in-flight flush before releasing ownership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-jsonl-closing-"));
	const filename = join(directory, "controller.jsonl");
	const database = db.createInstance<string>(filename);
	let finishFlush!: () => void;
	try {
		await database.open();
		vi.spyOn(database as JsonlDB<string>, "compress").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishFlush = resolve;
				}),
		);
		const flushing = database.flush!();
		let closed = false;
		const closing = database.close().then(() => {
			closed = true;
		});
		await expect(new JsonlDB(filename).open()).rejects.toThrow(
			"Failed to lock DB file",
		);
		expect(closed).toBe(false);
		finishFlush();
		await flushing;
		await closing;
		expect(closed).toBe(true);
	} finally {
		finishFlush?.();
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("flush latches a compression failure and close retains ownership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-jsonl-failure-"));
	const filename = join(directory, "controller.jsonl");
	const database = db.createInstance<string>(filename);
	try {
		await database.open();
		const failure = new Error("Compression failed");
		const compress = vi
			.spyOn(database as JsonlDB<string>, "compress")
			.mockRejectedValue(failure);
		await expect(database.flush!()).rejects.toBe(failure);
		await expect(database.flush!()).rejects.toBe(failure);
		await expect(database.open()).rejects.toBe(failure);
		await expect(database.close()).rejects.toBe(failure);
		expect(compress).toHaveBeenCalledOnce();
		await expect(new JsonlDB(filename).open()).rejects.toThrow(
			"Failed to lock DB file",
		);
	} finally {
		await JsonlDB.prototype.close.call(database);
		await rm(directory, { recursive: true, force: true });
	}
});

test("flush times out and latches an unresponsive compression operation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-jsonl-timeout-"));
	const database = db.createInstance<string>(
		join(directory, "controller.jsonl"),
	);
	try {
		await database.open();
		vi.spyOn(database as JsonlDB<string>, "compress").mockImplementation(
			() => new Promise(() => {}),
		);
		vi.useFakeTimers();
		const failure = database.flush!().catch((error) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		const error = await failure;
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("timed out after 30000 ms");
		await expect(database.flush!()).rejects.toBe(error);
		await expect(database.close()).rejects.toBe(error);
	} finally {
		vi.useRealTimers();
		await JsonlDB.prototype.close.call(database);
		await rm(directory, { recursive: true, force: true });
	}
});
