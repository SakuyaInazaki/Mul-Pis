import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface BoundedFileTail {
	bytesRead: number;
	truncatedStart: boolean;
	truncatedEnd: boolean;
	text: string;
}

/** Read at most maxBytes from the end of one explicitly selected file. */
export function readBoundedFileTail(file: string, maxBytes: number): BoundedFileTail {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) {
		throw new Error("tail byte count must be 1..65536");
	}
	const fd = openSync(file, "r");
	try {
		const length = fstatSync(fd).size;
		const count = Math.min(length, maxBytes);
		const buffer = Buffer.alloc(count);
		let bytesRead = 0;
		while (bytesRead < count) {
			const n = readSync(fd, buffer, bytesRead, count - bytesRead, length - count + bytesRead);
			if (n === 0) break;
			bytesRead += n;
		}
		return {
			bytesRead,
			truncatedStart: length > count,
			truncatedEnd: bytesRead < count,
			text: buffer.subarray(0, bytesRead).toString("utf8"),
		};
	} finally {
		closeSync(fd);
	}
}
